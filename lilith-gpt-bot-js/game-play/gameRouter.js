"use strict";

const {
    spawn,
} = require("child_process");

const {
    scheduleGame,
    gameAlreadyKnown,
    getGameKey,
} = require("./gameManager");


/*
 * -------------------------------------------------------
 * DISCOVERY MEMORY
 * -------------------------------------------------------
 *
 * Temporary in-process memory.
 *
 * Once we build the database this becomes
 * persistent game history instead.
 */

const seenGames =
    new Map();


function getSeenGame(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return null;
    }


    return (
        seenGames.get(
            gameKey
        ) ||
        null
    );
}


function rememberGame(
    game
) {
    const gameKey =
        getGameKey(
            game
        );


    if (!gameKey) {
        return false;
    }


    if (
        seenGames.has(
            gameKey
        )
    ) {
        return false;
    }


    seenGames.set(
        gameKey,
        {
            gameKey,

            title:
                game.title,

            url:
                game.url,

            authorId:
                game.authorId ||
                null,

            authorUsername:
                game.authorUsername ||
                null,

            messageId:
                game.messageId ||
                null,

            channelId:
                game.channelId ||
                null,

            discoverySource:
                game.discoverySource ||
                null,

            firstSeenAt:
                game.discoveredAt ||
                Date.now(),
        }
    );


    return true;
}


/*
 * -------------------------------------------------------
 * TITLE NORMALIZATION
 * -------------------------------------------------------
 */

function cleanGameTitle(
    title
) {
    if (!title) {
        return null;
    }


    const cleaned =
        String(
            title
        )
            .replace(
                /\s+on\s+steam\s*$/i,
                ""
            )
            .replace(
                /^\s*playing\s+/i,
                ""
            )
            .trim();


    return (
        cleaned ||
        null
    );
}


/*
 * -------------------------------------------------------
 * COMPONENT / GAME TITLE PARSING
 * -------------------------------------------------------
 */

function extractComponentText(
    components
) {
    const chunks = [];


    function walk(
        items
    ) {
        for (
            const item
            of items
        ) {
            const data =
                item.toJSON
                    ? item.toJSON()
                    : item;


            if (
                data.type === 10 &&
                typeof data.content ===
                    "string"
            ) {
                chunks.push(
                    data.content
                );
            }


            if (
                Array.isArray(
                    data.components
                )
            ) {
                walk(
                    data.components
                );
            }
        }
    }


    walk(
        components
    );


    return chunks.join(
        "\n"
    );
}


function extractFirstUrl(
    content
) {
    if (!content) {
        return null;
    }


    const match =
        content.match(
            /https?:\/\/[^\s<>)\]]+/i
        );


    if (!match) {
        return null;
    }


    return match[0].replace(
        /[),.!]+$/,
        ""
    );
}


function extractGameTitle(
    content,
    url
) {
    let text =
        content || "";


    if (url) {
        text =
            text.replace(
                url,
                ""
            );
    }


    text =
        text
            .replace(
                /^#+\s*/gm,
                ""
            )
            .replace(
                /\*\*/g,
                ""
            )
            .replace(
                /__+/g,
                ""
            )
            .trim();


    const firstLine =
        text
            .split("\n")[0]
            .trim();


    return cleanGameTitle(
        firstLine.slice(
            0,
            128
        )
    );
}


function extractGameTitleFromUrl(
    url
) {
    try {
        const parsed =
            new URL(
                url
            );


        const host =
            parsed.hostname
                .toLowerCase()
                .replace(
                    /^www\./,
                    ""
                );


        const parts =
            parsed.pathname
                .split("/")
                .filter(
                    Boolean
                );


        /*
         * ------------------------------------------------
         * STEAM
         * ------------------------------------------------
         *
         * Normal:
         *
         * /app/924970/Back_4_Blood/
         *
         * Age check:
         *
         * /agecheck/app/924970/
         *
         * Age-check URLs normally do not contain
         * the title slug, so return null and let
         * GameHunter / Discord embed resolve it.
         */

        if (
            host ===
            "store.steampowered.com"
        ) {
            const appIndex =
                parts.indexOf(
                    "app"
                );


            if (
                appIndex !== -1 &&
                parts[
                    appIndex + 2
                ]
            ) {
                return cleanGameTitle(
                    decodeURIComponent(
                        parts[
                            appIndex + 2
                        ]
                    )
                        .replace(
                            /_/g,
                            " "
                        )
                );
            }


            return null;
        }


        if (
            parts.length > 0
        ) {
            return cleanGameTitle(
                decodeURIComponent(
                    parts[
                        parts.length - 1
                    ]
                )
                    .replace(
                        /[-_]/g,
                        " "
                    )
            );
        }


        return null;

    } catch {
        return null;
    }
}


