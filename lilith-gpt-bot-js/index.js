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
 * Extract a reasonable game title from FreeStuff text.
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
 * Return true if the URL looks like a game-store page
 * we want Vesper to treat as a game discovery.
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
 * Try to derive a human-readable game title
 * from a recognized store URL.
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
         * /app/3517740/Frostrail/
         */
        if (host === 'store.steampowered.com') {
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
                return parts[appIndex + 2]
                    .replace(/_/g, ' ')
                    .trim();
            }
        }

        /*
         * Generic fallback:
         * use the last meaningful URL path segment.
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

client.once(Events.ClientReady, (readyClient) => {
    console.log(
        `The bot is online as ${readyClient.user.tag}.`
    );
});

client.on(Events.MessageCreate, async (message) => {
    /*
     * FreeStuff gets special handling before
     * the generic "ignore bots" rule.
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
            extractFirstUrl(sourceText);

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
                '[game-play] Could not determine game title'
            );

            return;
        }

        const added =
            enqueueGame({
                title: `Playing ${title}`,
                url,
                messageId: message.id,
                channelId: message.channelId,
                source: 'freestuff',
                discoveredAt: Date.now(),
            });

        if (added) {
            console.log(
                `[game-play] FreeStuff queued: ${title}`
            );

            startNextGame(client);
        }

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
     * If a human posts a recognizable game-store
     * URL in one of Vesper's allowed channels,
     * silently queue it.
     *
     * They do not need to say "Vesper".
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
                const added =
                    enqueueGame({
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
                    });

                if (added) {
                    console.log(
                        `[game-play] discovered game in chat: ${gameTitle}`
                    );

                    startNextGame(client);
                }
            }
        }
    }

    /*
     * Ignore Discord replies during normal
     * conversational handling.
     */
    if (message.type === MessageType.Reply) {
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

    if (!allowedChannel && !mentionedBot) {
        return;
    }

    /*
     * Normal conversational trigger.
     */
    const namedVesper =
        /\bvesper\b/i.test(
            message.content
        );

    if (!namedVesper && !mentionedBot) {
        return;
    }

    const cleanedContent =
        message.content
            .replace(/<@!?\d+>/g, '')
            .replace(/\bvesper\b/gi, '')
            .trim();

    /*
     * Temporary manual test hook.
     */
    const testGameMatch =
        cleanedContent.match(
            /^testgame\s+(.+)$/i
        );

    if (testGameMatch) {
        let title =
            testGameMatch[1].trim();

        title = title.replace(
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
            startNextGame(client);

            await message.reply(
                `queued **${title}**`
            );
        }

        return;
    }

    await message.channel.sendTyping();

    const sendTypingInterval =
        setInterval(() => {
            message.channel
                .sendTyping()
                .catch(() => {});
        }, 5000);

    try {
        const conversation = [
            {
                role: 'system',
                content: 'mmm hmmm im here..',
            },
        ];

        const prevMessages =
            await message.channel.messages.fetch({
                limit: 30,
            });

        const orderedMessages =
            [...prevMessages.values()].reverse();

        for (const msg of orderedMessages) {
            if (
                msg.author.bot &&
                msg.author.id !== client.user.id
            ) {
                continue;
            }

            if (
                msg.author.id !== client.user.id
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
                    .replace(/\s+/g, '_')
                    .replace(/[^\w]/g, '');

            if (
                msg.author.id === client.user.id
            ) {
                conversation.push({
                    role: 'assistant',
                    name: username,
                    content: msg.content,
                });
            } else {
                conversation.push({
                    role: 'user',
                    name: username,
                    content: msg.content,
                });
            }
        }

        const response =
            await openai.chat.completions.create({
                model: 'gpt-5.5',
                messages: conversation,
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

        const chunkSizeLimit = 2000;

        for (
            let i = 0;
            i < responseMessage.length;
            i += chunkSizeLimit
        ) {
            const chunk =
                responseMessage.substring(
                    i,
                    i + chunkSizeLimit
                );

            if (i === 0) {
                await message.reply(chunk);
            } else {
                await message.channel.send(
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
});

client.login(process.env.TOKEN);
