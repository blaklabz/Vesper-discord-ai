'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createVoicePresence } = require('../voice-presence');

function fixture({ allowed = true, enter } = {}) {
    const connections=[], options=[], timers=[];
    const api={VoiceConnectionStatus:{Ready:'ready',Disconnected:'disconnected',Destroyed:'destroyed'},
        joinVoiceChannel: opts => {
            options.push(opts);
            const connection=new EventEmitter();connection.destroyed=false;
            connection.destroy=()=>{connection.destroyed=true;connection.emit('stateChange',{}, {status:'destroyed'});};
            connections.push(connection);return connection;
        }, entersState: enter || (async()=>{})};
    const controller=createVoicePresence({loadVoice:()=>api,now:()=>1000000,
        schedule:(fn,ms)=>{const timer={fn,ms,unref(){}};timers.push(timer);return timer;},cancel:timer=>{timer.canceled=true;}});
    const message={guild:{id:'guild',members:{me:{}},voiceAdapterCreator:{}},
        member:{voice:{channel:{id:'voice',type:2,permissionsFor:()=>({has:()=>allowed})}}}};
    return {controller,message,connections,options,timers};
}

test('presence joins own channel self-muted and self-deafened with a bounded expiry',async()=>{
    const f=fixture();const status=await f.controller.join(f.message,120);
    assert.equal(status.joined,true);
    assert.equal(f.options[0].channelId,'voice');assert.equal(f.options[0].guildId,'guild');
    assert.equal(f.options[0].selfMute,true);assert.equal(f.options[0].selfDeaf,true);
    assert.equal(f.timers[0].ms,120*60000);
    f.controller.leave();assert.equal(f.connections[0].destroyed,true);assert.equal(f.timers[0].canceled,true);
});
test('DMs, missing voice state, stages and missing permissions cannot initiate a join',async()=>{
    for(const change of [f=>{f.message.guild=null;},f=>{f.message.member.voice.channel=null;},
                         f=>{f.message.member.voice.channel.type=13;}]){
        const f=fixture();change(f);await assert.rejects(()=>f.controller.join(f.message));assert.equal(f.options.length,0);
    }
    const f=fixture({allowed:false});await assert.rejects(()=>f.controller.join(f.message),/permissions/);
    assert.equal(f.options.length,0);
});
test('readiness failure destroys the incomplete connection',async()=>{
    const f=fixture({enter:async()=>{throw new Error('cannot connect');}});
    await assert.rejects(()=>f.controller.join(f.message),/cannot connect/);
    assert.equal(f.connections[0].destroyed,true);assert.equal(f.controller.status().joined,false);
});
test('expiry and disconnected state clean up voice presence',async()=>{
    const f=fixture();await f.controller.join(f.message);
    f.timers[0].fn();assert.equal(f.controller.status().joined,false);
    await f.controller.join(f.message);
    f.connections[1].emit('stateChange',{}, {status:'disconnected'});
    assert.equal(f.controller.status().joined,false);assert.equal(f.connections[1].destroyed,true);
});
test('a stop while joining prevents a late connection from sticking around',async()=>{
    let finish;const ready=new Promise(resolve=>{finish=resolve;});
    const f=fixture({enter:()=>ready});const join=f.controller.join(f.message);
    f.controller.leave();finish();await assert.rejects(()=>join,/canceled/);
    assert.equal(f.connections[0].destroyed,true);assert.equal(f.controller.status().joined,false);
});
