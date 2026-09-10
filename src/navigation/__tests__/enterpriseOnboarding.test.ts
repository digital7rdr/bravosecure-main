/**
 * F1 — the Enterprise create-or-join fork (PDF A4/M4) had no runtime door.
 *
 * RED BEFORE THE FIX. `EnterpriseSetup` is registered in two navigators, but the
 * ONLY `navigate('EnterpriseSetup')` in `src/` lives inside
 * `DepartmentChannelsScreen` — a screen a brand-new Enterprise customer never
 * opens. Post-registration the app goes pendingTier -> TierPaywall ->
 * setActiveProduct('messenger') -> the Messenger chat list, so the fork was
 * never asked of the one person it exists for.
 *
 * Three things have to hold, and each is pinned separately because each can
 * regress on its own:
 *   1. the DECISION — enterprise AND subscribed, not "picked enterprise then
 *      chose Start as Lite today";
 *   2. the DELIVERY — the navigate waits for a shell that actually registers the
 *      route (the paywall unmounts and the product tree mounts in the same tick,
 *      plus MainNavigator's B-95 navigator-free hold frame, so an immediate
 *      navigate is dropped silently);
 *   3. the WIRING — MainNavigator's paywall resolution really calls both. 1 and 2
 *      are pure and would stay green forever with nothing calling them, which is
 *      exactly the state this bug was in.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const mockHasRoute = jest.fn<boolean, [string]>();
const mockOpenJoinFlowScreen = jest.fn(
  (_nav: unknown, _route: string) => ({ok: true, via: 'sibling' as const}),
);

jest.mock('../navigationRef', () => ({
  navigationRef: {
    isReady:  () => true,
    navigate: jest.fn(),
    getState: () => ({routeNames: ['Auth', 'Main']}),
  },
  mountedTreeHasRoute: (route: string) => mockHasRoute(route),
}));

jest.mock('../departmentalEntry', () => ({
  openJoinFlowScreen: (nav: unknown, route: string) => mockOpenJoinFlowScreen(nav, route),
}));

import {
  ENTERPRISE_SETUP_MAX_WAIT_MS,
  ENTERPRISE_SETUP_POLL_MS,
  openEnterpriseSetupWhenMounted,
  shouldAskEnterpriseSetup,
} from '../enterpriseOnboarding';

describe('shouldAskEnterpriseSetup — who is owed the A4/M4 fork', () => {
  it('asks a customer who just SUBSCRIBED on the enterprise tier', () => {
    expect(shouldAskEnterpriseSetup('enterprise', true)).toBe(true);
  });

  it('does NOT ask someone who picked enterprise then took "Start as Lite today"', () => {
    // TierPaywall calls the same onDone with subscribed=false. A Lite account
    // must not be dropped into "name your company workspace".
    expect(shouldAskEnterpriseSetup('enterprise', false)).toBe(false);
  });

  it('does NOT ask a PRO subscriber — the fork is enterprise-only', () => {
    expect(shouldAskEnterpriseSetup('pro', true)).toBe(false);
  });

  it('does not ask when no paid tier was pending', () => {
    expect(shouldAskEnterpriseSetup(null, true)).toBe(false);
    expect(shouldAskEnterpriseSetup(undefined, true)).toBe(false);
  });
});

describe('openEnterpriseSetupWhenMounted — delivery across the shell swap', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHasRoute.mockReset();
    mockOpenJoinFlowScreen.mockClear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    jest.useRealTimers();
    (console.warn as jest.Mock).mockRestore();
  });

  it('navigates immediately when a shell already registers EnterpriseSetup', () => {
    mockHasRoute.mockReturnValue(true);

    openEnterpriseSetupWhenMounted();

    expect(mockOpenJoinFlowScreen).toHaveBeenCalledTimes(1);
    // The ROUTE is the contract — resolving it through the shared resolver is
    // what keeps the three-shell path table in one place.
    expect(mockOpenJoinFlowScreen.mock.calls[0][1]).toBe('EnterpriseSetup');
  });

  it('WAITS for the product tree instead of dropping the navigate', () => {
    // The state at call time: the paywall has just unmounted, MainNavigator is
    // holding its navigator-free frame, nothing registers the route yet.
    mockHasRoute.mockReturnValue(false);

    openEnterpriseSetupWhenMounted();
    expect(mockOpenJoinFlowScreen).not.toHaveBeenCalled();

    jest.advanceTimersByTime(ENTERPRISE_SETUP_POLL_MS * 3);
    expect(mockOpenJoinFlowScreen).not.toHaveBeenCalled();

    // …MessengerNavigator mounts.
    mockHasRoute.mockReturnValue(true);
    jest.advanceTimersByTime(ENTERPRISE_SETUP_POLL_MS);
    expect(mockOpenJoinFlowScreen).toHaveBeenCalledTimes(1);
  });

  it('gives up out loud rather than navigating blind, and only once', () => {
    mockHasRoute.mockReturnValue(false);

    openEnterpriseSetupWhenMounted();
    jest.advanceTimersByTime(ENTERPRISE_SETUP_MAX_WAIT_MS + ENTERPRISE_SETUP_POLL_MS * 2);

    expect(mockOpenJoinFlowScreen).not.toHaveBeenCalled();
    // console.warn survives release builds (babel strips log, keeps warn), so
    // this is the marker a device log can be searched for.
    expect((console.warn as jest.Mock).mock.calls.flat().join(' ')).toMatch(/ENTSETUP/);

    // And the poll really stopped — no zombie timer re-firing after the ceiling.
    mockHasRoute.mockReturnValue(true);
    jest.advanceTimersByTime(ENTERPRISE_SETUP_POLL_MS * 10);
    expect(mockOpenJoinFlowScreen).not.toHaveBeenCalled();
  });
});

/**
 * THE WIRING. Both functions above are pure and were absent entirely before this
 * fix; a suite that only exercised them would go green while the fork stayed
 * unreachable — which is the bug. So assert the DECISION SITE: the body of
 * MainNavigator's `resolvePaywall` (the one place `pendingTier` stops being
 * pending) must consult the rule and open the fork, and TierPaywall must hand it
 * the subscribed/declined answer.
 *
 * MainNavigator.tsx is CRLF and heavily commented — comments are stripped first
 * (prose naming a symbol is the classic false pass here), and the assertions are
 * scoped to the balanced body of the callback, never to the file.
 */
