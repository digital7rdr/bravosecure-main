/**
 * Bravo-shipped call tones.
 *
 * Why we don't use InCallManager.startRingtone/Ringback('_DEFAULT_'):
 * the library resolves '_DEFAULT_' to `Settings.System.DEFAULT_RINGTONE_URI`
 * and reads it via `MediaPlayer.setDataSource(ContentResolver, uri)`.
 * On Android 14 + some OEM Pixels (incl. our test Pixel 6a) the
 * default URI's content provider answers the openTypedAssetFile call
 * with FileNotFoundException. The library swallows this silently and
 * the user hears nothing while a call is ringing — observed in logcat:
 *
 *   W MediaPlayer: Error setting data source via ContentResolver
 *   W MediaPlayer: java.io.FileNotFoundException: open failed: ENOENT
 *     at com.zxcpoiu.incallmanager.InCallManagerModule$myMediaPlayer.startPlay
 *
 * Fix: ship our own WAV assets (assets/ringback.wav for outgoing,
 * assets/ringtone.wav for incoming) and play them via expo-av's
 * `Audio.Sound`. This sidesteps both the broken URI resolver AND the
 * audio-stream confusion (InCallManager routes ringtones via
 * MODE_IN_COMMUNICATION which on some BT stacks defaults to a
 * whispered earpiece volume).
 *
 * expo-av is already a dep (used by VoiceNoteRecorder). On iOS the
 * same path works — Audio.Sound respects Audio.setAudioModeAsync's
 * `playsInSilentModeIOS` so the tone plays even with the ringer
 * switch off, matching the Telephony app behaviour.
 */
import {Audio, InterruptionModeIOS} from 'expo-av';

/**
 * Fix #13: replace the dual-boolean (`ringback` + `ringbackBusy`)
 * pair with an explicit state machine. Two booleans encode FOUR
 * states (00, 01, 10, 11) but only THREE are legal — the fourth
 * (`ringback != null && ringbackBusy === true`, "loaded but mid-
 * load") is unreachable in normal flow but easy to drift into
 * under rapid start/stop racing (user mashes accept-then-decline,
 * or a network glitch fires both `call.answer` and `call.hangup`
 * inside one frame). The state machine makes every transition
 * explicit and rejects illegal ones.
 */
type ToneState = 'idle' | 'starting' | 'started' | 'stopping';

interface ToneSlot {
  state: ToneState;
  sound: Audio.Sound | null;
  /**
   * B-480 — a start that arrived while this slot was tearing down, queued to
   * run once it reaches 'idle'.
   *
   * React runs an effect's cleanup BEFORE its re-run, so a screen that re-keys
   * its ring effect calls `stopRingtone()` and `startRingtone()` in ONE tick —
   * and `stopSlot` sets 'stopping' synchronously, before its first await. The
   * start therefore hit the "not idle" guard and was simply dropped: a second
   * incoming ring re-using a mounted screen vibrated in silence.
   *
   * A thunk rather than the six start parameters, so the queue costs one field.
   */
  pendingStart: (() => Promise<void>) | null;
}

const ringbackSlot: ToneSlot = {state: 'idle', sound: null, pendingStart: null};
const ringtoneSlot: ToneSlot = {state: 'idle', sound: null, pendingStart: null};

/**
 * Run a queued start, if one is waiting. Must only be called once the slot is
 * back at 'idle', or the replay hits the same guard that queued it.
 */
async function drainPendingStart(slot: ToneSlot): Promise<void> {
  const queued = slot.pendingStart;
  if (!queued) {return;}
  slot.pendingStart = null;
  await queued();
}

const RINGBACK_ASSET = require('../../../../assets/ringback.wav');
const RINGTONE_ASSET = require('../../../../assets/ringtone.wav');

