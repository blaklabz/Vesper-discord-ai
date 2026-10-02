const {
    getDatetime,
} = require("./datetime");

const {
    createGameSession,
    listGameSessions,
    updateGameSession,
    deleteGameSession,
} = require("./gameSessions");

const tools = {
    get_datetime: {
        definition: {
            type: "function",
            function: {
                name: "get_datetime",
                description: "Get the current date and time. Use this when current time or date information is needed.",
                parameters: {
                    type: "object",
                    properties: {},
                    additionalProperties: false,
                },
            },
        },
        execute: async () => getDatetime(),
    },

    create_game_session: {
        definition: {
            type: "function",
            function: {
                name: "create_game_session",
                description: "Create a native Discord scheduled event for a gaming session. Resolve relative dates/times with get_datetime first. start_time MUST be ISO-8601 with an explicit timezone offset. Only claim success after this tool succeeds.",
                parameters: {
                    type: "object",
                    properties: {
                        name: { type: "string", description: "Short event name, usually the game plus Session, e.g. Valheim Session." },
                        start_time: { type: "string", description: "ISO-8601 start date/time with explicit timezone offset, e.g. 2026-10-04T16:00:00-04:00." },
                        duration_minutes: { type: "integer", minimum: 15, maximum: 1440, description: "Optional duration. Defaults to 180 minutes." },
                        location: { type: "string", description: "Optional Discord event location text. Defaults to Discord." },
                        description: { type: "string", description: "Optional short description." },
                    },
                    required: ["name", "start_time"],
                    additionalProperties: false,
                },
            },
        },
        execute: createGameSession,
    },

    list_game_sessions: {
        definition: {
            type: "function",
            function: {
                name: "list_game_sessions",
                description: "List native Discord scheduled events in the current server. Use this to identify an event ID before updating or deleting when the user refers to an event by name/date rather than ID.",
                parameters: {
                    type: "object",
                    properties: {
                        include_completed: { type: "boolean", description: "Include completed/cancelled events. Defaults to false." },
                    },
                    additionalProperties: false,
                },
            },
        },
        execute: listGameSessions,
    },

    update_game_session: {
        definition: {
            type: "function",
            function: {
                name: "update_game_session",
                description: "Update a native Discord scheduled gaming event. If the event ID is unknown, call list_game_sessions first. Do not guess when multiple events could match. start_time must include a timezone offset.",
                parameters: {
                    type: "object",
                    properties: {
                        event_id: { type: "string", description: "Discord scheduled event ID." },
                        name: { type: "string" },
                        start_time: { type: "string", description: "New ISO-8601 start date/time with explicit timezone offset." },
                        duration_minutes: { type: "integer", minimum: 15, maximum: 1440 },
                        location: { type: "string" },
                        description: { type: "string" },
                    },
                    required: ["event_id"],
                    additionalProperties: false,
                },
            },
        },
        execute: updateGameSession,
    },

    delete_game_session: {
        definition: {
            type: "function",
            function: {
                name: "delete_game_session",
                description: "Delete/cancel a native Discord scheduled gaming event. If the event ID is unknown, call list_game_sessions first. Never guess which event to delete when the request is ambiguous.",
                parameters: {
                    type: "object",
                    properties: {
                        event_id: { type: "string", description: "Discord scheduled event ID." },
                    },
                    required: ["event_id"],
                    additionalProperties: false,
                },
            },
        },
        execute: deleteGameSession,
    },
};

function getToolDefinitions() {
    return Object.values(tools).map((tool) => tool.definition);
}

async function executeTool(name, args = {}, context = {}) {
    const tool = tools[name];
    if (!tool) throw new Error(`Unknown tool: ${name}`);

    console.log(
        `[tools] dispatch ${name}:`,
        JSON.stringify({
            args,
            context: {
                guildId: context.guild?.id || null,
                guildName: context.guild?.name || null,
                channelId: context.channelId || null,
                requesterId: context.requesterId || null,
                requesterTag: context.requesterTag || null,
            },
        }, null, 2)
    );

    try {
        const result = await tool.execute(args, context);
        console.log(`[tools] dispatch success ${name}:`, JSON.stringify(result, null, 2));
        return result;
    } catch (error) {
        console.error(`[tools] dispatch failure ${name}:`, {
            message: error.message,
            name: error.name,
            code: error.code,
            status: error.status,
            rawError: error.rawError,
            stack: error.stack,
        });
        throw error;
    }
}

module.exports = {
    getToolDefinitions,
    executeTool,
};
