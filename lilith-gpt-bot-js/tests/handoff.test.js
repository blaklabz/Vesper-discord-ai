const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const { requestsSableHandoff } = require('../handoff-routing');
const { isCodingRequest, codingRefusal } = require('../coding-boundary');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('const eligibleForHelp =');
const end = source.indexOf('/*', source.indexOf('handoff=false api-call=false', start));
assert.ok(start > 0 && end > start, 'help routing block must be present');
const routing = source.slice(start, end);

async function runRoute({ dm = false, status = 'online', question = 'ask Sable to explain this' } = {}) {
    const calls = { classify: 0, presence: 0, replies: [] };
    const context = {
        isCodingRequest, codingRefusal, requestsSableHandoff, isDirectMessage: dm, explicitBothRequest: false, messageIsMedia: false, postedUrl: null,
        cleanedContent: question, SABLE_USER_ID: 'sable-id',
        message: { author: { bot: false, username: 'Toby' }, guild: dm ? null : {},
            channel: { sendTyping: async () => {} }, reply: async value => calls.replies.push(value) },
        classifyHelpRequest: async () => { calls.classify++; return { route: 'SABLE', source: 'test' }; },
        sableAvailability: async guild => { assert.ok(guild); calls.presence++; return status; },
        wakeEngaged: () => {}, client: {},
        generateSableHandoff: async () => 'Some question! <@sable-id>, your thoughts?',
        lazyRedirect: state => `redirect:${state}`, console: { log() {}, error() {} },
        setInterval, clearInterval,
    };
    const result = await vm.runInNewContext(`(async () => { ${routing}\nreturn 'conversation'; })()`, context);
    return { result, calls };
}

for (const question of [
    'do you know about him having to step down',
    'vesper can i give you access to look stuff up when you do not know?',
    'can you explain this to me?',
]) {
    test(`DM stays conversational without presence or handoff: ${question}`, async () => {
        const { result, calls } = await runRoute({ dm: true, question });
        assert.equal(result, 'conversation');
        assert.equal(calls.classify, 0);
        assert.equal(calls.presence, 0);
        assert.equal(calls.replies.length, 0);
    });
}

test('server online handoff mentions only Sable and neutralizes user mentions', async () => {
    const { calls } = await runRoute({ question: 'ask Sable to explain this <@123> @everyone <@&456>' });
    assert.equal(calls.presence, 1);
    assert.equal(calls.replies.length, 1);
    const reply = calls.replies[0];
    assert.ok(reply.content.includes('<@sable-id>'));
    assert.ok(!/everyone|<@123>|<@&456>/.test(reply.content));
    assert.deepEqual(Array.from(reply.allowedMentions.users), ['sable-id']);
});

for (const status of ['idle', 'dnd', 'offline', 'unknown']) {
    test(`server ${status} does not summon Sable`, async () => {
        const { calls } = await runRoute({ status });
        assert.equal(calls.replies[0].content, `redirect:${status}`);
        assert.deepEqual(Array.from(calls.replies[0].allowedMentions.parse), []);
    });
}

test('DM prompt context skips presence lookup and does not claim a private handoff', async () => {
    const start = source.indexOf('const sableStatus = isDirectMessage');
    const end = source.indexOf('const liveGame =', start);
    assert.ok(start > 0 && end > start);
    const context = { isDirectMessage: true, explicitBothRequest: false,
        sableAvailability: () => { throw Error('DM must not look up server presence'); }, message: { guild: null } };
    const result = await vm.runInNewContext(`(async () => { ${source.slice(start, end)} return librarianContext; })()`, context);
    assert.match(result, /Sable cannot see this chat/);
    assert.match(result, /Do not mention\/ping Sable, forward private messages/);
    assert.match(result, /adding features/);
});

for (const question of ['explain this', 'look up Nvidia news', 'can i give you access to look stuff up?', 'what is a CPU?', "don't ask Sable", 'what do you think of Sable?']) {
    test(`ordinary server question stays with Vesper: ${question}`, async () => {
        const { result, calls } = await runRoute({ question });
        assert.equal(result, 'conversation');
        assert.equal(calls.presence, 0);
        assert.equal(calls.replies.length, 0);
    });
}
for (const question of ['ask Sable about Nvidia', 'can you get Sable to help?', 'hand this to Sable', 'bring Sable in']) {
    test(`explicit collaboration request: ${question}`, () => assert.equal(requestsSableHandoff(question), true));
}
test('explicit DM handoff stays private and conversational', async () => {
    const { result, calls } = await runRoute({ dm: true, question: 'ask Sable about Nvidia' });
    assert.equal(result, 'conversation');
    assert.equal(calls.replies.length, 0);
});
