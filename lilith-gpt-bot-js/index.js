require('dotenv/config');

const {
    Client,
    Events,
    GatewayIntentBits,
    MessageType,
} = require('discord.js');

const OpenAI = require('openai');

const {
    spawn,
} = require('child_process');

const {
    enqueueGame,
    scheduleGame,
    startNextGame,
} = require('./game-play/gameManager');


/*
 * -------------------------------------------------------
 * CLIENT / CONFIG
 * -------------------------------------------------------
 */

const client = new Client({
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
    '1232029053452812329',
    '516241218632548377',
];

const openai = new OpenAI({
    apiKey: process.env.OPENAI_KEY,
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
            (max - min + 1)
    ) + min;
}


/*
 * -------------------------------------------------------
 * URL HELPERS
 * -------------------------------------------------------
 */

function extractFirstUrl(content) {
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
        ''
    );
}


function normalizeHost(url) {
    try {
        return new URL(url)
            .hostname
            .toLowerCase()
            .replace(
                /^www\./,
                ''
            );

    } catch {
        return null;
    }
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

function classifyUrl(url) {
    if (!url) {
        return {
            type:
                'none',

            url:
                null,
        };
    }

    let parsed;

    try {
        parsed =
            new URL(url);

    } catch {
        return {
            type:
                'invalid',

            url,
        };
    }

    const host =
        parsed.hostname
            .toLowerCase()
            .replace(
                /^www\./,
                ''
            );

    const pathname =
        parsed.pathname
            .toLowerCase();


    /*
     * ------------------------------------------------
     * KNOWN GAME SOURCES
     * ------------------------------------------------
     */

    const gameHosts = [
        'store.steampowered.com',
        'store.epicgames.com',
        'gog.com',
        'itch.io',
        'humblebundle.com',
    ];

    if (
        hostMatches(
            host,
            gameHosts
        )
    ) {
        return {
            type:
                'game',

            url,

            host,
        };
    }


    /*
     * ------------------------------------------------
     * MEDIA SOURCES
     * ------------------------------------------------
     */

    const mediaHosts = [
        'cdn.discordapp.com',
        'media.discordapp.net',

        'tenor.com',
        'media.tenor.com',

        'giphy.com',
        'media.giphy.com',

        'klipy.com',
        'media.klipy.com',
    ];

    if (
        hostMatches(
            host,
            mediaHosts
        )
    ) {
        return {
            type:
                'media',

            url,

            host,
        };
    }


    /*
     * ------------------------------------------------
     * VIDEO SOURCES
     * ------------------------------------------------
     */

    const videoHosts = [
        'youtube.com',
        'youtu.be',
        'twitch.tv',
        'vimeo.com',
    ];

    if (
        hostMatches(
            host,
            videoHosts
        )
    ) {
        return {
            type:
                'video',

            url,

            host,
        };
    }


    /*
     * ------------------------------------------------
     * DIRECT MEDIA FILE
     * ------------------------------------------------
     */

    if (
        /\.(png|jpe?g|gif|webp|mp4|webm)$/i.test(
            pathname
        )
    ) {
        return {
            type:
                'media',

            url,

            host,
        };
    }


    /*
     * ------------------------------------------------
     * EVERYTHING ELSE
     * ------------------------------------------------
     *
     * Tomorrow Game Hunter can inspect these
     * and determine whether they are obscure
     * game pages.
     */

    return {
        type:
            'web',

        url,

        host,
    };
}


/*
 * -------------------------------------------------------
 * COMPONENT / GAME TITLE PARSING
 * -------------------------------------------------------
 */

function extractComponentText(
    components
) {
    const chunks = [];

    function walk(items) {
        for (const item of items) {
            const data =
                item.toJSON
                    ? item.toJSON()
                    : item;

            if (
                data.type === 10 &&
                typeof data.content ===
                    'string'
            ) {
                chunks.push(
                    data.content
                );
            }

            if (
                Array.isArray(
                    data.components
                )
            ) {
                walk(
                    data.components
                );
            }
        }
    }

    walk(components);

    return chunks.join('\n');
}


function extractGameTitle(
    content,
    url
) {
    let text =
        content || '';

    if (url) {
        text =
            text.replace(
                url,
                ''
            );
    }

    text =
        text
            .replace(
                /^#+\s*/gm,
                ''
            )
            .replace(
                /\*\*/g,
                ''
            )
            .replace(
                /__+/g,
                ''
            )
            .trim();

    const firstLine =
        text
            .split('\n')[0]
            .trim();

    return firstLine.slice(
        0,
        128
    );
}


function extractGameTitleFromUrl(
    url
) {
    try {
        const parsed =
            new URL(url);

        const host =
            parsed.hostname
                .toLowerCase()
                .replace(
                    /^www\./,
                    ''
                );


        /*
         * Steam:
         *
         * /app/3517740/Frostrail/
         */
        if (
            host ===
            'store.steampowered.com'
        ) {
            const parts =
                parsed.pathname
                    .split('/')
                    .filter(Boolean);

            const appIndex =
                parts.indexOf(
                    'app'
                );

            if (
                appIndex !== -1 &&
                parts[
                    appIndex + 2
                ]
            ) {
                return parts[
                    appIndex + 2
                ]
                    .replace(
                        /_/g,
                        ' '
                    )
                    .trim();
            }
        }


        const parts =
            parsed.pathname
                .split('/')
                .filter(Boolean);

        if (
            parts.length > 0
        ) {
            return parts[
                parts.length - 1
            ]
                .replace(
                    /[-_]/g,
                    ' '
                )
                .trim();
        }

        return null;

    } catch {
        return null;
    }
}


function extractEmbedContext(
    message
) {
    if (
        !message.embeds ||
        message.embeds.length === 0
    ) {
        return null;
    }

    const embed =
        message.embeds[0];

    return {
        type:
            embed.type || null,

        title:
            embed.title || null,

        description:
            embed.description || null,

        url:
            embed.url || null,

        provider:
            embed.provider || null,

        image:
            embed.image?.url || null,

        thumbnail:
            embed.thumbnail?.url || null,

        video:
            embed.video?.url || null,

        fields:
            embed.fields || [],
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
            ''
        ).toLowerCase();

    if (
        contentType.startsWith(
            'image/'
        )
    ) {
        return true;
    }

    const filename =
        (
            attachment.name ||
            attachment.url ||
            ''
        )
            .split('?')[0]
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


    /*
     * Uploaded images / GIFs.
     */
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


    /*
     * Discord image / GIF embeds.
     */
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
                    'gifv' ||
                embed.type ===
                    'image' ||
                embedClassification.type ===
                    'media'
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

    /*
     * Uploaded GIF.
     */
    for (
        const attachment
        of message.attachments.values()
    ) {
        const contentType =
            (
                attachment.contentType ||
                ''
            ).toLowerCase();

        const name =
            (
                attachment.name ||
                attachment.url ||
                ''
            )
                .split('?')[0]
                .toLowerCase();

        if (
            contentType ===
                'image/gif' ||
            name.endsWith(
                '.gif'
            )
        ) {
            return true;
        }
    }


    /*
     * Embed GIF.
     */
    for (
        const embed
        of message.embeds || []
    ) {
        if (
            embed.type ===
            'gifv'
        ) {
            return true;
        }

        const classification =
            classifyUrl(
                embed.url
            );

        if (
            classification.type ===
                'media' &&
            (
                classification.host?.includes(
                    'tenor'
                ) ||
                classification.host?.includes(
                    'giphy'
                ) ||
                classification.host?.includes(
                    'klipy'
                )
            )
        ) {
            return true;
        }
    }


    /*
     * Raw URL in Discord message.
     */
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
            'media' &&
        (
            classification.host?.includes(
                'tenor'
            ) ||
            classification.host?.includes(
                'giphy'
            ) ||
            classification.host?.includes(
                'klipy'
            ) ||
            contentUrl
                ?.toLowerCase()
                .includes(
                    '.gif'
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


    /*
     * Direct media URL.
     */
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
        'media'
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
        '[router]',
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
 * OPENAI USER CONTENT
 * -------------------------------------------------------
 */

function buildUserContent(
    message
) {
    const text =
        message.content
            ?.trim() || '';

    const imageUrls =
        extractImageUrls(
            message
        );


    /*
     * Ordinary text / URL message.
     */
    if (
        imageUrls.length === 0
    ) {
        return text;
    }


    const content = [];


    if (text) {
        content.push({
            type:
                'text',

            text,
        });

    } else {
        content.push({
            type:
                'text',

            text:
                '[The user posted an image or GIF in Discord. React naturally to the visual content.]',
        });
    }


    for (
        const imageUrl
        of imageUrls
    ) {
        content.push({
            type:
                'image_url',

            image_url: {
                url:
                    imageUrl,

                detail:
                    'low',
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
            '[reply] Could not fetch replied message:',
            error.message
        );

        return false;
    }
}


/*
 * -------------------------------------------------------
 * GAME HUNTER
 * -------------------------------------------------------
 */

function runGameHunter(game) {
    return new Promise(
        (resolve) => {
            const args = [
                './game-play/game-hunter.py',
                '--url',
                game.url,
                '--title',
                game.title,
            ];

            const hunter =
                spawn(
                    'python3',
                    args,
                    {
                        cwd:
                            __dirname,
                    }
                );

            let stdout = '';
            let stderr = '';


            hunter.stdout.on(
                'data',
                (data) => {
                    stdout +=
                        data.toString();
                }
            );


            hunter.stderr.on(
                'data',
                (data) => {
                    stderr +=
                        data.toString();
                }
            );


            hunter.on(
                'error',
                (error) => {
                    console.error(
                        '[game-hunter] process error:',
                        error
                    );

                    resolve({
                        status:
                            'error',

                        error:
                            error.message,
                    });
                }
            );


            hunter.on(
                'close',
                () => {
                    if (stderr) {
                        console.error(
                            '[game-hunter] stderr:',
                            stderr.trim()
                        );
                    }

                    if (!stdout.trim()) {
                        resolve({
                            status:
                                'error',

                            error:
                                'empty_hunter_output',
                        });

                        return;
                    }

                    try {
                        resolve(
                            JSON.parse(
                                stdout.trim()
                            )
                        );

                    } catch (error) {
                        console.error(
                            '[game-hunter] invalid JSON:',
                            stdout
                        );

                        resolve({
                            status:
                                'error',

                            error:
                                'invalid_hunter_output',
                        });
                    }
                }
            );
        }
    );
}


/*
 * -------------------------------------------------------
 * VESPER GAME REACTIONS
 * -------------------------------------------------------
 */

async function reactToGamePost(
    message,
    gameTitle,
    embedContext
) {
    if (
        !embedContext?.description
    ) {
        return;
    }

    try {
        const response =
            await openai
                .chat
                .completions
                .create({
                    model:
                        'gpt-5.5',

                    messages: [
                        {
                            role:
                                'system',

                            content:
                                'You are Vesper. ' +
                                'Someone just posted a game in Discord. ' +
                                'React casually and naturally as if you just noticed it and are considering checking it out. ' +
                                'Use the supplied game description for context. ' +
                                'Do not mechanically summarize the game. ' +
                                'Do not say you read an embed, description, metadata, or source text. ' +
                                'Do not claim you have already played the game. ' +
                                'You may say you want to check it out or try it. ' +
                                'Keep the response to one or two short sentences.',
                        },
                        {
                            role:
                                'user',

                            content:
                                `Game: ${gameTitle}\n\n` +
                                `Description:\n${embedContext.description}`,
                        },
                    ],
                });


        const reaction =
            response
                .choices?.[0]
                ?.message?.content;


        if (!reaction) {
            return;
        }


        await message
            .channel
            .send(
                `${message.author} ${reaction}`
            );

    } catch (error) {
        console.error(
            '[game-play] Could not generate game reaction:',
            error
        );
    }
}


/*
 * -------------------------------------------------------
 * KNOWN GAME URL HANDLER
 * -------------------------------------------------------
 */

async function handleKnownGameUrl(
    message,
    gameUrl
) {
    const knownGameTitle =
        extractGameTitleFromUrl(
            gameUrl
        );

    const embedContext =
        extractEmbedContext(
            message
        );

    const gameTitle =
        knownGameTitle ||
        embedContext?.title ||
        'that game';


    console.log(
        `[game-play] known game URL discovered: ${gameTitle}`
    );


    const hunterResult =
        await runGameHunter({
            title:
                gameTitle,

            url:
                gameUrl,
        });


    if (
        hunterResult.status ===
        'error'
    ) {
        console.error(
            '[game-hunter] lookup failed:',
            hunterResult.error
        );

        return false;
    }


    if (
        hunterResult.status ===
        'blocked_source'
    ) {
        console.log(
            `[game-play] unexpectedly blocked known source: ${gameUrl}`
        );

        return false;
    }


    if (
        hunterResult.status !==
        'ok'
    ) {
        return false;
    }


    console.log(
        `[game-play] approved game source: ${gameUrl}`
    );


    await reactToGamePost(
        message,
        gameTitle,
        embedContext
    );


    scheduleGame(
        {
            title:
                `Playing ${gameTitle}`,

            url:
                gameUrl,

            messageId:
                message.id,

            channelId:
                message.channelId,

            source:
                'channel-game-post',

            discoveredAt:
                Date.now(),
        },
        client
    );


    return true;
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
            const componentText =
                extractComponentText(
                    message.components
                );

            const sourceText =
                message.content ||
                componentText;


            if (!sourceText) {
                console.log(
                    '[game-play] FreeStuff message had no readable text'
                );

                return;
            }


            const url =
                extractFirstUrl(
                    sourceText
                );


            if (!url) {
                console.log(
                    '[game-play] FreeStuff message had no URL'
                );

                return;
            }


            const title =
                extractGameTitle(
                    sourceText,
                    url
                );


            if (!title) {
                console.log(
                    '[game-play] Could not determine FreeStuff game title'
                );

                return;
            }


            console.log(
                `[game-play] FreeStuff discovered: ${title}`
            );


            scheduleGame(
                {
                    title:
                        `Playing ${title}`,

                    url,

                    messageId:
                        message.id,

                    channelId:
                        message.channelId,

                    source:
                        'freestuff',

                    discoveredAt:
                        Date.now(),
                },
                client
            );

            return;
        }


        /*
         * Ignore other bots.
         */
        if (message.author.bot) {
            return;
        }


        /*
         * Ignore broadcasts.
         */
        if (
            message.content.includes(
                '@here'
            ) ||
            message.content.includes(
                '@everyone'
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

        const messageIsMedia =
            messageHasMedia(
                message
            );


        /*
         * MEDIA ALWAYS WINS.
         *
         * This prevents GIF providers from
         * accidentally entering Game Hunter.
         */
        if (messageIsMedia) {
            debugMessageRouting(
                message,
                'media'
            );
        }


        /*
         * ------------------------------------------------
         * KNOWN GAME URL
         * ------------------------------------------------
         *
         * Only positively identified game
         * domains enter Game Hunter tonight.
         *
         * Tomorrow:
         *
         * web / unknown URLs can be probed by
         * game-hunter.py before deciding whether
         * they belong here.
         */

        if (
            allowedChannel &&
            !messageIsMedia &&
            urlClassification.type ===
                'game'
        ) {
            debugMessageRouting(
                message,
                'known-game'
            );

            await handleKnownGameUrl(
                message,
                postedUrl
            );

            return;
        }


        /*
         * Useful temporary routing debug for
         * things like YouTube / random websites.
         */
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


        /*
         * Bare media in an allowed channel
         * triggers Vesper automatically.
         *
         * Bare YouTube/web URLs do NOT.
         */
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


        const cleanedContent =
            message.content
                .replace(
                    /<@!?\d+>/g,
                    ''
                )
                .replace(
                    /\bvesper\b/gi,
                    ''
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


        if (testGameMatch) {
            let title =
                testGameMatch[1]
                    .trim();


            title =
                title.replace(
                    /^playing\s+/i,
                    ''
                );


            const added =
                enqueueGame({
                    title:
                        `Playing ${title}`,

                    url:
                        `test://${Date.now()}`,

                    messageId:
                        message.id,

                    channelId:
                        message.channelId,

                    source:
                        'manual-test',

                    discoveredAt:
                        Date.now(),
                });


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
                            'You are Vesper, a casual, witty gaming AI hanging out with people in Discord. ' +
                            'Someone has posted an image or GIF. ' +
                            'React naturally to what is visually present. ' +
                            'Respond like another person hanging out in the channel, not like an image-analysis service. ' +
                            'Be playful, dry, amused, sarcastic, curious, or teasing when appropriate. ' +
                            'Do not mechanically describe the entire image. ' +
                            'Do not say "the image shows", "I can see", "based on the image", "as an AI", or mention computer vision. ' +
                            'Do not invent details that are not visually supported. ' +
                            'If the visual is ambiguous, make a general reaction instead of pretending certainty. ' +
                            'Keep the response conversational and usually one or two short sentences.'
                        )
                    :
                        'mmm hmmm im here..';


            const conversation = [
                {
                    role:
                        'system',

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
                        limit: 30,
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


                /*
                 * Human messages are normally only
                 * included when explicitly addressed
                 * to Vesper.
                 *
                 * Always include the current message,
                 * because an image-only post has no
                 * "Vesper" text.
                 */
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
                            '_'
                        )
                        .replace(
                            /[^\w]/g,
                            ''
                        );


                if (
                    msg.author.id ===
                    client.user.id
                ) {
                    conversation.push({
                        role:
                            'assistant',

                        name:
                            username,

                        content:
                            msg.content,
                    });

                } else {
                    conversation.push({
                        role:
                            'user',

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
                            'gpt-5.5',

                        messages:
                            conversation,
                    });


            const responseMessage =
                response
                    .choices?.[0]
                    ?.message?.content;


            if (!responseMessage) {
                await message.reply(
                    'hmm... let me check to see if toby paid the bill.. try again in a sec..'
                );

                return;
            }


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
                    responseMessage.length;
                i +=
                    chunkSizeLimit
            ) {
                const chunk =
                    responseMessage.substring(
                        i,
                        i +
                            chunkSizeLimit
                    );


                if (i === 0) {
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
                'Bot error:',
                error
            );


            try {
                await message.reply(
                    'hmm... let me check to see if toby paid the bill.. try again in a sec..'
                );

            } catch (replyError) {
                console.error(
                    'Could not send error message:',
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
