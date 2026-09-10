/**
 * Scope v2 Phase 6 — the Enterprise onboarding route (A2/M2, A4/M4, A5).
 *
 * A SOURCE SCAN, deliberately, for the same reason as the bottom-nav rule: every
 * invariant here is an ABSENCE or a WIRING fact, and neither survives a render
 * test. "This screen shows no plan tiers", "this screen never creates an agent",
 * "both arms of the fork are registered in every shell that mounts one" — a
 * mounted component can satisfy all three while the file drifts.
 *
 * Comments are stripped before every presence/absence assertion. The screens
 * deliberately EXPLAIN what they must not do (they name `service_provider` and
 * the agency funnel in prose), and a naive scan would fail on its own docs —
 * which is the single most common false result in this repo.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function src(...parts: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8')
    .replace(/\r\n/g, '\n');
}

// LINE-ANCHORED block strip (`src/__tests__/sourceScanSafety.test.ts`): a
// slash-star inside a string literal — a wildcard MIME type, for instance —
// makes the greedy form swallow real code, and every absence assertion below
// would then pass over code that is present.
function code(text: string): string {
  return text
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/^[ \t]*\{\/\*[\s\S]*?\*\/\}[ \t]*$/gm, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const SETUP = code(src('screens', 'deptchat', 'EnterpriseSetupScreen.tsx'));
const CREATE = code(src('screens', 'deptchat', 'CreateWorkspaceScreen.tsx'));

describe('A4/M4 — the Enterprise create-or-join fork', () => {
  it('offers BOTH arms, and nothing else', () => {
    expect(SETUP).toMatch(/navigate\('CreateWorkspace'\)/);
    expect(SETUP).toMatch(/navigate\('JoinWorkspace'/);
  });

  /**
   * A2/M2 — "Professional must not appear in the Enterprise onboarding route."
   *
   * Satisfied STRUCTURALLY: this screen shows no plan tiers at all, so there is
   * no list for a later edit to re-widen. Asserting the absence of every tier
   * name (not just 'pro') is what makes that real — a screen that showed Lite
   * and Enterprise but not Professional would pass a narrower check while still
   * being a plan picker.
   */
  it('shows NO plan tiers — the rule is structural, not a filter', () => {
    for (const tier of [/\bProfessional\b/, /\bpendingTier\b/, /plansForProduct/, /tierMatrix/]) {
      expect(SETUP).not.toMatch(tier);
    }
    // …and it is not quietly importing the pricing surface either.
    expect(SETUP).not.toMatch(/PricingScreen|subscription_tier/);
  });

  /**
   * An owner who already HAS a workspace must not be parked on a screen asking
   * them to create one. Checked on mount rather than trusted from a route param:
   * the fork is reachable from more than one entry point.
   */
  it('sends an existing owner straight into their workspace', () => {
    expect(SETUP).toMatch(/enterpriseApi\.myWorkspace\(\)/);
    // F-WSHUB (2026-08-09, deliberate change) — owners now land on the
    // Workspace Hub when the mounted tree registers it; the Departmental
    // replace stays as the fallback for shells without the hub route
    // (Agent/CPO), resolved via findNavigatorWithRoute so neither arm is a
    // silently-dropped navigate.
    expect(SETUP).toMatch(/findNavigatorWithRoute\(navigation, 'WorkspaceHub'\)/);
    expect(SETUP).toMatch(/navigation\.replace\('WorkspaceHub'\)/);
    expect(SETUP).toMatch(/navigation\.replace\('Departmental'\)/);
  });

  it('names no organisation — M11A geometry holds before approval too', () => {
    // A pending or prospective member must see nothing about the org. This
    // screen runs BEFORE any request exists, so it cannot render org data at all.
    expect(SETUP).not.toMatch(/org_name|organisation_name|orgName/);
  });
});

