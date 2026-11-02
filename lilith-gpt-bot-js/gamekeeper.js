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
// Gamekeeper owns the roster. Never maintain a second game list here.
const knownGames = new Map();
const validGameName = name => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(name);
const gameLabel = name => name ? name.split(/[-_]/).map(part =>
    part ? part[0].toUpperCase() + part.slice(1) : part).join(" ") : "the game servers";
function gameAliases(name) {
    const words = name.split(/[-_]/).filter(Boolean);
    const variants = new Set([name, words.join(" "), words.join("-")]);
    // Allow 'core keeper' for 'core-keeper-2', without maintaining a title list.
    if (words.length > 1 && /^\d+$/.test(words[words.length - 1])) {
        variants.add(words.slice(0, -1).join(" "));
    }
    return [...variants].sort((a, b) => b.length - a.length);
}
function findGame(text, names = knownGames.keys()) {
    const normalized = String(text).toLowerCase();
    const candidates = [...names].flatMap(name => gameAliases(name).map(alias => ({ name, alias })))
        .sort((a, b) => b.alias.length - a.alias.length);
    return candidates.find(({ alias }) => {
        const escaped = alias.replace(/[ -]/g, "[ _-]");
        return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(normalized);
    })?.name || null;
}
const busy = new Set();
// Optional, occasional capability hints; never more than once per cooldown.
const reminderChanceRaw = Number(process.env.GAMEKEEPER_CAPABILITY_REMINDER_CHANCE ?? "0.12");
const REMINDER_CHANCE = Number.isFinite(reminderChanceRaw) ? Math.max(0, Math.min(1, reminderChanceRaw)) : 0.12;
const reminderCooldownRaw = Number(process.env.GAMEKEEPER_CAPABILITY_REMINDER_COOLDOWN_MS ?? "1800000");
const REMINDER_COOLDOWN_MS = Number.isFinite(reminderCooldownRaw) ? Math.max(0, reminderCooldownRaw) : 1800000;
let lastCapabilityReminderAt = 0;
function capabilityReminderDue() {
    const now = Date.now();
    if (now - lastCapabilityReminderAt < REMINDER_COOLDOWN_MS || Math.random() >= REMINDER_CHANCE) return false;
    lastCapabilityReminderAt = now;
    return true;
}
// Keep operations in #blaklabz, not #charcoal-deli.
const HANDOFF_TIMEOUT_MS = 105000;
const STOP_TIMEOUT_MS = 105000;
const STOP_ADMIN_ROLE_IDS = new Set((process.env.GAMEKEEPER_ADMIN_ROLE_IDS || "").split(",").map(x => x.trim()).filter(Boolean));
function authorizedStop(message) {
    return ADMIN_IDS.includes(message.author.id) ||
        message.member?.roles?.cache?.some(role => STOP_ADMIN_ROLE_IDS.has(role.id)) === true;
}
function terminalFailure(body) {
    return /⛔|❌|permission|denied|unauthori[sz]ed|failed|error|unknown|not found|controller error/i.test(body);
}

