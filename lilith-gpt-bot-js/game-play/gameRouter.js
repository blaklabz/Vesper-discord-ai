"use strict";

const {
    spawn,
} = require("child_process");


const {
    scheduleGame,
    gameAlreadyKnown,
} = require("./gameManager");


const {
    recordDiscovery,
} = require("./gameDatabase");


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
        content ||
        "";


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
            embed.type ||
            null,

        title:
            cleanGameTitle(
                embed.title
            ),

        description:
            embed.description ||
            null,

        url:
            embed.url ||
            null,

        provider:
            embed.provider ||
            null,

        image:
            embed.image?.url ||
            null,

        thumbnail:
            embed.thumbnail?.url ||
            null,

        video:
            embed.video?.url ||
            null,

        fields:
            embed.fields ||
            [],
    };
}


/*
 * -------------------------------------------------------
 * GAME HUNTER
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
 * REACTIONS
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
                                "Someone just posted a game you have never encountered before. " +
                                "React naturally as if you are considering checking it out. " +
                                "Do not mechanically summarize the game. " +
                                "Do not mention databases, metadata, scraping, APIs, reviews, embeds, or software internals. " +
                                "Do not claim you have played it. " +
                                "Keep it to one or two short sentences.",
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


        if (reaction) {
            await message.reply(
                reaction
            );
        }

    } catch (error) {
        console.error(
            "[game-play] Could not generate game reaction:",
            error
        );
    }
}


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
            previous?.last_poster_id
        ) &&
        previous.last_poster_id ===
            message.author.id;


    const previousPoster =
        previous?.last_poster_username ||
        previous?.first_poster_username ||
        "someone";


    let historyContext;


    if (
        previous.status ===
        "played"
    ) {
        historyContext =
            "You have already played this game before.";

    } else if (
        previous.status ===
        "playing"
    ) {
        historyContext =
            "You are already playing this game.";

    } else if (
        previous.status ===
        "skipped"
    ) {
        historyContext =
            "You already considered this game and decided not to play it.";

    } else {
        historyContext =
            "You have already seen this game before but have not necessarily played it.";
    }


    let posterContext;


    if (samePoster) {
        posterContext =
            "The person posting it now is the same person who posted it most recently. " +
            "Be playfully snarky about them showing you the same game again.";

    } else {
        posterContext =
            `The previous person who posted it was ${previousPoster}. ` +
            "A different person has posted it now. " +
            "Mention naturally that you recognize it.";
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
                                historyContext +
                                " " +
                                posterContext +
                                " Do not pretend it is new. " +
                                "Do not mention databases, memory systems, duplicate detection, IDs, scraping, APIs, or software internals. " +
                                "Keep the response short and natural.",
                        },
                        {
                            role:
                                "user",

                            content:
                                `Game: ${game.title}\n` +
                                `Times previously seen: ${previous.times_seen}\n` +
                                `Previous status: ${previous.status}\n` +
                                `Current poster: ${message.author.username}`,
                        },
                    ],
                });


        const reaction =
            response
                .choices?.[0]
                ?.message?.content;


        if (reaction) {
            await message.reply(
                reaction
            );
        }

    } catch (error) {
        console.error(
            "[game-play] Could not generate duplicate reaction:",
            error
        );
    }
}


/*
 * -------------------------------------------------------
 * COMMON RESULT HANDLING
 * -------------------------------------------------------
 */

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


function buildGame(
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


/*
 * -------------------------------------------------------
 * KNOWN GAME URL
 * -------------------------------------------------------
 */

async function handleKnownGameUrl(
    message,
    gameUrl,
    client,
    openai
) {
    const embedContext =
        extractEmbedContext(
            message
        );


    const candidateTitle =
        cleanGameTitle(
            extractGameTitleFromUrl(
                gameUrl
            ) ||
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


    const game =
        buildGame(
            hunterResult,
            message,
            "channel-game-post"
        );


    /*
     * This both reads previous history
     * AND records this new discovery.
     */

    const discovery =
        recordDiscovery(
            game
        );


    if (
        discovery.duplicate
    ) {
        const samePoster =
            discovery.previous
                ?.last_poster_id ===
            message.author.id;


        console.log(
            `[game-play] previously known game: ` +
            `${game.title} (${game.game_key}); ` +
            `same poster: ${samePoster}; ` +
            `status: ${discovery.previous.status}; ` +
            `seen: ${discovery.previous.times_seen}`
        );


        await reactToDuplicateGamePost(
            message,
            game,
            discovery.previous,
            openai
        );


        return true;
    }


    if (
        gameAlreadyKnown(
            game
        )
    ) {
        console.log(
            `[game-play] active duplicate ignored: ${game.title}`
        );


        return true;
    }


    await reactToGamePost(
        message,
        game,
        embedContext,
        openai
    );


    scheduleGame(
        game,
        client
    );


    return true;
}


/*
 * -------------------------------------------------------
 * FREESTUFF
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


    const game =
        buildGame(
            hunterResult,
            message,
            "freestuff"
        );


    const discovery =
        recordDiscovery(
            game
        );


    if (
        discovery.duplicate
    ) {
        console.log(
            `[game-play] FreeStuff previously known: ` +
            `${game.title} (${game.game_key})`
        );


        return true;
    }


    if (
        gameAlreadyKnown(
            game
        )
    ) {
        console.log(
            `[game-play] FreeStuff active duplicate ignored: ${game.title}`
        );


        return true;
    }


    scheduleGame(
        game,
        client
    );


    return true;
}


module.exports = {
    handleKnownGameUrl,
    handleFreeStuffMessage,
};