describe('A5 — Create Org Workspace', () => {
  it('posts the name and nothing else', () => {
    expect(CREATE).toMatch(/enterpriseApi\.createWorkspace\(trimmed\)/);
    // The owner comes from the token server-side. An owner field here would be
    // the client choosing whose org to create.
    expect(CREATE).not.toMatch(/owner_user_id\s*:/);
  });

  /**
   * THE DECISION THIS PINS (owner-decided 2026-08-04). The only pre-existing way
   * to own an org was the agency funnel, which flips `users.role` to
   * service_provider and routes the account into the provider home and the job
   * marketplace. An Enterprise company is not a security-services agency.
   */
  it('never mints an agent or a service provider', () => {
    expect(CREATE).not.toMatch(/agentApi|createAgent|'company'/);
    expect(CREATE).not.toMatch(/service_provider/);
  });

  /**
   * `owns_workspace` is server-authoritative and decides whether this user may
   * ENTER the workspace. Navigating before re-reading the session lands the
   * owner on their own brand-new workspace and tells them they have no access.
   */
  it('re-reads the session BEFORE navigating in', () => {
    expect(CREATE).toMatch(/recheckMembership\(\)/);
    const refreshAt = CREATE.indexOf('recheckMembership()');
    const navAt = CREATE.indexOf("navigation.replace('Departmental')");
    expect(refreshAt).toBeGreaterThan(-1);
    expect(navAt).toBeGreaterThan(refreshAt);
  });

  /**
   * `recheckMembership` swallows its own errors BY DESIGN — a transient
   * /auth/me 401 must not log a client out — so it resolves happily on failure
   * and leaves the flag stale. Navigating on a stale flag is the exact "no
   * access to the workspace I just created" dead end this path exists to avoid.
   */
  it('VERIFIES the refresh landed instead of trusting it', () => {
    expect(CREATE).toMatch(/useAuthStore\.getState\(\)\.user\?\.owns_workspace !== true/);
    // The check must sit BETWEEN the refresh and the navigation, or it proves
    // nothing about what the user is about to see.
    const refreshAt = CREATE.indexOf('recheckMembership()');
    const verifyAt = CREATE.indexOf('owns_workspace !== true');
    const navAt = CREATE.indexOf("navigation.replace('Departmental')");
    expect(verifyAt).toBeGreaterThan(refreshAt);
    expect(navAt).toBeGreaterThan(verifyAt);
    // …and it must not navigate anyway on the failure branch.
    const branch = CREATE.slice(verifyAt, navAt);
    expect(branch).toMatch(/return;/);
  });

  it('refuses a blank name without asking the server', () => {
    expect(CREATE).toMatch(/const trimmed = name\.trim\(\)/);
    expect(CREATE).toMatch(/trimmed\.length > 0 && !busy/);
  });

  it('obeys the app-wide keyboard rule instead of hand-rolling avoidance', () => {
    expect(CREATE).toMatch(/useKeyboardLayout/);
    // Banned repo-wide (CLAUDE.md B-184).
    expect(CREATE).not.toMatch(/KeyboardAvoidingView|keyboardVerticalOffset|kbHeight/);
  });
});

