import {CommonActions} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {navigationRef, mountedTreeHasRoute} from './navigationRef';

/**
 * Issues 18 + 19 (Testing Issues V2, pp.23–24) — "Departmental Chat Entry Card
 * Does Not Open" / "Attendance and Incidents Entry Does Not Open Across
 * Dashboards".
 *
 * ROOT CAUSE. `GroupsScreen` is registered in TWO shells — MessengerNavigator
 * (`Groups`) and AgentNavigator (`Groups`) — but `DepartmentChannels` is
 * registered in MessengerNavigator ONLY. MainNavigator renders exactly one of
 * CpoNavigator / AgentNavigator / the client tab shell, so when a
 * service-provider account is in the Agent shell there is no
 * `DepartmentChannels` route anywhere in the mounted tree: `navigate()` finds no
 * target, bubbles to the root, and is DROPPED. In a release build that is a
 * completely silent no-op — "the card does not open", exactly as reported, and
 * on the role most likely to hold the entitlement.
 *
 * It typechecked because the screen types its navigation as
 * `MessengerStackParamList` at both mount points, so TS validated the route
 * against a param list that only one of the two shells actually implements.
 *
 * THE RULE HERE: never navigate to a hard-coded route name from a screen that
 * more than one navigator hosts. Ask the mounted tree which of the candidate
 * routes it actually has, take the first that exists, and if none does say so
 * out loud instead of dropping the tap. The PDF asks for exactly this — "repair
 * the shared route and entitlement check; do not duplicate broken navigation in
 * separate layouts".
 */

/** The structural slice of a React Navigation object this module needs. Kept
 *  structural on purpose: the helper runs under three different param lists
 *  (Messenger / Agent / Cpo), so no single generated type fits all callers. */
export interface RouteAwareNavigation {
  navigate: (...args: never[]) => void;
  getParent?: () => RouteAwareNavigation | undefined;
  getState?: () => {routeNames?: string[]} | undefined;
}

/**
 * A navigation object that can actually BE resolved against the mounted tree.
 *
 * `RouteAwareNavigation` leaves `getParent`/`getState` optional, which is right
 * for the walk itself — it must tolerate whatever it is handed and simply find
 * nothing. It is wrong as an ENTRY contract: a caller passing `{navigate}`
 * alone typechecked cleanly while making every candidate miss, so the resolver
 * silently degraded to its "no door anywhere" Alert (R10-2). Requiring the two
 * accessors at the entry point turns that into a compile error at the call
 * site, which is where it can be fixed.
 */
export interface ResolvableNavigation extends RouteAwareNavigation {
  getParent: () => RouteAwareNavigation | undefined;
  getState: () => {routeNames?: string[]} | undefined;
}

/** How deep to walk before giving up — a guard against a cyclic parent chain,
 *  not a real limit (the deepest shell in this app nests 3 navigators). */
const MAX_DEPTH = 10;

/**
 * Walk this navigator and every ancestor, returning the first one that actually
 * registers `route`. Returns null when no navigator in the mounted tree does —
 * which is the case a bare `navigate()` swallows.
 */
export function findNavigatorWithRoute(
  nav: RouteAwareNavigation | undefined | null,
  route: string,
): RouteAwareNavigation | null {
  let cur = nav ?? null;
  for (let depth = 0; cur && depth < MAX_DEPTH; depth++) {
    if (cur.getState?.()?.routeNames?.includes(route) === true) {
      return cur;
    }
    cur = cur.getParent?.() ?? null;
  }
  return null;
}

/** True when this screen is already rendered inside DepartmentalNavigator's
 *  5-tab shell (Home · Channels · Attend · Incident · Vault).
 *
 *  Replaces a single-level `getParent()` probe: that only ever inspected ONE
 *  navigator, so it read false in any shell that nests deeper than the case it
 *  was written for — and a false reading routes into a re-entry of a shell the
 *  user is already looking at, which presents as "nothing happened". */
export function isInDepartmentalShell(nav: RouteAwareNavigation | undefined | null): boolean {
  return findNavigatorWithRoute(nav, 'Attend') !== null;
}

interface EntryResult {
  ok: boolean;
  /** Which candidate actually resolved — asserted by the regression tests. */
  via: 'direct' | 'shell' | 'tab' | 'sibling' | 'none';
}

export function navigateVia(
  target: RouteAwareNavigation,
  ...args: unknown[]
): void {
  (target.navigate as unknown as (...a: unknown[]) => void)(...args);
}

