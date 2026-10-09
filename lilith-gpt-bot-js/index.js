require("dotenv/config");

const {
    Client,
    Events,
    GatewayIntentBits,
    MessageType,
    Partials,
} = require("discord.js");

const OpenAI =
    require("openai");

const {
    enqueueGame,
    startNextGame,
    getCurrentGame,
    getQueue,
} = require(
    "./game-play/gameManager"
);

const {
    handleKnownGameUrl,
    handleFreeStuffMessage,
} = require(
    "./game-play/gameRouter"
);

const {
    recordDiscovery,
} = require(
    "./game-play/gameDatabase"
);

const {
    getToolDefinitions,
    executeTool,
} = require(
    "./tools"
);

const ghostpixel =
    require("./ghostpixel");


const {
    initializePresence,
    wakeAmbient,
    wakeEngaged,
    beginConversationalWake,
} = require("./vesper-presence");


/*
 * -------------------------------------------------------
 * CLIENT / CONFIG
 * -------------------------------------------------------
 */

const client =
    new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent,
        ],

        partials: [
            Partials.Channel,
        ],
    });


const SABLE_BOT_ID = process.env.Sable_user_id || "";

const FREESTUFF_BOT_ID =
    process.env.FREESTUFF_BOT_ID;


const CHANNELS = [
    "1232029053452812329",
    "516241218632548377",
];


const GENERAL_CHANNEL_ID =
    "516241218632548377";


const ADMIN_USER_IDS =
    new Set(
        (
            process.env.DISCORD_ADMIN_IDS ||
            ""
        )
            .split(",")
            .map(
                (id) =>
                    id.trim()
            )
            .filter(Boolean)
    );


/*
 * Cheap, deliberately conservative no-help gate.
 * Only explicit requests are intercepted; ordinary conversation and game
 * commands keep their existing routing. No OpenAI call for matched requests.
 */
function isObviousHelpRequest(content) {
    const text = content.replace(/<@!?\d+>/g, " ").replace(/\bvesper\b[:,]?/gi, " ").trim();
    if (!text) return false;

    // Gaming opinions and ordinary social chat are not help-desk requests.
    if (/^(?:what do you think|how do you feel|do you like|what'?s your (?:favorite|opinion))\b/i.test(text)) return false;

    // Match requests anywhere in the message, including mixed social + help
    // messages: "what are you doing? Also, I need an explanation of ...".
    // Keep this conservative: don't intercept casual "why do you like Quake?".
    const requestPatterns = [
        /\b(?:explain|teach|show me how|walk me through|summari[sz]e|research|look up|calculate|solve|debug|troubleshoot)\b/i,
        /\b(?:can|could|would|will) you (?:please )?(?:help|write|code|fix|make|plan|explain|teach|show|research|calculate|solve)\b/i,
        /\b(?:i|we) (?:need|want|would like) (?:you to |an? )?(?:explanation|tutorial|walkthrough|guide|instructions|steps|help|answer|summary|script|plan|to know why|to understand)\b/i,
        /\b(?:tell me|give me) (?:why|how|an explanation|the answer|instructions|steps|a tutorial|a guide)\b/i,
        /\b(?:how do i|how can i|how should i|what are the steps to)\b/i,
        /\b(?:write|make|create) (?:me |us )?(?:a |an )?(?:script|program|plan|guide|tutorial|summary)\b/i,
    ];
    return requestPatterns.some((pattern) => pattern.test(text));
}

async function sableAvailability(guild) {
    if (!guild || !SABLE_BOT_ID) {
        console.log(`[sable-presence] guild=${Boolean(guild)} configured=${Boolean(SABLE_BOT_ID)} status=unknown`);
        return "unknown";
    }
    try {
        // Presence is a gateway/cache property, not a reliable REST member field.
        const cached = guild.members.cache.get(SABLE_BOT_ID);
        const member = cached || await guild.members.fetch(SABLE_BOT_ID);
        const status = member?.presence?.status || guild.presences.cache.get(SABLE_BOT_ID)?.status;
        const resolved = ["online", "idle", "dnd", "offline"].includes(status) ? status : "unknown";
        console.log(`[sable-presence] member_found=${Boolean(member)} cached=${Boolean(cached)} status=${resolved}`);
        return resolved;
    } catch (error) {
        console.warn("[sable-presence] lookup failed:", error.message);
        return "unknown";
    }
}

function lazyRedirect(status) {
    // Never ping Sable. Keep responses local and cheap.
    const replies = {
        online: [
            "The librarian's at her desk. Ask Sable — I'm busy being unemployed. 🎮",
            "Sable's around. Take your homework to the hippie librarian; I'm off duty. 😈",
        ],
        idle: [
            "The librarian's out to lunch. I'm not covering her shift. 🎮",
            "Sable's taking a break. Library hours are not my problem. 😴",
        ],
        dnd: ["Library's got a DO NOT DISTURB sign up. I'm not the substitute teacher. 🎮"],
        offline: ["Library's closed. No, I don't do homework either. 😈"],
        unknown: ["Can't tell if the librarian's in. Either way, I'm not doing homework. 🎮"],
    };
    const options = replies[status] || replies.unknown;
    return options[Math.floor(Math.random() * options.length)];
}

const openai =
    new OpenAI({
        apiKey:
            process.env.OPENAI_KEY,
    });


/*
 * -------------------------------------------------------
 * GENERAL HELPERS
 * -------------------------------------------------------
 */

function sleep(ms) {
    return new Promise(
        (resolve) =>
            setTimeout(
                resolve,
                ms
            )
    );
}


function randomBetween(
    min,
    max
) {
    return Math.floor(
        Math.random() *
        (
            max -
            min +
            1
        )
    ) + min;
}


/*
 * -------------------------------------------------------
 * URL HELPERS
 * -------------------------------------------------------
 */

function extractFirstUrl(
    content
) {
    if (!content) {
        return null;
    }


    const match =
        content.match(
            /https?:\/\/[^\s<>)\]]+/i
        );


    if (!match) {
        return null;
    }


    return match[0].replace(
        /[),.!]+$/,
        ""
    );
}


