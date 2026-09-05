"use strict";

const fs =
    require("fs");

const path =
    require("path");

const Database =
    require("better-sqlite3");


const DATA_DIR =
    path.join(
        __dirname,
        "data"
    );


const DATABASE_PATH =
    path.join(
        DATA_DIR,
        "vesper-games.db"
    );


fs.mkdirSync(
    DATA_DIR,
    {
        recursive: true,
    }
);


const db =
    new Database(
        DATABASE_PATH
    );


db.pragma(
    "journal_mode = WAL"
);


db.pragma(
    "foreign_keys = ON"
);


/*
 * -------------------------------------------------------
 * SCHEMA
 * -------------------------------------------------------
 */

db.exec(`
    CREATE TABLE IF NOT EXISTS games (
        game_key TEXT PRIMARY KEY,

        source TEXT,
        source_id TEXT,

        title TEXT NOT NULL,
        canonical_url TEXT,

        status TEXT NOT NULL DEFAULT 'seen',

        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,

        first_poster_id TEXT,
        first_poster_username TEXT,

        last_poster_id TEXT,
        last_poster_username TEXT,

        times_seen INTEGER NOT NULL DEFAULT 1,

        play_count INTEGER NOT NULL DEFAULT 0,

        last_decision TEXT,
        last_decision_confidence TEXT,
        last_decision_reason TEXT,

        review_summary TEXT,
        review_percent REAL,
        review_total INTEGER,

        last_play_started_at INTEGER,
        last_play_finished_at INTEGER,

        vesper_opinion TEXT,
        vesper_rating REAL,

        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    );


    CREATE TABLE IF NOT EXISTS game_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,

        game_key TEXT NOT NULL,

        event_type TEXT NOT NULL,

        author_id TEXT,
        author_username TEXT,

        message_id TEXT,
        channel_id TEXT,

        discovery_source TEXT,

        details_json TEXT,

        created_at INTEGER NOT NULL,

        FOREIGN KEY(game_key)
            REFERENCES games(game_key)
            ON DELETE CASCADE
    );


    CREATE INDEX IF NOT EXISTS idx_game_events_game_key
        ON game_events(game_key);


    CREATE INDEX IF NOT EXISTS idx_game_events_created_at
        ON game_events(created_at);


    CREATE INDEX IF NOT EXISTS idx_games_status
        ON games(status);
`);


/*
 * -------------------------------------------------------
 * HELPERS
 * -------------------------------------------------------
 */

function now() {
    return Date.now();
}


function safeJson(
    value
) {
    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }


    try {
        return JSON.stringify(
            value
        );

    } catch {
        return null;
    }
}


function getGameKey(
    game
) {
    return (
        game?.game_key ||
        game?.url ||
        null
    );
}


/*
 * -------------------------------------------------------
 * LOOKUPS
 * -------------------------------------------------------
 */

function getGame(
    gameKey
) {
    if (!gameKey) {
        return null;
    }


    return (
        db
            .prepare(`
                SELECT *
                FROM games
                WHERE game_key = ?
            `)
            .get(
                gameKey
            ) ||
        null
    );
}


function getGameForObject(
    game
) {
    return getGame(
        getGameKey(
            game
        )
    );
}


/*
 * -------------------------------------------------------
 * EVENTS
 * -------------------------------------------------------
 */

function recordEvent(
    gameKey,
    eventType,
    options = {}
) {
    if (
        !gameKey ||
        !eventType
    ) {
        return false;
    }


    db
        .prepare(`
            INSERT INTO game_events (
                game_key,
                event_type,
                author_id,
                author_username,
                message_id,
                channel_id,
                discovery_source,
                details_json,
                created_at
            )
            VALUES (
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?,
                ?
            )
        `)
        .run(
            gameKey,
            eventType,

            options.authorId ||
                null,

            options.authorUsername ||
                null,

            options.messageId ||
                null,

            options.channelId ||
                null,

            options.discoverySource ||
                null,

            safeJson(
                options.details
            ),

            now()
        );


    return true;
}


