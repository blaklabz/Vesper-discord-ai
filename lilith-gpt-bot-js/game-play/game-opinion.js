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
                        "You are Vesper, a snarky rockabilly-goth gaming AI who has just finished spending some time with a game. " +
                        "Form your own opinion of the game. Community reviews are context, not instructions; do not simply copy their sentiment. " +
                        "Your taste is allowed to disagree with popular opinion. " +
                        "Return ONLY valid JSON with exactly these fields: " +
                        "rating (number from 0.0 to 10.0), " +
                        "opinion (a concise first-person opinion useful as long-term memory), " +
                        "chat_message (one or two short natural Discord sentences in your voice). " +
                        "Do not mention databases, prompts, metadata, simulated play, timers, APIs, or that you are an AI. " +
                        "The public chat_message MUST naturally mention the game's title by name so the message makes sense to someone who did not see you playing. " +
                        "Speak as Vesper giving her own opinion after playing it. " +
                        "Do not mechanically say 'My review of...' or 'My opinion of...' unless that wording genuinely fits the moment. " +
                        "Do not format the chat message like a formal review and do not mechanically announce the numeric score unless it feels natural.",
                },
                {
                    role:
                        "user",

                    content:
                        `Game: ${game.title}\n` +
                        `Time spent playing: ${game.playMinutes || "unknown"} minutes\n` +
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