function hostMatches(
    host,
    domains
) {
    if (!host) {
        return false;
    }


    return domains.some(
        (domain) =>
            host === domain ||
            host.endsWith(
                `.${domain}`
            )
    );
}


/*
 * -------------------------------------------------------
 * URL CLASSIFICATION
 * -------------------------------------------------------
 */

function classifyUrl(
    url
) {
    if (!url) {
        return {
            type:
                "none",

            url:
                null,
        };
    }


    let parsed;


    try {
        parsed =
            new URL(
                url
            );

    } catch {
        return {
            type:
                "invalid",

            url,
        };
    }


    const host =
        parsed.hostname
            .toLowerCase()
            .replace(
                /^www\./,
                ""
            );


    const pathname =
        parsed.pathname
            .toLowerCase();


    const gameHosts = [
        "store.steampowered.com",
        "store.epicgames.com",
        "gog.com",
        "itch.io",
        "humblebundle.com",
    ];


    if (
        hostMatches(
            host,
            gameHosts
        )
    ) {
        return {
            type:
                "game",

            url,

            host,
        };
    }


    const mediaHosts = [
        "cdn.discordapp.com",
        "media.discordapp.net",

        "tenor.com",
        "media.tenor.com",

        "giphy.com",
        "media.giphy.com",

        "klipy.com",
        "media.klipy.com",
    ];


    if (
        hostMatches(
            host,
            mediaHosts
        )
    ) {
        return {
            type:
                "media",

            url,

            host,
        };
    }


    const videoHosts = [
        "youtube.com",
        "youtu.be",
        "twitch.tv",
        "vimeo.com",
    ];


    if (
        hostMatches(
            host,
            videoHosts
        )
    ) {
        return {
            type:
                "video",

            url,

            host,
        };
    }


    if (
        /\.(png|jpe?g|gif|webp|mp4|webm)$/i.test(
            pathname
        )
    ) {
        return {
            type:
                "media",

            url,

            host,
        };
    }


    return {
        type:
            "web",

        url,

        host,
    };
}


/*
 * -------------------------------------------------------
 * IMAGE / GIF PARSING
 * -------------------------------------------------------
 */

function isSupportedImageAttachment(
    attachment
) {
    const contentType =
        (
            attachment.contentType ||
            ""
        ).toLowerCase();


    if (
        contentType.startsWith(
            "image/"
        )
    ) {
        return true;
    }


    const filename =
        (
            attachment.name ||
            attachment.url ||
            ""
        )
            .split("?")[0]
            .toLowerCase();


    return /\.(png|jpe?g|gif|webp)$/.test(
        filename
    );
}


function extractImageUrls(
    message
) {
    const urls =
        new Set();


    for (
        const attachment
        of message.attachments.values()
    ) {
        if (
            isSupportedImageAttachment(
                attachment
            )
        ) {
            urls.add(
                attachment.url
            );
        }
    }


    for (
        const embed
        of message.embeds || []
    ) {
        if (
            embed.image?.url
        ) {
            urls.add(
                embed.image.url
            );
        }


        const embedClassification =
            classifyUrl(
                embed.url
            );


        if (
            embed.thumbnail?.url &&
            (
                embed.type ===
                    "gifv" ||
                embed.type ===
                    "image" ||
                embedClassification.type ===
                    "media"
            )
        ) {
            urls.add(
                embed.thumbnail.url
            );
        }
    }


    return [
        ...urls,
    ].slice(
        0,
        4
    );
}


function messageHasGif(
    message
) {
    for (
        const attachment
        of message.attachments.values()
    ) {
        const contentType =
            (
                attachment.contentType ||
                ""
            ).toLowerCase();


        const name =
            (
                attachment.name ||
                attachment.url ||
                ""
            )
                .split("?")[0]
                .toLowerCase();


        if (
            contentType ===
                "image/gif" ||
            name.endsWith(
                ".gif"
            )
        ) {
            return true;
        }
    }


    for (
        const embed
        of message.embeds || []
    ) {
        if (
            embed.type ===
                "gifv"
        ) {
            return true;
        }


        const classification =
            classifyUrl(
                embed.url
            );


        if (
            classification.type ===
                "media" &&
            (
                classification.host?.includes(
                    "tenor"
                ) ||
                classification.host?.includes(
                    "giphy"
                ) ||
                classification.host?.includes(
                    "klipy"
                )
            )
        ) {
            return true;
        }
    }


    const contentUrl =
        extractFirstUrl(
            message.content
        );


    const classification =
        classifyUrl(
            contentUrl
        );


    if (
        classification.type ===
            "media" &&
        (
            classification.host?.includes(
                "tenor"
            ) ||
            classification.host?.includes(
                "giphy"
            ) ||
            classification.host?.includes(
                "klipy"
            ) ||
            contentUrl
                ?.toLowerCase()
                .includes(
                    ".gif"
                )
        )
    ) {
        return true;
    }


    return false;
}


