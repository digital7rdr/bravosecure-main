import React, {useEffect} from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Platform, InteractionManager, Image, AppState, BackHandler, type ViewStyle} from 'react-native';
import {createBottomTabNavigator, type BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {getFocusedRouteNameFromRoute, CommonActions, useNavigation} from '@react-navigation/native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useReportBottomTabBar} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useRegisteredNames} from '@/modules/messenger/contacts/useRegisteredNames';
import {getDirectoryUsersClient} from '@/modules/messenger/contacts/directoryNames';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useAuthStore} from '@store/authStore';
import {deriveEntitlements} from '@store/entitlements';
import {useProductStore} from '@store/productStore';
import {pendingProvider} from '@store/pendingProvider';
import {pendingTier} from '@store/pendingTier';
import {effectiveTier} from '@utils/tier';
import TierPaywall from '@screens/pro/TierPaywall';
import {configureMessengerRuntime, setMessengerConfigGate, getMessengerRuntime, _resetMessengerRuntime} from '@/modules/messenger/runtime';
import {startJsThreadWatchdog} from '@utils/jsThreadWatchdog';
import {setIncomingCallHandler, setCallOfferVerifier} from '@/modules/messenger/webrtc/callDispatcher';
import {setGroupCallRingHandler} from '@/modules/messenger/webrtc/groupCallRingDispatcher';
import {useMessengerStore, resolveDirectConversationIdFromState, directPlaceholderConversation} from '@/modules/messenger/store';
import {useActivityStore} from '@store/activityStore';
import {API_BASE_URL, MSG_BASE_URL} from '@utils/constants';
import {onTierInsufficient, onAuthLost} from '@services/api';
import {navigationRef} from './navigationRef';
import {navigateToMessengerScreen} from './messengerDeepLink';
import {secureFlowTabFor, SECURE_FLOW_ORDER, SECURE_FLOW_CONFIRM_LEAVE} from './secureFlowTab';
import {navigateOnce} from './tapGuard';
import {TAB_ICONS as SECURE_TAB_ICONS} from './SecureTabNavigator';
import {Alert} from '@utils/alert';
import {shouldAskEnterpriseSetup, openEnterpriseSetupWhenMounted} from './enterpriseOnboarding';
import {BravoFont} from '@/theme/bravo';
import type {MainTabParamList} from './types';

// XEd25519 (Curve25519) sender-cert public key, base64. Pinned at
// build time from EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64; the matching
// private key lives only in auth-service .env. The constant fallback
// matches the dev keypair in apps/auth-service/.env so the app boots
// out-of-the-box without env wiring — flip both before staging/prod.
const SENDER_CERT_PUBLIC_KEY_B64 =
  process.env.EXPO_PUBLIC_SENDER_CERT_PUBLIC_KEY_B64 ??
  '7uox+8+kRi7Sy3jb+ibmm+Dt2S/LPtSiT2hkF1GjjyQ=';

import ProductGateScreen from '@screens/auth/ProductGateScreen';
import MessengerNavigator from './MessengerNavigator';
import BookingNavigator from './BookingNavigator';
import ProfileScreen from '@screens/settings/ProfileScreen';
// W4/B-685 boot diet — the agent/CPO shells are required LAZILY at their render
// branches below, never imported statically. The static import chain
// (AgentNavigator → AgentLiveTrackerScreen → BravoMap → @rnmapbox/maps) made
// EVERY account load + init the 19 MB Mapbox native SDK at shell mount:
// device-confirmed 2026-08-28 (MapboxInitializer + both .so loads in logcat on
// a messenger-only account). Only the role that renders a shell pays its eval,
// once. Pinned by bootDietGuards.test.ts.
let LazyAgentNavigator: React.ComponentType | null = null;
let LazyCpoNavigator: React.ComponentType | null = null;
function getAgentNavigator(): React.ComponentType {
  if (!LazyAgentNavigator) {
    LazyAgentNavigator = (require('./AgentNavigator') as {default: React.ComponentType}).default;
  }
  return LazyAgentNavigator;
}
function getCpoNavigator(): React.ComponentType {
  if (!LazyCpoNavigator) {
    LazyCpoNavigator = (require('./CpoNavigator') as {default: React.ComponentType}).default;
  }
  return LazyCpoNavigator;
}
import CpoOnboardingNavigator from './CpoOnboardingNavigator';
import CpoActivationScreen from '@screens/cpo/CpoActivationScreen';
import AccessEndedScreen from '@screens/cpo/AccessEndedScreen';
import {resolveAuthedRoute} from './resolveRoute';
import {tokenVault} from '@services/tokenVault';

const Tab = createBottomTabNavigator<MainTabParamList>();

// Command Home obsidian background (matches DashboardScreen's local
// T.bg / the Bravo Command Home design tokens). Kept here so the tab
// bar + scene container can match the Home screen without pulling in
// DashboardScreen's local token block.
const HOME_BG = '#07090D';
// Universal footer palette — obsidian + platinum-cobalt, matching the Bravo
// Secure design handoff (no navy shade). The root tab bar is the app-wide
// footer, so these apply on every tab.
const FOOTER_ACCENT = '#5B8DEF';
const FOOTER_ACCENT_DEEP = '#2F5BE0';
const FOOTER_MUTE = 'rgba(180,188,204,0.45)';
const FOOTER_TEXT = '#F2F4F8';

type IconName = React.ComponentProps<typeof Icon>['name'];

const ICONS: Record<string, {default: IconName; active: IconName; label: string}> = {
  Dashboard:    {default: 'home-outline',            active: 'home',                  label: 'Home'},
  MessengerTab: {default: 'message-text-outline',    active: 'message-text',          label: 'Messenger'},
  SecureTab:    {default: 'shield-check-outline',    active: 'shield-check',          label: 'Secure'},
  AgentJobs:    {default: 'clipboard-list-outline',  active: 'clipboard-list',        label: 'Jobs'},
  ProfileTab:   {default: 'account-circle-outline',  active: 'account-circle',        label: 'Profile'},
};

// VBG screens render fullscreen (no root tab bar). Keep in sync with the
// VBG* routes registered in BookingNavigator.
const VBG_FULLSCREEN_ROUTES = new Set(['VBGHome', 'VBGMap', 'VBGSRA', 'VBGOSINT', 'VBGNearby', 'VBGGeoRisk', 'VBGEmergency']);

// Wave 5d — the LITE Secure shell (SecureShell → SecureTabNavigator) renders its
// OWN ObsidianTabBar, so the root CustomTabBar must hide while it is the focused
// nested route, or the screen has two footers. Drilling deeper into the booking
// flow focuses a normal booking route (not this one), so the root bar returns —
// exactly the pre-Wave-5d behaviour for those screens.
/**
 * Secure routes that own their own footer, so the ROOT tab bar must hide.
 *
 * B-657 — `SecureLanding` is in here, and that is the fix for the founder's
 * "switching from Messenger to Secure shows my previous page with TWO bottom
 * nav bars for a couple of seconds, then switches".
 *
 * WHY TWO BARS APPEARED. This set is consulted via
 * `getFocusedRouteNameFromRoute`, which reports the focused nested route as of
 * the LAST COMMITTED navigation state. `SecureLanding` resets the stack to
 * `[SecureShell]`, and `SecureShell` mounts its own 4-tab footer immediately —
 * but the root navigator only learns the focused route is now `SecureShell` on
 * the FOLLOWING render. For that window both footers are on screen.
 *
 * Hiding the root bar for `SecureLanding` closes the window: the bar is already
 * gone before the shell's bar is drawn, so the handover is bar-less → shell bar
 * instead of two bars → one.
 *
 * ⚠️ Deliberately NOT hidden for the PRO path. Its target is
 * `[BookingHome, ProDashboard]`, neither of which is in this set, so the root
 * bar comes back once the resolver lands — correct, because ProDashboard has no
 * footer of its own. PRO therefore gets bar-hidden-while-resolving rather than a
 * double bar, which is the better of the two artifacts.
 *
 * NOTE this does not remove the RESOLVE WAIT itself. `secureProStore` is not
 * persisted, so the first Secure entry of each app session blocks on
 * `/pro-applications/me`; that shows as a spinner with no bar, which is an
 * honest loading state rather than a wrong-page flash.
 */
const SECURE_FULLSCREEN_ROUTES = new Set(['SecureShell', 'SecureLanding']);

// Screens hosted in the SecureTab stack but reached FROM Profile — the footer
// should highlight PROFILE while these are open (not SECURE). Payment/booking
// flows (CreditPaywall, TierPaywall, the SecurePro application flow)
// intentionally stay SECURE.
const PROFILE_HOSTED_ROUTES = new Set([
  'IndividualProfile', 'CorporateProfile', 'TripHistory', 'ProActivityHistory',
  // 'Credits' = Profile → Transaction History (wallet balance/batches), an
  // account-history view, so keep PROFILE highlighted like the others.
  'Credits', 'PaymentMethods',
]);

// B-91 M0 — per-product bottom-bar contents. Messenger owns its internal
// 5-tab bar so the root bar never shows there; Secure Services and VBG show
// Messenger (the communication MODULE) + Profile, per the spec's taskbars.
// VBG's own 3-tab footer renders on VBG screens (which hide this bar).
const PRODUCT_TABS: Record<string, ReadonlyArray<string>> = {
  messenger: ['MessengerTab'],
  secure: ['MessengerTab', 'ProfileTab'],
  vbg: ['MessengerTab', 'ProfileTab'],
};

