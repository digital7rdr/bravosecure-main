import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Redirect-param completeness sweep for the push layer (static source scan).
 *
 * Every notification tap that deep-links must carry the FULL param list its
 * target route needs — a missing key does not throw, it just mounts a broken
 * screen (or clobbers good params on an already-mounted one, because RN6
 * navigate() REPLACES params). The B-54 class. Bugs pinned here:
 *
 *   B-85    — Chat deep-links need `initial: false`, or back-nav bubbles to
 *             the Dashboard instead of the chat list; ChatScreen itself
 *             crashes at render without `name` + `isGroup` (N-07/N-08).
 *   NA-01   — the FCM voip-wake never carries SDP / remoteDeviceId /
 *             conversationId, so a CallScreen navigation built from raw wake
 *             data CLOBBERED the SDP the WS offer had already delivered →
 *             auto-accept starved, dead Answer buttons. The notifee lane must
 *             hydrate through resolveIncomingCallRoute (wire ?? cache).
 *   P1-BR-1 — a group accept must echo the per-recipient roomToken into
 *             sfu.join, or the callee creates a NEW room instead of joining
 *             the host's.
 *   B-102 A1 / NA-02 — autoAccept: an explicit Answer (notifee button /
 *             Telecom) must auto-accept; a body tap must land on the ring UI;
 *             the WS offer replay may re-assert autoAccept ONLY via the
 *             explicit-accept latch (wasCallExplicitlyAccepted).
 *
 * fcmBootstrap.ts / MainNavigator.tsx transitively import react-native +
 * firebase, so the node `messenger-crypto` project scans them as TEXT (same
 * pattern as messageTopologyInvariants.test.ts). Rules that keep the sweep
 * honest:
 *   - both files are CRLF: no `$`-anchored line regexes (in JS, `$` with /m
 *     matches before `\n`, so a CRLF line body ending in `\r` never matches);
 *     key checks use bounded character classes instead.
 *   - comments are stripped BEFORE every assertion — prose naming a screen or
 *     a param is the classic false result in this repo.
 *   - site counts are pinned so the sweep can never pass vacuously, and any
 *     navigate shape the object-scan cannot see is banned outright.
 */

const FCM_PATH = join(process.cwd(), 'src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts');
const NAV_PATH = join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx');
// Ops-Room call fix (2026-08-09) — the in-app WS ring/dismissal lanes moved
// onto the resolver too (they had the SAME hard-coded-shell-path bug the push
// lanes fixed in B-257/B-258, which is why "mission group calls don't work"
// only hit CPO/agency personas). These files join the sweep.
const CS_PATH  = join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx');
const GCS_PATH = join(process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx');
const TRACKER_PATH = join(process.cwd(), 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');

/** Strip line + block comments so scans see CODE, not prose. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, ''); // [^\n] also eats the trailing \r — CRLF-safe
}

interface NavSite {
  readonly file: string;
  readonly screen: string;
  /** The balanced `{...}` object that contains `screen: 'X'`. */
  readonly enclosing: string;
  /** The balanced object after the sibling `params:` key ('' when absent). */
  readonly params: string;
  /** Up to 260 chars of code preceding the site (nesting context). */
  readonly before: string;
}

function matchingBrace(src: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {return i;}
    }
  }
  throw new Error(`unbalanced braces after index ${openIdx}`);
}

function enclosingOpenBrace(src: string, beforeIdx: number): number {
  let depth = 0;
  for (let i = beforeIdx; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') {
      depth++;
    } else if (ch === '{') {
      if (depth === 0) {return i;}
      depth--;
    }
  }
  throw new Error('no enclosing brace found');
}

/** Every `screen: 'X'` navigation object in the (comment-stripped) source. */
function findNavSites(stripped: string, file: string, screen: string): NavSite[] {
  const needle = new RegExp(`screen:\\s*['"]${screen}['"]`, 'g');
  const sites: NavSite[] = [];
  for (let m = needle.exec(stripped); m !== null; m = needle.exec(stripped)) {
    const open = enclosingOpenBrace(stripped, m.index - 1);
    const close = matchingBrace(stripped, open);
    const enclosing = stripped.slice(open, close + 1);
    let params = '';
    const pKey = enclosing.indexOf('params:', m.index - open);
    if (pKey !== -1) {
      const pOpen = enclosing.indexOf('{', pKey);
      if (pOpen !== -1) {
        params = enclosing.slice(pOpen, matchingBrace(enclosing, pOpen) + 1);
      }
    }
    sites.push({
      file,
      screen,
      enclosing,
      params,
      before: stripped.slice(Math.max(0, open - 260), open),
    });
  }
  return sites;
}