// Discord webhook ID (not the webhook display name or Gamekeeper bot user ID).
// Set this explicitly to avoid trusting a spoofable display name.
const GAMEKEEPER_WEBHOOK_ID = process.env.GAMEKEEPER_WEBHOOK_ID || "";
const GAMEKEEPER_ANNOUNCE_CHANNEL_ID = process.env.GAMEKEEPER_ANNOUNCE_CHANNEL_ID || "516241218632548377";
const announcedShutdowns = new Map();


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
    shutdownWarning: ["Thirty minutes until the server curfew. Save your progress, nocturnal gremlins.", "Half an hour until Gamekeeper pulls the plug. Save now, complain later."],
    shutdownVerified: ["The machines have been tucked into their crypts. I'm going back to the couch.", "Four AM. The servers are asleep. Some of you should try it.", "Gamekeeper did the responsible thing. Disgusting. I approve."],
    handoff: ["The librarian's on duty. She gets the server ritual."],
    startConfirmed: ["{game} is awake and officially running. I dragged it out of the crypt; Gamekeeper checked the pulse.", "{game} has risen. The machinery confirms it, so I can return to doing absolutely nothing.", "The {game} server is running. My summoning ritual was flawless, obviously."],
    stopConfirmed: ["{game} is safely asleep. Gamekeeper checked the lights; I get the couch back.", "The crypt has reclaimed {game}. Shutdown confirmed, no dramatic resurrection required.", "{game} is off and the rack is a little quieter. Beautiful."],
    handoffSuccess: ["{game} got its {action} orders. Sable handled the paperwork, Gamekeeper confirmed it, and I'm back on the couch.", "The librarian and the rack goblin have settled {game}'s {action} business. My supervision was impeccable.", "{game}: {action} confirmed. Sable did the ritual; I provided the appropriate amount of dramatic disinterest."],
    handoffFailure: ["The {action} ritual for {game} didn't get a clean confirmation. Sable's report says something went wrong; I'm not calling it done.", "{game}'s {action} request hit a snag. No victory lap until the machinery actually confirms it."],
    sableOffline: ["The librarian's vanished into the stacks. No {action} for {game} until she's back; I can still start and stop things.", "Sable's gone dark. {game}'s {action} ritual can wait. I refuse to throw commands into a void.", "The librarian isn't answering. {game} stays as-is; my couch and I are handling the disappointment."],
    sableDisconnected: ["Sable slipped away before I could pass along {game}'s {action} request. Nothing was sent. Typical librarian behavior.", "The librarian vanished mid-errand. No {action} request for {game} was sent; the server remains untouched by me."],
    handoffTimeout: ["Sable hasn't confirmed {game}'s {action} yet. Could've worked, could've exploded into paperwork. Check the ops channel before trying again.", "No final word on {game}'s {action}. Don't repeat the ritual until you've checked the ops channel."],
    clarify: ["I caught the game name, but the rest of that spell was gibberish. Start it, or what?", "Darling, those words are doing parkour. Which server action did you actually want?", "That sounded almost like a command. Try telling me what to do with the server."],
};

