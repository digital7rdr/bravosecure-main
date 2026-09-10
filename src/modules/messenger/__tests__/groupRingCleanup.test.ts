/**
 * WI-4.5 / WI-4.6 — group answer/end must clean every ring artifact, and the
 * group explicit-accept latch must round-trip like the 1:1 one.
 *
 * The 1:1 lifecycle cleans four things when a call is answered or ends: the
 * notification card, the native ringtone, the incoming-call payload, and (on
 * end) the tombstone + accept latch. The group lifecycle cleaned NONE of them:
 *
 *   - IncomingGroupCallScreen.accept navigated away and left the `bravo-call-
 *     <roomId>` card + native ringtone to the 45 s timeout;
 *   - its decline sent `sfu.ring.decline` and left the card, the payload and
 *     the latch;
 *   - endActiveGroupCall tore down transports and audio but left the payload
 *     un-tombstoned and the accept latch set.
 *
 * The latch half is what makes WI-4.6 SAFE: the group navigate sites now
 * re-assert `autoAccept` from `wasCallExplicitlyAccepted(roomId)` (the exact
 * B-102 A1 mirror), so a stale latch surviving the call's end would AUTO-JOIN
 * a future re-ring of the same room with zero user action — the B-110 ghost
 * answer, groupified. End/decline clearing the latch is the other half of the
 * same feature.
 *
 * Registry half is behavioural (groupCallRegistry is node-loadable); the
 * screen and MainNavigator halves are source scans (they mount RN).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('@/modules/messenger/runtime/callDiag', () => ({
  logCallSm:      jest.fn(),
  logCallSmQuiet: jest.fn(),
  shortCallId:    (s: string) => s.slice(0, 8),
}));

const mockDismissCallNotif = jest.fn(async () => {});
jest.mock('@/modules/messenger/push/callNotification', () => ({
  dismissCallNotif: (id: string) => mockDismissCallNotif(id),
}));

const mockNotifyCallEnded = jest.fn();
jest.mock('@/modules/messenger/push/fcmBootstrap', () => ({
  notifyCallEnded: (id: string) => mockNotifyCallEnded(id),
}));

import * as reg from '../runtime/groupCallRegistry';
import * as cache from '../push/incomingCallCache';

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\r\n]*/g, '');
}
const read = (...p: string[]): string => readFileSync(join(process.cwd(), ...p), 'utf8');

beforeEach(async () => {
  mockDismissCallNotif.mockClear();
  mockNotifyCallEnded.mockClear();
  cache._resetIncomingCallCacheForTests();
  await reg.endActiveGroupCall(); // quiesce the singleton between cases
  mockDismissCallNotif.mockClear();
  mockNotifyCallEnded.mockClear();
});

function register(roomId: string): reg.GroupCallKey {
  return reg.setActiveGroupCall({
    roomId,
    conversationId: 'conv-1',
    callType: 'voice',
    state: 'connected',
    startedAt: Date.now(),
    minimized: false,
    remoteTiles: [],
    leave: async () => {},
  } as never);
}

