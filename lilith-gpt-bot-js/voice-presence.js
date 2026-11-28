'use strict';

// Presence only: no receiver subscriptions, audio player, microphone, or speech.
function createVoicePresence({ loadVoice = () => require('@discordjs/voice'), now = Date.now,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
    let current = null;
    function leave() {
        const previous = current;
        current = null;
        if (previous) {
            if (previous.timer) cancel(previous.timer);
            if (!previous.destroyed) { previous.destroyed = true; previous.connection.destroy(); }
        }
    }
    return {
        leave,
        status() {
            if (current && now() >= current.expiresAt) leave();
            return current ? { joined: current.ready, channel_id: current.channelId,
                expires_at: new Date(current.expiresAt).toISOString(), muted: true, deafened: true }
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
                ready: false, timer: null, destroyed: false };
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

module.exports = { createVoicePresence };
