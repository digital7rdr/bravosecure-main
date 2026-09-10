/**
 * Regression — B-123 (real root cause): camera flip installed a DISABLED track.
 *
 * mediasoup latches a producer's paused state from the track at construction:
 *     this._paused = disableTrackOnPause ? !track.enabled : false;
 * GC-06 blanks the track (enabled = false) across produce() so no frame escapes
 * before the FrameCryptor attaches — so every producer is born "paused".
 * withTrackBlanked re-enables the track afterwards, so the call looks healthy
 * and the wrong flag stays invisible...
 *
 * ...until replaceTrack re-applies it:
 *     if (this._paused) { this._track.enabled = false; }
 * A camera flip then installs a fresh track and immediately disables it.
 *
 * Device evidence (iPhone trace, 2026-07-19):
 *     switchCamera swapped to=environment newTrack=live/enabled=false
 * with the Android peer reporting dec:0/rx:0/B:0.
 *
 * This models the mediasoup semantics and pins the repair. It deliberately does
 * NOT assert that blanking stops — GC-06 is a security control (no plaintext
 * video window); only the stale flag is corrected.
 */

type Track = {enabled: boolean; readyState: 'live' | 'ended'};

/** Faithful subset of mediasoup-client Producer for the paused/track semantics. */
class FakeProducer {
  _paused: boolean;
  _track: Track;
  readonly _disableTrackOnPause = true;

  constructor(track: Track) {
    // Producer.js:46
    this._paused = this._disableTrackOnPause ? !track.enabled : false;
    this._track = track;
  }

  resume() {
    // Producer.js resume()
    this._paused = false;
    if (this._track && this._disableTrackOnPause) {this._track.enabled = true;}
  }

  replaceTrack({track}: {track: Track}) {
    // Producer.js replaceTrack() — re-applies the latched paused state.
    this._track = track;
    if (this._track && this._disableTrackOnPause) {
      this._track.enabled = !this._paused;
    }
  }
}

/** Mirrors useGroupCall.withTrackBlanked (GC-06). */
async function withTrackBlanked<T>(track: Track, fn: () => Promise<T>): Promise<T> {
  const wasEnabled = track.enabled;
  if (wasEnabled) {track.enabled = false;}
  try { return await fn(); }
  finally { if (wasEnabled) {track.enabled = true;} }
}

/** Mirrors useGroupCall.clearBlankedPauseLatch. */
function clearBlankedPauseLatch(prod: {resume?: () => void} | null): void {
  try { prod?.resume?.(); } catch { /* best-effort */ }
}

async function produceBlanked(track: Track, repair: boolean) {
  let prod!: FakeProducer;
  await withTrackBlanked(track, async () => {
    prod = new FakeProducer(track);   // constructed while blanked
    return prod;
  });
  if (repair) {clearBlankedPauseLatch(prod);}
  return prod;
}

describe('B-123 — GC-06 blanking latches a false paused state', () => {
  it('reproduces the bug: without the repair, a flip installs a DISABLED track', async () => {
    const original: Track = {enabled: true, readyState: 'live'};
    const prod = await produceBlanked(original, /* repair */ false);

    // Call looks healthy — the finally re-enabled the original track.
    expect(original.enabled).toBe(true);
    // ...but mediasoup recorded the producer as paused.
    expect(prod._paused).toBe(true);

    const flipped: Track = {enabled: true, readyState: 'live'};
    prod.replaceTrack({track: flipped});
    expect(flipped.enabled).toBe(false);   // exactly the device symptom
  });

  it('with the repair, a flipped-in track stays ENABLED', async () => {
    const original: Track = {enabled: true, readyState: 'live'};
    const prod = await produceBlanked(original, /* repair */ true);

    expect(prod._paused).toBe(false);

    const flipped: Track = {enabled: true, readyState: 'live'};
    prod.replaceTrack({track: flipped});
    expect(flipped.enabled).toBe(true);
    expect(flipped.readyState).toBe('live');
  });

  it('repeated flips keep working (reflip was the reported symptom)', async () => {
    const original: Track = {enabled: true, readyState: 'live'};
    const prod = await produceBlanked(original, true);

    for (let i = 0; i < 4; i++) {
      const next: Track = {enabled: true, readyState: 'live'};
      prod.replaceTrack({track: next});
      expect(next.enabled).toBe(true);
    }
  });

  it('GC-06 still blanks across the produce window (security control intact)', async () => {
    const track: Track = {enabled: true, readyState: 'live'};
    let enabledDuringProduce = true;
    await withTrackBlanked(track, async () => {
      enabledDuringProduce = track.enabled;
      return null;
    });
    // No frame can leave before the cryptor attaches...
    expect(enabledDuringProduce).toBe(false);
    // ...and the track is restored afterwards.
    expect(track.enabled).toBe(true);
  });

  it('the repair is a no-op on a producer that lacks resume()', () => {
    expect(() => clearBlankedPauseLatch({} as never)).not.toThrow();
    expect(() => clearBlankedPauseLatch(null)).not.toThrow();
  });
});
