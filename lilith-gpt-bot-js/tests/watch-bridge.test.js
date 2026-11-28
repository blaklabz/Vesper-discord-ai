'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createStore, createServer, createWatchController, authorized, watchMessages } = require('../watch-bridge');
const token = 'a'.repeat(64);
const session = 'session-12345678';
const jpeg = Buffer.from([0xff,0xd8,0xff,0x01,0xff,0xd9]).toString('base64');
function frame(i = 1, now = 1000000, extra = {}) {
    return { session_id: session, frame_id: i.toString(16).padStart(32,'0'),
        captured_at: new Date(now).toISOString(), image_base64: jpeg, ...extra };
}
function message(content, replies = [], id = 'admin') {
    return { content, channelId: 'channel', author: { id, bot: false },
        channel: { sendTyping: async () => {} }, reply: async reply => { replies.push(reply); } };
}

test('authentication rejects missing/wrong/short tokens', () => {
    assert.equal(authorized('Bearer ' + token, token), true);
    for (const header of [undefined,'Bearer wrong','Basic '+token]) assert.equal(authorized(header,token),false);
    assert.equal(authorized('Bearer short','short'),false);
});
test('frames require explicit session, validate freshness and JPEG', () => {
    const s=createStore({now:()=>1000000});
    assert.equal(s.accept(frame()).status,409);
    s.start('channel','admin');
    assert.equal(s.accept(frame(1,900000)).status,422);
    assert.equal(s.accept(frame(1,1010000)).status,422);
    assert.equal(s.accept(frame(1,1000000,{image_base64:'bad'})).status,400);
    assert.equal(s.accept(frame()).status,200);
    assert.equal(s.frames('other').length,0);
    assert.equal(s.frames('channel').length,1);
});
test('deduplication, ordering, source changes and bounded buffer', () => {
    let time=1000000;
    const s=createStore({now:()=>time});s.start('channel','admin');
    assert.equal(s.accept(frame()).accepted,true);
    assert.equal(s.accept(frame()).duplicate,true);
    assert.equal(s.accept(frame(2,1000000,{session_id:'different-session'})).status,409);
    assert.equal(s.accept(frame(2,999999)).status,422);
    for(let i=2;i<=12;i++){time++;assert.equal(s.accept(frame(i,time)).accepted,true);}
    assert.equal(s.status().buffered_frames,6);
    assert.equal(s.frames('channel').length,3);
});
test('stop, capture errors, stale frames and expiry prevent use', () => {
    let time=1000000;
    const s=createStore({now:()=>time});s.start('channel','admin');s.accept(frame());
    s.sourceError({session_id:session,error:'Window missing'});
    assert.equal(s.frames('channel').length,0);
    time++;s.accept(frame(2,time));time+=31000;
    assert.equal(s.frames('channel').length,0);
    time+=600000;assert.equal(s.status().active,false);
    s.start('channel','admin');s.stop();assert.equal(s.status().active,false);
});
test('multimodal content contains sampled timestamps, bytes and no URLs to fetch', () => {
    const messages=watchMessages([frame()],'What is happening?','NO CODING');
    assert.match(messages[0].content,/no stream audio/i);
    assert.match(messages[0].content,/NO CODING/);
    assert.equal(messages[1].content.filter(p=>p.type==='image_url').length,1);
    assert.ok(messages[1].content.at(-1).image_url.url.startsWith('data:image/jpeg;base64,'));
});
test('disabled and non-admin commands cannot enable capture', async () => {
    let replies=[];
    const c=createWatchController({token,adminIds:new Set(['admin']),openai:{}});
    await c.handle(message('!watch start',replies,'stranger'));
    assert.equal(c.store.status().active,false);
    const disabled=createWatchController({token:'',adminIds:new Set(['admin']),openai:{}});
    await disabled.handle(message('!watch start',replies));
    assert.equal(disabled.store.status().active,false);
});
test('only explicit look invokes the model; stop clears frames', async () => {
    let calls=0;const replies=[];
    const openai={chat:{completions:{create:async()=>{calls++;return {choices:[{message:{content:'A game menu.'}}]};}}}};
    const c=createWatchController({token,adminIds:new Set(['admin']),openai,now:()=>1000000});
    await c.handle(message('!watch start',replies));c.store.accept(frame());
    await c.handle(message('!watch status',replies));assert.equal(calls,0);
    await c.handle(message('!watch look what is on screen?',replies));assert.equal(calls,1);
    assert.equal(replies.at(-1).content,'A game menu.');
    assert.deepEqual(replies.at(-1).allowedMentions.parse,[]);
    await c.handle(message('!watch stop',replies));assert.equal(c.store.frames('channel').length,0);
});
test('coding policy is retained on watch requests', async () => {
    let calls=0;
    const c=createWatchController({token,adminIds:new Set(['admin']),openai:{chat:{completions:{create:async()=>{calls++;}}}},
        isCodingRequest:()=>true,codingRefusal:()=> 'No coding',now:()=>1000000});
    const replies=[];await c.handle(message('!watch start',replies));c.store.accept(frame());
    await c.handle(message('!watch look fix this code',replies));
    assert.equal(calls,0);assert.equal(replies.at(-1).content,'No coding');
});
test('new human activity cancels an older model reply', async () => {
    let finish;
    const pending=new Promise(resolve=>{finish=resolve;});
    const c=createWatchController({token,adminIds:new Set(['admin']),now:()=>1000000,
        openai:{chat:{completions:{create:()=>pending}}}});
    const replies=[];await c.handle(message('!watch start',replies));c.store.accept(frame());
    const look=c.handle(message('!watch look',replies));
    await new Promise(resolve=>setImmediate(resolve));
    await c.handle(message('Actually, wait',replies));
    finish({choices:[{message:{content:'Must not post'}}]});await look;
    assert.equal(replies.some(r=>r.content==='Must not post'),false);
});
test('receiver HTTP endpoint requires token before accepting body', async t => {
    const s=createStore({now:()=>1000000});s.start('channel','admin');
    const server=createServer({store:s,token});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>server.close(resolve)));
    async function send(auth) {
        return new Promise((resolve,reject)=>{
            const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/watch/frame',method:'POST',
                headers:auth?{Authorization:'Bearer '+token}:{}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
            req.on('error',reject);req.end(JSON.stringify(frame()));
        });
    }
    assert.equal(await send(false),401);assert.equal(await send(true),200);
});
test('reply based on samples that became stale is discarded even with newer buffered images', async () => {
    let time=1000000, finish;
    const pending=new Promise(resolve=>{finish=resolve;});
    const c=createWatchController({token,adminIds:new Set(['admin']),now:()=>time,
        openai:{chat:{completions:{create:()=>pending}}}});
    const replies=[];await c.handle(message('!watch start',replies));c.store.accept(frame());
    const look=c.handle(message('!watch look',replies));
    await new Promise(resolve=>setImmediate(resolve));
    time+=31000;c.store.accept(frame(2,time));
    finish({choices:[{message:{content:'Stale description'}}]});await look;
    assert.equal(replies.some(r=>r.content==='Stale description'),false);
});

