const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const lookup = require('../tools/webLookup');

test('lookup explicitly reports unavailable without claiming a search', async () => {
    const result = await lookup.webLookup({ query: 'latest Nvidia news' });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.code, 'LOOKUP_NOT_CONFIGURED');
    assert.deepEqual(result.sources, []);
    assert.match(result.message, /No search was performed/);
    assert.match(result.message, /joke/);
});
for (const args of [{}, { query: '' }, { query: '   ' }, { query: 4 }, { query: 'x'.repeat(1001) }]) {
    test(`invalid lookup query: ${JSON.stringify(args).slice(0, 50)}`, async () => {
        assert.equal((await lookup.webLookup(args)).status, 'invalid_request');
    });
}
test('tool registry advertises and dispatches the stub through its real entry points', async () => {
    const registrySource = fs.readFileSync(path.join(__dirname, '..', 'tools', 'index.js'), 'utf8');
    const module = { exports: {} };
    vm.runInNewContext(registrySource, {
        module,
        require: name => name === './webLookup' ? lookup : new Proxy({}, { get: () => async () => ({}) }),
        console: { log() {}, error() {} },
    });
    const definitions = module.exports.getToolDefinitions();
    assert.ok(definitions.some(tool => tool.function.name === 'web_lookup'));
    const result = await module.exports.executeTool('web_lookup', { query: 'latest news' });
    assert.equal(result.code, 'LOOKUP_NOT_CONFIGURED');
    assert.deepEqual(result.sources, []);
});