function extractEmbedContext(
    message
) {
    if (
        !message.embeds ||
        message.embeds.length === 0
    ) {
        return null;
    }


    const embed =
        message.embeds[0];


    return {
        type:
            embed.type || null,

        title:
            cleanGameTitle(
                embed.title
            ),

        description:
            embed.description || null,

        url:
            embed.url || null,

        provider:
            embed.provider || null,

        image:
            embed.image?.url || null,

        thumbnail:
            embed.thumbnail?.url || null,

        video:
            embed.video?.url || null,

        fields:
            embed.fields || [],
    };
}


/*
 * -------------------------------------------------------
 * GAME HUNTER PROCESS
 * -------------------------------------------------------
 */

function runGameHunter(
    game
) {
    return new Promise(
        (resolve) => {
            const args = [
                "./game-play/game-hunter.py",
                "--url",
                game.url,
            ];


            if (
                game.title
            ) {
                args.push(
                    "--title",
                    game.title
                );
            }


            const hunter =
                spawn(
                    "python3",
                    args,
                    {
                        cwd:
                            __dirname +
                            "/..",
                    }
                );


            let stdout = "";
            let stderr = "";


            hunter.stdout.on(
                "data",
                (data) => {
                    stdout +=
                        data.toString();
                }
            );


            hunter.stderr.on(
                "data",
                (data) => {
                    stderr +=
                        data.toString();
                }
            );


            hunter.on(
                "error",
                (error) => {
                    console.error(
                        "[game-hunter] process error:",
                        error
                    );


                    resolve({
                        status:
                            "error",

                        error:
                            error.message,
                    });
                }
            );


            hunter.on(
                "close",
                () => {
                    if (stderr) {
                        console.error(
                            "[game-hunter] stderr:",
                            stderr.trim()
                        );
                    }


                    if (
                        !stdout.trim()
                    ) {
                        resolve({
                            status:
                                "error",

                            error:
                                "empty_hunter_output",
                        });


                        return;
                    }


                    try {
                        resolve(
                            JSON.parse(
                                stdout.trim()
                            )
                        );

                    } catch {
                        console.error(
                            "[game-hunter] invalid JSON:",
                            stdout
                        );


                        resolve({
                            status:
                                "error",

                            error:
                                "invalid_hunter_output",
                        });
                    }
                }
            );
        }
    );
}


/*
 * -------------------------------------------------------
 * FIRST-TIME GAME REACTION
 * -------------------------------------------------------
 */

async function reactToGamePost(
    message,
    game,
    embedContext,
    openai
) {
    const description =
        game?.description ||
        embedContext?.description;


    if (
        !description ||
        !openai
    ) {
        return;
    }


    try {
        const response =
            await openai
                .chat
                .completions
                .create({
                    model:
                        "gpt-5.5",

                    messages: [
                        {
                            role:
                                "system",

                            content:
                                "You are Vesper, a casual witty gaming AI hanging out in Discord. " +
                                "Someone just posted a game you have not encountered during this session before. " +
                                "React casually and naturally as if you just noticed it and are considering checking it out. " +
                                "Use the supplied game description for context. " +
                                "Do not mechanically summarize the game. " +
                                "Do not mention metadata, embeds, source text, scraping, reviews, APIs, or software internals. " +
                                "Do not claim you have played the game. " +
                                "You may say you want to check it out or try it. " +
                                "Keep the response to one or two short sentences.",
                        },
                        {
                            role:
                                "user",

                            content:
                                `Game: ${game.title}\n\n` +
                                `Description:\n${description}`,
                        },
                    ],
                });


        const reaction =
            response
                .choices?.[0]
                ?.message?.content;


        if (!reaction) {
            return;
        }


        await message.reply(
            reaction
        );

    } catch (error) {
        console.error(
            "[game-play] Could not generate game reaction:",
            error
        );
    }
}