/**
 * Open the Department Channels directory from whichever shell the caller is in.
 *
 * `DepartmentChannels` (the standalone screen) when the host navigator has it;
 * otherwise the full `Departmental` workspace shell focused on its Channels tab
 * — which is the only door the Agent and CPO shells register. An account whose
 * tree has neither gets a message, never a dead tap.
 *
 * `opts.preferHome` (founder QA 2026-08-08): a workspace MEMBER/OWNER tapping
 * the menu wants their DASHBOARD (the Departmental shell's Home tab — counts,
 * announcements, quick actions), not the raw channel list. The caller decides
 * (it knows the entitlements; this resolver does not) — non-members keep the
 * directory, which owns the join gate and the Enterprise upsell.
 */
export function openDepartmentChannels(
  nav: ResolvableNavigation,
  opts?: {preferHome?: boolean},
): EntryResult {
  if (opts?.preferHome) {
    // The shell wins when mounted. The Home TAB is named EXPLICITLY: a bare
    // navigate('Departmental') only lands on Home for a COLD mount — from a
    // WARM shell (the user is inside it, on Attend, or deep in a channel
    // thread) navigating to the already-focused route with no params changes
    // nothing, and the drawer row promising the dashboard reads as a dead tap
    // (both reviewers, round 1).
    const homeShell = findNavigatorWithRoute(nav, 'Departmental');
    if (homeShell) {
      navigateVia(homeShell, 'Departmental', {screen: 'Home', initial: false});
      return {ok: true, via: 'shell'};
    }
    if (mountedTreeHasRoute('MessengerTab') && navigationRef.isReady()) {
      navigationRef.dispatch(CommonActions.navigate('Main', {
        screen: 'MessengerTab',
        params: {screen: 'Departmental', params: {screen: 'Home', initial: false}, initial: false},
      }));
      return {ok: true, via: 'sibling'};
    }
    // No shell anywhere in this tree — fall through to the directory branches.
  }
  const direct = findNavigatorWithRoute(nav, 'DepartmentChannels');
  if (direct) {
    navigateVia(direct, 'DepartmentChannels');
    return {ok: true, via: 'direct'};
  }
  const shell = findNavigatorWithRoute(nav, 'Departmental');
  if (shell) {
    // R11-6 — name the DIRECTORY, not just the tab. A bare `{screen: 'Channels'}`
    // is a tab switch, so if the Channels stack is already deep (the user opened
    // a channel, then went elsewhere) this control lands on the chat thread
    // rather than the directory it advertises. Naming the route makes
    // StackRouter POP back to it when it is already there, and `initial: false`
    // keeps the root correct on a cold stack.
    navigateVia(shell, 'Departmental', {
      screen: 'Channels',
      params: {screen: 'DepartmentChannels', initial: false},
    });
    return {ok: true, via: 'shell'};
  }
  // The R7-1 SIBLING case, same as openJoinFlowScreen's: in the client tab
  // shell the drawer is opened from SecureTab / the VBG home, and the workspace
  // routes live under the SIBLING MessengerTab — an ancestor walk can never see
  // them. Without this branch an Enterprise subscriber got the "no door" alert
  // below, which read as "agency accounts only" (founder report, 2026-08-07).
  // Placed AFTER `shell` so agency/CPO trees keep resolving via Departmental.
  //
  // WITHOUT preferHome this targets the STANDALONE directory, exactly like the
  // `direct` branch — not the Departmental workspace shell. The directory is
  // what the destination navigator registers first; it is also the screen that
  // carries the non-entitled gate and its Enterprise upsell, so a Lite/Pro
  // user landing here keeps the same pitch they get from the Messenger tab
  // (edge-case review #1/#2). Members get the dashboard via preferHome above.
  if (mountedTreeHasRoute('MessengerTab') && navigationRef.isReady()) {
    navigationRef.dispatch(CommonActions.navigate('Main', {
      screen: 'MessengerTab',
      params: {screen: 'DepartmentChannels', initial: false},
    }));
    return {ok: true, via: 'sibling'};
  }
  // Reachable only from a torn/pre-auth tree now (every mounted shell has
  // either an ancestor `Departmental` or a sibling `MessengerTab`), so the copy
  // is a transient "try again" — never a statement about the account type, and
  // never an instruction to open a tab this tree provably does not have.
  Alert.alert(
    'Department Channels unavailable',
    'Department Channels couldn’t be opened right now. Please try again.',
  );
  return {ok: false, via: 'none'};
}

