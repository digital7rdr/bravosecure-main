/**
 * bravoTones must pin expo-av's Android audio mode BEFORE playing each
 * tone: expo-av re-applies setSpeakerphoneOn(!playThroughEarpieceAndroid)
 * on every audio-session touch (play / focus change / unload), which
 * clobbered InCallManager's in-call routing — the device sat on
 * loudspeaker while the call UI said earpiece. Voice ringback must run
 * through the earpiece; ringtone always through the speaker.
 */

const mockSetAudioModeAsync = jest.fn(async (..._args: unknown[]) => undefined);
const mockCreateAsync = jest.fn(async (..._args: unknown[]) => ({
  sound: {
    stopAsync: jest.fn(async () => undefined),
    unloadAsync: jest.fn(async () => undefined),
  },
}));

jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: (...a: unknown[]) => mockSetAudioModeAsync(...a),
    Sound: {createAsync: (...a: unknown[]) => mockCreateAsync(...a)},
  },
  // Mirrors expo-av's real enum. Keep it here: bravoTones reads
  // InterruptionModeIOS.DoNotMix, and a mock that omits it makes every ringback
  // assertion fail with "Number of calls: 0" — the throw happens while building
  // the argument, inside startSlot's own try/catch, so it looks like the tone
  // simply never started.
  InterruptionModeIOS: {MixWithOthers: 0, DoNotMix: 1, DuckOthers: 2},
}));

jest.mock('../../../../assets/ringback.wav', () => 1, {virtual: true});
jest.mock('../../../../assets/ringtone.wav', () => 2, {virtual: true});

import {startRingback, startRingtone, stopRingtone, stopAllTones} from '../runtime/bravoTones';

describe('bravoTones audio mode', () => {
  beforeEach(async () => {
    await stopAllTones();
    mockSetAudioModeAsync.mockClear();
    mockCreateAsync.mockClear();
  });

  it('voice ringback pins playThroughEarpieceAndroid=true before playing', async () => {
    await startRingback(true);
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: true}),
    );
    expect(mockSetAudioModeAsync.mock.invocationCallOrder[0]).toBeLessThan(
      mockCreateAsync.mock.invocationCallOrder[0],
    );
  });

  it('video ringback uses the speaker (playThroughEarpieceAndroid=false)', async () => {
    await startRingback(false);
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: false}),
    );
  });

  it('ringback defaults to speaker when no argument is given', async () => {
    await startRingback();
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: false}),
    );
  });

  it('ringtone always plays through the speaker', async () => {
    await startRingtone();
    expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({playThroughEarpieceAndroid: false}),
    );
  });

  // ── BS-CALL-IOSCAT ────────────────────────────────────────────────────
  // expo-av maps `allowsRecordingIOS: false` (its DEFAULT) to the
  // AVAudioSession category `playback`. An OUTGOING call has already acquired
  // the mic by the time the ringback plays, so taking the session to `playback`
  // tears that live capture down — and expo-av never restores the category.
  // The ringtone is the opposite case: nothing is captured while ringing, and
  // `playback` is what keeps an incoming ring loud on the speaker.
  describe('iOS audio-session category (BS-CALL-IOSCAT)', () => {
    it('ringback keeps the recording session so it cannot kill the live call capture', async () => {
      await startRingback(true);
      expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
        expect.objectContaining({allowsRecordingIOS: true}),
      );
    });

    it('ringback takes the session outright rather than mixing under other audio', async () => {
      await startRingback(true);
      expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
        expect.objectContaining({interruptionModeIOS: 1 /* DoNotMix */}),
      );
    });

    it('ringback stays active in the background so a locked screen does not mute it', async () => {
      await startRingback(false);
      expect(mockSetAudioModeAsync).toHaveBeenCalledWith(
        expect.objectContaining({staysActiveInBackground: true}),
      );
    });

    it('ringtone does NOT request the recording session — it must stay loud on the speaker', async () => {
      await startRingtone();
      const mode = mockSetAudioModeAsync.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
      expect(mode).toBeDefined();
      expect(mode).not.toHaveProperty('allowsRecordingIOS');
    });
  });
});

/**
 * B-480 / B-484 — the slot must survive a stop and a start landing in ONE tick.
 *
 * React runs an effect's cleanup BEFORE its re-run, so a screen that re-keys its
 * ring effect (a second incoming ring re-using the mounted instance, or
 * CallScreen's `[isRinging, callId]` on a call-waiting offer) calls
 * `stopRingtone()` and then `startRingtone()` synchronously. `stopSlot` sets
 * 'stopping' before its first await, so the start used to hit the "not idle"
 * guard and be dropped outright: ring #2 vibrated in silence.
 *
 * These run against the REAL module — `inAppRingOwnership.test.ts` substitutes a
 * naked `jest.fn()` for the tones, so it is structurally incapable of catching
 * this: its `start` mock always "succeeds" even when the real slot refuses.
 */
