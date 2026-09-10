import {resolveAuthedRoute} from './resolveRoute';

/**
 * B-257 / B-258 — where the messenger screens actually live, per shell.
 *
 * THE BUG. Every notification deep-link hard-coded ONE path:
 *
 *     navigate('Main', {screen: 'MessengerTab', params: {screen: 'CallScreen', …}})
 *
 * `MessengerTab` exists only in the CLIENT tab shell. `MainNavigator` mounts
 * exactly one shell per account kind and returns `<CpoNavigator/>` or
 * `<AgentNavigator/>` BEFORE it ever reaches those tabs, so for a CPO or an
 * agency account that route is not in the mounted tree at all. React Navigation
 * drops an unresolvable navigate silently, which left the user sitting on
 * whatever was on screen — in practice the product gate, "Choose Dashboard".
 *
 * For a message that is an annoyance. For a CALL it is the whole bug: the
 * accept runs inside CallScreen (`useCall` consumes the cached offer SDP and
 * answers). No CallScreen mounted → nobody ever answers → the caller rings out
 * and the call "fails or cuts". Answering from the notification was therefore
 * broken for every CPO and agency account.
 *
 * The routes were never missing — they are registered in all three shells, just
 * at three different paths:
 *
 *   | shell  | path to CallScreen                            |
 *   | ------ | --------------------------------------------- |
 *   | client | Main -> MessengerTab -> CallScreen            |
 *   | agency | CallScreen              (AgentNavigator root) |
 *   | cpo    | CpoTabs -> CpoComms -> CallScreen             |
 *
 * This module is the ONE place that knows that table, and it decides the shell
 * with `resolveAuthedRoute` — the same pure function `MainNavigator` uses to
 * choose which shell to mount. Deriving it a second way is how the deep-link
 * and the shell would drift apart again.
 *
 * This is the third instance of one pattern in this codebase (see B-251 and
 * Issues 18/19): a hard-coded route name that only holds in one of several
 * mounted shells. If you are about to write a literal route name in code that
 * more than one shell can run, resolve it here instead.
 */

/** Messenger screens a notification can deep-link into. Registered under all
 *  three shells — only the PATH differs. */
export type MessengerTarget =
  | 'MessengerHome'
  | 'Chat'
  | 'CallScreen'
  | 'GroupCallScreen'
  | 'IncomingGroupCallScreen'
  | 'CallsLog'
  // F4 — a department-channel notification tap must NOT land on ChatScreen (it
  // renders phone/video buttons unconditionally, and the PDF's A9/M9 rule is
  // "no phone/call button appears in Department Channel chat").
  | 'DepartmentChat'
  | 'DepartmentChannels'
  // R13-2 — the enterprise join-loop wakes (A11 admin inbox / M11A status).
  // Registered in MessengerNavigator and on the Departmental Channels stack.
  | 'Approvals'
  | 'ApprovalStatus'
  // vs2 item 16 — incident wakes. Registered on the Departmental shell's
  // INCIDENT tab (not the Channels stack), which is why they need their own
  // nesting below rather than joining AGENCY_WORKSPACE_ROUTES.
  | 'IncidentDetail'
  | 'IncidentQueue'
  | 'MyIncidents';

/**
 * What AgentNavigator registers on its root stack. The agency shell is the one
 * that does NOT nest MessengerNavigator, so it hosts a hand-picked subset.
 * Anything outside this set has to degrade to a screen that exists, or we are
 * back to a silently dropped navigate, which is the whole bug.
 *
 * N2 — `CallsLog` was added to AgentNavigator (the MessengerHome footer's Call
 * tap bare-navigates to it and silently no-op'd in this shell), so it now
 * routes directly here too instead of degrading, matching the CPO shell which
 * nests the whole MessengerNavigator.
 */
const AGENCY_ROOT_ROUTES: ReadonlySet<string> = new Set<MessengerTarget>([
  'MessengerHome', 'Chat', 'CallScreen', 'GroupCallScreen', 'IncomingGroupCallScreen', 'CallsLog',
]);

/**
 * F4 — targets the agency shell reaches ONLY through the Departmental workspace.
 *
 * AgentNavigator registers `Departmental` and nothing that lives inside it, so
 * these two would otherwise degrade to `MessengerHome` — dropping an agency
 * owner (a persona who is in every channel) on the chat list instead of the
 * channel post they tapped. The nesting is the same one `departmentalEntry`
 * uses, `initial: false` included: without it React Navigation ROOTS the lazy
 * Channels stack at the target, so back falls out of the stack and the
 * directory is unreachable for the life of the shell (R9-2).
 */
const AGENCY_WORKSPACE_ROUTES: ReadonlySet<string> = new Set<MessengerTarget>([
  'DepartmentChat', 'DepartmentChannels',
  // R13-2 — same reach: AgentNavigator registers `Departmental`, and the
  // join/approval screens sit on its Channels stack (Phase 3 registered them
  // there precisely because every approver persona lives in this shell).
  'Approvals', 'ApprovalStatus',
]);

