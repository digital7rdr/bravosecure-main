/**
 * R11-1 — `initial: false` on nested navigation, enforced repo-wide instead of
 * one literal pin per call site.
 *
 * THE RULE. React Navigation overrides a child navigator's `initialRouteName`
 * with the nested screen whenever `params.initial !== false`
 * (`@react-navigation/core` useNavigationBuilder). If that child is a STACK and
 * it has not mounted yet — which is the normal case, since tabs are lazy by
 * default — the stack initialises AT the target with no history beneath it.
 * Back falls out of the stack, and any control that later tries to reach the
 * stack's real root with a bare tab switch lands on the target instead, for the
 * life of the shell.
 *
 * WHY A SCAN. This bug was found three separate times in this phase (R9-2, then
 * R10-1 twice) and each fix was pinned with a literal assertion naming one call
 * site. Those pins do not see call site N+1 — and the two R10-1 fixes were
 * proven unpinned by a mutation that survived the FULL app project at an
 * identical total. Enumerating sites is what keeps failing; the rule is what
 * needs enforcing.
 *
 * Comments are stripped before any assertion: an `initial: false` mentioned in
 * prose must not satisfy the check, and — the way this test's own first draft
 * misread `DepartmentalHomeScreen` — a long comment BETWEEN `screen:` and
 * `initial:` must not hide a flag that is genuinely there.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join, sep} from 'node:path';

/** Strip block and line comments, preserving offsets is unnecessary here — we
 *  re-derive line numbers from the stripped text only for reporting. */
function strip(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

function sources(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') {sources(p, acc);}
    } else if (/\.tsx?$/.test(e.name)) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Extract the object literal enclosing `at`, then report whether `initial:`
 * appears at ITS top level (not inside a deeper `params: {...}`).
 */
function enclosingObjectHasInitial(src: string, at: number): boolean {
  let depth = 0;
  let start = -1;
  for (let i = at; i >= 0; i--) {
    const ch = src[i];
    if (ch === '}') {depth++;} else if (ch === '{') {
      if (depth === 0) {start = i; break;}
      depth--;
    }
  }
  if (start < 0) {return false;}
  let d = 0;
  let end = src.length;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') {d++;} else if (src[i] === '}') {
      d--;
      if (d === 0) {end = i; break;}
    }
  }
  // Only the top level of THIS object.
  const body = src.slice(start + 1, end);
  let dd = 0;
  let flat = '';
  for (const ch of body) {
    if (ch === '{' || ch === '[') {dd++;}
    else if (ch === '}' || ch === ']') {dd--;}
    else if (dd === 0) {flat += ch;}
  }
  return /\binitial\s*:\s*false\b/.test(flat);
}

/**
 * Sites that are legitimately flagless. Each needs a REASON, because an
 * allowlist without one becomes a place to silence the test.
 *
 * Two shapes qualify:
 *  - the nested leaf is a TAB, not a stack screen. TabRouter materialises every
 *    registered route regardless, so there is no root to override.
 *  - the leaf IS the child stack's own `initialRouteName`, so "override the
 *    initial route to X" and "initialise at X" are the same thing.
 */
const TAB_LEAVES = new Set([
  'MessengerTab', 'SecureTab', 'ProfileTab',   // the client tab shell
  'Channels', 'Attend', 'Incident', 'Vault',   // the Departmental shell
  'CpoComms',                                  // the CPO shell
]);

/**
 * Leaves that ARE their child stack's own initial route, so "override the
 * initial route to X" and "initialise at X" are the same thing.
 *
 * SCOPED BY HOST, not by bare name. `MessengerHome` is the initialRouteName of
 * MessengerNavigator, but `AgentNavigator` ALSO registers a screen called
 * `MessengerHome` on a stack whose initial route is `AgentTypeSelect` — so a
 * name-global exemption states something false and would wave through a real
 * re-rooting if a nesting into the Agent shell were ever added. The exemption
 * is only valid for the nestings that actually target those two stacks.
 */
