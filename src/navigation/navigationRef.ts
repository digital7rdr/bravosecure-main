import {createNavigationContainerRef} from '@react-navigation/native';
import type {RootStackParamList} from './types';

/**
 * Navigation ref exposed to non-screen modules that need to navigate
 * (e.g. the global incoming-call handler in MainNavigator). Lives in
 * its own file so it doesn't import from `./index` — that would close
 * a cycle (index → MainNavigator → index) and trigger Metro's
 * "Require cycle" warning + can leave the ref undefined at first read.
 */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();

interface NavStateLike {
  routeNames?: string[];
  routes?: Array<{name?: string; state?: NavStateLike}>;
}

/**
 * Does the MOUNTED navigator tree register `route` anywhere — including in a
 * SIBLING branch?
 *
 * `findNavigatorWithRoute` (departmentalEntry) walks the caller's ancestors,
 * which is right for "where am I allowed to go from here" but structurally
 * blind to siblings. The client shell is a TAB navigator, so
 * MessengerTab's routes are a sibling of SecureTab's and of BookingNavigator's
 * — and both R6-4 (Pricing) and R7-1 (the applicant's own approval screens)
 * were dead taps for exactly that reason. Two call sites needed the same
 * search, so it lives here rather than becoming a second drifted copy.
 *
 * Relies on `routeNames` being REGISTRATION-complete (React Navigation lists
 * every registered screen whether or not it has rendered), so a lazy tab that
 * has never been opened is still found. What must be mounted is the navigator
 * that registers the route, not the screen itself — and a child navigator's
 * state is written into its parent's `routes[i].state` during the child's first
 * render, so any tree containing a live caller is already populated.
 */
export function mountedTreeHasRoute(route: string): boolean {
  if (!navigationRef.isReady()) {return false;}
  const walk = (state: NavStateLike | undefined, depth: number): boolean => {
    if (!state || depth > 10) {return false;}
    if (state.routeNames?.includes(route) === true) {return true;}
    return (state.routes ?? []).some(r => walk(r.state, depth + 1));
  };
  return walk(navigationRef.getRootState() as NavStateLike | undefined, 0);
}

/**
 * Is `route` sitting in the mounted tree with OTHER routes stacked ON TOP of it?
 *
 * The question a "take me to this section's root" control has to ask BEFORE it
 * moves. React Navigation's NAVIGATE does not push when a route of that name
 * already exists — StackRouter returns `routes.slice(0, index + 1)`, dropping
 * everything above it. So landing on a root that is already in the stack is a
 * POP, and it destroys whatever the user has open above it. That is only safe
 * to do silently when there is nothing there: when the route is absent the same
 * navigate is an ordinary push, and when it is already the top it is a no-op.
 *
 * Concretely, `SecureProApplyScreen` keeps all fifteen application fields in
 * local `useState` with no store behind them and no `beforeRemove` guard, so a
 * pop past it is unrecoverable.
 *
 * Returns false when the ref is not ready — an unmounted tree has nothing to
 * destroy, and a guard that blocks on "I don't know" would block the first tap
 * after boot.
 */
export function mountedStackHasRoutesAbove(route: string): boolean {
  if (!navigationRef.isReady()) {return false;}
  const walk = (state: NavStateLike | undefined, depth: number): boolean => {
    if (!state || depth > 10) {return false;}
    const routes = state.routes ?? [];
    const at = routes.findIndex(r => r.name === route);
    if (at >= 0 && at < routes.length - 1) {return true;}
    // Keep descending regardless: the same name can appear in a sibling branch
    // (the client shell is a TAB navigator), and only the branch that actually
    // has something above it should answer true.
    return routes.some(r => walk(r.state, depth + 1));
  };
  return walk(navigationRef.getRootState() as NavStateLike | undefined, 0);
}
