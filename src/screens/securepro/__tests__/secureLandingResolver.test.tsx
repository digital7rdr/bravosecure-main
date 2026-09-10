/**
 * PDF-1 #1 — the Secure tier resolver (`SecureLandingScreen`) + its shared
 * `secureRootRoute` decision.
 *
 * The seeded landing for the Secure product reads the client's tier from
 * `useSecureProStore.application` (`status === 'ACTIVE'` ⇒ PRO retainer, own
 * plan OR a linked family member — the SAME source as BookingHome's PRO/LITE
 * badge and SecureServices' Pro card) and RESETS the stack to the tier's
 * canonical home:
 *
 *   - ACTIVE                 → [BookingHome, ProDashboard]  (the Pro dashboard)
 *   - loaded, not ACTIVE     → [SecureShell]                (the Lite 4-tab shell,
 *                              Wave 5d; its Home tab is the Book-Now home)
 *   - not loaded yet         → WAIT (no reset) — no flash of the wrong home
 *   - load failed (hasLoaded flips in the store's catch, app stays null)
 *                            → the SAFE default, Lite home — never a Pro dashboard
 *
 * A reset (not pop/replace) is what makes the same-product drawer tap land
 * deterministically on the canonical home from ANY depth. NOT the messenger
 * `isProActive`/`subscription_tier` (SP-01). The resolver only reads
 * `application`.
 */
import React from 'react';
import {render, act} from '@testing-library/react-native';
import {useSecureProStore} from '@store/secureProStore';
import SecureLandingScreen from '@screens/securepro/SecureLandingScreen';
import {secureRootRoute} from '@screens/securepro/secureRoot';

const mockReset = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({reset: (...a: unknown[]) => mockReset(...a)}),
}));

const mockLoad = jest.fn(async () => {});

type AppLike = {id: string; status: string} | null;
function seed(app: AppLike, hasLoaded: boolean) {
  useSecureProStore.setState({
    application: app as never,
    hasLoaded,
    loadApplication: mockLoad as never,
  });
}

// Wave 5d — the LITE client now roots at the 4-tab shell, not the bare home.
// B-661 (founder, 2026-08-25: "it should be for lite and pro version both"):
// EVERY tier lands on the SAME 4-tab shell. The tier no longer picks a ROUTE,
// it picks what the shell Home TAB renders - so the footer, which a Pro client
// never had, is now unconditional. That was the whole bug the founder reported:
// two people on the same build saw different navigation because one was Pro.
const SHELL_STACK = {index: 0, routes: [{name: 'SecureShell'}]};
// The stack that must no longer be produced for ANYONE. Kept (not deleted) so
// the negative assertions below still name the thing that regressed.
const PRO_ROUTE_STACK = {index: 1, routes: [{name: 'BookingHome'}, {name: 'ProDashboard'}]};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('secureRootRoute — the single tier decision', () => {
  it('ACTIVE (own plan or family member) roots at the shell TOO', () => {
    // Not a route difference any more: ProDashboard is what the shell Home tab
    // renders for an ACTIVE plan (SecureTabNavigator.SecureHomeTab).
    expect(secureRootRoute({status: 'ACTIVE'} as never)).toBe('SecureShell');
  });

  it('every non-ACTIVE state, and no application, roots at the LITE shell (SecureShell)', () => {
    expect(secureRootRoute(null)).toBe('SecureShell');
    expect(secureRootRoute(undefined)).toBe('SecureShell');
    for (const status of ['PENDING_PROPOSAL', 'ACCEPTED', 'EXPIRED', 'REJECTED', 'CANCELLED']) {
      expect(secureRootRoute({status} as never)).toBe('SecureShell');
    }
  });
});