const STACK_ROOTS: Array<[string, string]> = [
  // file that performs the nesting          leaf that is that stack's root
  ['src/screens/dashboard/DashboardScreen.tsx', 'MessengerHome'],  // -> MessengerNavigator
  ['src/screens/dashboard/DashboardScreen.tsx', 'BookingHome'],    // -> BookingNavigator
];
const stackRoot = new Set(STACK_ROOTS.map(([f, s]) => `${f}::${s}`));

/**
 * PRE-EXISTING unflagged sites, outside Phase 3. Listed rather than fixed so
 * this test can enforce the rule for NEW code without silently absorbing a
 * backlog — and so the backlog is visible instead of invisible. Each of these
 * re-roots a lazy stack and is a real finding; they are recorded in
 * docs/planning/ENTERPRISE_DEPT_CHANNELS_SCOPE_V2_FIT.md for the founder.
 *
 * Do NOT add to this list to make a new failure go away. Add `initial: false`.
 */
const KNOWN_PREEXISTING: Array<[string, string]> = [
  ['src/modules/messenger/backup/backupBoot.ts', 'BackupRestore'],
  ['src/modules/messenger/backup/backupBoot.ts', 'BackupSetup'],
  // (removed 2026-08-15, BB-3) MainNavigator -> TierPaywall: the tier-403
  // handler now carries initial: false — a 403 raised from inside Messenger
  // used to re-root the lazy Booking stack at the paywall, whose back arrow
  // and close were then silent no-ops.
  ['src/navigation/MainNavigator.tsx', 'VBGHome'],
  ['src/screens/dashboard/DashboardScreen.tsx', 'VBGHome'],
  ['src/screens/dashboard/DashboardScreen.tsx', 'BookingHistory'],
  // (removed) DashboardScreen -> ProLanding. The route no longer exists ANYWHERE
  // in src/ — the row was the exact "dead row = a permanently reserved slot"
  // this list's own guard below exists to catch, and it was already red on HEAD.
  ['src/screens/settings/ProfileScreen.tsx', 'CreditPaywall'],
  ['src/screens/settings/ProfileScreen.tsx', 'IndividualProfile'],
];

/**
 * DELIBERATELY flagless call deep-links — the category still exists but the
 * SITES moved (Ops-Room call fix, 2026-08-09): the in-app WS ring/dismissal
 * lanes now go through `navigateToMessengerScreen` (their hard-coded
 * Main→MessengerTab paths dropped silently on CPO/agency shells — the
 * "mission group calls don't work" P0), and the resolver nests a POSITIONAL
 * target, so this literal `screen: 'X'` scanner cannot see them anymore.
 * Their B-319 flaglessness (a cold ring must be the stack's only route; both
 * files keep their `canGoBack() === false` fallbacks) is pinned in its new
 * shape by pushNavigateParamSweep.test.ts ("ring resolver sites stay
 * FLAGLESS"), which asserts no opts argument on any ring resolver site.
 */
const DELIBERATE_CALL_DEEPLINK: Array<[string, string]> = [];

const known = new Set(
  [...KNOWN_PREEXISTING, ...DELIBERATE_CALL_DEEPLINK].map(([f, s]) => `${f}::${s}`));

interface Site { file: string; screen: string; flagged: boolean }

