// Stable tool contract for the future shared lookup service. No network calls yet.
const definition = {
    type: 'function',
    function: {
        name: 'web_lookup',
        description: 'Request current web information or verify an uncertain factual claim. This is a placeholder: the backend is not configured yet and returns no sources. Never treat unavailable as a successful search.',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: 'A focused search query. Do not include secrets or unnecessary private conversation details.', minLength: 1, maxLength: 1000 } },
            required: ['query'],
            additionalProperties: false,
        },
    },
};
async function webLookup(args = {}) {
    if (typeof args.query !== 'string' || !args.query.trim() || args.query.length > 1000) {
        return { status: 'invalid_request', code: 'INVALID_QUERY', sources: [], message: 'Provide a nonempty query of at most 1000 characters.' };
    }
    return {
        status: 'unavailable',
        code: 'LOOKUP_NOT_CONFIGURED',
        sources: [],
        message: 'Live web lookup is not connected yet. No search was performed and no claim was verified. Explain that honestly in your own voice; a joke about the unfinished feature is welcome. You may ask for a headline or link excerpt to discuss, but cannot claim to read a URL without a working retrieval tool.',
    };
}
module.exports = { definition, webLookup };