async function flourish(openai, kind, { label, action, detail = "", woke = false, reminder = false } = {}) {
    const fallback = choose(FALLBACK[kind] || FALLBACK.error)
        .replaceAll("{game}", label || "the server")
        .replaceAll("{action}", ({ alwayson: "always-on", ondemand: "on-demand" })[action] || action || "operation");
    const reminderText = " I can directly start and stop game servers and check status or inventory; Sable handles restart, kill, always-on, and on-demand changes.";
    const fallbackWithReminder = reminder ? `${fallback} ${choose(["I can still start, stop, and check the roster. Sable handles the fancier rituals.", "Need something else? Starts, stops, and server status are my department. Sable gets the scary switches."])}` : fallback;
    if (!openai?.chat?.completions?.create) { console.warn(`[gamekeeper] flourish fallback kind=${kind} reason=api_unavailable`); return fallbackWithReminder; }
    try {
        const result = await openai.chat.completions.create({
            model: "gpt-5.5", max_completion_tokens: 140,
            messages: [
                { role: "system", content: "You are Vesper, a mischievous, sarcastic goth gamer in Discord. Write ONE fresh, vivid, playful line (max 260 characters) reacting to the specific server event. Vary your metaphors and sentence structures. Do not use repetitive stock phrases. Never invent facts, claim a VM has booted when only a request was submitted, or claim an alert was delivered. For startConfirmed, Gamekeeper verified the named game is running; for stopConfirmed, Gamekeeper verified it is stopped. For either, produce a fresh self-contained playful sentence about the confirmed state, never paste or quote raw Gamekeeper output. For shutdownWarning, the servers are still running and will shut down in 30 minutes: tell players to save. For shutdownVerified, the named servers are confirmed stopped. For handoffSuccess, the operation is confirmed: celebrate with one complete witty sentence, mentioning the game and what changed, without quoting Sable, adding report labels, or narrating a pending handoff. For handoffFailure, the operation is NOT confirmed: give one complete witty but accurate sentence, without implying success. For sableOffline or sableDisconnected, Sable is unavailable and NO privileged command was submitted; refuse with dry humor without implying any change. For handoffTimeout, the outcome is unknown and a request MAY have completed; tell the user to check #blaklabz before retrying. For denied, permissions blocked the request; for error, do not claim success. For a clarify event, playfully roast the confusing original request and ask for clarification without guessing an action. For a submitted start request, make it clear in your own fresh words that you sent the request to start the server, but do not imply it has finished booting. Avoid formulaic confirmations and do not mention RAM, memory, VM IDs, or resource figures. Do not include mentions, quotes, markdown code, newlines, or technical status details. " + (reminder ? "Casually weave in a brief, accurate reminder of your Gamekeeper abilities without sounding like a help menu: " + reminderText : "Do not list your abilities unless directly relevant.") + " " + (woke ? "You have just been disturbed from a nap; optionally add a sleepy or irritated flavor, but do not mention timers or system mechanics." : "") },
                { role: "user", content: `Event: ${kind}; game: ${label}; action: ${action}; verified detail: ${String(detail).slice(0, 350)}` },
            ],
        });
        const generated = String(result.choices?.[0]?.message?.content || "")
            .replace(/<@!?\d+>|@everyone|@here|@sable/gi, "")
            .replace(/[\r\n]+/g, " ").trim().slice(0, 300);
        if (!generated) console.warn(`[gamekeeper] flourish fallback kind=${kind} reason=empty_response`);
        return generated || fallbackWithReminder;
    } catch (error) {
        console.warn(`[gamekeeper] flourish fallback kind=${kind} reason=api_error:`, error.message);
        return fallbackWithReminder;
    }
}

function parseRequest(content) {
    const text = String(content || "").replace(/<@!?\d+>/g, " ").replace(/\bvesper\b[:,]?/gi, " ").replace(/\b(?:ask|tell|have)\s+sable\s+to\b/gi, " ").trim();
    const game = findGame(text);
    // Status/inventory questions always return the complete inventory.
    const inventoryQuestion = /\b(list|inventory|roster|catalog|catalogue|which|what|show|all|available|servers?|games?)\b/i.test(text);
    const statusQuestion = /\b(status|running|online|up|down|active|stopped|state)\b/i.test(text);
    const serverContext = Boolean(game) || /\b(game\s*servers?|servers?\s*(?:in\s*the\s*lab|on\s*the\s*lab|status|running)|gamekeeper|games?\s*(?:running|installed|available))\b/i.test(text);
    const commandLike = /\b(start|stop|restart|reboot|boot|launch|shutdown|shut|turn|power|wake|spin|fire|bring|kill|spank|kick|poke|nudge|status|running|online|offline|list|inventory|roster|show|check)\b/i.test(text);
    const actions = [
        ["start", /\b(start|boot|spin up|fire up|bring up|wake up|turn\s+(?:(?:it|that|the\s+server|[\w-]+)\s+)?on|power\s+(?:(?:it|that|[\w-]+)\s+)?up|launch)\b/i],
        ["stop", /\b(stop|shut down|shutdown|turn\s+(?:(?:it|that|the\s+server|[\w-]+)\s+)?off|power off)\b/i],
        ["restart", /\b(restart|reboot)\b/i],
        ["kill", /\b(kill|force[ -]?stop)\b/i],
        ["status", /\b(status|running|online|up|down)\b/i],
        ["alwayson", /\b(always[ -]?on)\b/i],
        ["ondemand", /\b(on[ -]?demand)\b/i],
    ];
    const modeAction = /\balways[ -]?on\b/i.test(text) ? "alwayson" : /\bon[ -]?demand\b/i.test(text) ? "ondemand" : null;
    const action = modeAction || actions.find(([, pattern]) => pattern.test(text))?.[0];
    // Status words alone are conversational; only route them when the user
    // actually refers to a game or the game-server infrastructure.
    // e.g. "your new feature is online" must NOT trigger !games.
    // A bare "game" (e.g. Wendy's RPG) or "what" is NOT an infra request.
    const inventoryContext = serverContext || /\b(?:game\s*servers?|servers?|inventory|roster|gamekeeper)\b/i.test(text);
    if (inventoryContext && (action === "status" ||
        (!action && (inventoryQuestion || statusQuestion)))) {
        return { action: "inventory", game, specific: Boolean(game) };
    }
    if (!action) return serverContext && commandLike ? { action: "clarify", game } : null;
    if (!game) return serverContext && commandLike ? { action: "clarify", game: null } : null;
    return { action, game };
}

