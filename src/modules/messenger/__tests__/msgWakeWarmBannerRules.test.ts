/**
 * Warm-background msg-wake banner decision rules — the FCM
 * `setBackgroundMessageHandler` lane registered at module top-level in
 * push/fcmBootstrap.ts, plus the M16 seam in push/backgroundMessageNotifier.ts.
 *
 * What this pins (and the bug IDs behind each rule):
 *
 *   P2-BR-5 — mute suppression keys ONLY off an explicit conversationId in the
 *             wake. A DM id heuristically resolved from senderUserId is
 *             ambiguous under sealed sender (the sender may be posting to a
 *             GROUP), so a muted 1:1 must never silence that sender's wakes.
 *   P1-8    — while the store-driven notifier is alive, the FCM handler draws
 *             NO banner of its own (the notifier posts the correct conv-keyed
 *             one after the pull) — no duplicates, no misattribution.
 *   P2-6    — the fallback banner fires ONLY when getMessagePostedGeneration
 *             did not advance across the pull (notifier drew nothing), and it
 *             is keyed explicit-conv or sender-generic — NEVER the resolved DM.
 *   N-02/S3 — call-cancel and voip-wake short-circuit before the msg-wake lane.
 *   B-107   — restore mode gates the runtime boot (getMessengerRuntime) so a
 *             bg msg-wake can't run installIdentity mid-restore (Round-8 class).
 *   M16     — the notifier's banner post site lives ONLY inside onAfterCommit,
 *             so a rolled-back receive txn can never leave a banner behind
 *             (static scan; behavioural rollback coverage lives in
 *             backgroundMessageNotifier.test.ts).
 *
 * The bg handler cannot be imported as a symbol — fcmBootstrap registers it as
 * a top-level side effect — so it is captured from the messaging mock, the same
 * trick fcmBootstrapOrder.test.ts uses.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
jest.mock('react-native', () => ({
  Platform: {OS: 'android', Version: 33},
  PermissionsAndroid: {check: jest.fn(async () => true), request: jest.fn(async () => 'granted')},
  NativeModules: {},
  AppState: {currentState: 'background', addEventListener: jest.fn(() => ({remove: jest.fn()}))},
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});
jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    getToken:                    jest.fn(async () => 'tok-1'),
    onTokenRefresh:              jest.fn(() => () => {}),
    onMessage:                   jest.fn(() => () => {}),
    setBackgroundMessageHandler: jest.fn(),
  };
  const messaging = () => api;
  return {__esModule: true, default: messaging};
});
jest.mock('@notifee/react-native', () => ({
  __esModule: true,
  default: {
    displayNotification: jest.fn(async () => 'nid'),
    cancelNotification:  jest.fn(async () => {}),
    createChannel:       jest.fn(async () => 'ch'),
    deleteChannel:       jest.fn(async () => {}),
    onForegroundEvent:   jest.fn(),
    onBackgroundEvent:   jest.fn(),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: jest.fn()},
}));
jest.mock('@/store/authStore', () => ({
  useAuthStore: {getState: () => ({user: {id: 'self-1'}})},
}));
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
  reportIncomingCall:       jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/voipWakeVerify', () => ({
  verifyVoipWake: jest.fn(async () => ({ok: false, reason: 'bad-sig'})),
}));
jest.mock('../push/callNotification', () => ({
  showMessageNotif:     jest.fn(async () => {}),
  dismissMessageNotif:  jest.fn(async () => {}),
  showIncomingCallNotif: jest.fn(async () => {}),
  dismissCallNotif:     jest.fn(async () => {}),
  showMissedCallNotif:  jest.fn(async () => {}),
  markReplyQueued:      jest.fn(async () => {}),
}));
jest.mock('../push/mutedLookup', () => ({
  isConversationMuted:         jest.fn(async () => false),
  resolveDirectConversation:   jest.fn(async () => null),
  resolveDirectConversationId: jest.fn(async () => null),
  resolveConversationMeta:     jest.fn(async () => null),
  resolveDirectPeerName:       jest.fn(async () => null),
  resolveTotalUnread:          jest.fn(async () => null),
  conversationExists:          jest.fn(async () => false),
}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier:     jest.fn(),
  stopBackgroundMessageNotifier:      jest.fn(),
  isBackgroundMessageNotifierRunning: jest.fn(() => false),
  getMessagePostedGeneration:         jest.fn(() => 0),
  // B-703 MR-19 — the warm lane now asks the witness, not the raw counter.
  snapshotCues:                       jest.fn(() => ({gen: 0, failures: 0})),
  cueDeliveredSince:                  jest.fn(async () => false),
  setContentPreviewEnabled:           jest.fn(),
}));
jest.mock('@/modules/messenger/runtime', () => ({
  getMessengerRuntime: jest.fn(async () => ({pullEnvelopes: jest.fn(async () => {})})),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

import '../push/fcmBootstrap'; // registers the bg handler as a top-level side effect
import messaging from '@react-native-firebase/messaging';
import {
  showMessageNotif,
  showIncomingCallNotif,
  dismissCallNotif,
} from '../push/callNotification';
import {isConversationMuted, resolveDirectConversation, resolveConversationMeta, resolveTotalUnread} from '../push/mutedLookup';
import {
  isBackgroundMessageNotifierRunning,
  getMessagePostedGeneration,
  snapshotCues,
  cueDeliveredSince,
} from '../push/backgroundMessageNotifier';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {verifyVoipWake} from '../push/voipWakeVerify';
// Real leaf module (no imports) — the SAME instance fcmBootstrap lazily
// requires, because both specifiers resolve to the same file.
import {setRestoreModeActive} from '../backup/restoreMode';

type BgHandler = (m: {data?: Record<string, string>}) => Promise<void>;
// Captured at module scope, BEFORE the first beforeEach clears mock.calls.
const bgHandler = ((messaging().setBackgroundMessageHandler as unknown as jest.Mock)
  .mock.calls[0] as [BgHandler])[0];

const show        = showMessageNotif as jest.Mock;
const showRing    = showIncomingCallNotif as jest.Mock;
const dismissRing = dismissCallNotif as jest.Mock;
const mutedMock   = isConversationMuted as jest.Mock;
const resolveDM   = resolveDirectConversation as jest.Mock;
const resolveMeta = resolveConversationMeta as jest.Mock;
const resolveUnread = resolveTotalUnread as jest.Mock;
const running     = isBackgroundMessageNotifierRunning as jest.Mock;
const gen         = getMessagePostedGeneration as jest.Mock;
const snapCues    = snapshotCues as jest.Mock;
const cueDelivered = cueDeliveredSince as jest.Mock;
const getRuntime  = getMessengerRuntime as jest.Mock;
const verify      = verifyVoipWake as jest.Mock;

const wake = (data: Record<string, string>) => bgHandler({data});

let genValue = 0;
// B-703 MR-19 — a cue that was ATTEMPTED but failed to draw. The real witness
// counts these; the mock models the same pair so the fallback rule under test
// is the shipped one.
let failValue = 0;
let pullMock: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  genValue = 0;
  failValue = 0;
  pullMock = jest.fn(async () => {});
  mutedMock.mockImplementation(async () => false);
  resolveDM.mockImplementation(async () => null);
  resolveMeta.mockImplementation(async () => null);
  resolveUnread.mockImplementation(async () => null);
  running.mockImplementation(() => false);
  gen.mockImplementation(() => genValue);
  snapCues.mockImplementation((cid?: string) =>
    ({gen: genValue, failures: failValue, conversationId: cid, convFailures: failValue}));
  cueDelivered.mockImplementation(async (b: {gen: number; failures: number}) =>
    genValue !== b.gen && failValue === b.failures);
  getRuntime.mockImplementation(async () => ({pullEnvelopes: pullMock}));
  verify.mockImplementation(async () => ({ok: false, reason: 'bad-sig'}));
  setRestoreModeActive(false);
});

describe('P2-BR-5 — the warm mute gate keys ONLY off an explicit conversationId', () => {
  it('an explicit muted conversationId suppresses the banner (but never the pull)', async () => {
    mutedMock.mockImplementation(async (o: {conversationId?: string}) => o.conversationId === 'conv-m');
    await wake({kind: 'msg-wake', conversationId: 'conv-m', senderUserId: 'peer-1'});

    expect(mutedMock).toHaveBeenCalledWith({conversationId: 'conv-m'});
    expect(show).not.toHaveBeenCalled();
    // Mute silences the UI, not the envelope pull — the message still lands.
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('muted + notifier alive → the P2-6 fallback stays silent too', async () => {
    running.mockImplementation(() => true);
    mutedMock.mockImplementation(async () => true);
    await wake({kind: 'msg-wake', conversationId: 'conv-m', senderUserId: 'peer-1'});

    // Generation did not advance, but `muted` vetoes the fallback: a muted
    // conversation must not resurface through the fallback lane.
    expect(show).not.toHaveBeenCalled();
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it('a DM resolved from senderUserId NEVER consults the mute list (heuristic ≠ explicit)', async () => {
    // B-411 — the lane titles from `bannerTitle` (the tagged/laundered
    // variant); `name` is the untagged display name for route params.
    resolveDM.mockImplementation(async () => ({id: 'dm-1', name: 'Alice', bannerTitle: 'Alice'}));
    await wake({kind: 'msg-wake', senderUserId: 'peer-1'});

    // The sender's 1:1 being muted must not silence a possible GROUP message,
    // so the mute lookup is not even consulted without an explicit conv id.
    expect(mutedMock).not.toHaveBeenCalled();
    // B-710 — the resolved DM is a GUESS, and a guess no longer KEYS the banner:
    // this draw carries no body, so keying it on the DM put it on the same
    // notifee id as the store notifier's rich card and replaced it (and for a
    // group message it captioned the sender's 1:1). It still ROUTES the tap, via
    // `convRouteHint` + `convUnconfirmed`, which is what B-324 actually needs.
    expect(show).toHaveBeenCalledTimes(1);
    // B-692 NL-2 — wakeFallback: an alerted generic wake draw opens the
    // collapse window so the notifier's named upgrade can't double-sound.
    expect(show.mock.calls[0][0]).toEqual({
      conversationId: undefined,
      convRouteHint: 'dm-1',
      senderUserId: 'peer-1',
      title: 'Alice',
      convUnconfirmed: true,
      wakeFallback: true,
    });
  });
});

describe('P1-8 / P2-6 — notifier deferral and the generation-gated fallback', () => {
  it('notifier alive → no immediate FCM banner; the fallback posts AFTER the pull when the generation did not advance', async () => {
    running.mockImplementation(() => true);
    await wake({kind: 'msg-wake', senderUserId: 'peer-1'});

    // Exactly ONE banner: the fallback. An immediate draw would have made two.
    expect(show).toHaveBeenCalledTimes(1);
    expect(pullMock).toHaveBeenCalledTimes(1);
    expect(pullMock.mock.invocationCallOrder[0]).toBeLessThan(show.mock.invocationCallOrder[0]);
  });

  it('no fallback when the notifier posted during the pull (generation advanced)', async () => {
    running.mockImplementation(() => true);
    pullMock = jest.fn(async () => { genValue++; }); // the notifier drew a banner mid-pull
    await wake({kind: 'msg-wake', senderUserId: 'peer-1'});

    expect(pullMock).toHaveBeenCalledTimes(1);
    expect(show).not.toHaveBeenCalled(); // neither immediate nor fallback
  });

  it('B-703 MR-19 — a cue that was ATTEMPTED but FAILED to draw still gets the fallback', async () => {
    running.mockImplementation(() => true);
    // The notifier bumped its generation (synchronously, by contract) and then
    // notifee refused the display / the in-app layer was not mounted. The old
    // rule read only the generation, called that "a banner exists", and the
    // message produced ZERO user-visible signal.
    pullMock = jest.fn(async () => { genValue++; failValue++; });
    await wake({kind: 'msg-wake', conversationId: 'conv-9', senderUserId: 'peer-1'});

    expect(pullMock).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
    // B-710 re-point: the wake now also NAMES ITS SENDER. Without it
    // `shouldAlert` takes the anonymous arm and arms the process-wide 10 s
    // window, silencing every other conversation. The invariant this case
    // exists for — a failed cue still gets its fallback, conv-keyed — is
    // asserted directly rather than by exact object shape.
    expect(show.mock.calls[0][0]).toMatchObject({conversationId: 'conv-9', wakeFallback: true});
    expect(show.mock.calls[0][0].senderUserId).toBe('peer-1');
  });

  it('B-703 MR-19/MR-10 — the witness is snapshotted at handler ENTRY, not after the awaits', async () => {
    running.mockImplementation(() => true);
    await wake({kind: 'msg-wake', conversationId: 'conv-9', senderUserId: 'peer-1'});

    expect(snapCues).toHaveBeenCalledWith('conv-9');
    expect(cueDelivered).toHaveBeenCalledWith(
      expect.objectContaining({gen: 0, failures: 0, conversationId: 'conv-9'}),
      expect.objectContaining({senderUserId: 'peer-1'}),
    );
    // MR-10: it must precede EVERY await in the handler — the mute lookup and
    // the runtime boot included. Snapshotting after them made a banner the live
    // WS lane drew during those awaits invisible, and the handler posted a
    // duplicate generic one over it.
    expect(snapCues.mock.invocationCallOrder[0]).toBeLessThan(mutedMock.mock.invocationCallOrder[0]);
    expect(snapCues.mock.invocationCallOrder[0]).toBeLessThan(getRuntime.mock.invocationCallOrder[0]);
    expect(snapCues.mock.invocationCallOrder[0]).toBeLessThan(pullMock.mock.invocationCallOrder[0]);
  });

  it('B-703 MR-10 — the witness is asked WHO sent it, so it can claim that sender\'s cue', async () => {
    running.mockImplementation(() => true);
    // The server puts no conversationId on a chat wake, so the sender is the
    // ONLY attribution available. Without it the witness can claim nothing and
    // every wake whose cue landed before it started draws a duplicate.
    await wake({kind: 'msg-wake', senderUserId: 'peer-1'});

    expect(cueDelivered).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({senderUserId: 'peer-1'}),
    );
    expect(pullMock).toHaveBeenCalledTimes(1); // the pull is never skipped
  });

  it('B-703 MR-10 — the witness is only consulted when a fallback could actually draw', async () => {
    // Critic F11: it was evaluated ahead of the short-circuit, spending a
    // bounded wait of Doze budget on wakes that cannot draw anything.
    running.mockImplementation(() => false);
    await wake({kind: 'msg-wake', senderUserId: 'peer-1'});
    expect(cueDelivered).not.toHaveBeenCalled();

    cueDelivered.mockClear();
    running.mockImplementation(() => true);
    mutedMock.mockImplementation(async () => true);
    await wake({kind: 'msg-wake', conversationId: 'conv-m', senderUserId: 'peer-1'});
    expect(cueDelivered).not.toHaveBeenCalled();
  });

  it('fallback keying: an explicit conversationId stays conv-keyed', async () => {
    running.mockImplementation(() => true);
    await wake({kind: 'msg-wake', conversationId: 'conv-9', senderUserId: 'peer-1'});

    expect(show).toHaveBeenCalledTimes(1);
    // The KEYING is what this case pins: an unambiguous wake stays conv-keyed,
    // and in particular never falls back to the heuristic DM (the case below).
    // B-710 re-point: `senderUserId` now rides alongside — it does NOT change
    // the notifee id (`conversationId` wins in `showMessageNotif`), it scopes
    // the alert-collapse window to this sender instead of gagging every
    // conversation for 10 s. `convRouteHint` must stay absent: the conversation
    // here is wire truth, not a guess.
    const arg = show.mock.calls[0][0];
    expect(arg.conversationId).toBe('conv-9');
    expect(arg.wakeFallback).toBe(true);
    expect(arg.senderUserId).toBe('peer-1');
    expect(arg.convRouteHint).toBeUndefined();
    expect(arg.convUnconfirmed).toBeFalsy();
  });

  it('fallback keying: sender-keyed generic — NEVER the heuristically-resolved DM (misattribution guard)', async () => {
    running.mockImplementation(() => true);
    // B-411 — the lane titles from `bannerTitle` (the tagged/laundered
    // variant); `name` is the untagged display name for route params.
    resolveDM.mockImplementation(async () => ({id: 'dm-1', name: 'Alice', bannerTitle: 'Alice'}));
    await wake({kind: 'msg-wake', senderUserId: 'peer-1'});

    expect(show).toHaveBeenCalledTimes(1);
    // Keying the fallback to the resolved 1:1 would deep-link a GROUP message
    // into the sender's DM thread — the exact P1-8 misattribution.
    // (wakeFallback rides every generic wake draw — B-692 NL-2.)
    expect(show.mock.calls[0][0]).toStrictEqual({senderUserId: 'peer-1', wakeFallback: true});
    // The deferred lane never even resolves the DM.
    expect(resolveDM).not.toHaveBeenCalled();
  });
});

describe('short-circuit kinds and the B-107 restore gate', () => {
  it('call-cancel tears down the ring and never touches the msg-wake lane', async () => {
    await wake({kind: 'call-cancel', callId: 'call-1'});

    expect(dismissRing).toHaveBeenCalledWith('call-1');
    expect(show).not.toHaveBeenCalled();
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it('voip-wake is verifier-gated and never falls through to the msg-wake lane', async () => {
    await wake({kind: 'voip-wake', callId: 'call-2', sig: 'forged'});

    expect(verify).toHaveBeenCalledTimes(1);
    expect(showRing).not.toHaveBeenCalled(); // bad-sig verdict → dropped, no ring spam
    expect(show).not.toHaveBeenCalled();
    expect(getRuntime).not.toHaveBeenCalled();
  });

  it('B-107 — restore mode blocks the runtime boot; the pre-pull banner still draws', async () => {
    setRestoreModeActive(true);
    await wake({kind: 'msg-wake', conversationId: 'conv-1'});

    // The banner block runs (UI is safe); the runtime boot — installIdentity /
    // bundle publish, the Round-8 stranded-backup class — must not.
    expect(show).toHaveBeenCalledTimes(1);
    expect(getRuntime).not.toHaveBeenCalled();

    // Control: the same wake boots the runtime once restore mode lifts.
    setRestoreModeActive(false);
    await wake({kind: 'msg-wake', conversationId: 'conv-1'});
    expect(getRuntime).toHaveBeenCalledTimes(1);
  });
});

// ── M16 static scan ──────────────────────────────────────────────────────────
// backgroundMessageNotifier's rollback behaviour is covered behaviourally in
// backgroundMessageNotifier.test.ts; what no behavioural test can pin is that
// onAfterCommit stays the ONLY post seam — a second, direct post site would
// reintroduce banners for uncommitted rows while that suite stayed green.

const NOTIFIER_SRC = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'backgroundMessageNotifier.ts');
const HEADLESS_SRC = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmHeadless.ts');

/** Strip `//` line and block comments so a scan sees CODE, not prose (the
 *  files are CRLF; index-based checks below are line-ending agnostic). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

describe('M16 — the store-notifier banner posts ONLY via the onAfterCommit seam (static scan)', () => {
  const stripped = stripComments(readFileSync(NOTIFIER_SRC, 'utf8'));

  it('imports onAfterCommit from the receive transaction module', () => {
    expect(stripped).toMatch(/import \{onAfterCommit\} from '\.\.\/runtime\/receiveTransaction';/);
  });

  it('the single post() call site sits inside the onAfterCommit callback', () => {
    const postCalls = stripped.match(/void post\(/g) ?? [];
    expect(postCalls).toHaveLength(1);

    // B-692 re-point: the notifier now opens EARLIER onAfterCommit seams for
    // the foreground in-app lane, so anchor on the seam NEAREST the post site
    // rather than the file's first. Intent unchanged: nothing posts outside
    // an onAfterCommit callback.
    const post = stripped.indexOf('void post(');
    const seam = stripped.lastIndexOf('onAfterCommit(', post);
    expect(seam).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(seam);
    // The callback body between the seam open and its first close must be the
    // one carrying the post — nothing may post outside it.
    const closing = stripped.indexOf('});', seam);
    expect(post).toBeLessThan(closing);
  });

  it('B-692 — every foreground in-app notify site sits inside an onAfterCommit callback too', () => {
    // M16 extends to the in-app lane: a rolled-back receive txn must make no
    // sound and show no in-app banner. A notify call hoisted out of its seam
    // would land after some EARLIER seam whose closing precedes it — red.
    const sites = [...stripped.matchAll(/notifyForegroundMessage\(\{/g)].map(m => m.index ?? -1);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const site of sites) {
      const seam = stripped.lastIndexOf('onAfterCommit(', site);
      expect(seam).toBeGreaterThan(-1);
      const closing = stripped.indexOf('});', seam);
      expect(site).toBeLessThan(closing);
    }
  });

  it('showMessageNotif is invoked ONLY inside the post() → drawBanner() pair', () => {
    const calls = stripped.match(/showMessageNotif\(/g) ?? [];
    expect(calls).toHaveLength(1);

    // B-703 MR-19 re-point. The draw moved out of post() into drawBanner()
    // (post() now registers it as a pending cue and awaits it), and drawBanner
    // happens to sit in the window this used to scan — so the old anchor kept
    // passing while its own stated invariant had become false. Anchor on the
    // function that actually contains the call.
    const drawFn = stripped.indexOf('async function drawBanner(');
    const nextFn = stripped.indexOf('async function dismiss(');
    expect(drawFn).toBeGreaterThan(-1);
    expect(nextFn).toBeGreaterThan(drawFn);
    const site = stripped.indexOf('await showMessageNotif(');
    expect(site).toBeGreaterThan(drawFn);
    expect(site).toBeLessThan(nextFn);
    // ...and drawBanner is reachable only from post(): one call, inside it.
    const postFn = stripped.indexOf('async function post(');
    const postBody = stripped.slice(postFn, drawFn);
    expect(postFn).toBeGreaterThan(-1);
    expect(postFn).toBeLessThan(drawFn);
    expect(stripped.match(/drawBanner\(/g) ?? []).toHaveLength(2); // the definition + the one call
    expect(postBody).toContain('drawBanner(conversationId, opts)');
  });

  it('P2-6 rider: the generation bump is synchronous — first statement of post(), above any await', () => {
    const postFn = stripped.indexOf('async function post(');
    const body   = stripped.slice(postFn, stripped.indexOf('async function drawBanner('));
    const bump   = body.indexOf('messagePostedGeneration++');
    const firstAwait = body.indexOf('await');
    expect(bump).toBeGreaterThan(-1);
    expect(firstAwait).toBeGreaterThan(-1);
    // If the bump slid below an await, the FCM handler's genBefore/genAfter
    // comparison could read a stale generation and double-banner.
    expect(bump).toBeLessThan(firstAwait);
  });

  it('B-703 MR-19 — both wake lanes ask the WITNESS, never the raw generation', () => {
    // The behavioural pins above run against a MOCKED notifier, so they can only
    // prove the lane consumes what it is given. This proves the lane consumes
    // the right thing: a direct `getMessagePostedGeneration()` read in either
    // handler reintroduces the whole bug (a failed draw reads as a banner).
    const lanes = ['fcmBootstrap.ts', 'fcmHeadless.ts'] as const;
    for (const f of lanes) {
      const src = readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'push', f), 'utf8')
        .split(/\r?\n/)
        .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
        .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
        .join('\n');
      expect(src).toContain('cueDeliveredSince(');
      expect(src).toContain('snapshotCues(');
      expect(src).not.toContain('getMessagePostedGeneration');
    }
  });

  it('B-703 MR-19 — the killed lane\'s cue wait fits INSIDE its Doze window', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmHeadless.ts'), 'utf8');
    const drain  = Number(/const HEADLESS_DRAIN_BUDGET_MS = (\d+);/.exec(src)?.[1]);
    const verdict = Number(/const HEADLESS_CUE_VERDICT_BUDGET_MS = (\d+);/.exec(src)?.[1]);
    expect(Number.isFinite(drain)).toBe(true);
    expect(Number.isFinite(verdict)).toBe(true);
    // The verdict wait is spent AFTER the drain race, and the fallback draw
    // (mute lookup + conversation resolve + unread + display) still has to fit
    // in the ~10 s high-priority wake window.
    expect(drain + verdict).toBeLessThanOrEqual(8_500);
    // ...and it must actually be passed, not left on the shared default.
    // B-710 — anchored on the SHAPE, not a byte-exact one-liner: the call now
    // also names its sender (so `claimCueToken` can answer at all) and spans
    // several lines. A literal-substring scan on a formatting choice is the
    // character-window trap that has gone vacuously green in this repo before.
    // Critic D4 — strip comments FIRST. `.exec` takes the first match, and a
    // multi-line B-710 comment sits directly above the call site: an un-stripped
    // scan reads the prose instead of the code. This repo has lost a session to
    // exactly that. Also match balanced-ish options text rather than `[^}]*`,
    // which truncates at the first nested brace.
    // Named apart from the describe-level `stripped` (which strips a DIFFERENT
    // file): shadowing it tripped no-shadow, and more to the point a reader of
    // this assertion could not tell which source was being scanned.
    const strippedSrc = src
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    const call = /cueDeliveredSince\(\s*cuesBefore\s*,[\s\S]{0,300}?\)\s*;/.exec(strippedSrc)?.[0] ?? '';
    expect(call).not.toBe('');
    expect(call).toContain('budgetMs: HEADLESS_CUE_VERDICT_BUDGET_MS');
    // B-710 — and it must name the sender with a real value: without it
    // `claimCueToken` returns false on sight and the one-cue-one-wake ledger is
    // inert on this lane. `senderUserId: undefined` is that inert state, so the
    // scan must reject it explicitly.
    expect(call).toMatch(/senderUserId\s*:/);
    expect(call).not.toMatch(/senderUserId\s*:\s*undefined/);
  });
});

describe('launcher badge coverage on the FCM lanes (B-231)', () => {
  // B-231: showMessageNotif only touched the launcher badge when a numeric
  // badgeCount was passed (N-17 "omitted when unknown so we never clobber a real
  // count"), and the only caller that passed one was backgroundMessageNotifier.
  // Now every FCM-lane draw (killed headless, warm direct, P2-6 fallback) reads
  // the persisted unread mirror via resolveTotalUnread() and passes it, so a
  // killed/backgrounded device's badge no longer goes stale. A null read still
  // OMITS the badge (never clobbers a real count with a guess).
  it('FCM-lane banners carry the resolved unread badge, and OMIT it when the mirror read is null', async () => {
    // Behavioural: warm direct draw (notifier down) carries the resolved badge.
    resolveMeta.mockImplementation(async () => ({name: 'Ops Team'}));
    resolveUnread.mockImplementation(async () => 4);
    await wake({kind: 'msg-wake', conversationId: 'conv-1'});
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0].badgeCount).toBe(4);

    // Behavioural: the P2-6 fallback carries it too.
    show.mockClear();
    running.mockImplementation(() => true);
    resolveUnread.mockImplementation(async () => 7);
    await wake({kind: 'msg-wake', conversationId: 'conv-1'});
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0].badgeCount).toBe(7);

    // N-17 preserved: a null mirror read OMITS the badge (undefined → showMessageNotif
    // drops it) rather than clobbering the launcher with 0.
    show.mockClear();
    running.mockImplementation(() => false);
    resolveUnread.mockImplementation(async () => null);
    await wake({kind: 'msg-wake', conversationId: 'conv-1'});
    expect(show).toHaveBeenCalledTimes(1);
    expect(show.mock.calls[0][0].badgeCount).toBeUndefined();

    // Static: the killed headless lane now has badge plumbing.
    expect(stripComments(readFileSync(HEADLESS_SRC, 'utf8'))).toContain('badgeCount');
  });
});
