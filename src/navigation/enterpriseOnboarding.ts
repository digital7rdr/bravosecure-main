import {navigationRef, mountedTreeHasRoute} from './navigationRef';
import {openJoinFlowScreen, type ResolvableNavigation} from './departmentalEntry';

/**
 * F1 — the Enterprise create-or-join fork (PDF frames A4/M4) had NO runtime door.
 *
 * THE BUG. `EnterpriseSetupScreen` and `CreateWorkspaceScreen` are built and
 * registered (MessengerNavigator + DepartmentalNavigator's Channels stack), but
 * the only `navigate('EnterpriseSetup')` in the whole app lives inside
 * `DepartmentChannelsScreen` — a screen a brand-new Enterprise customer has no
 * reason to open and, in the client shell, would not know exists. The
 * post-registration flow is:
 *
 *     pre-auth tier pick -> pendingTier.set('enterprise') -> register/OTP
 *       -> MainNavigator renders <TierPaywall standalone> -> onDone
 *       -> setActiveProduct('messenger') -> the Messenger chat list
 *
 * so the fork — "are you creating a company or joining one?" — was never asked
 * of the one person it exists for. They landed in a personal chat list with no
 * workspace and no visible way to make one.
 *
 * THE FIX is this module: the paywall's resolution is the moment the tier stops
 * being "pending" and becomes the account's, so that is where the fork is asked.
 *
 * WHY IT WAITS. `resolvePaywall` unmounts the paywall and mounts the product
 * tree in the same tick (and MainNavigator deliberately holds ONE navigator-free
 * frame on a product switch — B-95), so at call time no shell registers
 * `EnterpriseSetup` yet and a navigate would be dropped silently. We poll the
 * MOUNTED tree for the route itself — not a timer guess — and only then hand off
 * to `openJoinFlowScreen`, the one resolver that knows where the join/fork
 * screens live in each shell. Re-deriving that path here is exactly the
 * duplicate-copy drift this repo keeps paying for.
 *
 * SAFE FOR AN EXISTING OWNER: `EnterpriseSetupScreen` redirects to the workspace
 * when the account already owns one, so a re-entry is a no-op, not a trap.
 */

/** The tier picked pre-auth, as `pendingTier` stores it. */
export type ResolvedPaidTier = 'pro' | 'enterprise' | null | undefined;

/**
 * Does resolving the paywall with this tier owe the user the A4/M4 fork?
 *
 * Pure so the decision can be pinned without a navigator. `subscribed` is
 * TierPaywall's own `onDone(subscribed)` argument: declining ("Start as Lite
 * today") lands a Lite account, and a Lite account is not asked to create a
 * company workspace.
 */
export function shouldAskEnterpriseSetup(tier: ResolvedPaidTier, subscribed: boolean): boolean {
  return tier === 'enterprise' && subscribed === true;
}

/** Poll cadence + ceiling for the wait described above. */
export const ENTERPRISE_SETUP_POLL_MS = 200;
export const ENTERPRISE_SETUP_MAX_WAIT_MS = 15_000;

/**
 * The container ref, shaped as the resolver's entry contract.
 *
 * The root container has no `getParent`, so every ancestor branch of
 * `openJoinFlowScreen` misses by construction and it takes its SIBLING branch —
 * `Main -> MessengerTab -> EnterpriseSetup` with `initial: false`, which is the
 * path the client shell (the only shell that can reach the paywall) needs.
 */
function refAsNavigation(): ResolvableNavigation {
  return {
    navigate: (...args: never[]) =>
      (navigationRef.navigate as unknown as (...a: unknown[]) => void)(...args),
    getParent: () => undefined,
    getState: () =>
      navigationRef.isReady()
        ? (navigationRef.getState() as unknown as {routeNames?: string[]})
        : undefined,
  };
}

/**
 * Open the Enterprise fork as soon as a shell that registers it is mounted.
 *
 * Gives up (loudly — `console.warn` survives release builds) rather than
 * navigating blind, so a device log can tell "the fork opened" from "the shell
 * never came up" instead of both looking like silence.
 */
/**
 * D4 — a second call while the first is still polling would run two independent
 * timer chains, and both could fire `openJoinFlowScreen` once the tree mounts:
 * the user gets the setup screen pushed twice and has to dismiss it twice. The
 * paywall can complete more than once per session (decline, re-open, subscribe),
 * so this is reachable rather than theoretical.
 */
let entSetupPolling = false;

export function openEnterpriseSetupWhenMounted(): void {
  if (entSetupPolling) {
    console.warn('[ENTSETUP] already waiting for the product tree — ignoring duplicate request');
    return;
  }
  entSetupPolling = true;
  const startedAt = Date.now();
  const attempt = (): void => {
    if (mountedTreeHasRoute('EnterpriseSetup')) {
      entSetupPolling = false;
      const result = openJoinFlowScreen(refAsNavigation(), 'EnterpriseSetup');
      console.warn(`[ENTSETUP] enterprise fork opened ok=${result.ok} via=${result.via}`);
      return;
    }
    if (Date.now() - startedAt >= ENTERPRISE_SETUP_MAX_WAIT_MS) {
      entSetupPolling = false;
      console.warn('[ENTSETUP] no shell registered EnterpriseSetup — enterprise fork NOT shown');
      return;
    }
    setTimeout(attempt, ENTERPRISE_SETUP_POLL_MS);
  };
  attempt();
}