/**
 * B-257/B-258 — the SECOND deep-link shape.
 *
 * Push deep-links no longer hard-code `Main -> MessengerTab -> X`: that path
 * exists only in the CLIENT tab shell, and MainNavigator mounts CpoNavigator or
 * AgentNavigator instead for provider accounts, so every notification tap by a
 * CPO or agency user resolved to nothing and was silently dropped. They now go
 * through `navigateToMessengerScreen(ref, 'X', {params}, {opts})`, which picks
 * the path for the mounted shell.
 *
 * The param contracts below still have to hold, so the sweep learns to see the
 * new call shape rather than being relaxed.
 */
function findResolverSites(stripped: string, file: string, screen: string): NavSite[] {
  const needle = new RegExp(
    `navigateToMessengerScreen\\(\\s*[^,]+,\\s*['"]${screen}['"]\\s*,\\s*`, 'g');
  const sites: NavSite[] = [];
  for (let m = needle.exec(stripped); m !== null; m = needle.exec(stripped)) {
    const pOpen = stripped.indexOf('{', m.index + m[0].length - 1);
    if (pOpen === -1) {continue;}
    const pClose = matchingBrace(stripped, pOpen);
    const params = stripped.slice(pOpen, pClose + 1);
    // Enclosing = the whole call, so the `{initial: false}` options argument is
    // visible to the assertions that look for it.
    const callEnd = stripped.indexOf(');', pClose);
    sites.push({
      file,
      screen,
      enclosing: stripped.slice(m.index, callEnd === -1 ? pClose + 1 : callEnd + 2),
      params,
      before: stripped.slice(Math.max(0, m.index - 260), m.index),
    });
  }
  return sites;
}

/**
 * Both shapes. Lane assertions must see a navigation whichever form it takes,
 * or a lane silently reads as EMPTY and its discipline check passes vacuously.
 */
function findAnySites(stripped: string, file: string, screen: string): NavSite[] {
  return [...findNavSites(stripped, file, screen), ...findResolverSites(stripped, file, screen)];
}
/** Key present as `key:` OR shorthand `key,` / `key}`. Comments are already gone. */
function hasParamKey(params: string, key: string): boolean {
  return new RegExp(`[{,\\s]${key}\\s*[:,}]`).test(params);
}

function missingKeys(site: NavSite, keys: readonly string[]): string[] {
  return keys.filter(k => !hasParamKey(site.params, k));
}

function sliceBetween(src: string, startToken: string, endToken: string): string {
  const start = src.indexOf(startToken);
  if (start === -1) {throw new Error(`start token not found: ${startToken}`);}
  const end = src.indexOf(endToken, start + startToken.length);
  if (end === -1) {throw new Error(`end token not found: ${endToken}`);}
  return src.slice(start, end);
}

const fcm = stripComments(readFileSync(FCM_PATH, 'utf8'));
const nav = stripComments(readFileSync(NAV_PATH, 'utf8'));
const cs  = stripComments(readFileSync(CS_PATH, 'utf8'));
const gcs = stripComments(readFileSync(GCS_PATH, 'utf8'));
const tracker = stripComments(readFileSync(TRACKER_PATH, 'utf8'));

