const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createMediaPolicy, skipMediaReply, unsolicitedMediaContext } = require('../media-policy');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
test('cooldown applies per channel after a reply, not after silence', () => {
    let time = 0;
    const policy = createMediaPolicy({ now: () => time });
    assert.equal(policy.canReact('a'), true);
    policy.recordReply('a');
    assert.equal(policy.canReact('a'), false);
    assert.equal(policy.canReact('b'), true);
    time = 179999;
    assert.equal(policy.canReact('a'), false);
    time = 180000;
    assert.equal(policy.canReact('a'), true);
});
test('silence marker and empty output never become public replies', () => {
    for (const output of [null, '', '  ', '[NO_REACTION]', 'Oops [NO_REACTION]']) assert.equal(skipMediaReply(output), true);
    assert.equal(skipMediaReply('That cat has claimed the chair.'), false);
});
async function routeMedia({ direct = false, cooling = false, bot = false } = {}) {
    const pending = new Map();
    const prior = { cancelled: false, messageId: 'old' };
    pending.set('channel', prior);
    let waits = 0;
    const start = source.indexOf('const unsolicitedMedia =');
    const end = source.indexOf('/*', start);
    const result = await vm.runInNewContext(`(async () => { ${source.slice(start, end)} return 'continue'; })()`, {
        messageIsMedia: true, directInteraction: direct,
        message: { id: 'new', channelId: 'channel', author: { bot } },
        pendingMediaReactions: pending,
        mediaPolicy: { canReact: () => !cooling },
        randomBetween: () => 0, sleep: async () => { waits++; }, console: { log() {} },
    });
    return { result, waits, prior, pending };
}
test('ambient image during cooldown is skipped before typing/model and retires old reaction', async () => {
    const { result, waits, prior, pending } = await routeMedia({ cooling: true });
    assert.equal(result, undefined);
    assert.equal(waits, 0);
    assert.equal(prior.cancelled, true);
    assert.equal(pending.size, 0);
});
test('direct image bypasses ambient cooldown', async () => {
    const { result, waits } = await routeMedia({ direct: true, cooling: true });
    assert.equal(result, 'continue');
    assert.equal(waits, 0);
});
test('eligible ambient image keeps delayed supersession mechanism', async () => {
    const { result, waits, prior } = await routeMedia();
    assert.equal(result, 'continue');
    assert.equal(waits, 1);
    assert.equal(prior.cancelled, true);
});
test('abstention exits before the generic error reply', async () => {
    const start = source.indexOf('if (unsolicitedMedia && (skipMediaReply(responseMessage)');
    const end = source.indexOf('/*', start);
    const result = await vm.runInNewContext(`(async () => { ${source.slice(start, end)} throw Error('silence reached reply'); })()`, {
        unsolicitedMedia: true, skipMediaReply, responseMessage: '[NO_REACTION]',
        mediaPolicy: { canReact: () => true }, message: { id: 'image', channelId: 'channel' }, console: { log() {} },
    });
    assert.equal(result, undefined);
});
test('ambient prompt permits abstention while retaining tools and typing', () => {
    assert.match(unsolicitedMediaContext, /Silence is the default/);
    assert.match(source, /tools:\s+getToolDefinitions\(\)/);
    assert.match(source, /tool_choice:\s+"auto"/);
    assert.doesNotMatch(source, /if \(!unsolicitedMedia\) await message/);
    assert.match(source, /const sendTypingInterval =\s+setInterval/);
    assert.match(source, /if \(unsolicitedMedia\) mediaPolicy.recordReply/);
});
