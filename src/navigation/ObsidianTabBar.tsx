/**
 * Shared bottom-tab-bar renderer — the SAME component MainNavigator's root
 * footer uses (extracted verbatim, parameterised over icons/colors), so
 * every bottom tab bar in the app (root shell, CpoNavigator, Departmental
 * module) is pixel-identical: same spacing math, same safe-area handling,
 * same active-indicator glow. Fixes the recurring "tabs aren't aligned /
 * there's so much space between them" reports — those navigators previously
 * used React Navigation's default renderer via a raw `tabBarStyle` override,
 * which is a DIFFERENT layout engine than this custom bar and never quite
 * matched it.
 */
import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet, Platform} from 'react-native';
import type {BottomTabBarProps} from '@react-navigation/bottom-tabs';
import {useReportBottomTabBar} from '@hooks/useBottomInset';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {BravoFont} from '@/theme/bravo';
import {navigateOnce} from './tapGuard';

type IconName = React.ComponentProps<typeof Icon>['name'];

export type ObsidianTabIcon = {default: IconName; active: IconName; label: string};

export interface ObsidianTabBarProps extends BottomTabBarProps {
  icons: Record<string, ObsidianTabIcon>;
  /**
   * Which tab lights up while a HIDDEN route is the active one.
   *
   * Named by the navigator, never inferred. Inferring it as "the first visible
   * route" made the highlight depend on <Tab.Screen> DECLARATION ORDER: reorder
   * the list, or hide the first tab, and the bar silently lights the wrong one
   * while the user is inside a module. Nothing can test declaration order, so
   * the coupling would have been invisible.
   */
  standInTab?: string;
  bg?: string;
  accent?: string;
  mute?: string;
  text?: string;
  hairColor?: string;
}

/**
 * Routes that own the whole screen and must never have a tab bar under them.
 * Kept as data next to the bar that honours it, so a new full-screen route is
 * one line here rather than a fifth copy of a mount/unmount setOptions dance.
 */
const FULLSCREEN_ROUTES = new Set(['DepartmentChat', 'Chat', 'CallScreen', 'VoiceCall']);

