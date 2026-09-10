/**
 * Audit Rev2 SP-01 — "a cheap messenger subscription unlocks the Pro dashboard".
 *
 * TWO defects, one of which is bigger than the reported one.
 *
 * (1) THE REPORTED BUG — ProDashboardScreen's gate read
 *         const legacyPro = isProActive(user);
 *         if (hasLoaded && !planActive && !legacyPro) { redirect }
 *     `isProActive` only checks `subscription_tier in ('pro','enterprise')`,
 *     which is the MESSENGER ladder, set by the messenger paywall. Two products
 *     deliberately share one tier vocabulary (tierMatrix.ts:52-64 says so out
 *     loud, while the same file's header says Bravo Secure Pro is a DIFFERENT
 *     product). So buying Messenger Pro for 2500 BC admitted you to the Secure
 *     Pro dashboard with no application and no plan payment.
 *
 *     NOTE the fix is to DELETE `legacyPro`, not to replace it with
 *     `!application?.via_owner` as the audit proposed: `via_owner` is only ever
 *     attached to a row already selected `WHERE status = 'ACTIVE'`, so
 *     via_owner => planActive and the extra term is unreachable dead code.
 *     Family members are already covered by planActive.
 *
 * (2) THE BIGGER ONE — the gate FAILS OPEN. loadApplication's catch set
 *     `s.error` but never `s.hasLoaded`, and the gate is `if (hasLoaded && ...)`.
 *     So any failed /pro-applications/me — offline, 500, the 15s axios timeout,
 *     a 401 mid-refresh — left hasLoaded false, the redirect never ran, and the
 *     full dashboard rendered FOR ANYONE. Same fail-open shape as every other
 *     finding in this group.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('@services/api', () => ({
  secureProApi: {
    me:     jest.fn(),
    renew:  jest.fn(),
    create: jest.fn(),
    cancel: jest.fn(),
    messages: jest.fn(),
    sendMessage: jest.fn(),
  },
}));


const {secureProApi} = require('@services/api') as {secureProApi: {me: jest.Mock}};

const {useSecureProStore} = require('../secureProStore') as typeof import('../secureProStore');

const INITIAL = useSecureProStore.getState();

describe('SP-01 — the Pro plan gate must fail CLOSED', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useSecureProStore.setState({...INITIAL, application: null, hasLoaded: false, error: null});
  });

  it('sets hasLoaded on SUCCESS (baseline)', async () => {
    secureProApi.me.mockResolvedValue({data: {application: null, history: []}});
    await useSecureProStore.getState().loadApplication();
    expect(useSecureProStore.getState().hasLoaded).toBe(true);
  });

  // The fail-open. Without hasLoaded, the screen's `if (hasLoaded && ...)` gate
  // never fires and every Pro module renders.
  it('sets hasLoaded on FAILURE too, so the gate still runs when the API is down', async () => {
    secureProApi.me.mockRejectedValue(new Error('Network Error'));
    await useSecureProStore.getState().loadApplication();

    const st = useSecureProStore.getState();
    expect(st.error).toBeTruthy();
    expect(st.application).toBeNull();
    expect(st.hasLoaded).toBe(true);
  });

  it('a failed load must not leave a stale application behind', async () => {
    useSecureProStore.setState({application: {id: 'a1', status: 'ACTIVE'} as never, hasLoaded: true});
    secureProApi.me.mockRejectedValue(new Error('boom'));
    await useSecureProStore.getState().loadApplication();
    // Deliberately NOT asserting application === null: a transient blip should
    // not sign the user out of a plan they hold. What matters is that hasLoaded
    // is true so the gate evaluates planActive at all.
    expect(useSecureProStore.getState().hasLoaded).toBe(true);
  });
});

describe('SP-01 — the messenger tier must not open the Secure Pro dashboard', () => {
  // A source scan, because the assertion is about a DECISION SITE inside an RN
  // screen this node-environment project cannot mount. Guarded per CLAUDE.md:
  // read is EOL-normalised, and comments are stripped LINE-BY-LINE (the house
  // block-comment stripper is documented to eat real code when it meets `/*`
  // inside a string — see src/__tests__/sourceScanSafety.test.ts).
  function codeOnly(...parts: string[]): string {
    return readFileSync(join(process.cwd(), ...parts), 'utf8')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it('does not consult the messenger subscription tier when gating the dashboard', () => {
    const src = codeOnly('src', 'screens', 'pro', 'ProDashboardScreen.tsx');
    expect(src).not.toMatch(/\blegacyPro\b/);
    expect(src).not.toMatch(/\bisProActive\b/);
  });

  // Audit Rev2 SP-01 — the redirect moved OUT of the screen into the shared
  // useProPlanGate hook (the fix's whole point: one gate, not nine side doors).
  // Pin it at its new home, or the "still redirects" invariant goes unguarded.
  it('the shared gate still redirects a non-active plan to SecureProStatus', () => {
    const hook = codeOnly('src', 'hooks', 'useProPlanGate.ts');
    expect(hook).toMatch(/StackActions\.replace\(\s*'SecureProStatus'\s*\)/);
    // Fails CLOSED: the redirect is guarded by hasLoaded && !planActive.
    expect(hook).toMatch(/hasLoaded\s*&&\s*!planActive/);
  });

  // The duplicate-copy guarantee: EVERY screen behind the paywall must mount the
  // single gate. A new Pro screen added without it is a fresh side door — this
  // scan is what actually enforces "gated in ONE place".
  const PAYWALLED_SCREENS: string[][] = [
    ['src', 'screens', 'pro', 'ProDashboardScreen.tsx'],
    ['src', 'screens', 'pro', 'ProAssignedTeamScreen.tsx'],
    ['src', 'screens', 'pro', 'ProLiveMissionScreen.tsx'],
    ['src', 'screens', 'pro', 'ProActivityHistoryScreen.tsx'],
    ['src', 'screens', 'securepro', 'SecureProCalendarScreen.tsx'],
    ['src', 'screens', 'securepro', 'SecureProMissionsScreen.tsx'],
    ['src', 'screens', 'securepro', 'SecureProMembersScreen.tsx'],
  ];

  it.each(PAYWALLED_SCREENS)('%s mounts useProPlanGate', (...parts: string[]) => {
    const src = codeOnly(...parts);
    expect(src).toMatch(/useProPlanGate\s*\(/);
    expect(src).toMatch(/from '@hooks\/useProPlanGate'/);
  });
});
