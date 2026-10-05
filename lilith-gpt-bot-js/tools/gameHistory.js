"use strict";

const {
    getLastPlayedGame,
    getPlayedGamesSince,
    findGameHistory,
} = require(
    "../game-play/gameDatabase"
);


function simplifyGame(
    game
) {
    if (!game) {
        return null;
    }


    return {
        title:
            game.title,

        status:
            game.status,

        play_count:
            game.play_count,

        last_play_started_at:
            game.last_play_started_at,

        last_play_finished_at:
            game.last_play_finished_at,

        vesper_opinion:
            game.vesper_opinion,

        vesper_rating:
            game.vesper_rating,
    };
}


async function queryGameHistory(
    args = {}
) {
    const mode =
        args.mode;


    if (mode === "last_played") {
        const game =
            getLastPlayedGame();


        return {
            mode,
            game:
                simplifyGame(
                    game
                ),
        };
    }


    if (mode === "recent") {
        const since =
            Date.parse(
                args.since
            );


        if (
            !Number.isFinite(
                since
            )
        ) {
            throw new Error(
                "recent game history requires a valid ISO-8601 since value."
            );
        }


        const games =
            getPlayedGamesSince(
                since
            );


        return {
            mode,
            since:
                args.since,

            count:
                games.length,

            games:
                games.map(
                    simplifyGame
                ),
        };
    }


    if (mode === "lookup") {
        if (!args.title) {
            throw new Error(
                "lookup game history requires a title."
            );
        }


        const games =
            findGameHistory(
                args.title
            );


        return {
            mode,
            query:
                args.title,

            count:
                games.length,

            games:
                games.map(
                    simplifyGame
                ),
        };
    }


    throw new Error(
        `Unknown game history mode: ${mode}`
    );
}


module.exports = {
    queryGameHistory,
};