const chatSites = [
  ...findNavSites(fcm, 'fcmBootstrap.ts', 'Chat'),
  ...findResolverSites(fcm, 'fcmBootstrap.ts', 'Chat'),
  ...findNavSites(nav, 'MainNavigator.tsx', 'Chat'),
];
const callSites = [
  ...findNavSites(fcm, 'fcmBootstrap.ts', 'CallScreen'),
  ...findResolverSites(fcm, 'fcmBootstrap.ts', 'CallScreen'),
  ...findNavSites(nav, 'MainNavigator.tsx', 'CallScreen'),
  ...findResolverSites(nav, 'MainNavigator.tsx', 'CallScreen'),
];
const groupSites = [
  ...findNavSites(fcm, 'fcmBootstrap.ts', 'IncomingGroupCallScreen'),
  ...findResolverSites(fcm, 'fcmBootstrap.ts', 'IncomingGroupCallScreen'),
  ...findNavSites(nav, 'MainNavigator.tsx', 'IncomingGroupCallScreen'),
  ...findResolverSites(nav, 'MainNavigator.tsx', 'IncomingGroupCallScreen'),
  // The PRIMARY B-306 parked-ring consume lives in CallScreen's dismissal.
  ...findResolverSites(cs, 'CallScreen.tsx', 'IncomingGroupCallScreen'),
];

/** The Telecom Answer lane (navigateToIncomingCall) — always an explicit accept. */
const telecomLane = (): string =>
  sliceBetween(fcm, 'async function navigateToIncomingCall', 'function sendCallHangup');
/** The notifee Answer-button / body-tap lane (installNotifeeHandlers). */
const notifeeLane = (): string =>
  sliceBetween(fcm, 'function installNotifeeHandlers', 'export function stopFcmBootstrap');

