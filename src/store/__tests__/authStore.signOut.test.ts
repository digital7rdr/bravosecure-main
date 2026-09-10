/**
 * IDN-22 (F10) — signOut re-entrancy + overlay-flag hygiene. We exercise the
 * REAL signOut with every lazy-required messenger module mocked to a stub so
 * the teardown sequencing (guard → steps → finally) is what's under test.
 */
jest.mock('@services/api', () => ({
  authApi: {me: jest.fn(), signOut: jest.fn(() => Promise.resolve())},
  agentApi: {setDuty: jest.fn(() => Promise.resolve())},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  tokenStore: {get: jest.fn(), getRefresh: jest.fn(), set: jest.fn(), clear: jest.fn()},
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
jest.mock('expo-local-authentication', () => ({}));

// Stubs for every module signOut lazy-requires — the real ones pull native
// deps (op-sqlite, webrtc, keychain) that don't belong in a store unit test.
jest.mock('@/modules/messenger/runtime', () => ({
  getActiveOwnerKey: jest.fn(() => 'owner@x.io'),
  _resetMessengerRuntime: jest.fn(),
}));
jest.mock('@/modules/messenger/push/unregisterPush', () => ({
  revokeServerPushTokens: jest.fn(() => Promise.resolve()),
}));
jest.mock('@/modules/messenger/webrtc/incomingOneToOneBanner', () => ({clearPendingOneToOne: jest.fn()}));
jest.mock('@/modules/messenger/runtime/callRegistry', () => ({endActiveCall: jest.fn()}));
jest.mock('@/modules/messenger/runtime/groupCallRegistry', () => ({endActiveGroupCall: jest.fn(() => Promise.resolve())}));
jest.mock('@/modules/messenger/runtime/bravoTones', () => ({stopAllTones: jest.fn(() => Promise.resolve())}));
jest.mock('@/modules/messenger/backup/messageMirror', () => ({
  disposeMirror: jest.fn(),
  isMirrorEnabled: jest.fn(() => true),
  drainMirrorOutbox: jest.fn(() => Promise.resolve()),
  fireMerkleHookNowIfPending: jest.fn(() => Promise.resolve()),
  mirrorOutboxSize: jest.fn(() => 1),
}));
jest.mock('@/modules/messenger/backup/mirrorBootstrap', () => ({stopMirrorBootstrap: jest.fn()}));
jest.mock('@/modules/messenger/backup/identityBackup', () => ({lockIdentityBackup: jest.fn()}));
jest.mock('@/modules/messenger/runtime/productionRuntime', () => ({disposeLiveRuntime: jest.fn()}));
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({clearAllPresence: jest.fn()})},
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({clearLiveTransport: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/callDispatcher', () => ({clearAllCallDispatchState: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/sfuDispatcher', () => ({clearAllSfuHandlers: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/groupCallIdentityRegistry', () => ({clearAllRoomIdentities: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/useGroupCall', () => ({clearAllLiveSfuHandles: jest.fn()}));
jest.mock('@/modules/messenger/webrtc/groupCallRingDispatcher', () => ({clearAllGroupCallRingHandlers: jest.fn()}));
jest.mock('@/modules/messenger/runtime/rttRegistry', () => ({clearRtt: jest.fn()}));
jest.mock('@/modules/messenger/push/fcmBootstrap', () => ({stopFcmBootstrap: jest.fn()}));
jest.mock('@/modules/messenger/push/voipWakeVerify', () => ({clearVoipWakeKey: jest.fn(() => Promise.resolve())}));
jest.mock('@/modules/messenger/runtime/wipeAtRest', () => ({
  wipeUserAtRest: jest.fn(() => Promise.resolve({errors: []})),
}));
jest.mock('@store/walletStore', () => ({useWalletStore: {getState: () => ({reset: jest.fn()})}}));
jest.mock('@store/bookingStore', () => ({useBookingStore: {getState: () => ({reset: jest.fn()})}}));
const mockActivityClear = jest.fn();
const mockActivityWipeLocal = jest.fn();
jest.mock('@store/activityStore', () => ({
  useActivityStore: {getState: () => ({clear: mockActivityClear, wipeLocal: mockActivityWipeLocal})},
}));
jest.mock('@store/activitySync', () => ({
  resetActivitySyncWatermark: jest.fn(() => Promise.resolve()),
  stopActivitySync: jest.fn(),
}));

import {useAuthStore} from '@store/authStore';
import {authApi, getDeviceId} from '@services/api';
import {setUser as setObservabilityUser} from '@modules/observability';
import {wipeUserAtRest} from '@/modules/messenger/runtime/wipeAtRest';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  disposeMirror, isMirrorEnabled, drainMirrorOutbox, fireMerkleHookNowIfPending,
  mirrorOutboxSize,
} from '@/modules/messenger/backup/messageMirror';

const mockApiSignOut = authApi.signOut as jest.Mock;
const mockGetDeviceId = getDeviceId as jest.Mock;
const mockSetObsUser = setObservabilityUser as jest.Mock;
const mockWipe = wipeUserAtRest as jest.Mock;
const mockDispose = disposeMirror as jest.Mock;
const mockMirrorEnabled = isMirrorEnabled as jest.Mock;
const mockDrain = drainMirrorOutbox as jest.Mock;
const mockFirePending = fireMerkleHookNowIfPending as jest.Mock;
const mockOutboxSize = mirrorOutboxSize as jest.Mock;

describe('authStore.signOut — IDN-22 re-entrancy + flag hygiene', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDeviceId.mockResolvedValue('dev-1');
    mockApiSignOut.mockResolvedValue(undefined);
    mockMirrorEnabled.mockReturnValue(true);
    mockDrain.mockResolvedValue(undefined);
    mockFirePending.mockResolvedValue(undefined);
    mockOutboxSize.mockReturnValue(1);
    useAuthStore.setState({isAuthenticated: true, isSigningOut: false});
  });

  it('a second call while one is in flight is a no-op', async () => {
    // Hold the auth-service revoke so the first call parks mid-teardown.
    let releaseApiSignOut!: () => void;
    mockApiSignOut.mockImplementationOnce(
      () => new Promise<void>(r => { releaseApiSignOut = r; }),
    );

    const p1 = useAuthStore.getState().signOut();
    // The flag is raised synchronously before the first await, so the
    // second call must early-return without starting its own teardown.
    expect(useAuthStore.getState().isSigningOut).toBe(true);
    const p2 = useAuthStore.getState().signOut();
    await p2;
    expect(mockGetDeviceId).toHaveBeenCalledTimes(1);

    // Flush pending microtasks so p1 reaches (and parks on) the held
    // authApi.signOut call before we release it.
    await new Promise(r => setTimeout(r, 0));
    expect(mockApiSignOut).toHaveBeenCalledTimes(1);
    releaseApiSignOut();
    await p1;
    expect(mockApiSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().isSigningOut).toBe(false);
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });

  it('clears isSigningOut in finally even when a step throws', async () => {
    mockSetObsUser.mockImplementationOnce(() => { throw new Error('sentry down'); });
    await expect(useAuthStore.getState().signOut()).rejects.toThrow('sentry down');
    // The button must not be bricked: flag cleared, next attempt runs.
    expect(useAuthStore.getState().isSigningOut).toBe(false);
    await useAuthStore.getState().signOut();
    expect(mockApiSignOut).toHaveBeenCalledTimes(2);
    expect(useAuthStore.getState().isSigningOut).toBe(false);
  });

  it('plain signOut does NOT wipe at-rest; {wipeAtRest:true} does', async () => {
    await useAuthStore.getState().signOut();
    expect(mockWipe).not.toHaveBeenCalled();

    useAuthStore.setState({isAuthenticated: true, isSigningOut: false});
    await useAuthStore.getState().signOut({wipeAtRest: true});
    expect(mockWipe).toHaveBeenCalledTimes(1);
    expect(mockWipe).toHaveBeenCalledWith('owner@x.io');
  });

  it('MOB-6/MOB-7 — signOut resets the activity-sync watermark, stops the listener, and wipes the feed', async () => {
    const {resetActivitySyncWatermark, stopActivitySync} =
      require('@store/activitySync') as typeof import('@store/activitySync');
    await useAuthStore.getState().signOut();
    // MOB-6 — the per-user cursor cleanup + foreground-listener teardown are wired.
    expect(stopActivitySync as jest.Mock).toHaveBeenCalledTimes(1);
    expect(resetActivitySyncWatermark as jest.Mock).toHaveBeenCalledTimes(1);
    // MOB-7 — the feed is wiped so it can't leak to the next user before the next
    // login's setOwner() effect runs. RE-POINTED (B-706) from `clear` to `wipeLocal`:
    // the contract is unchanged, the action is not.
    expect(mockActivityWipeLocal).toHaveBeenCalledTimes(1);
    // B-706 — and it must NOT be `clear()`. `clear()` is the user's own dismiss-all and
    // now records tombstones; using it here would make a sign-out/sign-in on the SAME
    // account suppress that account's entire history forever (setOwner only drops the
    // ledger when the identity CHANGES). A privacy wipe leaves no deletion state behind.
    expect(mockActivityClear).not.toHaveBeenCalled();
  });
});

/**
 * B-632 — a deletion made moments before sign-out never reaches the server,
 * and a later restore RESURRECTS the message.
 *
 * `mirrorRemoval` queues a SYNTHETIC tombstone (`messageMirror.ts:481-523`) —
 * the SQL row is already gone (`messengerStore.ts:570-572`), so nothing can
 * re-derive it — and `signOut` called `disposeMirror()` (`queue.length = 0`)
 * with no preceding drain. Worse, `mirror_flushed` still holds the row's LIVE
 * version, so the next boot sweep's `seedMirrorDedup` skips it BY DESIGN (I1):
 * logging back in never heals it. Same class as B-594/B-605, which this
 * silently reverted.
 *
 * ⚠️ WHY THE ORDERING PIN BELOW IS NOT PEDANTRY. The drain must run BEFORE
 * `authApi.signOut(deviceId)`, because that call revokes the JTI and every
 * later upload 401s — `flush()` classifies `unauthorized` as RETRYABLE, so the
 * batch is requeued and then thrown away by `disposeMirror`. With a mocked
 * backup client the 401 never happens, so a mis-placed drain passes every
 * behavioural test in this file. The same hazard is documented for push tokens
 * at `authStore.ts:672-680`.
 */
describe('B-632 — sign-out must not discard a pending deletion', () => {
  // This describe sits OUTSIDE the IDN-22 block above, so it needs its own
  // reset — without it the mock call counts accumulate across cases and the
  // "costs nothing when locked" assertion reads another test's calls.
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetDeviceId.mockResolvedValue('dev-1');
    mockApiSignOut.mockResolvedValue(undefined);
    mockMirrorEnabled.mockReturnValue(true);
    mockDrain.mockResolvedValue(undefined);
    mockFirePending.mockResolvedValue(undefined);
    mockOutboxSize.mockReturnValue(1);
    useAuthStore.setState({isAuthenticated: true, isSigningOut: false});
  });

  it('drains the mirror (both queues) and ships the owed commit before disposing', async () => {
    await useAuthStore.getState().signOut();
    // Both queues drain through this one call — it loops on
    // `queue.length > 0 || convQueue.size > 0`, so the MESSAGE tombstone and
    // the CONVERSATION delete (B-605's half) are both covered.
    expect(mockDrain).toHaveBeenCalledTimes(1);
    // …and the commit that upload owes (I2) is fast-forwarded, gated: this is
    // the EXPORTED form of B1's `if (merkleHookDebounce)` check, so a sign-out
    // with nothing owed costs no network.
    expect(mockFirePending).toHaveBeenCalledTimes(1);
  });

  it('the WHOLE sequence is ordered: drain → fire → revoke → dispose', async () => {
    /**
     * One array, four steps, because each adjacency is load-bearing:
     *
     *  drain → fire   — `fireMerkleHookNowIfPending` only fires when the
     *                   debounce slot is ARMED, and it is the drain's own
     *                   flushes that arm it. Fire-first finds the gate false,
     *                   skips the commit, then uploads: rows on the server,
     *                   pending flag set, no covering commit. That is the I2
     *                   window this commit exists to close, reopened by a
     *                   two-line swap — and it stayed green until this
     *                   assertion existed.
     *  fire → revoke  — after `authApi.signOut` the JTI is dead; every upload
     *                   401s, `flush()` treats `unauthorized` as retryable and
     *                   requeues, and `disposeMirror` then discards it. Inert,
     *                   and green under any mocked client.
     *  revoke → dispose — the queue must still exist while we drain it.
     */
    const order: string[] = [];
    // `mirrorOutboxSize()` must be read BEFORE the drain: reading it after
    // returns ~0 on every successful drain, so the `queued > 0` guard suppresses
    // the device marker and the fix becomes unobservable on-device again — with
    // every other assertion still green. Exactly the "tidy the reads together"
    // edit someone makes later.
    mockOutboxSize.mockImplementationOnce(() => { order.push('size'); return 1; });
    mockDrain.mockImplementationOnce(async () => { order.push('drain'); });
    mockFirePending.mockImplementationOnce(async () => { order.push('fire'); });
    mockApiSignOut.mockImplementationOnce(async () => { order.push('revoke'); });
    mockDispose.mockImplementationOnce(() => { order.push('dispose'); });
    await useAuthStore.getState().signOut();
    expect(order).toEqual(['size', 'drain', 'fire', 'revoke', 'dispose']);
  });

  it('still drains on {wipeAtRest: true} — the path where a lost tombstone is UNRECOVERABLE', async () => {
    // `wipeUserAtRest` destroys the local SQLCipher history that B-81 repair
    // needs, so a deletion dropped here can never be recovered by any
    // in-contract path. Pinned so a later "don't touch the network on wipe"
    // change cannot silently skip it.
    await useAuthStore.getState().signOut({wipeAtRest: true});
    expect(mockDrain).toHaveBeenCalledTimes(1);
    expect(mockWipe).toHaveBeenCalledTimes(1);
  });

  it('costs nothing when backup is locked — no drain, no commit', async () => {
    mockMirrorEnabled.mockReturnValue(false);
    await useAuthStore.getState().signOut();
    expect(mockDrain).not.toHaveBeenCalled();
    expect(mockFirePending).not.toHaveBeenCalled();
  });

  it('a hung network cannot block sign-out — the race times out and teardown continues', async () => {
    // Never resolves: without the bounded race this awaits forever and the
    // user is stuck behind the "Signing out…" overlay.
    mockDrain.mockImplementationOnce(() => new Promise<void>(() => {}));
    await useAuthStore.getState().signOut();
    expect(mockDispose).toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().isSigningOut).toBe(false);
  });

  it('a drain that THROWS is swallowed — sign-out always completes', async () => {
    mockDrain.mockImplementationOnce(() => Promise.reject(new Error('offline')));
    await useAuthStore.getState().signOut();
    expect(mockDispose).toHaveBeenCalled();
    expect(useAuthStore.getState().isAuthenticated).toBe(false);
  });
});

