import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import Svg, {Path, Circle} from 'react-native-svg';
import {useNavigation, useRoute} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import type {BookingStackParamList, MainTabParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {VBG} from './vbgUi';

/**
 * VBG bottom nav. VBG screens render fullscreen (the app's root tab bar is
 * hidden for VBG* routes — see MainNavigator VBG_FULLSCREEN_ROUTES), so this
 * is the module's own footer, styled with the obsidian VBG tokens.
 *
 * B-91 M2 R7 — exactly THREE tabs (spec p.21): Home · News Feed · Messenger.
 * Key Points and GeoRisk lost their tabs because both live INSIDE the Home
 * scroll now; their screens remain reachable as Home drill-downs and light
 * the Home tab while open.
 *
 * Active tab is DYNAMIC: by default it's derived from the current route
 * (useRoute → VBG_ROUTE_TO_TAB), so the highlight is always correct on every
 * VBG screen and follows navigation without each screen having to pass a
 * literal. The optional `active` prop is an override for the rare screen that
 * lives off the map (e.g. SRA, a GeoRisk drill-down, indicates 'georisk').
 */
export type VbgTab = 'home' | 'news' | 'messenger';

type Nav = NativeStackNavigationProp<BookingStackParamList> &
  BottomTabNavigationProp<MainTabParamList>;

/**
 * Which footer tab is "current" for a given VBG stack route. Pure data so it
 * can be unit-tested without rendering. Routes not listed (e.g. VBGSRA, a
 * drill-down) have no own tab — callers pass an explicit `active` override.
 */
export const VBG_ROUTE_TO_TAB: Partial<Record<keyof BookingStackParamList, VbgTab>> = {
  VBGHome:    'home',
  VBGMap:     'home',
  VBGNearby:  'home',
  VBGGeoRisk: 'home',
  VBGSRA:     'home',
  VBGOSINT:   'news',
};

/** Resolve the active tab: explicit override wins, else derive from route. */
export function tabForRoute(routeName: string | undefined, override?: VbgTab): VbgTab {
  if (override) {return override;}
  return VBG_ROUTE_TO_TAB[routeName as keyof BookingStackParamList] ?? 'home';
}

/**
 * Navigation target for each tab. Within-stack tabs are a single route name;
 * cross-tab tabs hop to MessengerTab with a nested screen. Pure data so the
 * routing contract is unit-testable.
 */
export type TabTarget =
  | {kind: 'stack'; route: keyof BookingStackParamList}
  | {kind: 'tab'; tab: 'MessengerTab'; screen: 'IntelFeed' | 'MessengerHome' | 'NewsFeed'};

export const TAB_TARGET: Record<VbgTab, TabTarget> = {
  home:      {kind: 'stack', route: 'VBGHome'},
  // Founder 2026-08-01 — News Feed opens the main news DASHBOARD (regions +
  // hero + Bravo Intel entry), replacing the VBG-local OSINT feed as the tab
  // target. VBGOSINT stays reachable as a Home drill-down (VBG_ROUTE_TO_TAB
  // still lights this tab while it is open).
  news:      {kind: 'tab', tab: 'MessengerTab', screen: 'NewsFeed'},
  messenger: {kind: 'tab', tab: 'MessengerTab', screen: 'MessengerHome'},
};

interface TabDef {
  key:   VbgTab;
  label: string;
  icon:  (active: boolean) => React.ReactNode;
}

const stroke = (active: boolean) => (active ? VBG.accent : VBG.textMute);

const TABS: TabDef[] = [
  {
    key: 'home', label: 'Home',
    icon: a => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <Path d="M4 10.5L12 4l8 6.5V20h-5v-6H9v6H4Z" stroke={stroke(a)} strokeWidth={1.7} strokeLinejoin="round" strokeLinecap="round" />
      </Svg>
    ),
  },
  {
    key: 'news', label: 'News Feed',
    icon: a => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        {/* broadcast / signal */}
        <Circle cx={12} cy={12} r={2} fill={stroke(a)} />
        <Path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 16.2a6 6 0 0 0 0-8.4M5 5a9.5 9.5 0 0 0 0 14M19 19a9.5 9.5 0 0 0 0-14" stroke={stroke(a)} strokeWidth={1.6} strokeLinecap="round" fill="none" />
      </Svg>
    ),
  },
  {
    key: 'messenger', label: 'Messenger',
    icon: a => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
        <Path d="M4 5h16v11H8l-4 3V5Z" stroke={stroke(a)} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" fill="none" />
      </Svg>
    ),
  },
];

export function VbgFooter({active: override}: {active?: VbgTab} = {}) {
  const navigation = useNavigation<Nav>();
  const route = useRoute();
  const insets = useSafeAreaInsets();
  // Dynamic: derive from the current route unless an explicit override is set.
  const active = tabForRoute(route?.name, override);

  const go = (tab: VbgTab) => {
    // Why: drill-downs (Nearby/GeoRisk/SRA) light the Home tab but are NOT
    // VBGHome — no-op only when we're already ON the tab's target route, so
    // Home still returns to the dashboard from a drill-down.
    const target = TAB_TARGET[tab];
    if (tab === active && (target.kind !== 'stack' || route?.name === target.route)) {return;}
    // navigate's overloads need a LITERAL route name; our route comes from the
    // TAB_TARGET table as a union variable, which breaks overload resolution
    // (TS2769). Same nested-union cast the navigation root uses (MainNavigator).
    const nav = navigation.navigate as unknown as (name: string, params?: unknown) => void;
    if (target.kind === 'stack') {
      nav(target.route);
    } else {
      // Cross-tab: hop to the Messenger stack via the parent tab navigator.
      // News Feed + Messenger both live under MessengerTab.
      nav(target.tab, {screen: target.screen});
    }
  };

  return (
    <View style={[styles.wrap, {paddingBottom: Math.max(insets.bottom, 10)}]}>
      <View style={styles.bar}>
        <View pointerEvents="none" style={styles.edge} />
        {TABS.map(t => {
          const on = t.key === active;
          return (
            <TouchableOpacity key={t.key} activeOpacity={0.75} style={styles.item} onPress={() => go(t.key)}>
              {on && <View testID={`vbg-tab-indicator-${t.key}`} style={styles.indicator} />}
              <View style={styles.iconWrap}>{t.icon(on)}</View>
              <Text style={[styles.label, on && styles.labelOn]} numberOfLines={1}>{t.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  wrap: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    paddingHorizontal: 12, paddingTop: 8,
    // Paint the obsidian screen bg so content scrolling under the footer can't
    // bleed through the wrap's transparent zones (the 8px top strip, the side
    // gutters, and the rounded-bar corner notches). The bar floats on top.
    backgroundColor: VBG.bg,
  },
  bar: {
    flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between',
    backgroundColor: 'rgba(13,17,25,0.96)',
    borderWidth: 1, borderColor: VBG.hair2, borderRadius: 20,
    paddingVertical: 10, paddingHorizontal: 6,
    shadowColor: '#000', shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 18,
  },
  edge: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(255,255,255,0.12)'},
  item: {flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 4, position: 'relative'},
  indicator: {
    position: 'absolute', top: -6, width: 22, height: 2.5, borderRadius: 2,
    backgroundColor: VBG.accent,
    shadowColor: VBG.accent, shadowOpacity: 1, shadowRadius: 8, shadowOffset: {width: 0, height: 0}, elevation: 5,
  },
  iconWrap: {width: 26, height: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 3},
  label: {fontSize: 8.5, fontWeight: '600', letterSpacing: 0.3, color: VBG.textMute},
  labelOn: {color: VBG.text},
}));
