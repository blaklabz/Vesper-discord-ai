"use strict";

const {
    ActivityType,
} = require("discord.js");

const {
    shouldQueueGame,
} = require("./game-decision");

const {
    recordDecision,
    recordQueued,
    recordPlayStarted,
    recordPlayFinished,
} = require("./gameDatabase");

const {
    formAndShareGameOpinion,
} = require("./game-opinion");


const DEFAULT_MIN_PLAY_MINUTES = 10;
const DEFAULT_MAX_PLAY_MINUTES = 60;

const MIN_PLAY_MINUTES =
    Number(process.env.VESPER_MIN_PLAY_MINUTES) ||
    DEFAULT_MIN_PLAY_MINUTES;

const MAX_PLAY_MINUTES =
    Number(process.env.VESPER_MAX_PLAY_MINUTES) ||
    DEFAULT_MAX_PLAY_MINUTES;

const MIN_DISCOVERY_DELAY_MINUTES = 2;
const MAX_DISCOVERY_DELAY_MINUTES = 8;


const queue = [];

const scheduledGames =
    new Map();


let currentGame = null;
let playTimer = null;


/*
 * -------------------------------------------------------
 * RANDOMIZATION
 * -------------------------------------------------------
 */

function randomInteger(
    min,
    max
) {
    return (
        Math.floor(
            Math.random() *
            (max - min + 1)
        ) + min
    );
}


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
 * -------------------------------------------------------
 * GAME IDENTITY
 * -------------------------------------------------------
 */

function getGameKey(
    game
) {
    if (!game) {
        return null;
    }


    return (
        game.game_key ||
        game.url ||
        null
    );
}


function sameGame(
    first,
    second
) {
    const firstKey =
        getGameKey(
            first
        );


    const secondKey =
        getGameKey(
            second
        );


    if (
        !firstKey ||
        !secondKey
    ) {
        return false;
    }


    return (
        firstKey ===
        secondKey
    );
}


function gameAlreadyKnown(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return false;
    }


    const alreadyQueued =
        queue.some(
            (item) =>
                sameGame(
                    item,
                    game
                )
        );


    const currentlyPlaying =
        sameGame(
            currentGame,
            game
        );


    const alreadyScheduled =
        scheduledGames.has(
            gameKey
        );


    return (
        alreadyQueued ||
        currentlyPlaying ||
        alreadyScheduled
    );
}


/*
 * -------------------------------------------------------
 * REVIEW LOGGING
 * -------------------------------------------------------
 */

function logReviewContext(
    game
) {
    const reviews =
        game?.reviews;


    if (!reviews) {
        console.log(
            `[game-play] reviews unavailable: ${game.title}`
        );

        return;
    }


    if (
        !reviews.available
    ) {
        console.log(
            `[game-play] reviews unavailable: ` +
            `${game.title}` +
            (
                reviews.error
                    ? ` (${reviews.error})`
                    : ""
            )
        );

        return;
    }


    const summary =
        reviews.summary ||
        "Unknown";


    const percent =
        reviews.positive_percent;


    const total =
        reviews.total ||
        0;


    console.log(
        `[game-play] reviews: ${game.title} - ` +
        `${summary}; ` +
        `${percent}% positive ` +
        `(${total} review(s))`
    );
}


/*
 * -------------------------------------------------------
 * QUEUE
 * -------------------------------------------------------
 */

function enqueueGame(
    game
) {
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


    queue.push(
        game
    );


    recordQueued(
        game
    );


    console.log(
        `[game-play] queued: ${game.title} (${game.url})`
    );


    return true;
}


/*
 * -------------------------------------------------------
 * DECISION / CONSIDERATION
 * -------------------------------------------------------
 */

function considerGame(
    game,
    client
) {
    console.log(
        `[game-play] considering: ${game.title}`
    );


    logReviewContext(
        game
    );


    const result =
        shouldQueueGame(
            game
        );


    recordDecision(
        game,
        result.decision
    );


    if (
        !result.shouldQueue
    ) {
        console.log(
            `[game-play] Vesper refused: ` +
            `${game.title} - ` +
            `${result.decision.reason}`
        );


        return false;
    }


    console.log(
        `[game-play] Vesper accepted: ${game.title}`
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


    return added;
}


/*
 * -------------------------------------------------------
 * DISCOVERY SCHEDULING
 * -------------------------------------------------------
 */

function scheduleGame(
    game,
    client
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        console.log(
            `[game-play] game has no usable identity: ${game?.title || "Unknown Game"}`
        );


        return false;
    }


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
                scheduledGames.delete(
                    gameKey
                );


                considerGame(
                    game,
                    client
                );
            },

            delay.ms
        );


    scheduledGames.set(
        gameKey,
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
 * -------------------------------------------------------
 * GAME SELECTION
 * -------------------------------------------------------
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
 * -------------------------------------------------------
 * DISCORD PRESENCE
 * -------------------------------------------------------
 */

function clearPlayingActivity(
    client
) {
    client.user.setPresence({
        activities: [],

        status:
            "online",
    });
}


/*
 * -------------------------------------------------------
 * PLAY LIFECYCLE
 * -------------------------------------------------------
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


    recordPlayStarted(
        currentGame
    );


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
            "online",
    });


    console.log(
        "[game-play] presence:",
        client.user.presence.activities
    );


    playTimer =
        setTimeout(
            () => {
                finishCurrentGame(
                    client
                ).catch(
                    (error) => {
                        console.error(
                            "[game-play] finishCurrentGame failed:",
                            error
                        );
                    }
                );
            },

            duration.ms
        );
}


async function finishCurrentGame(
    client
) {
    if (!currentGame) {
        return;
    }


    const finishedGame =
        currentGame;


    console.log(
        `[game-play] Vesper finished playing: ` +
        `${finishedGame.title}`
    );


    recordPlayFinished(
        finishedGame
    );


    /*
     * Vesper forms her own post-play opinion, stores it,
     * and voices it in the channel where the game was
     * originally discovered. Opinion failure must not
     * wedge the game queue.
     */
    try {
        await formAndShareGameOpinion(
            finishedGame,
            client
        );

    } catch (error) {
        console.error(
            `[game-opinion] Could not form opinion for ${finishedGame.title}:`,
            error
        );
    }


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
        "[game-play] cleared playing activity"
    );


    startNextGame(
        client
    );
}


/*
 * -------------------------------------------------------
 * STATE
 * -------------------------------------------------------
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
    considerGame,

    startNextGame,
    finishCurrentGame,

    getCurrentGame,
    getQueue,
    getScheduledGames,

    getGameKey,
    gameAlreadyKnown,
};