describe('WI-4.5 — endActiveGroupCall cleans the ring artifacts (owner only)', () => {
  it('dismisses the ring card + ringtone, DROPS the payload, clears the latch', async () => {
    cache.setIncomingCallPayload({callId: 'room-e1', callerName: 'H', kind: 'group-voice', roomId: 'room-e1', roomToken: 't'});
    register('room-e1');
    const outcome = await reg.endActiveGroupCall('room-e1');
    expect(outcome).toBe('ended');
    expect(mockDismissCallNotif).toHaveBeenCalledWith('room-e1');
    expect(cache.getIncomingCallPayload('room-e1')).toBeNull();
    // Review round 1 (P1) — DROPPED, NOT tombstoned. The gateway reuses a
    // roomId across re-rings while the room has participants (B-334/B-336
    // Add-member), and the FCM lanes refuse a tombstoned id — so an END
    // tombstone made a member who left a live call unreachable on a killed
    // app's only lane for the whole tombstone TTL. Ending MY call is not a
    // verdict about the room's future rings; decline/cancel are, and those
    // lanes still tombstone (case below).
    expect(cache.isIncomingCallDead('room-e1')).toBe(false);
    expect(mockNotifyCallEnded).toHaveBeenCalledWith('room-e1');
  });

  it('a re-ring of the same room AFTER an end presents normally on the FCM lanes', async () => {
    register('room-e2');
    await reg.endActiveGroupCall('room-e2');
    // The Add-member re-invite: same roomId, new fan-out. The cache seed the
    // FCM lanes gate on must ACCEPT it.
    const seeded = cache.setIncomingCallPayload({callId: 'room-e2', callerName: 'H', kind: 'group-voice', roomId: 'room-e2'});
    expect(seeded).toBe(true);
  });

  it('a REFUSED stale-room end touches NOTHING', async () => {
    cache.setIncomingCallPayload({callId: 'room-live', callerName: 'H', kind: 'group-voice', roomId: 'room-live'});
    register('room-live');
    const outcome = await reg.endActiveGroupCall('room-somebody-else');
    expect(outcome).toBe('refused');
    expect(mockDismissCallNotif).not.toHaveBeenCalled();
    expect(cache.getIncomingCallPayload('room-live')).not.toBeNull();
    expect(cache.isIncomingCallDead('room-somebody-else')).toBe(false);
    expect(mockNotifyCallEnded).not.toHaveBeenCalled();
    await reg.endActiveGroupCall('room-live');
  });

  it('an end with no active call cleans nothing (nothing was owned)', async () => {
    // Review round 1 note — this branch returning BEFORE the cleanup block is
    // deliberate: with nothing registered there are no artifacts this
    // teardown owns. The latch-leak this used to imply (an Answer whose join
    // never registered) is closed elsewhere: every non-accept exit of
    // IncomingGroupCallScreen clears the latch via dismissRing, and the
    // latch itself is scrubbed at 5 minutes.
    const outcome = await reg.endActiveGroupCall('room-none');
    expect(outcome).toBe('ended');
    expect(mockDismissCallNotif).not.toHaveBeenCalled();
    expect(cache.isIncomingCallDead('room-none')).toBe(false);
  });

  it('the ring screen clears the latch on EVERY non-accept exit (dismissRing funnel)', () => {
    const screen = stripComments(read('src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx'));
    const at = screen.indexOf('const dismissRing = useCallback');
    expect(at).toBeGreaterThan(-1);
    // R2-4 — a changed dep list must FAIL this anchor, not silently widen
    // the slice to the whole file.
    const depsAt = screen.indexOf('}, [navigation, roomId]);', at);
    expect(depsAt).toBeGreaterThan(at);
    const body = screen.slice(at, depsAt);
    expect(body).toMatch(/notifyCallEnded\(roomId\)/);
    // The SUCCESSFUL accept path (the navigation.replace) never passes the
    // funnel — an answered ring keeps its latch for the WI-4.6 offer-replay
    // re-assert. Its EARLY exits (roomMissing, same-tick cancel, missing
    // FrameCryptor) do call dismissRing, and clearing the latch there is the
    // point: those are failed answers.
    const navAt = screen.indexOf("navigation.replace('GroupCallScreen'");
    expect(navAt).toBeGreaterThan(-1);
    // R2-4 — the window must reach the arrow-fn close AFTER the replace
    // call's own `});`, or it only covers the replace's argument list and
    // the assertion is vacuous.
    const fnEnd = screen.indexOf('};', screen.indexOf('});', navAt) + 3);
    expect(fnEnd).toBeGreaterThan(navAt);
    const afterNav = screen.slice(navAt, fnEnd);
    expect(afterNav).not.toMatch(/dismissRing\(\)/);
  });

  it('the ordered teardown is preserved — ending flag is still published before the leave runs', async () => {
    let sawEndingDuringLeave = false;
    reg.setActiveGroupCall({
      roomId: 'room-ord',
      conversationId: 'conv-1',
      callType: 'voice',
      state: 'connected',
      startedAt: Date.now(),
      minimized: false,
      remoteTiles: [],
      leave: async () => {
        sawEndingDuringLeave = reg.getActiveGroupCall()?.ending === true;
      },
    } as never);
    await reg.endActiveGroupCall('room-ord');
    expect(sawEndingDuringLeave).toBe(true);
  });
});

