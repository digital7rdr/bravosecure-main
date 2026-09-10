/**
 * Server-wake tap routing map parity — produced kinds vs routed kinds.
 *
 * CRIT-5 made `serverWakeNotifications.AGENT_WAKE_META` the single producer of
 * server-wake notifications (warm + killed paths), and LM-N2/LB-N made
 * `fcmBootstrap.routeServerWakeTap` (+ CLIENT_STAGE_SCREEN) the single tap
 * consumer. Nothing ties the two files together at compile time, so a kind
 * added to the producer without a route entry silently regresses to the
 * pre-LM-N2 behaviour: the banner draws, the tap opens the app "wherever it
 * was" (N-21 shipped exactly this way for `incident-*` on the PRODUCER side).
 * This suite diffs the two kind sets both ways so the maps cannot drift.
 *
 * Also pinned here:
 *   - the bookingId shape-validation regex is applied BEFORE the id is
 *     threaded into navigation params, and the literal is identical on the
 *     producer (serverWakeNotifications) and consumer (routeServerWakeTap)
 *     sides;
 *   - the CLIENT_STAGE_SCREEN comment contract ("Every target here needs only
 *     {bookingId}") against navigation/types.ts, so a target can never grow a
 *     required param the tap route does not supply;
 *   - tap consumption ordering (P1-7 class): routeServerWakeTap is consulted
 *     BEFORE the missed-call branch and BEFORE the call branch, so a server
 *     kind that happens to carry a callId can never mount a ghost CallScreen.
 *
 * fcmBootstrap imports react-native / firebase at module top, so the map
 * contents are pinned by STATIC SOURCE SCAN (same pattern as
 * messageTopologyInvariants.test.ts — files are CRLF, comments are stripped
 * before any ordering/absence assertion). The behavioural cases load the
 * module under the same mock harness fcmBootstrapOrder.test.ts already proves
 * out.
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
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://msg.test', API_BASE_URL: 'https://api.test'}));
jest.mock('@services/api', () => ({refreshAccessTokenShared: jest.fn(async () => {})}), {virtual: true});

jest.mock('@react-native-firebase/messaging', () => {
  const api = {
    // Resolves immediately so the Promise.race deadline timer is cleared and
    // no register fetch ever fires — this suite never exercises the register.
    getToken:                    jest.fn(async () => null),
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
    onBackgroundEvent:      jest.fn(),
    onForegroundEvent:      jest.fn(),
    getInitialNotification: jest.fn(async () => null),
    displayNotification:    jest.fn(async () => {}),
    cancelNotification:     jest.fn(async () => {}),
    createChannel:          jest.fn(async () => 'ch'),
    deleteChannel:          jest.fn(async () => {}),
  },
  AndroidImportance: {HIGH: 4, DEFAULT: 3, LOW: 2},
  AndroidCategory:   {MESSAGE: 'msg', CALL: 'call'},
  AndroidVisibility: {PRIVATE: 0, PUBLIC: 1},
  AndroidStyle:      {BIGTEXT: 1, MESSAGING: 2},
  EventType:         {PRESS: 1, ACTION_PRESS: 2},
}));

const mockNav = jest.fn();
jest.mock('@navigation/navigationRef', () => ({
  navigationRef: {isReady: () => true, navigate: (n: string, p?: unknown) => mockNav(n, p)},
}));
jest.mock('../push/callKitBridge', () => ({
  setupCallKit:             jest.fn(async () => {}),
  subscribeToCallKitEvents: jest.fn(() => () => {}),
  bringAppToForeground:     jest.fn(),
  reportEnded:              jest.fn(),
}));
jest.mock('../push/voipPush', () => ({startVoipPushBootstrap: jest.fn(async () => {})}));
jest.mock('../push/backgroundMessageNotifier', () => ({
  startBackgroundMessageNotifier:      jest.fn(),
  stopBackgroundMessageNotifier:       jest.fn(),
  isBackgroundMessageNotifierRunning:  jest.fn(() => false),
  getMessagePostedGeneration:          jest.fn(() => 0),
  snapshotCues:                        jest.fn(() => ({gen: 0, failures: 0})),
  cueDeliveredSince:                   jest.fn(async () => false),
}));
jest.mock('@/modules/messenger/runtime/transportRegistry', () => ({getLiveTransport: () => null}));

const PRESS = 1;

const SWN_PATH  = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'serverWakeNotifications.ts');
const BOOT_PATH = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');
const NAV_PATH  = join(process.cwd(), 'src', 'navigation', 'types.ts');

/** Strip `//` line and block comments so a scan sees CODE, not prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/** Slice [startMarker, endMarker) — both must exist, endMarker after start. */
function sliceBetween(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** Kinds the producer can draw a notification for (AGENT_WAKE_META keys plus
 *  any `kind === '…'` special branch inside showServerWakeNotification). */
function producedKinds(): Set<string> {
  const src = stripComments(readFileSync(SWN_PATH, 'utf8'));
  const out = new Set<string>();
  // Object keys of AGENT_WAKE_META (block ends at the first column-0 `};`).
  const metaBlock = sliceBetween(src, 'const AGENT_WAKE_META', '\n};');
  for (const m of metaBlock.matchAll(/'([a-z0-9.-]+)':\s*\{/g)) { out.add(m[1]); }
  // Special display branches (today: booking-approved). The lookbehind keeps
  // `typeof data.kind === 'string'` from injecting a phantom 'string' kind.
  const fnBody = src.slice(src.indexOf('export async function showServerWakeNotification'));
  expect(fnBody.length).toBeGreaterThan(0);
  for (const m of fnBody.matchAll(/(?<![\w.$])kind === '([a-z0-9.-]+)'/g)) { out.add(m[1]); }
  return out;
}

/** The comment-stripped body of routeServerWakeTap (incl. nothing after it). */
function routeTapBody(): string {
  const src = readFileSync(BOOT_PATH, 'utf8');
  return stripComments(sliceBetween(src, 'function routeServerWakeTap', 'export function resolveIncomingCallRoute'));
}

/** CLIENT_STAGE_SCREEN as kind → target-screen map. */
function clientStageScreen(): Map<string, string> {
  const src = stripComments(readFileSync(BOOT_PATH, 'utf8'));
  const block = sliceBetween(src, 'const CLIENT_STAGE_SCREEN', '\n};');
  const map = new Map<string, string>();
  for (const m of block.matchAll(/'([a-z0-9-]+)':\s*'([A-Za-z]+)'/g)) { map.set(m[1], m[2]); }
  return map;
}

/** Kinds routeServerWakeTap consumes (explicit branches + stage-screen keys). */
function routedKinds(): Set<string> {
  const out = new Set<string>();
  for (const m of routeTapBody().matchAll(/(?<![\w.$])kind === '([a-z0-9.-]+)'/g)) { out.add(m[1]); }
  for (const k of clientStageScreen().keys()) { out.add(k); }
  return out;
}

// A produced kind whose tap is INTENTIONALLY not deep-linked lands here with a
// reason. Empty today: every kind the producer draws has a tap route.
const UNROUTED_ALLOWLIST: string[] = [];
// A routed kind not produced by serverWakeNotifications would be dead map
// weight (or a producer regression). Empty today.
const ROUTED_ONLY_ALLOWLIST: string[] = [];

describe('server-wake kind-set parity (static scan)', () => {
  it('extraction sanity — the scans see the real maps, not vacuous slices', () => {
    const produced = producedKinds();
    const routed = routedKinds();
    // If either extraction regresses to ~0 entries, every diff below would
    // pass vacuously — pin known sentinels and a floor.
    expect(produced.size).toBeGreaterThanOrEqual(20);
    for (const k of ['sos-cpo-alert', 'dispatch-offer', 'incident-submitted', 'detail-live', 'booking-approved']) {
      expect(produced).toContain(k);
    }
    expect(routed.size).toBeGreaterThanOrEqual(20);
    expect(routed).toContain('crew-assigned');
    // The stage-screen keys only count as "routed" because routeServerWakeTap
    // actually consults the map.
    expect(routeTapBody()).toMatch(/CLIENT_STAGE_SCREEN\[kind\]/);
  });

  it('every produced kind is matched by a routeServerWakeTap branch / stage-screen entry (or allow-listed)', () => {
    const routed = routedKinds();
    const unrouted = [...producedKinds()]
      .filter(k => !routed.has(k) && !UNROUTED_ALLOWLIST.includes(k))
      .sort();
    // A kind listed here draws a banner whose tap falls through to the OS
    // default — the pre-LM-N2 dead-tap regression. Route it or allow-list it.
    expect(unrouted).toEqual([]);
  });

  it('every routed kind is actually produced (no dead route entries)', () => {
    const produced = producedKinds();
    const dead = [...routedKinds()]
      .filter(k => !produced.has(k) && !ROUTED_ONLY_ALLOWLIST.includes(k))
      .sort();
    expect(dead).toEqual([]);
  });
});

describe('bookingId shape validation (static scan)', () => {
  it('producer and tap route apply the IDENTICAL shape regex', () => {
    const tapMatch = /(\/\^\S+\/)\.test\(rawId\)/.exec(routeTapBody());
    const swnBody = stripComments(readFileSync(SWN_PATH, 'utf8'));
    const producerMatch = /(\/\^\S+\/)\.test\(bookingId\)/.exec(swnBody);
    expect(tapMatch).not.toBeNull();
    expect(producerMatch).not.toBeNull();
    expect(tapMatch![1]).toBe(producerMatch![1]);
  });

  it('routeServerWakeTap validates BEFORE building candidates and threads only the validated id', () => {
    const body = routeTapBody();
    const idxTest = body.indexOf('.test(rawId)');
    const idxCandidates = body.indexOf('candidates');
    expect(idxTest).toBeGreaterThan(-1);
    expect(idxCandidates).toBeGreaterThan(-1);
    expect(idxTest).toBeLessThan(idxCandidates);
    // Params carry the validated `bid`, never the raw payload field.
    expect(body).toMatch(/bookingId:\s*bid\b/);
    expect(body).not.toMatch(/bookingId:\s*(?:rawId\b|data\.bookingId)/);
    // The raw field is read exactly once — into the variable the regex gates.
    expect(body.match(/data\.bookingId/g)).toHaveLength(1);
  });
});

describe('CLIENT_STAGE_SCREEN targets require only {bookingId} (navigation/types.ts)', () => {
  const navSrc = stripComments(readFileSync(NAV_PATH, 'utf8'));
  const bookingBlock = sliceBetween(navSrc, 'export type BookingStackParamList = {', '\n};');

  /** The type of one route entry, sliced by brace-aware scan to its `;`. */
  function routeEntryType(route: string): string {
    const m = new RegExp('(^|\\r?\\n)\\s{2}' + route + ':').exec(bookingBlock);
    expect(m).not.toBeNull();
    let i = m!.index + m![0].length;
    const start = i;
    let depth = 0;
    for (; i < bookingBlock.length; i++) {
      const ch = bookingBlock[i];
      if (ch === '{' || ch === '(' || ch === '<' || ch === '[') { depth++; }
      else if (ch === '}' || ch === ')' || ch === '>' || ch === ']') { depth--; }
      else if (ch === ';' && depth === 0) { break; }
    }
    return bookingBlock.slice(start, i).trim();
  }

  /** Non-optional property names across every object literal in the type. */
  function requiredProps(typeStr: string): string[] {
    const props: string[] = [];
    let depth = 0;
    let objStart = -1;
    for (let i = 0; i < typeStr.length; i++) {
      const ch = typeStr[i];
      if (ch === '{') { if (depth === 0) { objStart = i + 1; } depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          for (const part of typeStr.slice(objStart, i).split(';')) {
            const pm = /^\s*([A-Za-z_][A-Za-z0-9_]*)(\??):/.exec(part);
            if (pm && pm[2] !== '?') { props.push(pm[1]); }
          }
          objStart = -1;
        }
      }
    }
    return props;
  }

  // Every navigable target: stage-screen values plus the two the sos branch /
  // bid-absent degrade use directly ('LiveTracking' / 'BookingHome').
  const targets = [...new Set([...clientStageScreen().values(), 'LiveTracking', 'BookingHome'])].sort();

  it('every target screen exists in BookingStackParamList', () => {
    for (const t of targets) {
      expect(routeEntryType(t).length).toBeGreaterThan(0);
    }
  });

  it('no target requires a param other than bookingId', () => {
    // The comment contract on CLIENT_STAGE_SCREEN: "Every target here needs
    // only {bookingId}". A target that grows another REQUIRED param mounts
    // with it undefined on every wake tap.
    const offenders: string[] = [];
    for (const t of targets) {
      const extra = requiredProps(routeEntryType(t)).filter(p => p !== 'bookingId');
      if (extra.length > 0) { offenders.push(`${t}: ${extra.join(',')}`); }
    }
    expect(offenders).toEqual([]);
  });

  it('the bid-absent degrade target BookingHome takes no params at all', () => {
    // routeServerWakeTap falls back to {screen:'BookingHome', params:undefined}
    // when the bookingId fails shape validation — that only holds while the
    // route accepts undefined params.
    expect(routeEntryType('BookingHome')).toBe('undefined');
  });
});

describe('tap consumption ordering (static scan)', () => {
  it('routeServerWakeTap is consulted before the missed-call branch, which precedes the call branch', () => {
    const src = readFileSync(BOOT_PATH, 'utf8');
    const handleBody = stripComments(sliceBetween(src, 'const handle = async', 'notifee.onForegroundEvent'));
    const iRoute  = handleBody.indexOf('routeServerWakeTap(');
    const iMissed = handleBody.indexOf("data.kind === 'missed-call'");
    const iCall   = handleBody.indexOf('const callId = data.callId');
    expect(iRoute).toBeGreaterThan(-1);
    expect(iMissed).toBeGreaterThan(-1);
    expect(iCall).toBeGreaterThan(-1);
    expect(iRoute).toBeLessThan(iMissed);
    expect(iMissed).toBeLessThan(iCall);
    // The consult must short-circuit — a consumed server kind returns before
    // the later branches can even look at callId.
    expect(handleBody).toMatch(/routeServerWakeTap\(data\.kind,\s*data\)\)\s*\{\s*return;\s*\}/);
  });
});