async function startSlot(
  slot: ToneSlot,
  asset: number,
  volume: number,
  label: string,
  throughEarpiece: boolean,
  keepRecordingSessionIOS: boolean,
): Promise<void> {
  // Only 'idle' can transition to 'starting'. 'starting' or 'started' means a
  // previous call already covered us.
  if (slot.state === 'starting' || slot.state === 'started') {return;}
  // 'stopping' means we are mid-tear-down and starting now would race the
  // unload — so QUEUE rather than drop. Dropping is what made a re-keyed ring
  // effect silent (B-480): the cleanup's stop and the re-run's start land in
  // the same tick, and the stop wins the state.
  if (slot.state === 'stopping') {
    slot.pendingStart = () =>
      startSlot(slot, asset, volume, label, throughEarpiece, keepRecordingSessionIOS);
    return;
  }
  slot.state = 'starting';
  try {
    // Why: expo-av re-applies setSpeakerphoneOn(!playThroughEarpieceAndroid)
    // every time it touches the audio session (play, focus changes, unload),
    // clobbering InCallManager's in-call routing — the device ended on
    // loudspeaker while the UI said earpiece. Setting the mode to match the
    // call's desired route BEFORE playing means every re-apply lands on the
    // same route the call wants, so there is nothing to clobber.
    // BS-CALL-IOSCAT (iOS, UNVERIFIED — no Mac/device available in the session
    // that wrote this) — `allowsRecordingIOS` defaults to FALSE, and expo-av
    // maps that to the AVAudioSession category `playback`. For the RINGTONE
    // that is correct and deliberate: nothing has been captured yet (the audio
    // session and getUserMedia are both deferred until the user accepts), and
    // `playback` is what makes an incoming ring loud on the speaker.
    //
    // For the RINGBACK it is not. An outgoing call has ALREADY acquired the mic
    // (useCall acquires local media up front for `direction: 'outgoing'`), so
    // the session is in playAndRecord with a live capture on it — and dropping
    // it to `playback` mid-call tears that capture down. expo-av never restores
    // the category either, which is the same leak sqa.md already records for
    // voice notes ("AVAudioSession stays in playAndRecord — subsequent playback
    // routes quiet/earpiece until restart"), just in the other direction.
    //
    // So the ringback keeps the recording session shape and takes the session
    // outright (DoNotMix) instead of mixing under whatever else is playing.
    await Audio.setAudioModeAsync({
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: throughEarpiece,
      ...(keepRecordingSessionIOS
        ? {allowsRecordingIOS: true, staysActiveInBackground: true, interruptionModeIOS: InterruptionModeIOS.DoNotMix}
        : {}),
    });
    const {sound} = await Audio.Sound.createAsync(
      asset, {shouldPlay: true, isLooping: true, volume},
    );
    // Race guard: if `stop` was called while we were awaiting the
    // load, the slot is now 'stopping' (or 'idle' after a hard reset).
    // Don't claim ownership of the freshly-loaded sound — unload it.
    if (slot.state !== 'starting') {
      try { await sound.unloadAsync(); } catch { /* ignore */ }
      // B-484 — this used to return WITHOUT restoring 'idle'. `stopSlot`'s
      // 'starting' branch deliberately delegates the teardown here and returns
      // early, so nothing else ever wrote the state back: the slot sat in
      // 'stopping' FOREVER, every later start refused at the guard above and
      // every later stop refused at its own. The slots are module-scoped, so
      // that meant no ringtone and no ringback for the rest of the process.
      // Trigger is a cleanup landing inside this load window — two awaits of
      // real device latency.
      if (slot.state === 'stopping') {slot.state = 'idle';}
      await drainPendingStart(slot);
      return;
    }
    slot.sound = sound;
    slot.state = 'started';
    console.log(`[bravo.tones] ${label} started`);
  } catch (e) {
    slot.state = 'idle';
    console.warn(`[bravo.tones] ${label} failed:`, (e as Error).message);
    // The THIRD exit that returns the slot to 'idle', and it owes the queue the
    // same drain as the other two. A stop can land while this start is
    // awaiting (marking 'stopping' and delegating teardown here), a restart can
    // queue behind it, and THEN the original start can fail — leaving a queued
    // start that nothing would ever run. Same class as B-484: every path back
    // to a terminal state must release what the transitional state collected.
    await drainPendingStart(slot);
  }
}

async function stopSlot(slot: ToneSlot, label: string): Promise<void> {
  // A stop always cancels a queued restart. Otherwise sign-out
  // (`stopAllTones`) or a second cleanup would resurrect a tone the user has
  // already left behind — the login-screen bleed the sign-out sweep exists to
  // prevent.
  slot.pendingStart = null;
  // Idle → no-op. Starting → mark stopping; the in-flight `start`
  // sees the changed state on resolve and unloads itself. Started →
  // tear down now. Stopping → already in progress; skip.
  if (slot.state === 'idle') {return;}
  if (slot.state === 'stopping') {return;}
  if (slot.state === 'starting') {
    slot.state = 'stopping';
    return; // start handler will unload the sound when it resolves
  }
  // 'started'
  slot.state = 'stopping';
  const s = slot.sound;
  slot.sound = null;
  try { await s?.stopAsync(); } catch { /* ignore */ }
  try { await s?.unloadAsync(); } catch { /* ignore */ }
  slot.state = 'idle';
  console.log(`[bravo.tones] ${label} stopped`);
  // AFTER 'idle', or the replay hits the guard that queued it.
  await drainPendingStart(slot);
}

/**
 * Outgoing-call ringback. Plays a 440+480 Hz dual tone (1s on, 3s off
 * cycle). Looped until stopRingback().
 *
 * `throughEarpiece` — pass true for VOICE calls (the caller is holding
 * the phone to their ear, like the system dialer) and false for VIDEO
 * calls (phone held in front, speaker is correct).
 */
export async function startRingback(throughEarpiece = false): Promise<void> {
  // keepRecordingSessionIOS: the outgoing call already holds the mic — see the
  // BS-CALL-IOSCAT note in startSlot.
  await startSlot(ringbackSlot, RINGBACK_ASSET, 0.85, 'ringback', throughEarpiece, true);
}

export async function stopRingback(): Promise<void> {
  await stopSlot(ringbackSlot, 'ringback');
}

/**
 * Incoming-call ringtone. Plays an 800+1000 Hz alert pattern (0.4s on,
 * 0.2s off, repeat) which is louder + more attention-grabbing than the
 * default ringback. Looped until stopRingtone().
 */
export async function startRingtone(): Promise<void> {
  // Ringtone always through the loudspeaker — an incoming call must be
  // audible from across the room.
  // keepRecordingSessionIOS FALSE — nothing is captured while ringing, and the
  // `playback` category is what keeps the ring loud on the speaker.
  await startSlot(ringtoneSlot, RINGTONE_ASSET, 1.0, 'ringtone', false, false);
}

export async function stopRingtone(): Promise<void> {
  await stopSlot(ringtoneSlot, 'ringtone');
}

/**
 * Emergency stop everything — used on call.end / app-background to
 * avoid runaway tones if a normal stop missed for any reason.
 */
export async function stopAllTones(): Promise<void> {
  await Promise.all([stopRingback(), stopRingtone()]);
}