describe('round 2 — a tombstone is per-RING for groups, not per-room (R2-2)', () => {
  it('a NEW fan-out (different ringId) supersedes a declined ring\'s tombstone', () => {
    // Host rings (ring-1) → member declines → tombstone. Host rings AGAIN
    // (ring-2, same roomId — the gateway reuses it while the room lives).
    // The killed lane's ONLY presentation is gated on this seed; refusing it
    // made the member silently unreachable for the whole tombstone TTL.
    cache.setIncomingCallPayload({callId: 'room-r1', callerName: 'H', kind: 'group-voice', roomId: 'room-r1', ringId: 'ring-1'});
    cache.clearIncomingCallPayload('room-r1'); // decline → tombstone carries ring-1
    expect(cache.isIncomingCallDead('room-r1')).toBe(true);

    const seeded = cache.setIncomingCallPayload({callId: 'room-r1', callerName: 'H', kind: 'group-voice', roomId: 'room-r1', ringId: 'ring-2'});
    expect(seeded).toBe(true);
    // The new fan-out supersedes the consumed one entirely — the card this
    // seed draws must survive the notifee stale-card gate.
    expect(cache.isIncomingCallDead('room-r1')).toBe(false);
  });

  it('a FOREGROUND-consumed ring (no cache entry → no captured ringId) still yields to a new fan-out (F1)', () => {
    // The WS/foreground group lanes never seed the cache, so their decline/
    // cancel tombstones carry ringId: undefined. A later seed CARRYING a
    // ringId proves a B-336 relay — on a group id, an identity-less tombstone
    // can only mean foreground consumption, so the new fan-out supersedes.
    // (1:1 is unaffected: its seeds never carry a ringId, so it stays in the
    // refusal branch below.)
    cache.clearIncomingCallPayload('room-fg'); // foreground decline: nothing cached
    expect(cache.isIncomingCallDead('room-fg')).toBe(true);
    const seeded = cache.setIncomingCallPayload({callId: 'room-fg', callerName: 'H', kind: 'group-voice', roomId: 'room-fg', ringId: 'ring-2'});
    expect(seeded).toBe(true);
  });

  it('the SAME ringId (a stale duplicate of the consumed ring) stays refused', () => {
    cache.setIncomingCallPayload({callId: 'room-r2', callerName: 'H', kind: 'group-voice', roomId: 'room-r2', ringId: 'ring-9'});
    cache.clearIncomingCallPayload('room-r2');
    expect(cache.setIncomingCallPayload({callId: 'room-r2', callerName: 'H', kind: 'group-voice', roomId: 'room-r2', ringId: 'ring-9'})).toBe(false);
  });

  it('a seed with NO ringId stays refused (pre-B-336 relay: fail closed, old behaviour)', () => {
    cache.setIncomingCallPayload({callId: 'room-r3', callerName: 'H', kind: 'group-voice', roomId: 'room-r3', ringId: 'ring-a'});
    cache.clearIncomingCallPayload('room-r3');
    expect(cache.setIncomingCallPayload({callId: 'room-r3', callerName: 'H', kind: 'group-voice', roomId: 'room-r3'})).toBe(false);
  });

  it('1:1 semantics unchanged — no ringId anywhere, a tombstoned callId never reseeds', () => {
    cache.setIncomingCallPayload({callId: 'c-11', callerName: 'A', kind: 'voice'});
    cache.clearIncomingCallPayload('c-11');
    expect(cache.setIncomingCallPayload({callId: 'c-11', callerName: 'A', kind: 'voice'})).toBe(false);
  });

  it('a 1:1 tombstone is NEVER superseded, even by a seed smuggling a ringId (F1-R4)', () => {
    // ringId rides UNSIGNED on the wake, and every 1:1 tombstone lacks one —
    // so without the kind gate, ANY ringId-carrying seed would delete a 1:1
    // tombstone and disarm its three consumers (the WI-4.7 accept gate, the
    // dead-offer watchdog, the offer-replay guard). The supersede must be a
    // property of the GUARD (group kinds only), not of the server's current
    // habit of omitting ringId on the 1:1 lane.
    cache.setIncomingCallPayload({callId: 'c-smuggle', callerName: 'A', kind: 'voice'});
    cache.clearIncomingCallPayload('c-smuggle');
    expect(cache.setIncomingCallPayload({callId: 'c-smuggle', callerName: 'A', kind: 'voice', ringId: 'ring-x'})).toBe(false);
    expect(cache.isIncomingCallDead('c-smuggle')).toBe(true);
  });
});

