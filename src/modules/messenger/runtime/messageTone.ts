/**
 * B-692 S-3 — the in-app message receive tone (WhatsApp-parity audio cue).
 *
 * Deliberately NOT a bravoTones slot: those are looping call tones with a
 * start/stop state machine (B-480/B-484) whose slots must survive stop→start
 * races. A receive blip is fire-and-forget — it never loops, never needs a
 * stop, and must never be able to wedge a call-tone slot. It gets its own
 * one-shot player instead.
 *
 * Why no Audio.setAudioModeAsync here: expo-av re-applies speakerphone routing
 * on every audio-session touch (see bravoTones' clobber note). A blip must
 * never re-route live call audio — so instead of pinning a mode, the tone is
 * simply SKIPPED while any 1:1 or group call is live.
 */
import {Audio} from 'expo-av';

const MESSAGE_TONE_ASSET = require('../../../../assets/message.wav');

// Product kill switch. DEFAULT OFF — founder decision 2026-08-29 (B-698
// session): "sound per message … I don't want that." The tone machinery
// stays for a future in-app-sounds SETTING; flipping this back on without
// that setting re-ships the vetoed behaviour.
let soundsEnabled = false;

/** Is the in-app message sound layer enabled? (Default: OFF, founder veto.) */
export function inAppMessageSoundsEnabled(): boolean {
  return soundsEnabled;
}

/** Test hook — the throttle/guard suite needs the layer audible to exercise. */
export function _setInAppMessageSoundsForTest(v: boolean): void {
  soundsEnabled = v;
}

/** A burst of arrivals plays ONE blip, not a stack of them. */
export const TONE_MIN_GAP_MS = 400;

export type MessageToneKind = 'banner' | 'inChat';

let lastPlayAt = 0;
let inFlight = false;

function callIsLive(): boolean {
  try {
    const {getActiveCall} = require('./callRegistry') as typeof import('./callRegistry');
    if (getActiveCall()) {return true;}
  } catch { /* registry unavailable — treat as no call */ }
  try {
    const {getActiveGroupCall} = require('./groupCallRegistry') as typeof import('./groupCallRegistry');
    if (getActiveGroupCall()) {return true;}
  } catch { /* registry unavailable — treat as no call */ }
  return false;
}

/**
 * Play the receive blip. Returns whether a play was actually started —
 * false when disabled, throttled, mid-play, or a call is live.
 * `now` injectable so the throttle is testable without fake timers.
 */
export async function playMessageTone(
  kind: MessageToneKind,
  now: number = Date.now(),
): Promise<boolean> {
  if (!soundsEnabled) {return false;}
  if (inFlight || now - lastPlayAt < TONE_MIN_GAP_MS) {return false;}
  if (callIsLive()) {return false;}
  inFlight = true;
  lastPlayAt = now;
  try {
    const {sound} = await Audio.Sound.createAsync(
      MESSAGE_TONE_ASSET,
      {shouldPlay: true, isLooping: false, volume: kind === 'banner' ? 0.7 : 0.4},
    );
    let unloaded = false;
    const unload = () => {
      if (unloaded) {return;}
      unloaded = true;
      void sound.unloadAsync().catch(() => undefined);
    };
    sound.setOnPlaybackStatusUpdate(st => {
      if (!st.isLoaded || st.didJustFinish) {unload();}
    });
    // Why: a status update is not guaranteed on every platform path — the
    // timer backstop keeps a missed didJustFinish from leaking the player.
    setTimeout(unload, 3000);
    return true;
  } catch {
    return false;
  } finally {
    inFlight = false;
  }
}

/** Test-only: reset the throttle so cases don't order-couple. */
export function _resetMessageToneForTest(): void {
  lastPlayAt = 0;
  inFlight = false;
  soundsEnabled = false; // back to the shipped default
}
