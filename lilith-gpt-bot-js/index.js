require('dotenv/config');

const {
    Client,
    Events,
    GatewayIntentBits,
    MessageType,
} = require('discord.js');

const OpenAI = require('openai');

const {
    enqueueGame,
    scheduleGame,
    startNextGame,
} = require('./game-play/gameManager');

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
 * Extract the first URL from a block of text.
 */
function extractFirstUrl(content) {
    const match =
        content.match(/https?:\/\/[^\s<>)\]]+/i);

    if (!match) {
        return null;
    }

    return match[0].replace(/[),.!]+$/, '');
}

/*
 * Recursively collect text from Discord's newer
 * message component structure.
 *
 * FreeStuff currently uses these instead of
 * normal message.content / embeds.
 */
function extractComponentText(components) {
    const chunks = [];

    function walk(items) {
        for (const item of items) {
            const data =
                item.toJSON
                    ? item.toJSON()
                    : item;

            if (
                data.type === 10 &&
                typeof data.content === 'string'
            ) {
                chunks.push(data.content);
            }

            if (Array.isArray(data.components)) {
                walk(data.components);
            }
        }
    }

    walk(components);

    return chunks.join('\n');
}

/*
 * Extract a reasonable game title
 * from FreeStuff component text.
 */
function extractGameTitle(content, url) {
    let text = content;

    if (url) {
        text = text.replace(url, '');
    }

    text = text
        .replace(/^#+\s*/gm, '')
        .replace(/\*\*/g, '')
        .replace(/__+/g, '')
        .trim();

    const firstLine =
        text.split('\n')[0].trim();

    return firstLine.slice(0, 128);
}

/*
 * Return true if this looks like
 * a game-store URL Vesper understands.
 */
function isGameUrl(url) {
    if (!url) {
        return false;
    }

    try {
        const parsed = new URL(url);

        const host =
            parsed.hostname
                .toLowerCase()
                .replace(/^www\./, '');

        const gameHosts = [
            'store.steampowered.com',
            'store.epicgames.com',
            'gog.com',
            'itch.io',
            'humblebundle.com',
        ];

        return gameHosts.some(
            (gameHost) =>
                host === gameHost ||
                host.endsWith(`.${gameHost}`)
        );
    } catch {
        return false;
    }
}

/*
 * Derive the game title from a store URL.
 */
function extractGameTitleFromUrl(url) {
    try {
        const parsed = new URL(url);

        const host =
            parsed.hostname
                .toLowerCase()
                .replace(/^www\./, '');

        /*
         * Steam:
         *
         * /app/3517740/Frostrail/
         */
        if (
            host === 'store.steampowered.com'
        ) {
            const parts =
                parsed.pathname
                    .split('/')
                    .filter(Boolean);

            const appIndex =
                parts.indexOf('app');

            if (
                appIndex !== -1 &&
                parts[appIndex + 2]
            ) {
                return parts[
                    appIndex + 2
                ]
                    .replace(/_/g, ' ')
                    .trim();
            }
        }

        /*
         * Generic fallback:
         * use the final meaningful URL segment.
         */
        const parts =
            parsed.pathname
                .split('/')
                .filter(Boolean);

        if (parts.length > 0) {
            return parts[
                parts.length - 1
            ]
                .replace(/[-_]/g, ' ')
                .trim();
        }

        return null;
    } catch {
        return null;
    }
}

/*
 * Pull useful game information from
 * Discord's generated store preview.
 */
function extractEmbedContext(message) {
    if (
        !message.embeds ||
        message.embeds.length === 0
    ) {
        return null;
    }

    const embed =
        message.embeds[0];

    return {
        title:
            embed.title || null,

        description:
            embed.description || null,

        url:
            embed.url || null,

        fields:
            embed.fields || [],
    };
}

/*
 * Let Vesper react naturally to a game
 * somebody dropped in chat.
 */
async function reactToGamePost(
    message,
    gameTitle,
    embedContext
) {
    if (!embedContext?.description) {
        return;
    }

    try {
        const response =
            await openai.chat.completions.create({
                model: 'gpt-5.5',

                messages: [
                    {
                        role: 'system',

                        content:
                            'You are Vesper. ' +
                            'Someone just posted a game in Discord. ' +
                            'React casually and naturally as if you just noticed it and are considering checking it out. ' +
                            'Use the supplied game description for context. ' +
                            'Do not mechanically summarize the game. ' +
                            'Do not say you read a description, embed, review, metadata, or source text. ' +
                            'Do not claim you have already played it. ' +
                            'You may say that you want to check it out or try it. ' +
                            'Keep the response to one or two short sentences.',
                    },
                    {
                        role: 'user',

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

        await message.channel.send(
            `${message.author} ${reaction}`
        );
    } catch (error) {
        console.error(
            '[game-play] Could not generate game reaction:',
            error
        );
    }
}

client.once(
    Events.ClientReady,
    (readyClient) => {
        console.log(
            `The bot is online as ${readyClient.user.tag}.`
        );
    }
);

client.on(
    Events.MessageCreate,
    async (message) => {
        /*
         * FreeStuff gets special handling
         * before the generic bot-ignore rule.
         */
        if (
            FREESTUFF_BOT_ID &&
            message.author.id === FREESTUFF_BOT_ID
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

            const game = {
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
            };

            console.log(
                `[game-play] FreeStuff discovered: ${title}`
            );

            /*
             * FreeStuff games get the same delayed
             * "maybe I'll check this out" behavior
             * as human game posts.
             */
            scheduleGame(
                game,
                client
            );

            return;
        }

        /*
         * Ignore all other bots.
         */
        if (message.author.bot) {
            return;
        }

        /*
         * Ignore @everyone / @here.
         */
        if (
            message.content.includes('@here') ||
            message.content.includes('@everyone')
        ) {
            return;
        }

        /*
         * Ambient game discovery.
         *
         * A human can simply drop a recognized
         * store link into an allowed channel.
         *
         * Vesper does NOT need to be addressed.
         */
        const ambientAllowedChannel =
            CHANNELS.includes(
                message.channelId
            );

        if (ambientAllowedChannel) {
            const gameUrl =
                extractFirstUrl(
                    message.content
                );

            if (
                gameUrl &&
                isGameUrl(gameUrl)
            ) {
                const gameTitle =
                    extractGameTitleFromUrl(
                        gameUrl
                    );

                if (gameTitle) {
                    console.log(
                        `[game-play] discovered game in chat: ${gameTitle}`
                    );

                    /*
                     * Use Discord's generated Steam/store
                     * preview as immediate context.
                     */
                    const embedContext =
                        extractEmbedContext(
                            message
                        );

                    /*
                     * Social reaction happens immediately.
                     *
                     * Example:
                     *
                     * "Okay, trains and zombies?
                     * Yeah, I'm checking this out."
                     */
                    await reactToGamePost(
                        message,
                        gameTitle,
                        embedContext
                    );

                    /*
                     * Then Vesper waits a little while
                     * before actually "playing" it.
                     */
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
                }
            }
        }

        /*
         * Ignore Discord replies during
         * normal conversational handling.
         */
        if (
            message.type ===
            MessageType.Reply
        ) {
            return;
        }

        /*
         * Must either be in an allowed channel
         * OR directly mention Vesper.
         */
        const allowedChannel =
            CHANNELS.includes(
                message.channelId
            );

        const mentionedBot =
            message.mentions.users.has(
                client.user.id
            );

        if (
            !allowedChannel &&
            !mentionedBot
        ) {
            return;
        }

        /*
         * Normal conversation still requires
         * Vesper's name or direct mention.
         */
        const namedVesper =
            /\bvesper\b/i.test(
                message.content
            );

        if (
            !namedVesper &&
            !mentionedBot
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
         * Manual debugging hook.
         *
         * This bypasses the discovery delay.
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

                    /*
                     * Unique synthetic URL allows
                     * repeated testing.
                     */
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

        await message.channel.sendTyping();

        const sendTypingInterval =
            setInterval(
                () => {
                    message.channel
                        .sendTyping()
                        .catch(
                            () => {}
                        );
                },

                5000
            );

        try {
            const conversation = [
                {
                    role:
                        'system',

                    content:
                        'mmm hmmm im here..',
                },
            ];

            const prevMessages =
                await message
                    .channel
                    .messages
                    .fetch({
                        limit: 30,
                    });

            const orderedMessages =
                [
                    ...prevMessages
                        .values(),
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
                 * Human messages enter the
                 * conversation only when Vesper
                 * was named / mentioned.
                 */
                if (
                    msg.author.id !==
                    client.user.id
                ) {
                    const namedVesper =
                        /\bvesper\b/i.test(
                            msg.content
                        );

                    const mentionsVesper =
                        msg.mentions.users.has(
                            client.user.id
                        );

                    if (
                        !namedVesper &&
                        !mentionsVesper
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
                            msg.content,
                    });
                }
            }

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

            if (
                !responseMessage
            ) {
                await message.reply(
                    'hmm... let me check to see if toby paid the bill.. try again in a sec..'
                );

                return;
            }

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
                    responseMessage
                        .substring(
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
            } catch (
                replyError
            ) {
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
