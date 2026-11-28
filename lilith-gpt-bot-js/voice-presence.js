'use strict';

const { Readable } = require('node:stream');

// Realtime speech arrives as 24 kHz signed little-endian mono PCM.
// Discord raw resources expect 48 kHz stereo PCM; interpolate without an FFmpeg process.
function pcm24MonoTo48Stereo(input) {
    if (!Buffer.isBuffer(input) || input.length < 2 || input.length % 2 || input.length > 24000 * 2 * 20)
        throw new Error('Invalid or oversized speech PCM.');
    const output = Buffer.alloc(input.length * 4);
    for (let i = 0; i < input.length / 2; i++) {
        const sample = input.readInt16LE(i * 2);
        const next = i + 1 < input.length / 2 ? input.readInt16LE((i + 1) * 2) : sample;
        const half = Math.round((sample + next) / 2);
        output.writeInt16LE(sample, i * 8); output.writeInt16LE(sample, i * 8 + 2);
        output.writeInt16LE(half, i * 8 + 4); output.writeInt16LE(half, i * 8 + 6);
    }
    return output;
}

// Output-only audio: the connection always stays self-deafened; no receiver subscriptions.
function createVoicePresence({ loadVoice = () => require('@discordjs/voice'), now = Date.now,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    let current = null;
    function stopAudio() { current?.playback?.finish(); }
    function leave() {
        const previous = current;
        stopAudio();
        current = null;
        if (previous) {
            if (previous.timer) cancel(previous.timer);
            if (!previous.destroyed) { previous.destroyed = true; previous.connection.destroy(); }
        }
    }
    return {
        leave,
        stopAudio,
        async setSpeech(enabled) {
            if (!current?.ready) throw new Error('Join a voice channel first.');
            const record = current;
            if (enabled && !record.channel.permissionsFor(record.botMember)?.has('Speak'))
                throw new Error('Vesper needs Speak permission in this voice channel.');
            stopAudio();
            if (record.speechEnabled === enabled) return;
            record.ready = false;
            const voice = loadVoice();
            try {
                if (!record.connection.rejoin({ selfMute: !enabled, selfDeaf: true }))
                    throw new Error('Voice configuration update failed.');
                await voice.entersState(record.connection, voice.VoiceConnectionStatus.Ready, 15000);
                if (current !== record) throw new Error('Voice configuration update was canceled.');
                record.speechEnabled = enabled;
                record.ready = true;
            } catch (error) { if (current === record) leave(); throw error; }
        },
        async playPCM(pcm, { isCurrent = () => true, signal } = {}) {
            if (!current?.ready || !current.speechEnabled || current.playback)
                throw new Error('Voice speech output is unavailable or already playing.');
            if (signal?.aborted || !isCurrent()) return false;
            const record = current;
            const voice = loadVoice();
            const source = Readable.from([pcm24MonoTo48Stereo(pcm)]);
            return new Promise((resolve, reject) => {
                let player, resource, subscription, timeout, guard, done = false, started = false;
                const abort = () => finish();
                function finish(error) {
                    if (done) return;
                    done = true;
                    clearTimeout(timeout); clearInterval(guard);
                    signal?.removeEventListener('abort', abort);
                    subscription?.unsubscribe();
                    player?.stop(true);
                    resource?.playStream?.destroy(); source.destroy();
                    if (record.playback?.finish === finish) record.playback = null;
                    error ? reject(error) : resolve(started);
                }
                record.playback = { finish };
                try {
                    player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Stop } });
                    player.on('error', error => finish(error));
                    player.on('stateChange', (_old, state) => {
                        if (state.status === voice.AudioPlayerStatus.Playing) started = true;
                        if (state.status === voice.AudioPlayerStatus.Idle) finish();
                    });
                    resource = voice.createAudioResource(source, { inputType: voice.StreamType.Raw });
                    subscription = record.connection.subscribe(player);
                    if (!subscription) throw new Error('Could not subscribe speech player to voice.');
                    signal?.addEventListener('abort', abort, { once: true });
                    guard = setInterval(() => { if (!isCurrent() || current !== record) finish(); }, 250);
                    guard.unref?.();
                    timeout = setTimeout(() => finish(new Error('Speech playback exceeded its time limit.')), 22000);
                    timeout.unref?.();
                    player.play(resource);
                } catch (error) { finish(error); }
            });
        },
        status() {
            if (current && now() >= current.expiresAt) leave();
            return current ? { joined: current.ready, channel_id: current.channelId,
                expires_at: new Date(current.expiresAt).toISOString(), muted: !current.speechEnabled, deafened: true, speaking: Boolean(current.playback) }
                : { joined: false };
        },
        async join(message, minutes = 120) {
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)
                throw new Error('Voice duration must be 1–240 minutes.');
            if (!message.guild || !message.member?.voice?.channel)
                throw new Error('Join a server voice channel yourself, then send !watch join in that server.');
            const channel = message.member.voice.channel;
            if (channel.type !== 2) throw new Error('Use a regular server voice channel for presence mode.');
            const permissions = channel.permissionsFor(message.guild.members.me);
            if (!permissions?.has('ViewChannel') || !permissions.has('Connect'))
                throw new Error('Vesper needs View Channel and Connect permissions in your voice channel.');
            const voice = loadVoice();
            leave();
            const connection = voice.joinVoiceChannel({ channelId: channel.id, guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator, selfMute: true, selfDeaf: true });
            const record = { connection, channelId: channel.id, expiresAt: now() + minutes * 60000,
                ready: false, timer: null, destroyed: false, channel, botMember: message.guild.members.me, speechEnabled: false, playback: null };
            current = record;
            connection.on('error', error => console.error('[ghostframe] Voice connection:', error.message));
            connection.on('stateChange', (_old, next) => {
                if (current !== record) return;
                if ([voice.VoiceConnectionStatus.Destroyed, voice.VoiceConnectionStatus.Disconnected].includes(next.status)) leave();
            });
            try {
                await voice.entersState(connection, voice.VoiceConnectionStatus.Ready, 15000);
                if (current !== record) throw new Error('Voice join was canceled.');
                record.ready = true;
                record.timer = schedule(() => { if (current === record) leave(); }, Math.max(0, record.expiresAt - now()));
                record.timer.unref?.();
                return this.status();
            } catch (error) {
                if (current === record) leave();
                if (error.code === 'ABORT_ERR') throw new Error('Voice connection timed out; check channel permissions and LXC network access.');
                throw error;
            }
        },
    };
}

module.exports = { createVoicePresence, pcm24MonoTo48Stereo };