/**
 * The ordering pin the behavioural tests above CANNOT provide (see the ⚠️).
 * Source scan, because the hazard is positional and invisible to a mock.
 */
describe('B-632 — the drain call site precedes authApi.signOut (source scan)', () => {
  const src = () =>
    readFileSync(join(process.cwd(), 'src', 'store', 'authStore.ts'), 'utf8').replace(/\r\n/g, '\n');

  /** Comments stripped — `authStore.ts:673` contains the literal token
   *  `authApi.signOut()` inside the push-token comment, so an unstripped scan
   *  matches PROSE before the real call site and passes vacuously with the
   *  drain on the wrong side. This repo has shipped that mistake before. */
  const code = () =>
    src()
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');

  it('the scan reads real code, not prose (guards a vacuous pass)', () => {
    expect(code()).toContain('signOut:');
    expect(code()).not.toContain('Once auth invalidates the JTI');
  });

  it('drainMirrorOutbox appears BEFORE authApi.signOut( inside signOut', () => {
    const c = code();
    const start = c.indexOf('signOut:');
    expect(start).toBeGreaterThan(-1);
    const drainAt = c.indexOf('drainMirrorOutbox', start);
    // The full token — bare `signOut` also matches the declaration itself.
    const revokeAt = c.indexOf('authApi.signOut(', start);
    expect(drainAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(-1);
    expect(drainAt).toBeLessThan(revokeAt);
  });

  it('the drain is AWAITED and bounded — not fire-and-forget', () => {
    const c = code();
    const at = c.indexOf('drainMirrorOutbox');
    const region = c.slice(Math.max(0, at - 600), at + 600);
    expect(region).toMatch(/await\s+Promise\.race/);
    expect(region).toMatch(/isMirrorEnabled\(\)/);
    /**
     * The DRAIN ITSELF must be awaited, not just the race around it.
     *
     * `void mirror.drainMirrorOutbox()` — the obvious "make sign-out snappier"
     * edit — passes every behavioural test in this file: the call still
     * happens, the order mock still records first (its body runs synchronously
     * to the first await), and the hung-network case still completes because
     * the IIFE falls straight through. It also reinstates B-632, because the
     * upload is then still in flight when the JTI is revoked below.
     */
    expect(region).toMatch(/await\s+mirror\.drainMirrorOutbox\(\)/);
  });

  it('the abandoned tail cannot surface as an unhandled rejection', () => {
    // The outer catch only sees a rejection that WINS the race. One arriving
    // after the timeout already won belongs to a promise nobody awaits, and RN
    // reports it in release — on the teardown path.
    expect(code()).toMatch(/\}\)\(\)\.catch\(/);
  });

  it('the timeout handle is cleared — this file runs on REAL timers', () => {
    expect(code()).toMatch(/clearTimeout\(drainTimer\)/);
  });
});