describe('both arms are registered in EVERY shell that mounts one', () => {
  /**
   * JoinWorkspace is mounted in two navigators. Registering the fork in only one
   * makes one arm reachable and the other silently dropped — which is exactly
   * the class of bug Phase 3 shipped ("a screen in 2 shells, a route in 1 →
   * navigate silently DROPPED").
   */
  const SHELLS = ['DepartmentalNavigator.tsx', 'MessengerNavigator.tsx'];

  it.each(SHELLS)('%s registers EnterpriseSetup and CreateWorkspace', file => {
    const nav = code(src('navigation', file));
    // The scan must be finding the sibling, or the assertions below prove nothing.
    expect(nav).toMatch(/name="JoinWorkspace"/);
    expect(nav).toMatch(/name="EnterpriseSetup"/);
    expect(nav).toMatch(/name="CreateWorkspace"/);
  });

  it.each(SHELLS)('%s imports both screen components', file => {
    const nav = code(src('navigation', file));
    expect(nav).toMatch(/import EnterpriseSetupScreen from/);
    expect(nav).toMatch(/import CreateWorkspaceScreen from/);
  });

  it.each(SHELLS)('%s no longer registers OrgChannelTree (items 03/06 retired it)', file => {
    /**
     * The SAME class, caught live: an editing slip left this route imported in
     * MessengerNavigator but never registered, so every drill-in from that
     * shell would have been silently dropped while the Departmental shell
     * worked fine — the hardest version of this bug to notice.
     *
     * Assert the REGISTRATION, not just the import: an unused import is a lint
     * error, but a registered-in-one-shell route is silent.
     */
    const nav = code(src('navigation', file));
    // items 03/06 — the drill-in is superseded by the inline collapsible tree,
    // so the route is GONE rather than registered-but-unreachable. Asserting the
    // absence in BOTH shells is what stops half a retirement: a screen left
    // registered in one navigator is the dead-UI half of the B-258 class.
    expect(nav).not.toMatch(/name="OrgChannelTree"/);
    expect(nav).not.toMatch(/import OrgChannelTreeScreen from/);
  });
});

describe('the /auth/me fan-out carries owns_workspace to EVERY consumer', () => {
  /**
   * THE DUPLICATE-COPY CLASS — the repo's most common bug shape.
   *
   * `authApi.me()` is destructured in FOUR places in authStore. Adding the flag
   * to three of them would leave one session path where the workspace owner is
   * silently locked out, and no unit test would see it because each path is
   * exercised by a different flow (boot, login, OTP, membership recheck).
   *
   * So: count them, and require every one to carry it.
   */
  it('every authApi.me() destructure includes it', () => {
    const store = code(src('store', 'authStore.ts'));
    const calls = store.match(/const \{[^}]*\} = await authApi\.me\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(4);
    for (const c of calls) {
      expect(c).toMatch(/\bowns_workspace\b/);
      // F-WSHUB — org_is_workspace is the same duplicate-copy class:
      // completeAuth and biometricSignIn dropped it (toUser defaults false),
      // so a member's hub tile rendered empty until the first recheck tick.
      expect(c).toMatch(/\borg_is_workspace\b/);
      // B-417 — owns_agency is the Ops Room key-authority owner fact: a lane
      // that drops it silently strands the workspace-joined owner's drain on
      // the next refresh through that lane.
      expect(c).toMatch(/\bowns_agency\b/);
    }
  });

  it('B-417 — routingOf carries owns_agency (the PATCH-profile rebuild lane)', () => {
    // routingOf rebuilds the user from a profile PATCH (no /auth/me refetch).
    // Its own doc comment records the failure mode: any routing field it
    // drops silently reverts on the next profile edit — for owns_agency that
    // means the owner's device loses Ops Room key authority until the next
    // full /auth/me. Anchor on the function body, not the whole file.
    const store = code(src('store', 'authStore.ts'));
    const start = store.indexOf('function routingOf(');
    expect(start).toBeGreaterThan(-1);
    const end = store.indexOf('function toUser(', start);
    expect(end).toBeGreaterThan(start);
    const body = store.slice(start, end);
    expect(body).toMatch(/owns_agency:\s*u\.owns_agency/);
  });

  it('the gate reads ownership FIRST, and only an explicit true', () => {
    const ent = code(src('store', 'entitlements.ts'));
    expect(ent).toMatch(/user\.owns_workspace === true \|\|/);
    // A truthy coercion would let a stray string from an old server read as
    // ownership. Fails closed.
    expect(ent).not.toMatch(/!!user\.owns_workspace/);
  });
});

/**
 * Client review vs2 (2026-08-09), batch A. Every rule here is an ABSENCE or a
 * fixed string, which is why these are scans and not render tests: the two
 * subtitle sites on Departmental Home sit in different branches of a ternary,
 * so a render test only ever exercises whichever one the fixture picks — the
 * exact false-green the plan warned about.
 *
 * `code()` strips comments first: these screens legitimately DISCUSS the words
 * being banned.
 */
