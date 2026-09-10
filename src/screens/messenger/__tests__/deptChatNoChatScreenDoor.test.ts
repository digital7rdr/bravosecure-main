/**
 * A9 / M9 — "No phone/call button appears in Department Channel chat; calls
 * remain in Messenger."
 *
 * The rule is satisfied STRUCTURALLY (department channels have their own screen,
 * `DepartmentChatScreen`, with no call affordance; `ChatScreen` renders phone
 * and video buttons unconditionally), which makes it a ROUTING rule: it holds
 * exactly as long as no path opens a department conversation in `ChatScreen`.
 *
 * ── WHY THIS IS A SOURCE SCAN ───────────────────────────────────────────────
 *
 * This is the repo's most common bug shape: ONE behaviour, N drifted copies, and
 * the fix lands only on the copy that was examined. The notification lane was
 * closed first; `LinksScreen` was still a live second door, and two conversation
 * lists were third and fourth. A unit test can prove the helper is right and a
 * render test can prove ONE screen calls it — neither can see copy N+1. Only an
 * enumerated sweep over every `navigate('Chat'` site can, so the sweep is the
 * gate and the enumeration below is the thing that must be kept honest.
 *
 * ── HOW THE ASSERTIONS ARE ANCHORED ─────────────────────────────────────────
 *
 * At the DECISION SITE. Asserting "the file imports openConversation" would stay
 * green with the import unused; asserting "the file does not contain
 * navigate('Chat'" would fail on prose and on unrelated call sites. So each
 * guarded screen is checked for its actual handler calling the helper, and for
 * the absence of a raw `navigate('Chat'` anywhere in its stripped source.
 *
 * CLAUDE.md traps handled: comments are stripped BEFORE every absence assertion
 * (three of these files now explain the rule in prose that names both
 * `navigate('Chat'` and `ChatScreen`), and every file is read with CRLF
 * normalised, because a `\n`-anchored regex over CRLF matches nothing and the
 * suite passes VACUOUSLY.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n')
    // Trailing line comments too — `navigate('Chat')` inside one would read as
    // a live call site.
    .replace(/([^:'"`])\/\/.*$/gm, '$1');
}

/** A DIRECT in-app navigate straight into ChatScreen. */
const RAW_CHAT_NAVIGATE = /(?:navigate|push|replace)\(\s*['"]Chat['"]/;

/**
 * The NESTED form — `navigate('SomeTab', {screen: 'Chat', …})`, which hops tabs
 * and lands on exactly the same screen.
 *
 * This was the sweep's blind spot, and it was not hypothetical: two live sites
 * (`LiveTrackingScreen`, `OpsMissionDetailScreen`) already use it, and neither
 * appeared in the enumeration below because the direct-form regex above cannot
 * see them. A brand-new screen shipping a nested door passed the whole suite.
 */
const NESTED_CHAT_NAVIGATE = /screen:\s*['"]Chat['"]/;

/** Either shape opens the banned surface, so the sweep must count both. */
const ANY_CHAT_NAVIGATE = new RegExp(
  `${RAW_CHAT_NAVIGATE.source}|${NESTED_CHAT_NAVIGATE.source}`,
);

/**
 * THE GUARDED SET — every screen that opens a thread from a list of
 * conversations/messages, i.e. every screen whose input can carry a department
 * channel's conversation id.
 */
const GUARDED: Array<[string, string[], string]> = [
  // [label, path, the handler that must route through the helper]
  ['LinksScreen', ['src', 'screens', 'messenger', 'LinksScreen.tsx'], 'const openChat = (r: LinkRow) => {'],
  ['GroupsScreen', ['src', 'screens', 'messenger', 'GroupsScreen.tsx'], 'const openGroup = (g: GroupItem) => {'],
  ['MessengerHomeScreen', ['src', 'screens', 'messenger', 'MessengerHomeScreen.tsx'], 'const goChat  = useCallback('],
];

/**
 * THE EXEMPT SET — `navigate('Chat'` sites that CANNOT receive a department
 * conversation id, each with the reason. A row here is a claim, and the third
 * describe block below re-derives each claim from source so an exemption cannot
 * quietly become false.
 */
const EXEMPT: Array<[string, string[], string]> = [
  ['ChatInfoScreen', ['src', 'screens', 'messenger', 'ChatInfoScreen.tsx'],
    'opens a "direct:" canonical 1:1 from a member tap; a department channel is a group and never has a direct: id'],
  ['NewChatScreen', ['src', 'screens', 'messenger', 'NewChatScreen.tsx'],
    'opens a group it just created via runtime.createGroupChat, or a 1:1 with a picked/dialled peer — neither can be an existing department channel'],
  ['AgentLiveTrackerScreen', ['src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx'],
    'opens the MISSION comms group (commsChannelId from the mission), not a department channel; outside the messenger surface'],
  // The two NESTED-form sites. Both hop to the messenger tab carrying a MISSION
  // group id, so neither can be a department channel — but they were invisible
  // to the sweep until NESTED_CHAT_NAVIGATE was added, which is the only reason
  // this enumeration was ever "complete".
  ['LiveTrackingScreen', ['src', 'screens', 'liveops', 'LiveTrackingScreen.tsx'],
    'hops to MessengerTab with the MISSION group id (convId from the mission record), never a department channel'],
  ['OpsMissionDetailScreen', ['src', 'screens', 'ops', 'OpsMissionDetailScreen.tsx'],
    'hops to MessengerTab with the MISSION group id (cid from the mission record), never a department channel'],
];

describe('A9/M9 — no in-app list opens a department channel in ChatScreen', () => {
  it('the sweep found every navigate(Chat) site in the app', () => {
    // THE ANTI-VACUITY CHECK, and the thing that makes the enumerations above
    // meaningful: walk the source tree, find every raw Chat navigate, and
    // require that each one is either guarded or explicitly exempted. A NEW
    // screen with an unguarded navigate fails here by name.
    const roots = [
      ['src', 'screens'],
      ['src', 'modules', 'messenger'],
    ];
    const found: string[] = [];
    const walk = (parts: string[]) => {
      for (const entry of readdirSync(join(process.cwd(), ...parts), {withFileTypes: true})) {
        if (entry.name === '__tests__' || entry.name === 'node_modules') {continue;}
        const next = [...parts, entry.name];
        if (entry.isDirectory()) { walk(next); continue; }
        if (!/\.tsx?$/.test(entry.name)) {continue;}
        // BOTH shapes. Scanning only the direct form is what let a nested
        // `navigate('MessengerTab', {screen: 'Chat'})` ship unnoticed.
        if (ANY_CHAT_NAVIGATE.test(strip(read(...next)))) {found.push(next.join('/'));}
      }
    };
    for (const r of roots) {walk(r);}

    // The scan must actually be finding things, or every assertion is vacuous.
    expect(found.length).toBeGreaterThan(0);

    const allowed = new Set(EXEMPT.map(([, p]) => p.join('/')));
    // The helper IS the guard — its ordinary arm is the one legitimate raw
    // navigate into ChatScreen in the app. Excluded by identity rather than
    // exempted, and its own behaviour is pinned by the second describe block.
    allowed.add('src/screens/messenger/openConversation.ts');
    expect(found.filter(f => !allowed.has(f))).toEqual([]);
  });

  it.each(GUARDED)('%s routes its list tap through the shared helper', (_label, parts, handler) => {
    const src = strip(read(...parts));
    const at = src.indexOf(handler);
    expect(at).toBeGreaterThan(-1);
    // The DECISION SITE: the handler body itself must call the helper.
    expect(src.slice(at, at + 400)).toMatch(/openConversation\(navigation, \{/);
    // …and nothing in the file may still reach ChatScreen by EITHER shape.
    expect(src).not.toMatch(ANY_CHAT_NAVIGATE);
  });

  it.each(EXEMPT)('%s is exempt for a reason that still holds', (label, parts, _why) => {
    const src = strip(read(...parts));
    // Each exemption is re-derived, not trusted. If one of these stops being
    // true the row must be MOVED to GUARDED, not deleted.
    if (label === 'ChatInfoScreen') {
      // Only reachable with a canonical direct id.
      expect(src).toMatch(/navigate\('Chat', \{conversationId: canonical, name, isGroup: false\}\)/);
      expect(src).toMatch(/canonical\.startsWith\('direct:'\)/);
    }
    if (label === 'NewChatScreen') {
      // Every site is either a just-created group or a picked 1:1 peer.
      const sites = [...src.matchAll(/navigate\('Chat', \{[^}]*\}\)/g)].map(m => m[0]);
      expect(sites.length).toBeGreaterThanOrEqual(4);
      for (const s of sites) {
        expect(s).toMatch(/isGroup: (true|false)/);
      }
      expect(src).toMatch(/runtime\.createGroupChat\(/);
    }
    if (label === 'AgentLiveTrackerScreen') {
      // The mission comms group, never a department channel.
      expect(src).toMatch(/conversationId: commsChannelId/);
    }
    if (label === 'LiveTrackingScreen' || label === 'OpsMissionDetailScreen') {
      // Nested hop, and the id it carries must still come from the MISSION —
      // a bare `conversationId: <something else>` here would need re-deriving.
      expect(src).toMatch(/screen: 'Chat'/);
      expect(src).toMatch(/conversationId: c(onv)?id/i);
    }
  });
});

describe('the helper itself keeps the three destinations', () => {
  const HELPER = strip(read('src', 'screens', 'messenger', 'openConversation.ts'));

  it('asks the store rather than re-implementing the department test', () => {
    // `resolveDeptConversation` reads BOTH signals (the additive persisted
    // registry and the B-206-prunable pointer). A local re-implementation would
    // inevitably read only one.
    expect(HELPER).toMatch(/import \{resolveDeptConversation\} from '@\/modules\/messenger\/push\/deptChannelTarget'/);
    expect(HELPER).toMatch(/resolveDeptConversation\(target\.conversationId, useMessengerStore\.getState\(\)\)/);
  });

  it('degrades to the directory, never to Chat, when the channel id is unknown', () => {
    // THE TRAP THIS PINS: falling back to Chat for a departmental conversation
    // whose pointer row is missing would re-open the banned surface for exactly
    // the channels this device has never opened.
    // Anchor the end of the slice on the ORDINARY arm. Take the indices first
    // and assert both are real: `String.slice` treats a -1 end as "one from the
    // end", so a stale anchor silently widens the slice to the whole file and
    // the absence assertion below fails for the wrong reason (or, with the
    // polarity flipped, passes vacuously).
    const armStart = HELPER.indexOf('if (dept?.channelId)');
    const armEnd = HELPER.search(/\bnavigate\('Chat'/);
    expect(armStart).toBeGreaterThan(-1);
    expect(armEnd).toBeGreaterThan(armStart);
    const deptArm = HELPER.slice(armStart, armEnd);
    expect(deptArm).toMatch(/'DepartmentChat'/);
    expect(deptArm).toMatch(/'DepartmentChannels'/);
    expect(deptArm).not.toMatch(RAW_CHAT_NAVIGATE);
    // Both departmental arms must RETURN — falling through would navigate twice.
    expect(deptArm.match(/return;/g)?.length).toBe(2);
  });

  it('reaches the departmental routes through the shell-aware resolver', () => {
    // DepartmentChat/DepartmentChannels are NOT on AgentNavigator's root stack,
    // and GroupsScreen + MessengerHomeScreen are both mounted there. A bare
    // navigate would be silently DROPPED in the agency shell.
    expect(HELPER).toMatch(/navigateToMessengerScreen\(nav as never, 'DepartmentChat'/);
    expect(HELPER).toMatch(/navigateToMessengerScreen\(nav as never, 'DepartmentChannels'/);
    const deepLink = strip(read('src', 'navigation', 'messengerDeepLink.ts'));
    expect(deepLink).toMatch(/AGENCY_WORKSPACE_ROUTES[\s\S]{0,200}?'DepartmentChat', 'DepartmentChannels'/);
  });

  it('stays in step with the notification lane', () => {
    // Same three destinations, same order. If these two drift, one lane starts
    // opening the banned surface again while the other does not — which is how
    // the second door survived the first fix.
    const fcm = strip(read('src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts'));
    const nav = fcm.slice(fcm.indexOf('function navigateToThread('));
    expect(nav.indexOf("'DepartmentChat'")).toBeGreaterThan(-1);
    expect(nav.indexOf("'DepartmentChannels'")).toBeGreaterThan(nav.indexOf("'DepartmentChat'"));
    expect(nav.indexOf("'Chat'")).toBeGreaterThan(nav.indexOf("'DepartmentChannels'"));
  });
});