function waitForGamekeeper(client, channelId, game, timeoutMs = 25000, terminal = null) {
    let handler, timer;
    const promise = new Promise((resolve, reject) => {
        handler = msg => {
            if (msg.author?.id !== GAMEKEEPER_BOT_ID || msg.channelId !== channelId) return;
            const content = String(msg.content || "");
            if (game === "__inventory__") {
                if (!/\b(running|stopped|always-on|on-demand)\b/i.test(content) ||
                    !/^\s*[a-z0-9][a-z0-9_-]*\s+(?:running|stopped)\s+(?:always-on|on-demand)\s*$/im.test(content)) {
                    if (!/controller error|⚠️|⛔/i.test(content)) return;
                }
            } else if (!content.toLowerCase().includes(game.toLowerCase()) && !/controller error/i.test(content)) return;
            if (terminal && !terminal(content)) return;
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
    const terminal = action === "start"
        ? body => terminalFailure(body) || /(?:✅|confirmed|already).*\b(?:started|running)\b|\b(?:started|running)\b.*(?:✅|confirmed|already)/i.test(body)
        : action === "stop"
        ? body => terminalFailure(body) || /(?:✅|confirmed|already)\b.*\bstopped\b|\bstopped\b.*(?:✅|confirmed|already)/i.test(body)
        : null;
    const waiting = waitForGamekeeper(client, channel.id, action === "list" ? "__inventory__" : game,
        action === "stop" || action === "start" ? STOP_TIMEOUT_MS : 25000, terminal);
    try {
        await channel.send({ content: action === "list" ? "!games" : `!game ${action} ${game}`, allowedMentions: { parse: [] } });
        return await waiting.promise;
    } catch (error) {
        waiting.cancel();
        throw error;
    }
}

function parseInventory(raw) {
    const rows = new Map();
    for (const line of String(raw || "").split(/\r?\n/)) {
        const match = line.trim().match(/^([a-z0-9][a-z0-9_-]{0,63})\s+(running|stopped)\s+(always-on|on-demand)\s*$/i);
        if (!match) continue;
        const [, rawName, rawState, rawMode] = match;
        const name = rawName.toLowerCase();
        if (!validGameName(name) || rows.has(name)) throw new Error(`Invalid or duplicate Gamekeeper game: ${name}`);
        rows.set(name, { name, state: rawState.toLowerCase(), mode: rawMode.toLowerCase() });
    }
    if (!rows.size) throw new Error("Gamekeeper returned no parseable inventory; refusing to assume an empty roster");
    return rows;
}
function formatInventory(raw) {
    const rows = parseInventory(raw);
    knownGames.clear();
    for (const [name, row] of rows) knownGames.set(name, row);
    return [...rows.values()].map(({ name, state, mode }) =>
        `${state === "running" ? "🟢" : "⚫"} **${gameLabel(name)}** — ${state === "running" ? "Running" : "Stopped"} | ${mode === "always-on" ? "Always-on" : "On-demand"}`
    ).join("\n");
}
async function refreshGames(client) {
    const channel = await client.channels.fetch(GAMEKEEPER_CHANNEL_ID);
    if (!channel?.send) throw new Error("Gamekeeper command channel unavailable");
    const raw = await command(client, channel, "list");
    if (/⚠️|⛔|controller error/i.test(raw)) throw new Error(raw);
    formatInventory(raw);
    return knownGames;
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

// Observe the specific Sable confirmation in the operations channel. This is
// reporting only: Sable and Gamekeeper remain responsible for authorization and execution.
function waitForSableResult(client, channelId, action, game, afterId) {
    let listener, timer;
    const normalize = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
    const gameNames = [game, gameLabel(game)].map(normalize);
    const promise = new Promise((resolve, reject) => {
        listener = msg => {
            if (msg.author?.id !== SABLE_USER_ID || msg.channelId !== channelId) return;
            if (BigInt(msg.id) <= BigInt(afterId)) return;
            const body = String(msg.content || "");
            const normalized = normalize(body);
            const matchesGame = gameNames.some(name => name && normalized.includes(name));
            const failure = /handoff rejected|cannot verify|went quiet|⛔|❌|failed|denied|error/i.test(body);
            // Sable may say "Core Keeper 2" for core-keeper-2 and may describe
            // "kill" as "forcibly stopped". Do not require action keywords.
            if (!matchesGame) return;
            if (!/Gamekeeper/i.test(body) && !failure) return;
            cleanup();
            resolve(body);
        };
        timer = setTimeout(() => { cleanup(); reject(new Error("Sable did not confirm the handoff in time")); }, HANDOFF_TIMEOUT_MS);
        client.on("messageCreate", listener);
    });
    function cleanup() { clearTimeout(timer); client.off("messageCreate", listener); }
    return { promise, cancel: cleanup };
}

async function handle({ message, client, sableAvailability, openai }) {
    if (message.author.bot || !message.guild) return false;
    const addressed = message.mentions.users.has(client.user.id) || /\bvesper\b/i.test(message.content);
    if (!addressed) return false;
    let request = parseRequest(message.content);
    // A newly added game may not be in our last roster. Discover it from
    // Gamekeeper before deciding whether an addressed operation is actionable.
    if (!request || (request.action === "clarify" && !request.game)) {
        if (/\b(start|stop|restart|reboot|boot|launch|kill|status|turn|power|wake|always[ -]?on|on[ -]?demand)\b/i.test(message.content)) {
            try {
                await refreshGames(client);
                request = parseRequest(message.content);
            } catch (error) {
                console.warn("[gamekeeper] game discovery failed:", error.message);
                // Do not guess a server name if discovery is unavailable.
            }
        }
    }
    if (!request) return false;
    const { action, game } = request;
    const label = gameLabel(game);
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
    const voice = (kind, detail = "") => flourish(openai, kind, {
        label, action, detail, woke,
        reminder: capabilityReminderDue(),
    });

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
                label: game ? gameLabel(game) : "all game servers", action: "inventory", woke,
                detail: game ? "Someone requested one game; respond with a playful lazy refusal to do a single-game lookup, then provide the full inventory." : "Someone requested the full server inventory."
            });
            await reply(`${intro}\n\n🎮 **BlakLabz Game Server Inventory**\n${inventory}`);
            return true;
        }
        // Delegate only restart, kill, and scheduling changes to Sable.
        // The payload stays in #blaklabz; public chat gets prose and a result.
        if (["restart", "kill", "alwayson", "ondemand"].includes(action)) {
            if (!SABLE_USER_ID) throw new Error("Sable bot ID is not configured");
            // Fail closed: a configured bot ID is not evidence Sable is connected.
            // Discord idle/DND still mean connected; offline/unknown do not.
            const sableStatus = typeof sableAvailability === "function"
                ? await sableAvailability(message.guild).catch(error => {
                    console.warn("[gamekeeper] Sable availability check failed:", error.message);
                    return "unknown";
                })
                : "unknown";
            if (!["online", "idle", "dnd"].includes(sableStatus)) {
                console.log(`[gamekeeper] handoff blocked: Sable status=${sableStatus} action=${action} game=${game}`);
                await reply(await voice("sableOffline", `Sable status: ${sableStatus}; no request submitted.`));
                return true;
            }
            const channel = await client.channels.fetch(GAMEKEEPER_CHANNEL_ID);
            if (!channel?.send) throw new Error("Gamekeeper operations channel unavailable");
            const reference = `https://discord.com/channels/${message.guild.id}/${message.channelId}/${message.id}`;
            const handoff = `[GAMEKEEPER_HANDOFF_V1]\n` +
                `requester_id=${message.author.id}\n` +
                `request_message_id=${message.id}\n` +
                `request_channel_id=${message.channelId}\n` +
                `request_guild_id=${message.guild.id}\n` +
                `action=${action}\n` +
                `game=${game}\n` +
                `original=${reference}\n` +
                `[/GAMEKEEPER_HANDOFF_V1]`;
            // Register before posting: Sable may respond faster than Vesper's typing delay.
            // Recheck immediately before sending, in case Sable disconnected
            // while the operations channel was being fetched.
            const currentStatus = typeof sableAvailability === "function"
                ? await sableAvailability(message.guild).catch(() => "unknown")
                : "unknown";
            if (!["online", "idle", "dnd"].includes(currentStatus)) {
                console.log(`[gamekeeper] handoff aborted before send: Sable status=${currentStatus} action=${action} game=${game}`);
                await reply(await voice("sableDisconnected", `Sable status: ${currentStatus}; no request submitted.`));
                return true;
            }
            const waiter = waitForSableResult(client, channel.id, action, game, message.id);
            try {
                const posted = await channel.send({
                    content: `<@${SABLE_USER_ID}> ${handoff}`,
                    allowedMentions: { users: [SABLE_USER_ID], repliedUser: false },
                });
                console.log(`[gamekeeper] delegated action=${action} game=${game} requester=${message.author.id} original=${message.id} ops=${posted.id}`);
                // Await the result directly. A slow typing/LLM acknowledgment can
                // arrive after Sable finishes and misleadingly say "waiting".
                const result = await waiter.promise;
                const failed = terminalFailure(result) || /rejected|cannot verify|went quiet/i.test(result);
                // The outcome comes from Sable's verified result, never the LLM.
                // Give Vesper one complete personality-driven reply, not a canned
                // prefix stitched to Sable's operational report.
                const flavor = await voice(failed ? "handoffFailure" : "handoffSuccess", result);
                await reply(failed
                    ? `⚠️ ${flavor} (Not confirmed.)`
                    : `✅ ${flavor}`);
            } catch (error) {
                await reply(`⚠️ ${await voice("handoffTimeout", "No confirmed response; request was submitted and may have completed. Check #blaklabz before retrying.")}`);
                console.warn(`[gamekeeper] handoff result timeout action=${action} game=${game}: ${error.message}`);
            } finally { waiter.cancel(); }
            return true;
        }
        // Stop is Vesper's responsibility, not an informal Sable handoff.
        if (action === "stop") {
            if (!authorizedStop(message)) {
                await reply(`⛔ ${await voice("denied", "Stopping game servers requires administrator permission. No stop command submitted.")}`);
                return true;
            }
            const channel = await client.channels.fetch(GAMEKEEPER_CHANNEL_ID);
            if (!channel?.send) throw new Error("Gamekeeper command channel unavailable");
            const result = await command(client, channel, "stop", game);
            if (terminalFailure(result)) throw new Error(result);
            if (!/(?:✅|confirmed|already)\b.*\bstopped\b|\bstopped\b.*(?:✅|confirmed|already)/i.test(result)) throw new Error(`Unconfirmed stop: ${result}`);
            await reply(`💀 ${await voice("stopConfirmed", result)}`);
            return true;
        }
        // Start and status are handled directly by Vesper, regardless of Sable's presence.
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
        if (terminalFailure(result)) throw new Error(result);
        if (!/(?:✅|confirmed|already).*\b(?:started|running)\b|\b(?:started|running)\b.*(?:✅|confirmed|already)/i.test(result)) throw new Error(`Unconfirmed start: ${result}`);
        await reply(`⚡ ${await voice("startConfirmed", result)}`);
        return true;
    } catch (error) {
        console.error("[gamekeeper]", error);
        const notified = await notifyAdmin(client, `${message.author.username} requested ${action} ${game || "all games"}; failed: ${error.message}`);
        const line = await voice("error", error.message);
        await reply(`${line} ⚠️ Gamekeeper couldn't confirm ${action === "inventory" ? "the inventory" : `${action} for ${label}`}.${notified ? " I've alerted the admin." : " The admin alert could not be delivered."}`);
        return true;
    } finally { busy.delete(key); }
}

