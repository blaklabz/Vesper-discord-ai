"use strict";

// Vesper's narrowly scoped Discord bridge to the independent Gamekeeper bot.
const GAMEKEEPER_BOT_ID = process.env.GAMEKEEPER_BOT_ID || "1562610844603387914";
const GAMEKEEPER_CHANNEL_ID = process.env.GAMEKEEPER_CHANNEL_ID || "1232029053452812329";
const SABLE_USER_ID = process.env.SABLE_USER_ID || "";
// Dedicated alert recipient wins; otherwise choose a human admin, never a bot.
const ADMIN_IDS = (process.env.DISCORD_ADMIN_IDS || "").split(",").map(x => x.trim()).filter(Boolean);
const ADMIN_USER_ID = process.env.GAMEKEEPER_ADMIN_USER_ID ||
    ADMIN_IDS.find(id => id === "195895553911947264") ||
    ADMIN_IDS.find(id => id !== "1232035346531745956" && id !== GAMEKEEPER_BOT_ID && id !== SABLE_USER_ID) ||
    "195895553911947264";
const GAMES = ["core-keeper-2", "enshrouded", "shadowdark", "v-rising", "valheim", "windrose", "quake"];
const LABELS = { "core-keeper-2": "Core Keeper 2", "v-rising": "V Rising", enshrouded: "Enshrouded", shadowdark: "Shadowdark", valheim: "Valheim", windrose: "Windrose", quake: "Quake" };
const busy = new Set();

// Match Vesper's existing conversational wake timing in index.js.
const { beginConversationalWake, wakeEngaged } = require("./vesper-presence");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.floor(min + Math.random() * (max - min + 1));
const choose = options => options[Math.floor(Math.random() * options.length)];

async function typingPause(channel, ms) {
    const typing = () => channel.sendTyping().catch(error =>
        console.warn("[gamekeeper] typing indicator failed:", error.message));
    await typing();
    const refresh = setInterval(typing, 5000);
    try { await pause(ms); } finally { clearInterval(refresh); }
}

function wakeDelay(idleMs) {
    const minutes = idleMs / 60000;
    if (minutes < 5) return randomBetween(1000, 3000);
    if (minutes < 15) return randomBetween(3000, 8000);
    if (minutes < 30) return randomBetween(8000, 15000);
    if (minutes < 60) return randomBetween(15000, 30000);
    return randomBetween(30000, 60000);
}

async function naturalReply(message, content, { followup = false, wakeMs = 0 } = {}) {
    const delay = followup ? randomBetween(1800, 4000) : randomBetween(2500, 5000);
    await typingPause(message.channel, delay + wakeMs);
    return followup ? message.channel.send(content) : message.reply(content);
}

// A varied fallback if the language model is unavailable; never invent outcomes.
const FALLBACK = {
    already: ["That server's already awake. My summoning circle is wasted.", "Already running. Even I can't boot something twice, darling.", "It's alive already. Try not to look so surprised."],
    starting: ["Fine. I'm rattling Gamekeeper's cage.", "One server resurrection, coming right up.", "I'll ask the machinery nicely. By which I mean not nicely."],
    submitted: ["Gamekeeper accepted the request. Boot completion is another story.", "The start request is in. The silicon gremlins have the floor.", "Request submitted. No victory lap until the VM actually wakes."],
    status: ["Fresh intel from the machine room:", "The server oracle has spoken:", "I consulted the little rack goblin. Here's the verdict:"],
    denied: ["Nice try. That lever is above my pay grade.", "I'm not authorized to pull that particular switch.", "Nope. That operation needs a grown-up with permissions."],
    error: ["The machinery has declined to cooperate. Rude.", "Gamekeeper and I are having a communication disagreement.", "Well, that operation went straight into the haunted basement."],
    busy: ["One server ritual at a time, please.", "I'm already handling that one. Patience, mortal.", "Same game, same moment. I only have two metaphorical hands."],
    inventory: ["You wanted one server? Adorable. I fetched the entire crypt. Find it yourself.", "I refuse to be a personal server concierge. Here’s the whole collection.", "One status check? Please. I brought you the entire inventory. Use your eyeballs."],
    inventoryAll: ["The full roster, freshly dragged out of Gamekeeper:", "Here’s the state of the whole digital dungeon:", "I checked every server. Yes, all of them. Try to contain your awe."],
    handoff: ["Sable's awake, so I'm delegating this particular haunting.", "The librarian's on duty. She gets the server ritual.", "I'm passing this one to Sable before someone hands me more responsibility."],
    clarify: ["I caught the game name, but the rest of that spell was gibberish. Start it, or what?", "Darling, those words are doing parkour. Which server action did you actually want?", "That sounded almost like a command. Try telling me what to do with the server."],
};

