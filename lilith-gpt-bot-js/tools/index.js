const {
    getDatetime,
} = require(
    "./datetime"
);


const tools = {
    get_datetime: {
        definition: {
            type:
                "function",

            function: {
                name:
                    "get_datetime",

                description:
                    "Get the current date and time. Use this when current time or date information is needed.",

                parameters: {
                    type:
                        "object",

                    properties: {},

                    additionalProperties:
                        false,
                },
            },
        },

        execute:
            async () =>
                getDatetime(),
    },
};


function getToolDefinitions() {
    return Object.values(
        tools
    ).map(
        (tool) =>
            tool.definition
    );
}


async function executeTool(
    name,
    args = {}
) {
    const tool =
        tools[name];


    if (!tool) {
        throw new Error(
            `Unknown tool: ${name}`
        );
    }


    return tool.execute(
        args
    );
}


module.exports = {
    getToolDefinitions,
    executeTool,
};