// Authenticated Gamekeeper webhook: 30-minute warning and verified 4 AM shutdown.
// Trust the configured webhook ID, not its spoofable display name.
async function handleShutdownWebhook({ message, client, openai }) {
    // Only consume authenticated webhook events posted in #blaklabz.
    // Vesper sends her commentary separately to #charcoal-deli.
    if (!GAMEKEEPER_WEBHOOK_ID || !message.guild ||
        message.channelId !== GAMEKEEPER_CHANNEL_ID ||
        message.webhookId !== GAMEKEEPER_WEBHOOK_ID) return false;
    const body = String(message.content || "");
    const warning = /30 minutes until the 4:00 AM Eastern hard shutdown/i.test(body);
    const verified = /4:00\s*AM\s*[—-]\s*Gamekeeper shutdown verified/i.test(body);
    if (!warning && !verified) return false;

    let names;
    if (warning) {
        const match = body.match(/Servers:\s*([^\r\n]+)/i);
        if (!match) return true;
        names = match[1].split(/[,;]/).map(n => n.trim().toLowerCase()).filter(validGameName);
    } else {
        const confirmed = [...body.matchAll(/^CONFIRMED\s+([\w-]+)\s*\(VM\s+\d+\):\s*stopped\s*$/gim)];
        names = confirmed.map(m => m[1].toLowerCase()).filter(validGameName);
    }
    names = [...new Set(names)];
    if (!names.length) return true;
    const now = Date.now();
    for (const [key, at] of announcedShutdowns) if (now - at > 6 * 3600000) announcedShutdowns.delete(key);
    const eventType = warning ? "warning30" : "shutdownVerified";
    const key = `${new Date(message.createdTimestamp || now).toISOString().slice(0, 10)}:${eventType}:${names.slice().sort().join(",")}`;
    if (announcedShutdowns.has(key)) return true;
    announcedShutdowns.set(key, now);
    try {
        const channel = await client.channels.fetch(GAMEKEEPER_ANNOUNCE_CHANNEL_ID);
        if (!channel?.send) throw new Error("Announcement channel unavailable");
        const labels = names.map(gameLabel);
        const quip = await flourish(openai, warning ? "shutdownWarning" : "shutdownVerified", {
            label: labels.join(", "), action: warning ? "warning" : "shutdown",
            detail: warning
                ? "Gamekeeper warns that these servers are scheduled for shutdown in 30 minutes at 4 AM Eastern. Remind players to save; do NOT claim they have stopped."
                : "Gamekeeper verified these servers stopped at 4 AM Eastern. Mention no other servers."
        });
        const prefix = warning
            ? `⚠️ **30 minutes until shutdown:** ${labels.join(", ")}`
            : `💀 **Gamekeeper verified shutdown:** ${labels.join(", ")}`;
        await channel.send({ content: `${prefix}\n${quip}`, allowedMentions: { parse: [] } });
        console.log(`[gamekeeper] ${eventType} announced: ${names.join(",")}`);
    } catch (error) {
        announcedShutdowns.delete(key);
        console.error(`[gamekeeper] ${eventType} announcement failed:`, error);
    }
    return true;
}

module.exports = { handle, parseRequest, handleShutdownWebhook };