/** jest.resetModules is never called here, but keep the anchor-suite accessor. */
function nf(): Record<string, jest.Mock> {
  return (require('@notifee/react-native') as {default: Record<string, jest.Mock>}).default;
}

describe('behavioral — tap routing through the notifee handler', () => {
  let bgHandler: (ev: unknown) => Promise<void>;

  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) { await Promise.resolve(); }
  };

  beforeAll(async () => {
    const boot = require('../push/fcmBootstrap') as typeof import('../push/fcmBootstrap');
    await boot.startFcmBootstrap();
    bgHandler = nf().onBackgroundEvent.mock.calls.at(-1)![0] as (ev: unknown) => Promise<void>;
  });

  beforeEach(() => {
    mockNav.mockClear();
    nf().displayNotification.mockClear();
    nf().cancelNotification.mockClear();
  });

  function press(data: Record<string, string>): unknown {
    return {type: PRESS, detail: {notification: {data}, pressAction: {id: 'default'}}};
  }

  it('deep-links a client stage kind with a valid bookingId to its stage screen', async () => {
    const bookingId = '0abc1234-dead-beef-0000-111122223333';
    await bgHandler(press({kind: 'crew-assigned', bookingId}));
    await flush();
    // BB-3 — initial: false seeds BookingHome beneath the stage screen on a
    // cold start, so back works (flagless = the target became the only route).
    expect(mockNav).toHaveBeenCalledWith('SecureTab', {screen: 'LiveTracking', initial: false, params: {bookingId}});
  });

  it('degrades a bad-shape bookingId to BookingHome without threading the raw id', async () => {
    await bgHandler(press({kind: 'crew-assigned', bookingId: 'ZZZ-not-a-booking-id'}));
    await flush();
    expect(mockNav).toHaveBeenCalledWith('SecureTab', {screen: 'BookingHome', initial: false, params: undefined});
    expect(JSON.stringify(mockNav.mock.calls)).not.toContain('ZZZ-not-a-booking-id');
  });

  it('a server kind carrying a callId routes as a server wake — never into the call branch', async () => {
    // P1-7 class: the call branch would dismiss `bravo-call-<id>` and mount an
    // incoming CallScreen for a call that does not exist.
    await bgHandler(press({kind: 'sos-cpo-alert', callId: 'c-99', missionId: 'm-7'}));
    await flush();
    expect(mockNav).toHaveBeenCalledWith('CpoMission', undefined);
    expect(mockNav).toHaveBeenCalledWith('SecureTab', {screen: 'BookingHome', initial: false, params: undefined});
    expect(JSON.stringify(mockNav.mock.calls)).not.toContain('CallScreen');
    expect(nf().cancelNotification).not.toHaveBeenCalled();
  });
});