function CustomTabBar({state, descriptors, navigation}: BottomTabBarProps) {
  const insets = useSafeAreaInsets();
  // NAV-23 (2026-08-26 audit) — selector, not the bare hook: this bar already
  // re-renders on every navigation state change; a bare useAuthStore() also
  // re-ran it on EVERY auth-store write.
  const user = useAuthStore(s => s.user);
  const activeProduct = useProductStore(s => s.activeProduct);
  const userInitials = (user?.full_name ?? user?.email ?? 'B')
    .split(/[\s@.]/)
    .filter(Boolean)
    .map(w => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase() || 'B';
  // Honour per-screen `tabBarStyle: {display:'none'}` set from nested
  // stack screens (e.g. CallScreen wants full immersion). Without this
  // the custom bar always renders and ignores the option.
  const focusedRoute   = state.routes[state.index];
  const focusedOptions = descriptors[focusedRoute.key]?.options;
  const tabBarStyle = focusedOptions?.tabBarStyle as ViewStyle | undefined;
  // Messenger owns its own internal tab bar (Chat / Groups / Call /
  // Files / News), so always hide the root app bar while inside that
  // nested stack. Belt-and-braces over `tabBarStyle` — some RN Nav
  // versions drop the style on deeply-nested descriptors.
  const hidden = tabBarStyle?.display === 'none' || focusedRoute.name === 'MessengerTab';

  // B-245 — tell screens above us that a bar is present so they stop adding
  // the safe-area inset a second time. THIS bar, not ObsidianTabBar, is what
  // renders on the root shell (booking, agent, pro, news, wallet…), so wiring
  // only ObsidianTabBar left every one of those screens still double-counting
  // — the gap the fix was supposed to close. Called before the early return
  // because hooks cannot be conditional.
  useReportBottomTabBar(!hidden);

  if (hidden) {return null;}

  // Profile-hosted screens (My Profile, My Bookings, Activity History, etc.)
  // physically live in the SecureTab/BookingNavigator stack, so the active
  // tab is SecureTab when they're open. Visually, though, the user came from
  // Profile — so highlight PROFILE, not SECURE, while one of these is focused.
  const secureNested = focusedRoute.name === 'SecureTab'
    ? getFocusedRouteNameFromRoute(focusedRoute)
    : undefined;
  const showProfileAsActive = !!secureNested && PROFILE_HOSTED_ROUTES.has(secureNested);

  // Client feedback 2026-08-22 ("Wrong Nav Bar") — while a LITE booking-flow
  // route is focused (the consolidated dashboards, the Summary surfaces…) this
  // root footer RENDERS AS the Secure 4-tab bar with the matching tab lit, so
  // the footer reads Home · Book · Summary · Messenger end-to-end instead of
  // flipping back to MESSENGER · PROFILE the moment the user leaves the shell
  // (PDF-2: "the bottom navigation highlights Booking throughout data entry").
  // The decision is the pure `secureFlowTabFor` (unit-tested). A press goes
  // INTO the shell — already in the stack for LITE, so navigate pops back to it
  // — and switches its tab. Same renderer, same styles: not a fourth bar.
  // The SecureTab's nested stack (BookingNavigator) as React Navigation holds it:
  // the shell must be BENEATH the focused route for a flow-bar press to be a pop
  // (on a PRO stack it is absent, and the same navigate would PUSH the shell).
  const secureStackRoutes = focusedRoute.name === 'SecureTab'
    ? (focusedRoute.state?.routes ?? [])
    : [];
  const shellMounted = secureStackRoutes.some(r => r.name === 'SecureShell');
  const nestedParams = secureNested
    ? (secureStackRoutes.find(r => r.name === secureNested)?.params as Record<string, unknown> | undefined) ?? null
    : null;
  const flowTab = secureFlowTabFor({
    activeProduct,
    focusedRouteName: focusedRoute.name,
    nestedRouteName: secureNested,
    nestedRouteParams: nestedParams,
    profileHosted: showProfileAsActive,
    shellMounted,
  });

  type BarItem = {
    key: string; focused: boolean; iconName: IconName; label: string;
    avatar: boolean; onPress: () => void;
  };
  const items: BarItem[] = flowTab
    ? SECURE_FLOW_ORDER.map(tab => {
        const focused = tab === flowTab;
        const meta = SECURE_TAB_ICONS[tab] ?? ICONS.Dashboard;
        const goToShellTab = () =>
          navigation.navigate('SecureTab', {screen: 'SecureShell', params: {screen: tab, initial: false}, initial: false});
        return {
          key: `secure-flow-${tab}`,
          focused,
          iconName: focused ? meta.active : meta.default,
          label: meta.label,
          avatar: false,
          onPress: () => {
            // The lit tab IS this screen's context — a re-press must never pop a
            // half-filled dashboard back to the shell.
            if (focused) {return;}
            // Messenger is the root tab — a plain focus, no params (B-95 class);
            // the Secure stack stays intact beneath, nothing is popped.
            if (tab === 'Messenger') {navigateOnce(navigation, 'MessengerTab'); return;}
            // Home/Summary POP everything above the shell. A nested-params
            // navigate bypasses `beforeRemove`, so the only guard is here: the
            // same "Leave this screen?" the drawer's Switch Dashboard asks before
            // it truncates a stack (B-393 class) — but only off a surface holding
            // state the store does not carry (the dashboards' local picker time,
            // a half-placed pin). Summary surfaces pop silently, as the root
            // SECURE tab always has.
            if (secureNested && SECURE_FLOW_CONFIRM_LEAVE.has(secureNested)) {
              Alert.alert(
                'Leave this screen?',
                'Going to ' + meta.label + ' closes the booking screens you have open. Anything not yet submitted may not be kept.',
                [
                  {text: 'Stay', style: 'cancel'},
                  {text: 'Continue', style: 'destructive', onPress: goToShellTab},
                ],
              );
              return;
            }
            goToShellTab();
          },
        };
      })
    : state.routes
        .filter(route => (PRODUCT_TABS[activeProduct ?? 'secure'] ?? []).includes(route.name))
        .map(route => {
          let focused = state.routes[state.index]?.key === route.key;
          // Override: while a profile-hosted screen is open inside SecureTab,
          // render PROFILE active and SECURE inactive.
          if (showProfileAsActive) {
            if (route.name === 'ProfileTab') {focused = true;}
            else if (route.name === 'SecureTab') {focused = false;}
          }
          const {options} = descriptors[route.key];
          const meta = ICONS[route.name] ?? ICONS.Dashboard;
          return {
            key: route.key,
            focused,
            iconName: focused ? meta.active : meta.default,
            label: options.tabBarLabel === 'Jobs' ? 'Jobs' : meta.label,
            avatar: route.name === 'ProfileTab',
            onPress: () => {
              const event = navigation.emit({
                type: 'tabPress', target: route.key, canPreventDefault: true,
              });
              if (!focused && !event.defaultPrevented) {
                // NAV-10 — 'focused' is a render-time capture, stale for a
                // whole mash burst under JS-thread lag; navigateOnce drops the
                // same-name repeats a stale check lets through.
                // NO params on a bar press. `route.params` here is only ever a
                // leftover deep-link payload (incoming call / drawer sibling
                // dispatch wrote {screen: …} onto the tab route), and replaying
                // it re-aims the tab at that screen on every later press — the
                // B-95 class. A plain focus preserves the tab's own state;
                // SecureTab's explicit landing lives in its tabPress listener.
                navigateOnce(navigation, route.name);
              }
            },
          };
        });

  // The footer is universally obsidian (#07090D) to match the Bravo Secure
  // design — same bar on every tab, no navy shade.
  //
  // Bottom pad: in flow mode use the SAME formula as the shell's ObsidianTabBar
  // (`insets.bottom || 12`, see its "dead black gap on 3-button nav" note), or
  // the footer visibly grows/shrinks by 6dp every time the user steps between
  // the shell and a dashboard — the two bars render the same four items and
  // must read as one. The root bar's own formula is left as it was.
  const barPaddingBottom = flowTab
    ? (insets.bottom > 0 ? insets.bottom : 12)
    : Math.max(insets.bottom, 8) + 6;
  return (
    <View style={[s.bar, {paddingBottom: barPaddingBottom}]}>
      <View style={s.hairline} />
      <View style={s.row}>
        {items.map(item => (
          <TouchableOpacity
            key={item.key}
            accessibilityRole="button"
            accessibilityState={item.focused ? {selected: true} : {}}
            onPress={item.onPress}
            activeOpacity={0.7}
            style={s.item}>
            {/* Top glow indicator — only visible on the active tab. */}
            {item.focused && <View style={s.activeIndicator} />}
            <View style={s.iconWrap}>
              {item.avatar ? (
                user?.avatar_url ? (
                  <Image
                    source={{uri: user.avatar_url}}
                    style={[s.profileAvatar, item.focused && s.profileAvatarActive]}
                  />
                ) : (
                  <View style={[s.profileAvatar, s.profileAvatarFallback, item.focused && s.profileAvatarActive]}>
                    <Text style={s.profileAvatarText}>{userInitials}</Text>
                  </View>
                )
              ) : (
                <Icon
                  name={item.iconName}
                  size={22}
                  color={item.focused ? FOOTER_ACCENT : FOOTER_MUTE}
                />
              )}
            </View>
            <FitLine
              style={[s.label, item.focused && s.labelActive]}
              floorScale={0.75}
              text={item.label}
            />
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

/**
 * WI-4.6 — the group mirror of the 1:1 explicit-accept lookup. Group Answer
 * taps latch `explicitAcceptIds` under the roomId (the gateway reuses it as
 * the callId), and every IncomingGroupCallScreen navigate re-asserts
 * `autoAccept` from it so a ring frame landing after the Answer cannot
 * un-answer the call (RN6 navigate REPLACES params — B-102 A1). Lazy require:
 * a cold WS-only boot has no push layer, and `false` is the right answer then.
 */
function groupRingExplicitlyAccepted(roomId: string): boolean {
  try {
    const fb = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
    // R2-3 — bounded to ONE ring window: the re-assert only has to outlive
    // the seconds between a landed navigation and its chasing WS frame.
    // Group roomIds are reused, so a longer memory auto-joins the NEXT ring.
    const {RING_TIMEOUT_MS} = require('@/modules/messenger/webrtc/callDeadlines') as typeof import('@/modules/messenger/webrtc/callDeadlines');
    return fb.wasCallExplicitlyAcceptedWithin(roomId, RING_TIMEOUT_MS);
  } catch {
    return false;
  }
}

export default function MainNavigator() {
  // NAV-23 — selector: this component owns the whole tab tree; a bare
  // useAuthStore() re-rendered it on every auth-store write.
  const user = useAuthStore(s => s.user);
  const recheckMembership = useAuthStore(s => s.recheckMembership);
  // FIX-02 audit round 2 — the messenger configure effect defers itself on a
  // degraded boot with no ownerKey pin; it needs this flag in its deps so the
  // /auth/me that verifies the session re-runs it (its deps are deliberately
  // NOT email/phone — a profile edit must not re-init the runtime). For a
  // normal boot the flag never flips, so this adds no re-runs; for a pinned
  // degraded boot the flip re-runs configureMessengerRuntime with identical
  // values, which the runtime cache absorbs.
  const sessionUnverified = useAuthStore(s => s.sessionUnverified);
  // B-115 — the B-79 placeholder-name backfill was mounted ONLY on
  // MessengerHomeScreen, so a cold-contact call/thread kept its raw-id
  // label until the user happened to visit Home. Mount it globally: any
  // still-placeholder direct conversation upgrades to the registered
  // Bravo name wherever the user is (custom + address-book names win).
  useRegisteredNames({users: user?.id ? getDirectoryUsersClient() : null, enabled: !!user?.id});
  // B-91 M0 — which standalone product the client shell mounts. Adopt the
  // pre-auth selector choice once (no-op when an active product already
  // persists or nothing is pending).
  const activeProduct = useProductStore(s => s.activeProduct);
  const gateVisible = useProductStore(s => s.gateVisible);
  React.useEffect(() => {
    useProductStore.getState().adoptPendingProduct();
  }, []);

  // B-95 — the keyed remount of the tab tree below is NOT enough to reset it
  // on a product switch: React Navigation stores the nested navigator's state
  // on the parent 'Main' route, and a freshly-keyed navigator REHYDRATES that
  // state (all three products share route names, so it is always "valid"),
  // ignoring initialRouteName — the old product's screen survived the switch.
  // The library's own cleanup (useNavigationBuilder unmount → setTimeout(0) →
  // state=undefined) also skips itself when the replacement navigator has
  // already mounted. So: hold one navigator-free frame on switch, let the
  // deferred cleanup clear the slate, then mount the new product's tree.
  const [mountedProduct, setMountedProduct] = React.useState(activeProduct);
  useEffect(() => {
    if (mountedProduct === activeProduct) {return;}
    const t = setTimeout(() => setMountedProduct(activeProduct), 30);
    return () => clearTimeout(t);
  }, [mountedProduct, activeProduct]);

  const navigation = useNavigation<{setParams: (p: object) => void}>();
  // A provider who just signed up is still role='individual' until they create
  // their company agent. The persisted pendingProvider flag bridges that window
  // so they enter the agent flow (AgentTypeSelect → POST /agents → role flips)
  // instead of the client home. Cleared once the company agent exists.
  const [pendingProv, setPendingProv] = React.useState(false);
  React.useEffect(() => {
    let alive = true;
    void pendingProvider.get().then(v => { if (alive) {setPendingProv(v);} });
    return () => { alive = false; };
  }, [user?.role]);

  // M1A rule 5 — the paid tier picked on the pre-auth plan screen. Loaded
  // async; 'unknown' keeps us from flashing the product gate for one frame
  // before the paywall on a fresh Pro/Enterprise signup. Resolved (subscribe
  // OR "Start as Lite today") → cleared and never asked again.
  const [pendingPaidTier, setPendingPaidTier] =
    React.useState<'unknown' | 'pro' | 'enterprise' | null>('unknown');
  React.useEffect(() => {
    let alive = true;
    void pendingTier.get().then(v => {
      if (!alive) {return;}
      // Already paid (re-login, ops grant, second device) — nothing to ask.
      if (v && effectiveTier(useAuthStore.getState().user) !== 'lite') {
        void pendingTier.clear();
        setPendingPaidTier(null);
        return;
      }
      setPendingPaidTier(v);
    });
    return () => { alive = false; };
  }, [user?.id]);
  const resolvePaywall = React.useCallback((subscribed: boolean) => {
    const resolvedTier = pendingPaidTier === 'unknown' ? null : pendingPaidTier;
    void pendingTier.clear();
    setPendingPaidTier(null);
    // Spec routing (M1A §2): Lite/Pro land on the Chat list; Enterprise stays
    // inside Messenger. Either way the tier flow enters the Messenger product
    // — the combined home no longer exists and the gate isn't re-asked here.
    useProductStore.getState().setActiveProduct('messenger');
    // F1 — a new ENTERPRISE customer is owed the A4/M4 create-or-join fork. This
    // is the only moment the app knows the tier was just bought: `pendingTier` is
    // cleared above and never asked again. Without this the fork's single call
    // site (inside DepartmentChannelsScreen) meant nobody was ever asked, and the
    // customer landed in a personal chat list with no workspace. Declining to
    // Lite is NOT enterprise — `shouldAskEnterpriseSetup` gates on `subscribed`.
    if (shouldAskEnterpriseSetup(resolvedTier, subscribed)) {
      openEnterpriseSetupWhenMounted();
    }
  }, [pendingPaidTier]);

  // RS-06 — refresh /auth/me whenever the app returns to the foreground, for
  // EVERY shell (not just the CPO shell). A server-side role / tier / membership
  // change made while the app was backgrounded otherwise stays invisible on a
  // warm app. recheckMembership re-pulls /auth/me (updating the local user →
  // resolveAuthedRoute re-routes) and, for a suspended/removed CPO, runs the
  // endCpoAccess teardown. Min-interval guarded so rapid fg/bg toggles don't
  // hammer the endpoint, and gated on an authenticated user so it never fires
  // on the login surface. No mount fire — addEventListener doesn't emit for the
  // already-'active' state, so this can't double-pull right after initialize().
  const lastMeRefresh = React.useRef(0);
  React.useEffect(() => {
    if (!user?.id) {return;}
    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') {return;}
      // Audit Step 2.1 — refresh the TURN cache on foreground so a call
      // started right after unlock finds it warm (no-op while still fresh).
      try {
        const {prewarmIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
        prewarmIceServers();
      } catch { /* prewarm never blocks */ }
      const now = Date.now();
      if (now - lastMeRefresh.current < 30_000) {return;}
      lastMeRefresh.current = now;
      void recheckMembership();
    });
    return () => sub.remove();
  }, [user?.id, recheckMembership]);

  // VBG audit H-3 — resume the encrypted-telemetry loop on app boot for a
  // principal already enrolled in monitoring (no-op when no key is stored).
  useEffect(() => {
    if (!user?.id) {return;}
    void import('@/services/vbgTelemetry').then(m => m.ensureVbgTelemetry()).catch(() => {});
    // Linked Members — active family members share their last fix with the
    // plan owner (membership-gated server-side; silent no-op for everyone else).
    void import('@/services/familyPresence').then(m => m.ensureFamilyPresence()).catch(() => {});
  }, [user?.id]);

  // §35A §B — route off the SERVER-authenticated account_kind (never a client flag).
  // pendingProvider + the legacy role strings survive only as the agency self-signup
  // fallback (resolveAuthedRoute folds them in). Decided once here; the branch happens
  // after the messenger-runtime bootstrap below so a CPO's Ops Room comms still warm up.
  const authedRoute = resolveAuthedRoute({
    accountKind:     user?.account_kind,
    mustSetPassword: user?.must_set_password,
    membershipStatus: user?.membership_status,
    cpoNeedsOnboarding: user?.cpo_needs_onboarding,
    legacyRole:      user?.role,
    pendingProvider: pendingProv,
    isOrgManager:    user?.is_org_manager,
    hasWorkspaceAffiliation: user?.owns_workspace === true || (user?.workspaces?.length ?? 0) > 0,
  });

  // Audit F-05 — a tier-gated 403 (tier_insufficient) anywhere in the app
  // routes the CLIENT into the MESSENGER-tier paywall (TierPaywall) instead of
  // failing silently. This is the M1A subscription surface — deliberately NOT
  // the Bravo Secure Pro application flow (the old ProPaywall funnel is gone).
  // Provider shells (cpo/agency) have no paywall route, so no-op there.
  const isClientShell = !['access-ended', 'cpo-activation', 'cpo-onboarding', 'cpo', 'agency'].includes(authedRoute as string);
  useEffect(() => {
    if (!isClientShell) {return;}
    return onTierInsufficient(() => {
      if (navigationRef.isReady()) {
        navigationRef.dispatch(
          // BB-3 (2026-08-15 back audit) — initial: false, or a tier-403 from
          // inside Messenger re-roots the lazy Booking stack at the paywall:
          // its back arrow and close were silent no-ops (openPricing.ts states
          // the same rule for the sibling Pricing entry).
          CommonActions.navigate('Main', {screen: 'SecureTab', params: {screen: 'TierPaywall', initial: false, params: {tier: 'pro'}}}),
        );
      }
    });
  }, [isClientShell]);

  // LB-API1 — a genuine session loss (revoked/absent refresh token; most often a
  // single-device takeover when the same account signs in elsewhere) clears the
  // tokens in the api interceptor. Without this the app would sit tokenless on a
  // booking screen and every call would 401 ("the API stopped working"). Tear the
  // session down so RootNavigator swaps to the login stack. Applies to ALL shells.
  useEffect(() => {
    return onAuthLost(() => {
      // signOut is idempotent + best-effort; guard so a burst of 401s (the live
      // screen fires several concurrent polls) triggers exactly one teardown.
      const st = useAuthStore.getState();
      if (st.isSigningOut || !st.isAuthenticated) {return;}
      void st.signOut();
    });
  }, []);

  // B-95 — hardware back at a product's ROOT re-opens the product gate
  // instead of closing the app (Main is the only root route, so there is
  // nothing to pop and Android would exit). Screen-level handlers (calls,
  // vault lock) register later and win first; while anything can pop we
  // return false so the container's own back handling runs. On the gate
  // itself this handler is unregistered — back there backgrounds the app,
  // the normal Android root behaviour.
  useEffect(() => {
    if (!isClientShell || !activeProduct || gateVisible) {return;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (navigationRef.isReady() && navigationRef.canGoBack()) {return false;}
      // B-352 — a cross-product entry (VBG → Secure Services) recorded where
      // it came from; back at this product's root returns THERE, not to the
      // gate. setActiveProduct clears returnProduct, so a second back at the
      // origin's root falls through to the gate as before.
      const returnTo = useProductStore.getState().returnProduct;
      if (returnTo) {
        useProductStore.getState().setActiveProduct(returnTo);
        return true;
      }
      // vs2 item 18 — back at a product root no longer re-opens the gate.
      //
      // The gate is the BOOT question ("where would you like to start?"). Firing
      // it from a back press turned the ordinary Android "I'm done" gesture into
      // a full-screen modal the user did not ask for, and made the app
      // impossible to leave with back at all. `false` hands the press to the OS,
      // which backgrounds the app — the standard behaviour at a root.
      //
      // The B-352 branch above is UNTOUCHED: a cross-product entry still
      // returns to where it came from first.
      return false;
    });
    return () => sub.remove();
  }, [isClientShell, activeProduct, gateVisible]);

  // B-95 — deep-link navigates (incoming call / notification tap →
  // navigate('Main', {screen: 'MessengerTab', …})) leave those params ON the
  // Main route. A freshly-mounted nested navigator lets `params.screen`
  // override its initialRouteName, so a stale deep-link would re-aim every
  // later product switch at MessengerTab. Neutralize the nested params each
  // time the client tab tree goes hidden (gate or switch hold-frame);
  // anything that navigates AFTER this transition still lands normally.
  const treeHidden = !activeProduct || gateVisible || mountedProduct !== activeProduct;
  useEffect(() => {
    if (!isClientShell || !treeHidden) {return;}
    navigation.setParams({screen: undefined, params: undefined, initial: undefined, state: undefined});
  }, [isClientShell, treeHidden, navigation]);

  // Configure + pre-warm the messenger runtime the moment the Dashboard
  // paints, so the first tap on a Chat doesn't block on ~1s of pure-JS
  // libsignal keygen. Without configureMessengerRuntime() the runtime
  // falls through to loopback-memory mode and messages echo locally
  // instead of routing through the relay — see BRAVO-INTEL banner.
  useEffect(() => {
    if (!user?.id || !SENDER_CERT_PUBLIC_KEY_B64) {return;}
    // Isolation layer 3 (in-memory): wipe the Zustand store if a
    // *different* identity logs in. Keyed on a stable identifier
    // (email/phone) rather than user.id — auth-service mints a fresh
    // UUID on every re-register, which would otherwise wipe the store
    // for the same human in dev. Production identities are stable
    // either way.
    // L5 OWNERKEY-DRIFT-HISTORY-LOSS — PIN the SQLCipher persistence key to the
    // immutable user.id. The old `email ?? phone ?? id` chain silently re-keyed
    // the DB (and orphaned the user's chat history) whenever a re-login returned
    // a /me payload WITHOUT email — the reported "messages gone after logout/
    // login". We now resolve ownerKey ONCE per user.id and reuse it: existing
    // installs adopt their CURRENT email-based key on first run (no orphan),
    // and every later login is drift-proof regardless of payload completeness
    // or a later profile email change. Async (one AsyncStorage read) so the
    // body that configures the runtime runs after the pin resolves.
    const userId = user.id;
    const computedOwnerKey = user.email ?? user.phone_e164 ?? userId;
    let cancelled = false;
    let task: ReturnType<typeof InteractionManager.runAfterInteractions> | null = null;
    const configuring = (async () => {
    let ownerKey = computedOwnerKey;
    try {
      const pinned = await AsyncStorage.getItem(`msg:ownerKey:${userId}`);
      if (pinned) {
        ownerKey = pinned;
      } else if (useAuthStore.getState().sessionUnverified) {
        // FIX-02 audit round 2 — a degraded (claims-only) session has no
        // email/phone, so computedOwnerKey degenerated to user.id. Round 1
        // only deferred WRITING the pin; the boot still RAN on the degenerate
        // key, which pointed setOwner at an empty vault slot and opened a
        // user.id-scoped SQLCipher DB — any message received during that boot
        // landed in a DB that is orphaned forever once the verified boot pins
        // the real email-derived key. Silent data stranding beats a missing
        // messenger for one rare boot (pre-L5 install + snapshot-less +
        // offline), so skip the messenger configure entirely: this effect
        // re-runs when /auth/me lands because sessionUnverified is in its
        // dependency array (the flag flip is the verification signal).
        console.log('[MainNavigator] degraded session with no ownerKey pin — messenger deferred to a verified boot');
        return;
      } else {
        await AsyncStorage.setItem(`msg:ownerKey:${userId}`, ownerKey);
      }
    } catch { /* storage blip — fall back to the computed key (no worse than before) */ }
    if (cancelled) {return;}
    const store = useMessengerStore.getState();
    // Two DIFFERENT ids on purpose: `ownerKey` scopes the vault/DB (it is an
    // email for most accounts), `userId` is the auth UUID that group
    // participants/receipts are keyed by. Conflating them is what made the
    // group blue tick unreachable.
    store.setOwner(ownerKey, userId);
    // Step 18 — scope the activity feed to this identity too, so a user switch on the
    // same device wipes the previous account's notifications inbox (P0 isolation).
    useActivityStore.getState().setOwner(ownerKey);
    // B-696 — adopt this owner's vault slice (stash-and-swap; design doc
    // VAULT_DURABILITY_DESIGN_2026-08-29 §3). Same ownerKey as the two
    // setOwner calls above, deferred past the vault store's own rehydration
    // so the swap never runs against initialState. Then arm the Phase D
    // index sync (push on change, pull-merge on an empty index) — it keys
    // the blob crypto off the SAME ownerKey's mirror master key and the
    // auth userId for the AAD/server row.
    try {
      const {adoptVaultOwnerWhenReady, armVaultIndexSync} = require('@/modules/messenger/vault') as
        typeof import('@/modules/messenger/vault');
      adoptVaultOwnerWhenReady(ownerKey);
      armVaultIndexSync(ownerKey, userId);
    } catch { /* vault module unavailable — vault stays unadopted, locked-empty */ }
    // N-20 — hydrate the in-app bell from the durable server inbox now + on
    // every foreground, so a wake missed while killed/Dozed still backfills.
    try {
      const {startActivitySync} = require('@store/activitySync') as typeof import('@store/activitySync');
      startActivitySync();
    } catch { /* non-fatal — local activity still renders */ }
    /**
     * Scope v2 Phase 4 — ARM THE COMPANY-FILE REFUSAL AT BOOT.
     *
     * `moveBytesToVault` refuses a company file by asking whether its
     * conversation is departmental. That registry is otherwise armed only by
     * opening a channel thread or a Vault/Files surface — and a channel
     * notification deep-links straight to ChatScreen, which does neither. Worse,
     * the deep link passes `initial: false` so MessengerHome is seeded BENEATH
     * the pushed Chat: mounted but never focused, so a focus effect there never
     * runs. In the Agent shell MessengerHome is a sibling route that never
     * mounts at all.
     *
     * So it is armed HERE, once per owner, before any shell mounts — the only
     * point all three shells and the cold deep-link share. Best-effort and
     * non-fatal: a failure leaves the registry as it was on disk (it is
     * persisted and additive), and every other writer still contributes.
     */
    /**
     * ⚠️ B-593 — THIS ARMING MUST STAY BELOW `store.setOwner`.
     *
     * A first pass moved it to the top of the effect, reasoning that a
     * degraded (claims-only) boot returns early and never arms, leaving dept
     * channels visible for that whole session. True — but the remedy is worse
     * than the leak: `setOwner` SNAPSHOTS the live `deptConversationIds` into
     * the outgoing owner's slice and then REPLACES it from the incoming
     * owner's, so an arm that resolves first writes the new user's channel ids
     * into the PREVIOUS user's persisted registry and then has its own result
     * discarded. One HTTP round trip against one AsyncStorage read is a race
     * the network usually loses — "usually" being the shape of a shipped bug.
     *
     * The degraded boot defers the ENTIRE messenger for the same reason (an
     * unknown ownerKey points at the wrong vault slot and DB), so arming a
     * registry there would be writing under an identity we have not resolved.
     * Leaving it unarmed for that rare boot is the honest trade; the effect
     * re-runs the moment `sessionUnverified` flips.
     */
    try {
      const {armDeptConversationRegistry} =
        require('@/modules/messenger/vault/useCompanyShelf') as typeof import('@/modules/messenger/vault/useCompanyShelf');
      void armDeptConversationRegistry();
    } catch { /* non-fatal */ }
    // Also tear down the runtime singleton so the new user gets a fresh
    // SQLCipher DB opened with their own key, not the previous user's.
    _resetMessengerRuntime();
    // socket.io-client accepts the http(s) base URL + strips `/ws`
    // internally, so we hand it the same messenger base URL — the path
    // is configured inside TransportClient.
    const wsUrl = `${MSG_BASE_URL.replace(/^http/, 'ws')}/ws`;
    configureMessengerRuntime({
      authBaseUrl:      API_BASE_URL,
      messengerBaseUrl: MSG_BASE_URL,
      wsUrl,
      getToken:         () => tokenVault.getAccess(),
      // Round 2 fix: drive the single-flight refresh chain so the
      // KeysHttpClient / SenderCertClient / RelayHttpClient 401 retry
      // paths actually fire. Lazy-required to avoid a boot-time cycle.
      refreshToken:     () => {

        const {refreshAccessTokenShared} = require('@/services/api') as typeof import('@/services/api');
        return refreshAccessTokenShared();
      },
      authorityPubKeyB64: SENDER_CERT_PUBLIC_KEY_B64,
      ownUserId:        userId,
      // Stable persistence key — matches the messengerStore vault key,
      // so SQLCipher messages stay paired with the conversation list
      // even if user.id rotates across re-registrations.
      ownerKey,
    });
    // B-324/B-325 — persist what the KILLED-app drain needs to rebuild this
    // exact config with no UI (headlessDrain.ts): the two ids + the PUBLIC
    // authority key (verbatim, so the two configs can never drift). No
    // tokens, no private keys. Cleared on signOut.
    try {
      const {persistHeadlessRuntimeConfig} = require('@/modules/messenger/push/headlessDrain') as typeof import('@/modules/messenger/push/headlessDrain');
      void persistHeadlessRuntimeConfig({ownUserId: userId, ownerKey, authorityPubKeyB64: SENDER_CERT_PUBLIC_KEY_B64});
    } catch { /* headless drain simply stays unavailable */ }
    task = InteractionManager.runAfterInteractions(() => {
      // CRITICAL ORDER: probe for backup BEFORE the messenger runtime
      // boots. Reason: buildProductionRuntime() unconditionally calls
      // installIdentity(), which auto-creates a fresh Signal identity
      // when the local store has none. After that, "no local identity"
      // is no longer a detectable state — the runtime always has one.
      //
      // So if a user clears app data with a server backup in place, the
      // post-runtime probe always returned "case B — backup + local
      // identity" (the freshly-installed one) and skipped the restore
      // screen. The user then saw the BackupSetup prompt and lost their
      // chats.
      //
      // Fix: peek the keychain BEFORE runtime init. Empty keychain +
      // backup-on-server → push BackupRestore, which will install the
      // OLD identity from the wrapped backup, then init the runtime.
      // Otherwise just init the runtime as before.

      const {runBackupBoot} = require('@/modules/messenger/backup/backupBoot') as typeof import('@/modules/messenger/backup/backupBoot');
      // Department posts are E2EE and device-local, so deleting the app
      // destroys a workspace's whole history — an encrypted backup is the
      // only thing that survives it. For org accounts the setup prompt is
      // therefore mandatory, not dismissible. Derived from the ONE shared
      // entitlements rule so it cannot drift from every other org gate.
      const isOrgAccount = deriveEntitlements(useAuthStore.getState().user).isOrgAffiliated;
      void runBackupBoot(navigationRef, {ownerKey, legacyOwnerId: userId, getMessengerRuntime, isOrgAccount})
        .catch(e => console.warn('[MainNavigator] backup boot failed:', (e as Error).message));
      // FCM bootstrap — request POST_NOTIFICATIONS on Android 13+,
      // grab the FCM token, POST to /push/register-voip so the gateway
      // can VoIP-wake this device for inbound 1:1 / group calls. Idempotent.

      const {startFcmBootstrap} = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
      void startFcmBootstrap().catch(e =>
        console.warn('[MainNavigator] FCM bootstrap failed:', (e as Error).message))
        .finally(() => {
          // B-412 — one [NOTIFHEALTH] warn per boot, after the bootstrap has
          // had its chance to register, so `reg=` reflects this session.
          const {logNotifHealth} = require('@/modules/messenger/push/notifHealthProbe') as typeof import('@/modules/messenger/push/notifHealthProbe');
          void logNotifHealth();
        });
    });
    })();
    // B-272 — publish the pending configure SYNCHRONOUSLY (no await may run
    // before this line). A chat mounted in this same frame by a notification
    // deep link then WAITS for the ownerKey pin instead of being told the
    // runtime is unconfigured and silently skipping its drain.
    setMessengerConfigGate(configuring);
    // B-285 — report JS-thread stalls for the life of the session. Idempotent, so
    // a re-run of this effect does not stack timers. This is what turns "the tap
    // sometimes takes a moment" into a timestamped duration we can attribute.
    startJsThreadWatchdog();
    void configuring.catch(e =>
      console.warn('[MainNavigator] messenger configure failed:', (e as Error).message));
    return () => { cancelled = true; task?.cancel(); };
    // user.email + user.phone_e164 derive into ownerKey; we
    // intentionally re-init only on user.id change so a profile
    // edit doesn't trigger a full SQLCipher re-open + WS reconnect.
    // sessionUnverified is the ONE exception (audit round 2): the deferred
    // degraded boot above must get a second chance when /auth/me lands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, sessionUnverified]);

  // Wire the global incoming-call handler. Without this the dispatcher
  // silently drops every `call.offer` whose callId isn't already
  // registered locally — the symptom is "I called but the other phone
  // never rang." Navigates to CallScreen with direction='incoming' so
  // the ringing UI mounts and useCall picks up the offer SDP.
  useEffect(() => {
    if (!user?.id) {return;}
    setIncomingCallHandler((data, opts) => {
      if (!navigationRef.isReady()) {return;}
      // [CALLLAT] (audit Step 0) — the answerer lane's true origin: the offer
      // (SDP) reached this device. `freshAfterMs` lets a notification tap that
      // came first keep t0 (killed lane), but never a previous call's clock.
      {
        const {logCallLat} = require('@/modules/messenger/runtime/callDiag') as typeof import('@/modules/messenger/runtime/callDiag');
        logCallLat('1to1-in', data.callId, 'offer:received', {kind: data.kind, reassert: !!opts?.reassert}, {freshAfterMs: 90_000});
      }
      // Audit Step 2.1 — warm TURN while the phone rings so the accept-time
      // fetch is a cache hit (the caller's measured 46–76 % time-to-offer).
      try {
        const {prewarmIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
        prewarmIceServers();
      } catch { /* diag/prewarm never blocks a ring */ }
      // B-107 — a backup restore is in progress: never ring. The restore
      // flow disposes/rebuilds the runtime mid-flight (a live call's
      // signalling would strand — B-64 class) and an answer would be
      // signed by the throwaway pre-restore identity. Auto-busy so the
      // caller's ring stops immediately (same frame the CALL-N10
      // second-call guard sends). Placed BEFORE the Telecom/cache work so
      // no system UI ever rings.
      // WI-2.5(b) — a RE-ASSERT must never reach this. It only fires for a
      // call whose signalling is already registered and whose accept the user
      // has explicitly latched, so sending `busy` here would busy the very
      // call being answered. Pre-Phase-2 the replay died at `sig.ingest` and
      // could not reach the handler at all. WI-5.7 note: the dispose-path
      // transients clear (restore rebuild) PRESERVES the live call's
      // registered signalling precisely so this stays true — only sign-out
      // clears unconditionally, and it ends the active call first.
      try {
        const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
        if (!opts?.reassert && isRestoreModeActive()) {
          try {
            const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
            // AUDIT #11 — the restore flow now NULLS the registry for the
            // rebuild window (disposeLiveRuntime → clearLiveTransport), so a
            // bare getLiveTransport() here is null in EXACTLY the flow this
            // busy exists for, and `?.` silently dropped it — the caller
            // rang to the 30s timeout. Wait (bounded) for the rebuild's new
            // socket instead; the busy still races well ahead of the ring
            // timeout.
            void reg.waitForLiveTransport(8_000).then(t => {
              t?.send({event: 'call.hangup', data: {callId: data.callId, to: data.from, reason: 'busy'}} as never);
              // Log-honesty (critic): say what actually happened, when it did.
              console.log('[MainNavigator] restore-busy', t ? 'sent' : 'NO socket within 8s — dropped', data.callId);
            }).catch(() => { /* fire-and-forget */ });
          } catch { /* fire-and-forget */ }
          console.log('[MainNavigator] restore in progress — busy queued for', data.callId);
          return;
        }
      } catch { /* flag module unavailable — ring normally */ }
      // FIX-14 — never ring a call this device already knows is over.
      //
      // The server skips replaying an offer whose caller already hung up
      // (rehydrateCallSession), so protection against a resurrected ring rested
      // ENTIRELY on that one server-side tombstone. Every cancel lane on the
      // client — WS call.hangup, the FCM call-cancel wake, Telecom end, decline,
      // natural end — already funnels through clearIncomingCallPayload (which
      // tombstones) and callRegistry's recently-ended window, and neither was
      // consulted here. A reconnect that replays a stale `call.offer`, or a
      // wake that outlived its call, rang anyway.
      //
      // Cheap, synchronous, and keyed STRICTLY by callId — never by peer, or a
      // legitimate second call from the same person would be swallowed.
      try {
        const cache = require('@/modules/messenger/push/incomingCallCache') as typeof import('@/modules/messenger/push/incomingCallCache');
        const reg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        if (cache.isIncomingCallDead(data.callId) || reg.wasRecentlyEnded(data.callId)) {
          console.log('[MainNavigator] dropping offer for a call already ended:', data.callId);
          // Sweep any ring the OS may still be showing for it (Doze-deferred
          // display, a wake drawn before the cancel landed).
          try {
            const notif = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
            void notif.dismissCallNotif(data.callId).catch(() => { /* best-effort */ });
          } catch { /* notif module unavailable */ }
          return;
        }
      } catch { /* guard modules unavailable — ring normally */ }
      // Resolve the CANONICAL conversation for this peer (the server-UUID row if one already
      // exists) instead of a fresh `direct:<peer>` synthetic — otherwise every inbound call spawns
      // a DUPLICATE thread next to the real chat (named with the raw user-id hex) and the call
      // record lands in the duplicate. Mirrors the message send/receive resolver paths.
      const store = useMessengerStore.getState();
      const conversationId = resolveDirectConversationIdFromState(store, data.from.userId);
      // Prefer the real chat name for the CallKit / lock-screen label; B-226 —
      // fall back to the session directory name (populated from /conversations/mine)
      // and the peer phone before the raw-id code, and fire a backfill so a later
      // resolution can title a subsequent call. Code only for a truly-unknown peer.
      const dirName = store.directoryNames[data.from.userId];
      const peerPhone = store.conversations[conversationId]?.phoneE164
        ?? Object.values(store.conversations).find(c => c.type === 'direct' && c.peer?.userId === data.from.userId)?.phoneE164;
      if (!store.conversations[conversationId]?.name && !dirName && !peerPhone) {
        try {
          const {ensureDirectoryNames} = require('@/modules/messenger/contacts/directoryNames') as typeof import('@/modules/messenger/contacts/directoryNames');
          ensureDirectoryNames([data.from.userId]);
        } catch { /* offline — code fallback below */ }
      }
      const callerName = store.conversations[conversationId]?.name
        ?? dirName
        ?? peerPhone
        ?? data.from.userId.slice(0, 8);
      // EDGE CASE: user is mid group call when a 1:1 offer lands.
      // WhatsApp-style: instead of yanking them away from the group
      // call (which would tear it down without consent), publish to
      // the in-call banner registry so GroupCallScreen can render an
      // accept/decline overlay. Accept hangs up the group call THEN
      // navigates to CallScreen; decline sends call.hangup so the
      // offerer doesn't keep ringing forever. Without this branch
      // the receiver's app silently switches surfaces and the group
      // call's leave path never runs — peers see the receiver as a
      // black tile that won't go away.

      const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
      // WI-1.6 — an `ending` group call is not a surface to show a waiting
      // banner over; let the offer take the normal ring path.
      const liveGroupForBanner = groupReg.getActiveGroupCall();
      if (liveGroupForBanner && !liveGroupForBanner.ending) {

        const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof import('@/modules/messenger/webrtc/incomingOneToOneBanner');
        // Hangup any older banner before replacing — only the latest
        // ring is shown, mirroring WhatsApp.
        const prev = banner.getPendingOneToOne();
        if (prev && prev.callId !== data.callId) {
          try {

            const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
            const tx = reg.getLiveTransport();
            tx?.send({event: 'call.hangup', data: {callId: prev.callId, to: prev.from, reason: 'busy'}} as never);
          } catch { /* fire-and-forget */ }
        }
        banner.setPendingOneToOne(data);
        return;
      }

      // B-238-CW — a SECOND inbound 1:1 while already on a 1:1 call. The old
      // CALL-N10 behaviour auto-busied it, because navigating to CallScreen
      // re-keyed useCall's boot deps → its cleanup ran controller.hangup('ended')
      // and tore down the LIVE call with NO choice offered. Now route it through
      // the SAME non-destructive banner the group branch uses: CallScreen renders
      // an Accept/Decline overlay over the live call. Accept = endActiveCall(current)
      // then join the new one; Decline = call.hangup{declined} + stay on the current
      // call. Only the latest ring shows — an older pending banner is busied first
      // (WhatsApp parity, mirrors the group branch above).
      {
        const callReg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
        const liveCall = callReg.getActiveCall();
        // Why: B-322 — during an OUTGOING call's boot window (TURN fetch +
        // getUserMedia, up to ~6 s) the registry is still empty, so the
        // registry-only check fell through to navigate() below and RN6
        // param-replace re-keyed the mounted CallScreen's useCall boot: the
        // outgoing attempt silently died, no bubble, callee never rung. The
        // mounted-route check is the same belt the group-ring park wears.
        // Same-callId falls through ON PURPOSE — that is the B-102 A1 offer
        // replay for the call being answered; navigate() must re-assert.
        const curRoute = navigationRef.getCurrentRoute();
        const curRouteCallId = (curRoute?.params as {callId?: string} | undefined)?.callId;
        const bootingOtherCall =
          (curRoute?.name === 'CallScreen' || curRoute?.name === 'VoiceCall') &&
          curRouteCallId !== data.callId;
        if ((liveCall && liveCall.callId !== data.callId) || bootingOtherCall) {
          const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof import('@/modules/messenger/webrtc/incomingOneToOneBanner');
          const prev = banner.getPendingOneToOne();
          if (prev && prev.callId !== data.callId) {
            try {
              const reg = require('@/modules/messenger/runtime/transportRegistry') as typeof import('@/modules/messenger/runtime/transportRegistry');
              const tx = reg.getLiveTransport();
              tx?.send({event: 'call.hangup', data: {callId: prev.callId, to: prev.from, reason: 'busy'}} as never);
            } catch { /* fire-and-forget */ }
          }
          banner.setPendingOneToOne(data);
          return;
        }
      }

      // W4.2 — only a ring that will actually present full-screen reaches
      // here (both busy branches above return). Raising Telecom BEFORE those
      // branches gave a busy device a second system call UI over its live
      // call, so the system surface + lock-screen cache move below them; the
      // in-call banners own the busy presentation. iOS stays skeleton-inert
      // until the VoIP cert lands; Android de-dupes by callId.
      // WI-2.5(b) — an offer-replay RE-ASSERT skips the whole presentation
      // block. The ring surfaces are already up (or already answered); raising
      // Telecom again for a uuid that has a live connection orphans it, and
      // re-seeding the cache is pointless work on a call we are answering.
      // The re-assert wants exactly one thing: the navigate below, carrying
      // autoAccept.
      if (!opts?.reassert) {
      try {
        const {reportIncomingCall} = require('@/modules/messenger/push/callKitBridge') as typeof import('@/modules/messenger/push/callKitBridge');
        const cache = require('@/modules/messenger/push/incomingCallCache') as typeof import('@/modules/messenger/push/incomingCallCache');
        cache.setIncomingCallPayload({
          callId:         data.callId,
          callerName,
          kind:           data.kind === 'video' ? 'video' : 'voice',
          fromUserId:     data.from.userId,
          remoteDeviceId: data.from.deviceId,
          incomingSdp:    data.sdp,
          conversationId,
        });
        reportIncomingCall({
          callId:     data.callId,
          callerName,
          kind:       data.kind === 'video' ? 'video' : 'voice',
        });
        // WI-4.9 — the WS lane presents in-app (no card), so it retires the
        // caller's stale "Missed call" banner here rather than through the
        // showIncomingCallNotif funnel the card lanes share.
        const {dismissMissedCallNotifs} = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
        void dismissMissedCallNotifs({fromUserId: data.from.userId, conversationId});
      } catch (e) { console.warn('[MainNavigator] callkit + cache failed:', (e as Error).message); }
      }

      // Auto-create a row ONLY for a genuinely-new contact — i.e. the resolver returned a
      // synthetic `direct:<peer>` key AND no row exists yet. If an existing UUID (or synthetic)
      // row was resolved above, we reuse it and NEVER spawn a duplicate. A cold contact still
      // needs a row so the call-record bubble has somewhere to land.
      if (conversationId.startsWith('direct:') && !store.conversations[conversationId]) {
        // B-134 — mint through the SHARED placeholder so the name is
        // backfillable. This used to hand-roll `userId.slice(0, 8)`, which
        // looks equivalent but is not: `useRegisteredNames` treats ONLY the
        // `Bravo · ` prefix as "still a placeholder, safe to overwrite", so a
        // row created here kept a raw hex label forever even after contact
        // discovery learned the person's real name.
        store.upsertConversation(directPlaceholderConversation(
          conversationId,
          data.from.userId,
          {userId: data.from.userId, deviceId: data.from.deviceId},
          new Date().toISOString(),
        ));
      }

      // Cast through `as unknown as never` because navigationRef.navigate
      // has a deeply nested type union for nested-stack params and TS5's
      // tuple narrowing can't satisfy both overloads at once. The single-
      // `as never` cast resolved to the [never, never] overload, which
      // then rejected the params object. Two-step cast bypasses that.
      // B-102 A1 — RN6 navigate() REPLACES params on an already-mounted
      // CallScreen. When the user already tapped Answer on the notification
      // (killed-app flow: the tap navigates first, this offer replay lands
      // second), losing that flag re-showed the ring screen AFTER the user
      // answered. Re-assert it from the push layer's explicit-accept latch.
      let wasExplicitlyAccepted = false;
      try {
        const fb = require('@/modules/messenger/push/fcmBootstrap') as typeof import('@/modules/messenger/push/fcmBootstrap');
        wasExplicitlyAccepted = fb.wasCallExplicitlyAccepted(data.callId);
      } catch { /* push layer not booted — cold WS-only path */ }
      // Ops-Room call fix (2026-08-09) — the shell-aware resolver, NOT a
      // hard-coded Main→MessengerTab path: that path exists only in the
      // client shell, so a foregrounded CPO/agency user's WS-delivered offer
      // navigated nowhere (RN6 drops unresolvable navigates silently) and
      // the FCM rescue copy was dedup-suppressed — zero paths to the ring
      // UI. Same class the push lanes fixed in B-257/B-258. DELIBERATELY no
      // opts argument (B-319): a cold ring must be the stack's only route.
      // B-460 — the resolver returns FALSE when React Navigation silently
      // drops an unresolvable nested navigate (the product-gate / product-switch
      // hold windows). This call site discarded it; the WI-2.5(b) re-assert
      // needs it, because latching a callId whose navigate never landed
      // swallows the reconnect replay that would have rescued the call.
      return navigateToMessengerScreen(navigationRef as never, 'CallScreen', {
        callType:       data.kind,
        isIncoming:     true,
        conversationId,
        callId:         data.callId,
        remoteUserId:   data.from.userId,
        remoteDeviceId: data.from.deviceId,
        incomingSdp:    data.sdp,
        ...(wasExplicitlyAccepted ? {autoAccept: true} : {}),
      });
    });
    return () => setIncomingCallHandler(null);
  }, [user?.id]);

  // Audit S7 — install the caller-identity verifier for inbound 1:1
  // call.offer frames. Runs alongside setIncomingCallHandler; the
  // dispatcher invokes the verifier BEFORE the handler so a spoofed
  // offer never reaches the navigation root. Verifier is async so we
  // import lazily — the @bravo/messenger-core helper itself is sync to
  // import but pulling it at module top-level creates a circular load
  // with the messenger runtime on cold start.
  useEffect(() => {
    if (!user?.id) {return;}
    const selfUserId   = user.id;
    const selfDeviceId = 1; // Phase-1 single-device, mirrors signalDeviceId default
    setCallOfferVerifier(async (offer) => {
      // Audit Round-2 P0-C1 — fail-CLOSED on missing auth. A compromised
      // gateway (or any insider with WS access) could otherwise mint a
      // call.offer attributing it to any user, ring the callee's screen
      // with a spoofed identity, and — on accept — establish DTLS-SRTP
      // to the attacker. The signed `auth` block (XEd25519 sender cert
      // + AAD over callId/from/to/kind/ts) is the only end-to-end check
      // that the offer actually came from the named caller. Emergency
      // rollback for a legacy client surfacing in the wild:
      //   EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER=true
      // Default is reject so the policy is safe even if the env is
      // never set.
      if (!offer.auth) {
        const legacyOk = (process.env.EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER ?? '') === 'true';
        if (legacyOk) {
          console.warn(`[bravo.callDispatcher] inbound call.offer carries no auth block (cid=${offer.callId.slice(0, 8)} from=${offer.from.userId.slice(0, 8)}) — accepting under EXPO_PUBLIC_ALLOW_UNSIGNED_CALL_OFFER legacy flag`);
          return {ok: true};
        }
        return {ok: false, reason: 'missing_auth'};
      }
      try {
        const {verifyCallOfferAuth} = require('@bravo/messenger-core') as typeof import('@bravo/messenger-core');
        const result = await verifyCallOfferAuth({
          auth: offer.auth,
          wire: {callId: offer.callId, from: offer.from, kind: offer.kind},
          self: {userId: selfUserId, deviceId: selfDeviceId},
          authorityPubKeyB64: SENDER_CERT_PUBLIC_KEY_B64,
        });
        return result.ok ? {ok: true} : {ok: false, reason: result.reason};
      } catch (e) {
        return {ok: false, reason: `verifier_threw:${(e as Error).message}`};
      }
    });
    return () => setCallOfferVerifier(null);
  }, [user?.id]);

  // Group-call ring handler. Server fans `sfu.ring.incoming` to every
  // recipient's userRoom when one member taps the phone icon. We wake
  // the IncomingGroupCallScreen so it can play the ringtone + show
  // accept/decline. Cancel/decline frames are handled by the screen
  // itself (it registers its own handler in the same multi-subscriber
  // dispatcher).
  useEffect(() => {
    if (!user?.id) {return;}
    const unsub = setGroupCallRingHandler({
      onIncoming: (ring) => {
        if (!navigationRef.isReady()) {return;}
        // [CALLLAT] — invitee lane origin: the ring reached this device.
        const latDiag = require('@/modules/messenger/runtime/callDiag') as typeof import('@/modules/messenger/runtime/callDiag');
        latDiag.logCallLat('grp-join', ring.conversationId, 'ring:received', {room: latDiag.shortCallId(ring.roomId), replayed: !!ring.replayed}, {freshAfterMs: 90_000});
        // Audit Step 2.1 — warm TURN while the group ring shows (the join awaits it).
        try {
          const {prewarmIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
          prewarmIceServers();
        } catch { /* prewarm never blocks a ring */ }
        // B-107 — no group ring DURING a backup restore: handleRestore
        // disposes and rebuilds the live runtime mid-flow, so joining would
        // strand the signalling (the B-64 zombie-session class).
        try {
          const {isRestoreModeActive} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
          if (isRestoreModeActive()) {
            // B-479 — PARK it rather than dropping it on the floor.
            //
            // Dropping relied on the server's reconnect replay to bring the
            // ring back, and that replay is ONE-SHOT and destructive: the
            // gateway clears the pending-ring artifacts as soon as it emits
            // them. The restore flow connects a socket while this very flag is
            // still armed, so the single replay could be consumed here and
            // discarded before the restore finished — the ring gone with no
            // ring, no missed-call record, and nothing left to replay.
            //
            // Parked, it has an owner and a 45 s expiry that writes the
            // missed-call bubble, and the restore-exit subscription below
            // re-presents it if the restore finishes in time. Reporting TRUE
            // is the same contract the 1:1-busy park site uses: parked counts
            // as presented, so a replay must not stack a second copy.
            const {parkGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
            parkGroupRing(ring);
            console.warn('[CALLDIAG] [ring.route] PARKED behind restore room=', ring.roomId.slice(0, 8));
            return true;
          }
        } catch { /* flag module unavailable — ring normally */ }
        const route = navigationRef.getCurrentRoute();
        // B-306 — a group ring must NOT be navigated over a live 1:1.
        // CallScreen's ended auto-dismiss is a delayed goBack that pops
        // whatever is on top, so a ring screen pushed here loses a race the
        // dedup then makes unrecoverable (device-proven: escalation's ring
        // lands the same instant the 1:1 dies — no ringtone, no answer
        // button, frozen call screen). Park it; CallScreen consumes it at
        // its OWN dismissal moment — one navigation actor, no race.
        //
        // Two busy signals, both needed: the registry call (live 1:1), and
        // the mounted route ('CallScreen' / 'VoiceCall' in both stacks) —
        // because mid-teardown the registry is ALREADY null while the
        // screen and its pending goBack still exist, which is exactly the
        // race window from the device log.
        try {
          const callReg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
          const live1to1 = callReg.getActiveCall();
          const busy1to1 =
            (live1to1 && live1to1.state !== 'ended' && live1to1.state !== 'failed') ||
            route?.name === 'CallScreen' || route?.name === 'VoiceCall';
          if (busy1to1) {
            const {parkGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
            parkGroupRing(ring);
            console.warn('[CALLDIAG] [ring.route] PARKED behind 1:1 room=', ring.roomId.slice(0, 8), 'route=', route?.name);
            // Why: B-321 — the ONLY consume site was CallScreen's dismissal,
            // which a MINIMIZED 1:1 never reaches: the parked ring silently
            // died at its 45 s TTL (no ringtone, no missed-call record).
            // Fallback: when the 1:1 leaves the registry, consume from here.
            // consumePendingGroupRing is one-shot, so this and the CallScreen
            // path can never both fire; the route guard + retry ladder keep
            // us out of the mid-teardown goBack race the park exists for.
            const attemptConsume = (attempt: number): void => {
              if (attempt > 5) {return;}
              setTimeout(() => {
                try {
                  const r = navigationRef.getCurrentRoute();
                  if (r?.name === 'CallScreen' || r?.name === 'VoiceCall') {
                    attemptConsume(attempt + 1);
                    return;
                  }
                  const {consumePendingGroupRing, reparkGroupRing: repark} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
                  const parked = consumePendingGroupRing();
                  if (!parked) {return;}
                  console.warn('[CALLDIAG] [ring.handoff] registry-null fallback consuming parked ring room=', parked.roomId.slice(0, 8));
                  // Ops-Room call fix (2026-08-09) — shell-aware resolver; the
                  // hard-coded MessengerTab path dropped silently on CPO/agency
                  // shells. No opts (B-319 flaglessness preserved).
                  const landed = navigateToMessengerScreen(navigationRef as never, 'IncomingGroupCallScreen', {
                    roomId:         parked.roomId,
                    conversationId: parked.conversationId,
                    callType:       parked.callType,
                    callerName:     parked.callerName,
                    fromUserId:     parked.from.userId,
                    roomToken:      parked.roomToken,
                    // WI-6.7 — the ring's own fan-out id, for cancel matching.
                    ringId:         parked.ringId,
                    // WI-4.6 — same latch re-assert as the primary site: the
                    // user may have answered from the notification while this
                    // ring sat parked behind the 1:1.
                    ...(groupRingExplicitlyAccepted(parked.roomId) ? {autoAccept: true} : {}),
                  });
                  // B-478 — the consume above is DESTRUCTIVE: it clears the
                  // park AND cancels its 45 s expiry. Discarding the navigate
                  // result therefore lost the ring outright when the resolver
                  // refused (no navigator, not ready, a throw) — not parked,
                  // not presented, and already dedup-marked by the park site's
                  // own `return true`, so no missed-call record either.
                  // Re-park so the ring keeps an owner and its expiry bubble,
                  // and let the ladder try again.
                  if (!landed) {
                    console.warn('[CALLDIAG] [ring.handoff] navigate refused — re-parking room=', parked.roomId.slice(0, 8));
                    repark(parked);
                    attemptConsume(attempt + 1);
                  }
                } catch { /* parked ring stays; the TTL bounds it */ }
              }, attempt === 1 ? 400 : 800);
            };
            try {
              // onActiveCallChange fires synchronously on register (current
              // state) — in the route-only busy window the registry is
              // ALREADY null, so the unsubscribe handle may not exist yet
              // inside the callback. The flag + post-assign unsubscribe
              // covers that first fire.
              let offActive: (() => void) | null = null;
              let fired = false;
              offActive = callReg.onActiveCallChange((call) => {
                if (call !== null || fired) {return;}
                fired = true;
                offActive?.();
                attemptConsume(1);
              });
              if (fired) {offActive();}
            } catch { /* subscription unavailable — CallScreen path still consumes */ }
            // WI-3.6 — PARKED counts as presented: the ring now has an
            // owner and a 45 s expiry that writes a missed-call bubble, so a
            // replay must not stack a second copy on top of it.
            //
            // KNOWN GAP (logged, not fixed here): the consume ladder above
            // takes the park destructively and then discards its own navigate
            // result, so a shell whose nested navigate is dropped loses the
            // ring with no missed-call record — while this `true` has already
            // burned the marker. Fixing that means reworking the ladder, which
            // is outside this work item.
            return true;
          }
        } catch { /* registry unavailable — ring normally */ }
        // B-08 — suppress duplicate rings (server re-fan-out, the host's
        // own ring echoing back, or a presence/ring race) that would
        // navigate over an in-progress GroupCallScreen and abort its join.
        const groupReg = require('@/modules/messenger/runtime/groupCallRegistry') as typeof import('@/modules/messenger/runtime/groupCallRegistry');
        const active = groupReg.getActiveGroupCall();
        const routeRoomId = (route?.params as {roomId?: string} | undefined)?.roomId;
        // WI-1.6 — a call marked `ending` is NOT an in-progress join, so it must
        // not suppress a ring. The slot used to be nulled before the leave was
        // awaited, so this read was null for free; keeping the entry alive would
        // otherwise swallow a genuine re-ring for up to the 3 s leave window.
        const suppressRoomId = active && !active.ending ? active.roomId : null;
        if (!groupReg.shouldNavigateForRing(ring.roomId, suppressRoomId, route?.name, routeRoomId)) {
          console.warn('[CALLDIAG] [ring.route] suppressed room=', ring.roomId.slice(0, 8), 'route=', route?.name);
          return;
        }
        console.warn('[CALLDIAG] [ring.route] navigating room=', ring.roomId.slice(0, 8));
        // WI-4.9 — same as the 1:1 WS site: an in-app group ring supersedes
        // that thread's "Missed call" banner. Best-effort, never blocks.
        try {
          const {dismissMissedCallNotifs} = require('@/modules/messenger/push/callNotification') as typeof import('@/modules/messenger/push/callNotification');
          void dismissMissedCallNotifs({fromUserId: ring.from.userId, conversationId: ring.conversationId});
        } catch { /* notifee unavailable */ }
        // Ops-Room call fix (2026-08-09) — THE bug behind "mission group
        // calls don't work": this WS ring handler runs for EVERY shell, but
        // the old hard-coded Main→MessengerTab path exists only in the
        // client shell — a foregrounded CPO or agency manager's ring
        // navigated nowhere (RN6 drops it silently) while the FCM rescue
        // copy was dedup-suppressed. The shell-aware resolver is the same
        // one every push lane uses (B-257/B-258). DELIBERATELY no opts
        // argument (B-319): a cold ring must be the stack's only route.
        // WI-3.6 — report whether the navigate was accepted, so the
        // dispatcher only burns the ring's dedup marker when it was.
        //
        // Scope, honestly: the resolver returns false for a missing/not-ready
        // navigator and for a throwing `navigate()`, and true otherwise. It
        // CANNOT see RN6 silently dropping an unresolvable NESTED navigate —
        // the Ops-Room shell bug named just above — because that does not
        // throw. So this closes the cold-boot and hard-failure lanes, not that
        // one. Do not read it as covering the shell case.
        // WI-4.6 — the group mirror of B-102 A1: RN6 navigate() REPLACES
        // params, so a WS ring frame landing AFTER the notification Answer
        // (which navigated with autoAccept) would un-answer the call.
        // Re-assert from the explicit-accept latch (keyed by roomId — the
        // gateway reuses it as the callId). Three things keep a stale latch
        // from auto-joining a FUTURE ring of the same room:
        // endActiveGroupCall clears it, EVERY non-accept exit of the ring
        // screen clears it (IncomingGroupCallScreen.dismissRing — decline,
        // host cancel, roomMissing, timeout), and the latch itself is a
        // timestamped map scrubbed at 5 minutes.
        return navigateToMessengerScreen(navigationRef as never, 'IncomingGroupCallScreen', {
          roomId:         ring.roomId,
          conversationId: ring.conversationId,
          callType:       ring.callType,
          callerName:     ring.callerName,
          fromUserId:     ring.from.userId,
          // Audit row #5 — thread the per-recipient room-token
          // through ring → IncomingGroupCallScreen → GroupCall-
          // Screen → sfu.join. Server requires this echo when
          // SFU_ROOM_TOKEN_SECRET is configured.
          roomToken:      ring.roomToken,
          // WI-6.7 — the ring's own fan-out id, for cancel matching.
          ringId:         ring.ringId,
          ...(groupRingExplicitlyAccepted(ring.roomId) ? {autoAccept: true} : {}),
        });
      },
      onCancel: (data) => {
        // IncomingGroupCallScreen handles its own on-screen cancel. This
        // clears the B-306 PARKED copy: a ring the host withdrew while the
        // user was still on the 1:1 must never be consumed later.
        try {
          const {clearPendingGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
          // WI-6.7 — scope the clear to the cancelled fan-out: a parked NEWER
          // ring for the same room survives a stale cancel.
          clearPendingGroupRing(data.roomId, data.ringId);
        } catch { /* ignore */ }
      },
      onDecline: () => { /* IncomingGroupCallScreen handles its own decline */ },
    });
    return unsub;
  }, [user?.id]);

  /**
   * B-479 — re-present a group ring that was parked because a backup restore
   * was running.
   *
   * The suppressing branch above parks rather than drops, but nothing used to
   * watch the flag: every consumer POLLED it at decision time, so anything it
   * caused to be dropped had no way back. This is the missing edge — when the
   * restore ends, whatever it silenced gets its chance.
   *
   * If the park has already expired (a restore longer than the 45 s TTL, which
   * is the common case) `consumePendingGroupRing` returns null and the expiry
   * has already written the missed-call bubble AND re-armed the room's dedup
   * marker (B-481), so a later copy of the ring can still ring.
   */
  useEffect(() => {
    if (!user?.id) {return;}
    let unsubRestore: (() => void) | null = null;
    try {
      const {subscribeRestoreMode} = require('@/modules/messenger/backup/restoreMode') as typeof import('@/modules/messenger/backup/restoreMode');
      unsubRestore = subscribeRestoreMode((active) => {
        if (active) {return;}
        // Deferred a tick ON PURPOSE. The flag is cleared from
        // `BackupRestoreScreen`'s unmount cleanup, so this callback runs inside
        // React's commit while that screen is being torn down and its own exit
        // navigation is in flight. Pushing a ring screen into that window is
        // exactly the mid-teardown race the parked-ring mailbox exists for —
        // the same reason CallScreen's consume waits for its pop to settle.
        setTimeout(() => {
        // Held outside the try so the catch can put it BACK. The consume is
        // destructive, so a throw past it would otherwise lose the ring —
        // there is no park left to bound it.
        let taken: import('@/modules/messenger/webrtc/groupCallRingDispatcher').GroupCallRingPayload | null = null;
        try {
          if (!navigationRef.isReady()) {return;}
          // A restore can end while a 1:1 call is live — the restore branch is
          // the FIRST test in onIncoming, so a ring arriving during a restore
          // parks under it and the 1:1 ladder is never armed. Presenting here
          // without the busy test would push the ring screen on top of a live
          // CallScreen, whose ended auto-dismiss is a delayed goBack that pops
          // whatever is on top — the ring is popped ~50 ms later, already
          // consumed, its expiry cancelled and its room dedup-marked. That is
          // B-306 exactly, which is why both sibling consume sites carry this
          // test. Leave it parked; the ladder or CallScreen's dismissal owns it.
          const route = navigationRef.getCurrentRoute();
          if (route?.name === 'CallScreen' || route?.name === 'VoiceCall') {return;}
          try {
            const callReg = require('@/modules/messenger/runtime/callRegistry') as typeof import('@/modules/messenger/runtime/callRegistry');
            const live1to1 = callReg.getActiveCall();
            if (live1to1 && live1to1.state !== 'ended' && live1to1.state !== 'failed') {return;}
          } catch { /* registry unavailable — the route test above still guards */ }
          const {consumePendingGroupRing, reparkGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
          const parked = consumePendingGroupRing();
          if (!parked) {return;}
          taken = parked;
          console.warn('[CALLDIAG] [ring.handoff] restore ended — presenting parked ring room=', parked.roomId.slice(0, 8));
          const landed = navigateToMessengerScreen(navigationRef as never, 'IncomingGroupCallScreen', {
            roomId:         parked.roomId,
            conversationId: parked.conversationId,
            callType:       parked.callType,
            callerName:     parked.callerName,
            fromUserId:     parked.from.userId,
            roomToken:      parked.roomToken,
            // WI-6.7 — the ring's own fan-out id, for cancel matching.
            ringId:         parked.ringId,
            // WI-4.6 — the latch re-assert, third site: an Answer pressed
            // while the ring waited out the restore must still auto-join.
            ...(groupRingExplicitlyAccepted(parked.roomId) ? {autoAccept: true} : {}),
          });
          // Same B-478 discipline as the 1:1 ladder: the consume is
          // destructive, so a refused navigate must give the ring back rather
          // than drop it.
          if (!landed) {
            console.warn('[CALLDIAG] [ring.handoff] restore-exit navigate refused — re-parking room=', parked.roomId.slice(0, 8));
            reparkGroupRing(parked);
            taken = null;
          }
        } catch {
          if (taken) {
            try {
              const {reparkGroupRing} = require('@/modules/messenger/webrtc/pendingGroupRing') as typeof import('@/modules/messenger/webrtc/pendingGroupRing');
              reparkGroupRing(taken);
            } catch { /* nothing more we can do */ }
          }
        }
        }, 0);
      });
    } catch { /* flag module unavailable — nothing to watch */ }
    return () => { unsubRestore?.(); };
  }, [user?.id]);

  // §35A §B — mount exactly one shell by account_kind.
  //   access-ended → a suspended/removed CPO (covers boot/login as already-revoked).
  //   cpo-activation → first login, set password before the home.
  //   cpo → the managed-guard shell (CpoNavigator).
  //   agency → the 9-screen Agent Portal (AgentNavigator) — also the legacy/pendingProvider fallback.
  //   client → the consumer tabs below.
  if (authedRoute === 'access-ended') {
    return <AccessEndedScreen />;
  }
  if (authedRoute === 'cpo-activation') {
    return <CpoActivationScreen />;
  }
  if (authedRoute === 'cpo-onboarding') {
    return <CpoOnboardingNavigator />;
  }
  if (authedRoute === 'cpo') {
    const CpoShell = getCpoNavigator();
    return <CpoShell />;
  }
  if (authedRoute === 'agency') {
    const AgentShell = getAgentNavigator();
    return <AgentShell />;
  }

  // M1A rule 5 — the end-of-signup subscription ask. Shown once, before the
  // shell, when a paid tier was picked pre-auth and the account is still
  // effectively Lite (an already-paid account skips straight through).
  // Declining is first-class: "Start as Lite today" lands a working Lite
  // account; tier changes live in Settings → Pricing thereafter.
  if (pendingPaidTier === 'unknown') {
    return <View style={{flex: 1, backgroundColor: HOME_BG}} />;
  }
  if (pendingPaidTier) {
    return <TierPaywall tier={pendingPaidTier} standalone onDone={resolvePaywall} />;
  }

  // B-91 M0 — client accounts live inside ONE standalone product at a time.
  // No persisted product yet (fresh installs + every pre-split account) →
  // the product gate. There is no combined home to fall back to. B-95 also
  // re-opens the gate on demand (drawer "Choose dashboard" / back at a
  // product root) — unmounting the tab tree here is what lets its nested
  // navigation state clear before the next product mounts.
  if (!activeProduct || gateVisible) {
    return <ProductGateScreen />;
  }

  // B-95 — one navigator-free frame per product switch so the previous
  // product's nested state finishes cleaning up (see effect above).
  if (mountedProduct !== activeProduct) {
    return <View style={{flex: 1, backgroundColor: HOME_BG}} />;
  }

  return (
    <Tab.Navigator
      // Why: keying by product remounts the whole tab tree on a product
      // switch — the old product's navigation stacks die with it, which IS
      // the spec's back-stack-reset rule (no reset() bookkeeping to drift).
      key={activeProduct}
      initialRouteName={activeProduct === 'messenger' ? 'MessengerTab' : 'SecureTab'}
      tabBar={renderCustomTabBar}
      // Scene background = obsidian so the Command Home status-bar / safe-
      // area zone reads near-black instead of the default navy stage. Other
      // tabs paint their own background on top, so this only shows through
      // on Home (which is intentionally #07090D).
      sceneContainerStyle={{backgroundColor: HOME_BG}}
      // BS-TABBACK — back from a non-Home tab (e.g. Messenger) returns to
      // the previously-focused tab instead of EXITING the app. Default
      // bottom-tab back behaviour let a back-swipe out of Messenger close
      // the app entirely. `history` walks the tab-focus history back to
      // Dashboard/Home, matching WhatsApp/standard Android expectations.
      backBehavior="history"
      screenOptions={{headerShown: false}}>
      {/* B-91 M0 — the combined command home (Dashboard) is no longer a
          route: the spec deletes it. Its SOS duty lives on in the VBG
          hold-to-alert; the screen file stays in-tree pending INDEX Q8. */}
      <Tab.Screen name="MessengerTab" component={MessengerNavigator} options={{tabBarLabel: 'Messenger', tabBarStyle: {display: 'none'}}} />
      <Tab.Screen
        name="SecureTab"
        component={BookingNavigator}
        // Each product opens on ITS OWN root:
        //   vbg    → VBG dashboard
        //   secure → SecureLanding (the tier resolver: PRO retainer clients land
        //            on ProDashboard, LITE clients on the Book-Now home; PDF-1 #1)
        //
        // Secure used to land on the "Secure Plans" chooser (B-390/B-393). The
        // founder change moves the landing to the tier the client actually holds
        // and demotes the chooser to a card on BookingHome. The tier
        // (`application?.status === 'ACTIVE'`) is loaded lazily, so a small
        // resolver screen reads it and replaces itself with the right root
        // rather than flashing the Lite home before a Pro dashboard —
        // src/screens/securepro/SecureLandingScreen.tsx.
        //
        // `initial: false` so BookingHome stays beneath SecureLanding in the
        // stack (the resolver pops onto it for Lite, and it is the Pro back
        // target) and the back gesture still works — see
        // src/navigation/__tests__/nestedNavigationInitialFlag.test.ts, which
        // enforces this for every nested navigate into a lazy stack.
        initialParams={
          activeProduct === 'vbg'    ? {screen: 'VBGHome'}
          : activeProduct === 'secure' ? {screen: 'SecureLanding', initial: false}
          : undefined
        }
        options={({route}) => {
          /**
           * B-657 — `getFocusedRouteNameFromRoute` returns UNDEFINED until this
           * stack has committed a navigation state, i.e. on the very first
           * render after the tab is entered. Falling back to `''` there made
           * the root bar show for that frame even though the stack is about to
           * land on `SecureLanding` — the first half of the double-bar flicker.
           *
           * So the fallback is the route this tab is SEEDED with
           * (`initialParams.screen`), which is what will be focused a moment
           * later. Same answer, one frame earlier.
           */
          const seeded = (route.params as {screen?: string} | undefined)?.screen;
          const nested = getFocusedRouteNameFromRoute(route) ?? seeded ?? '';
          return {
            tabBarLabel: 'Secure',
            // VBG screens go fullscreen, and the Wave 5d Secure shell renders its
            // own footer — hide the root tab bar for both so nothing draws two.
            tabBarStyle: VBG_FULLSCREEN_ROUTES.has(nested) || SECURE_FULLSCREEN_ROUTES.has(nested)
              ? {display: 'none'}
              : undefined,
          };
        }}
        listeners={({navigation: nav}) => ({
          // Land on the product's root when re-entered via the bar — must match
          // `initialParams` above, or the tab bar and the drawer switch would
          // disagree about where the secure product lands.
          tabPress: e => {
            e.preventDefault();
            nav.navigate('SecureTab',
              activeProduct === 'vbg'
                ? {screen: 'VBGHome'}
                : {screen: 'SecureLanding', initial: false},
            );
          },
        })}
      />
      <Tab.Screen name="ProfileTab"   component={ProfileScreen}      options={{tabBarLabel: 'Profile'}} />
    </Tab.Navigator>
  );
}

// Hoisted out of MainNavigator so React doesn't see a fresh component
// type on every parent render (which would unmount/remount the entire
// tab bar subtree and lose its animation/state).
function renderCustomTabBar(props: React.ComponentProps<typeof CustomTabBar>): React.ReactElement {
  return <CustomTabBar {...props} />;
}

const s = StyleSheet.create({
  bar: {
    backgroundColor: HOME_BG,
    paddingTop: 14,
    ...Platform.select({
      ios: {
        shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 18,
        shadowOffset: {width: 0, height: -6},
      },
      android: {elevation: 20},
    }),
  },
  // Thin top-edge hairline — fades at the edges like the design atom.
  hairline: {
    height: 1, marginHorizontal: 20, marginBottom: 14,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  row: {
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 8,
  },
  item: {
    flex: 1, alignItems: 'center', justifyContent: 'flex-start',
    paddingVertical: 2,
    position: 'relative',
  },
  // Blue glowing indicator pip above the icon — only shown on active.
  activeIndicator: {
    position: 'absolute', top: -14, width: 26, height: 2.5, borderRadius: 2,
    backgroundColor: FOOTER_ACCENT,
    shadowColor: FOOTER_ACCENT, shadowOpacity: 1, shadowRadius: 12, shadowOffset: {width: 0, height: 0}, elevation: 6,
  },
  iconWrap: {
    width: 28, height: 28,
    alignItems: 'center', justifyContent: 'center',
    marginBottom: 5,
  },
  iconWrapActive: {},  // (legacy — kept for any outside refs, no effect)
  label: {
    fontFamily: BravoFont.sans,
    fontSize: 10, fontWeight: '600', letterSpacing: 0.4,
    textTransform: 'uppercase', textAlign: 'center',
    color: FOOTER_MUTE,
  },
  labelActive: {color: FOOTER_TEXT},
  profileAvatar: {
    width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
  },
  profileAvatarActive: {
    backgroundColor: FOOTER_ACCENT_DEEP,
    borderColor: FOOTER_ACCENT,
  },
  profileAvatarFallback: {
    alignItems: 'center', justifyContent: 'center',
  },
  profileAvatarText: {
    fontFamily: BravoFont.sans,
    color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.3,
  },
});
