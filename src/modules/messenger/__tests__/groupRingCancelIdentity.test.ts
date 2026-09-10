/**
 * WI-6.7 — ring-identity on the CLIENT cancel surfaces (+ the WI-6.1
 * preserve-the-answering-device guard).
 *
 * A room carries several rings over its life (mid-call "Add", Re-ring), so a
 * cancel that names its fan-out must dismiss ONLY that ring:
 *   - dispatcher dedup: a named cancel re-arms only the cancelled ring's
 *     marker — a NEWER presented ring stays dedup-suppressed for replays;
 *   - the parked copy: clearPendingGroupRing keeps a parked NEWER ring;
 *   - the screens / push lanes: pinned by source scan (RN screens and the
 *     module-private handleCallCancel are unreachable from this project).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  setGroupCallRingHandler,
  clearAllGroupCallRingHandlers,
  dispatchGroupRingFrame,
} from '../webrtc/groupCallRingDispatcher';
import {
  parkGroupRing,
  peekPendingGroupRing,
  clearPendingGroupRing,
  _resetPendingGroupRingForTest,
} from '../webrtc/pendingGroupRing';

const ROOM = 'room-identity-1';
const ringFrame = (ringId?: string, extra: Record<string, unknown> = {}) => ({
  event: 'sfu.ring.incoming',
  data: {
    roomId: ROOM, conversationId: 'conv-1', callType: 'voice',
    from: {userId: 'host-1', deviceId: 1}, callerName: 'Host', ringId, ...extra,
  },
});
const cancelFrame = (ringId?: string) => ({
  event: 'sfu.ring.cancelled',
  data: {roomId: ROOM, conversationId: 'conv-1', ringId},
});

afterEach(() => {
  clearAllGroupCallRingHandlers();
  _resetPendingGroupRingForTest();
});

describe('WI-6.7 — dispatcher dedup re-arm is ring-scoped', () => {
  function presentAll(): jest.Mock {
    const onIncoming = jest.fn(() => true);
    setGroupCallRingHandler({onIncoming, onCancel: () => {}, onDecline: () => {}});
    return onIncoming;
  }

  it('cancelling ring #1 leaves ring #2 dedup-suppressed (its replay cannot double-present)', () => {
    const onIncoming = presentAll();
    dispatchGroupRingFrame(ringFrame('r1'));
    dispatchGroupRingFrame(ringFrame('r2'));
    expect(onIncoming).toHaveBeenCalledTimes(2);

    dispatchGroupRingFrame(cancelFrame('r1')); // stale cancel for the OLD ring

    dispatchGroupRingFrame(ringFrame('r2'));   // r2 replay: still owned, suppressed
    expect(onIncoming).toHaveBeenCalledTimes(2);
    dispatchGroupRingFrame(ringFrame('r1'));   // r1 marker was re-armed by ITS cancel
    expect(onIncoming).toHaveBeenCalledTimes(3);
  });

  it('an UN-named cancel keeps the historical room-wide re-arm', () => {
    const onIncoming = presentAll();
    dispatchGroupRingFrame(ringFrame('r1'));
    dispatchGroupRingFrame(ringFrame('r2'));
    dispatchGroupRingFrame(cancelFrame(undefined));
    dispatchGroupRingFrame(ringFrame('r1'));
    dispatchGroupRingFrame(ringFrame('r2'));
    expect(onIncoming).toHaveBeenCalledTimes(4); // both re-presented
  });

  it('a named cancel also drops the legacy bare-roomId marker (pre-B-336 rings)', () => {
    const onIncoming = presentAll();
    dispatchGroupRingFrame(ringFrame(undefined)); // old-relay ring → bare marker
    expect(onIncoming).toHaveBeenCalledTimes(1);
    dispatchGroupRingFrame(cancelFrame('r-any'));
    dispatchGroupRingFrame(ringFrame(undefined));
    expect(onIncoming).toHaveBeenCalledTimes(2);  // re-armed
  });

  it('the cancel payload hands ringId through to the registered handlers', () => {
    const seen: Array<string | undefined> = [];
    setGroupCallRingHandler({
      onIncoming: () => true,
      onCancel: (d) => { seen.push(d.ringId); },
      onDecline: () => {},
    });
    dispatchGroupRingFrame(cancelFrame('r9'));
    dispatchGroupRingFrame(cancelFrame(undefined));
    expect(seen).toEqual(['r9', undefined]);
  });
});

describe('WI-6.7 — the parked copy survives a stale cancel', () => {
  const parked = (ringId?: string) => ({
    roomId: ROOM, conversationId: 'conv-1', callType: 'voice' as const,
    from: {userId: 'host-1', deviceId: 1}, callerName: 'Host', ringId,
  });

  it('a cancel naming an OLDER ring leaves a parked newer ring in place', () => {
    parkGroupRing(parked('r2'));
    clearPendingGroupRing(ROOM, 'r1');
    expect(peekPendingGroupRing()?.ringId).toBe('r2');
    clearPendingGroupRing(ROOM, 'r2'); // its OWN cancel still lands
    expect(peekPendingGroupRing()).toBeNull();
  });

  it('an un-named cancel and a ringId-less parked ring keep the room-wide clear', () => {
    parkGroupRing(parked('r2'));
    clearPendingGroupRing(ROOM);           // no ringId → room-wide
    expect(peekPendingGroupRing()).toBeNull();
    parkGroupRing(parked(undefined));      // legacy parked ring
    clearPendingGroupRing(ROOM, 'r-any');  // named cancel still clears it
    expect(peekPendingGroupRing()).toBeNull();
  });

  it('a cancel for a DIFFERENT room never touches the park, named or not', () => {
    parkGroupRing(parked('r2'));
    clearPendingGroupRing('other-room', 'r2');
    clearPendingGroupRing('other-room');
    expect(peekPendingGroupRing()?.ringId).toBe('r2');
  });
});

// ─── Source scans: RN screens + module-private push handlers ───────────────

function stripped(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('WI-6.7 — screen + navigator threading (source scans)', () => {
  it('IncomingGroupCallScreen matches cancel identity and re-binds per ring', () => {
    const src = stripped(['src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx']);
    expect(src).toContain('if (data.ringId && ringId && data.ringId !== ringId) {return;}');
    // The handler effect is keyed per RING — a same-room ring #2 swaps params
    // without changing roomId, and a stale closure would ignore its cancel.
    expect(src).toContain('}, [roomId, ringId, navigation]);');
    // The param actually arrives.
    expect(src).toMatch(/const \{roomId, conversationId, callType, callerName, fromUserId, roomToken, autoAccept, ringId\} = route\.params;/);
  });

  it('MainNavigator threads ringId at every navigate site and scopes the parked clear', () => {
    const src = stripped(['src', 'navigation', 'MainNavigator.tsx']);
    expect(src).toContain('clearPendingGroupRing(data.roomId, data.ringId)');
    const paramThreads = src.match(/ringId:\s+(?:ring|parked)\.ringId,/g) ?? [];
    expect(paramThreads).toHaveLength(3); // live WS ring + both parked-consume ladders
  });

  it('useGroupCall records every fan-out and names the cancel ONLY for a single-fan-out call', () => {
    const src = stripped(['src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts']);
    const captures = src.match(/mintedRingIdsRef\.current\.add\(ringAck\.ringId\);/g) ?? [];
    expect(captures).toHaveLength(3); // boot ring, invite ring, re-ring
    // Round 2 (edge F2) — the cancel is a cancel-ALL: naming the LATEST of
    // several fan-outs left the other fan-out's recipients ringing a
    // withdrawn call. Exactly-one minted → named; else unscoped room-wide.
    expect(src).toMatch(/ringId:\s+mintedRingIdsRef\.current\.size === 1\s*\n\s*\? Array\.from\(mintedRingIdsRef\.current\)\[0\]\s*\n\s*: undefined,/);
    expect(src).not.toContain('lastRingIdRef'); // the latest-wins single ref is the bug shape
  });

  it('same-room ring #2 gets its own settle latch and 45s clock (screen keys per ring)', () => {
    const src = stripped(['src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx']);
    // Round 2 (critic F4) — both per-ring effects re-key on ringId: the latch
    // reset and the 45 s fallback. Keyed on roomId alone, ring #2 inherited
    // ring #1's remaining clock and latched settle.
    const perRingDeps = src.match(/\}, \[roomId, ringId\]\);/g) ?? [];
    expect(perRingDeps).toHaveLength(2);
  });
});

describe('WI-6.1/WI-6.7 — the push cancel lane guards (source scans)', () => {
  it('handleCallCancel refuses to tear down a call this device answered/holds live', () => {
    const src = stripped(['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts']);
    const fnStart = src.indexOf('async function handleCallCancel');
    expect(fnStart).toBeGreaterThan(-1);
    const dismiss = src.indexOf('await cn.dismissCallNotif(callId)', fnStart);
    const liveGuard = src.indexOf("live.state !== 'ended' && live.state !== 'failed' && live.state !== 'ringing'", fnStart);
    const latchGuard = src.indexOf('Date.now() - acceptedAt <= ACCEPT_PRESERVE_WINDOW_MS', fnStart);
    const ringGuard = src.indexOf('cached.ringId !== cancelRingId', fnStart);
    // All three guards exist and run BEFORE any teardown side effect.
    for (const idx of [liveGuard, latchGuard, ringGuard]) {
      expect(idx).toBeGreaterThan(fnStart);
      expect(idx).toBeLessThan(dismiss);
    }
    // The accept shield is bounded — a losing device must not strand forever.
    expect(src).toMatch(/const ACCEPT_PRESERVE_WINDOW_MS = 20_000;/);
  });

  it('round 2 — a BARE ringing entry is collapsed, not shielded (F1/F2)', () => {
    const src = stripped(['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts']);
    const fnStart = src.indexOf('async function handleCallCancel');
    const dismiss = src.indexOf('await cn.dismissCallNotif(callId)', fnStart);
    // The live-call shield must EXCLUDE 'ringing' — a ring surface is exactly
    // what a cancel collapses; shielding it re-creates the 45s ghost ring
    // whose expiry hangup could kill the live call.
    expect(src.slice(fnStart, dismiss)).toContain("live.state !== 'ringing'");
    // And the in-app bare ring is actively ended through the KEYED teardown,
    // scoped away from caller-gave-up cancels (the WS hangup lane owns those).
    const collapse = src.indexOf("if (data.missed !== '1') {", fnStart);
    const keyedEnd = src.indexOf("reg.endActiveCall({callId: ringing.callId, gen: ringing.gen}, 'ended', 'remote', {silentWire: true});", fnStart);
    expect(collapse).toBeGreaterThan(fnStart);
    expect(keyedEnd).toBeGreaterThan(collapse);
    expect(keyedEnd).toBeLessThan(dismiss);
  });

  it('silentWire is opted into at EXACTLY the two remote-verdict sites (round 3)', () => {
    // The round-3 regression: keying wire-silence on source==='remote'
    // silently killed the peer's "Call ended" for the Telecom/system-UI End
    // and logout sites, which label themselves 'remote' for the CallKit
    // glyph while RELYING on the wire hangup. The opt-in must never spread
    // to those sites; this counts the exact population.
    const count = (rel: string[]) =>
      (stripped(rel).match(/silentWire: true/g) ?? []).length;
    expect(count(['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'])).toBe(1);      // the ring collapse
    expect(count(['src', 'modules', 'messenger', 'runtime', 'callSyncProbe.ts'])).toBe(1);  // the probe verdict
    expect(count(['src', 'store', 'authStore.ts'])).toBe(0);                                 // logout keeps the hangup
    expect(count(['src', 'modules', 'messenger', 'webrtc', 'callDispatcher.ts'])).toBe(0);   // zombie-end unchanged
  });

  it('endSilently is genuinely wire-silent (no sendHangup in its body)', () => {
    const src = stripped(['src', 'modules', 'messenger', 'webrtc', 'callController.ts']);
    const start = src.indexOf('endSilently(reason: HangupReason');
    expect(start).toBeGreaterThan(-1);
    // The next method opens after this one closes; bound the body scan there.
    const bodyEnd = src.indexOf('private async handleAnswer', start);
    const body = src.slice(start, bodyEnd > -1 ? bodyEnd : start + 600);
    expect(body).not.toContain('sendHangup');
    expect(body).toContain('ringState.cancel'); // expiry can't double-fire
  });

  it('the headless lane carries the same ring-identity guard before its dismiss', () => {
    const src = stripped(['src', 'modules', 'messenger', 'push', 'fcmHeadless.ts']);
    const guard = src.indexOf('cached.ringId !== cancelRingId');
    const dismiss = src.indexOf('await cn.dismissCallNotif(data.callId)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(dismiss);
  });
});