export function ObsidianTabBar({
  state, descriptors, navigation, icons,
  standInTab,
  bg = '#07090D', accent = '#5B8DEF', mute = 'rgba(180,188,204,0.45)',
  text = '#F2F4F8', hairColor = 'rgba(255,255,255,0.1)',
}: ObsidianTabBarProps) {
  const insets = useSafeAreaInsets();

  const focusedRoute   = state.routes[state.index];
  const focusedOptions = descriptors[focusedRoute.key]?.options;
  const tabBarStyle = focusedOptions?.tabBarStyle as {display?: string} | undefined;
  /**
   * DERIVED FROM THE FOCUSED ROUTE, not only from the option — the same
   * belt-and-braces `MainNavigator` already carries, and for a sharper reason
   * here.
   *
   * A screen that wants the bar gone sets `tabBarStyle: {display: 'none'}` in a
   * MOUNT effect and restores it on unmount. That pairing assumes the route can
   * never have two live instances. `DepartmentChat` now can: it is registered
   * with a per-channel `getId`, so a push notification for another channel
   * while you are reading one PUSHES a second instance instead of swapping
   * params. Popping the inner one then ran its cleanup — restoring the bar —
   * while the outer one was still mounted and focused, and its mount effect
   * never re-ran. The member landed back in the first channel with the bar
   * drawn over the composer, and it did not heal until they left the channel.
   *
   * Deriving it here fixes that for every full-screen route at once, and does
   * not flicker during the push transition the way a focus-paired effect in
   * each screen would. `ChatScreen` and `CallScreen` set the option the same
   * way and are covered by the same list.
   */
  const focusedChild = focusedRoute.state?.routes?.[focusedRoute.state.index ?? 0]?.name;
  const hidden = tabBarStyle?.display === 'none' ||
    FULLSCREEN_ROUTES.has(focusedRoute.name) ||
    (!!focusedChild && FULLSCREEN_ROUTES.has(focusedChild));

  // Tell screens above us that a tab bar is present, so they stop adding the
  // safe-area inset a second time — this bar already reserves it below them.
  // See useBottomInset.
  useReportBottomTabBar(!hidden);

  if (hidden) {return null;}

  // Why not Math.max(insets.bottom, 8) + 6: on a classic 3-button-nav Android
  // phone insets.bottom already reports the system nav bar's full reserved
  // height, so adding a further +6 on top of it (a formula tuned for the
  // gesture-nav/home-indicator case, where insets.bottom is small) opened a
  // large dead black gap between the tab bar and the system buttons. Use the
  // inset as-is when it's real; only fall back to a small fixed margin when
  // there's no system inset to speak of (insets.bottom === 0).
  const bottomPad = insets.bottom > 0 ? insets.bottom : 12;

  // When the ACTIVE route is one of the hidden ones, no rendered item would be
  // focused and the bar would highlight nothing — "where am I?". The hidden
  // routes are reached FROM the first tab (the workspace Home dashboard), so it
  // stands in as their parent while one of them is open. No-op for any
  // navigator that hides nothing: focusedIsHidden is false and this is inert.
  const focusedIsHidden = !!descriptors[focusedRoute.key]?.options.tabBarButton;
  // The stand-in must itself be RENDERABLE, or the highlight it exists to
  // provide simply never appears — the misconfiguration is invisible either
  // way, so say so out loud in dev rather than pretending the filter fixes it.
  const standInKey = focusedIsHidden && standInTab
    ? state.routes.find(r => r.name === standInTab && !descriptors[r.key]?.options.tabBarButton)?.key
    : undefined;
  if (__DEV__ && focusedIsHidden && standInTab && !standInKey) {
    console.warn(
      `[ObsidianTabBar] standInTab "${standInTab}" is not a rendered tab — ` +
      'nothing will highlight while a hidden route is active. Name a visible tab.',
    );
  }

  return (
    <View style={[s.bar, {backgroundColor: bg, paddingBottom: bottomPad}]}>
      <View style={[s.hairline, {backgroundColor: hairColor}]} />
      <View style={s.row}>
        {state.routes.map(route => {
          const focused = standInKey
            ? standInKey === route.key
            : state.routes[state.index]?.key === route.key;
          const {options} = descriptors[route.key];
          // A route may be REACHABLE without being SHOWN.
          //
          // React Navigation's own convention for that is `tabBarButton`, and
          // the stock bar honours it; this custom bar did not, so there was no
          // way to keep a tab navigable while hiding it. Honouring it here lets
          // a navigator drop a tab from the BAR without unregistering the
          // route — so every existing `navigation.navigate('Attend')` keeps
          // working while the bar renders only what the design allows.
          if (options.tabBarButton) {return null;}
          const meta = icons[route.name] ?? {default: 'help-circle-outline' as IconName, active: 'help-circle' as IconName, label: route.name};
          const iconName = focused ? meta.active : meta.default;
          const label = (options.tabBarLabel as string | undefined) ?? meta.label;
          const badge = options.tabBarBadge;

          // Why: while a hidden route is focused, `focused` above is aliased to
          // the stand-in item — so the guard below saw the stand-in as already
          // focused and swallowed the press. HOME therefore did nothing from
          // inside Channels/Attend/Incident/Vault, which is what the user reads
          // as "the button is dead". A stand-in press is never a redundant tap
          // on the current screen: the current screen is the hidden route.
          const pressIsStandIn = !!standInKey && standInKey === route.key;

          const onPress = () => {
            const event = navigation.emit({type: 'tabPress', target: route.key, canPreventDefault: true});
            if (event.defaultPrevented) {return;}
            if (pressIsStandIn) {
              // NAV-10 (2026-08-26 audit) — navigateOnce here and below:
              // `focused` is a render-time capture, stale for a whole mash
              // burst while the JS thread lags, so all N presses used to pass
              // the check and queue N dispatches. Same-name repeats inside the
              // window are dropped at the press site instead; a press on a
              // DIFFERENT tab always passes.
              // Leaving a module does NOT reset it — deliberately.
              //
              // A popToTop here was tried and reverted: it silently destroyed
              // unsaved input on every module screen that does NOT hide this
              // bar, which is all of them except the chat thread. The worst
              // cases were a hand-picked 62-day day-status batch and a geofence
              // a manager had physically walked to capture — one tap on HOME,
              // no confirmation, no recovery. React Navigation preserving a
              // tab's stack is also the standard behaviour users expect.
              //
              // If "re-entering a module resumes where I left it" is ever
              // reported as a problem, fix it on the ENTRY side instead: have
              // each Home card name its module's root route (the R11-6
              // precedent in departmentalEntry.ts). That covers the Messenger
              // tab and the header chevron too, which this never did.
              //
              // No params, and therefore: a stand-in MUST be a leaf screen, not
              // a nested stack. A bare navigate into a stack re-enters it
              // wherever it was left.
              navigateOnce(navigation, route.name);
              return;
            }
            if (!focused) {
              // NO params on a bar press — same rule as MainNavigator's bar.
              // `route.params` here is only ever deep-link residue (e.g. the
              // CPO shell's messengerDeepLink writes {screen:'CallScreen',…}
              // onto the visible CpoComms tab), and replaying it re-opens the
              // deep-linked screen on every later press — the B-95 class.
              // Neither consumer (CpoNavigator, DepartmentalNavigator) has
              // initialParams, so a plain focus is behaviour-identical
              // otherwise and clears the stale payload.
              navigateOnce(navigation, route.name);
            }
          };

          return (
            <TouchableOpacity
              key={route.key}
              accessibilityRole="button"
              // Why: the visible label is inside a nested <Text>, so a screen
              // reader announced the tab without naming it, and nothing could
              // address an individual tab in a test. Both fixed by naming it here.
              accessibilityLabel={label}
              accessibilityState={{selected: focused}}
              onPress={onPress}
              activeOpacity={0.7}
              style={s.item}>
              {focused && <View style={[s.activeIndicator, {backgroundColor: accent, shadowColor: accent}]} />}
              <View style={s.iconWrap}>
                <Icon name={iconName} size={22} color={focused ? accent : mute} />
                {badge !== null && badge !== undefined && badge !== '' && (
                  <View style={[s.badge, {borderColor: bg}]}>
                    <Text style={s.badgeText} numberOfLines={1}>{badge}</Text>
                  </View>
                )}
              </View>
              {/**
                * UI corrections 2026-08-15 item 07 — the workspace bar went from
                * two items to FIVE, and the labels no longer fit.
                *
                * ARITHMETIC, not a guess: `s.row` has paddingHorizontal 8, so at
                * 320dp each of five items gets (320-16)/5 = 60.8dp. At fontScale
                * 1.3 "MESSENGER" and "CHANNELS" exceed that and `numberOfLines`
                * alone would ellipsise them to "MESSAG…" on every small device.
                *
                * Shrink-to-fit rather than shortening the words: the PDF names
                * these five destinations explicitly, and abbreviating them is a
                * content change the founder did not ask for. `minimumFontScale`
                * floors it so the label degrades to smaller, never to unreadable.
                *
                * Inert for the other two consumers of this bar (MainNavigator,
                * CpoNavigator) — their labels already fit, and this only engages
                * when the text would otherwise overflow.
                */}
              <FitLine
                style={[s.label, {color: focused ? text : mute, textAlign: 'center'}]}
                floorScale={0.75}
                text={label}
              />
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  bar: {
    paddingTop: 14,
    ...Platform.select({
      ios: {shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: {width: 0, height: -6}},
      android: {elevation: 20},
    }),
  },
  hairline: {height: 1, marginHorizontal: 20, marginBottom: 14},
  row: {flexDirection: 'row', alignItems: 'flex-start', paddingHorizontal: 8},
  item: {flex: 1, alignItems: 'center', justifyContent: 'flex-start', paddingVertical: 2, position: 'relative'},
  activeIndicator: {
    position: 'absolute', top: -14, width: 26, height: 2.5, borderRadius: 2,
    shadowOpacity: 1, shadowRadius: 12, shadowOffset: {width: 0, height: 0}, elevation: 6,
  },
  iconWrap: {width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 5},
  badge: {
    position: 'absolute', top: -4, right: -8, minWidth: 16, minHeight: 16, maxWidth: 34, borderRadius: 8, paddingVertical: 1,
    backgroundColor: '#EF4444', borderWidth: 1.5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 3,
  },
  badgeText: {color: '#FFFFFF', fontFamily: BravoFont.bold, fontSize: 9},
  label: {
    fontFamily: BravoFont.sans, fontSize: 10, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase',
  },
});