describe('bravoTones restart safety', () => {
  beforeEach(async () => {
    await stopAllTones();
    mockSetAudioModeAsync.mockClear();
    mockCreateAsync.mockClear();
  });

  it('B-480: a stop and a start in the SAME tick still ends up playing', async () => {
    await startRingtone();
    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
    mockCreateAsync.mockClear();

    // The re-key: cleanup then re-run, no await between them.
    const stopping = stopRingtone();
    const starting = startRingtone();
    await Promise.all([stopping, starting]);

    // The queued start must have actually loaded a second sound. Before the
    // fix this was 0 — the tone was silent for the whole of ring #2.
    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  });

  it('B-480: the slot is left usable afterwards', async () => {
    await startRingtone();
    const stopping = stopRingtone();
    const starting = startRingtone();
    await Promise.all([stopping, starting]);
    await stopAllTones();
    mockCreateAsync.mockClear();

    await startRingtone();
    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  });

  it('B-480: a stop CANCELS a queued restart rather than resurrecting it', async () => {
    // Sign-out (`stopAllTones`) must not be undone by a start that was queued
    // moments earlier — that is the login-screen tone bleed the sweep exists to
    // prevent.
    await startRingtone();
    mockCreateAsync.mockClear();

    const first  = stopRingtone();
    const queued = startRingtone();   // queued behind the stop
    const second = stopRingtone();    // …and cancelled by this one
    await Promise.all([first, queued, second]);

    expect(mockCreateAsync).not.toHaveBeenCalled();
  });

  it('B-484: a stop landing INSIDE the load window does not brick the slot', async () => {
    /**
     * `stopSlot`'s 'starting' branch marks 'stopping' and returns, delegating
     * teardown to the in-flight start. That start's race guard unloaded the
     * sound and returned WITHOUT restoring 'idle' — so the slot stayed
     * 'stopping' forever: every later start refused at its guard, every later
     * stop refused at its own, and the slots are module-scoped. No ringtone and
     * no ringback for the rest of the process.
     */
    let releaseLoad: (() => void) | null = null;
    mockCreateAsync.mockImplementationOnce(async () => {
      await new Promise<void>(r => { releaseLoad = r; });
      return {sound: {stopAsync: jest.fn(async () => undefined), unloadAsync: jest.fn(async () => undefined)}};
    });

    const starting = startRingtone();          // parks inside createAsync
    await Promise.resolve();
    await stopRingtone();                      // 'starting' -> 'stopping'
    releaseLoad!();                            // the load finally resolves
    await starting;

    // The slot must be usable again.
    mockCreateAsync.mockClear();
    await startRingtone();
    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  });

  it('B-484: a start QUEUED during the load window is still run', async () => {
    /**
     * The two fixes meet here, and this is the only path that exercises the
     * drain inside the load-race guard: `stopSlot`'s 'starting' branch marks
     * 'stopping' and returns BEFORE any await, so its tail drain never runs.
     * If the guard restores 'idle' without draining, a start queued in that
     * window is silently forgotten — the slot is healthy but the ring the user
     * is looking at never sounds.
     */
    let releaseLoad: (() => void) | null = null;
    mockCreateAsync.mockImplementationOnce(async () => {
      await new Promise<void>(r => { releaseLoad = r; });
      return {sound: {stopAsync: jest.fn(async () => undefined), unloadAsync: jest.fn(async () => undefined)}};
    });

    const starting = startRingtone();     // parks inside createAsync
    await Promise.resolve();
    await stopRingtone();                 // 'starting' -> 'stopping', returns early
    const queued = startRingtone();       // queued behind the stop
    mockCreateAsync.mockClear();
    releaseLoad!();                       // the first load finally resolves
    await Promise.all([starting, queued]);

    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  });
});

describe('bravoTones — every path back to idle drains the queue', () => {
  beforeEach(async () => {
    await stopAllTones();
    mockSetAudioModeAsync.mockClear();
    mockCreateAsync.mockClear();
  });

  it('a start queued behind a FAILING start is still run', async () => {
    /**
     * `startSlot` has three exits that return the slot to 'idle': the post-load
     * race guard, `stopSlot`'s tail, and the catch. The catch was the one this
     * suite missed on the first pass — found by self-diffing rather than by a
     * test, which is precisely why it is pinned now.
     *
     * Sequence: start A parks in the loader; a stop marks 'stopping' and
     * delegates teardown to A; a restart queues behind it; then A FAILS. If the
     * catch does not drain, the queued start is lost and the ring is silent.
     */
    let failLoad: ((e: Error) => void) | null = null;
    mockCreateAsync.mockImplementationOnce(async () => {
      await new Promise<void>((_res, rej) => { failLoad = rej as (e: Error) => void; });
      throw new Error('unreachable');
    });

    const starting = startRingtone();
    await Promise.resolve();
    await stopRingtone();               // 'starting' -> 'stopping'
    const queued = startRingtone();     // queued behind the stop
    mockCreateAsync.mockClear();
    failLoad!(new Error('audio session lost'));
    await Promise.all([starting, queued]);

    expect(mockCreateAsync).toHaveBeenCalledTimes(1);
  });
});
