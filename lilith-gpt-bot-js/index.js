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
 *
 * FreeStuff currently puts its game announcement
 * inside nested type-10 text components rather than
 * normal message.content or embeds.
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
 * Extract a reasonable game title from the
 * FreeStuff text block.
 */
function extractGameTitle(content, url) {
    let text = content;

    if (url) {
        text = text.replace(url, '');
    }

    text = text
        /*
         * Strip markdown heading markers.
         *
         * Example:
         * ### Game name here
         *
         * becomes:
         * Game name here
         */
        .replace(/^#+\s*/gm, '')

        /*
         * Strip basic markdown emphasis.
         */
        .replace(/\*\*/g, '')
        .replace(/__+/g, '')

        /*
         * Clean up whitespace.
         */
        .trim();

    /*
     * The first line of the FreeStuff component
     * is currently the game title.
     */
    const firstLine =
        text.split('\n')[0].trim();

    return firstLine.slice(0, 128);
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
        /*
         * FreeStuff's newer message format uses
         * Discord components instead of normal
         * message content.
         */
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
                /*
                 * Discord isn't consistently rendering
                 * the literal "Playing" prefix for bot
                 * activities, so keep it in the name.
                 */
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
        CHANNELS.includes(message.channelId);

    const mentionedBot =
        message.mentions.users.has(
            client.user.id
        );

    if (!allowedChannel && !mentionedBot) {
        return;
    }

    /*
     * In allowed channels, respond whenever
     * the word "Vesper" appears anywhere
     * in the message.
     *
     * Also respond if Discord directly
     * @mentions the bot.
     */
    const namedVesper =
        /\bvesper\b/i.test(
            message.content
        );

    if (!namedVesper && !mentionedBot) {
        return;
    }

    /*
     * Remove Vesper's name / direct mention so
     * command parsing operates on the meaningful
     * part of the message.
     */
    const cleanedContent =
        message.content
            .replace(/<@!?\d+>/g, '')
            .replace(/\bvesper\b/gi, '')
            .trim();

    /*
     * Temporary manual game-play test hook.
     *
     * Examples:
     *
     *   Vesper testgame Quake
     *   Vesper testgame Chicken
     *   Vesper testgame Enshrouded
     */
    const testGameMatch =
        cleanedContent.match(
            /^testgame\s+(.+)$/i
        );

    if (testGameMatch) {
        let title =
            testGameMatch[1].trim();

        /*
         * Let either of these work:
         *
         *   Vesper testgame Quake
         *   Vesper testgame Playing Quake
         */
        title = title.replace(
            /^playing\s+/i,
            ''
        );

        const added =
            enqueueGame({
                /*
                 * Keep the visible activity wording
                 * consistent with FreeStuff games.
                 */
                title: `Playing ${title}`,

                /*
                 * Each manual test gets a unique URL
                 * so repeated testing of the same
                 * game isn't blocked as a duplicate.
                 */
                url: `test://${Date.now()}`,

                messageId: message.id,
                channelId: message.channelId,
                source: 'manual-test',
                discoveredAt: Date.now(),
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
            /*
             * Ignore other bots.
             *
             * Keep Vesper's own previous replies.
             */
            if (
                msg.author.bot &&
                msg.author.id !== client.user.id
            ) {
                continue;
            }

            /*
             * For users, only include messages
             * where Vesper was named or directly
             * mentioned.
             */
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

        /*
         * Discord message limit.
         */
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

            /*
             * First chunk replies directly
             * to the user.
             *
             * Remaining chunks just go into
             * the channel so Discord doesn't
             * create repeated reply pings.
             */
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
        /*
         * Always stop the typing interval.
         */
        clearInterval(
            sendTypingInterval
        );
    }
});

client.login(process.env.TOKEN);