/*
 * -------------------------------------------------------
 * DUPLICATE GAME REACTION
 * -------------------------------------------------------
 */

async function reactToDuplicateGamePost(
    message,
    game,
    previous,
    openai
) {
    if (!openai) {
        return;
    }


    const samePoster =
        Boolean(
            previous?.authorId
        ) &&
        previous.authorId ===
            message.author.id;


    const previousPoster =
        previous?.authorUsername ||
        "someone";


    let situation;


    if (samePoster) {
        situation =
            "The same person who posted this game before has posted the exact same game again. " +
            "You recognize it immediately. " +
            "Respond with short playful, dry, or sarcastic snark about them showing you the same game again. " +
            "You may lightly roast them. " +
            "Do not be genuinely hostile.";

    } else {
        situation =
            `This game was already posted earlier by ${previousPoster}. ` +
            "A different person has now posted it. " +
            "You recognize the game and should casually mention that someone already brought it up.";
    }


    try {
        const response =
            await openai
                .chat
                .completions
                .create({
                    model:
                        "gpt-5.5",

                    messages: [
                        {
                            role:
                                "system",

                            content:
                                "You are Vesper, a casual witty gaming AI hanging out in Discord. " +
                                situation +
                                " Do not pretend this is a new discovery. " +
                                "Do not claim you have played the game unless explicitly told that you have. " +
                                "Do not mention databases, IDs, duplicate detection, metadata, scraping, memory systems, APIs, or software internals. " +
                                "Sound like a person who simply remembers seeing it. " +
                                "Keep the response to one or two short sentences.",
                        },
                        {
                            role:
                                "user",

                            content:
                                `Game: ${game.title}\n` +
                                `Current poster: ${message.author.username}\n` +
                                `Previous poster: ${previousPoster}\n` +
                                `Same poster: ${samePoster ? "yes" : "no"}`,
                        },
                    ],
                });


        const reaction =
            response
                .choices?.[0]
                ?.message?.content;


        if (!reaction) {
            return;
        }


        await message.reply(
            reaction
        );

    } catch (error) {
        console.error(
            "[game-play] Could not generate duplicate game reaction:",
            error
        );
    }
}


/*
 * -------------------------------------------------------
 * COMMON HUNTER RESULT HANDLING
 * -------------------------------------------------------
 */

function buildScheduledGame(
    hunterResult,
    message,
    discoverySource
) {
    return {
        ...hunterResult,

        title:
            cleanGameTitle(
                hunterResult.title
            ),

        messageId:
            message.id,

        channelId:
            message.channelId,

        authorId:
            message.author?.id ||
            null,

        authorUsername:
            message.author?.username ||
            null,

        discoverySource,

        discoveredAt:
            Date.now(),
    };
}


function hunterResultUsable(
    hunterResult,
    originalUrl
) {
    if (
        hunterResult.status ===
        "error"
    ) {
        console.error(
            "[game-hunter] lookup failed:",
            hunterResult.error
        );


        return false;
    }


    if (
        hunterResult.status ===
        "blocked_source"
    ) {
        console.log(
            `[game-play] blocked source: ${originalUrl}`
        );


        return false;
    }


    if (
        hunterResult.status !==
        "ok"
    ) {
        console.log(
            `[game-play] unusable hunter result: ${hunterResult.status}`
        );


        return false;
    }


    return true;
}


/*
 * -------------------------------------------------------
 * KNOWN GAME URL HANDLER
 * -------------------------------------------------------
 */