/**
 * Scope v2 Phase 3 — open one of the join/approval screens (`Approvals`,
 * `JoinWorkspace`, `ApprovalStatus`) from whichever shell the caller is in.
 *
 * Same class of bug as Issue 18, found in review round 6: all three were
 * registered ONLY in MessengerNavigator, while every approver persona — agency
 * owner AND promoted org manager (`resolveRoute.ts:60`) — is routed into
 * AgentNavigator, which does not mount it. The call sites used a bare
 * `if (host) { navigate }` with no else, so the tap was silently dropped: an
 * admin could receive the "join requested" notification and never open the
 * inbox, and the loop ended at "pending" permanently.
 *
 * They are now also registered on the Departmental shell's Channels stack, so
 * the candidates are: the Channels TAB when we are already inside the shell
 * (a direct hit can be on a navigator OUTSIDE it, and pushing there covers the
 * tab bar) · the host navigator directly · the tab otherwise · entering the
 * shell focused on that screen · and finally a SIBLING branch of the mounted
 * tree, which an ancestor walk cannot see.
 *
 * `initial: false` IS LOAD-BEARING — do not "tidy" it away (R9-2). React
 * Navigation overrides a child navigator's `initialRouteName` with the nested
 * screen whenever `params.initial !== false`
 * (`@react-navigation/core` useNavigationBuilder). The Channels stack is lazy,
 * so an admin whose FIRST entry to the workspace is the Home-tab "Approvals"
 * card would root that stack at the approvals inbox with **no history**: back
 * falls out of the stack, and "Department Channels" then lands on the inbox for
 * the life of the shell — a dead end `openDepartmentChannels` cannot repair,
 * because its own shell branch carries no inner screen. With `initial: false`
 * the stack initialises at `DepartmentChannels` and the target is pushed on top.
 *
 * PHASE 6 NOTE — this resolver deliberately carries no CALLER params: every
 * branch passes only the route (plus the `initial` flag above). M5's `{code}`
 * deep link therefore cannot be wired by adding a `linking` config alone; the
 * param has to be threaded through here first, or the code will be silently
 * dropped on three of the five branches.
 */
export function openJoinFlowScreen(
  nav: ResolvableNavigation,
  // EnterpriseSetup is the create-or-join FORK (Phase 6). It resolves through
  // the same candidate ladder as its siblings because it is registered on the
  // same stacks — omitting it here made the fork typecheck-fail at the one
  // call site that needs it.
  route: 'Approvals' | 'JoinWorkspace' | 'ApprovalStatus' | 'EnterpriseSetup',
): EntryResult {
  // ORDER MATTERS, and inside the workspace the TAB hop outranks a direct hit.
  //
  // R8-5: in a departmental shell hosted by MessengerNavigator, the ancestor
  // walk from the Home tab finds `Approvals` on MessengerNavigator — OUTSIDE
  // the shell — and pushes it full-screen over the workspace, losing the tab
  // bar. Routing through the Channels tab keeps the user inside the shell they
  // are looking at, which is what this resolver's contract says. Outside the
  // shell there is no tab to hop and `direct` is tried first as before.
  const tabs = findNavigatorWithRoute(nav, 'Channels');
  if (tabs && isInDepartmentalShell(nav)) {
    navigateVia(tabs, 'Channels', {screen: route, initial: false});
    return {ok: true, via: 'tab'};
  }
  const direct = findNavigatorWithRoute(nav, route);
  if (direct) {
    navigateVia(direct, route);
    return {ok: true, via: 'direct'};
  }
  // Reached only if some future shell registers `Channels` without `Attend`.
  if (tabs) {
    navigateVia(tabs, 'Channels', {screen: route, initial: false});
    return {ok: true, via: 'tab'};
  }
  const shell = findNavigatorWithRoute(nav, 'Departmental');
  if (shell) {
    navigateVia(shell, 'Departmental', {screen: 'Channels', params: {screen: route, initial: false}});
    return {ok: true, via: 'shell'};
  }
  // R7-1 — the SIBLING case, and the one an ancestor walk cannot reach.
  //
  // The applicant is a CLIENT account (they bought a plan, or hold a printed
  // code), so their ActivityCenter is BookingNavigator's, under SecureTab. The
  // three routes are registered under the sibling MessengerTab. Walking up from
  // BookingNavigator reaches the tab navigator and the root and finds none of
  // them — so tapping "your request was approved" alerted "not available here",
  // on the notification this whole phase exists to deliver.
  if (mountedTreeHasRoute('MessengerTab') && navigationRef.isReady()) {
    navigationRef.dispatch(
      CommonActions.navigate('Main', {
        screen: 'MessengerTab',
        params: {screen: route, initial: false},
      }),
    );
    return {ok: true, via: 'sibling'};
  }
  // Same torn-tree residue as its siblings above — account-neutral copy (the
  // old "organisation account" wording misread an Enterprise subscriber as
  // needing an agency login; founder report 2026-08-07).
  Alert.alert(
    'Not available here',
    'This screen couldn’t be opened right now. Please try again.',
  );
  return {ok: false, via: 'none'};
}