describe('behavioral — producer-side bookingId validation (serverWakeNotifications)', () => {
  const swn = (): typeof import('../push/serverWakeNotifications') =>
    require('../push/serverWakeNotifications') as typeof import('../push/serverWakeNotifications');

  beforeEach(() => {
    nf().displayNotification.mockClear();
    nf().createChannel.mockClear();
  });

  it('rejects a bad-shape bookingId before threading it into notifee data (kind still consumed)', async () => {
    const handled = await swn().showServerWakeNotification({kind: 'booking-approved', bookingId: 'not$a$uuid'});
    expect(handled).toBe(true);
    expect(nf().displayNotification).not.toHaveBeenCalled();
  });

  it('threads ONLY {kind, bookingId} for a valid booking-approved wake', async () => {
    const bookingId = '0abc1234-dead-beef-0000-111122223333';
    const handled = await swn().showServerWakeNotification({
      kind: 'booking-approved',
      bookingId,
      stray: 'field-not-needed-by-the-tap-route',
    });
    expect(handled).toBe(true);
    expect(nf().displayNotification).toHaveBeenCalledTimes(1);
    const arg = nf().displayNotification.mock.calls[0][0] as {id: string; data: Record<string, unknown>};
    expect(arg.id).toBe(`booking-approved-${bookingId}`);
    expect(arg.data).toEqual({kind: 'booking-approved', bookingId});
  });

  it('AGENT_WAKE_META display filters non-string wake-data values before notifee, so a nested object cannot blank the banner (B-234 fixed)', async () => {
    // B-234: RNFirebase types a push's data as `{[k: string]: string | object}`
    // (nested objects are real on the iOS lane), and notifee rejects the WHOLE
    // displayNotification on a non-string value. The meta branch now filters to
    // string values before display (only string fields were ever read), so a
    // nested-object field is dropped and the banner still draws.
    const handled = await swn().showServerWakeNotification({
      kind: 'agent-approved',
      eventId: 'evt-1',
      opaque: {nested: 'x'},
    });
    expect(handled).toBe(true);
    expect(nf().displayNotification).toHaveBeenCalledTimes(1);
    const arg = nf().displayNotification.mock.calls[0][0] as {id: string; data: Record<string, unknown>};
    expect(arg.id).toBe('agent-approved-evt-1');
    // The non-string field was dropped; every surviving value is a string.
    expect(arg.data.opaque).toBeUndefined();
    expect(Object.values(arg.data).every(v => typeof v === 'string')).toBe(true);
  });

  /**
   * Client review vs2 item 16 — "identify the organisation, state that an
   * incident was reported, identify the reporter… Do not state CPO as not all
   * organizations have CPOs."
   *
   * Rendered, not scanned: the composition is per-event, so a source scan
   * cannot tell a working banner from a broken one.
   */
  describe('item 16 — incident banner names the org and the reporter', () => {
    it('composes both when the payload carries them', async () => {
      await swn().showServerWakeNotification({
        kind: 'incident-submitted', eventId: 'e1',
        orgName: 'SASFA', reporterName: 'Lerato M', incidentId: 'inc-1',
      });
      const arg = nf().displayNotification.mock.calls[0][0] as {title: string; body: string};
      expect(arg.title).toBe('SASFA: incident reported');
      expect(arg.body).toBe('Reported by Lerato M. Tap to review.');
    });

    it('falls back to generic copy on an OLD server (no names) — and never says CPO', async () => {
      await swn().showServerWakeNotification({kind: 'incident-submitted', eventId: 'e2'});
      const arg = nf().displayNotification.mock.calls[0][0] as {title: string; body: string};
      expect(arg.title).toBe('Incident reported');
      expect(arg.body).not.toMatch(/CPO/);
      expect(arg.body).toMatch(/incident was reported/i);
    });

    it('a blank reporter name degrades instead of rendering "Reported by ."', async () => {
      await swn().showServerWakeNotification({
        kind: 'incident-submitted', eventId: 'e3', orgName: 'GSSG', reporterName: '   ',
      });
      const arg = nf().displayNotification.mock.calls[0][0] as {title: string; body: string};
      expect(arg.title).toBe('GSSG: incident reported');
      expect(arg.body).not.toMatch(/Reported by\s*\./);
      expect(arg.body).toMatch(/incident was reported/i);
    });
  });
});
