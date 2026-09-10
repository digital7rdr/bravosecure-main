/**
 * B-236u — route picker DEAD for the first ~11 s of every call.
 *
 * Device evidence (realme Buds Wireless 3 connected, call #2 of the 3-repro
 * session):
 *
 *   18:24:13.532  RNInCallManager.chooseAudioRoute(): user choose SPEAKER_PHONE
 *   18:24:13.5xx  E InCallManager: selectAudioDevice() Can not select SPEAKER_PHONE from available []
 *   (repeats for EARPIECE / SPEAKER at :13.9, :16.6, :19.3 — every tap dropped)
 *   18:24:24.489  device list finally populates
 *
 * The native route manager starts with an EMPTY device list and
 * `selectAudioDevice` neither queues nor retries, so every explicit pick in
 * that window vanishes. The fix is queue-and-apply: a pick that cannot land
 * yet is REMEMBERED as the user's explicit preference and applied on the
 * first device-list event that can honour it —
 *
 *  - a list that CONTAINS the picked route, for headset routes
 *    (BLUETOOTH / WIRED_HEADSET, which may genuinely be absent), or
 *  - the first NON-EMPTY list, for the built-in routes
 *    (SPEAKER_PHONE / EARPIECE — the enumerator is alive, so the pick lands).
 *
 * The queued pick must survive until applied or call end, be superseded by a
 * newer explicit pick, never override a route the user set successfully
 * afterwards, and be cleared on teardown. And it extends the existing
 * sticky-explicit-pick rule: an explicit pick beats the B-309 opening settle
 * (callers cancel the settle on pick), it does not fork a second rule.
 */
import {createOpeningRouteSettle, createRoutePickQueue} from '../runtime/callAudioRoute';

describe('B-236u — a pick against an empty device list is queued, not dropped', () => {
  it('THE BUG: pick while the list is empty → applied when the list arrives', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    // The dead window: no device-list event has fired yet.
    expect(q.pick('SPEAKER_PHONE')).toBe(false);
    expect(apply).not.toHaveBeenCalled();
    // 18:24:24.489 — the list populates.
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('SPEAKER_PHONE');
  });

  it('a built-in route applies on the first NON-EMPTY list even if not listed', () => {
    // Tablets can enumerate without EARPIECE; a live enumerator is enough for
    // the built-ins — parking the pick forever would be a second dead toggle.
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.pick('EARPIECE');
    q.onDeviceList(['SPEAKER_PHONE', 'BLUETOOTH']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('EARPIECE');
  });

  it('a headset route waits for a list that actually contains it', () => {
    // BT SCO can enumerate seconds after the built-ins; applying early would
    // just reproduce the native drop.
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.pick('BLUETOOTH');
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    expect(apply).not.toHaveBeenCalled();
    expect(q.pending()).toBe('BLUETOOTH');
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('BLUETOOTH');
  });

  it('an empty list event applies nothing — including built-ins', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.pick('SPEAKER_PHONE');
    q.onDeviceList([]);
    expect(apply).not.toHaveBeenCalled();
    expect(q.pending()).toBe('SPEAKER_PHONE');
  });

  it('applies exactly once — later lists do not re-apply (SCO flap guard)', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.pick('SPEAKER_PHONE');
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a newer explicit pick supersedes the queued one', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.pick('BLUETOOTH');
    q.pick('SPEAKER_PHONE');
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('SPEAKER_PHONE');
  });

  it('a pick that lands now clears the queue — it never overrides a later success', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    // BT tapped during the dead window…
    q.pick('BLUETOOTH');
    // …list arrives without BT (SCO still connecting) — BT stays queued…
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    // …then the user picks EARPIECE, which lands immediately.
    expect(q.pick('EARPIECE')).toBe(true);
    expect(apply).toHaveBeenNthCalledWith(1, 'EARPIECE');
    // BT finally enumerates: the stale queued pick must NOT yank the user off
    // the route they set successfully.
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(q.pending()).toBeNull();
  });

  it('pick applies immediately once the list is known — the normal path is unchanged', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE', 'BLUETOOTH']);
    expect(q.pick('BLUETOOTH')).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith('BLUETOOTH');
    expect(q.pending()).toBeNull();
  });

  it('clear() at call end disarms the queue', () => {
    const apply = jest.fn();
    const q = createRoutePickQueue({apply});
    q.pick('SPEAKER_PHONE');
    q.clear();
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    expect(apply).not.toHaveBeenCalled();
    expect(q.pending()).toBeNull();
  });

  it('an apply that synchronously re-emits a device event cannot double-apply', () => {
    // chooseAudioRoute can emit onAudioDeviceChanged before it returns; a
    // still-set queue would loop.
    const q = createRoutePickQueue({
      apply: () => q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']),
    });
    const spy = jest.spyOn(q, 'onDeviceList');
    q.pick('SPEAKER_PHONE');
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    // Outer event + exactly one re-entrant event from the single apply.
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe('B-236u × B-309 — an explicit pick beats the opening settle', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('pick during the dead window → settle cancelled, user route (not the default) applies', () => {
    // The wiring contract: on ANY explicit pick the screen cancels the settle
    // (sticky-explicit-pick, extended not forked) and routes the pick through
    // the queue. The media default must never land after the user has chosen.
    const applied: string[] = [];
    const settle = createOpeningRouteSettle({
      applyDefault: () => { applied.push('DEFAULT'); },
      timeoutMs: 1200,
    });
    const q = createRoutePickQueue({apply: r => { applied.push(r); }});
    // User taps SPEAKER before the first device event exists.
    q.pick('SPEAKER_PHONE');
    settle.cancel();
    // First enumeration arrives — no headset, i.e. the case where the settle
    // would have applied the default.
    settle.onFirstDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    q.onDeviceList(['EARPIECE', 'SPEAKER_PHONE']);
    jest.advanceTimersByTime(5000);
    expect(applied).toEqual(['SPEAKER_PHONE']);
  });
});
