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


    /*
     * Convert Discord's internal:
     *
     * <@123456789>
     *
     * into:
     *
     * @username
     *
     * before sending the text to the model.
     */

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


                /*
                 * Remove Vesper's own mention.
                 */

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


    /*
     * Remove typed "Vesper" when it is being
     * used to address the bot.
     */

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


    /*
     * Make sure the guild member cache is populated.
     *
     * Vesper has GuildMembers intent, so this allows
     * us to resolve names generated by the model back
     * into real Discord member IDs.
     */

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


    /*
     * Build a list of names that Discord members may
     * reasonably be referred to by.
     *
     * We check:
     *
     * - Discord username
     * - global display name
     * - server nickname / display name
     */

    const members =
        [
            ...guild.members.cache.values(),
        ];


    /*
     * Sort longest names first so that a member named
     * "Merllin The Grey" is considered before "Merllin".
     */

    const candidates = [];


    for (
        const member
        of members
    ) {
        /*
         * Never let Vesper ping herself.
         */

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


    /*
     * Replace model-generated:
     *
     * @Merllin
     *
     * with Discord's actual:
     *
     * <@256952296359985152>
     */

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
         * Ignore other bots.
         */

        if (
            message.author.bot
        ) {
            return;
        }


        /*
         * Ignore broadcasts.
         */

        if (
            message.content.includes(
                "@here"
            ) ||
            message.content.includes(
                "@everyone"
            )
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

        const mentionedBot =
            message.mentions.users.has(
                client.user.id
            );

        console.log(
            "[mentions-debug]",
            {
                content: message.content,
                botId: client.user.id,
                mentionedBot,
                mentionedUsers: [
                    ...message.mentions.users.keys(),
                ],
            }
        );


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


        const namedVesper =
            /\bvesper\b/i.test(
                message.content
            );


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

        await message
            .channel
            .sendTyping();


        const sendTypingInterval =
            setInterval(
                () => {
                    message
                        .channel
                        .sendTyping()
                        .catch(
                            () => {}
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

            const systemPrompt =
                messageIsMedia
                    ?
                        (
                            "You are Vesper, a casual, snarky gaming AI hanging out with people in Discord. " +
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
                        "mmm hmmm im here..";


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
                 * Ignore other bots.
                 */

                if (
                    msg.author.bot &&
                    msg.author.id !==
                        client.user.id
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
             *
             * GPT thinks in human-readable @names.
             *
             * Before sending the response to Discord,
             * translate real guild members back into
             * Discord's <@ID> format.
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