describe('client review vs2 — batch A', () => {
  const HOME = code(src('screens', 'deptchat', 'DepartmentalHomeScreen.tsx'));
  const HUB = code(src('screens', 'deptchat', 'WorkspaceHubScreen.tsx'));
  const INCIDENT = code(src('screens', 'deptchat', 'IncidentDetailScreen.tsx'));
  const DAYSTATUS = code(src('screens', 'deptchat', 'DayStatusScreen.tsx'));

  /** Item 1 — a workspace may belong to a company, association, club, unit… */
  it('item 1 — the enterprise onboarding flow never says "company"', () => {
    for (const [name, text] of [['EnterpriseSetup', SETUP], ['CreateWorkspace', CREATE],
      ['WorkspaceHub', HUB], ['IncidentDetail', INCIDENT]] as const) {
      // Scoped to the word: `name@company.com` placeholders elsewhere are not
      // this rule's business, and none of these four files carries one.
      expect(`${name}:${/\bcompan(y|y's|ies)\b/i.test(text)}`).toBe(`${name}:false`);
    }
    // Anti-vacuity — prove the scan is reading real screens, not empty strings.
    expect(SETUP).toMatch(/Create a workspace/);
    expect(HUB).toMatch(/No workspaces yet/);
  });

  /** Item 10 — broadcasts belong inside Channels, not on the dashboard. */
  it('item 10 — no Broadcast/Announcements card on the org dashboard', () => {
    // Anchored on the SURFACE, not on a state-setter name: re-adding the card
    // as setBroadcast()/setBoardChannel() must still fail.
    expect(HOME).not.toMatch(/ANNOUNCEMENTS/);
    expect(HOME).not.toMatch(/bullhorn/);
    // The operational cards the client kept must survive the deletion.
    for (const card of ['Attendance', 'Incidents', 'Channels', 'Vault']) {
      expect(`${card}:${HOME.includes(card)}`).toBe(`${card}:true`);
    }
  });

  /** Item 14 — status names must stay inside their cards at every size. */
  it('item 14 — the day-status label can shrink and wrap', () => {
    // The cell is a fixed-width row; without both of these the label crosses
    // the card border on narrow screens and at large font scales.
    expect(DAYSTATUS).toMatch(/statText:\s*\{[^}]*\bflex:\s*1\b/);
    expect(DAYSTATUS).toMatch(/statText:\s*\{[^}]*\bminWidth:\s*0\b/);
    const cell = DAYSTATUS.slice(DAYSTATUS.indexOf('DAY_STATUSES.map'));
    expect(cell.slice(0, 700)).toMatch(/numberOfLines=\{2\}/);
  });

  // Item 11's pins live in `src/screens/messenger/__tests__/deptComposerMetrics
  // .test.ts`, alongside B-197's, because the file they guard is under
  // src/screens/messenger/** and must run inside the messenger gate — this
  // suite does not.

  /**
   * Item 3 — "the keyboard must never be in the way of text". The form was a
   * plain ScrollView with a CTA at the bottom of the scroll content.
   */
  it('item 3 — the invite form uses the blessed keyboard shell with a pinned CTA', () => {
    const INVITE = code(src('screens', 'deptchat', 'InviteMemberScreen.tsx'));
    expect(INVITE).toMatch(/<KeyboardAvoidingScreen/);
    expect(INVITE).toMatch(/footerGap=\{\d+\}/);
    // The CTA must be in the FOOTER slot, not in the scroll body.
    const footer = INVITE.slice(INVITE.indexOf('footer={'), INVITE.indexOf('footer={') + 420);
    expect(footer).toMatch(/Create invite/);
    // And the hand-rolled inset formula must be gone — one rule, one place.
    expect(INVITE).not.toMatch(/const bottomPad = \(gap/);
  });

  /** Item 15 — the category grid is the FIRST screen of Incident Report. */
  it('item 15 — the member Incident root is the category grid', () => {
    const NAV = code(src('navigation', 'DepartmentalNavigator.tsx'));
    // UI corrections 2026-08-15 item 09 SUPERSEDES the role branch: BOTH roles
    // now root at the grid. Item 15's actual requirement — "the first dashboard
    // you see when you enter Incident Report is the grid" — is strengthened by
    // that, not weakened, so the pin follows it.
    expect(NAV).toMatch(/initialRouteName="ReportIncidentCategory"/);
    // My Reports must stay reachable, or the member loses their own history.
    const CAT = code(src('screens', 'deptchat', 'ReportIncidentCategoryScreen.tsx'));
    expect(CAT).toMatch(/navigate\('MyIncidents'\)/);
    // …and "Done" must land there rather than on a blank new report, which is
    // what this screen's own copy promises. Assert the ORDERED PAIR: dropping
    // the popToTop leaves the just-submitted screen in the stack (back would
    // return into it) while a lone `navigate('MyIncidents')` assertion stays
    // green — a real mutation hole.
    const DONE = code(src('screens', 'deptchat', 'IncidentSubmittedScreen.tsx'));
    expect(DONE).toMatch(/popToTop\(\);\s*navigation\.navigate\('MyIncidents'\)/);
  });

  /**
   * Item 15's own hazard: as the module ROOT this screen never unmounts, so a
   * finished report's category/severity would stay selected and silently
   * pre-categorise the next one. The reset must live in the SAME focus effect
   * that reloads the draft.
   */
  it('item 15 — the root grid clears its selection after a SUBMIT only', () => {
    const CAT = code(src('screens', 'deptchat', 'ReportIncidentCategoryScreen.tsx'));
    const effect = CAT.slice(CAT.indexOf('useFocusEffect(useCallback('));
    const body = effect.slice(0, effect.indexOf('}, [userId]));'));
    expect(body).toMatch(/consumeIncidentSubmitted\(\)/);
    expect(body).toMatch(/setCategory\(null\)/);
    expect(body).toMatch(/setSeverity\(null\)/);
    // Anti-vacuity: prove the slice really is the focus effect.
    expect(body).toMatch(/loadIncidentDraft/);
    // The flag is worthless unless the submit path raises it.
    const DETAILS = code(src('screens', 'deptchat', 'ReportIncidentDetailsScreen.tsx'));
    expect(DETAILS).toMatch(/markIncidentSubmitted\(\)/);
  });

  /**
   * The Home card must NAME the wizard. Done deliberately leaves the Incident
   * stack on My Reports, so a bare navigate would re-enter there — "Log an
   * incident" opening the reports list.
   */
  it('item 15 — the member Home card lands on the wizard, not wherever it was left', () => {
    expect(HOME).toMatch(/navigate\('Incident', \{screen: 'ReportIncidentCategory', initial: false\}\)/);
    // item 09 — the manager no longer gets a bare tab open: their root is the
    // grid too, so the card names the grid for BOTH roles and the queue gets its
    // own explicitly-named doors (the Open-incidents tile, and the Review row on
    // the grid). A bare navigate here would re-enter wherever the stack was left.
    expect(HOME).not.toMatch(/isManager\)?\s*\{\s*navigation\.navigate\('Incident'\);/);
    expect(HOME).toMatch(/navigate\('Incident', \{screen: 'IncidentQueue', initial: false\}\)/);
  });

  /** Item 17 (rename half) — the surface is called Channels. */
  it('item 17 — the dashboard is titled Channels, with no "Department" left', () => {
    expect(HOME).toMatch(/headerTitle\}>Channels</);
    // Two subtitle sites exist (hub arm + fallback arm). A flat absence covers
    // both; a render test would only ever see one.
    expect(HOME).not.toMatch(/·\s*Department\b/);
    expect(HOME).not.toMatch(/>Departmental</);
  });
});
