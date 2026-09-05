"use strict";


const MIN_REVIEW_SAMPLE = 25;

const HARD_SKIP_PERCENT = 40;
const SOFT_SKIP_PERCENT = 55;
const MIXED_PERCENT = 70;
const GOOD_PERCENT = 85;


function decideGame(game) {
    if (!game) {
        return {
            decision: "SKIP",
            confidence: "high",
            reason: "GameHunter returned no game data.",
        };
    }

    if (game.status !== "ok") {
        return {
            decision: "SKIP",
            confidence: "high",
            reason:
                `GameHunter status was ${game.status}.`,
        };
    }

    const reviews = game.reviews;

    /*
     * No reviews is not a rejection.
     *
     * Steam currently gives us structured review
     * information. Other storefronts may not.
     */
    if (!reviews) {
        return {
            decision: "PLAY",
            confidence: "low",
            reason:
                "No review information is available.",
        };
    }

    if (!reviews.available) {
        return {
            decision: "PLAY",
            confidence: "low",
            reason:
                "Review information could not be retrieved.",
        };
    }

    const total = Number(
        reviews.total || 0
    );

    const percent = Number(
        reviews.positive_percent
    );

    if (
        !Number.isFinite(percent)
    ) {
        return {
            decision: "PLAY",
            confidence: "low",
            reason:
                "No usable positive-review percentage is available.",
        };
    }

    /*
     * Tiny samples shouldn't cause Vesper
     * to reject something outright.
     */
    if (
        total < MIN_REVIEW_SAMPLE
    ) {
        return {
            decision: "PLAY",
            confidence: "low",
            reason:
                `Only ${total} reviews are available.`,
        };
    }

    /*
     * Truly terrible reviews.
     */
    if (
        percent < HARD_SKIP_PERCENT
    ) {
        return {
            decision: "SKIP",
            confidence: "high",
            reason:
                `Only ${percent}% of ${total} reviews are positive.`,
        };
    }

    /*
     * Probably not worth Vesper's time.
     */
    if (
        percent < SOFT_SKIP_PERCENT
    ) {
        return {
            decision: "SKIP",
            confidence: "medium",
            reason:
                `${percent}% of ${total} reviews are positive.`,
        };
    }

    /*
     * Mixed territory.
     *
     * She'll still try these for now.
     */
    if (
        percent < MIXED_PERCENT
    ) {
        return {
            decision: "PLAY",
            confidence: "low",
            reason:
                `Reviews are mixed at ${percent}% positive.`,
        };
    }

    /*
     * Generally positive.
     */
    if (
        percent < GOOD_PERCENT
    ) {
        return {
            decision: "PLAY",
            confidence: "medium",
            reason:
                `${percent}% of ${total} reviews are positive.`,
        };
    }

    /*
     * Strong reviews.
     */
    return {
        decision: "PLAY",
        confidence: "high",
        reason:
            `${percent}% of ${total} reviews are positive`
            + (
                reviews.summary
                    ? ` (${reviews.summary}).`
                    : "."
            ),
    };
}


function formatDecisionLog(
    game,
    decision
) {
    const title =
        game?.title
        || "Unknown Game";

    return (
        `[game-play] decision: `
        + `${decision.decision} `
        + `(${decision.confidence}) `
        + `${title} - `
        + `${decision.reason}`
    );
}


function shouldQueueGame(
    game
) {
    const decision =
        decideGame(game);

    console.log(
        formatDecisionLog(
            game,
            decision
        )
    );

    return {
        shouldQueue:
            decision.decision
            === "PLAY",

        decision,
    };
}


module.exports = {
    decideGame,
    shouldQueueGame,
    formatDecisionLog,

    thresholds: {
        MIN_REVIEW_SAMPLE,
        HARD_SKIP_PERCENT,
        SOFT_SKIP_PERCENT,
        MIXED_PERCENT,
        GOOD_PERCENT,
    },
};