describe('round 2 — the END marker closes the stale-Answer replay without touching re-invites (R2-1)', () => {
  it('END marks the room ring consumed; a FRESH seed self-heals it', async () => {
    register('room-m1');
    await reg.endActiveGroupCall('room-m1');
    expect(cache.isGroupRingConsumed('room-m1')).toBe(true);
    // The re-invite's FCM seed (any lane) clears the marker — a genuine new
    // fan-out must never be blocked by MY old teardown.
    cache.setIncomingCallPayload({callId: 'room-m1', callerName: 'H', kind: 'group-voice', roomId: 'room-m1', ringId: 'ring-n'});
    expect(cache.isGroupRingConsumed('room-m1')).toBe(false);
  });

  it('the marker is meaningless for ids that never ended a group call', () => {
    expect(cache.isGroupRingConsumed('room-never')).toBe(false);
  });
});

describe('WI-4.5 — IncomingGroupCallScreen lanes (source scan; screen mounts RN)', () => {
  const screen = stripComments(read('src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx'));

  it('accept dismisses the ring card + native ringtone before navigating into the room', () => {
    const acceptAt = screen.indexOf('const accept = ');
    const navAt = screen.indexOf("navigation.replace('GroupCallScreen'", acceptAt);
    expect(acceptAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(-1);
    const between = screen.slice(acceptAt, navAt);
    expect(between).toMatch(/dismissCallNotif\(roomId\)/);
  });

  it('decline dismisses the card and tombstones the payload (matches the notifee decline lane)', () => {
    const declineAt = screen.indexOf('const decline = ');
    expect(declineAt).toBeGreaterThan(-1);
    const body = screen.slice(declineAt, screen.indexOf('}, [', declineAt));
    expect(body).toMatch(/dismissCallNotif\(roomId\)/);
    expect(body).toMatch(/clearIncomingCallPayload\(roomId\)/);
  });
});

describe('WI-4.6 — the group navigate sites re-assert the explicit accept (source scan)', () => {
  const nav = stripComments(read('src', 'navigation', 'MainNavigator.tsx'));

  it('every IncomingGroupCallScreen navigate carries the latch-derived autoAccept', () => {
    // Three sites: the primary ring handler, the busy-1:1 consume ladder, and
    // the restore-exit re-present. Each must re-assert, or an offer/ring
    // replay landing after the Answer tap un-answers the call (RN6 navigate
    // REPLACES params — the exact B-102 A1 mechanism).
    const sites: number[] = [];
    let at = nav.indexOf("'IncomingGroupCallScreen'");
    while (at !== -1) {
      sites.push(at);
      at = nav.indexOf("'IncomingGroupCallScreen'", at + 1);
    }
    // Type unions / route maps also name the screen; count only navigate calls.
    const navigateSites = sites.filter(s => {
      const before = nav.slice(Math.max(0, s - 120), s);
      return /navigateToMessengerScreen\(\s*navigationRef as never,\s*$/.test(before) || before.includes('navigateToMessengerScreen(');
    });
    expect(navigateSites.length).toBeGreaterThanOrEqual(3);
    for (const s of navigateSites) {
      const window = nav.slice(s, s + 900);
      expect(window).toMatch(/groupRingExplicitlyAccepted\((?:ring|parked)\.roomId\)/);
    }
  });

  it('the group latch consult is BOUNDED to the ring window (R2-3)', () => {
    // A group Answer whose navigation was abandoned keeps the intent latch
    // (WI-4.3) — correct for the chasing WS frame, but group roomIds are
    // reused, so a 5-minute latch would auto-join the room's NEXT ring. The
    // re-assert only has to outlive the seconds between a landed navigation
    // and its ring frame; one ring window is generous.
    const helper = nav.slice(nav.indexOf('function groupRingExplicitlyAccepted'), nav.indexOf('export default function MainNavigator'));
    expect(helper).toMatch(/wasCallExplicitlyAcceptedWithin\(roomId,\s*RING_TIMEOUT_MS\)/);
  });

  it('the latch lookup is the 1:1 mirror — guarded require, never a static import', () => {
    // The push layer must stay lazily required from MainNavigator (cold
    // WS-only boots have no push layer), same as the 1:1 site.
    expect(nav).not.toMatch(/^import .*fcmBootstrap/m);
  });
});
