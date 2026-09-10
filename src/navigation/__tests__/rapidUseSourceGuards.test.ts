/**
 * NAV-08/10/12/23 (2026-08-26 back-navigation & rapid-use audit) — the
 * cross-shell pins that cannot be render-tested from the node side. All are
 * comment-stripped source scans (house rules: CRLF-normalize, strip comments,
 * anchor at the decision site).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('NAV-12 — the pay button cannot double-charge', () => {
  const PAYWALL = 'src/screens/booking/CreditPaywallScreen.tsx';

  it('runPayment bails out on a synchronous REF, not the processing state', () => {
    // disabled={processing} needs a committed re-render, which lands late
    // exactly when the JS thread is backed up — the condition of the repro.
    // Each queued repeat here is a Stripe PaymentIntent.
    const src = strip(read(PAYWALL));
    const at = src.indexOf('const runPayment');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 400);
    expect(body).toMatch(/if \(processingRef\.current\) \{return;\}/);
    expect(body).toMatch(/processingRef\.current = true;/);
  });

  it('the ref re-arms in finally, and the button also disables visually', () => {
    const src = strip(read(PAYWALL));
    expect(src).toMatch(/finally \{\n\s*processingRef\.current = false;/);
    const btn = src.indexOf('void runPayment()');
    expect(btn).toBeGreaterThan(-1);
    expect(src.slice(btn, btn + 200)).toMatch(/disabled=\{processing\}/);
  });
});

describe('NAV-08 — timer-driven navigation cannot race a user back press', () => {
  it.each([
    // A back press inside the timer window pops the hosting screen; the timer
    // must not then navigate/pop on its behalf (a stale GO_BACK bubbles to the
    // parent — the B-261 mechanism, from a timer instead of a tap).
    ['src/components/ProfileDrawerModal.tsx', /isFocused && !isFocused\.call\(navigation\)\) \{return;\}/],
    ['src/screens/dashboard/DashboardScreen.tsx', /if \(navigation\.isFocused\(\)\) \{\n\s*\(navigation as unknown as \{navigate/],
    ['src/screens/booking/BookingHomeScreen.tsx', /if \(resumable && navigation\.isFocused\(\)\) \{/],
    ['src/screens/agent/AgentDashboardScreen.tsx', /if \(!navigation\.isFocused\(\)\) \{return;\}\n\s*switch \(label\)/],
  ])('%s guards its deferred navigation with isFocused', (file, marker) => {
    expect(strip(read(file as string))).toMatch(marker as RegExp);
  });

  it('IncomingOffer auto-dismiss is FOCUS-scoped and re-arms (never a blurred GO_BACK, never a parked screen)', () => {
    // The plain-useEffect timer fired once from a buried screen; an isFocused
    // skip alone then never re-armed, parking the route on 'passed' and
    // re-creating the watcher-swallow (critic finding). useFocusEffect gives
    // both halves: no blurred dispatch, re-armed on every refocus.
    const src = strip(read('src/screens/agent/IncomingOfferScreen.tsx'));
    const at = src.indexOf("if (phase !== 'passed')");
    expect(at).toBeGreaterThan(-1);
    const before = src.slice(0, at);
    expect(before.lastIndexOf('useFocusEffect(')).toBeGreaterThan(before.lastIndexOf('useEffect('));
    // ...and a cascade's params update re-adopts the NEW offer id.
    expect(src).toMatch(/pid && pid !== offerId/);
  });
});

describe('NAV-10 — the hottest forward-navigation presses route through navigateOnce', () => {
  it('Dashboard module cards (the literal "one button ×20" surface)', () => {
    const src = strip(read('src/screens/dashboard/DashboardScreen.tsx'));
    expect(src).toMatch(/goToMessenger = \(\) => navigateOnce\(navigation, 'MessengerTab'/);
    expect(src).toMatch(/goToSecure = \(\) => navigateOnce\(navigation, 'SecureTab'/);
    expect(src).toMatch(/goToVBG = \(\) => navigateOnce\(navigation, 'SecureTab'/);
  });

  it('ObsidianTabBar presses (the stale-focused capture cannot dedupe a burst)', () => {
    const src = strip(read('src/navigation/ObsidianTabBar.tsx'));
    const hits = src.match(/navigateOnce\(navigation, route\.name\);/g) ?? [];
    expect(hits.length).toBe(2); // the stand-in press and the plain-tab press
    expect(src).not.toMatch(/(^|[^.\w])navigation\.navigate\(route\.name\)/m);
  });

  it('CustomTabBar generic tab press routes through navigateOnce', () => {
    const src = strip(read('src/navigation/MainNavigator.tsx'));
    expect(src).toMatch(/navigateOnce\(navigation, route\.name\);/);
  });

  it('CONTROL: navigateOnce is wired widely (deleting call sites cannot pass silently)', () => {
    const files = [
      'src/screens/dashboard/DashboardScreen.tsx',
      'src/screens/agent/AgentDashboardScreen.tsx',
      'src/screens/booking/BookingHomeScreen.tsx',
      'src/screens/messenger/MessengerHomeScreen.tsx',
    ];
    const count = files
      .map(f => (strip(read(f)).match(/navigateOnce\(/g) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(count).toBeGreaterThan(30);
  });
});

describe('NAV-07 — agent hardware-back handlers read handleBack through a ref', () => {
  // The []-deps useFocusEffect callback froze the FIRST render's handleBack
  // behind a suppressed lint rule; AgentRegistrationWizardScreen had the fix
  // (handleBackRef) and these four were the un-fixed copies.
  it.each([
    'src/screens/agent/AgentAvailabilityScreen.tsx',
    'src/screens/agent/AgentKYCScreen.tsx',
    'src/screens/agent/AgentCoverageScreen.tsx',
    'src/screens/agent/AgentDocsUploadScreen.tsx',
  ])('%s', file => {
    const src = strip(read(file as string));
    expect(src).toMatch(/handleBackRef\.current = handleBack;/);
    expect(src).toMatch(/handleBackRef\.current\(\);/);
    // The stale form must be gone at the registration site.
    expect(src).not.toMatch(/hardwareBackPress', \(\) => \{\n\s*handleBack\(\);/);
  });
});

describe('NAV-17 — async-mutation buttons carry a synchronous in-flight guard', () => {
  // disabled={state} needs a committed re-render — late exactly when the JS
  // thread is lagging. Each of these used to fire once per queued tap.
  it.each([
    ['src/screens/settings/ProfileScreen.tsx', /if \(bioBusyRef\.current\) \{return;\}/],
    ['src/screens/messenger/MessengerSettingsScreen.tsx', /if \(unblockingRef\.current\.has\(userId\)\) \{return;\}/],
    ['src/screens/messenger/ChatInfoScreen.tsx', /if \(saveContactBusyRef\.current\) \{return;\}/],
    ['src/screens/deptchat/IncidentDetailScreen.tsx', /if \(busy \|\| busyRef\.current\) \{return;\}/],
    ['src/screens/dashboard/DashboardScreen.tsx', /if \(markAllInFlightRef\.current\) \{return;\}/],
  ])('%s', (file, marker) => {
    expect(strip(read(file as string))).toMatch(marker as RegExp);
  });
});

describe('NAV-21 — DepartmentalHome loads in parallel with one live run', () => {
  it('the six sequential awaits became one Promise.all, deduped per focus', () => {
    const src = strip(read('src/screens/deptchat/DepartmentalHomeScreen.tsx'));
    expect(src).toMatch(/await Promise\.all\(tasks\);/);
    expect(src).toMatch(/loadInFlightRef/);
  });
});

describe('NAV-23 — freezeOnBlur coverage: blurred screens stop rendering through the pop', () => {
  // MessengerNavigator has carried stack-wide freezeOnBlur since MX-13; the
  // other stacks never got it, so their blurred screens (booking polls, agent
  // dashboards, news WebViews) kept re-rendering under every pushed screen and
  // through every pop animation. NOTE: an explicit freezeOnBlur works WITHOUT
  // enableFreeze() — freezeEnabled() is only the destructuring default
  // (MESSENGER_LAG_AUDIT N2's contrary claim is corrected in that doc).
  it.each([
    'BookingNavigator.tsx',
    'AgentNavigator.tsx',
    'NewsNavigator.tsx',
    'AuthNavigator.tsx',
    'CpoOnboardingNavigator.tsx',
    'CpoNavigator.tsx',
    'DepartmentalNavigator.tsx',
    'MessengerNavigator.tsx',
  ])('%s sets freezeOnBlur: true', file => {
    expect(strip(read(join('src/navigation', file)))).toMatch(/freezeOnBlur: true/);
  });
});

describe('NAV-23 — the navigation root subscribes by selector, not the bare store hook', () => {
  // A bare useAuthStore() re-rendered the whole NavigationContainer subtree /
  // the tab bar on EVERY auth-store write.
  it.each([
    'src/navigation/index.tsx',
    'src/navigation/MainNavigator.tsx',
  ])('%s has no bare useAuthStore() destructuring', file => {
    const src = strip(read(file));
    expect(src).not.toMatch(/[=]\s*useAuthStore\(\)/);
  });
});