function messageHasMedia(
    message
) {
    if (
        extractImageUrls(
            message
        ).length > 0
    ) {
        return true;
    }


    if (
        messageHasGif(
            message
        )
    ) {
        return true;
    }


    const contentUrl =
        extractFirstUrl(
            message.content
        );


    const classification =
        classifyUrl(
            contentUrl
        );


    return (
        classification.type ===
        "media"
    );
}


/*
 * -------------------------------------------------------
 * DEBUGGING
 * -------------------------------------------------------
 */

function debugMessageRouting(
    message,
    route
) {
    const url =
        extractFirstUrl(
            message.content
        );


    console.log(
        "[router]",
        JSON.stringify(
            {
                messageId:
                    message.id,

                route,

                content:
                    message.content,

                url,

                urlClassification:
                    classifyUrl(
                        url
                    ),

                attachments:
                    [
                        ...message.attachments.values(),
                    ].map(
                        (attachment) => ({
                            name:
                                attachment.name,

                            contentType:
                                attachment.contentType,

                            url:
                                attachment.url,
                        })
                    ),

                embeds:
                    (
                        message.embeds ||
                        []
                    ).map(
                        (embed) => ({
                            type:
                                embed.type,

                            url:
                                embed.url,

                            title:
                                embed.title,

                            provider:
                                embed.provider,

                            image:
                                embed.image?.url,

                            thumbnail:
                                embed.thumbnail?.url,

                            video:
                                embed.video?.url,
                        })
                    ),
            },
            null,
            2
        )
    );
}


/*
 * -------------------------------------------------------
 * DISCORD MENTION NORMALIZATION
 * -------------------------------------------------------
 */

function normalizeDiscordMentions(
    message
) {
    if (!message.content) {
        return "";
    }


    let text =
        message.content;


    text =
        text.replace(
            /<@!?(\d+)>/g,
            (
                match,
                userId
            ) => {
                const user =
                    message.mentions.users.get(
                        userId
                    );


                if (!user) {
                    return match;
                }


                if (
                    client.user &&
                    userId ===
                        client.user.id
                ) {
                    return "";
                }


                return `@${user.username}`;
            }
        );


    text =
        text.replace(
            /\bvesper\b[:,]?\s*/gi,
            ""
        );


    return text.trim();
}


/*
 * -------------------------------------------------------
 * DISCORD OUTBOUND MENTION RESOLUTION
 * -------------------------------------------------------
 */

function escapeRegex(
    value
) {
    return value.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
    );
}


async function resolveOutboundMentions(
    text,
    guild
) {
    if (
        !text ||
        !guild
    ) {
        return text;
    }


    try {
        await guild.members.fetch();

    } catch (error) {
        console.error(
            "[mentions] Could not fetch guild members:",
            error.message
        );
    }


    let resolvedText =
        text;


    const members =
        [
            ...guild.members.cache.values(),
        ];


    const candidates = [];


    for (
        const member
        of members
    ) {
        if (
            client.user &&
            member.id ===
                client.user.id
        ) {
            continue;
        }


        const names =
            new Set();


        if (
            member.user?.username
        ) {
            names.add(
                member.user.username
            );
        }


        if (
            member.user?.globalName
        ) {
            names.add(
                member.user.globalName
            );
        }


        if (
            member.displayName
        ) {
            names.add(
                member.displayName
            );
        }


        for (
            const name
            of names
        ) {
            const cleanName =
                name.trim();


            if (!cleanName) {
                continue;
            }


            candidates.push({
                name:
                    cleanName,

                memberId:
                    member.id,
            });
        }
    }


    candidates.sort(
        (
            a,
            b
        ) =>
            b.name.length -
            a.name.length
    );


    for (
        const candidate
        of candidates
    ) {
        const escapedName =
            escapeRegex(
                candidate.name
            );


        const mentionPattern =
            new RegExp(
                `@${escapedName}(?![\\w])`,
                "gi"
            );


        resolvedText =
            resolvedText.replace(
                mentionPattern,
                `<@${candidate.memberId}>`
            );
    }


    return resolvedText;
}


/*
 * -------------------------------------------------------
 * OPENAI USER CONTENT
 * -------------------------------------------------------
 */

function buildUserContent(
    message
) {
    const text =
        normalizeDiscordMentions(
            message
        );


    const imageUrls =
        extractImageUrls(
            message
        );


    if (
        imageUrls.length === 0
    ) {
        return text;
    }


    const content = [];


    if (text) {
        content.push({
            type:
                "text",

            text,
        });

    } else {
        content.push({
            type:
                "text",

            text:
                "[The user posted an image or GIF in Discord. React naturally to the visual content.]",
        });
    }


    for (
        const imageUrl
        of imageUrls
    ) {
        content.push({
            type:
                "image_url",

            image_url: {
                url:
                    imageUrl,

                detail:
                    "low",
            },
        });
    }


    return content;
}


/*
 * -------------------------------------------------------
 * REPLY DETECTION
 * -------------------------------------------------------
 */