describe('sweep machinery — the scan cannot pass vacuously', () => {
  it('strips // and /* */ comments across CRLF line endings', () => {
    const fixture = "a\r\n// screen: 'Chat' in prose\r\nb /* screen: 'CallScreen' */ c\r\n";
    const out = stripComments(fixture);
    expect(out).not.toMatch(/Chat|CallScreen/);
    expect(out).toMatch(/a\r?\n\r?\nb\s+c/); // code survives, prose does not
  });

  it('does not count a commented-out navigation site', () => {
    const fixture =
      "// nav.navigate('Main', {screen: 'Chat', params: {conversationId: c}})\r\n" +
      "nav.navigate('Main', {screen: 'Chat', initial: false, params: {conversationId: c, name: n, isGroup: g}});\r\n";
    const sites = findNavSites(stripComments(fixture), 'fixture', 'Chat');
    expect(sites).toHaveLength(1);
    expect(hasParamKey(sites[0].params, 'name')).toBe(true);
    expect(hasParamKey(sites[0].params, 'isGroup')).toBe(true);
    expect(hasParamKey(sites[0].params, 'absent')).toBe(false);
  });

  it('found every known site (fcm: 2 Chat + 2 CallScreen + 2 group; navigator: 1 CallScreen + 3 group; CallScreen.tsx: 1 group)', () => {
    const count = (sites: NavSite[], file: string): number => sites.filter(s => s.file === file).length;
    expect(count(chatSites, 'fcmBootstrap.ts')).toBeGreaterThanOrEqual(2);
    expect(count(callSites, 'fcmBootstrap.ts')).toBeGreaterThanOrEqual(2);
    expect(count(groupSites, 'fcmBootstrap.ts')).toBeGreaterThanOrEqual(2);
    // Ops-Room call fix — exact counts, resolver-shaped: a site that silently
    // reverts to the hard-coded form would vanish from findResolverSites and
    // fail here (red-first proven: these were 0 before the fix).
    expect(count(callSites, 'MainNavigator.tsx')).toBe(1);
    // 3 group sites since B-479: the live onIncoming navigate, the parked-ring
    // registry-null fallback consume, and the restore-exit consume (a ring
    // parked because a backup restore was running, re-presented when it ends).
    expect(count(groupSites, 'MainNavigator.tsx')).toBe(3);
    expect(count(groupSites, 'CallScreen.tsx')).toBe(1);
  });

  it('every discovered site has a parsable params block', () => {
    const bad = [...chatSites, ...callSites, ...groupSites]
      .filter(s => s.params === '')
      .map(s => ({file: s.file, screen: s.screen, site: s.enclosing.slice(0, 80)}));
    expect(bad).toEqual([]);
  });

  it('no deep-link uses a shape this sweep cannot see (direct navigate to the route name)', () => {
    // A `navigate('Chat', {...})` at stack level would evade the nested-object
    // scan above — ban the shape outright in both files.
    const evasion = /\.(navigate|push|replace)\(\s*['"](Chat|CallScreen|IncomingGroupCallScreen)['"]/;
    expect(fcm).not.toMatch(evasion);
    expect(nav).not.toMatch(evasion);
  });
});

describe('B-85 — every Chat deep-link is complete', () => {
  const REQUIRED = ['conversationId', 'name', 'isGroup'] as const;

  it('passes conversationId + name + isGroup at every site (N-07/N-08 render-crash guard)', () => {
    expect(chatSites.length).toBeGreaterThanOrEqual(2);
    const failures = chatSites
      .map(s => ({file: s.file, missing: missingKeys(s, REQUIRED), site: s.enclosing.slice(0, 120)}))
      .filter(f => f.missing.length > 0);
    expect(failures).toEqual([]);
  });

  it('sets initial: false on the navigator object at every site (back → chat list, not Dashboard)', () => {
    const failures = chatSites
      .filter(s => !/initial:\s*false/.test(s.enclosing))
      .map(s => ({file: s.file, site: s.enclosing.slice(0, 120)}));
    expect(failures).toEqual([]);
  });

  it('B-258 — no PUSH deep-link hard-codes a shell path', () => {
    // `Main -> MessengerTab` exists only in the CLIENT tab shell. MainNavigator
    // mounts CpoNavigator or AgentNavigator instead for provider accounts, so a
    // hard-coded path resolved to nothing and React Navigation dropped the tap
    // silently — the user landed on the product gate, and for a CALL that meant
    // CallScreen never mounted and nobody ever answered.
    expect(fcm).not.toMatch(/'MessengerTab'/);
  });

  it('Ops-Room call fix — no IN-APP call lane hard-codes the shell path either', () => {
    // The same B-258 defect lived on in the WS ring/dismissal lanes for a
    // year: a foregrounded CPO/agency user's ring navigated nowhere and the
    // FCM rescue copy was dedup-suppressed — mission Ops Room group calls
    // read as dead for two of the three personas. MainNavigator legitimately
    // owns the literal in PRODUCT_TABS / the tab-bar check / initialRouteName,
    // so its ban is SHAPE-scoped to the navigation-object form; the two call
    // screens have no legitimate use at all.
    expect(nav).not.toMatch(/screen:\s*['"]MessengerTab['"]/);
    expect(cs).not.toMatch(/'MessengerTab'/);
    expect(gcs).not.toMatch(/'MessengerTab'/);
  });

  it('Ops-Room call fix — ring resolver sites stay FLAGLESS (B-319 preserved)', () => {
    // A cold ring must be the stack's only route; the old hard-coded sites
    // were deliberately flagless (nestedNavigationInitialFlag documented
    // them) and the resolver adds initial:false ONLY when an opts argument
    // asks for it — so the pin is: no opts argument on any ring site.
    const ringSites = [
      ...callSites.filter(s => s.file === 'MainNavigator.tsx'),
      ...groupSites.filter(s => s.file === 'MainNavigator.tsx'),
      ...groupSites.filter(s => s.file === 'CallScreen.tsx'),
    ];
    // 5 since B-479 added the restore-exit consume. Kept exact rather than
    // >=: the number is the vacuity guard — a site that silently reverted to
    // the hard-coded form would vanish from the resolver scan and this would
    // still pass under a >= bound.
    expect(ringSites.length).toBe(5);
    for (const s of ringSites) {
      expect(s.enclosing).not.toMatch(/initial:\s*false/);
    }
  });

  it('Ops-Room call fix (H5) — the live-tracker call shim routes through the resolver', () => {
    // The B-212 comment claimed GroupCallScreen is on the root stack "for
    // every mode" — false for CPO (CpoRootStackParamList registers neither
    // call screen), so the flat root-ref navigate dropped silently and a
    // CPO's tracker-initiated Ops Room call never started.
    expect(tracker).toMatch(/navigateToMessengerScreen\(navigationRef as never, screen as MessengerTarget/);
    expect(tracker).not.toMatch(/navigationRef\.navigate as unknown/);
  });

  it('B-258 — every push Chat deep-link goes through the shell resolver', () => {
    const fcmChat = chatSites.filter(s => s.file === 'fcmBootstrap.ts');
    expect(fcmChat.length).toBeGreaterThanOrEqual(2);
    const failures = fcmChat
      .filter(s => !/navigateToMessengerScreen\(/.test(s.enclosing))
      .map(s => ({file: s.file, site: s.enclosing.slice(0, 120)}));
    expect(failures).toEqual([]);
  });
});

describe('NA-01 — every CallScreen navigation carries the full call contract', () => {
  const REQUIRED = [
    'callType',
    'isIncoming',
    'conversationId',
    'callId',
    'remoteUserId',
    'remoteDeviceId',
    'incomingSdp',
  ] as const;

  it('passes all 7 call params at every site', () => {
    expect(callSites.length).toBeGreaterThanOrEqual(3);
    const failures = callSites
      .map(s => ({file: s.file, missing: missingKeys(s, REQUIRED)}))
      .filter(f => f.missing.length > 0);
    expect(failures).toEqual([]);
  });

  it('push-layer sites never take incomingSdp straight off the wake payload (the NA-01 clobber shape)', () => {
    // The FCM wake data NEVER carries SDP, so `incomingSdp: data.…` is always
    // undefined — and RN6 navigate() would replace the good SDP the WS offer
    // delivered. Only cache-backed sources (payload./route.) are legal here.
    const fcmCall = callSites.filter(s => s.file === 'fcmBootstrap.ts');
    expect(fcmCall.length).toBeGreaterThanOrEqual(2);
    for (const s of fcmCall) {
      expect(s.params).not.toMatch(/incomingSdp:\s*data\./);
    }
  });

  it('the notifee Answer/tap lane hydrates via resolveIncomingCallRoute', () => {
    const lane = notifeeLane();
    expect(lane).toMatch(/[=]\s*resolveIncomingCallRoute\(/);
    const sites = findAnySites(lane, 'lane', 'CallScreen');
    expect(sites).toHaveLength(1);
    expect(sites[0].params).toMatch(/incomingSdp:\s*route\.incomingSdp/);
    expect(sites[0].params).toMatch(/remoteDeviceId:\s*route\.remoteDeviceId/);
    expect(sites[0].params).toMatch(/conversationId:\s*route\.conversationId/);
  });

  it('resolveIncomingCallRoute treats the cache as fallback, never as override', () => {
    const body = sliceBetween(fcm, 'export function resolveIncomingCallRoute', 'function installNotifeeHandlers');
    // Wire data wins, the incoming-call cache fills the holes (wire ?? cached).
    expect(body).toMatch(/\?\?\s*cached\.incomingSdp/);
    expect(body).toMatch(/\?\?\s*cached\.remoteDeviceId/);
    expect(body).toMatch(/\?\?\s*cached\.conversationId/);
    expect(body).not.toMatch(/cached\.\w+\s*\?\?/);
    // Last-resort conversationId is the synthetic direct:<peer> key.
    expect(body).toMatch(/`direct:\$\{/);
  });
});

describe('P1-BR-1 — every IncomingGroupCallScreen navigation carries the group ring contract', () => {
  const REQUIRED = ['roomId', 'roomToken', 'conversationId', 'callType', 'callerName', 'fromUserId'] as const;

  it('passes all 6 group params at every site (roomToken echo → sfu.join)', () => {
    expect(groupSites.length).toBeGreaterThanOrEqual(3);
    const failures = groupSites
      .map(s => ({file: s.file, missing: missingKeys(s, REQUIRED)}))
      .filter(f => f.missing.length > 0);
    expect(failures).toEqual([]);
  });
});

describe('B-102 A1 / NA-02 — autoAccept discipline per lane', () => {
  it('the Telecom Answer lane hardcodes autoAccept: true on both ring targets', () => {
    const lane = telecomLane();
    const call = findAnySites(lane, 'lane', 'CallScreen');
    const group = findAnySites(lane, 'lane', 'IncomingGroupCallScreen');
    expect(call).toHaveLength(1);
    expect(group).toHaveLength(1);
    expect(call[0].params).toMatch(/autoAccept:\s*true/);
    expect(group[0].params).toMatch(/autoAccept:\s*true/);
  });

  it('the notifee lane derives autoAccept from the press action — a body tap must NOT auto-accept', () => {
    const lane = notifeeLane();
    // WI-4.4 — autoAccept is the Answer action OR the already-latched Answer
    // intent (an FSI body press landing after the Answer event must not
    // un-answer the call via RN6's param replace). Never a bare literal, and
    // never derived from anything besides those two facts.
    // R2-5 — through the scrubbing reader, never a raw .has (the scrub-on-read
    // invariant would otherwise have a silent bypass at this one site).
    expect(lane).toMatch(/const\s+autoAccept\s*=\s*isAnswerAction\s*\|\|\s*wasCallExplicitlyAccepted\(callId\)/);
    // The Answer branch is the only consumer of the answer dedupe; the body
    // tap owns a separate one and can no longer burn the Answer button.
    expect(lane).toMatch(/if\s*\(isAnswerAction\)\s*\{[^}]*markAccepted\(callId\)/);
    expect(lane).toMatch(/else\s+if\s*\(!markBodyTapNavigated\(callId\)\)/);
    const sites = [
      ...findAnySites(lane, 'lane', 'CallScreen'),
      ...findAnySites(lane, 'lane', 'IncomingGroupCallScreen'),
    ];
    expect(sites).toHaveLength(2);
    for (const site of sites) {
      expect(hasParamKey(site.params, 'autoAccept')).toBe(true);
      expect(site.params).not.toMatch(/autoAccept:\s*true/);
    }
  });

  it('every push-layer ring navigation lives in one of the two audited lanes', () => {
    // A NEW push lane (e.g. a killed-wake route added to the 8000-line runtime
    // or a third handler here) must be classified before it ships: explicit
    // accept → autoAccept: true; body tap → derived. Adding one breaks this
    // count on purpose — extend the lane slices above when it does.
    const laneCount = (screen: string): number =>
      findAnySites(telecomLane(), 'lane', screen).length +
      findAnySites(notifeeLane(), 'lane', screen).length;
    expect(laneCount('CallScreen')).toBe(callSites.filter(s => s.file === 'fcmBootstrap.ts').length);
    expect(laneCount('IncomingGroupCallScreen')).toBe(groupSites.filter(s => s.file === 'fcmBootstrap.ts').length);
  });

  it('the WS offer replay re-asserts autoAccept ONLY through the explicit-accept latch', () => {
    // B-102 A1 — the offer replay lands SECOND in the killed-app Answer flow
    // and replaces params. It must re-assert autoAccept iff the push layer
    // recorded an explicit Answer; an unconditional key would auto-accept
    // calls the user never answered.
    const sites = callSites.filter(s => s.file === 'MainNavigator.tsx');
    expect(sites).toHaveLength(1);
    const latch = /\.\.\.\(\s*wasExplicitlyAccepted\s*\?\s*\{\s*autoAccept:\s*true\s*\}\s*:\s*\{\s*\}\s*\)/;
    expect(sites[0].params).toMatch(latch);
    expect(sites[0].params.replace(latch, '')).not.toMatch(/autoAccept/);
  });

  it('the WS group ring re-asserts autoAccept ONLY through the explicit-accept latch', () => {
    const sites = groupSites.filter(s => s.file === 'MainNavigator.tsx');
    // 3 sites: the live onIncoming navigate (B-321), the parked-ring
    // registry-null fallback consume (B-321), and the restore-exit consume
    // (B-479). WI-4.6 — each is the group mirror of the 1:1 rule above: a
    // ring frame landing after the notification Answer replaces params, so
    // each site re-asserts autoAccept iff the push layer recorded an explicit
    // Answer for this roomId. An unconditional key would auto-join calls the
    // user never answered; NO key un-answers calls they did.
    expect(sites).toHaveLength(3);
    const latch = /\.\.\.\(\s*groupRingExplicitlyAccepted\((?:ring|parked)\.roomId\)\s*\?\s*\{\s*autoAccept:\s*true\s*\}\s*:\s*\{\s*\}\s*\)/;
    for (const site of sites) {
      expect(site.params).toMatch(latch);
      expect(site.params.replace(latch, '')).not.toMatch(/autoAccept/);
    }
  });
});
