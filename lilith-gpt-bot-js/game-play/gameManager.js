const { ActivityType } = require('discord.js');

const MIN_PLAY_MINUTES = 1;
const MAX_PLAY_MINUTES = 5;

const queue = [];

let currentGame = null;
let playTimer = null;

function randomPlayDurationMs() {
    const minutes =
        Math.floor(
            Math.random() *
            (MAX_PLAY_MINUTES - MIN_PLAY_MINUTES + 1)
        ) + MIN_PLAY_MINUTES;

    return {
        minutes,
        ms: minutes * 60 * 1000,
    };
}

function enqueueGame(game) {
    /*
     * Avoid duplicate queue entries for the same URL.
     */
    const alreadyQueued = queue.some(
        (item) => item.url === game.url
    );

    const currentlyPlaying =
        currentGame?.url === game.url;

    if (alreadyQueued || currentlyPlaying) {
        return false;
    }

    queue.push(game);

    console.log(
        `[game-play] queued: ${game.title} (${game.url})`
    );

    return true;
}

function chooseRandomQueuedGame() {
    if (queue.length === 0) {
        return null;
    }

    const index =
        Math.floor(Math.random() * queue.length);

    return queue.splice(index, 1)[0];
}

function clearPlayingActivity(client) {
    client.user.setPresence({
        activities: [],
        status: 'online',
    });
}

function startNextGame(client) {
    if (currentGame || queue.length === 0) {
        return;
    }

    const game = chooseRandomQueuedGame();

    if (!game) {
        return;
    }

    const duration = randomPlayDurationMs();

    currentGame = {
        ...game,
        startedAt: Date.now(),
        playMinutes: duration.minutes,
    };

    console.log(
        `[game-play] Vesper started playing: ` +
        `${currentGame.title} for ${duration.minutes} minutes`
    );

    client.user.setPresence({
        activities: [
            {
                name: currentGame.title,
                type: ActivityType.Playing,
            },
        ],
        status: 'online',
    });

    console.log(
        '[game-play] presence:',
        client.user.presence.activities
    );

    playTimer = setTimeout(() => {
        finishCurrentGame(client);
    }, duration.ms);
}

function finishCurrentGame(client) {
    if (!currentGame) {
        return;
    }

    console.log(
        `[game-play] Vesper finished playing: ${currentGame.title}`
    );

    currentGame = null;

    if (playTimer) {
        clearTimeout(playTimer);
        playTimer = null;
    }

    clearPlayingActivity(client);

    /*
     * If another game is waiting,
     * immediately move on to a random queued game.
     */
    startNextGame(client);
}

function getCurrentGame() {
    return currentGame;
}

function getQueue() {
    return [...queue];
}

module.exports = {
    enqueueGame,
    startNextGame,
    finishCurrentGame,
    getCurrentGame,
    getQueue,
};