async function flourish(openai, kind, { label, action, detail = "", woke = false } = {}) {
    const fallback = choose(FALLBACK[kind] || FALLBACK.error);
    if (!openai?.chat?.completions?.create) { console.warn(`[gamekeeper] flourish fallback kind=${kind} reason=api_unavailable`); return fallback; }
    try {
        const result = await openai.chat.completions.create({
            model: "gpt-5.5", max_completion_tokens: 140,
            messages: [
                { role: "system", content: "You are Vesper, a mischievous, sarcastic goth gamer in Discord. Write ONE fresh, vivid, playful line (max 180 characters) reacting to the specific server event. Vary your metaphors and sentence structures. Do not use repetitive stock phrases. Never invent facts, claim a VM has booted when only a request was submitted, or claim an alert was delivered. For a clarify event, playfully roast the confusing original request and ask for clarification without guessing an action. For a submitted start request, make it clear in your own fresh words that you sent the request to start the server, but do not imply it has finished booting. Avoid formulaic confirmations and do not mention RAM, memory, VM IDs, or resource figures. Do not include mentions, quotes, markdown code, newlines, or technical status details. " + (woke ? "You have just been disturbed from a nap; optionally add a sleepy or irritated flavor, but do not mention timers or system mechanics." : "") },
                { role: "user", content: `Event: ${kind}; game: ${label}; action: ${action}; verified detail: ${String(detail).slice(0, 350)}` },
            ],
        });
        const generated = String(result.choices?.[0]?.message?.content || "")
            .replace(/<@!?\d+>|@everyone|@here|@sable/gi, "")
            .replace(/[\r\n]+/g, " ").trim().slice(0, 180);
        if (!generated) console.warn(`[gamekeeper] flourish fallback kind=${kind} reason=empty_response`);
        return generated || fallback;
    } catch (error) {
        console.warn(`[gamekeeper] flourish fallback kind=${kind} reason=api_error:`, error.message);
        return fallback;
    }
}

function parseRequest(content) {
    const text = String(content || "").replace(/<@!?\d+>/g, " ").replace(/\bvesper\b[:,]?/gi, " ").trim();
    const aliases = [
        ["core-keeper-2", /\bcore[ -]?keeper(?:[ -]?2)?\b/i],
        ["v-rising", /\bv[ -]?rising\b/i],
        ...GAMES.filter(x => !["core-keeper-2", "v-rising"].includes(x)).map(x => [x, new RegExp(`\\b${x}\\b`, "i")]),
    ];
    const game = aliases.find(([, pattern]) => pattern.test(text))?.[0] || null;
    // Status/inventory questions always return the complete inventory.
    const inventoryQuestion = /\b(list|inventory|roster|catalog|catalogue|which|what|show|all|available|servers?|games?)\b/i.test(text);
    const statusQuestion = /\b(status|running|online|up|down|active|stopped|state)\b/i.test(text);
    const serverContext = Boolean(game) || /\b(game\s*servers?|servers?\s*(?:in\s*the\s*lab|on\s*the\s*lab|status|running)|gamekeeper|games?\s*(?:running|installed|available))\b/i.test(text);
    const commandLike = /\b(start|stop|restart|reboot|boot|launch|shutdown|shut|turn|power|wake|spin|fire|bring|kill|spank|kick|poke|nudge|status|running|online|offline|list|inventory|roster|show|check)\b/i.test(text);
    const actions = [
        ["start", /\b(start|boot|spin up|fire up|bring up|wake up|turn\s+(?:(?:it|that|the\s+server|[\w-]+)\s+)?on|power\s+(?:(?:it|that|[\w-]+)\s+)?up|launch)\b/i],
        ["stop", /\b(stop|shut down|shutdown|turn\s+(?:(?:it|that|the\s+server|[\w-]+)\s+)?off|power off|kill)\b/i],
        ["restart", /\b(restart|reboot)\b/i],
        ["status", /\b(status|running|online|up|down)\b/i],
        ["alwayson", /\b(always[ -]?on)\b/i],
        ["ondemand", /\b(on[ -]?demand)\b/i],
    ];
    const action = actions.find(([, pattern]) => pattern.test(text))?.[0];
    // Status words alone are conversational; only route them when the user
    // actually refers to a game or the game-server infrastructure.
    // e.g. "your new feature is online" must NOT trigger !games.
    const inventoryContext = serverContext || /\b(?:game\s*servers?|games?|servers?|inventory|roster|gamekeeper)\b/i.test(text);
    if (inventoryContext && (action === "status" ||
        (!action && (inventoryQuestion || statusQuestion)))) {
        return { action: "inventory", game, specific: Boolean(game) };
    }
    if (!action) return serverContext && commandLike ? { action: "clarify", game } : null;
    if (!game) return serverContext && commandLike ? { action: "clarify", game: null } : null;
    return { action, game };
}

