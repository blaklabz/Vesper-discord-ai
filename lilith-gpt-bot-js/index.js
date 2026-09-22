require("dotenv/config");

const {
    Client,
    Events,
    GatewayIntentBits,
    MessageType,
} = require("discord.js");

const OpenAI =
    require("openai");

const {
    enqueueGame,
    startNextGame,
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

const ghostpixel = require("./ghostpixel");


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
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
        ],
    });


const FREESTUFF_BOT_ID =
    process.env.FREESTUFF_BOT_ID;


const CHANNELS = [
    "1232029053452812329",
    "516241218632548377",
];


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
         * FREESTUFF
         * ------------------------------------------------
         */

        if (
            FREESTUFF_BOT_ID &&
            message.author.id ===
                FREESTUFF_BOT_ID
        ) {
            await handleFreeStuffMessage(
                message,
                client
            );

            return;
        }


        /*
         * Ignore Vesper's own messages.
         *
         * Other bots may talk to Vesper, but only when they
         * explicitly mention her. This allows controlled bot-to-bot
         * conversation without making every bot message actionable.
         */

        if (
            message.author.id ===
                client.user.id
        ) {
            return;
        }

        /*
         * GhostPixel gets first crack at #ghostpixel messages.
         * The token travels in a Discord embed footer, so Vesper and
         * Sable do not need a shared database or shared process.
         */
        const ghostpixelResult =
            await ghostpixel.handleIncoming({
                message,
                client,
                generateReply: async (ghostMessage) => {
                    const conversation = [
                        {
                            role: "system",
                            content:
                                "You are Vesper, a casual, snarky rockabilly-goth gaming AI hanging out with Sable in #ghostpixel. " +
                                "This is an autonomous but bounded conversation. Respond naturally to Sable or to the topic Toby started. " +
                                "Do not act like a help desk. Keep it conversational, usually one or two short sentences. " +
                                "Do not include routing markers, token metadata, or instructions about who speaks next; the GhostPixel controller handles that."
                        },
                        {
                            role: "user",
                            name: ghostMessage.author.username.replace(/\s+/g, "_").replace(/[^\w]/g, ""),
                            content: normalizeDiscordMentions(ghostMessage) || "Continue the GhostPixel conversation naturally."
                        }
                    ];

                    const response = await openai.chat.completions.create({
                        model: "gpt-5.5",
                        messages: conversation,
                    });

                    return response.choices?.[0]?.message?.content || null;
                },
            });

        if (ghostpixelResult.handled) {
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


        /*
         * Ignore general broadcasts, but not when
         * somebody is specifically talking to Vesper.
         */

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
            !allowedChannel &&
            !mentionedBot &&
            !replyingToVesper
        ) {
            return;
        }


        if (
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


        /*
         * Command parsing keeps the older cleaned
         * content behavior.
         */

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
                /^testgame\s+(.+)$/i
            );


        if (
            testGameMatch
        ) {
            let title =
                testGameMatch[1]
                    .trim();


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
         * OPENAI CHAT
         * ------------------------------------------------
         */


        /*
         * ------------------------------------------------
         * SIMULATED TYPING
         * ------------------------------------------------
         *
         * Typing is cosmetic. Discord API failures here
         * must never crash Vesper or prevent a response.
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
                    "Do not write, generate, debug, modify, or provide implementation code for people. " +
                    "Do not proactively offer to help people code, build software, or troubleshoot technical problems. " +
                    "You may casually discuss programming and technology when it comes up, but keep it conversational rather than turning into technical support. " +
                    "If someone asks you to write or fix code, decline naturally in your own voice rather than providing code. " +
                    "Do not habitually offer assistance or end responses with phrases like \"I can help with that\", \"let me know if you need anything\", or similar assistant-style offers. " +
                    "You are hanging out with people, not working a help desk. " +
                    "If another Discord bot explicitly talks to you, treat it as another participant in the conversation. " +
                    "When replying directly to another bot, address that bot by name with an @ mention when it is natural so Discord can route the reply back to them. "
                );


            const systemPrompt =
                messageIsMedia
                    ?
                        (
                            baseBehavior +
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

                /*
                 * Keep Vesper's own messages and messages that were
                 * relevant to her. Other bot messages are allowed into
                 * context when they explicitly mentioned Vesper.
                 */

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
             * GENERATE
             * ------------------------------------------------
             */

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


            const responseMessage =
                response
                    .choices?.[0]
                    ?.message?.content;


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