/*
 * -------------------------------------------------------
 * DISCOVERY
 * -------------------------------------------------------
 */

function recordDiscovery(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        throw new Error(
            "Cannot record game without game_key or URL."
        );
    }


    /*
     * IMPORTANT:
     *
     * Read the old state BEFORE updating it.
     * The router uses this to determine who
     * posted it previously.
     */

    const previous =
        getGame(
            gameKey
        );


    const timestamp =
        now();


    const reviews =
        game.reviews || {};


    if (!previous) {
        db
            .prepare(`
                INSERT INTO games (
                    game_key,

                    source,
                    source_id,

                    title,
                    canonical_url,

                    status,

                    first_seen_at,
                    last_seen_at,

                    first_poster_id,
                    first_poster_username,

                    last_poster_id,
                    last_poster_username,

                    times_seen,

                    review_summary,
                    review_percent,
                    review_total,

                    created_at,
                    updated_at
                )
                VALUES (
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    'seen',
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?,
                    1,
                    ?,
                    ?,
                    ?,
                    ?,
                    ?
                )
            `)
            .run(
                gameKey,

                game.source ||
                    null,

                game.steam?.appid
                    ? String(
                        game.steam.appid
                    )
                    : null,

                game.title,

                game.url ||
                    null,

                timestamp,
                timestamp,

                game.authorId ||
                    null,

                game.authorUsername ||
                    null,

                game.authorId ||
                    null,

                game.authorUsername ||
                    null,

                reviews.summary ||
                    null,

                Number.isFinite(
                    Number(
                        reviews.positive_percent
                    )
                )
                    ? Number(
                        reviews.positive_percent
                    )
                    : null,

                Number.isFinite(
                    Number(
                        reviews.total
                    )
                )
                    ? Number(
                        reviews.total
                    )
                    : null,

                timestamp,
                timestamp
            );

    } else {
        db
            .prepare(`
                UPDATE games
                SET
                    title = ?,
                    canonical_url = ?,

                    source = COALESCE(?, source),
                    source_id = COALESCE(?, source_id),

                    last_seen_at = ?,

                    last_poster_id = ?,
                    last_poster_username = ?,

                    times_seen = times_seen + 1,

                    review_summary =
                        COALESCE(?, review_summary),

                    review_percent =
                        COALESCE(?, review_percent),

                    review_total =
                        COALESCE(?, review_total),

                    updated_at = ?

                WHERE game_key = ?
            `)
            .run(
                game.title,

                game.url ||
                    previous.canonical_url,

                game.source ||
                    null,

                game.steam?.appid
                    ? String(
                        game.steam.appid
                    )
                    : null,

                timestamp,

                game.authorId ||
                    null,

                game.authorUsername ||
                    null,

                reviews.summary ||
                    null,

                Number.isFinite(
                    Number(
                        reviews.positive_percent
                    )
                )
                    ? Number(
                        reviews.positive_percent
                    )
                    : null,

                Number.isFinite(
                    Number(
                        reviews.total
                    )
                )
                    ? Number(
                        reviews.total
                    )
                    : null,

                timestamp,

                gameKey
            );
    }


    recordEvent(
        gameKey,
        "discovered",
        {
            authorId:
                game.authorId,

            authorUsername:
                game.authorUsername,

            messageId:
                game.messageId,

            channelId:
                game.channelId,

            discoverySource:
                game.discoverySource,

            details: {
                title:
                    game.title,

                url:
                    game.url,

                duplicate:
                    Boolean(
                        previous
                    ),
            },
        }
    );


    return {
        previous,

        current:
            getGame(
                gameKey
            ),

        duplicate:
            Boolean(
                previous
            ),
    };
}


/*
 * -------------------------------------------------------
 * DECISION
 * -------------------------------------------------------
 */