describe('MainNavigator wires the fork into the paywall resolution', () => {
  const src = readFileSync(join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx'), 'utf8');

  /** Strip block + line comments. `[^\n]` also eats the trailing \r (CRLF-safe). */
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  function balancedBodyAfter(from: number): string {
    const open = code.indexOf('{', from);
    let depth = 0;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') {depth++;}
      else if (code[i] === '}') { depth--; if (depth === 0) {return code.slice(open, i + 1);} }
    }
    throw new Error('unbalanced resolvePaywall body');
  }

  const declIdx = code.indexOf('const resolvePaywall');
  const body = balancedBodyAfter(declIdx);

  it('resolvePaywall exists and takes the paywall outcome', () => {
    expect(declIdx).toBeGreaterThan(-1);
    // Without the argument the decline path is indistinguishable from a
    // subscribe, and every Lite decliner gets the enterprise fork.
    expect(code.slice(declIdx, declIdx + 200)).toMatch(/React\.useCallback\(\s*\(\s*subscribed\s*:/);
  });

  it('the resolution consults the rule and opens the fork', () => {
    expect(body).toMatch(/shouldAskEnterpriseSetup\(/);
    expect(body).toMatch(/openEnterpriseSetupWhenMounted\(\)/);
  });

  it('the fork is gated, not fired for every resolved paywall', () => {
    expect(body).toMatch(/if\s*\(\s*shouldAskEnterpriseSetup\([^)]*\)\s*\)\s*\{[\s\S]*?openEnterpriseSetupWhenMounted\(\)/);
  });

  it('both symbols are really imported from the module that owns them', () => {
    expect(code).toMatch(
      /import\s*\{[^}]*shouldAskEnterpriseSetup[^}]*openEnterpriseSetupWhenMounted[^}]*\}\s*from\s*'\.\/enterpriseOnboarding'/,
    );
  });

  it("TierPaywall's onDone is the resolution — the fork's only trigger", () => {
    expect(code).toMatch(/<TierPaywall[^>]*onDone=\{resolvePaywall\}/);
  });
});

/**
 * D4 (critic finding) — a duplicate request must not open the fork twice.
 *
 * `openEnterpriseSetupWhenMounted` polls for up to 15s. Two calls while the
 * first is still waiting used to start two independent timer chains, and BOTH
 * would fire once the product tree mounted — the user gets the setup screen
 * pushed twice and has to dismiss it twice.
 *
 * Reachable, not theoretical: the paywall can resolve more than once in a
 * session (decline, re-open, subscribe), and each resolution calls this.
 */
describe('the enterprise fork opens once per wait', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockHasRoute.mockReset();
    mockOpenJoinFlowScreen.mockClear();
  });
  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('a second request while still polling is ignored', () => {
    mockHasRoute.mockReturnValue(false);          // tree not mounted yet
    openEnterpriseSetupWhenMounted();
    openEnterpriseSetupWhenMounted();             // the duplicate
    mockHasRoute.mockReturnValue(true);           // now it mounts
    jest.advanceTimersByTime(1000);
    expect(mockOpenJoinFlowScreen).toHaveBeenCalledTimes(1);
  });

  it('a LATER request still works once the first has finished', () => {
    mockHasRoute.mockReturnValue(true);
    openEnterpriseSetupWhenMounted();
    expect(mockOpenJoinFlowScreen).toHaveBeenCalledTimes(1);
    // The guard must CLEAR on success, or the fork can never be opened again
    // for the rest of the process — a worse bug than the one it fixes.
    openEnterpriseSetupWhenMounted();
    expect(mockOpenJoinFlowScreen).toHaveBeenCalledTimes(2);
  });

  it('the guard also clears when the wait GIVES UP', () => {
    mockHasRoute.mockReturnValue(false);
    openEnterpriseSetupWhenMounted();
    jest.advanceTimersByTime(20_000);             // past the 15s ceiling
    expect(mockOpenJoinFlowScreen).not.toHaveBeenCalled();
    mockHasRoute.mockReturnValue(true);
    openEnterpriseSetupWhenMounted();
    jest.advanceTimersByTime(1000);
    expect(mockOpenJoinFlowScreen).toHaveBeenCalledTimes(1);
  });
});