/**
 * vs2 item 16 — targets on the Departmental shell's INCIDENT tab.
 *
 * Every shell reaches these through `Departmental`, but the tab differs from
 * the Channels-stack set above, so the nesting is `Departmental → Incident →
 * leaf` rather than `Departmental → Channels → leaf`. Split out because an
 * incident wake landing on the channel directory is exactly the bug item 16
 * exists to fix.
 */
const DEPT_INCIDENT_ROUTES: ReadonlySet<string> = new Set<MessengerTarget>([
  'IncidentDetail', 'IncidentQueue', 'MyIncidents',
]);

interface NavLike {
  isReady?: () => boolean;
  navigate: (name: string, params?: unknown) => void;
}

interface ShellSignals {
  accountKind?: string;
  mustSetPassword?: boolean;
  membershipStatus?: string | null;
  cpoNeedsOnboarding?: boolean;
  legacyRole?: string;
  pendingProvider?: boolean;
  isOrgManager?: boolean;
}

/**
 * The nav action for `target` under the shell implied by `signals`.
 *
 * Pure and exported so the three-shell table can be asserted exhaustively in a
 * unit test — the device matrix for "answer a call from a notification as a
 * CPO" is expensive, and this is the part that was wrong.
 */
/**
 * vs2 edge A9 — does a dept THREAD tap actually land the user inside the
 * workspace surface on THIS shell?
 *
 * `adoptOrgContext`'s contract is explicit: do NOT adopt a sticky org context
 * from a door that does not put the user inside that org's surface, because the
 * context also decides the DESTINATION of clock-in, incident submit and invite
 * mint — writes with no drift guard.
 *
 * Only the AGENCY shell routes `DepartmentChat` through `Departmental →
 * Channels`. The client and CPO shells reach `MessengerNavigator`'s copy, where
 * Back lands on `MessengerHome` — which `scopeChannelsToActiveWorkspace`
 * explicitly excludes from workspace scoping. So on those shells the A9 symptom
 * does not occur AND adopting would repoint a global with nothing on screen
 * naming the new org.
 *
 * Lives HERE, beside the routing table it reads, so it cannot drift from the
 * decision it mirrors — a second copy of "which shell enters Departmental" is
 * this repo's most-shipped bug shape.
 */
export function deptThreadEntersWorkspaceSurface(): boolean {
  try {
    const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
    const u = useAuthStore.getState().user;
    return resolveAuthedRoute({
      accountKind:        u?.account_kind,
      mustSetPassword:    u?.must_set_password,
      membershipStatus:   u?.membership_status,
      cpoNeedsOnboarding: u?.cpo_needs_onboarding,
      legacyRole:         u?.role,
      isOrgManager:       u?.is_org_manager,
    } as Parameters<typeof resolveAuthedRoute>[0]) === 'agency';
  } catch {
    return false;   // no store — never adopt on a guess
  }
}

export function messengerRouteFor(
  target: MessengerTarget,
  params: Record<string, unknown>,
  signals: ShellSignals,
  opts?: {
    /**
     * B-85, load-bearing on the Chat deep-links: without `initial: false`
     * React Navigation treats the nested screen as the stack's initial route
     * and seeds [Chat] ALONE, so Back bubbles past the chat list to the
     * dashboard. With it, MessengerHome is seeded underneath. Only meaningful
     * on the nested paths — the agency shell pushes onto a live stack.
     */
    initial?: boolean;
  },
): {name: string; params?: unknown} {
  const shell = resolveAuthedRoute(signals as Parameters<typeof resolveAuthedRoute>[0]);
  // Omit an empty params object rather than sending `params: {}`. RN6's
  // navigate() REPLACES params, so an empty object is not inert — it would
  // clobber the params of an already-mounted screen. It also keeps the emitted
  // action byte-identical to what every pre-existing call site produced.
  const hasParams = Object.keys(params).length > 0;
  const leaf = {
    screen: target,
    ...(opts?.initial === false ? {initial: false} : {}),
    ...(hasParams ? {params} : {}),
  };

  // Incident targets first: the nesting is the same in the two provider shells
  // (both register `Departmental` on their ROOT stack) and only the client
  // shell needs the extra MessengerTab hop.
  if (DEPT_INCIDENT_ROUTES.has(target)) {
    /**
     * item 09 — SEED THE QUEUE UNDER AN INCIDENT DETAIL.
     *
     * The Incident tab used to root at IncidentQueue for a manager, so a push
     * that opened IncidentDetail had the queue beneath it and Back returned
     * there. Item 09 moved that root to the report screen, which would have left
     * a manager backing out of an incident onto a category grid.
     *
     * A screen+initial:false payload can only ever seed [initialRouteName,
     * target] — it cannot express "put IncidentQueue underneath". A nested
     * state payload can, so the detail lane uses one. The other two targets
     * (IncidentQueue itself, MyIncidents) are their own destination and keep the
     * simpler form.
     *
     * Warm-stack caveat, stated because it is not fixable here: if the Incident
     * stack is already mounted, the existing stack wins and no seeding happens.
     * That is React Navigation's behaviour for every payload shape.
     */
    const incidentLeaf = target === 'IncidentDetail'
      ? {
        screen: 'Incident',
        params: {
          state: {
            index: 1,
            routes: [
              {name: 'IncidentQueue'},
              {name: target, ...(hasParams ? {params} : {})},
            ],
          },
        },
      }
      : {
        screen: 'Incident',
        params: {screen: target, initial: false, ...(hasParams ? {params} : {})},
      };
    return shell === 'agency' || shell === 'cpo'
      ? {name: 'Departmental', params: incidentLeaf}
      : {name: 'Main', params: {screen: 'MessengerTab', params: {screen: 'Departmental', initial: false, params: incidentLeaf}}};
  }

  if (shell === 'agency') {
    // AgentNavigator registers the messenger screens directly on its root
    // stack, so the target IS the route name — when it registers it at all.
    if (AGENCY_ROOT_ROUTES.has(target)) {
      return {name: target, params: hasParams ? params : undefined};
    }
    if (AGENCY_WORKSPACE_ROUTES.has(target)) {
      return {
        name:   'Departmental',
        params: {screen: 'Channels', params: {screen: target, initial: false, ...(hasParams ? {params} : {})}},
      };
    }
    return {name: 'MessengerHome', params: undefined};
  }

  if (shell === 'cpo') {
    // CpoNavigator mounts MessengerNavigator as the CpoComms TAB.
    return {name: 'CpoTabs', params: {screen: 'CpoComms', params: leaf}};
  }

  // Client tabs — and the safe default. A shell we do not recognise is far more
  // likely to be the consumer one than a provider one, and this is also the
  // path every pre-existing build used.
  return {name: 'Main', params: {screen: 'MessengerTab', params: leaf}};
}