function automaticFixture(responses = ['A neat game moment.']) {
    const clock = {time:1000000};
    let calls = 0;
    const posts = [], controls = [];
    const channel = {sendTyping:async()=>{},send:async value=>{posts.push(value);}};
    const openai = {chat:{completions:{create:async payload=>{
        calls++;
        assert.match(payload.messages[0].content,/NO_COMMENT/);
        return {choices:[{message:{content:responses[Math.min(calls-1,responses.length-1)]}}]};
    }}}};
    const controller = createWatchController({token,adminIds:new Set(['admin']),openai,now:()=>clock.time,
        generalChannelId:'general',getChannel:async id=>{assert.equal(id,'general');return channel;}});
    function fresh(i, bytes=i) {
        const image = Buffer.from([0xff,0xd8,0xff,bytes,0xff,0xd9]).toString('base64');
        assert.equal(controller.store.accept(frame(i,clock.time,{image_base64:image})).status,200);
    }
    return {controller,clock,posts,controls,fresh,calls:()=>calls};
}

test('auto mode requires explicit admin enablement and targets configured general chat', async () => {
    const f=automaticFixture();
    await f.controller.tick();assert.equal(f.calls(),0);
    await f.controller.handle(message('!watch auto 120',f.controls,'stranger'));
    assert.equal(f.controller.store.status().active,false);
    await f.controller.handle(message('!watch auto 120',f.controls));
    assert.equal(f.controller.store.status().channel_id,'general');
    f.clock.time+=60000;f.fresh(1);await f.controller.tick();
    assert.equal(f.posts.length,1);
    assert.deepEqual(f.posts[0].allowedMentions.parse,[]);
});
test('auto mode can abstain and does not retry every scheduler tick', async () => {
    const f=automaticFixture(['[NO_COMMENT]']);
    await f.controller.handle(message('!watch auto 120',f.controls));
    f.clock.time+=60000;f.fresh(1);await f.controller.tick();await f.controller.tick();
    assert.equal(f.calls(),1);assert.equal(f.posts.length,0);
});
test('auto comments have five-minute spacing and skip unchanged screenshots', async () => {
    const f=automaticFixture(['First observation.','Second observation.']);
    await f.controller.handle(message('!watch auto 120',f.controls));
    f.clock.time+=60000;f.fresh(1);await f.controller.tick();
    f.clock.time+=180000;f.fresh(2);await f.controller.tick();assert.equal(f.calls(),1);
    f.clock.time+=120000;f.fresh(3,1);await f.controller.tick();assert.equal(f.calls(),1);
    f.clock.time+=180000;f.fresh(4);await f.controller.tick();assert.equal(f.calls(),2);
    assert.equal(f.posts.length,2);
});
test('human conversation pauses checks for a minute', async () => {
    const f=automaticFixture();
    await f.controller.handle(message('!watch auto 120',f.controls));
    f.clock.time+=60000;
    const human=message('Hey folks',f.controls);human.channelId='general';
    await f.controller.handle(human);f.fresh(1);await f.controller.tick();assert.equal(f.calls(),0);
    f.clock.time+=60000;f.fresh(2);await f.controller.tick();assert.equal(f.calls(),1);
});
test('automatic session expires and explicit off prevents future model calls', async () => {
    const f=automaticFixture();
    await f.controller.handle(message('!watch auto 120',f.controls));
    await f.controller.handle(message('!watch auto off',f.controls));
    f.clock.time+=60000;f.fresh(1);await f.controller.tick();assert.equal(f.calls(),0);
    await f.controller.handle(message('!watch auto 120',f.controls));
    f.clock.time+=120*60000;await f.controller.tick();assert.equal(f.controller.store.status().active,false);
});
test('duplicate commentary is suppressed even if the model repeats itself', async () => {
    const f=automaticFixture(['Same observation!','Same observation.']);
    await f.controller.handle(message('!watch auto 120',f.controls));
    f.clock.time+=60000;f.fresh(1);await f.controller.tick();
    f.clock.time+=5*60000;f.fresh(2);await f.controller.tick();
    assert.equal(f.calls(),2);assert.equal(f.posts.length,1);
});
test('auto stop during an in-flight model request prevents publication', async () => {
    let finish;
    const pending=new Promise(resolve=>{finish=resolve;});
    let time=1000000;const posts=[], controls=[];
    const c=createWatchController({token,adminIds:new Set(['admin']),now:()=>time,
        generalChannelId:'general',getChannel:async()=>({send:async value=>posts.push(value)}),
        openai:{chat:{completions:{create:()=>pending}}}});
    await c.handle(message('!watch auto 120',controls));time+=60000;c.store.accept(frame(1,time));
    const task=c.tick();await new Promise(resolve=>setImmediate(resolve));
    await c.handle(message('!watch auto off',controls));
    finish({choices:[{message:{content:'Should be canceled'}}]});await task;
    assert.equal(posts.length,0);
});

test('watch join is admin-only and stop also disconnects voice',async()=>{
    let joins=0,leaves=0;const replies=[];
    const voicePresence={join:async()=>{joins++;return {channel_id:'voice'};},leave:()=>{leaves++;},status:()=>({joined:false})};
    const c=createWatchController({token,adminIds:new Set(['admin']),openai:{},voicePresence});
    await c.handle(message('!watch join 120',replies,'stranger'));assert.equal(joins,0);
    await c.handle(message('!watch join 120',replies));assert.equal(joins,1);
    await c.handle(message('!watch stop',replies));assert.equal(leaves,1);
    assert.match(replies.at(-1).content,/disconnected/);
});
