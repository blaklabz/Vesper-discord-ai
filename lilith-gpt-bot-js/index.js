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
 * Game-play message parsing
 */
function extractFirstUrl(content) {
    const match =
        content.match(/https?:\/\/[^\s<>]+/i);

    if (!match) {
        return null;
    }

    return match[0].replace(/[),.!]+$/, '');
}

function extractGameTitle(content, url) {
    let text = content;

    if (url) {
        text = text.replace(url, '');
    }

    /*
     * Strip common markdown / punctuation noise.
     */
    text = text
        .replace(/\*\*/g, '')
        .replace(/__+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    /*
     * Temporary fallback.
     *
     * Once we see the actual FreeStuff message format,
     * we'll make this smarter.
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
        const url =
            extractFirstUrl(message.content);

        if (!url) {
            console.log(
                '[game-play] FreeStuff message had no URL'
            );

            return;
        }

        const title =
            extractGameTitle(
                message.content,
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
                title,
                url,
                messageId: message.id,
                channelId: message.channelId,
                source: 'freestuff',
                discoveredAt: Date.now(),
            });

        if (added) {
            startNextGame(client);
        }

        return;
    }

    // Ignore all other bots.
    if (message.author.bot) {
        return;
    }

    // Ignore @everyone / @here.
    if (
        message.content.includes('@here') ||
        message.content.includes('@everyone')
    ) {
        return;
    }

    /*
     * Ignore Discord replies during normal conversation.
     *
     * Game-play can eventually get its own reply handling
     * if we need it.
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
        message.mentions.users.has(client.user.id);

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
        /\bvesper\b/i.test(message.content);

    if (!namedVesper && !mentionedBot) {
        return;
    }

    /*
     * Remove Vesper's name / direct mention so
     * command parsing can work against the
     * meaningful part of the message.
     *
     * Example:
     *
     *   Vesper testgame Quake
     *
     * becomes:
     *
     *   testgame Quake
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
     *   Vesper testgame Dredge
     */
    const testGameMatch =
        cleanedContent.match(
            /^testgame\s+(.+)$/i
        );

    if (testGameMatch) {
        const title =
            testGameMatch[1].trim();

        const added =
            enqueueGame({
                title,

                /*
                 * Give every manual test a unique URL
                 * so duplicate detection doesn't block
                 * repeated testing of the same title.
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
             * Keep Vesper's own messages so
             * conversational context persists.
             */
            if (
                msg.author.bot &&
                msg.author.id !== client.user.id
            ) {
                continue;
            }

            /*
             * For human messages, only include
             * messages where Vesper was named
             * or directly mentioned.
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
             * Remaining chunks are sent
             * normally so Discord doesn't
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
         * Always stop the typing interval,
         * even if Discord/OpenAI throws.
         */
        clearInterval(
            sendTypingInterval
        );
    }
});

client.login(process.env.TOKEN);
