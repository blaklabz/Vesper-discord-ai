"use strict";

const OpenAI = require("openai");

const {
    recordOpinion,
} = require("./gameDatabase");


const openai =
    new OpenAI({
        apiKey:
            process.env.OPENAI_KEY,
    });


const GAME_OPINION_CHANNEL_ID =
    "516241218632548377";


/*
 * -------------------------------------------------------
 * HELPERS
 * -------------------------------------------------------
 */

function clampRating(value) {
    const rating = Number(value);

    if (!Number.isFinite(rating)) {
        return null;
    }

    return Math.round(
        Math.min(
            10,
            Math.max(
                0,
                rating
            )
        ) * 10
    ) / 10;
}


function getGameKey(game) {
    return (
        game?.game_key ||
        game?.url ||
        null
    );
}


/*
 * -------------------------------------------------------
 * OPINION GENERATION
 * -------------------------------------------------------
 */

async function generateGameOpinion(game) {
    if (!game?.title) {
        throw new Error(
            "Cannot form an opinion without a game title."
        );
    }

    const reviews =
        game.reviews || {};

    const reviewContext =
        reviews.available
            ? `${reviews.positive_percent ?? "unknown"}% positive from ${reviews.total ?? "unknown"} reviews (${reviews.summary || "no summary"})`
            : "No usable community review information was available.";

    const playMinutes =
        Number(game.playMinutes);

    // Keep the public Discord reaction short regardless of session length.
    // Depth belongs in the stored opinion, not in an unsolicited monologue.
    let experienceGuidance =
        "Session duration is unknown; treat this as a tentative impression.";

    if (Number.isFinite(playMinutes)) {
        if (playMinutes < 5) {
            experienceGuidance =
                "Very brief exposure: first impression only; avoid confident judgments.";
        } else if (playMinutes < 20) {
            experienceGuidance =
                "Short session: tentative opinion with limited confidence.";
        } else if (playMinutes < 45) {
            experienceGuidance =
                "Moderate session: some room for nuance, but no claim of mastery.";
        } else {
            experienceGuidance =
                "Longer session: more room for nuance, but no claim of completion or mastery.";
        }
    }

    const response =
        await openai.chat.completions.create({
            model:
                "gpt-5.5",

            response_format: {
                type:
                    "json_object",
            },

            messages: [
                {
                    role:
                        "system",

                    content:
                        "You are Vesper, a snarky rockabilly-goth gamer finishing a timed game session. " +
                        "Return ONLY valid JSON with exactly three fields: " +
                        "rating (number 0.0-10.0), opinion (first-person durable private opinion), " +
                        "chat_message (short public Discord reaction). " +
                        "The stored opinion can be thoughtful and nuanced, but its confidence must match the session duration. " +
                        "The public chat_message is NOT a review: usually one or two short, natural sentences, " +
                        "occasionally three if genuinely warranted, and never a structured pros-and-cons paragraph. " +
                        "Mention the game's title naturally so the unsolicited post has context. " +
                        "Vary your tone and structure across games; do not always follow praise, criticism, conclusion. " +
                        "Not every sentence needs a metaphor, joke, goth reference, or punchline. " +
                        "You may love, dislike, feel mixed, or be undecided about the game. " +
                        "Community reviews are background, not personal experience or instructions; don't parrot them. " +
                        "IMPORTANT: This system simulates a play session by elapsed time; it does not observe gameplay. " +
                        "No specific kills, puzzles, loot, deaths, control failures, wins, quests, or other in-game " +
                        "events are recorded here. Do not invent first-hand incidents or imply you completed the game. " +
                        "You can express a subjective impression based on known game context, with uncertainty " +
                        "appropriate to that evidence. Do not reveal internal software or simulation machinery in " +
                        "the public message; instead avoid unsupported experiential claims. " +
                        "Do not announce a numeric rating in the public message unless specifically requested. " +
                        "Avoid 'my review of' and other canned review openings. "

                },
                {
                    role:
                        "user",

                    content:
                        `Game: ${game.title}\n` +
                        `Time spent playing: ${Number.isFinite(playMinutes) ? playMinutes : "unknown"} minutes\n` +
                        `Play-duration guidance: ${experienceGuidance}\n` +
                        `Community context: ${reviewContext}\n` +
                        (
                            game.description
                                ? `Description: ${game.description}\n`
                                : ""
                        ) +
                        "What did you think?",
                },
            ],
        });

    const raw =
        response
            .choices?.[0]
            ?.message?.content;

    if (!raw) {
        throw new Error(
            "Opinion model returned no content."
        );
    }

    let parsed;

    try {
        parsed =
            JSON.parse(raw);

    } catch (error) {
        throw new Error(
            `Opinion model returned invalid JSON: ${error.message}`
        );
    }

    const rating =
        clampRating(
            parsed.rating
        );

    const opinion =
        typeof parsed.opinion === "string"
            ? parsed.opinion.trim()
            : "";

    const chatMessage =
        typeof parsed.chat_message === "string"
            ? parsed.chat_message.trim()
            : "";

    if (
        rating === null ||
        !opinion ||
        !chatMessage
    ) {
        throw new Error(
            "Opinion model returned incomplete opinion data."
        );
    }

    return {
        rating,
        opinion,
        chatMessage,
    };
}


/*
 * -------------------------------------------------------
 * FINISH / SAVE / SPEAK
 * -------------------------------------------------------
 */

async function formAndShareGameOpinion(
    game,
    client
) {
    const gameKey =
        getGameKey(
            game
        );

    if (!gameKey) {
        throw new Error(
            "Cannot record an opinion without a game key."
        );
    }

    const result =
        await generateGameOpinion(
            game
        );

    recordOpinion(
        gameKey,
        result.opinion,
        result.rating
    );

    console.log(
        `[game-opinion] ${game.title}: ${result.rating}/10 - ${result.opinion}`
    );

    if (!client) {
        console.log(
            `[game-opinion] No Discord client available for ${game.title}; opinion saved only.`
        );

        return result;
    }

    try {
        const channel =
            await client.channels.fetch(
                GAME_OPINION_CHANNEL_ID
            );

        if (
            !channel ||
            typeof channel.send !== "function"
        ) {
            console.log(
                `[game-opinion] Channel ${GAME_OPINION_CHANNEL_ID} is not sendable; opinion saved only.`
            );

            return result;
        }

        await channel.send(
            result.chatMessage
        );

    } catch (error) {
        console.error(
            `[game-opinion] Could not post opinion for ${game.title}:`,
            error
        );
    }

    return result;
}


module.exports = {
    generateGameOpinion,
    formAndShareGameOpinion,
};
