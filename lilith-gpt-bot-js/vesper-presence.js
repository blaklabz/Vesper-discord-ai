"use strict";

const {
    ActivityType,
} = require("discord.js");

const AMBIENT_WAKE_MS = 5 * 60 * 1000;
const ENGAGED_WAKE_MS = 15 * 60 * 1000;

let idleTimer = null;
let wakeUntil = 0;
let playing = false;
let idleSince = null;

function clearIdleTimer() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
}

function setIdle(client) {
    if (!client?.user || playing) {
        return;
    }

    idleSince = Date.now();
    wakeUntil = 0;
    clearIdleTimer();

    client.user.setPresence({
        activities: [],
        status: "idle",
    });

    console.log(
        "[presence] Discord client state after setIdle:",
        client.user.presence.status
    );

    console.log("[presence] Vesper is idle");
}

function scheduleIdle(client) {
    clearIdleTimer();

    if (playing || !wakeUntil) {
        return;
    }

    const remaining = wakeUntil - Date.now();

    if (remaining <= 0) {
        setIdle(client);
        return;
    }

    idleTimer = setTimeout(
        () => setIdle(client),
        remaining
    );
}

function wakeFor(client, durationMs, reason = "activity") {
    if (!client?.user) {
        return;
    }

    // Activity may extend wakefulness, but never shorten it.
    // idleSince is intentionally preserved for the upcoming
    // conversational wake-latency implementation.
    wakeUntil = Math.max(
        wakeUntil,
        Date.now() + durationMs
    );

    if (!playing) {
        client.user.setPresence({
            activities: [],
            status: "online",
        });
    }

    console.log(
        `[presence] awake (${reason}); idle no earlier than ${new Date(wakeUntil).toISOString()}`
    );

    scheduleIdle(client);
}

function wakeAmbient(client, reason = "general-chat") {
    wakeFor(client, AMBIENT_WAKE_MS, reason);
}

function wakeEngaged(client, reason = "engaged") {
    wakeFor(client, ENGAGED_WAKE_MS, reason);
}

function setPlaying(client, title) {
    if (!client?.user) {
        return;
    }

    playing = true;
    clearIdleTimer();

    client.user.setPresence({
        activities: [
            {
                name: `🎮 Playing ${title}`,
                type: ActivityType.Playing,
            },
        ],
        status: "online",
    });

    console.log(`[presence] playing: ${title}`);
}

function clearPlaying(client, reason = "game-finished") {
    playing = false;

    // Finishing a game is engaged activity and starts a fresh 15m window.
    wakeEngaged(client, reason);
}

function initializePresence(client) {
    playing = false;
    wakeUntil = 0;
    idleSince = null;
    clearIdleTimer();
    setIdle(client);
}

function isPlaying() {
    return playing;
}

function getIdleDurationMs() {
    if (!idleSince) {
        return 0;
    }

    return Date.now() - idleSince;
}

module.exports = {
    initializePresence,
    wakeAmbient,
    wakeEngaged,
    setPlaying,
    clearPlaying,
    isPlaying,
    getIdleDurationMs,
};
