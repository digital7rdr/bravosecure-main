/**
 * Bravo Secure — tier-aware landing resolver (PDF-1 #1).
 *
 * After login and on the Secure product switch, a PRO retainer client must land
 * on the Pro dashboard and a LITE client on the on-demand Book-Now home — not
 * the "Secure Plans" chooser (which stays reachable from BookingHome's
 * PLANS & SERVICES row). The tier comes from `useSecureProStore.application`
 * (`status === 'ACTIVE'` ⇒ Pro, own plan OR a linked family member) via the
 * shared `secureRootRoute` helper — the SAME source BookingHome's PRO/LITE badge
 * and SecureServices' Pro card use. NOT the messenger
 * `isProActive`/`subscription_tier` (SP-01: a different product, shared vocab).
 *
 * WHY A RESOLVER and not a synchronous branch at the landing sites: `application`
 * is loaded LAZILY — only fetched inside the useFocusEffect of the Secure
 * screens, never eagerly at boot/auth — so on the after-login path it is null at
 * landing time. Branching there would flash the Lite Book-Now home before a Pro
 * user's dashboard. This tiny screen shows a neutral loader, reads the gate once
 * it resolves, then RESETS the stack to the tier's canonical home:
 *   - ACTIVE             → [BookingHome, ProDashboard]  (back from Pro home → the
 *                          Book-Now home, the product's floor)
 *   - loaded, not ACTIVE → [SecureShell]                (the Lite 4-tab shell —
 *                          Wave 5d; its Home tab IS the Book-Now home)
 *   - not loaded / error → WAITS; the store flips `hasLoaded` in its own catch
 *     (fail-closed), so a failed load resolves to the SAFE default (Lite home),
 *     never a Pro dashboard a Lite user cannot use.
 *
 * A `reset` (not pop/replace) makes the landing DETERMINISTIC: the same-product
 * drawer tap `navigate`s here on top of whatever the user had open, and reset
 * collapses that to the canonical home in one shot — so a deep stack cannot leak
 * a stray screen beneath the home, and a Pro re-entry cannot stack a duplicate
 * ProDashboard. BookingHome is always the floor (seeded via `initial: false`),
 * which preserves the cold-stack-seed discipline.
 */
import React, {useEffect, useRef} from 'react';
import {View, ActivityIndicator, StyleSheet, StatusBar} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useSecureProStore} from '@store/secureProStore';
import {secureRootRoute} from './secureRoot';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureLanding'>;

const BG = '#07090D';
const ACCENT = '#5B8DEF';

/**
 * B-649 — how often a still-mounted resolver re-dispatches its reset.
 *
 * A successful reset UNMOUNTS this screen (the resolver is not in the target
 * stack), so the retry can never double-navigate; it only ever fires when the
 * previous dispatch provably went nowhere. That happens on the product-switch
 * round trip (VBG → Secure → VBG → Secure): the keyed shell remount's deferred
 * nested-state cleanup (B-95) can land AFTER this screen's reset when the JS
 * thread is stalled through the 30 ms hold-frame — measured 300-400 ms stalls
 * in the founder's repro log — wiping the freshly-reset stack back to the
 * seeded [BookingHome, SecureLanding] while the screen instance (and its old
 * decide-once latch) survives. The latch then pinned the user to the spinner
 * forever; the retry heals it in one tick.
 */
const RETRY_MS = 500;

type TargetRoutes = Array<{name: 'BookingHome' | 'ProDashboard' | 'SecureShell'}>;

export default function SecureLandingScreen() {
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(s => s.application);
  const hasLoaded = useSecureProStore(s => s.hasLoaded);
  const loadApplication = useSecureProStore(s => s.loadApplication);
  // Decide the TARGET exactly once — a late store change (e.g. the plan
  // expiring mid-resolve) must never re-aim a resolver that already picked its
  // landing. The DISPATCH, unlike the target, may repeat: see RETRY_MS.
  const target = useRef<TargetRoutes | null>(null);

  // Kick the lazy load — the store does not fetch /pro-applications/me at boot.
  useEffect(() => { void loadApplication(); }, [loadApplication]);

  useEffect(() => {
    if (!hasLoaded && !target.current) {return;}
    if (!target.current) {
      /**
       * B-661 — BOTH tiers land on the shell. Founder, 2026-08-25.
       *
       * This used to branch: PRO got `[BookingHome, ProDashboard]`, LITE got
       * `[SecureShell]`. That branch is why a PRO client never saw the 4-tab
       * footer — ProDashboard sits outside the shell and keeps MainNavigator's
       * root bar, so the footer looked permanently un-updated.
       *
       * The tier decision moved INTO the shell (`SecureTabNavigator`'s Home tab
       * renders the Pro dashboard for an ACTIVE client), so there is nothing
       * left to branch on here. `secureRootRoute` is still called rather than
       * hard-coding the literal: it stays the single named place the tier
       * question is asked, and the drawer's truncation guard reads the same
       * helper — the two must not drift about where Secure's home is.
       */
      target.current = [{name: secureRootRoute(application)}];
    }
    const dispatch = () => {
      const routes = target.current as TargetRoutes;
      navigation.reset({index: routes.length - 1, routes});
    };
    dispatch();
    // B-649 — self-heal: still mounted means the reset above went nowhere.
    const timer = setInterval(dispatch, RETRY_MS);
    return () => clearInterval(timer);
  }, [hasLoaded, application, navigation]);

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={BG} />
      <ActivityIndicator size="large" color={ACCENT} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: BG, alignItems: 'center', justifyContent: 'center'},
});