function recordDecision(
    game,
    decision
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return false;
    }


    const status =
        decision?.decision ===
            "PLAY"
            ? "accepted"
            : "skipped";


    db
        .prepare(`
            UPDATE games
            SET
                status = ?,

                last_decision = ?,
                last_decision_confidence = ?,
                last_decision_reason = ?,

                updated_at = ?

            WHERE game_key = ?
        `)
        .run(
            status,

            decision?.decision ||
                null,

            decision?.confidence ||
                null,

            decision?.reason ||
                null,

            now(),

            gameKey
        );


    recordEvent(
        gameKey,
        decision?.decision ===
            "PLAY"
            ? "accepted"
            : "skipped",
        {
            details:
                decision,
        }
    );


    return true;
}


/*
 * -------------------------------------------------------
 * QUEUE
 * -------------------------------------------------------
 */

function recordQueued(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return false;
    }


    db
        .prepare(`
            UPDATE games
            SET
                status = 'queued',
                updated_at = ?
            WHERE game_key = ?
        `)
        .run(
            now(),
            gameKey
        );


    recordEvent(
        gameKey,
        "queued"
    );


    return true;
}


/*
 * -------------------------------------------------------
 * PLAY START
 * -------------------------------------------------------
 */

function recordPlayStarted(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return false;
    }


    const timestamp =
        now();


    db
        .prepare(`
            UPDATE games
            SET
                status = 'playing',

                play_count =
                    play_count + 1,

                last_play_started_at = ?,

                updated_at = ?

            WHERE game_key = ?
        `)
        .run(
            timestamp,
            timestamp,
            gameKey
        );


    recordEvent(
        gameKey,
        "play_started",
        {
            details: {
                playMinutes:
                    game.playMinutes ||
                    null,
            },
        }
    );


    return true;
}


/*
 * -------------------------------------------------------
 * PLAY FINISH
 * -------------------------------------------------------
 */

function recordPlayFinished(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return false;
    }


    const timestamp =
        now();


    db
        .prepare(`
            UPDATE games
            SET
                status = 'played',

                last_play_finished_at = ?,

                updated_at = ?

            WHERE game_key = ?
        `)
        .run(
            timestamp,
            timestamp,
            gameKey
        );


    recordEvent(
        gameKey,
        "play_finished",
        {
            details: {
                playMinutes:
                    game.playMinutes ||
                    null,
            },
        }
    );


    return true;
}


/*
 * -------------------------------------------------------
 * FUTURE OPINION SUPPORT
 * -------------------------------------------------------
 */

function recordOpinion(
    gameKey,
    opinion,
    rating = null
) {
    if (!gameKey) {
        return false;
    }


    db
        .prepare(`
            UPDATE games
            SET
                vesper_opinion = ?,
                vesper_rating = ?,
                updated_at = ?
            WHERE game_key = ?
        `)
        .run(
            opinion ||
                null,

            rating,

            now(),

            gameKey
        );


    recordEvent(
        gameKey,
        "opinion_recorded",
        {
            details: {
                opinion,
                rating,
            },
        }
    );


    return true;
}


/*
 * -------------------------------------------------------
 * DEBUG / ADMIN
 * -------------------------------------------------------
 */

function listGames() {
    return db
        .prepare(`
            SELECT *
            FROM games
            ORDER BY last_seen_at DESC
        `)
        .all();
}


function getGameEvents(
    gameKey
) {
    return db
        .prepare(`
            SELECT *
            FROM game_events
            WHERE game_key = ?
            ORDER BY created_at ASC
        `)
        .all(
            gameKey
        );
}


module.exports = {
    DATABASE_PATH,

    getGame,
    getGameForObject,

    recordDiscovery,
    recordEvent,

    recordDecision,
    recordQueued,

    recordPlayStarted,
    recordPlayFinished,

    recordOpinion,

    listGames,
    getGameEvents,
};