describe('SecureLandingScreen — tier resolution', () => {
  it('kicks the lazy application load on mount (store does not fetch at boot)', () => {
    seed(null, false);
    render(<SecureLandingScreen />);
    expect(mockLoad).toHaveBeenCalledTimes(1);
  });

  it('a PRO client lands on the SAME shell as a LITE one - that IS the fix', () => {
    seed({id: 'a1', status: 'ACTIVE'}, true);
    render(<SecureLandingScreen />);
    expect(mockReset).toHaveBeenCalledWith(SHELL_STACK);
    // The old two-route Pro stack is what dropped the footer. Never again.
    expect(mockReset).not.toHaveBeenCalledWith(PRO_ROUTE_STACK);
  });

  it('a LITE client (no application) lands on the SecureShell 4-tab canonical stack', () => {
    seed(null, true);
    render(<SecureLandingScreen />);
    expect(mockReset).toHaveBeenCalledWith(SHELL_STACK);
  });

  it('a non-ACTIVE application (e.g. PENDING_PROPOSAL) is treated as LITE', () => {
    seed({id: 'a1', status: 'PENDING_PROPOSAL'}, true);
    render(<SecureLandingScreen />);
    expect(mockReset).toHaveBeenCalledWith(SHELL_STACK);
  });

  it('WAITS while the gate is not loaded — no flash of the wrong home', () => {
    seed(null, false);
    render(<SecureLandingScreen />);
    expect(mockReset).not.toHaveBeenCalled();
  });

  it('a not-yet-loaded gate resolves to the SAFE default (Lite) once it loads', () => {
    seed(null, false);
    render(<SecureLandingScreen />);
    expect(mockReset).not.toHaveBeenCalled();

    // The load returns with NO active plan (or failed — the store flips
    // hasLoaded in its catch either way, application stays null). Safe default.
    act(() => { useSecureProStore.setState({hasLoaded: true}); });

    expect(mockReset).toHaveBeenCalledWith(SHELL_STACK);
    expect(mockReset).not.toHaveBeenCalledWith(PRO_ROUTE_STACK);
  });

  it('the TARGET is decided exactly once — a later store change cannot re-aim it', () => {
    jest.useFakeTimers();
    try {
      seed({id: 'a1', status: 'ACTIVE'}, true);
      render(<SecureLandingScreen />);
      expect(mockReset).toHaveBeenCalledWith(SHELL_STACK);

      // A subsequent refresh (e.g. the plan expiring) must not swing a screen
      // that already picked its landing over to the OTHER home. B-649 allows
      // the dispatch to REPEAT (see below) — but only ever with the routes the
      // first decision produced.
      act(() => { useSecureProStore.setState({application: null as never}); });
      act(() => { jest.advanceTimersByTime(2_000); });

      expect(mockReset).toHaveBeenCalled();
      for (const call of mockReset.mock.calls) {
        expect(call[0]).toEqual(SHELL_STACK);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('B-649 — a swallowed reset retries while the resolver is still mounted', () => {
    // The product-switch round trip (VBG → Secure → VBG → Secure) can wipe the
    // freshly-reset stack via the keyed remount's deferred nested-state
    // cleanup (B-95) landing late on a stalled JS thread — the resolver stays
    // mounted with its reset gone and the user is pinned to the spinner
    // forever. Still-mounted IS the proof the dispatch went nowhere (a real
    // reset unmounts this screen), so the resolver must fire again.
    jest.useFakeTimers();
    try {
      seed({id: 'a1', status: 'ACTIVE'}, true);
      render(<SecureLandingScreen />);
      expect(mockReset).toHaveBeenCalledTimes(1);

      // The mock never unmounts the screen — exactly the swallowed case.
      act(() => { jest.advanceTimersByTime(1_100); });
      expect(mockReset.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const call of mockReset.mock.calls) {
        expect(call[0]).toEqual(SHELL_STACK);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  it('B-649 — the retry is registered inside the effect and cleared by its cleanup', () => {
    // Source scan, not a render: RTL auto-cleanup wedges when a test both
    // manually unmounts and runs fake timers in this harness. React guarantees
    // the effect cleanup fires on unmount; what needs pinning is that the
    // interval LIVES in that effect and its cleanup clears it — a retry hoisted
    // outside the effect (or an uncleared interval) is the ghost-dispatch bug.
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const {join} = require('node:path') as typeof import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src', 'screens', 'securepro', 'SecureLandingScreen.tsx'),
      'utf8',
    ).replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(src).toMatch(/const timer = setInterval\(dispatch, RETRY_MS\);\s*return \(\) => clearInterval\(timer\);/);
  });
});
