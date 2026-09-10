/**
 * B-261 — "I press back once and nothing happens, so I press again and it goes
 * back TWO pages."
 *
 * `navigation.goBack()` dispatches `{type: 'GO_BACK', source: <route key>}`.
 * The StackRouter pops the route after `source`. A second tap from the SAME
 * screen still carries that screen's key, but the screen is no longer in the
 * navigator's state, so the router returns null and React Navigation bubbles
 * the action to the PARENT navigator — which pops there. The extra tap does
 * not re-pop harmlessly; it removes a screen the user never asked to leave.
 *
 * The first tap was never lost — the JS thread was busy, so the transition
 * started late. This guard cannot make the app faster. It makes the extra tap
 * a no-op, which is what turns a lost screen back into a slow one.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  goBackOnce, BACK_GUARD_MS,
  navigateOnce, NAV_GUARD_MS,
  type BackCapableNavigation, type NavigateCapableNavigation,
} from '../tapGuard';

function fakeNav(focused = true) {
  const calls: number[] = [];
  const nav: BackCapableNavigation & {calls: number[]; focused: boolean} = {
    calls,
    focused,
    isFocused: () => nav.focused,
    goBack: () => { calls.push(calls.length); },
  };
  return nav;
}

describe('the repeat tap is swallowed, not forwarded to the parent navigator', () => {
  it('THE BUG: two taps in the same instant pop ONCE, not twice', () => {
    const nav = fakeNav();
    expect(goBackOnce(nav, 1_000)).toBe(true);
    expect(goBackOnce(nav, 1_000)).toBe(false);
    expect(nav.calls).toHaveLength(1);
  });

  it('a frantic burst still pops exactly once', () => {
    const nav = fakeNav();
    for (const t of [0, 40, 90, 150, 260, 400]) {
      goBackOnce(nav, t);
    }
    expect(nav.calls).toHaveLength(1);
  });

  it('the SAME screen may be popped again once the window has passed', () => {
    // Belt-and-braces only: in practice the screen is gone by then. But a
    // permanently disarmed back button would be a far worse bug than a double
    // pop, so the guard must expire.
    const nav = fakeNav();
    expect(goBackOnce(nav, 0)).toBe(true);
    expect(goBackOnce(nav, BACK_GUARD_MS)).toBe(true);
    expect(nav.calls).toHaveLength(2);
  });
});

describe('a legitimate back is NEVER swallowed', () => {
  it('popping screen C then immediately popping screen B both work', () => {
    // The reason the timestamp is keyed on the navigation OBJECT and not on a
    // module-global clock. A global one would eat this second tap, and the
    // user would have to press back twice for real — inventing the very
    // symptom we are fixing.
    const screenC = fakeNav();
    const screenB = fakeNav();
    expect(goBackOnce(screenC, 1_000)).toBe(true);
    expect(goBackOnce(screenB, 1_010)).toBe(true);
    expect(screenC.calls).toHaveLength(1);
    expect(screenB.calls).toHaveLength(1);
  });

  it('a navigation object without isFocused (older/nested helpers) still works', () => {
    const calls: string[] = [];
    const bare: BackCapableNavigation = {goBack: () => calls.push('back')};
    expect(goBackOnce(bare, 0)).toBe(true);
    expect(calls).toEqual(['back']);
  });

  it('a null navigation is a no-op, not a crash', () => {
    expect(goBackOnce(null, 0)).toBe(false);
    expect(goBackOnce(undefined, 0)).toBe(false);
  });
});

describe('the blurred-screen check — the half that works once state HAS flushed', () => {
  it('a screen already removed from the navigation state cannot pop', () => {
    // When React has flushed the first pop, useNavigationCache hands the
    // screen a FRESH navigation object, so the timestamp lookup misses. This
    // is the check that catches that case.
    const nav = fakeNav(false);
    expect(goBackOnce(nav, 0)).toBe(false);
    expect(nav.calls).toHaveLength(0);
  });

  it('the two checks are independent — neither alone covers both cases', () => {
    // Focused but repeated -> caught by the timestamp.
    const laggy = fakeNav(true);
    goBackOnce(laggy, 0);
    expect(goBackOnce(laggy, 10)).toBe(false);

    // Blurred but a fresh object -> caught by isFocused, timestamp is empty.
    const flushed = fakeNav(false);
    expect(goBackOnce(flushed, 10)).toBe(false);
  });
});

describe('NAV-10 — navigateOnce, the forward twin (2026-08-26 rapid-use audit)', () => {
  // navigate() dedups the DESTINATION, but 20 queued taps still ran 20 full
  // dispatch + reducer passes, and the user's next back press waited behind
  // them — the founder's "button ×20 then back" repro.
  function fwdNav() {
    const calls: Array<[string, object | undefined]> = [];
    const nav = {
      calls,
      navigate: ((name: string, params?: object) => { calls.push([name, params]); }) as never,
    };
    return nav as NavigateCapableNavigation & {calls: Array<[string, object | undefined]>};
  }

  it('THE BUG: a same-destination burst dispatches ONCE', () => {
    const nav = fwdNav();
    for (const t of [0, 30, 80, 140, 220, 350, 480]) {
      navigateOnce(nav, 'BookingHome', undefined, t);
    }
    expect(nav.calls).toHaveLength(1);
  });

  it('a DIFFERENT destination inside the window is a real tap and passes', () => {
    const nav = fwdNav();
    expect(navigateOnce(nav, 'A', undefined, 0)).toBe(true);
    expect(navigateOnce(nav, 'B', undefined, 50)).toBe(true);
    expect(nav.calls.map(c => c[0])).toEqual(['A', 'B']);
  });

  it('the guard expires — a later deliberate tap on the same destination works', () => {
    const nav = fwdNav();
    expect(navigateOnce(nav, 'A', undefined, 0)).toBe(true);
    expect(navigateOnce(nav, 'A', undefined, NAV_GUARD_MS)).toBe(true);
    expect(nav.calls).toHaveLength(2);
  });

  it('keyed per navigation OBJECT — another screen is never swallowed', () => {
    const a = fwdNav();
    const b = fwdNav();
    expect(navigateOnce(a, 'X', undefined, 0)).toBe(true);
    expect(navigateOnce(b, 'X', undefined, 10)).toBe(true);
  });

  it('same route name with DIFFERENT params is a distinct destination and passes', () => {
    // Dashboard's Secure and VBG tiles both target 'SecureTab' with different
    // nested screens; a name-only key dropped the second, distinct tap
    // (critic finding — the guard must never eat a real cross-button tap).
    const nav = fwdNav();
    expect(navigateOnce(nav, 'SecureTab', {screen: 'BookingHome'}, 0)).toBe(true);
    expect(navigateOnce(nav, 'SecureTab', {screen: 'VBGHome'}, 50)).toBe(true);
    expect(navigateOnce(nav, 'SecureTab', {screen: 'VBGHome'}, 90)).toBe(false);
    expect(nav.calls).toHaveLength(2);
  });

  it('params pass through verbatim; null nav is a no-op, not a crash', () => {
    const nav = fwdNav();
    navigateOnce(nav, 'Chat', {conversationId: 'c1'}, 0);
    expect(nav.calls[0]).toEqual(['Chat', {conversationId: 'c1'}]);
    expect(navigateOnce(null, 'Chat', undefined, 0)).toBe(false);
    expect(navigateOnce(undefined, 'Chat', undefined, 0)).toBe(false);
  });
});

describe('every tappable back in the app routes through the guard', () => {
  const SRC = path.resolve(__dirname, '..', '..');

  function tsxFiles(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') {tsxFiles(p, out);}
      } else if (e.name.endsWith('.tsx')) {
        out.push(p);
      }
    }
    return out;
  }

  it('no screen wires a raw goBack() straight into onPress', () => {
    // The whole point of the fix. A new screen that hand-rolls the old form
    // re-introduces the double pop on exactly one route, which is invisible
    // until a user loses their place — so pin it repo-wide.
    const offenders = tsxFiles(SRC)
      .filter(f => fs.readFileSync(f, 'utf8').includes('onPress={() => navigation.goBack()}'))
      .map(f => path.relative(SRC, f));
    expect(offenders).toEqual([]);
  });

  it('CONTROL: the guarded form is actually present and widely wired', () => {
    // Without this, deleting every back button in the app would make the scan
    // above pass. Anchors the assertion to a real, populated surface.
    const wired = tsxFiles(SRC)
      .filter(f => fs.readFileSync(f, 'utf8').includes('goBackOnce(navigation)'));
    expect(wired.length).toBeGreaterThan(80);
  });

  it('programmatic backs are NOT guarded — dropping one strands the screen', () => {
    // Scope rule, stated as a test so a future sweep does not "finish the job"
    // by wrapping every goBack(). A call ending or a save completing fires
    // from a screen that is legitimately blurred; the guard would eat it.
    const callScreen = fs.readFileSync(
      path.join(SRC, 'screens', 'messenger', 'CallScreen.tsx'), 'utf8');
    expect(callScreen).toMatch(/navigation\.goBack\(\)/);
  });
});
