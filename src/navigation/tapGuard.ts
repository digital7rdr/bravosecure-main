/**
 * B-261 — "I press back once and nothing happens, so I press again and it goes
 * back TWO pages."
 *
 * Both halves of that sentence are the same defect seen from two ends.
 *
 * WHY THE SECOND TAP POPS TWICE. `navigation.goBack()` dispatches
 * `{type: 'GO_BACK', source: <this route's key>}`. The StackRouter pops the
 * route that follows `source`. Tap it twice from screen B and the second
 * action still carries `source: B` — but B is no longer in the navigator's
 * state, so the router returns null and React Navigation BUBBLES the action to
 * the parent navigator, which pops there instead. One extra tap therefore does
 * not "pop B again" (harmless); it pops a screen the user never asked to
 * leave. Same mechanism for a tab shell: the second back exits the tab.
 *
 * WHY THE FIRST TAP LOOKS DEAD. The pop IS registered — it is the JS thread
 * that is busy, so the transition starts late. The user reads that as a missed
 * tap and taps again inside the window where the outgoing screen is still
 * mounted and still taking touches. Fixing the guard does not make the app
 * faster; it makes the extra tap HARMLESS, which is what turns a lost screen
 * back into a slightly slow one.
 *
 * TWO CHECKS, AND THEY COVER EACH OTHER'S GAP. Neither is sufficient alone:
 *
 *   - `isFocused()` reads the navigation state, which React updates
 *     ASYNCHRONOUSLY. Under React 18 automatic batching — and especially while
 *     the JS thread is lagging, which is precisely when this bug fires — the
 *     first tap's state change may not have flushed before the second tap's
 *     handler runs, so `isFocused()` can still say true.
 *   - The per-navigation timestamp closes exactly that window. It is keyed on
 *     the `navigation` OBJECT rather than a module-global clock, so a back tap
 *     on a DIFFERENT screen is never swallowed — the user can pop C, land on B
 *     and immediately pop B again. A global timestamp would have eaten that.
 *
 * When the state HAS flushed, `useNavigationCache` hands the screen a fresh
 * `navigation` object, so the WeakMap lookup misses — and that is the case
 * `isFocused()` catches, because the route is gone from state by then.
 *
 * SCOPE. Wire this into `onPress` handlers only. Programmatic backs (a call
 * ending, a save completing) must NOT be guarded: they legitimately fire from
 * a screen that is no longer focused, and dropping one strands the screen on
 * the stack — see B-213's blind-goBack pattern in CallScreen.
 */

/** The subset of a React Navigation `navigation` object this guard needs. */
export interface BackCapableNavigation {
  goBack: () => void;
  isFocused?: () => boolean;
}

/**
 * How long a second back tap from the SAME screen is treated as an accidental
 * repeat. A native-stack pop animates for ~300–350 ms on Android; a user
 * cannot see the previous screen, find its back affordance and press it inside
 * this window, so there is no legitimate tap to lose.
 */
export const BACK_GUARD_MS = 500;

// Weak so a popped screen's navigation object is still collectable.
const lastBackAt = new WeakMap<BackCapableNavigation, number>();

/**
 * Pop once per gesture. Returns whether the back was dispatched — false means
 * it was recognised as a repeat, which is a no-op, not an error.
 *
 * `now` is injectable so the timing rule can be tested without fake timers.
 */
export function goBackOnce(
  nav: BackCapableNavigation | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!nav) {
    return false;
  }
  // The screen already left the navigation state; a second GO_BACK from it
  // would bubble to the parent and pop something else.
  if (nav.isFocused?.() === false) {
    return false;
  }
  const prev = lastBackAt.get(nav);
  if (prev !== undefined && now - prev < BACK_GUARD_MS) {
    return false;
  }
  lastBackAt.set(nav, now);
  nav.goBack();
  return true;
}

/** The subset of a navigation object the forward guard needs. */
export interface NavigateCapableNavigation {
  navigate: (name: never, params?: never) => void;
}

/**
 * NAV-10 (2026-08-26 rapid-use audit) — the forward-navigation twin of
 * `goBackOnce`. `navigate()` already dedups the DESTINATION (20 taps land on
 * one screen), but every tap still queues a full dispatch + StackRouter
 * reducer run on the JS thread, and the user's next back press waits behind
 * all of them — the founder's "button ×20 then back" repro. This drops the
 * repeats at the press site instead.
 *
 * Keyed per (navigation object, route name): a repeat of the SAME destination
 * inside the window is an accidental mash and is dropped; a different
 * destination is always a real tap and passes. Same 500 ms reasoning as
 * BACK_GUARD_MS — a push animates for ~300–350 ms, so there is no legitimate
 * same-destination tap to lose inside the window.
 *
 * SCOPE. onPress handlers only, like goBackOnce — programmatic navigation
 * (resume flows, deep links, redirects) must never be dropped.
 */
export const NAV_GUARD_MS = 500;

const lastNavAt = new WeakMap<object, Map<string, number>>();

export function navigateOnce<Name extends string>(
  nav: (NavigateCapableNavigation & object) | null | undefined,
  name: Name,
  params?: object,
  now: number = Date.now(),
): boolean {
  if (!nav) {
    return false;
  }
  // The key includes the PARAMS, not just the route name (critic finding):
  // two different buttons can share a destination — Dashboard's Secure and
  // VBG tiles both navigate 'SecureTab' with different nested screens — and a
  // name-only key silently dropped the second, distinct tap. Same call site →
  // same literal key order, so the stringify is stable; a non-serializable
  // params object falls back to the name alone (guarding too wide beats
  // crashing a tap).
  let key: string = name;
  if (params !== undefined) {
    try { key = name + '|' + JSON.stringify(params); } catch { /* name-only */ }
  }
  let byKey = lastNavAt.get(nav);
  if (!byKey) {
    byKey = new Map();
    lastNavAt.set(nav, byKey);
  }
  const prev = byKey.get(key);
  if (prev !== undefined && now - prev < NAV_GUARD_MS) {
    return false;
  }
  byKey.set(key, now);
  // Preserve the original call ARITY: navigate(name) and navigate(name,
  // undefined) behave identically at runtime, but mocks asserting
  // toHaveBeenCalledWith(name) see the difference.
  const doNavigate = nav.navigate as (name: string, params?: object) => void;
  if (params === undefined) { doNavigate(name); } else { doNavigate(name, params); }
  return true;
}
