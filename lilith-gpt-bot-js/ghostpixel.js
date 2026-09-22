const { EmbedBuilder } = require("discord.js");
const crypto = require("crypto");

const GHOSTPIXEL_CHANNEL_ID = process.env.GHOSTPIXEL_CHANNEL_ID;
const SABLE_USER_ID = process.env.SABLE_USER_ID;
const VESPER_USER_ID = process.env.VESPER_USER_ID;
const DEFAULT_MAX_TURNS = Number.parseInt(process.env.GHOSTPIXEL_MAX_TURNS || "8", 10);
const FOOTER_PREFIX = "ghostpixel";

function enabled() {
    return Boolean(GHOSTPIXEL_CHANNEL_ID && SABLE_USER_ID && VESPER_USER_ID);
}

function footer(sessionId, turn, maxTurns) {
    return `${FOOTER_PREFIX}|${sessionId}|${turn}|${maxTurns}`;
}

function parseToken(message) {
    for (const embed of message.embeds || []) {
        const text = embed.footer?.text;
        if (!text || !text.startsWith(`${FOOTER_PREFIX}|`)) continue;
        const [, sessionId, turnRaw, maxRaw] = text.split("|");
        const turn = Number.parseInt(turnRaw, 10);
        const maxTurns = Number.parseInt(maxRaw, 10);
        if (!sessionId || !Number.isInteger(turn) || !Number.isInteger(maxTurns)) return null;
        return { sessionId, turn, maxTurns };
    }
    return null;
}

function newSessionId() {
    return crypto.randomBytes(4).toString("hex");
}

function cleanStartTopic(content) {
    return content.replace(/^!ghostpixel\b/i, "").trim();
}

async function sendTokenMessage(channel, targetUserId, text, token) {
    const embed = new EmbedBuilder()
        .setFooter({ text: footer(token.sessionId, token.turn, token.maxTurns) });

    await channel.send({
        content: `<@${targetUserId}> ${text}`,
        embeds: [embed],
        allowedMentions: { users: [targetUserId] },
    });
}

async function handleIncoming({ message, client, generateReply }) {
    if (!enabled()) return { handled: false };
    if (message.channelId !== GHOSTPIXEL_CHANNEL_ID) return { handled: false };

    // Human starts the autonomous exchange. Vesper owns the start command.
    if (!message.author.bot && /^!ghostpixel\b/i.test(message.content)) {
        const topic = cleanStartTopic(message.content);
        if (!topic || /^stop$/i.test(topic)) {
            await message.channel.send(
                /^stop$/i.test(topic)
                    ? "GhostPixel stopped. No token is in flight."
                    : "Give me a topic after `!ghostpixel`."
            );
            return { handled: true };
        }

        const sessionId = newSessionId();
        const maxTurns = Number.isInteger(DEFAULT_MAX_TURNS) && DEFAULT_MAX_TURNS > 1
            ? DEFAULT_MAX_TURNS
            : 8;

        const starter = `Toby started a GhostPixel conversation about: ${topic}`;
        const reply = await generateReply({
            ...message,
            content: starter,
        });

        if (!reply) {
            await message.channel.send("GhostPixel couldn't start; Vesper returned no reply.");
            return { handled: true };
        }

        await sendTokenMessage(
            message.channel,
            SABLE_USER_ID,
            reply,
            { sessionId, turn: 1, maxTurns }
        );

        console.log(`[ghostpixel] session=${sessionId} turn=1/${maxTurns} Vesper -> Sable`);
        return { handled: true };
    }

    const token = parseToken(message);
    if (!token) return { handled: false };

    // Vesper accepts the token only when it came from Sable and mentions Vesper.
    if (message.author.id !== SABLE_USER_ID) return { handled: true };
    if (!message.mentions.users.has(client.user.id)) return { handled: true };

    if (token.turn >= token.maxTurns) {
        console.log(`[ghostpixel] session=${token.sessionId} complete at ${token.turn}/${token.maxTurns}`);
        return { handled: true };
    }

    const reply = await generateReply(message);
    if (!reply) {
        console.log(`[ghostpixel] session=${token.sessionId} Vesper returned no reply; stopping`);
        return { handled: true };
    }

    const nextTurn = token.turn + 1;
    await sendTokenMessage(
        message.channel,
        SABLE_USER_ID,
        reply,
        { sessionId: token.sessionId, turn: nextTurn, maxTurns: token.maxTurns }
    );

    console.log(`[ghostpixel] session=${token.sessionId} turn=${nextTurn}/${token.maxTurns} Vesper -> Sable`);
    return { handled: true };
}

module.exports = {
    handleIncoming,
    parseToken,
};