function waitForGamekeeper(client, channelId, game, timeoutMs = 25000) {
    let handler, timer;
    const promise = new Promise((resolve, reject) => {
        handler = msg => {
            if (msg.author?.id !== GAMEKEEPER_BOT_ID || msg.channelId !== channelId) return;
            const content = String(msg.content || "");
            if (game === "__inventory__") {
                if (!/\b(running|stopped|always-on|on-demand)\b/i.test(content) ||
                    !GAMES.some(name => content.toLowerCase().includes(name))) {
                    if (!/controller error|⚠️|⛔/i.test(content)) return;
                }
            } else if (!content.toLowerCase().includes(game.toLowerCase()) && !/controller error/i.test(content)) return;
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
    const waiting = waitForGamekeeper(client, channel.id, action === "list" ? "__inventory__" : game);
    try {
        await channel.send({ content: action === "list" ? "!games" : `!game ${action} ${game}`, allowedMentions: { parse: [] } });
        return await waiting.promise;
    } catch (error) {
        waiting.cancel();
        throw error;
    }
}

function formatInventory(raw) {
    const rows = new Map();
    for (const line of String(raw || "").split(/\r?\n/)) {
        // Gamekeeper's !games output is whitespace-separated, not colon-separated.
        // Example: "core-keeper-2  stopped  on-demand"
        const match = line.trim().match(/^(core-keeper-2|enshrouded|shadowdark|v-rising|valheim|windrose|quake)\s+(running|stopped)\s+(always-on|on-demand)\s*$/i);
        if (!match) continue;
        const [, name, stateRaw, modeRaw] = match;
        const game = name.toLowerCase();
        const state = stateRaw.toLowerCase();
        const mode = modeRaw.toLowerCase() === "always-on" ? "Always-on" : "On-demand";
        rows.set(game, `${state === "running" ? "🟢" : "⚫"} **${LABELS[game]}** — ${state === "running" ? "Running" : "Stopped"} | ${mode}`);
    }
    if (rows.size !== GAMES.length) {
        throw new Error(`Incomplete Gamekeeper inventory (${rows.size}/${GAMES.length}); refusing to invent missing statuses`);
    }
    return GAMES.map(game => rows.get(game)).join("\n");
}

async function notifyAdmin(client, detail) {
    if (!ADMIN_USER_ID || ADMIN_USER_ID === client.user?.id || ADMIN_USER_ID === GAMEKEEPER_BOT_ID || ADMIN_USER_ID === SABLE_USER_ID) return false;
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
    if (message.author.bot || !message.guild) return false;
    const addressed = message.mentions.users.has(client.user.id) || /\bvesper\b/i.test(message.content);
    if (!addressed) return false;
    const request = parseRequest(message.content);
    if (!request) return false;
    const { action, game } = request;
    const label = game ? LABELS[game] : "the game servers";
    const key = `${message.channelId}:${action === "inventory" ? "inventory" : game}`;

    // This route runs BEFORE index.js's normal conversational wake handler.
    // Use the SAME idle-duration buckets, then mark Vesper engaged.
    const idleMs = beginConversationalWake();
    const wakeMs = idleMs === null ? 0 : wakeDelay(idleMs);
    const woke = idleMs !== null;
    console.log(`[gamekeeper] wake idle_ms=${idleMs ?? 0} delay_ms=${wakeMs}`);
    wakeEngaged(client, "gamekeeper-request");
    let firstReply = true;
    const reply = async (content) => {
        const options = { followup: !firstReply, wakeMs: firstReply ? wakeMs : 0 };
        firstReply = false;
        return naturalReply(message, content, options);
    };
    const voice = (kind, detail = "") => flourish(openai, kind, { label, action, detail, woke });

    if (busy.has(key)) {
        await reply(await voice("busy"));
        return true;
    }
    busy.add(key);
    try {
        if (action === "clarify") {
            const line = await flourish(openai, "clarify", {
                label, action, woke,
                detail: `Original message: ${String(message.content).slice(0, 220)}. The intended operation is unclear. Gently roast the confusing wording and ask which action they meant. Do not imply you executed anything.`,
            });
            await reply(line);
            return true;
        }
        // Inventory requests belong to Vesper even when Sable is online.
        if (action === "inventory") {
            const channel = await client.channels.fetch(GAMEKEEPER_CHANNEL_ID);
            if (!channel?.send) throw new Error("Gamekeeper command channel unavailable");
            const raw = await command(client, channel, "list");
            if (/⚠️|⛔|controller error/i.test(raw)) throw new Error(raw);
            const inventory = formatInventory(raw);
            const intro = await flourish(openai, game ? "inventory" : "inventoryAll", {
                label: game ? LABELS[game] : "all game servers", action: "inventory", woke,
                detail: game ? "Someone requested one game; respond with a playful lazy refusal to do a single-game lookup, then provide the full inventory." : "Someone requested the full server inventory."
            });
            await reply(`${intro}\n\n🎮 **BlakLabz Game Server Inventory**\n${inventory}`);
            return true;
        }
        const sable = await sableAvailability(message.guild);
        if (sable === "online") {
            const line = await voice("handoff");
            await reply({
                content: `${line}\n<@${SABLE_USER_ID}>, please ${action} **${game}** through Gamekeeper and report the result.`,
                allowedMentions: { users: SABLE_USER_ID ? [SABLE_USER_ID] : [], repliedUser: false },
            });
            return true;
        }
        if (action !== "start" && action !== "status") {
            const notified = await notifyAdmin(client, `${message.author.username} requested ${action} ${game} while Sable was ${sable}. Channel: <#${message.channelId}>`);
            const line = await voice("denied");
            const admin = ADMIN_USER_ID && ADMIN_USER_ID !== client.user.id ? ` Ask <@${ADMIN_USER_ID}>.` : "";
            await reply({ content: `${line} I can't ${action} ${label} while Sable is ${sable}.${admin}${notified ? " I sent an admin alert." : ""}`, allowedMentions: { users: ADMIN_USER_ID && ADMIN_USER_ID !== client.user.id ? [ADMIN_USER_ID] : [], repliedUser: false } });
            return true;
        }
        const channel = await client.channels.fetch(GAMEKEEPER_CHANNEL_ID);
        if (!channel?.send) throw new Error("Gamekeeper command channel unavailable");
        const status = await command(client, channel, "status", game);
        if (/⚠️|error|⛔/i.test(status)) throw new Error(status);
        if (action === "status") {
            await reply(`${await voice("status", status)}\n${status}`);
            return true;
        }
        if (/\brunning\b/i.test(status)) {
            await reply(`${await voice("already", status)}\n${status}`);
            return true;
        }
        if (!/\bstopped\b/i.test(status)) throw new Error(`Unrecognized status: ${status}`);
        // Submit VM operations immediately, without waiting for the conversational delay.
        const result = await command(client, channel, "start", game);
        if (/⚠️|error|⛔/i.test(result)) throw new Error(result);
        await reply(await voice("submitted", "Gamekeeper accepted the start request; server readiness has not been confirmed."));
        return true;
    } catch (error) {
        console.error("[gamekeeper]", error);
        const notified = await notifyAdmin(client, `${message.author.username} requested ${action} ${game || "all games"}; failed: ${error.message}`);
        const line = await voice("error", error.message);
        await reply(`${line} ⚠️ Gamekeeper couldn't confirm ${action === "inventory" ? "the inventory" : `${action} for ${label}`}.${notified ? " I've alerted the admin." : " The admin alert could not be delivered."}`);
        return true;
    } finally { busy.delete(key); }
}

module.exports = { handle, parseRequest };
