# Ghostframe watch-along and voice presence

The existing Mac Lookout, bridge sender, shared secret, and SSH tunnel are unchanged.
Only configured `DISCORD_ADMIN_IDS` can start or stop watch modes. Nothing automatically resumes after a bot restart.

## Tonight's commands

Join the server voice channel yourself. In a text channel in that same server, send:

```text
!watch join 120
!watch auto 120
```

Vesper joins your current regular voice channel for up to two hours, **self-muted and self-deafened**.
She does not subscribe to voice audio, record, transcribe, or speak. Video still arrives through Lookout;
joining Discord voice does not provide bot access to the shared stream video.

Automatic comments go to the existing configured general text channel, regardless of which text channel
received the admin command. A new `!watch auto` replaces the current watch session and clears old frames;
the running Mac sender should supply fresh frames within its next polling interval.

- `!watch auto 120`: opt into automatic comments in general for two hours. Default duration is 120 minutes; allowed range 1–240.
- `!watch auto off`: disable automatic comments; leave the current manual watch session and voice presence available until their respective expirations.
- `!watch look [question]`: explicitly ask about fresh frames, as before. Use it in the active watch text channel.
- `!watch start`: replace the session with the original manual-only, ten-minute watch in the current text channel.
- `!watch status`: inspect watch expiration, automatic mode, and voice presence.
- `!watch leave`: leave voice while keeping the watch session/comments otherwise unchanged.
- `!watch stop`: disable automatic commentary, clear frames, end the watch session, and leave voice.

## Pacing and model usage

The first automatic check waits at least a minute. Subsequent checks are no more frequent than roughly
every three minutes, and comments are at least five minutes apart. Checks may produce no comment at all.
Human activity in general pauses checks for a minute and cancels an older in-flight watch reply.
Unchanged screenshots, stale frames, capture errors, and exact repeated comments are skipped.
The model is instructed to abstain on routine gameplay, idle screens, Discord-only UI, uncertain images,
and repeated observations. Recent watch comments are supplied to discourage repeating a joke.

Automatic checks use Vesper's configured image-capable model and incur its normal API usage even when
the result is silence. Under steady fresh input, the pacing permits at most about 20 automatic model checks
and 12 comments per hour; human activity, unchanged frames, and abstention generally reduce that.
These are sampled still frames with no audio. She must not claim to hear dialogue or follow unseen action.

## Deploy

Sync/commit/push the changed Vesper files, then pull on the LXC and install dependencies using the updated
package lock (`npm ci`) before restarting Vesper with its usual process manager. The receiver still needs
`GHOSTFRAME_BRIDGE_TOKEN`. No new token or Mac sender update is required for these modes.

Voice additionally needs the `GuildVoiceStates` gateway intent (included in the updated client) and
**View Channel + Connect** permissions in the voice channel. The admin issuing `join` must be in that
server's voice channel. Voice joins have a bounded readiness timeout and an explicit expiry. A failed
or disconnected voice connection is cleaned up rather than repeatedly reconnecting in the background.

The voice dependency is pinned to a release compatible with Vesper's Node 22 runtime. Optional native
voice-encryption dependencies must resolve for the LXC platform during `npm ci`; no Opus player or FFmpeg
pipeline is required for self-muted/self-deafened presence. Live voice joining and actual automatic posts
still need testing after deployment. Unit tests use fake Discord/model/voice clients and do not join a server.

## Normal conversation awareness

Ordinary chat receives live watch metadata in the active watch channel: enabled state, number of fresh
samples, latest capture timestamp, capture error, and automatic-comment mode. It does not receive image
pixels merely because someone chats. Metadata must not be used to invent a visual observation.

An explicitly addressed admin question such as "Vesper, are you aware of what you are watching right now?"
or "Vesper, what do you see on screen?" uses the same fresh-image path as `!watch look`. An authorized
admin can also ask in a DM about the current watch without moving the session out of general.
Other server channels do not gain access to that watch context. Missing, expired, or stale frames produce
an availability response. Bot messages and unaddressed conversation do not trigger this natural-question path.
Voice presence remains self-muted/self-deafened and does not supply audio or stream video.

## Optional spoken commentary

Default output remains text. After joining your ordinary Discord voice channel:

```
!watch join 120
!watch output voice
!watch voice-test
!watch auto 120
```

`!watch output both` sends automatic comments to general and voice; `!watch output text`
returns to text and self-mutes. Manual `!watch look` and natural visual questions still
answer in text. Controls remain admin-only. Enabling voice posts an AI-voice disclosure
in general. Vesper needs View Channel, Connect, and Speak permissions.

`!watch stop` cancels speech, clears frames, disconnects, and resets output to text.
`!watch leave` cancels speech and disconnects; voice-only commentary pauses until you
join again. Expiry/disconnection also prevents playback. Human text activity interrupts
speech; Vesper stays self-deafened and does not listen, record, or detect when people
are speaking. She can therefore speak over someone; use text mode if that is disruptive.

The existing LXC `OPENAI_KEY` funds speech requests. Optional LXC environment settings:

```
GHOSTFRAME_SPEECH_MODEL=gpt-realtime-2.1-mini
GHOSTFRAME_SPEECH_VOICE=marin
GHOSTFRAME_SPEECH_STYLE="NYC cabbie delivery: a feminine voice with a New York City accent, brisk conversational pacing, streetwise confidence, dry wit, and a little friendly impatience. Keep it natural and intelligible, without shouting. Read the supplied words exactly; do not add catchphrases or extra dialogue."
```

Restart Vesper after changing environment settings. Voice is provisional: audition with
`!watch voice-test`. Stock Realtime voices include marin, cedar, coral, sage, shimmer,
alloy, ash, ballad, echo, and verse. Delivery instructions influence rather than guarantee
an accent or timbre. No Mac bridge change is needed.

Speech uses a separate text-only Realtime request per comment, with no microphone
input or conversation history. It buffers at most 20 seconds of 24 kHz PCM in memory,
checks the returned transcript against the comment, resamples to Discord's 48 kHz
stereo, and uses opusscript for encoding without FFmpeg. One job at a time, no queue;
stop, new human text, or stale frames discard obsolete output. Comments are limited
to 400 characters for speech. Synthesis has a 25-second deadline. Reworded transcripts
(including some number pronunciations) are rejected rather than speaking extra words.
Voice-only errors do not fall back to general; inspect `!watch status` and service logs.
Speech adds OpenAI API usage. This feature does not enable voice conversation.
