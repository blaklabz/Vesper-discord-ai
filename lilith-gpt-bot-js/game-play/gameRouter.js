"use strict";

const {
    spawn,
} = require("child_process");

const {
    scheduleGame,
} = require("./gameManager");


/*
 * -------------------------------------------------------
 * COMPONENT / GAME TITLE PARSING
 * -------------------------------------------------------
 */

function extractComponentText(
    components
) {
    const chunks = [];

    function walk(items) {
        for (const item of items) {
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

    return firstLine.slice(
        0,
        128
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
         * Steam normal URL:
         *
         * /app/3517740/Frostrail/
         *
         * Steam age check:
         *
         * /agecheck/app/924970/
         *
         * An age-check URL without a slug
         * intentionally returns null here.
         * GameHunter will resolve the real
         * title from the canonical store page.
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
                return decodeURIComponent(
                    parts[
                        appIndex + 2
                    ]
                )
                    .replace(
                        /_/g,
                        " "
                    )
                    .trim();
            }

            return null;
        }


        if (
            parts.length > 0
        ) {
            return decodeURIComponent(
                parts[
                    parts.length - 1
                ]
            )
                .replace(
                    /[-_]/g,
                    " "
                )
                .trim();
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
            embed.title || null,

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

                    } catch (error) {
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
 * VESPER GAME REACTION
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
                                "You are Vesper. " +
                                "Someone just posted a game in Discord. " +
                                "React casually and naturally as if you just noticed it and are considering checking it out. " +
                                "Use the supplied game description for context. " +
                                "Do not mechanically summarize the game. " +
                                "Do not say you read an embed, description, metadata, or source text. " +
                                "Do not claim you have already played the game. " +
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

        await message
            .channel
            .send(
                `${message.author} ${reaction}`
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

        messageId:
            message.id,

        channelId:
            message.channelId,

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
        urlTitle ||
        embedContext?.title ||
        null;


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


    await reactToGamePost(
        message,
        hunterResult,
        embedContext,
        openai
    );


    scheduleGame(
        buildScheduledGame(
            hunterResult,
            message,
            "channel-game-post"
        ),
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
        extractGameTitle(
            sourceText,
            url
        ) ||
        extractGameTitleFromUrl(
            url
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


    console.log(
        `[game-play] FreeStuff identified: ${hunterResult.title}` +
        (
            hunterResult.game_key
                ? ` (${hunterResult.game_key})`
                : ""
        )
    );


    scheduleGame(
        buildScheduledGame(
            hunterResult,
            message,
            "freestuff"
        ),
        client
    );


    return true;
}


module.exports = {
    handleKnownGameUrl,
    handleFreeStuffMessage,
};
