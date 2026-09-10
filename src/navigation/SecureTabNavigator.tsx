/**
 * SecureTabNavigator (Wave 5d — PDF-2 A7) — the streamlined LITE booking shell:
 * a 4-tab bottom navigator (Home · Book · Summary · Messenger) feeding the shared
 * `ObsidianTabBar`, mounted as the full-screen `SecureShell` route inside
 * `BookingNavigator`. It is the LITE Secure home; a PRO retainer client still
 * lands on ProDashboard (the tier resolver `SecureLandingScreen` decides which).
 *
 * WHY THE TABS ARE LEAVES, NOT PER-TAB STACKS. `BookingNavigator` owns ~55
 * booking routes in ONE flat stack, and every screen + deep link in the app
 * reaches them by `navigate('SecureTab', {screen: '<bookingRoute>'})`. Splitting
 * those routes across four sibling tab stacks would (a) duplicate ~30 screens,
 * (b) break the cross-tab `navigate(...)` resolution React Navigation does not do
 * between sibling tabs, and (c) deepen every external deep link by a level — the
 * highest-risk change on a spine that also carries live calls. So instead each
 * tab is a LEAF landing surface and this shell sits INSIDE BookingNavigator:
 * drilling deeper (a service dashboard, a live mission) bubbles the navigate UP
 * to BookingNavigator, which still resolves it exactly as before. Nothing is
 * duplicated and no external deep link changes — see the report for the full
 * integration rationale.
 *
 *   Home      → BookingHomeScreen   (the Book-Now home, verbatim)
 *   Book      → ServiceTypeScreen   (service chooser → the consolidated dashboard
 *                                     that lives in BookingNavigator)
 *   Summary   → SecureSummaryScreen (the active-booking surface via the shared
 *                                     resumeTargetFor resolver + empty state)
 *   Messenger → EXIT — the tab press is intercepted and hops to the messenger
 *               stack via the shell-aware resolver (mirrors DepartmentalNavigator)
 */
import React from 'react';
import {createBottomTabNavigator, type BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {ObsidianTabBar, type ObsidianTabIcon} from './ObsidianTabBar';
import {navigateToMessengerScreen} from './messengerDeepLink';
import type {SecureShellTabParamList} from './types';

import BookingHomeScreen from '@screens/booking/BookingHomeScreen';
import ServiceTypeScreen from '@screens/booking/ServiceTypeScreen';
import SecureSummaryScreen from '@screens/booking/SecureSummaryScreen';
import ProDashboardScreen from '@screens/pro/ProDashboardScreen';
import {useSecureProStore} from '@store/secureProStore';

/**
 * B-661 — the Home tab IS the tier decision now.
 *
 * `secureRootRoute` used to send an ACTIVE Pro client to `ProDashboard` as a
 * pushed screen OUTSIDE this shell, which is why a PRO account never saw this
 * footer — it kept MainNavigator's root bar instead. Both tiers now root at the
 * shell and the tier is resolved HERE, so a PRO client still lands on their
 * dashboard and gains the footer at the same time.
 *
 * ⚠️ ONE component, chosen at render — NOT two `Tab.Screen`s. A conditional
 * Tab.Screen would change the bar's ITEM COUNT and order by tier, and this
 * navigator's own comment says declaration order is the bar order and is
 * expressed in exactly one place. Two shapes of bar is precisely the drift that
 * comment exists to prevent.
 */
function SecureHomeTab(): React.ReactElement {
  const isProActive = useSecureProStore(s => s.application?.status === 'ACTIVE');
  return isProActive ? <ProDashboardScreen /> : <BookingHomeScreen />;
}

const OB = {
  bg: '#07090D',
  accent: '#5B8DEF',
  mute: 'rgba(180,188,204,0.45)',
  text: '#F2F4F8',
} as const;

// Icon map for the shared ObsidianTabBar — the SAME renderer the root shell,
// CpoNavigator and DepartmentalNavigator use, so this bar is pixel-identical.
// ⚠️ A MISSING KEY IS SILENT: ObsidianTabBar falls back to 'help-circle-outline'
// plus the raw route name, so a forgotten entry ships as a question mark.
// Exported: MainNavigator's root footer renders these SAME four items while a
// deeper LITE booking route is focused (secureFlowTab.ts) — one source, so the
// shell bar and the flow bar cannot drift apart.
export const TAB_ICONS: Record<string, ObsidianTabIcon> = {
  Home:      {default: 'home-outline',           active: 'home',           label: 'Home'},
  Book:      {default: 'shield-plus-outline',     active: 'shield-plus',     label: 'Book'},
  Summary:   {default: 'clipboard-text-outline',  active: 'clipboard-text',  label: 'Summary'},
  Messenger: {default: 'message-text-outline',    active: 'message-text',    label: 'Messenger'},
};

const Tab = createBottomTabNavigator<SecureShellTabParamList>();

/** Never rendered — the Messenger tab press is intercepted before navigation. */
function MessengerTabStub() {
  return null;
}

// Hoisted out of the navigator so React does not see a fresh component type on
// every render (which would unmount/remount the whole tab-bar subtree and lose
// its animation/state) — the same reason MainNavigator hoists its own renderer.
function renderSecureTabBar(props: BottomTabBarProps): React.ReactElement {
  return (
    <ObsidianTabBar
      {...props}
      icons={TAB_ICONS}
      bg={OB.bg}
      accent={OB.accent}
      mute={OB.mute}
      text={OB.text}
    />
  );
}

export default function SecureTabNavigator() {
  return (
    <Tab.Navigator
      sceneContainerStyle={{backgroundColor: OB.bg}}
      screenOptions={{headerShown: false}}
      // Back from a non-Home tab returns to Home rather than the previous tab —
      // matching DepartmentalNavigator. Home's own back then bubbles to
      // BookingNavigator (the shell is its only route after the LITE reset) and,
      // at the product root, to MainNavigator's hardware-back handler.
      backBehavior="firstRoute"
      tabBar={renderSecureTabBar}>
      {/* ⚠️ DECLARATION ORDER IS THE BAR ORDER — the founder's Home · Book ·
          Summary · Messenger is expressed HERE and nowhere else. */}
      {/* B-661 — tier-aware: Pro dashboard for an ACTIVE Pro client, the
          Book-Now home for everyone else. See SecureHomeTab above. */}
      <Tab.Screen name="Home" component={SecureHomeTab} />
      <Tab.Screen name="Book" component={ServiceTypeScreen} />
      <Tab.Screen name="Summary" component={SecureSummaryScreen} />
      {/* Messenger is a way OUT of the Secure shell, not a screen inside it, so
          the tab press is intercepted and never mounts the stub (a Tab.Screen
          still needs a component to exist). The shell-aware resolver knows every
          shell's path to MessengerHome — a bare getParent() hop is silently
          dropped in shells whose root stack has no such route (B-414). */}
      <Tab.Screen
        name="Messenger"
        component={MessengerTabStub}
        listeners={({navigation}) => ({
          tabPress: e => {
            e.preventDefault();
            navigateToMessengerScreen(navigation as never, 'MessengerHome', {}, {initial: false});
          },
        })}
      />
    </Tab.Navigator>
  );
}
