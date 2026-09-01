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

    text = text
        .replace(/\*\*/g, '')
        .replace(/__+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const firstLine =
        text.split('\n')[0].trim();

    return firstLine.slice(0, 128);
}

client.once(Events.ClientReady, (readyClient) => {
    console.log(`The bot is online as ${readyClient.user.tag}.`);
});

client.on(Events.MessageCreate, async (message) => {
    // Ignore bots
    if (message.author.bot) return;

    // Ignore @everyone / @here
    if (
        message.content.includes('@here') ||
        message.content.includes('@everyone')
    ) {
        return;
    }

    // Ignore Discord replies
    if (message.type === MessageType.Reply) {
        return;
    }

    // Must either be in an allowed channel OR directly mention Vesper.
    const allowedChannel = CHANNELS.includes(message.channelId);
    const mentionedBot = message.mentions.users.has(client.user.id);

    if (!allowedChannel && !mentionedBot) {
        return;
    }

    /*
     * In allowed channels, respond whenever the word "Vesper"
     * appears anywhere in the message.
     *
     * Examples:
     *   Vesper, what do you think?
     *   Hey Vesper, look at this.
     *   I think Vesper is a bitch.
     *   Does Vesper know about this?
     *
     * Also respond if Discord directly @mentions the bot.
     */
    const namedVesper = /\bvesper\b/i.test(message.content);

    if (!namedVesper && !mentionedBot) {
        return;
    }

    await message.channel.sendTyping();

    const sendTypingInterval = setInterval(() => {
        message.channel.sendTyping().catch(() => {});
    }, 5000);

    try {
        const conversation = [
            {
                role: 'system',
                content: 'mmm hmmm im here..',
            },
        ];

        const prevMessages = await message.channel.messages.fetch({
            limit: 30,
        });

        const orderedMessages = [...prevMessages.values()].reverse();

        for (const msg of orderedMessages) {
            // Ignore other bots
            if (msg.author.bot && msg.author.id !== client.user.id) {
                continue;
            }

            /*
             * Keep Vesper's own previous replies.
             *
             * For users, only include messages where:
             *   - "Vesper" appears anywhere in the message, OR
             *   - Vesper was directly @mentioned.
             */
            if (msg.author.id !== client.user.id) {
                const namedVesper =
                    /\bvesper\b/i.test(msg.content);

                const mentionsVesper =
                    msg.mentions.users.has(client.user.id);

                if (!namedVesper && !mentionsVesper) {
                    continue;
                }
            }

            const username = msg.author.username
                .replace(/\s+/g, '_')
                .replace(/[^\w]/g, '');

            if (msg.author.id === client.user.id) {
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

        const response = await openai.chat.completions.create({
            model: 'gpt-5.5',
            messages: conversation,
        });

        const responseMessage =
            response.choices?.[0]?.message?.content;

        if (!responseMessage) {
            await message.reply(
                'hmm... let me check to see if toby paid the bill.. try again in a sec..'
            );
            return;
        }

        // Discord message limit
        const chunkSizeLimit = 2000;

        for (
            let i = 0;
            i < responseMessage.length;
            i += chunkSizeLimit
        ) {
            const chunk = responseMessage.substring(
                i,
                i + chunkSizeLimit
            );

            /*
             * First chunk replies directly to the user.
             * Remaining chunks just go into the channel.
             *
             * Otherwise Discord creates a separate reply ping
             * for every 2,000-character chunk.
             */
            if (i === 0) {
                await message.reply(chunk);
            } else {
                await message.channel.send(chunk);
            }
        }
    } catch (error) {
        console.error('Bot error:', error);

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
         * Always stop the typing interval, even if
         * Discord/OpenAI throws an error.
         */
        clearInterval(sendTypingInterval);
    }
});

client.login(process.env.TOKEN);