/**
 * Open Attendance & Incidents.
 *
 * Inside the departmental shell this is a TAB SWITCH — re-entering a mounted
 * shell stacks a second identical copy, which reads as a dead tap. Outside it,
 * enter the shell already focused on `Attend`: the previous version navigated
 * to `Departmental` with no params and landed on the shell's default Home tab,
 * so even when it did navigate it did not open what the card advertised.
 */
export function openAttendance(nav: ResolvableNavigation): EntryResult {
  const tabs = findNavigatorWithRoute(nav, 'Attend');
  if (tabs) {
    navigateVia(tabs, 'Attend');
    return {ok: true, via: 'tab'};
  }
  const shell = findNavigatorWithRoute(nav, 'Departmental');
  if (shell) {
    navigateVia(shell, 'Departmental', {screen: 'Attend'});
    return {ok: true, via: 'shell'};
  }
  // R7-1 sibling branch — see openDepartmentChannels above for why. There is no
  // standalone Attend route (its uniqueness is pinned), so this one DOES enter
  // the shell, focused on the tab — the same shape the `shell` branch uses.
  // Unreachable from today's only caller (DepartmentChannelsScreen, whose
  // hosting navigator always registers `Departmental`, so `shell` wins first);
  // kept for symmetry and for future callers outside the messenger stack.
  if (mountedTreeHasRoute('MessengerTab') && navigationRef.isReady()) {
    navigationRef.dispatch(CommonActions.navigate('Main', {
      screen: 'MessengerTab',
      params: {screen: 'Departmental', initial: false, params: {screen: 'Attend'}},
    }));
    return {ok: true, via: 'sibling'};
  }
  Alert.alert(
    'Attendance unavailable',
    'Attendance couldn’t be opened right now. Please try again.',
  );
  return {ok: false, via: 'none'};
}

/**
 * Open the roster (Employees) from anywhere in the workspace shell.
 *
 * vs2 item 13 — "the user must be shown how to add a member to a shift before
 * the attendance review can continue". The two screens that need a roster
 * (Set day status, the shift editor's assign list) live on the ATTEND stack
 * while the roster lives on the CHANNELS stack, so neither can reach it with a
 * bare navigate: the route is not in their own stack and the call is dropped.
 * Same ladder as `openAttendance`, for the same reason.
 *
 * Unlike the push lane, callers here are SCREENS — they hand over a real
 * navigation object with a parent chain, so the walk actually resolves.
 */
export function openEmployees(nav: ResolvableNavigation): EntryResult {
  const tabs = findNavigatorWithRoute(nav, 'Channels');
  // R8-5 — the TAB HOP wins while we are inside the shell, exactly as
  // openJoinFlowScreen orders it. `Employees` is ALSO registered on
  // MessengerNavigator, which is an ancestor of the shell on the client/CPO
  // entry paths — so a `direct` walk finds that outer copy and pushes the
  // roster full-screen OVER the workspace, losing its tab bar. Whether that
  // happened depended on which door the user came through, which is the
  // nastiest shape this file exists to prevent.
  if (tabs && isInDepartmentalShell(nav)) {
    navigateVia(tabs, 'Channels', {screen: 'Employees', initial: false});
    return {ok: true, via: 'tab'};
  }
  const direct = findNavigatorWithRoute(nav, 'Employees');
  if (direct) {
    navigateVia(direct, 'Employees');
    return {ok: true, via: 'direct'};
  }
  if (tabs) {
    navigateVia(tabs, 'Channels', {screen: 'Employees', initial: false});
    return {ok: true, via: 'tab'};
  }
  const shell = findNavigatorWithRoute(nav, 'Departmental');
  if (shell) {
    navigateVia(shell, 'Departmental', {screen: 'Channels', params: {screen: 'Employees', initial: false}});
    return {ok: true, via: 'shell'};
  }
  Alert.alert('Roster unavailable', 'The roster couldn’t be opened right now. Please try again.');
  return {ok: false, via: 'none'};
}
