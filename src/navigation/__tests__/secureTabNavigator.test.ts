/**
 * Wave 5d (PDF-2 A7) — the Secure LITE 4-tab shell (Home · Book · Summary ·
 * Messenger).
 *
 * WHY A SOURCE SCAN. SecureTabNavigator and its leaf screens pull the whole
 * booking/messenger tree (RN screens, native modules) that the node project
 * cannot import, so — like navigatorConfig / workspaceBottomNav — the shape is
 * locked at the source level: which tabs the bar renders, in which order, what
 * each maps to, that Messenger EXITS, and that the Pro landing is preserved while
 * the LITE landing is the shell. The reachability half (all ~55 booking routes
 * still resolve) is structural: the shell is a route INSIDE BookingNavigator, so
 * the negative pins below (no per-tab stack, drilling bubbles up) are what keep
 * it that way.
 *
 * Files may be CRLF — normalise first, and strip comments so the prose that
 * names every tab and route cannot satisfy a scan about CODE.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

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

const NAV = code(src('navigation', 'SecureTabNavigator.tsx'));
const BOOKING = code(src('navigation', 'BookingNavigator.tsx'));
const MAIN = code(src('navigation', 'MainNavigator.tsx'));
const SUMMARY = code(src('screens', 'booking', 'SecureSummaryScreen.tsx'));
const RESOLVER = code(src('screens', 'securepro', 'SecureLandingScreen.tsx'));
const SECURE_ROOT = code(src('screens', 'securepro', 'secureRoot.ts'));

/** Founder order: Home · Book · Summary · Messenger. */
const TABS = ['Home', 'Book', 'Summary', 'Messenger'] as const;

describe('SecureTabNavigator — the LITE 4-tab shell', () => {
  it('the scan sees real code (not a vacuous pass)', () => {
    expect(NAV.length).toBeGreaterThan(800);
    expect(NAV).toContain('createBottomTabNavigator');
    expect(NAV).not.toContain('\r');
  });

  it('declares EXACTLY the four founder tabs, in order', () => {
    const declared = [...NAV.matchAll(/<Tab\.Screen\s+name="(\w+)"/g)].map(m => m[1]);
    expect(declared).toEqual([...TABS]);
  });

  it('feeds the shared ObsidianTabBar, and every tab has an icon', () => {
    // A missing icon key degrades SILENTLY to a question mark — assert each one.
    // The renderer is hoisted (so the bar subtree is not remounted every render),
    // so pin BOTH the wiring and that the hoisted renderer draws ObsidianTabBar.
    expect(NAV).toMatch(/tabBar=\{renderSecureTabBar\}/);
    expect(NAV).toMatch(/function renderSecureTabBar[\s\S]{0,200}?ObsidianTabBar/);
    for (const tab of TABS) {
      expect(NAV).toMatch(new RegExp(`\\b${tab}:\\s*\\{default:`));
    }
  });

  it('Home → SecureHomeTab (tier-aware), Book → ServiceTypeScreen, Summary → SecureSummaryScreen', () => {
    /**
     * B-661 — Home is no longer BookingHomeScreen DIRECTLY. Both tiers now root
     * at this shell, so the Home tab resolves the tier itself: the Pro dashboard
     * for an ACTIVE Pro client, the Book-Now home for everyone else. See the
     * tier-landing block below for why the split moved in here.
     *
     * BookingHomeScreen is still the LITE home — one level down, inside
     * SecureHomeTab — so this pin follows the wrapper rather than asserting a
     * component that no longer sits at the tab.
     */
    expect(NAV).toMatch(/<Tab\.Screen name="Home" component=\{SecureHomeTab\}/);
    expect(NAV).toMatch(/<BookingHomeScreen \/>/);
    expect(NAV).toMatch(/<Tab\.Screen name="Book" component=\{ServiceTypeScreen\}/);
    expect(NAV).toMatch(/<Tab\.Screen name="Summary" component=\{SecureSummaryScreen\}/);
  });

  it('the Messenger tab EXITS — press intercepted, hops via the shell resolver', () => {
    // preventDefault, then the shell-aware resolver (not a bare getParent hop
    // that is silently dropped in shells with no MessengerHome — B-414).
    expect(NAV).toMatch(/tabPress: e => \{[\s\S]*?e\.preventDefault\(\)/);
    expect(NAV).toMatch(/navigateToMessengerScreen\([\s\S]{0,80}?'MessengerHome'/);
    expect(NAV).not.toMatch(/getParent\(\)\?\.navigate\(/);
  });

  it('is a shell of LEAF tabs — no per-tab stack that would duplicate booking routes', () => {
    // The whole reachability argument: routes live in BookingNavigator, drilling
    // bubbles UP. A createNativeStackNavigator here would mean a duplicated,
    // cross-tab-unreachable copy.
    expect(NAV).not.toContain('createNativeStackNavigator');
  });
});

describe('SecureShell reachability — the shell sits INSIDE BookingNavigator', () => {
  it('BookingNavigator registers SecureShell so it is reachable', () => {
    expect(BOOKING).toContain('name="SecureShell"');
    expect(BOOKING).toMatch(/component=\{SecureTabNavigator\}/);
  });

  it('SecureShell is NOT the stack initial route — BookingHome stays the seed floor', () => {
    // The first <Stack.Screen> is the default initial route; it must stay
    // BookingHome so every deep-linked booking screen still seeds it beneath
    // (the cold-stack-seed rule). SecureShell being first would break that.
    const first = BOOKING.match(/<Stack\.Screen\s+name="(\w+)"/);
    expect(first?.[1]).toBe('BookingHome');
  });

  it('MainNavigator hides the root tab bar while SecureShell is focused', () => {
    // Or the shell shows two footers (its own ObsidianTabBar + the root bar).
    // B-657 RE-POINTED, not weakened: the set gained `SecureLanding` (see the
    // next test), so the pin asserts MEMBERSHIP rather than the exact literal —
    // an exact-literal match would have to be rewritten for every future entry
    // and says nothing extra.
    expect(MAIN).toMatch(/SECURE_FULLSCREEN_ROUTES = new Set\(\[[^\]]*'SecureShell'[^\]]*\]\)/);
    expect(MAIN).toMatch(/SECURE_FULLSCREEN_ROUTES\.has\(nested\)/);
  });

  it('B-657 — the root bar is ALSO hidden on SecureLanding, or two bars flash', () => {
    /**
     * Founder, 2026-08-24: "switching from Messenger to Secure shows my
     * previous page with TWO bottom nav bars for a couple of seconds, then it
     * switches."
     *
     * `getFocusedRouteNameFromRoute` reports the LAST COMMITTED navigation
     * state. `SecureLanding` resets to `[SecureShell]`, and the shell mounts
     * its own 4-tab footer at once — but the root navigator only learns the
     * focused route changed on the FOLLOWING render. For that window both
     * footers are drawn.
     *
     * Hiding the root bar for `SecureLanding` closes the window: it is already
     * gone before the shell's bar appears.
     */
    expect(MAIN).toMatch(/SECURE_FULLSCREEN_ROUTES = new Set\(\[[^\]]*'SecureLanding'[^\]]*\]\)/);
  });

  it('B-657 — the seeded route is the fallback before state commits', () => {
    /**
     * On the very FIRST render after entering the tab there is no committed
     * state, so `getFocusedRouteNameFromRoute` returns undefined. Falling back
     * to `''` showed the root bar for that frame — the first half of the same
     * flicker. The fallback is the route the tab is seeded with, which is what
     * gets focused a moment later: the same answer, one frame earlier.
     *
     * ⚠️ A bare `?? ''` here re-opens the flash. The `seeded` hop is the fix.
     */
    expect(MAIN).toMatch(/const seeded = \(route\.params as \{screen\?: string\} \| undefined\)\?\.screen/);
    expect(MAIN).toMatch(/getFocusedRouteNameFromRoute\(route\) \?\? seeded \?\? ''/);
  });
});