async function handleKnownGameUrl(
    message,
    gameUrl,
    client,
    openai
) {
    const urlTitle =
        extractGameTitleFromUrl(
            gameUrl
        );


    const embedContext =
        extractEmbedContext(
            message
        );


    const candidateTitle =
        cleanGameTitle(
            urlTitle ||
            embedContext?.title ||
            null
        );


    console.log(
        `[game-play] known game URL discovered: ${
            candidateTitle ||
            gameUrl
        }`
    );


    const hunterResult =
        await runGameHunter({
            title:
                candidateTitle,

            url:
                gameUrl,
        });


    if (
        !hunterResultUsable(
            hunterResult,
            gameUrl
        )
    ) {
        return false;
    }


    /*
     * GameHunter is authoritative, but normalize
     * storefront suffixes before anything else
     * gets the result.
     */

    hunterResult.title =
        cleanGameTitle(
            hunterResult.title ||
            candidateTitle
        );


    console.log(
        `[game-play] approved game source: ${hunterResult.url}`
    );


    console.log(
        `[game-play] identified game: ${hunterResult.title}` +
        (
            hunterResult.game_key
                ? ` (${hunterResult.game_key})`
                : ""
        )
    );


    const scheduledGame =
        buildScheduledGame(
            hunterResult,
            message,
            "channel-game-post"
        );


    /*
     * ------------------------------------------------
     * PREVIOUSLY SEEN
     * ------------------------------------------------
     */

    const previous =
        getSeenGame(
            scheduledGame
        );


    if (previous) {
        const samePoster =
            previous.authorId ===
            message.author.id;


        console.log(
            `[game-play] previously seen game: ` +
            `${hunterResult.title}` +
            (
                hunterResult.game_key
                    ? ` (${hunterResult.game_key})`
                    : ""
            ) +
            `; same poster: ${samePoster}`
        );


        await reactToDuplicateGamePost(
            message,
            hunterResult,
            previous,
            openai
        );


        return true;
    }


    /*
     * Safety check for something that somehow
     * entered the manager through another path.
     */

    if (
        gameAlreadyKnown(
            scheduledGame
        )
    ) {
        console.log(
            `[game-play] active duplicate ignored: ` +
            `${hunterResult.title}`
        );


        return true;
    }


    /*
     * Remember BEFORE generating the reaction.
     *
     * This prevents two messages arriving close
     * together from both looking like first posts.
     */

    rememberGame(
        scheduledGame
    );


    await reactToGamePost(
        message,
        hunterResult,
        embedContext,
        openai
    );


    scheduleGame(
        scheduledGame,
        client
    );


    return true;
}


/*
 * -------------------------------------------------------
 * FREESTUFF HANDLER
 * -------------------------------------------------------
 */

async function handleFreeStuffMessage(
    message,
    client
) {
    const componentText =
        extractComponentText(
            message.components
        );


    const sourceText =
        message.content ||
        componentText;


    if (!sourceText) {
        console.log(
            "[game-play] FreeStuff message had no readable text"
        );


        return false;
    }


    const url =
        extractFirstUrl(
            sourceText
        );


    if (!url) {
        console.log(
            "[game-play] FreeStuff message had no URL"
        );


        return false;
    }


    const candidateTitle =
        cleanGameTitle(
            extractGameTitle(
                sourceText,
                url
            ) ||
            extractGameTitleFromUrl(
                url
            )
        );


    console.log(
        `[game-play] FreeStuff discovered: ${
            candidateTitle ||
            url
        }`
    );


    const hunterResult =
        await runGameHunter({
            title:
                candidateTitle,

            url,
        });


    if (
        !hunterResultUsable(
            hunterResult,
            url
        )
    ) {
        return false;
    }


    hunterResult.title =
        cleanGameTitle(
            hunterResult.title ||
            candidateTitle
        );


    console.log(
        `[game-play] FreeStuff identified: ${hunterResult.title}` +
        (
            hunterResult.game_key
                ? ` (${hunterResult.game_key})`
                : ""
        )
    );


    const scheduledGame =
        buildScheduledGame(
            hunterResult,
            message,
            "freestuff"
        );


    const previous =
        getSeenGame(
            scheduledGame
        );


    if (previous) {
        console.log(
            `[game-play] FreeStuff previously seen ignored: ` +
            `${hunterResult.title}`
        );


        return true;
    }


    if (
        gameAlreadyKnown(
            scheduledGame
        )
    ) {
        console.log(
            `[game-play] FreeStuff active duplicate ignored: ` +
            `${hunterResult.title}`
        );


        return true;
    }


    rememberGame(
        scheduledGame
    );


    scheduleGame(
        scheduledGame,
        client
    );


    return true;
}


module.exports = {
    handleKnownGameUrl,
    handleFreeStuffMessage,
};