/**
 * Navigate to a messenger screen in whichever shell is mounted.
 *
 * Returns false when navigation is not ready — callers already own the
 * wait-for-ready loop and should not treat this as "route missing".
 */
export function navigateToMessengerScreen(
  nav: NavLike | null | undefined,
  target: MessengerTarget,
  params: Record<string, unknown>,
  opts?: {initial?: boolean},
): boolean {
  /**
   * A MISSING `isReady` means "screen navigation object", not "not ready".
   *
   * `isReady` exists only on the NavigationContainer ref. A screen or tab
   * `navigation` object — what `useNavigation()` and a tab listener hand you —
   * does not have it, and cannot: it only exists because its navigator is
   * already mounted and rendering. The old `!nav?.isReady?.()` treated
   * `undefined` as "not ready" and returned false having navigated NOWHERE,
   * silently, while typechecking cleanly because `isReady?:` is declared
   * optional.
   *
   * Three call sites were dead on that alone, and nothing caught it because
   * every pin over them is a source scan that reads the call and not its
   * effect:
   *   - `openConversation` (the dept-channel arm) — called with screen nav from
   *     MessengerHome, Groups and Links, so tapping a department channel in any
   *     of those lists did nothing at all. The A9/M9 rule "no dept conversation
   *     opens in ChatScreen" was being satisfied by accident.
   *   - `ActivityCenterScreen`'s incident rows.
   *   - the workspace's Messenger exit (added 2026-08-11, which is how this
   *     surfaced: it took a working exit away from two shells to fix a third).
   *
   * Only ABSENCE is treated as ready. A container ref that reports not-ready is
   * still refused — that check exists for the cold-boot push lane, where the
   * tree genuinely may not exist yet.
   */
  if (!nav) {return false;}
  if (nav.isReady && !nav.isReady()) {return false;}
  let signals: ShellSignals = {};
  try {
    // Lazy require: this module is pulled in by the push bootstrap, which runs
    // in headless JS where a static store import would drag the whole app graph.
    const {useAuthStore} = require('@store/authStore') as typeof import('@store/authStore');
    const s = useAuthStore.getState();
    const u = s.user;
    signals = {
      accountKind:        u?.account_kind,
      mustSetPassword:    u?.must_set_password,
      membershipStatus:   u?.membership_status,
      cpoNeedsOnboarding: u?.cpo_needs_onboarding,
      legacyRole:         u?.role,
      pendingProvider:    (s as unknown as {pendingProvider?: boolean}).pendingProvider,
      isOrgManager:       u?.is_org_manager,
    };
  } catch {
    // No store yet (cold headless start) — fall through to the client path,
    // which is what every build did before this module existed.
  }
  const route = messengerRouteFor(target, params, signals, opts);
  // Wrapped. The old readiness gate shielded this incidentally; now that a
  // screen nav object gets through, a malformed one would throw into whatever
  // called us — and one caller is a `tabPress` listener that has already run
  // `e.preventDefault()`, so a throw there eats the press AND raises.
  try {
    nav.navigate(route.name, route.params);
  } catch {
    return false;
  }
  return true;
}
