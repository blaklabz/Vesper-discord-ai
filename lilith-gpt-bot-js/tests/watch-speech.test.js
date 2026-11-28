'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {createSynthesizer,createSpeechOutput,spokenText,MAX_PCM_BYTES}=require('../watch-speech');
const {pcm24MonoTo48Stereo,createVoicePresence}=require('../voice-presence');
function fixture(){let socket;class WS extends EventEmitter{constructor(){super();this.sent=[];socket=this;}send(s){this.sent.push(JSON.parse(s));}terminate(){this.ended=true;}}return {synth:createSynthesizer({apiKey:'fake',loadWebSocket:()=>WS}),get socket(){return socket;},event(e){socket.emit('message',Buffer.from(JSON.stringify(e)));}};}
test('speech requests text-only audio and validates transcript before playback',async()=>{
 const f=fixture(),p=f.synth('Hello there.');f.event({type:'session.created'});f.event({type:'session.updated'});
 assert.equal(f.socket.sent[0].session.audio.input.turn_detection,null);assert.equal(f.socket.sent[1].response.conversation,'none');
 assert.equal(f.socket.sent[1].response.input[0].content[0].type,'input_text');
 f.event({type:'response.output_audio.delta',delta:Buffer.alloc(20).toString('base64')});f.event({type:'response.output_audio_transcript.done',transcript:'Hello there!'});
 f.event({type:'response.done',response:{status:'completed'}});assert.equal((await p).length,20);assert.equal(f.socket.ended,true);
});
test('mismatched transcript, oversized audio and early closure reject speech',async()=>{
 for(const kind of ['transcript','oversize','close']){const f=fixture(),p=f.synth('Hello');
 if(kind==='close')f.socket.emit('close');else if(kind==='oversize')f.event({type:'response.output_audio.delta',delta:Buffer.alloc(MAX_PCM_BYTES+2).toString('base64')});
 else{f.event({type:'response.output_audio.delta',delta:'AAAAAA=='});f.event({type:'response.done',response:{status:'completed',output:[{content:[{transcript:'Added words'}]}]}});}
 await assert.rejects(p);assert.equal(f.socket.ended,true);}
});
test('abort closes synthesis socket',async()=>{const f=fixture(),c=new AbortController(),p=f.synth('Hello',{signal:c.signal});c.abort();await assert.rejects(p,/canceled/);assert.equal(f.socket.ended,true);});
test('speech sanitization and PCM stereo interpolation',()=>{
 assert.equal(spokenText('**Hey** <@123> https://example.com 😂'),'Hey');const pcm=Buffer.alloc(4);pcm.writeInt16LE(-1000,0);pcm.writeInt16LE(1000,2);
 const out=pcm24MonoTo48Stereo(pcm);assert.deepEqual(Array.from({length:8},(_,i)=>out.readInt16LE(i*2)),[-1000,-1000,0,0,1000,1000,1000,1000]);assert.throws(()=>pcm24MonoTo48Stereo(Buffer.alloc(3)));
});
test('no overlapping speech; stale and canceled synthesis never plays',async()=>{
 let resolve,played=0,signal;const speech=createSpeechOutput({voicePresence:{status:()=>({joined:true}),stopAudio(){},playPCM:async()=>{played++;return true;}},synthesize:(_t,o)=>{signal=o.signal;return new Promise(r=>resolve=r);}});
 let current=true;const p=speech.speak('Hello',{isCurrent:()=>current});assert.equal(await speech.speak('Overlap'),false);current=false;resolve(Buffer.alloc(4));assert.equal(await p,false);assert.equal(played,0);
 const q=speech.speak('Bye');speech.cancel();assert.equal(signal.aborted,true);resolve(Buffer.alloc(4));assert.equal(await q,false);
});
test('Speak permission required; voice remains deafened and playback cleans up',async()=>{
 const conn=new EventEmitter();conn.destroy=()=>{};let config,player,allowed=true,unsubscribed=false;
 conn.rejoin=o=>{config=o;return true;};conn.subscribe=()=>({unsubscribe(){unsubscribed=true;}});
 const api={VoiceConnectionStatus:{Ready:'ready',Disconnected:'disconnected',Destroyed:'destroyed'},entersState:async()=>{},joinVoiceChannel:()=>conn,NoSubscriberBehavior:{Stop:'stop'},AudioPlayerStatus:{Playing:'playing',Idle:'idle'},StreamType:{Raw:'raw'},createAudioPlayer(){player=new EventEmitter();player.stop=()=>{};player.play=()=>player.emit('stateChange',{}, {status:'playing'});return player;},createAudioResource:source=>({playStream:source})};
 const v=createVoicePresence({loadVoice:()=>api});await v.join({guild:{id:'g',members:{me:{}},voiceAdapterCreator:{}},member:{voice:{channel:{id:'v',type:2,permissionsFor:()=>({has:p=>p!=='Speak'||allowed})}}}});
 allowed=false;await assert.rejects(()=>v.setSpeech(true),/Speak/);allowed=true;await v.setSpeech(true);assert.deepEqual(config,{selfMute:false,selfDeaf:true});const p=v.playPCM(Buffer.alloc(10));v.stopAudio();assert.equal(await p,true);assert.equal(unsubscribed,true);v.leave();
});
const {createWatchController}=require('../watch-bridge');
test('admin selects voice, both or text; voice errors never fall back to general',async()=>{
 for(const mode of ['voice','both','text']){
  let time=1000000,joined=true,calls=0,spoken=0,canceled=0;const posts=[],replies=[];
  const voice={status:()=>({joined}),setSpeech:async()=>{},leave:()=>joined=false};
  const speech={status:()=>({configured:true}),cancel:()=>canceled++,speak:async(_s,{isCurrent})=>{assert.equal(isCurrent(),true);spoken++;return true;}};
  const c=createWatchController({token:'a'.repeat(64),adminIds:new Set(['admin']),now:()=>time,generalChannelId:'general',voicePresence:voice,speechOutput:speech,
   getChannel:async()=>({send:async p=>posts.push(p)}),openai:{chat:{completions:{create:async()=>{calls++;return {choices:[{message:{content:'Great jump.'}}]};}}}}});
  const msg=(content,id='admin')=>({content,channelId:'general',author:{id,bot:false},reply:async p=>replies.push(p),channel:{}});
  await c.handle(msg('!watch output voice','stranger'));assert.equal(posts.length,0);
  await c.handle(msg('!watch output '+mode));posts.length=0;await c.handle(msg('!watch auto 120'));time+=60000;
  const image=Buffer.from([255,216,255,1,255,217]).toString('base64');
  c.store.accept({session_id:'session-12345678',frame_id:'1'.padStart(32,'0'),captured_at:new Date(time).toISOString(),image_base64:image});await c.tick();
  assert.equal(calls,1);assert.equal(spoken,mode==='text'?0:1);assert.equal(posts.length,mode==='voice'?0:1);
  await c.handle(msg('!watch stop'));assert.equal(joined,false);assert.ok(canceled>0);
 }
});
test('voice-only failure does not post the comment in text',async()=>{
 let time=1000000;const posts=[];const c=createWatchController({token:'a'.repeat(64),adminIds:new Set(['admin']),now:()=>time,generalChannelId:'general',
 voicePresence:{status:()=>({joined:true}),setSpeech:async()=>{}},speechOutput:{status:()=>({configured:true}),cancel(){},speak:async()=>{throw new Error('test synthesis failure');}},
 getChannel:async()=>({send:async p=>posts.push(p)}),openai:{chat:{completions:{create:async()=>({choices:[{message:{content:'Great jump.'}}]})}}}});
 const msg=content=>({content,channelId:'general',author:{id:'admin',bot:false},reply:async()=>{}});
 await c.handle(msg('!watch output voice'));posts.length=0;await c.handle(msg('!watch auto 120'));time+=60000;
 c.store.accept({session_id:'session-12345678',frame_id:'1'.padStart(32,'0'),captured_at:new Date(time).toISOString(),image_base64:Buffer.from([255,216,255,1,255,217]).toString('base64')});
 await c.tick();assert.equal(posts.length,0);
});