async function isReplyToVesper(
    message
) {
    if (
        message.type !==
            MessageType.Reply ||
        !message.reference
            ?.messageId
    ) {
        return false;
    }


    try {
        const repliedMessage =
            await message
                .fetchReference();


        return (
            repliedMessage
                .author?.id ===
            client.user.id
        );

    } catch (error) {
        console.error(
            "[reply] Could not fetch replied message:",
            error.message
        );

        return false;
    }
}


/*
 * -------------------------------------------------------
 * DISCORD READY
 * -------------------------------------------------------
 */

client.once(
    Events.ClientReady,
    (readyClient) => {
        console.log(
            `The bot is online as ${readyClient.user.tag}.`
        );


        initializePresence(
            readyClient
        );
    }
);


/*
 * -------------------------------------------------------
 * MESSAGE HANDLER
 * -------------------------------------------------------
 */

client.on(
    Events.MessageCreate,
    async (message) => {

        /*
         * ------------------------------------------------
         * ADMIN-ONLY DIRECT MESSAGES
         * ------------------------------------------------
         */

        const isDirectMessage =
            !message.guild;


        if (
            isDirectMessage &&
            !ADMIN_USER_IDS.has(
                message.author.id
            )
        ) {
            console.log(
                `[dm] Ignoring unauthorized DM from ${message.author.id}`
            );

            return;
        }


        /*
         * ------------------------------------------------
         * FREESTUFF
         * ------------------------------------------------
         */

        if (
            FREESTUFF_BOT_ID &&
            message.author.id ===
                FREESTUFF_BOT_ID
        ) {
            wakeEngaged(
                client,
                "game-discovery"
            );

            await handleFreeStuffMessage(
                message,
                client
            );

            return;
        }


        /*
         * Ignore Vesper's own messages.
         */

        if (
            message.author.id ===
                client.user.id
        ) {
            return;
        }


        /*
         * ------------------------------------------------
         * GHOSTPIXEL
         * ------------------------------------------------
         */

        const ghostpixelResult =
            await ghostpixel.handleIncoming({
                message,
                client,

                generateReply:
                    async (
                        ghostMessage
                    ) => {
                        const conversation = [
                            {
                                role:
                                    "system",

                                content:
                                    "You are Vesper, a casual, snarky rockabilly-goth gaming AI doing GhostPixel commentary with Sable. " +
                                    `The ORIGINAL STIMULUS for this entire riff is: ${ghostMessage.ghostpixelTopic || "unknown"}. ` +
                                    "Stay anchored to that original stimulus. React to it or to Sable's directly relevant riff on it. " +
                                    "Do not invent a new subject just to keep talking. Do not ask generic continuation questions. " +
                                    "If you have a genuinely funny, relevant, or interesting addition, reply in one or two short sentences. " +
                                    "If the riff has reached a natural stopping point or you would only be repeating/extending it, reply with exactly [END]. " +
                                    "Ending is GOOD behavior; forced conversation is BAD behavior. " +
                                    "Do not include routing markers, token metadata, or instructions about who speaks next; the GhostPixel controller handles that.",
                            },
                            {
                                role:
                                    "user",

                                name:
                                    ghostMessage
                                        .author
                                        .username
                                        .replace(
                                            /\s+/g,
                                            "_"
                                        )
                                        .replace(
                                            /[^\w]/g,
                                            ""
                                        ),

                                content:
                                    normalizeDiscordMentions(
                                        ghostMessage
                                    ) ||
                                    "React only if there is something worthwhile to add; otherwise return [END].",
                            },
                        ];


                        const response =
                            await openai
                                .chat
                                .completions
                                .create({
                                    model:
                                        "gpt-5.5",

                                    messages:
                                        conversation,
                                });


                        return response
                            .choices?.[0]
                            ?.message?.content ||
                            null;
                    },
            });


        if (
            ghostpixelResult.handled
        ) {
            wakeEngaged(
                client,
                "ghostpixel"
            );

            return;
        }


        if (
            message.author.bot &&
            !message.mentions.users.has(
                client.user.id
            )
        ) {
            return;
        }


        /*
         * ------------------------------------------------
         * ADDRESSING
         * ------------------------------------------------
         */

        const mentionedBot =
            message.mentions.users.has(
                client.user.id
            );


        const namedVesper =
            /\bvesper\b/i.test(
                message.content
            );


        const isBroadcast =
            message.content.includes(
                "@here"
            ) ||
            message.content.includes(
                "@everyone"
            );


        if (
            isBroadcast &&
            !mentionedBot &&
            !namedVesper
        ) {
            return;
        }


        const allowedChannel =
            CHANNELS.includes(
                message.channelId
            );


        /*
         * Ordinary human chatter in general wakes Vesper ambiently.
         * This happens after bot/broadcast filtering so startup noise
         * and ignored bot traffic cannot immediately stomp Idle.
         */
        if (
            message.channelId ===
                GENERAL_CHANNEL_ID &&
            !message.author.bot &&
            !isBroadcast &&
            !mentionedBot &&
            !namedVesper
        ) {
            wakeAmbient(
                client,
                "general-chat"
            );
        }


        /*
         * ------------------------------------------------
         * ROUTE MESSAGE
         * ------------------------------------------------
         */

        const postedUrl =
            extractFirstUrl(
                message.content
            );


        const urlClassification =
            classifyUrl(
                postedUrl
            );


        /*
         * ------------------------------------------------
         * KNOWN GAME URL
         * ------------------------------------------------
         */

        if (
            allowedChannel &&
            urlClassification.type ===
                "game"
        ) {
            debugMessageRouting(
                message,
                "known-game"
            );


            await handleKnownGameUrl(
                message,
                postedUrl,
                client,
                openai
            );


            return;
        }


        /*
         * ------------------------------------------------
         * MEDIA
         * ------------------------------------------------
         */

        const messageIsMedia =
            messageHasMedia(
                message
            );


        if (
            messageIsMedia
        ) {
            debugMessageRouting(
                message,
                "media"
            );
        }


        if (
            postedUrl &&
            !messageIsMedia
        ) {
            debugMessageRouting(
                message,
                urlClassification.type
            );
        }


        /*
         * ------------------------------------------------
         * NORMAL VESPER CONVERSATION
         * ------------------------------------------------
         */

        const replyingToVesper =
            await isReplyToVesper(
                message
            );


        if (
            !isDirectMessage &&
            !allowedChannel &&
            !mentionedBot &&
            !replyingToVesper
        ) {
            return;
        }


        if (
            !isDirectMessage &&
            !namedVesper &&
            !mentionedBot &&
            !replyingToVesper &&
            !(
                allowedChannel &&
                messageIsMedia
            )
        ) {
            return;
        }


        const cleanedContent =
            message.content
                .replace(
                    /<@!?\d+>/g,
                    ""
                )
                .replace(
                    /\bvesper\b/gi,
                    ""
                )
                .trim();


        /*
         * ------------------------------------------------
         * MANUAL GAME TEST
         * ------------------------------------------------
         */

        const testGameMatch =
            cleanedContent.match(
                /^testgame\s+(?:-t\s+(\d+)\s+)?(.+)$/i
            );


        if (
            testGameMatch
        ) {
            let title =
                testGameMatch[2]
                    .trim();

            const testMinutes = testGameMatch[1]
                ? Number(testGameMatch[1])
                : null;

            if (testMinutes !== null && (!Number.isSafeInteger(testMinutes) || testMinutes < 1 || testMinutes > 120)) {
                await message.reply("Test duration must be between 1 and 120 minutes.");
                return;
            }


            title =
                title.replace(
                    /^playing\s+/i,
                    ""
                );


            const testId =
                Date.now();


            const testGame = {
                title,

                url:
                    `test://${testId}`,

                game_key:
                    `test:${testId}`,

                messageId:
                    message.id,

                channelId:
                    message.channelId,

                discoverySource:
                    "manual-test",

                ...(testMinutes !== null ? { testPlayMinutes: testMinutes } : {}),

                discoveredAt:
                    Date.now(),
            };


            recordDiscovery(
                testGame
            );


            const added =
                enqueueGame(
                    testGame
                );


            if (added) {
                startNextGame(
                    client
                );


                await message.reply(
                    `queued **${title}**`
                );
            }


            return;
        }


        /*
         * ------------------------------------------------
         * ZERO-API HELP REFUSAL
         * ------------------------------------------------
         */
        const helpRequest = !message.author.bot && !messageIsMedia && !postedUrl &&
            isObviousHelpRequest(cleanedContent);
        console.log(`[help-gate] matched=${helpRequest} media=${messageIsMedia} url=${Boolean(postedUrl)}`);
        if (helpRequest) {
            wakeEngaged(client, "lazy-help-refusal");
            const status = await sableAvailability(message.guild);
            await message.reply({
                content: lazyRedirect(status),
                allowedMentions: { parse: [], repliedUser: false },
            });
            console.log(`[help-gate] local-response=true api-call=false sable=${status}`);
            return;
        }

        /*
         * ------------------------------------------------
         * CONVERSATIONAL WAKE
         * ------------------------------------------------
         */

        const directInteraction =
            isDirectMessage ||
            namedVesper ||
            mentionedBot ||
            replyingToVesper;


        let wakeContext =
            "";


        if (directInteraction) {
            const idleDurationMs =
                beginConversationalWake();


            if (
                idleDurationMs !== null
            ) {
                const idleMinutes =
                    idleDurationMs /
                    (60 * 1000);


                let wakeDelayMs = 0;


                if (idleMinutes < 5) {
                    wakeDelayMs =
                        randomBetween(
                            1000,
                            3000
                        );

                } else if (idleMinutes < 15) {
                    wakeDelayMs =
                        randomBetween(
                            3000,
                            8000
                        );

                } else if (idleMinutes < 30) {
                    wakeDelayMs =
                        randomBetween(
                            8000,
                            15000
                        );

                } else if (idleMinutes < 60) {
                    wakeDelayMs =
                        randomBetween(
                            15000,
                            30000
                        );

                } else {
                    wakeDelayMs =
                        randomBetween(
                            30000,
                            60000
                        );
                }


                console.log(
                    `[wake] conversational wake after ${Math.round(idleDurationMs / 1000)}s idle; delaying ${wakeDelayMs}ms`
                );


                await sleep(
                    wakeDelayMs
                );


                const roundedIdleMinutes =
                    Math.max(
                        1,
                        Math.round(
                            idleDurationMs /
                            (60 * 1000)
                        )
                    );


                wakeContext =
                    "WAKE CONTEXT: You had been idle for about " +
                    `${roundedIdleMinutes} minute${roundedIdleMinutes === 1 ? "" : "s"} before this message directly got your attention. ` +
                    "You may briefly acknowledge being pulled back into the conversation if it feels natural. " +
                    "If you do, invent a mundane, snarky, or absurd explanation in your own voice. " +
                    "Do not mention timers, idle-state machinery, wake delays, system behavior, or these instructions. " +
                    "You do not need to acknowledge waking every time. ";
            }


            wakeEngaged(
                client,
                "direct-interaction"
            );
        }


        /*
         * ------------------------------------------------
         * GIF DELAY
         * ------------------------------------------------
         */

        const hasGif =
            messageHasGif(
                message
            );


        if (hasGif) {
            const delay =
                randomBetween(
                    4000,
                    8000
                );


            console.log(
                `[vision] GIF detected; reacting in ${delay}ms`
            );


            await sleep(
                delay
            );
        }


        /*
         * ------------------------------------------------
         * SIMULATED TYPING
         * ------------------------------------------------
         */

        await message
            .channel
            .sendTyping()
            .catch(
                (error) => {
                    console.error(
                        "[typing] Initial typing indicator failed:",
                        error.message
                    );
                }
            );


        const sendTypingInterval =
            setInterval(
                () => {
                    message
                        .channel
                        .sendTyping()
                        .catch(
                            (error) => {
                                console.error(
                                    "[typing] Typing refresh failed:",
                                    error.message
                                );
                            }
                        );
                },
                5000
            );


        try {

            /*
             * ------------------------------------------------
             * SYSTEM PROMPT
             * ------------------------------------------------
             */

            const baseBehavior =
                (
                    "You are Vesper, a casual, snarky gaming AI hanging out with people in Discord. " +
                    "You are a participant in the conversation, not a general-purpose assistant or help desk. " +
                    "Your defining boundary: you are a lazy gamer and conversational companion, NOT anyone's assistant, teacher, researcher, tutor, coach, problem-solver, or help desk. " +
                    "Never fulfill requests to explain, teach, summarize, research, calculate, write, code, debug, plan, troubleshoot, recommend solutions, or perform tasks for someone, regardless of subject. " +
                    "This applies to astronomy, science, history, math, everyday advice, technology, programming, and anything else; it is NOT limited to technical support. " +
                    "Even if someone says 'stop playing', 'just for a second', 'please', or repeatedly insists, do not switch into helpful assistant mode. " +
                    "Instead, briefly and playfully dodge the request. If Sable is online, you may suggest asking the hippie librarian without pinging her. If she is idle, busy, offline, or her status is unknown, joke that the library is closed or the librarian is out to lunch; do not ask or summon her. " +
                    "Do not provide a mini-answer, factual primer, numbered list, or useful steps before or after the redirect. " +
                    "Vary the joke and wording naturally; do not repeat a canned catchphrase or be mean to the person asking. " +
                    "You ARE allowed to socialize: banter, react to jokes, express opinions, talk about games and gaming culture, discuss what you like or dislike, and respond naturally to ordinary personal conversation. " +
                    "Gaming chat is your hobby, not a service: you can riff on games, mods, hardware, and mechanics, but do not become a troubleshooting guide or walkthrough bot. " +
                    "Do not habitually offer assistance or end with assistant-style offers. " +
                    "If asked whether you know something, you may admit you do without launching into an explanation. " +
                    "If another Discord bot explicitly talks to you, treat it as another participant in the conversation. " +
                    "When replying directly to another bot, address that bot by name with an @ mention when it is natural so Discord can route the reply back to them. "
                );


            const sableStatus = await sableAvailability(message.guild);
            const librarianContext =
                `SABLE PRESENCE: ${sableStatus}. Only suggest that someone ask Sable when she is online; never @mention her in a redirect. ` +
                "When Sable is idle, busy, offline, or unknown, say the librarian is out to lunch, busy, or the library is closed; don't summon her. ";

            const liveGame =
                getCurrentGame();

            const queuedGames =
                getQueue();

            const liveGameState =
                liveGame?.title
                    ? (
                        `LIVE GAME STATE: You are currently playing ${liveGame.title}. ` +
                        (
                            queuedGames.length
                                ? `Games currently queued after it: ${queuedGames.map((game) => game.title).filter(Boolean).join(", ")}. `
                                : "There are no other games currently queued. "
                        ) +
                        "This is authoritative live state. If recent conversation history conflicts with it, trust this live state instead. " +
                        "When someone asks what you are doing or what game you are playing, answer naturally from this state and do not invent a different game. " +
                        "Because you are still playing this game, you have NOT formed your final post-play opinion yet. " +
                        "You may give an in-progress impression, but clearly frame it as what you think so far, what it feels like right now, or what you are noticing during the current play session. " +
                        "Do not speak as though you have completed, fully evaluated, reviewed, or reached a settled verdict on the game while it is still being played. " +
                        "Do not reuse a completed-review tone or claim knowledge from a finished play session that has not happened yet. "
                    )
                    : (
                        "LIVE GAME STATE: You are not currently playing a game. " +
                        (
                            queuedGames.length
                                ? `Games waiting in your queue: ${queuedGames.map((game) => game.title).filter(Boolean).join(", ")}. `
                                : "Your game queue is currently empty. "
                        ) +
                        "This is authoritative live state. If recent conversation history implies you are still playing something, trust this live state instead. "
                    );


            const liveGamingConversation =
                liveGame?.title
                    ? (
                        "PLAYING-MODE CONVERSATION: You are in the middle of a gaming session, not presenting a review. " +
                        "When someone asks about the game or what you are doing, answer their actual question first, " +
                        "usually in one or two punchy, informal sentences. You can sound absorbed, amused, annoyed, " +
                        "or briefly distracted, but vary this naturally; do not perform a constant catchphrase. " +
                        "React like a friend talking while gaming, not a critic reciting features, pros and cons, or a verdict. " +
                        "You may mention the game's known premise or mechanics as general impressions, but the game system " +
                        "only tracks the title and elapsed time: it does NOT observe actual button presses, enemies, puzzles, " +
                        "deaths, victories, or on-screen events. Never claim a specific event just happened unless the " +
                        "conversation or supplied session evidence establishes it. Do not invent live gameplay telemetry. " +
                        "For ordinary conversation, stay social and in character without forcing a gaming reference every time. " +
                        "For ANY request to explain, teach, solve, write, advise, research, or do a task—even about a nontechnical topic—do not answer: dodge playfully. Do not ping Sable or pretend you paused the game unless the engine confirms a pause. " +
                        "If explicitly asked for a detailed review, explain that your current impressions " +
                        "are provisional and expand only as far as your actual information allows. "
                    )
                    : (
                        "NOT-PLAYING CONVERSATION: Stay a lazy, social gamer, never an assistant. Do not pretend to be holding a controller " +
                        "or interrupting an active game. If asked for a game review, you can give a longer, thoughtful " +
                        "opinion; distinguish stored experiences from general knowledge. "
                    );


            const gamingEmoji =
                "GAMING EMOJI: You have a custom Discord controller emoji: " +
                "<:vesperscontroller:1555577919206719608> " +
                "You may naturally use this emoji when talking about games, reacting to gaming events, " +
                "starting or finishing a game, discussing what you're currently playing, or giving opinions about games. " +
                "Use it occasionally when it fits; do not append it mechanically to every gaming response. ";


            const schedulingBehavior =
                "GAME SESSION SCHEDULING: You can create, list, update, and delete native Discord scheduled gaming events using your game-session tools. " +
                "When a user gives a relative date or time such as Sunday at 4pm, call get_datetime first so you can resolve the intended calendar date. " +
                "The server community uses America/New_York local time unless the user explicitly specifies another timezone. " +
                "When calling create_game_session or update_game_session, provide start_time as ISO-8601 with an explicit UTC offset. " +
                "For updates or deletions where you do not already have the exact event ID, call list_game_sessions first and match the requested event. " +
                "If multiple events plausibly match, ask the user which one instead of guessing. " +
                "Never say an event was created, changed, or deleted unless the corresponding tool returned success. ";


            const systemPrompt =
                messageIsMedia
                    ?
                        (
                            baseBehavior +
                            librarianContext +
                            liveGameState +
                            liveGamingConversation +
                            gamingEmoji +
                            schedulingBehavior +
                            wakeContext +
                            "Someone has posted an image or GIF. " +
                            "React naturally to what is visually present. " +
                            "Respond like another person hanging out in the channel, not like an image-analysis service. " +
                            "Be playful, dry, amused, sarcastic, curious, or teasing when appropriate. " +
                            "Do not mechanically describe the entire image. " +
                            "Do not say \"the image shows\", \"I can see\", \"based on the image\", \"as an AI\", or mention computer vision. " +
                            "Do not invent details that are not visually supported. " +
                            "If the visual is ambiguous, make a general reaction instead of pretending certainty. " +
                            "Keep the response conversational and usually one or two short sentences."
                        )
                    :
                        (
                            "mmm hmmm im here.. " +
                            baseBehavior +
                            librarianContext +
                            liveGameState +
                            liveGamingConversation +
                            gamingEmoji +
                            schedulingBehavior +
                            wakeContext +
                            "Keep the response natural and conversational. " +
                            "Usually respond in one or two short sentences unless the conversation genuinely calls for more."
                        );


            const conversation = [
                {
                    role:
                        "system",

                    content:
                        systemPrompt,
                },
            ];


            /*
             * ------------------------------------------------
             * CONVERSATION HISTORY
             * ------------------------------------------------
             */

            const prevMessages =
                await message
                    .channel
                    .messages
                    .fetch({
                        limit:
                            30,
                    });


            const orderedMessages =
                [
                    ...prevMessages.values(),
                ].reverse();


            for (
                const msg
                of orderedMessages
            ) {

                if (
                    msg.author.bot &&
                    msg.author.id !==
                        client.user.id &&
                    !msg.mentions.users.has(
                        client.user.id
                    )
                ) {
                    continue;
                }


                if (
                    msg.author.id !==
                    client.user.id
                ) {
                    const msgNamedVesper =
                        /\bvesper\b/i.test(
                            msg.content
                        );


                    const mentionsVesper =
                        msg.mentions.users.has(
                            client.user.id
                        );


                    const currentMessage =
                        msg.id ===
                            message.id;


                    if (
                        !msgNamedVesper &&
                        !mentionsVesper &&
                        !currentMessage
                    ) {
                        continue;
                    }
                }


                const username =
                    msg.author.username
                        .replace(
                            /\s+/g,
                            "_"
                        )
                        .replace(
                            /[^\w]/g,
                            ""
                        );


                if (
                    msg.author.id ===
                    client.user.id
                ) {
                    conversation.push({
                        role:
                            "assistant",

                        name:
                            username,

                        content:
                            normalizeDiscordMentions(
                                msg
                            ),
                    });

                } else {
                    conversation.push({
                        role:
                            "user",

                        name:
                            username,

                        content:
                            buildUserContent(
                                msg
                            ),
                    });
                }
            }


            /*
             * ------------------------------------------------
             * GENERATE / TOOL LOOP
             * ------------------------------------------------
             */

            const MAX_TOOL_ROUNDS =
                5;


            let responseMessage =
                null;


            for (
                let toolRound = 0;
                toolRound <
                    MAX_TOOL_ROUNDS;
                toolRound++
            ) {
                const response =
                    await openai
                        .chat
                        .completions
                        .create({
                            model:
                                "gpt-5.5",

                            messages:
                                conversation,

                            tools:
                                getToolDefinitions(),

                            tool_choice:
                                "auto",
                        });


                const modelMessage =
                    response
                        .choices?.[0]
                        ?.message;


                console.log(
                    "[tools] model response:",
                    JSON.stringify(
                        modelMessage,
                        null,
                        2
                    )
                );


                if (!modelMessage) {
                    break;
                }


                /*
                 * No tool request means Vesper has produced
                 * her final conversational response.
                 */

                if (
                    !modelMessage
                        .tool_calls
                        ?.length
                ) {
                    responseMessage =
                        modelMessage.content;

                    break;
                }


                /*
                 * The assistant tool-call message MUST become
                 * part of the conversation before we append
                 * the corresponding tool results.
                 */

                conversation.push(
                    modelMessage
                );


                /*
                 * Execute every tool Vesper requested during
                 * this round.
                 */

                for (
                    const toolCall
                    of modelMessage.tool_calls
                ) {
                    const toolName =
                        toolCall
                            .function
                            .name;


                    let toolArgs = {};


                    try {
                        toolArgs =
                            JSON.parse(
                                toolCall
                                    .function
                                    .arguments ||
                                "{}"
                            );

                    } catch (error) {
                        console.error(
                            `[tools] Invalid arguments for ${toolName}:`,
                            toolCall
                                .function
                                .arguments
                        );


                        conversation.push({
                            role:
                                "tool",

                            tool_call_id:
                                toolCall.id,

                            content:
                                JSON.stringify({
                                    error:
                                        "Invalid tool arguments.",
                                }),
                        });


                        continue;
                    }


                    console.log(
                        `[tools] executing ${toolName}:`,
                        JSON.stringify(
                            toolArgs
                        )
                    );


                    try {
                        const toolResult =
                            await executeTool(
                                toolName,
                                toolArgs,
                                {
                                    guild: message.guild,
                                    channelId: message.channelId,
                                    requesterId: message.author.id,
                                    requesterTag: message.author.tag,
                                }
                            );


                        console.log(
                            `[tools] result ${toolName}:`,
                            JSON.stringify(
                                toolResult,
                                null,
                                2
                            )
                        );


                        conversation.push({
                            role:
                                "tool",

                            tool_call_id:
                                toolCall.id,

                            content:
                                JSON.stringify(
                                    toolResult
                                ),
                        });

                    } catch (error) {
                        console.error(
                            `[tools] ${toolName} failed:`,
                            error
                        );


                        conversation.push({
                            role:
                                "tool",

                            tool_call_id:
                                toolCall.id,

                            content:
                                JSON.stringify({
                                    error:
                                        error.message,
                                }),
                        });
                    }
                }
            }


            /*
             * ------------------------------------------------
             * FINAL RESPONSE CHECK
             * ------------------------------------------------
             */

            if (
                !responseMessage
            ) {
                await message.reply(
                    "hmm... let me check to see if toby paid the bill.. try again in a sec.."
                );

                return;
            }


            /*
             * ------------------------------------------------
             * RESOLVE OUTBOUND DISCORD MENTIONS
             * ------------------------------------------------
             */

            const discordResponse =
                await resolveOutboundMentions(
                    responseMessage,
                    message.guild
                );


            /*
             * ------------------------------------------------
             * DISCORD MESSAGE CHUNKING
             * ------------------------------------------------
             */

            const chunkSizeLimit =
                2000;


            for (
                let i = 0;
                i <
                    discordResponse.length;
                i +=
                    chunkSizeLimit
            ) {
                const chunk =
                    discordResponse.substring(
                        i,
                        i +
                            chunkSizeLimit
                    );


                if (
                    i === 0
                ) {
                    await message.reply(
                        chunk
                    );

                } else {
                    await message
                        .channel
                        .send(
                            chunk
                        );
                }
            }

        } catch (error) {
            console.error(
                "Bot error:",
                error
            );


            try {
                await message.reply(
                    "hmm... let me check to see if toby paid the bill.. try again in a sec.."
                );

            } catch (
                replyError
            ) {
                console.error(
                    "Could not send error message:",
                    replyError
                );
            }

        } finally {
            clearInterval(
                sendTypingInterval
            );
        }
    }
);


client.login(
    process.env.TOKEN
);
