/**
 * NA-06 — mirrors the in-app ring effect in CallScreen.tsx /
 * IncomingGroupCallScreen.tsx against a fake `bindInAppRingOwnership`.
 *
 * LIMITATION: this file MIRRORS the effect body, it does NOT render either
 * screen — CallScreen cannot mount without the WebRTC / InCallManager native
 * surface (same precedent as callAudioRouteGuard.test.ts). The contract it
 * pins is: the in-app tone stays silent while the native device ringtone owns
 * the callId, takes over exactly once on hand-off, and always cleans up.
 */

type OwnCb = (owns: boolean) => void;

class FakeRing {
  private owner: string | null = null;
  private listeners = new Set<() => void>();

  bind(callId: string | undefined, onOwn: OwnCb): () => void {
    let owns: boolean | null = null;
    const apply = () => {
      const next = !(callId && this.owner === callId);
      if (next === owns) {return;}
      owns = next;
      onOwn(next);
    };
    apply();
    this.listeners.add(apply);
    return () => { this.listeners.delete(apply); };
  }

  nativeStart(callId: string): void {
    this.owner = callId;
    this.listeners.forEach(l => l());
  }

  nativeStop(): void {
    this.owner = null;
    this.listeners.forEach(l => l());
  }
}

interface Tones {
  start: jest.Mock;
  stop: jest.Mock;
  vibrate: jest.Mock;
  cancel: jest.Mock;
}

function makeTones(): Tones {
  return {start: jest.fn(), stop: jest.fn(), vibrate: jest.fn(), cancel: jest.fn()};
}

/** Mirror of the CallScreen ring effect (isRinging === true). */
function runRingEffect(ring: FakeRing, callId: string | undefined, t: Tones): () => void {
  const unbind = ring.bind(callId, owns => {
    if (owns) {
      t.start();
      t.vibrate();
    } else {
      t.stop();
      t.cancel();
    }
  });
  return () => {
    unbind();
    t.stop();
    t.cancel();
  };
}

describe('NA-06 in-app ring ownership (CallScreen mirror)', () => {
  it('foreground ring (no native ring): the in-app tone plays exactly once', () => {
    const ring = new FakeRing();
    const t = makeTones();
    runRingEffect(ring, 'c-1', t);
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.vibrate).toHaveBeenCalledTimes(1);
  });

  it('warm-background ring (native ring already owns the call): the in-app tone is silent', () => {
    const ring = new FakeRing();
    ring.nativeStart('c-1');
    const t = makeTones();
    runRingEffect(ring, 'c-1', t);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.vibrate).not.toHaveBeenCalled();
  });

  it('hands off exactly once when the native ring stops (no double start)', () => {
    const ring = new FakeRing();
    ring.nativeStart('c-1');
    const t = makeTones();
    runRingEffect(ring, 'c-1', t);

    ring.nativeStop();
    expect(t.start).toHaveBeenCalledTimes(1);

    ring.nativeStop();
    ring.nativeStop();
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it('reverse race: WS offer mounts the screen first, the native wake then silences it', () => {
    const ring = new FakeRing();
    const t = makeTones();
    runRingEffect(ring, 'c-1', t);
    expect(t.start).toHaveBeenCalledTimes(1);

    ring.nativeStart('c-1');
    expect(t.stop).toHaveBeenCalledTimes(1);
    expect(t.cancel).toHaveBeenCalledTimes(1);
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it('a native ring for a DIFFERENT call does not silence this one', () => {
    const ring = new FakeRing();
    ring.nativeStart('other');
    const t = makeTones();
    runRingEffect(ring, 'c-1', t);
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it('cleanup always stops the tone and cancels vibration, whoever owned the ring', () => {
    const ring = new FakeRing();
    const owned = makeTones();
    const cleanupOwned = runRingEffect(ring, 'c-1', owned);
    cleanupOwned();
    expect(owned.stop).toHaveBeenCalled();
    expect(owned.cancel).toHaveBeenCalled();

    ring.nativeStart('c-2');
    const yielded = makeTones();
    const cleanupYielded = runRingEffect(ring, 'c-2', yielded);
    cleanupYielded();
    expect(yielded.stop).toHaveBeenCalled();
    expect(yielded.cancel).toHaveBeenCalled();
  });

  it('cleanup unbinds: a later ownership flip cannot ring a dead mount', () => {
    const ring = new FakeRing();
    ring.nativeStart('c-1');
    const t = makeTones();
    const cleanup = runRingEffect(ring, 'c-1', t);
    cleanup();
    t.start.mockClear();
    ring.nativeStop();
    expect(t.start).not.toHaveBeenCalled();
  });
});
