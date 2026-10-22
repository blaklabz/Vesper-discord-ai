"use strict";

// Vesper's narrowly scoped Discord bridge to the independent Gamekeeper bot.
const GAMEKEEPER_BOT_ID = process.env.GAMEKEEPER_BOT_ID || "1562617940757585971";
const GAMEKEEPER_CHANNEL_ID = process.env.GAMEKEEPER_CHANNEL_ID || "1232029053452812329";
const SABLE_USER_ID = process.env.SABLE_USER_ID || "";
const ADMIN_USER_ID = (process.env.DISCORD_ADMIN_IDS || "").split(",").map(x => x.trim()).find(Boolean);
const GAMES = ["core-keeper-2", "enshrouded", "shadowdark", "v-rising", "valheim", "windrose", "quake"];
const LABELS = { "core-keeper-2": "Core Keeper 2", "v-rising": "V Rising", enshrouded: "Enshrouded", shadowdark: "Shadowdark", valheim: "Valheim", windrose: "Windrose", quake: "Quake" };
const busy = new Set();

function parseRequest(content) {
    const text = String(content || "").replace(/<@!?\d+>/g, " ").replace(/\bvesper\b[:,]?/gi, " ").trim();
    const actions = [
        ["start", /\b(start|boot|spin up|fire up|bring up|wake up|turn on|launch)\b/i],
        ["stop", /\b(stop|shut down|shutdown|turn off|power off|kill)\b/i],
        ["restart", /\b(restart|reboot)\b/i],
        ["status", /\b(status|running|online|up|down)\b/i],
        ["alwayson", /\b(always[ -]?on)\b/i],
        ["ondemand", /\b(on[ -]?demand)\b/i],
    ];
    const action = actions.find(([, pattern]) => pattern.test(text))?.[0];
    if (!action) return null;
    const aliases = [
        ["core-keeper-2", /\bcore[ -]?keeper(?:[ -]?2)?\b/i],
        ["v-rising", /\bv[ -]?rising\b/i],
        ...GAMES.filter(x => !["core-keeper-2", "v-rising"].includes(x)).map(x => [x, new RegExp(`\\b${x}\\b`, "i")]),
    ];
    const game = aliases.find(([, pattern]) => pattern.test(text))?.[0];
    return game ? { action, game } : null;
}

function waitForGamekeeper(client, channelId, game, timeoutMs = 25000) {
    let handler, timer;
    const promise = new Promise((resolve, reject) => {
        handler = msg => {
            if (msg.author?.id !== GAMEKEEPER_BOT_ID || msg.channelId !== channelId) return;
            const content = String(msg.content || "");
            if (!content.toLowerCase().includes(game.toLowerCase()) && !/controller error/i.test(content)) return;
            cleanup();
            resolve(content);
        };
        timer = setTimeout(() => { cleanup(); reject(new Error("Gamekeeper did not respond")); }, timeoutMs);
        client.on("messageCreate", handler);
    });
    function cleanup() { clearTimeout(timer); client.off("messageCreate", handler); }
    return { promise, cancel: cleanup };
}

async function command(client, channel, action, game) {
    const waiting = waitForGamekeeper(client, channel.id, game);
    try {
        await channel.send({ content: `!game ${action} ${game}`, allowedMentions: { parse: [] } });
        return await waiting.promise;
    } catch (error) {
        waiting.cancel();
        throw error;
    }
}

async function notifyAdmin(client, detail) {
    if (!ADMIN_USER_ID) return false;
    try {
        const user = await client.users.fetch(ADMIN_USER_ID);
        await user.send({ content: `🎮 Vesper / Gamekeeper: ${detail}`, allowedMentions: { parse: [] } });
        return true;
    } catch (error) {
        console.warn("[gamekeeper] admin DM failed:", error.message);
        return false;
    }
}

async function handle({ message, client, sableAvailability, openai }) {
    if (message.author.bot || !message.guild || message.channelId !== GAMEKEEPER_CHANNEL_ID) return false;
    const addressed = message.mentions.users.has(client.user.id) || /\bvesper\b/i.test(message.content);
    if (!addressed) return false;
    const request = parseRequest(message.content);
    if (!request) return false;
    const { action, game } = request;
    const label = LABELS[game];
    const key = `${message.channelId}:${game}`;
    if (busy.has(key)) { await message.reply(`I'm already dealing with ${label}. One catastrophe at a time. 🙄`); return true; }
    busy.add(key);
    try {
        const sable = await sableAvailability(message.guild);
        if (sable === "online") {
            let flourish = `Oh, ${label} needs attention? Apparently I'm management now. 🙄`;
            try {
                const result = await openai.chat.completions.create({
                    model: "gpt-5.5", max_completion_tokens: 140,
                    messages: [
                        { role: "system", content: "You are Vesper, a snarky goth gaming companion. Write ONE short, witty, varied sentence reacting to a game server request before handing it to Sable. Do not claim you executed anything. No mentions, no commands, no line breaks. Output only the sentence." },
                        { role: "user", content: `Game: ${label}; requested action: ${action}` },
                    ],
                });
                flourish = String(result.choices?.[0]?.message?.content || "").replace(/<@!?\d+>|@everyone|@here|@sable/gi, "").trim().slice(0, 250) || flourish;
            } catch (error) { console.warn("[gamekeeper] flourish failed:", error.message); }
            await message.reply({
                content: `${flourish}\n<@${SABLE_USER_ID}>, please ${action} **${game}** through Gamekeeper and report the result.`,
                allowedMentions: { users: [SABLE_USER_ID], repliedUser: false },
            });
            return true;
        }
        if (action !== "start" && action !== "status") {
            const notified = await notifyAdmin(client, `${message.author.username} requested ${action} ${game} while Sable was ${sable}. Channel: <#${message.channelId}>`);
            await message.reply({ content: `Sable's ${sable}, and I'm not authorized to ${action} ${label}. Ask <@${ADMIN_USER_ID}>${notified ? " — I've also sent a DM." : "."}`, allowedMentions: { users: ADMIN_USER_ID ? [ADMIN_USER_ID] : [], repliedUser: false } });
            return true;
        }
        const channel = await client.channels.fetch(GAMEKEEPER_CHANNEL_ID);
        if (!channel?.send) throw new Error("Gamekeeper command channel unavailable");
        const status = await command(client, channel, "status", game);
        if (/⚠️|error|⛔/i.test(status)) throw new Error(status);
        if (action === "status") { await message.reply(`Gamekeeper says: ${status}`); return true; }
        if (/\brunning\b/i.test(status)) { await message.reply(`${label} is already running. Try not to break it. 😈`); return true; }
        if (!/\bstopped\b/i.test(status)) throw new Error(`Unrecognized status: ${status}`);
        await message.reply(`Sable's ${sable}. Fine, I'll wake ${label} myself. 🙄`);
        const result = await command(client, channel, "start", game);
        if (/⚠️|error|⛔/i.test(result)) throw new Error(result);
        await message.channel.send(`🎮 Gamekeeper: ${result}`);
        return true;
    } catch (error) {
        console.error("[gamekeeper]", error);
        await notifyAdmin(client, `${message.author.username} requested ${action} ${game}; failed: ${error.message}`);
        await message.reply("Gamekeeper didn't confirm that operation. I've alerted blaklabz; no victory dance yet. ⚠️");
        return true;
    } finally { busy.delete(key); }
}

module.exports = { handle, parseRequest };