function scan(): Site[] {
  const found: Site[] = [];
  for (const abs of sources('src')) {
    const rel = abs.split(sep).join('/');
    const src = strip(readFileSync(abs, 'utf8'));
    const re = /screen:\s*'([A-Za-z]+)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const before = src.slice(Math.max(0, m.index - 300), m.index);
      // Only navigation payloads — not local data unions that happen to have a
      // `screen` field.
      //
      // `navigate` followed by an open paren WITHIN A SHORT WINDOW, rather than
      // immediately. Two shapes in this repo put something in between and both
      // were invisible to the stricter form:
      //   - `navigateVia(...)`, this repo's own indirection helper, which every
      //     resolver branch goes through;
      //   - `(navigationRef.navigate as (n: string, p?: object) => void)(...)`,
      //     the cast used by MainNavigator's call/paywall deep links.
      // The second one matters especially because an earlier version of this
      // comment CLAIMED to cover the casts while the regex did not — a false
      // coverage claim is worse than no comment, and a new unflagged nesting
      // using that shape survived the full app project.
      if (!/\bnavigate\w*\b[\s\S]{0,140}?\(|\.replace\s*\(|\.push\s*\(|initialParams/.test(before)) {continue;}
      found.push({file: rel, screen: m[1], flagged: enclosingObjectHasInitial(src, m.index)});
    }
  }
  return found;
}

describe('nested navigation must not re-root a lazy child stack', () => {
  const sites = scan();

  it('finds the nested-navigation sites at all (guards the scanner itself)', () => {
    // A scan that matches nothing passes every assertion below vacuously — the
    // single most common way a source-scan gate in this repo dies.
    expect(sites.length).toBeGreaterThan(10);
    expect(sites.some(s => s.file.includes('departmentalEntry'))).toBe(true);
  });

  it('every stack-leaf nesting carries initial: false, or is a known exception', () => {
    const offenders = sites.filter(s =>
      !s.flagged &&
      !TAB_LEAVES.has(s.screen) &&
      !stackRoot.has(`${s.file}::${s.screen}`) &&
      !known.has(`${s.file}::${s.screen}`));
    expect(offenders.map(o => `${o.file} -> ${o.screen}`)).toEqual([]);
  });

  it('the Phase 3 surface carries it at EVERY site this scan can see', () => {
    // Named explicitly as well as covered by the sweep above, because these are
    // the sites the bug was actually found in — twice via a mutation that
    // survived the whole app project.
    const phase3 = sites.filter(s =>
      (s.file.endsWith('openPricing.ts') ||
       s.file.endsWith('DepartmentalHomeScreen.tsx')) &&
      !TAB_LEAVES.has(s.screen));
    // 'DepartmentChat' left this roll-call under client review vs2 item 10,
    // which deleted the Announcements card — the nesting SITE went, the rule
    // did not. 'ReportIncidentCategory' stays: item 15 made the grid the
    // member's Incident root, and the Home card must still NAME it, because
    // Done deliberately leaves that stack on My Reports and a bare navigate
    // would re-enter there. It keeps `initial: false` like every other site —
    // inert in this one case, but the rule is blanket on purpose.
    // item 09 added a SECOND named site in DepartmentalHomeScreen: the
    // Open-incidents tile now names IncidentQueue, because the Incident tab
    // roots at the report grid and a bare navigate would land a manager who
    // tapped "3 open incidents" on a blank category form. Both carry
    // initial:false, which is what this scan is actually about.
    expect(phase3.map(s => s.screen).sort())
      .toEqual(['IncidentQueue', 'Pricing', 'ReportIncidentCategory']);
    expect(phase3.filter(s => !s.flagged).map(s => `${s.file} -> ${s.screen}`)).toEqual([]);
  });

  /**
   * WHAT THIS SCAN CANNOT SEE, said out loud.
   *
   * `openJoinFlowScreen` nests a VARIABLE route (`{screen: route, ...}`), so a
   * literal `screen: 'X'` scan is blind to all four of its branches — the exact
   * sites R9-2 was about. Claiming repo-wide coverage while silently missing
   * them would be worse than not having the scan. They are pinned instead by
   * `joinApprovalFlow.test.ts`, which asserts the flag at each branch AND
   * carries a negative assertion that no branch nests a screen without it; the
   * behavioural payloads are asserted in `departmentalEntry.test.ts`.
   *
   * This test asserts that dynamic-nesting cover EXISTS, so deleting it there
   * fails here too.
   */
  it('dynamic (variable-route) nesting is covered elsewhere, and stays covered', () => {
    const entry = strip(readFileSync(join('src', 'navigation', 'departmentalEntry.ts'), 'utf8'));
    // The resolver genuinely does nest a variable route — if that stops being
    // true this test is guarding nothing and should be revisited.
    expect(entry).toMatch(/screen:\s*route/);
    expect(entry).not.toMatch(/\{screen: route\}/);

    const pin = strip(readFileSync(
      join('src', 'screens', 'deptchat', '__tests__', 'joinApprovalFlow.test.ts'), 'utf8'));
    expect(pin).toMatch(/screen: route, initial: false/);
    expect(pin).toMatch(/not\.toMatch\(\/\\\{screen: route\\\}\//);
  });

  it('every known-exception row corresponds to a REAL unflagged site', () => {
    // A length-only assertion pins the COUNT, not the CONTENTS — so a dead row
    // is a permanently reserved slot a future offender can be swapped into.
    // The first version of this list carried exactly that: a
    // `messengerDeepLink.ts -> CallScreen` row matching no site the scanner
    // produces (that file nests a VARIABLE route and already threads the flag),
    // which also put a finding that does not exist in front of the founder.
    const actual = new Set(
      sites.filter(s => !s.flagged).map(s => `${s.file}::${s.screen}`));
    for (const [file, screen] of [...KNOWN_PREEXISTING, ...DELIBERATE_CALL_DEEPLINK]) {
      expect(actual.has(`${file}::${screen}`)).toBe(true);
    }
  });

  it('the known-exception lists have not silently grown', () => {
    // If someone allowlists a NEW site instead of fixing it, this fails.
    // 9 -> 8: the dead `DashboardScreen -> ProLanding` row was deleted, not
    // swapped for a new offender (the route is gone from src/ entirely).
    // 8 -> 7: MainNavigator -> TierPaywall FIXED (BB-3) — the site now
    // carries initial: false, so the row had to go (the every-row-is-REAL
    // check below refuses fixed rows).
    expect(KNOWN_PREEXISTING).toHaveLength(7);
    // 3 -> 0: the call deep-links moved onto the resolver (see the list's
    // comment); their flaglessness is pinned by pushNavigateParamSweep now.
    expect(DELIBERATE_CALL_DEEPLINK).toHaveLength(0);
  });

  /**
   * WHAT THIS SCAN STILL CANNOT SEE — stated so nobody reads it as total cover.
   *
   * It matches `navigate…(`, `navigateVia(`, and the
   * `(navigationRef.navigate as …)(…)` cast, within a 300-char window before
   * the payload. It does NOT see a navigate aliased to a local helper declared
   * further away — `ProfileDrawerModal.tsx` defines `const go = …` ~35 lines
   * above its two nested calls, so those two sites are invisible here. They are
   * pre-existing and outside Phase 3; widening the window enough to catch them
   * starts pulling in unrelated `screen:` data literals, which would make the
   * gate noisy and therefore ignored.
   *
   * The claim this test DOES make: every nesting reachable through a direct,
   * helper, or cast call is covered — including all of the Phase 3 surface.
   */
  it('states its own blind spot rather than implying total coverage', () => {
    const self = readFileSync(
      join('src', 'navigation', '__tests__', 'nestedNavigationInitialFlag.test.ts'), 'utf8');
    expect(self).toMatch(/WHAT THIS SCAN STILL CANNOT SEE/);
    // MainNavigator no longer OWNS any cast-navigate site: the three call
    // deep-links were its only ones and the Ops-Room call fix (B-414) moved
    // them onto the resolver. Pin the new state — a cast navigate
    // reappearing there means someone bypassed the resolver.
    const main = strip(readFileSync(join('src', 'navigation', 'MainNavigator.tsx'), 'utf8'));
    expect(main).not.toMatch(/navigationRef\.navigate as/);
    // The scanner's cast-window REGEX still works — proven against a
    // synthetic fixture rather than claimed from a live site, because after
    // B-414 no scanner-visible cast site remains anywhere in src (the
    // surviving casts are variable-route helper aliases this literal scan
    // is documented blind to). A presence-pin on one of those would be the
    // exact false-coverage-comment failure this test's history warns about.
    const fixture =
      "(navigationRef.navigate as (n: string, p?: object) => void)('Main', " +
      "{screen: 'SyntheticFixtureRoute', params: {}});";
    const castWindow = /\bnavigate\w*\b[\s\S]{0,140}?\(|\.replace\s*\(|\.push\s*\(|initialParams/;
    expect(castWindow.test(fixture.slice(0, fixture.indexOf('screen:')))).toBe(true);
    expect(sites.some(s => s.file.endsWith('MainNavigator.tsx') && s.screen === 'TierPaywall')).toBe(true);
  });
});
