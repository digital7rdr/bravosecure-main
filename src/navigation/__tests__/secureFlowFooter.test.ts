/**
 * Client feedback 2026-08-22 ("Wrong Nav Bar") — the Secure LITE flow footer.
 *
 * PDF-2: "the bottom navigation highlights Booking throughout data entry" and
 * Summary on the summary screen. Wave 5d only put the Secure bar on the
 * `SecureShell` route; every pushed booking route fell back to the root
 * MESSENGER · PROFILE footer, which is what the client photographed under
 * "Confirm Booking".
 *
 * Two halves, like the other nav pins:
 *  - the DECISION is a pure function (`secureFlowTabFor`), tested directly —
 *    including the review-round-1 finding that a PRO stack (no shell beneath)
 *    must NOT get the bar, because its press would PUSH the LITE shell;
 *  - the WIRING into MainNavigator's CustomTabBar is a source scan (the root
 *    navigator cannot be imported by the node project). CRLF-normalised and
 *    comment-stripped, because both traps have cost this repo a session.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  secureFlowTabFor, SECURE_FLOW_TAB, SECURE_FLOW_ORDER, SECURE_FLOW_CONFIRM_LEAVE,
} from '../secureFlowTab';

function src(...parts: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8').replace(/\r\n/g, '\n');
}
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

const MAIN = code(src('navigation', 'MainNavigator.tsx'));
const BOOKING = code(src('navigation', 'BookingNavigator.tsx'));
const SHELL = code(src('navigation', 'SecureTabNavigator.tsx'));

const base = {activeProduct: 'secure', focusedRouteName: 'SecureTab', profileHosted: false, shellMounted: true};

describe('secureFlowTabFor — the decision', () => {
  it('lights BOOK on both consolidated dashboards and the service chooser', () => {
    expect(secureFlowTabFor({...base, nestedRouteName: 'CustomizeAddOns'})).toBe('Book');
    expect(secureFlowTabFor({...base, nestedRouteName: 'ExecReview'})).toBe('Book');
    expect(secureFlowTabFor({...base, nestedRouteName: 'ServiceType'})).toBe('Book');
    // The detour off the dashboard stays in the Book context.
    expect(secureFlowTabFor({...base, nestedRouteName: 'LocationPicker'})).toBe('Book');
  });

  it('lights SUMMARY on every post-confirm surface the resume resolver can target', () => {
    for (const r of ['OpsRoomReview', 'BookingConfirmation', 'LiveTracking', 'FindingDetail', 'NoDetail']) {
      expect(secureFlowTabFor({...base, nestedRouteName: r})).toBe('Summary');
    }
  });

  it('lights HOME on the areas the Lite Home opens (plans chooser, tiers, activity)', () => {
    for (const r of ['SecureServices', 'SecureLux', 'TierPaywall', 'Pricing', 'ActivityCenter']) {
      expect(secureFlowTabFor({...base, nestedRouteName: r})).toBe('Home');
    }
  });

  it('CreditPaywall is keyed on its DOOR: booking detour → Book, Ops-Room retry → Summary, wallet top-up → root footer', () => {
    expect(secureFlowTabFor({...base, nestedRouteName: 'CreditPaywall', nestedRouteParams: {source: 'booking-flow'}})).toBe('Book');
    expect(secureFlowTabFor({...base, nestedRouteName: 'CreditPaywall', nestedRouteParams: {source: 'opsroom'}})).toBe('Summary');
    expect(secureFlowTabFor({...base, nestedRouteName: 'CreditPaywall', nestedRouteParams: {source: 'wallet'}})).toBeNull();
    expect(secureFlowTabFor({...base, nestedRouteName: 'CreditPaywall', nestedRouteParams: null})).toBeNull();
    expect(secureFlowTabFor({...base, nestedRouteName: 'CreditPaywall'})).toBeNull();
  });

  it('NEVER renders when the shell is not beneath — a press would PUSH the Lite shell onto a PRO stack', () => {
    // PRO: [BookingHome, ProDashboard, TripHistory, OpsRoomReview] — no SecureShell.
    expect(secureFlowTabFor({...base, shellMounted: false, nestedRouteName: 'OpsRoomReview'})).toBeNull();
    expect(secureFlowTabFor({...base, shellMounted: false, nestedRouteName: 'CustomizeAddOns'})).toBeNull();
    // PRO back target: BookingHome beneath ProDashboard keeps the root footer.
    expect(secureFlowTabFor({...base, shellMounted: false, nestedRouteName: 'BookingHome'})).toBeNull();
    // LITE with the shell mounted: BookingHome as a stack route lights Home.
    expect(secureFlowTabFor({...base, nestedRouteName: 'BookingHome'})).toBe('Home');
  });

  it('is Secure-product only, SecureTab only, and PROFILE-hosted wins', () => {
    expect(secureFlowTabFor({...base, activeProduct: 'vbg', nestedRouteName: 'CustomizeAddOns'})).toBeNull();
    expect(secureFlowTabFor({...base, activeProduct: 'messenger', nestedRouteName: 'CustomizeAddOns'})).toBeNull();
    expect(secureFlowTabFor({...base, focusedRouteName: 'ProfileTab', nestedRouteName: 'CustomizeAddOns'})).toBeNull();
    expect(secureFlowTabFor({...base, profileHosted: true, nestedRouteName: 'CustomizeAddOns'})).toBeNull();
  });

  it('falls back to the ordinary root footer for Pro / VBG / unknown routes (never a blank bar)', () => {
    for (const r of ['ProDashboard', 'ProLiveMission', 'SecureProStatus', 'SecureProApply', 'VBGHome', 'Credits', 'SomethingNew', undefined, null]) {
      expect(secureFlowTabFor({...base, nestedRouteName: r})).toBeNull();
    }
  });

  it('every mapped route is a REAL BookingNavigator route (no dead keys)', () => {
    for (const route of [...Object.keys(SECURE_FLOW_TAB), ...SECURE_FLOW_CONFIRM_LEAVE]) {
      expect(BOOKING).toContain(`name="${route}"`);
    }
  });

  it('the confirm-leave set covers exactly the Book surfaces with unsaved local state, never a Summary surface', () => {
    for (const r of ['CustomizeAddOns', 'ExecReview', 'LocationPicker']) {
      expect(SECURE_FLOW_CONFIRM_LEAVE.has(r)).toBe(true);
      expect(SECURE_FLOW_TAB[r]).toBe('Book');
    }
    for (const r of SECURE_FLOW_CONFIRM_LEAVE) {
      expect(SECURE_FLOW_TAB[r]).toBe('Book');
    }
    for (const r of ['OpsRoomReview', 'BookingConfirmation', 'LiveTracking', 'SecureServices', 'BookingHome']) {
      expect(SECURE_FLOW_CONFIRM_LEAVE.has(r)).toBe(false);
    }
  });

  it('the bar order is the founder order, identical to the shell declaration', () => {
    expect([...SECURE_FLOW_ORDER]).toEqual(['Home', 'Book', 'Summary', 'Messenger']);
    const declared = [...SHELL.matchAll(/<Tab\.Screen\s+name="(\w+)"/g)].map(m => m[1]);
    expect(declared).toEqual([...SECURE_FLOW_ORDER]);
  });
});

describe('MainNavigator wiring — the root footer BECOMES the Secure flow bar', () => {
  it('the scan sees real code (not a vacuous pass)', () => {
    expect(MAIN.length).toBeGreaterThan(20_000);
    expect(MAIN).not.toContain('\r');
  });

  it('CustomTabBar asks the pure decision, with the shell-mounted and profile inputs read from the LIVE nav state', () => {
    expect(MAIN).toMatch(/import \{[^}]*\bsecureFlowTabFor\b[^}]*\} from '\.\/secureFlowTab'/);
    // shellMounted is derived from SecureTab's nested stack state — never assumed.
    expect(MAIN).toMatch(/const shellMounted = secureStackRoutes\.some\(r => r\.name === 'SecureShell'\)/);
    expect(MAIN).toMatch(/secureFlowTabFor\(\{[\s\S]{0,320}?profileHosted:\s*showProfileAsActive,\s*shellMounted,/);
    // The door-keyed route gets its params (CreditPaywall's `source`).
    expect(MAIN).toMatch(/nestedRouteParams:\s*nestedParams/);
  });

  it('the icons/labels come from the shell — one source, so the two bars cannot drift', () => {
    expect(MAIN).toMatch(/import \{[^}]*\bTAB_ICONS as SECURE_TAB_ICONS\b[^}]*\} from '\.\/SecureTabNavigator'/);
    expect(SHELL).toMatch(/export const TAB_ICONS/);
  });

  it('a flow-bar tab press goes INTO the shell with initial:false (cold-stack-seed rule)', () => {
    expect(MAIN).toMatch(
      /navigate\('SecureTab',\s*\{screen:\s*'SecureShell',\s*params:\s*\{screen:\s*tab,\s*initial:\s*false\},\s*initial:\s*false\}\)/,
    );
  });

  it('the Messenger item is the root Messenger tab (a plain focus, no params — B-95 class)', () => {
    // NAV-10 (2026-08-26) — dispatches through navigateOnce; still a plain
    // focus with NO params (the B-95 rule this pin exists for).
    expect(MAIN).toMatch(/tab === 'Messenger'\)\s*\{\s*navigateOnce\(navigation, 'MessengerTab'\);/);
  });

  it('pressing the already-lit tab is a no-op (never pops a half-filled dashboard)', () => {
    expect(MAIN).toMatch(/const focused = tab === flowTab;[\s\S]{0,600}?if \(focused\) \{return;\}/);
  });

  it('leaving a Book surface with local state asks first — the B-393 "Leave this screen?" class', () => {
    // The nested-params navigate bypasses beforeRemove, so the prompt lives at
    // the press: gated on the confirm-leave set, Stay = cancel, Continue = go.
    expect(MAIN).toMatch(/SECURE_FLOW_CONFIRM_LEAVE\.has\(secureNested\)/);
    expect(MAIN).toMatch(/Alert\.alert\(\s*'Leave this screen\?'[\s\S]{0,400}?\{text: 'Stay', style: 'cancel'\},\s*\{text: 'Continue', style: 'destructive', onPress: goToShellTab\}/);
  });

  it('flow mode pads the bottom like the shell bar (insets.bottom || 12) — no 6dp jump between the two bars', () => {
    expect(MAIN).toMatch(/const barPaddingBottom = flowTab\s*\?\s*\(insets\.bottom > 0 \? insets\.bottom : 12\)/);
  });

  it('still ONE renderer reporting its inset (no fourth tab-bar component)', () => {
    expect(MAIN).toMatch(/useReportBottomTabBar\(!hidden\)/);
  });
});