describe('the tier landing - BOTH tiers get the shell (B-661)', () => {
  /**
   * REVERSED from the previous rule ("LITE gets the shell, PRO keeps
   * ProDashboard"), on the founder's instruction 2026-08-25: "it should be for
   * lite and pro version both".
   *
   * The old split is exactly why a PRO account never saw the 4-tab footer no
   * matter how many builds they installed - ProDashboard sits OUTSIDE the shell
   * and is not in SECURE_FULLSCREEN_ROUTES, so it kept MainNavigator's root bar.
   * The founder read that as "the footer is not updating" when in fact their
   * tier had routed them away from the shell before it could render.
   *
   * The tier decision did not disappear - it moved one level IN, to the shell's
   * Home tab. So a PRO client still lands on their dashboard AND gains the
   * footer.
   */
  it('secureRootRoute returns the shell for EVERY tier', () => {
    expect(SECURE_ROOT).toMatch(/return 'SecureShell';/);
    // The old branch, verbatim - a revert goes red here.
    expect(SECURE_ROOT).not.toMatch(/'ACTIVE' \? 'ProDashboard'/);
    /**
     * The return type is narrowed to the single literal on purpose. Left as a
     * two-member union, a `=== 'ProDashboard'` branch would still typecheck and
     * silently never run; narrowed, TypeScript reports it. That is exactly what
     * caught the stale branch in SecureLandingScreen when this changed.
     */
    expect(SECURE_ROOT).toMatch(/SecureRoot = 'SecureShell'/);
  });

  it('the resolver seeds the shell unconditionally, with no tier branch left', () => {
    expect(RESOLVER).toMatch(/target\.current = \[\{name: secureRootRoute\(application\)\}\]/);
    // The two-way seed is gone: PRO must no longer be sent to a bare
    // [BookingHome, ProDashboard] stack outside the shell.
    expect(RESOLVER).not.toMatch(/\{name: 'BookingHome'\}, \{name: 'ProDashboard'\}/);
    // It still ASKS through the shared helper rather than hard-coding the
    // literal - the drawer's truncation guard reads the same function, and the
    // two must not drift about where Secure's home is.
    expect(RESOLVER).toMatch(/secureRootRoute\(application\)/);
  });

  it('the tier decision now lives in the shell Home tab', () => {
    expect(NAV).toMatch(/function SecureHomeTab\(\)/);
    expect(NAV).toMatch(/application\?\.status === 'ACTIVE'/);
    expect(NAV).toMatch(/<Tab\.Screen name="Home" component=\{SecureHomeTab\} \/>/);
    /**
     * ONE Tab.Screen, chosen at render - never two conditional ones. This
     * navigator's own comment says declaration order IS the bar order and is
     * expressed in exactly one place; a conditional Tab.Screen would give the
     * bar a different item count per tier, which is the drift that comment
     * exists to prevent.
     */
    expect(NAV.match(/<Tab\.Screen name="Home"/g) ?? []).toHaveLength(1);
  });
});

describe('the Summary tab — active-booking surface via the shared resolver', () => {
  it('uses the shared resume resolver, not a reinvented one', () => {
    expect(SUMMARY).toMatch(/resumeTargetFor/);
    expect(SUMMARY).toMatch(/findResumableBooking/);
    // Reads the SAME store the Book-Now home polls — no new backend.
    expect(SUMMARY).toMatch(/useBookingStore/);
  });

  it('shows an honest empty state when there is no active booking', () => {
    expect(SUMMARY).toContain('No active booking');
  });
});
