const {
    ActivityType,
} = require('discord.js');

/*
 * During testing you can shrink these.
 *
 * Production-ish values:
 * 10–60 minutes.
 */
const MIN_PLAY_MINUTES = 10;
const MAX_PLAY_MINUTES = 60;

/*
 * Delay between discovering a game
 * and deciding to "play" it.
 */
const MIN_DISCOVERY_DELAY_MINUTES = 2;
const MAX_DISCOVERY_DELAY_MINUTES = 8;

const queue = [];

const scheduledGames = new Map();

let currentGame = null;
let playTimer = null;

/*
 * Random integer between min and max,
 * inclusive.
 */
function randomInteger(
    min,
    max
) {
    return (
        Math.floor(
            Math.random() *
                (
                    max -
                    min +
                    1
                )
        ) + min
    );
}

/*
 * Determine how long Vesper "plays".
 */
function randomPlayDurationMs() {
    const minutes =
        randomInteger(
            MIN_PLAY_MINUTES,
            MAX_PLAY_MINUTES
        );

    return {
        minutes,
        ms:
            minutes *
            60 *
            1000,
    };
}

/*
 * Determine how long Vesper waits
 * after discovering a game.
 */
function randomDiscoveryDelayMs() {
    const minutes =
        randomInteger(
            MIN_DISCOVERY_DELAY_MINUTES,
            MAX_DISCOVERY_DELAY_MINUTES
        );

    return {
        minutes,
        ms:
            minutes *
            60 *
            1000,
    };
}

/*
 * Check whether this game is already
 * queued, scheduled, or being played.
 */
function gameAlreadyKnown(game) {
    if (!game?.url) {
        return false;
    }

    const alreadyQueued =
        queue.some(
            (item) =>
                item.url ===
                game.url
        );

    const currentlyPlaying =
        currentGame?.url ===
        game.url;

    const alreadyScheduled =
        scheduledGames.has(
            game.url
        );

    return (
        alreadyQueued ||
        currentlyPlaying ||
        alreadyScheduled
    );
}

/*
 * Add a game directly to the hopper.
 */
function enqueueGame(game) {
    if (
        gameAlreadyKnown(
            game
        )
    ) {
        console.log(
            `[game-play] duplicate ignored: ${game.title}`
        );

        return false;
    }

    queue.push(game);

    console.log(
        `[game-play] queued: ${game.title} (${game.url})`
    );

    return true;
}

/*
 * Schedule a discovered game to enter
 * the hopper after a small random delay.
 *
 * This makes Vesper feel less like she
 * instantly reacts to MessageCreate.
 */
function scheduleGame(
    game,
    client
) {
    if (
        gameAlreadyKnown(
            game
        )
    ) {
        console.log(
            `[game-play] discovered duplicate ignored: ${game.title}`
        );

        return false;
    }

    const delay =
        randomDiscoveryDelayMs();

    console.log(
        `[game-play] discovered: ${game.title}; ` +
        `considering in ${delay.minutes} minute(s)`
    );

    const timer =
        setTimeout(
            () => {
                /*
                 * Remove from scheduled state
                 * before enqueueing.
                 */
                scheduledGames.delete(
                    game.url
                );

                const added =
                    enqueueGame(
                        game
                    );

                if (added) {
                    startNextGame(
                        client
                    );
                }
            },

            delay.ms
        );

    scheduledGames.set(
        game.url,
        {
            game,
            timer,
            scheduledAt:
                Date.now(),
            delayMinutes:
                delay.minutes,
        }
    );

    return true;
}

/*
 * Pick a random game from the hopper.
 */
function chooseRandomQueuedGame() {
    if (
        queue.length === 0
    ) {
        return null;
    }

    const index =
        Math.floor(
            Math.random() *
            queue.length
        );

    return queue.splice(
        index,
        1
    )[0];
}

/*
 * Clear Discord activity.
 */
function clearPlayingActivity(
    client
) {
    client.user.setPresence({
        activities: [],
        status:
            'online',
    });
}

/*
 * Begin playing the next random
 * queued game.
 */
function startNextGame(
    client
) {
    if (
        currentGame ||
        queue.length === 0
    ) {
        return;
    }

    const game =
        chooseRandomQueuedGame();

    if (!game) {
        return;
    }

    const duration =
        randomPlayDurationMs();

    currentGame = {
        ...game,

        startedAt:
            Date.now(),

        playMinutes:
            duration.minutes,
    };

    console.log(
        `[game-play] Vesper started playing: ` +
        `${currentGame.title} for ` +
        `${duration.minutes} minute(s)`
    );

    client.user.setPresence({
        activities: [
            {
                name:
                    currentGame.title,

                type:
                    ActivityType.Playing,
            },
        ],

        status:
            'online',
    });

    console.log(
        '[game-play] presence:',
        client.user.presence.activities
    );

    playTimer =
        setTimeout(
            () => {
                finishCurrentGame(
                    client
                );
            },

            duration.ms
        );
}

/*
 * Finish the active game,
 * clear Discord presence,
 * then immediately look for
 * another queued game.
 */
function finishCurrentGame(
    client
) {
    if (!currentGame) {
        return;
    }

    console.log(
        `[game-play] Vesper finished playing: ${currentGame.title}`
    );

    currentGame = null;

    if (playTimer) {
        clearTimeout(
            playTimer
        );

        playTimer = null;
    }

    clearPlayingActivity(
        client
    );

    console.log(
        '[game-play] cleared playing activity'
    );

    startNextGame(
        client
    );
}

/*
 * Useful for future debugging / status commands.
 */
function getCurrentGame() {
    return currentGame;
}

function getQueue() {
    return [
        ...queue,
    ];
}

function getScheduledGames() {
    return [
        ...scheduledGames.values(),
    ].map(
        (entry) => ({
            game:
                entry.game,

            scheduledAt:
                entry.scheduledAt,

            delayMinutes:
                entry.delayMinutes,
        })
    );
}

module.exports = {
    enqueueGame,
    scheduleGame,
    startNextGame,
    finishCurrentGame,
    getCurrentGame,
    getQueue,
    getScheduledGames,
};
