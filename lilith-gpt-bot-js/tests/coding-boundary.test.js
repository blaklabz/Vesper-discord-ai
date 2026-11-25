const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isCodingRequest, codingBoundary, codingRefusal } = require('../coding-boundary');
for (const message of ['Vesper i need you to help me with some coding', 'write a Python script', 'review my code', 'explain this SQL query', 'fix my Terraform', 'debug this', 'help with this ```js\nx()\n```', 'give me a regex', 'refactor that']) {
    test(`declines coding: ${message}`, () => assert.equal(isCodingRequest(message), true));
}
for (const message of ['what is today’s weather?', 'look up Nvidia news', 'what do you think of GTA?', 'can I give you internet access?', 'start Windrose', 'I spent all day coding', 'what is your favorite game?']) {
    test(`allows ordinary conversation: ${message}`, () => assert.equal(isCodingRequest(message), false));
}
test('coding gate replies locally with no mentions and returns before model/tool loop', async () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    const start = source.indexOf('if (!message.author.bot && isCodingRequest(cleanedContent))');
    const end = source.indexOf('/*', start);
    assert.ok(start > 0 && source.indexOf('codingBoundary +') > 0);
    let reply;
    const context = { isCodingRequest, codingRefusal, cleanedContent: 'I need help coding', client: {}, wakeEngaged() {},
        message: { author: { bot: false }, reply: async value => { reply = value; } }, console: { log() {} } };
    const result = await vm.runInNewContext(`(async () => { ${source.slice(start, end)} throw Error('coding reached model'); })()`, context);
    assert.equal(result, undefined);
    assert.match(reply.content, /cod|IDE|debug/i);
    assert.equal(reply.allowedMentions.parse.length, 0);
});
test('prompt covers indirect requests, lookup bypass and code intake', () => {
    assert.match(codingBoundary, /Do not ask the user to paste code/);
    assert.match(codingBoundary, /Do not use web_lookup to bypass/);
    assert.match(codingBoundary, /pseudocode/);
});
