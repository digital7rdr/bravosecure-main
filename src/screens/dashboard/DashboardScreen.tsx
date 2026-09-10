import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  Animated,
  Easing,
  Pressable,
  Modal,
  TouchableWithoutFeedback,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@/theme/bravo';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import BravoMark from '@components/BravoMark';
import {useAuthStore} from '@store/authStore';
import {useBookingStore} from '@store/bookingStore';
import {useMessengerStore} from '@/modules/messenger/store';
import {useActivityStore, selectUnreadCount, type ActivityRowData} from '@store/activityStore';
import {APP_VERSION} from '@utils/constants';
import {sosApi} from '@services/api';
import Geolocation from 'react-native-geolocation-service';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {CompositeNavigationProp} from '@react-navigation/native';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MainTabParamList, BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {navigateOnce} from '@navigation/tapGuard';
import {isProActive} from '@utils/tier';
import {roleLabel} from '@utils/roleLabel';

// ── Local design tokens (Bravo handoff — obsidian / platinum-cobalt) ────
// Why: Dashboard-only re-skin to the premium "Command Home" palette via a
// LOCAL token block, matching the sibling auth screens (LoginScreen /
// RegisterScreen / OnboardingScreen) WITHOUT mutating the shared
// src/theme/bravo.ts token (used app-wide). The app tab bar staying navy is
// an accepted, known seam — see the re-skin brief.
const T = {
  bg:           '#07090D',
  bgSoft:       '#0B0E14',
  cardSolid:    'rgba(17,21,29,0.9)',
  text:         '#F2F4F8',
  textDim:      'rgba(229,233,242,0.62)',
  textMute:     'rgba(180,188,204,0.45)',
  textFaint:    'rgba(180,188,204,0.28)',
  hair:         'rgba(255,255,255,0.06)',
  hair2:        'rgba(255,255,255,0.09)',
  accent:       '#5B8DEF',
  accentDeep:   '#2F5BE0',
  accentSoft:   '#7FA8FF',
  accentGlow:   'rgba(91,141,239,0.35)',
  signal:       '#4ADE80',
  signalDim:    'rgba(74,222,128,0.14)',
  alert:        '#F5485A',
  amber:        '#F5B544',
  // module tints (vbg-command-home.jsx SVC):
  tintIndigo:   '#818CF8', tintIndigoIc: '#B7BEFF', tintIndigoBd: 'rgba(129,140,248,0.38)', tintIndigoGlow: 'rgba(129,140,248,0.26)',
  tintBlue:     '#5B8DEF', tintBlueIc:   '#A9C5FF', tintBlueBd:   'rgba(91,141,239,0.4)',   tintBlueGlow:   'rgba(91,141,239,0.3)',
  tintViolet:   '#A78BFA', tintVioletIc: '#C7B6FF', tintVioletBd: 'rgba(167,139,250,0.38)', tintVioletGlow: 'rgba(167,139,250,0.26)',
} as const;

// Count shown in the "Services · N ACTIVE" header. Mirrors the number of
// PremiumModuleCard rows rendered below (Messenger, Secure, VBG) so the
// label and the list can't drift.
const SERVICE_COUNT = 3;

type DashboardNav = CompositeNavigationProp<
  BottomTabNavigationProp<MainTabParamList, 'Dashboard'>,
  NativeStackNavigationProp<BookingStackParamList>
>;

// Audit fix 3.5 — MOCK_ACTIVITY and MOCK_NOTIFICATIONS removed. Both
// were stale fixtures from the design phase. Real activity should come
// from a `/me/activity` endpoint (TODO Phase 5+); real notifications
// arrive via FCM and are read from local storage at render time.

// Audit fix 3.5 — every entry must either navigate somewhere real
// (action: 'profile' | 'bookings' | …) or be hidden until the
// destination exists. The previous menu was 7 dead taps. `enabled`
// false items are filtered at render time so the user sees only
// actionable entries; a future PR enables them as the screens land.
type ProfileMenuItem = {
  icon: string;
  label: string;
  action: 'profile' | 'bookings' | 'security' | 'notifications' | 'support';
  enabled: boolean;
  divider?: boolean;
};
// Founder 2026-08-04: the "Bravo Secure Pro" drawer row is gone — Pro lives
// behind Switch Dashboard → Secure Services (single sanctioned entry).
const PROFILE_MENU: ProfileMenuItem[] = [
  {icon: 'account',              label: 'My Profile',           action: 'profile',       enabled: true},
  {icon: 'calendar',              label: 'My Bookings',          action: 'bookings',      enabled: true,  divider: true},
  {icon: 'shield-lock',           label: 'Security Settings',    action: 'security',      enabled: false},
  {icon: 'bell-outline',          label: 'Notification Settings', action: 'notifications', enabled: false},
  {icon: 'help-circle-outline',   label: 'Help & Support',       action: 'support',       enabled: false},
];

type SOSState = 'idle' | 'activating' | 'activated';

export default function DashboardScreen() {
  const {user} = useAuthStore();
  const {loadBookings} = useBookingStore();
  const navigation = useNavigation<DashboardNav>();
  const insets = useSafeAreaInsets();

  // Modals
  const [notifVisible, setNotifVisible] = useState(false);
  const [profileVisible, setProfileVisible] = useState(false);
  const [sosVisible, setSosVisible] = useState(false);
  const [sosState, setSosState] = useState<SOSState>('idle');
  const [countdown, setCountdown] = useState(3);
  const [activatedTime, setActivatedTime] = useState('');

  // Animations
  const pulse1 = useRef(new Animated.Value(1)).current;
  const pulse2 = useRef(new Animated.Value(1)).current;
  const profileSlide = useRef(new Animated.Value(-320)).current;
  const notifSlide = useRef(new Animated.Value(600)).current;
  const sosProgress = useRef(new Animated.Value(0)).current;

  // SOS hold refs
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cdInterval = useRef<ReturnType<typeof setInterval> | null>(null);
  const sosFadeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Audit fix 0.7 — server-assigned id of the live SOS event so cancel
  // can call /sos/:id/cancel. Tracked separately from the UI state so
  // a cancel-while-still-uploading correctly tears down the row once
  // the raise resolves.
  const [sosId, setSosId] = useState<string | null>(null);
  const [sosError, setSosError] = useState<string | null>(null);
  // Audit fix 0.7 (round-trip) — poll /sos/:id/status until ops sets
  // `acknowledged_at`. Until then the activated screen shows "Waiting
  // for ops…" so the UI never lies about server state.
  const [sosAcked, setSosAcked] = useState(false);
  const sosPollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sosPollCancelled = useRef(false);

  useEffect(() => {
    void loadBookings();
  }, [loadBookings]);

  // Audit fix 3.5 — only run the pulse animation while the dashboard
  // is focused. The previous `useEffect(startPulse)` ran the loop
  // forever after the first render, even when the user was on Messenger
  // or Profile tabs. Animated.loop is GC-safe but burns the JS thread,
  // and on Fabric the native driver keeps the loop alive across blur.
  useFocusEffect(
    useCallback(() => {
      const animation = Animated.loop(
        Animated.parallel([
          Animated.timing(pulse1, {
            toValue: 1.5, duration: 1600,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(pulse2, {
            toValue: 1.8, duration: 1800, delay: 400,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
        ]),
        {resetBeforeIteration: true},
      );
      animation.start();
      return () => {
        animation.stop();
        // Snap back to base scale so the next focus enters cleanly.
        pulse1.setValue(1);
        pulse2.setValue(1);
      };
    }, [pulse1, pulse2]),
  );

  // Audit fix 0.7 — drop every running timer when the screen unmounts.
  // Without this, a navigation-away during the 3-second hold leaks the
  // setTimeout/setInterval into the JS heap and (worse) can fire
  // activateSOS after the component is gone.
  useEffect(() => {
    return () => {
      if (holdTimer.current)    {clearTimeout(holdTimer.current);}
      if (cdInterval.current)   {clearInterval(cdInterval.current);}
      if (sosFadeTimer.current) {clearTimeout(sosFadeTimer.current);}
      if (sosPollTimer.current) {clearTimeout(sosPollTimer.current);}
      sosPollCancelled.current = true;
    };
  }, []);

  // Audit fix 3.5 — `startPulse` was a fire-and-forget Animated.loop()
  // that ran forever after mount. Replaced by the `useFocusEffect`
  // above so the loop is owned + stopped on blur.

  const isPro = isProActive(user);
  const initials = user?.full_name
    ?.split(' ')
    .map(n => n[0])
    .join('')
    .slice(0, 2)
    .toUpperCase() ?? 'BS';

  // Real unread count — summed across conversations from the messenger store.
  const unreadCount = useMessengerStore(s =>
    Object.values(s.conversations).reduce((n, c) => n + (c.unread_count || 0), 0),
  );
  // N-19 — the in-app notification centre (activity feed) that server-event
  // wakes populate via recordActivity(). The drawer used to be a hardcoded
  // "You're all caught up" empty state; now it renders these rows and its
  // "Mark all read" actually works.
  const activityRows = useActivityStore(s => s.rows);
  const activityUnread = useActivityStore(selectUnreadCount);
  const markActivityRead = useActivityStore(s => s.markRead);
  // N-20 — mark-all-read persists to the server so other devices converge.
  // NAV-17 (2026-08-26 audit) — in-flight ref: without it a mash fired one
  // network sync per tap.
  const markAllInFlightRef = useRef(false);
  const markAllActivityRead = () => {
    if (markAllInFlightRef.current) {return;}
    markAllInFlightRef.current = true;
    void (async () => {
      try {
        const {markAllActivityReadSynced} = require('@store/activitySync') as typeof import('@store/activitySync');
        await markAllActivityReadSynced();
      } catch { useActivityStore.getState().markAllRead(); }
      finally { markAllInFlightRef.current = false; }
    })();
  };

  // Real connectivity — drives the operator-status 'Online/Offline' label and
  // the bell dot (with unread). NetInfo fires on every OS connectivity change.
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const NetInfo = (require('@react-native-community/netinfo') as typeof import('@react-native-community/netinfo')).default;
    const unsub = NetInfo.addEventListener(st => setOnline(st.isConnected !== false));
    return () => unsub();
  }, []);

  // ── Navigation ──────────────────────────────────────────
  // NAV-10 (2026-08-26 audit) — navigateOnce: the three module cards are the
  // literal 'one button ×20' surface; each queued repeat was a full dispatch +
  // reducer run the next back press then waited behind.
  const goToMessenger = () => navigateOnce(navigation, 'MessengerTab', {screen: 'MessengerHome'});
  const goToSecure = () => navigateOnce(navigation, 'SecureTab', {screen: 'BookingHome'});
  // Virtual Bodyguard opens the VBG flow (dashboard → SRA/OSINT/tracking)
  // for everyone. It lives in the same SecureTab (BookingNavigator) stack
  // as BookingHome/ProDashboard, so a tier branch here would only send the
  // user to the wrong screen — which is exactly the "redirects to Lite" bug.
  const goToVBG = () => navigateOnce(navigation, 'SecureTab', {screen: 'VBGHome'});

  // ── Notification drawer ─────────────────────────────────
  const openNotif = () => {
    setNotifVisible(true);
    // N-20 — pull the latest server notifications when the drawer opens.
    try {
      const {syncActivityFromServer} = require('@store/activitySync') as typeof import('@store/activitySync');
      void syncActivityFromServer();
    } catch { /* best-effort */ }
    Animated.spring(notifSlide, {toValue: 0, useNativeDriver: true, bounciness: 4}).start();
  };
  const closeNotif = () => {
    Animated.timing(notifSlide, {toValue: 600, duration: 280, useNativeDriver: true}).start(() =>
      setNotifVisible(false),
    );
  };

  // ── Profile drawer ──────────────────────────────────────
  const openProfile = () => {
    setProfileVisible(true);
    Animated.spring(profileSlide, {toValue: 0, useNativeDriver: true, bounciness: 4}).start();
  };
  const closeProfile = () => {
    Animated.timing(profileSlide, {toValue: -320, duration: 280, useNativeDriver: true}).start(
      () => setProfileVisible(false),
    );
  };

  // ── SOS logic ───────────────────────────────────────────
  // BS-SOS — the SOS bar (pinned under the header) opens the activation
  // modal directly; the old two-stage fade-FAB activation was removed.
  // Audit fix 3.5 — was reading `Animated.Value._value` via a cast, which
  // is a private API that React Native has changed across versions
  // (the field is `_value` on classic, `__getValue()` on Fabric, neither
  // is documented). Track the wake state in a plain ref and update it
  // alongside the animation; the ref is the source of truth for "is
  // BS-SOS — the old two-stage "wake then tap" fade FAB was removed; the
  // emergency bar under the header is always visible and opens SOS directly.
  // (The fade refs sosFadeTimer/sosAwakeRef/sosFadeOpacity went away with
  // the FAB — openSOS just shows the modal now.)
  const openSOS = () => {
    setSosState('idle');
    setSosVisible(true);
  };
  const closeSOS = () => {
    cancelHold();
    setSosVisible(false);
    setSosState('idle');
  };
  const startHold = () => {
    setSosState('activating');
    setCountdown(3);
    sosProgress.setValue(0);
    Animated.timing(sosProgress, {toValue: 1, duration: 3000, useNativeDriver: false}).start();
    let cd = 3;
    cdInterval.current = setInterval(() => {
      cd--;
      setCountdown(Math.max(cd, 0));
      if (cd <= 0) {clearInterval(cdInterval.current!);}
    }, 1000);
    holdTimer.current = setTimeout(activateSOS, 3000);
  };
  const cancelHold = () => {
    if (holdTimer.current) {clearTimeout(holdTimer.current);}
    if (cdInterval.current) {clearInterval(cdInterval.current);}
    holdTimer.current = null;
    sosProgress.setValue(0);
    if (sosState !== 'activated') {setSosState('idle');}
  };
  // Audit fix 0.7 (round-trip) — poll the server for ack. Backoff
  // matches the dispatch loops (3s → 8s on consecutive misses, cap 15s)
  // and gives up at the 5-minute mark: by then ops has the panic event
  // in their unack feed, so additional polling just burns battery.
  // `sosPollCancelled.current` lets cancelSOS / unmount kill the loop
  // mid-flight without leaking a setTimeout.
  const pollSosStatus = (id: string) => {
    sosPollCancelled.current = false;
    const startedAt = Date.now();
    const MAX_POLL_MS = 5 * 60 * 1000;
    let delayMs = 3_000;
    const tick = () => {
      if (sosPollCancelled.current) {return;}
      sosApi.status(id)
        .then(res => {
          if (sosPollCancelled.current) {return;}
          if (res.data.acknowledged_at) {
            setSosAcked(true);
            return;            // stop polling — terminal success
          }
          if (Date.now() - startedAt >= MAX_POLL_MS) {return;}
          delayMs = Math.min(delayMs + 2_000, 15_000);
          sosPollTimer.current = setTimeout(tick, delayMs);
        })
        .catch(() => {
          if (sosPollCancelled.current) {return;}
          if (Date.now() - startedAt >= MAX_POLL_MS) {return;}
          delayMs = Math.min(delayMs + 2_000, 15_000);
          sosPollTimer.current = setTimeout(tick, delayMs);
        });
    };
    sosPollTimer.current = setTimeout(tick, delayMs);
  };

  // Audit fix 0.7 — round-trip to /sos/raise before flipping to
  // 'activated'. We optimistically set the local state immediately so
  // the UI feels instant, then attach GPS + persist on the server.
  // If the network call fails we surface the error inline (sosError)
  // and keep the modal open so the user can retry — failing closed
  // would defeat the entire point of a panic button.
  const activateSOS = () => {
    if (cdInterval.current) {clearInterval(cdInterval.current);}
    const now = new Date();
    setActivatedTime(
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
    );
    setSosState('activated');
    setSosError(null);
    setSosAcked(false);

    // Try to grab a quick GPS fix (3s budget, low-accuracy fallback).
    // Don't block the raise on this — if location is denied or slow,
    // the server still gets the panic event and ops can call back.
    let didFire = false;
    const fireRaise = (lat?: number, lng?: number) => {
      if (didFire) {return;}
      didFire = true;
      sosApi.raise({lat, lng, reason: 'panic_button'})
        .then(res => {
          setSosId(res.data.id);
          // Start the ack poll. The activated screen flips its label
          // from "Waiting for Bravo Control System…" to "Bravo Control System Acknowledged" only
          // when this resolves.
          pollSosStatus(res.data.id);
        })
        .catch(e => {
          // Best-effort: surface the error but keep the activated UI so
          // the user knows the screen DID react. They can retry or
          // fall back to a phone call.
          setSosError((e as Error).message ?? 'sos_send_failed');
        });
    };
    Geolocation.getCurrentPosition(
      pos => fireRaise(pos.coords.latitude, pos.coords.longitude),
      ()  => fireRaise(),
      {enableHighAccuracy: true, timeout: 3000, maximumAge: 30_000},
    );
  };

  // Audit fix 0.7 — cancel hits the backend so the SOS row goes to
  // status='false_alarm' and ops's unacked badge clears. Best-effort:
  // we tear down the modal regardless of the network outcome.
  const cancelSOS = () => {
    if (sosId) {
      sosApi.cancel(sosId).catch(() => { /* swallow — UI close is authoritative */ });
    }
    // Stop any in-flight ack poll so a late status response can't flip
    // the screen back to "Acknowledged" after the user cancelled.
    sosPollCancelled.current = true;
    if (sosPollTimer.current) {clearTimeout(sosPollTimer.current);}
    setSosId(null);
    setSosError(null);
    setSosAcked(false);
    setSosVisible(false);
    setSosState('idle');
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <AmbientBg bg={T.bg} />
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* ── Header (premium — Bravo mark + mono subtitle) ───── */}
      <View style={styles.header}>
        <View style={styles.headerLogo}>
          <BravoMark size={34} primary="#FFFFFF" accent={T.accent} />
          <View style={{marginLeft: 6}}>
            <Text style={styles.headerTitle}>BRAVO</Text>
            <Text style={styles.headerSubtitle}>Command · v{APP_VERSION}</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <TouchableOpacity style={styles.headerBtn} onPress={openNotif} activeOpacity={0.7} hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
            <Icon name="bell-outline" size={18} color={T.text} />
            {(unreadCount > 0 || activityUnread > 0) && <View style={styles.notifDot} />}
          </TouchableOpacity>
          <TouchableOpacity style={styles.avatar} onPress={openProfile} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={StyleSheet.absoluteFill} />
            ) : (
              <>
                <LinearGradient
                  colors={['#6E9BF5', T.accentDeep]}
                  start={{x: 0.1, y: 0}}
                  end={{x: 0.9, y: 1}}
                  style={StyleSheet.absoluteFill}
                />
                <Text style={styles.avatarText}>{initials}</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Emergency bar (pinned under header) ─────────────
          BS-SOS — a full-width SOS bar pinned here instead of a floating
          FAB, so it's always visible and never overlays the cards. */}
      <TouchableOpacity
        style={styles.sosBar}
        onPress={openSOS}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel="Emergency SOS">
        <LinearGradient
          colors={['#F0455A', '#D32339']}
          start={{x: 0, y: 0}}
          end={{x: 1, y: 1}}
          style={StyleSheet.absoluteFill}
        />
        <View style={styles.sosBarEdge} pointerEvents="none" />
        <View style={styles.sosBarBadge}>
          <Text style={styles.sosBarBadgeText}>!</Text>
        </View>
        <Text style={styles.sosBarText} numberOfLines={1}>EMERGENCY · SOS</Text>
      </TouchableOpacity>

      {/* ── Main scroll ───────────────────────────────────── */}
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.scrollContent, {paddingBottom: insets.bottom + 120}]}
        showsVerticalScrollIndicator={false}>

        {/* Step 19 — "Protect me now" auto-dispatch hero. Gated behind AUTO_DISPATCH so the
            dashboard is byte-for-byte unchanged until cut-over; when on, it deep-links into
            the booking wizard which submits the request as fully-automatic. */}
        {user?.auto_dispatch_enabled && (
          <TouchableOpacity activeOpacity={0.9} onPress={goToSecure} accessibilityRole="button"
            accessibilityLabel="Protect me now — auto-dispatch"
            style={{borderRadius: 20, overflow: 'hidden', marginBottom: 16, borderWidth: 1, borderColor: 'rgba(91,141,239,0.30)'}}>
            <LinearGradient colors={['#2F5BE0', '#16307E']} start={{x: 0, y: 0}} end={{x: 1, y: 1}}
              style={{flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 18, paddingVertical: 17}}>
              <View style={{width: 48, height: 48, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center'}}>
                <Icon name="shield-account" size={26} color="#fff" />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={{fontFamily: 'Manrope_700Bold', fontSize: 18, color: '#fff', letterSpacing: -0.2}}>Protect me now</Text>
                <Text style={{fontFamily: 'Manrope_500Medium', fontSize: 12.5, color: 'rgba(255,255,255,0.80)', marginTop: 2}}>
                  Nearest available agency, dispatched instantly
                </Text>
              </View>
              <Icon name="chevron-right" size={24} color="rgba(255,255,255,0.92)" />
            </LinearGradient>
          </TouchableOpacity>
        )}

        {/* Operator status strip — pulse + UTC clock */}
        <OperatorStatus online={online} />

        {/* Module tiles */}
        <View style={styles.tilesWrap}>

          {/* Services section header — "Services · 3 ACTIVE" per the
              Command Home design (vbg-command-home.jsx §Services). */}
          <View style={styles.servicesHeader}>
            <Text style={styles.sectionLabel}>Services</Text>
            <Text style={styles.servicesCount}>{SERVICE_COUNT} ACTIVE</Text>
          </View>

          {/* Bravo Messenger */}
          <PremiumModuleCard
            onPress={goToMessenger}
            iconName="lock"
            tint="indigo"
            title="Bravo Messenger"
            sub="Encrypted comms & channels"
            badge={unreadCount > 0 ? {kind: 'pill', text: `${unreadCount} UNREAD`, tint: 'indigo'} : {kind: 'dot'}}
          />

          {/* Bravo Secure */}
          <PremiumModuleCard
            onPress={goToSecure}
            iconName="shield-check"
            tint="blue"
            title="Bravo Secure"
            sub="Book security & protection"
            badge={{kind: 'dot'}}
          />

          {/* Virtual Bodyguard */}
          <PremiumModuleCard
            onPress={goToVBG}
            iconName="shield-account"
            tint="violet"
            title="Virtual Bodyguard"
            sub="VIP & corporate protection"
            badge={{kind: 'pill', text: isPro ? 'PRO' : 'VBG', tint: 'violet'}}
          />
        </View>

        {/* Audit fix 3.5 — Recent Activity ran off `MOCK_ACTIVITY`,
            5 hardcoded rows that never matched real account state.
            Removed; the section is hidden until a client-facing
            activity endpoint lands. The "Live feed" affordance lives
            in the messenger and ops-room screens already. */}
      </ScrollView>

      {/* BS-SOS — emergency button moved from a floating bottom-right FAB
          (which overlaid the booking cards) to the fixed bar pinned under
          the header (see above). Always visible, never hides content. */}

      {/* ── Notification Drawer (bottom sheet) ─────────────── */}
      <Modal visible={notifVisible} transparent animationType="none" onRequestClose={closeNotif} statusBarTranslucent>
        <TouchableWithoutFeedback onPress={closeNotif}>
          <View style={styles.drawerOverlay} />
        </TouchableWithoutFeedback>
        <Animated.View style={[styles.notifDrawer, {transform: [{translateY: notifSlide}]}]}>
          <TouchableOpacity style={styles.drawerHandle} onPress={closeNotif} activeOpacity={0.7}>
            <View style={styles.drawerHandleBar} />
          </TouchableOpacity>
          <View style={styles.drawerHeader}>
            <Text style={styles.drawerTitle}>Notifications</Text>
            {activityRows.length > 0 && (
              <TouchableOpacity activeOpacity={0.7} onPress={markAllActivityRead} hitSlop={{top: 12, bottom: 12, left: 8, right: 8}}>
                <Text style={styles.markAllRead}>Mark all read</Text>
              </TouchableOpacity>
            )}
          </View>
          <ScrollView style={styles.drawerScroll} showsVerticalScrollIndicator={false}>
            {/* N-19 — real in-app notification history. Rows are populated by
                recordActivity() on each server-event wake (booking / dispatch /
                mission / payout / SOS / incident); tapping one marks it read. */}
            {activityRows.length === 0 ? (
              <View style={{padding: 24, alignItems: 'center'}}>
                <Icon name="bell-outline" size={32} color={T.textMute} />
                <Text style={{color: T.textMute, marginTop: 8, fontSize: 13}}>
                  You're all caught up.
                </Text>
              </View>
            ) : (
              activityRows.map((row: ActivityRowData) => (
                <TouchableOpacity
                  key={row.id}
                  activeOpacity={0.7}
                  onPress={() => markActivityRead(row.id)}
                  style={notifRowStyles.row}>
                  {!row.read && <View style={notifRowStyles.unreadDot} />}
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={notifRowStyles.title} numberOfLines={1}>{row.title}</Text>
                    {!!row.subtitle && (
                      <Text style={notifRowStyles.subtitle} numberOfLines={2}>{row.subtitle}</Text>
                    )}
                  </View>
                  <Text style={notifRowStyles.time}>{relNotifTime(row.ts)}</Text>
                </TouchableOpacity>
              ))
            )}
            <View style={{height: 24}} />
          </ScrollView>
        </Animated.View>
      </Modal>

      {/* ── Profile Drawer (slides from left) ──────────────── */}
      <Modal visible={profileVisible} transparent animationType="none" onRequestClose={closeProfile} statusBarTranslucent>
        <View style={styles.profileOverlay}>
          <TouchableWithoutFeedback onPress={closeProfile}>
            <View style={StyleSheet.absoluteFill} />
          </TouchableWithoutFeedback>
          <Animated.View style={[styles.profileDrawer, {transform: [{translateX: profileSlide}]}]}>
            {/* User section */}
            <View style={[styles.profileUser, {paddingTop: insets.top + 16}]}>
              <View style={styles.profileAvatarWrap}>
                <View style={styles.profileAvatar}>
                  {user?.avatar_url ? (
                    <Image source={{uri: user.avatar_url}} style={styles.profileAvatarImg} />
                  ) : (
                    <Text style={styles.profileAvatarText}>{initials}</Text>
                  )}
                </View>
                <View style={styles.onlineDot} />
              </View>
              <View style={styles.profileUserInfo}>
                <View style={styles.profileNameRow}>
                  <Text style={styles.profileName}>{user?.full_name?.split(' ')[0] ?? 'User'} {user?.full_name?.split(' ')[1]?.[0] ?? ''}.</Text>
                  <View style={styles.roleBadge}>
                    <Text style={styles.roleBadgeText}>{roleLabel(user?.role)}</Text>
                  </View>
                </View>
                <TouchableOpacity activeOpacity={0.7}
                  onPress={() => {
                    closeProfile();
                    // NAV-08 — a back press inside the 240 ms window pops this
                    // screen; the timer must not then navigate from a screen
                    // the user already left.
                    setTimeout(() => {
                      if (navigation.isFocused()) {
                        (navigation as unknown as {navigate: (s: string) => void}).navigate('ProfileTab');
                      }
                    }, 240);
                  }}>
                  <Text style={styles.editProfile}>Edit Profile</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* Menu — Audit fix 3.5 — only enabled items render, each
                wired to its real navigation target. Disabled items are
                kept in PROFILE_MENU as a TODO list and hidden from the
                user until the destination screen lands. */}
            <ScrollView style={styles.profileMenu} showsVerticalScrollIndicator={false}>
              {PROFILE_MENU.filter(m => m.enabled).map(item => (
                <React.Fragment key={item.label}>
                  <TouchableOpacity
                    style={styles.menuItem}
                    activeOpacity={0.7}
                    onPress={() => {
                      closeProfile();
                      // Navigate after the drawer slides shut so the
                      // animation isn't interrupted mid-render.
                      setTimeout(() => {
                        switch (item.action) {
                          case 'profile':
                            navigation.navigate('ProfileTab');
                            break;
                          case 'bookings':
                            navigation.navigate('SecureTab', {screen: 'BookingHistory'});
                            break;
                        }
                      }, 240);
                    }}>
                    <View style={styles.menuItemLeft}>
                      <Icon name={item.icon} size={19} color={T.accent} />
                      <Text style={styles.menuItemLabel}>{item.label}</Text>
                    </View>
                    <Icon name="chevron-right" size={17} color={T.textMute} />
                  </TouchableOpacity>
                  {item.divider && <View style={styles.menuDivider} />}
                </React.Fragment>
              ))}
            </ScrollView>

            {/* Bottom */}
            <View style={[styles.profileBottom, {paddingBottom: insets.bottom + 8}]}>
              <TouchableOpacity
                style={styles.logoutBtn}
                activeOpacity={0.7}
                onPress={() => {
                  closeProfile();
                  void useAuthStore.getState().signOut();
                }}>
                <Icon name="logout" size={19} color={T.alert} />
                <Text style={styles.logoutText}>Log Out</Text>
              </TouchableOpacity>
              <View style={styles.versionWrap}>
                <Text style={styles.versionStudio}>OmniDevX Studio</Text>
                <Text style={styles.versionNum}>v{APP_VERSION}</Text>
              </View>
            </View>
          </Animated.View>
        </View>
      </Modal>

      {/* ── SOS Modal ──────────────────────────────────────── */}
      <Modal visible={sosVisible} transparent={false} animationType="fade" onRequestClose={closeSOS} statusBarTranslucent>
        <View style={[styles.sosModal, {paddingTop: insets.top}]}>

          {/* ── Idle state ─── */}
          {sosState === 'idle' && (
            <View style={styles.sosInner}>
              <View style={styles.sosModalHeader}>
                <TouchableOpacity onPress={closeSOS} style={styles.sosBackBtn} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="arrow-left" size={22} color={T.textDim} />
                </TouchableOpacity>
                <Text style={styles.sosModalTitle}>BRAVO</Text>
              </View>
              <View style={styles.sosCenterContent}>
                <Text style={styles.sosHeading}>Emergency SOS</Text>
                <Text style={styles.sosSubtitle}>Hold the button for 3 seconds to activate</Text>
                <Pressable
                  style={styles.sosHoldBtn}
                  onPressIn={startHold}
                  onPressOut={cancelHold}>
                  <Text style={styles.sosHoldText}>SOS</Text>
                </Pressable>
                <View style={styles.sosInfoCards}>
                  <View style={styles.sosInfoCard}>
                    <Icon name="map-marker" size={20} color={T.accent} />
                    <View>
                      <Text style={styles.sosInfoTitle}>Location Shared</Text>
                      <Text style={styles.sosInfoSub}>GPS coordinates sent to Bravo Control System</Text>
                    </View>
                  </View>
                  <View style={styles.sosInfoCard}>
                    <Icon name="headset" size={20} color={T.accent} />
                    <View>
                      <Text style={styles.sosInfoTitle}>Bravo Control System On Standby</Text>
                      <Text style={styles.sosInfoSub}>Response team ready to deploy</Text>
                    </View>
                  </View>
                </View>
              </View>
            </View>
          )}

          {/* ── Activating state ─── */}
          {sosState === 'activating' && (
            <View style={[styles.sosInner, {backgroundColor: 'rgba(127,29,29,0.6)'}]}>
              <View style={[styles.sosModalHeader, {borderBottomColor: 'rgba(153,27,27,0.3)'}]}>
                <TouchableOpacity onPress={() => { cancelHold(); setSosState('idle'); }} style={styles.sosBackBtn} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                  <Icon name="arrow-left" size={22} color={T.textDim} />
                </TouchableOpacity>
                <Text style={[styles.sosModalTitle, {color: '#FCA5A5'}]}>ACTIVATING SOS</Text>
              </View>
              <View style={styles.sosCenterContent}>
                <Text style={[styles.sosSubtitle, {color: '#FCA5A5'}]}>Keep holding the button...</Text>
                <View style={styles.sosCountdownWrap}>
                  <View style={styles.sosCountdownCircle}>
                    <Text style={styles.sosCountdownNum}>{countdown}</Text>
                  </View>
                </View>
                <Text style={styles.sosReleaseText}>RELEASE TO CANCEL</Text>
              </View>
            </View>
          )}

          {/* ── Activated state ─── */}
          {sosState === 'activated' && (
            <View style={[styles.sosInner, {backgroundColor: '#450A0A'}]}>
              <View style={[styles.sosModalHeader, {borderBottomColor: 'transparent'}]}>
                <Text style={[styles.sosModalTitle, {color: '#FCA5A5'}]}>SOS ACTIVE</Text>
                <Text style={styles.sosActivatedTime}>Activated at {activatedTime}</Text>
              </View>
              <View style={styles.sosCenterContent}>
                <View style={styles.sosActivatedIcon}>
                  <Icon name="shield-alert" size={64} color="#FFF" />
                </View>
                <Text style={styles.sosActivatedTitle}>SOS Active</Text>
                {/* Audit fix 0.7 (round-trip) — label is honest about
                    server state: until /sos/:id/status reports
                    `acknowledged_at`, we say "Waiting for ops…" not
                    "Notified". Flips to "Bravo Control System Acknowledged" once
                    ops clicks ack in the console. */}
                <Text style={[styles.sosSubtitle, {color: T.accentSoft, fontWeight: '700'}]}>
                  {sosAcked ? 'Bravo Control System Acknowledged' : 'Waiting for Bravo Control System…'}
                </Text>
                {/* Map mockup */}
                <View style={styles.sosMapCard}>
                  <View style={styles.sosMapHeader}>
                    <Text style={styles.sosMapLabel}>LIVE RESPONSE TRACKING</Text>
                  </View>
                  <View style={styles.sosMapBody}>
                    <View style={styles.sosMapDot}>
                      <Animated.View style={[styles.sosMapPing, {transform: [{scale: pulse1}], opacity: 0.7}]} />
                      <View style={styles.sosMapCenter} />
                    </View>
                  </View>
                </View>
                {sosError && (
                  <Text style={[styles.sosSubtitle, {color: T.alert, marginTop: 8, fontSize: 11}]}>
                    {sosError}
                  </Text>
                )}
                <TouchableOpacity style={styles.cancelSosBtn} onPress={cancelSOS}>
                  <Text style={styles.cancelSosText}>CANCEL SOS</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </View>
      </Modal>
    </View>
  );
}

// ─── Premium helpers ─────────────────────────────────────────────────────────

type PremiumTileTint = 'violet' | 'indigo' | 'blue';
type PremiumModuleBadge =
  | {kind: 'pill'; text: string; tint: PremiumTileTint}
  | {kind: 'dot'};

// Per-tint palette pulled from the local obsidian token block (vbg-command-home SVC).
const TILE_TINT: Record<PremiumTileTint, {
  rail: [string, string]; railGlow: string;
  iconFill: [string, string]; iconBd: string; iconGlow: string; iconColor: string;
}> = {
  indigo: {
    rail: [T.tintIndigo, '#4F46E5'], railGlow: T.tintIndigoGlow,
    iconFill: ['rgba(129,140,248,0.22)', 'rgba(129,140,248,0.06)'], iconBd: T.tintIndigoBd, iconGlow: T.tintIndigoGlow, iconColor: T.tintIndigoIc,
  },
  blue: {
    rail: [T.tintBlue, T.accentDeep], railGlow: T.tintBlueGlow,
    iconFill: ['rgba(91,141,239,0.22)', 'rgba(91,141,239,0.06)'], iconBd: T.tintBlueBd, iconGlow: T.tintBlueGlow, iconColor: T.tintBlueIc,
  },
  violet: {
    rail: [T.tintViolet, '#6366F1'], railGlow: T.tintVioletGlow,
    iconFill: ['rgba(167,139,250,0.22)', 'rgba(167,139,250,0.06)'], iconBd: T.tintVioletBd, iconGlow: T.tintVioletGlow, iconColor: T.tintVioletIc,
  },
};

function PremiumModuleCard({onPress, iconName, tint, title, sub, badge}: {
  onPress: () => void;
  iconName: string;
  tint: PremiumTileTint;
  title: string; sub: string;
  badge: PremiumModuleBadge;
}) {
  const t = TILE_TINT[tint];
  return (
    <TouchableOpacity style={p.modCard} onPress={onPress} activeOpacity={0.85}>
      {/* Card surface — obsidian gradient (rgba(22,28,40,0.8)→rgba(15,20,29,0.74)). */}
      <LinearGradient
        colors={['rgba(22,28,40,0.8)', 'rgba(15,20,29,0.74)']}
        start={{x: 0, y: 0}}
        end={{x: 1, y: 1}}
        style={StyleSheet.absoluteFill}
      />
      {/* Accent rail on the left — tinted gradient + glow. */}
      <View style={[p.modRailWrap, {shadowColor: t.railGlow}]} pointerEvents="none">
        <LinearGradient colors={t.rail} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={p.modRail} />
      </View>
      {/* Top edge-light — 1px linear gradient highlight. */}
      <View style={p.modEdgeLight} pointerEvents="none" />

      <View style={[p.modIcon, {borderColor: t.iconBd, shadowColor: t.iconGlow}]}>
        <LinearGradient colors={t.iconFill} start={{x: 0.2, y: 0}} end={{x: 0.9, y: 1}} style={StyleSheet.absoluteFill} />
        <Icon name={iconName} size={22} color={t.iconColor} />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={p.modTitle}>{title}</Text>
        <Text style={p.modSub} numberOfLines={1}>{sub}</Text>
      </View>

      {badge.kind === 'pill' ? (
        <View style={[p.pill, badge.tint === 'violet' ? p.pillViolet : p.pillIndigo]}>
          <Text style={[p.pillText, badge.tint === 'violet' ? p.pillTextViolet : p.pillTextIndigo]}>{badge.text}</Text>
        </View>
      ) : (
        <View style={p.dotBlue} />
      )}
      <Icon name="chevron-right" size={16} color={T.textMute} style={{marginLeft: 4}} />
    </TouchableOpacity>
  );
}

function OperatorStatus({online}: {online: boolean}) {
  const [clock, setClock] = useState(() => nowUtcClock());
  useEffect(() => {
    const id = setInterval(() => setClock(nowUtcClock()), 1000);
    return () => clearInterval(id);
  }, []);
  return (
    <View style={p.opStrip}>
      <View style={p.opEdge} pointerEvents="none" />
      <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
        <View style={[p.opDotOuter, !online && {backgroundColor: 'rgba(255,93,93,0.18)'}]}>
          <View style={[p.opDotInner, !online && {backgroundColor: '#FF5D5D'}]} />
        </View>
        <View>
          <Text style={p.opLabel}>Secure · {online ? 'Online' : 'Offline'}</Text>
          <Text style={p.opSub}>{online ? 'All systems nominal · VPN routed' : 'Reconnecting…'}</Text>
        </View>
      </View>
      <View style={{alignItems: 'flex-end'}}>
        <Text style={p.opClock}>{clock.main}<Text style={{color: T.textMute}}>{clock.sec}</Text></Text>
        <Text style={p.opZone}>{clock.zone}</Text>
      </View>
    </View>
  );
}

function nowUtcClock() {
  const d = new Date();
  const hh = d.getUTCHours().toString().padStart(2, '0');
  const mm = d.getUTCMinutes().toString().padStart(2, '0');
  const ss = d.getUTCSeconds().toString().padStart(2, '0');
  return {main: `${hh}:${mm}`, sec: `:${ss}`, zone: 'UTC · LDN'};
}

// ─── Premium styles — design token driven ───────────────────────────────────
const p = StyleSheet.create(scaleTextStyles({
  // Module card
  modCard: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    padding: 16, paddingLeft: 18,
    backgroundColor: T.cardSolid,
    borderRadius: 18,
    borderWidth: 1, borderColor: T.hair,
    overflow: 'hidden',
    position: 'relative',
  },
  modRailWrap: {position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 3,
    shadowOpacity: 1, shadowRadius: 6, shadowOffset: {width: 0, height: 0}, elevation: 4},
  modRail: {flex: 1, borderRadius: 3},
  modEdgeLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(255,255,255,0.10)'},
  modIcon: {
    width: 46, height: 46, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    flexShrink: 0, overflow: 'hidden',
    shadowOpacity: 1, shadowRadius: 10, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  modTitle: {fontFamily: BravoFont.display, fontSize: 16.5, fontWeight: '600', color: T.text, letterSpacing: -0.15, marginBottom: 3},
  modSub: {fontFamily: BravoFont.sans, fontSize: 12.5, color: T.textDim, letterSpacing: -0.1},
  pill: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999, borderWidth: 1},
  pillViolet: {backgroundColor: 'rgba(167,139,250,0.15)', borderColor: T.tintVioletBd},
  pillIndigo: {backgroundColor: 'rgba(129,140,248,0.12)', borderColor: T.tintIndigoBd},
  pillText: {fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.1, textTransform: 'uppercase'},
  pillTextViolet: {color: T.tintVioletIc},
  pillTextIndigo: {color: T.tintIndigoIc},
  dotBlue: {width: 8, height: 8, borderRadius: 4, backgroundColor: T.accent, marginRight: 4,
    shadowColor: T.accent, shadowOpacity: 1, shadowRadius: 10, shadowOffset: {width: 0, height: 0}, elevation: 4},

  // Activity
  actRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 13, paddingHorizontal: 4},
  actRowBorder: {borderBottomWidth: 1, borderBottomColor: T.hair},
  actDot: {width: 8, height: 8, borderRadius: 4, shadowOffset: {width: 0, height: 0}, elevation: 4},
  actTitle: {fontFamily: BravoFont.sans, fontSize: 13.5, fontWeight: '500', color: T.text, letterSpacing: -0.1, marginBottom: 2},
  actMeta:  {fontFamily: BravoFont.mono, fontSize: 10.5, color: T.textMute, letterSpacing: 0.3},
  actTime:  {fontFamily: BravoFont.mono, fontSize: 10.5, color: T.textMute, letterSpacing: 0.3},

  // Operator status strip — faint green "secure" tint card
  opStrip: {
    marginHorizontal: 18, marginTop: 12, paddingHorizontal: 16, paddingVertical: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: 'rgba(74,222,128,0.05)',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.18)',
    borderRadius: 14,
    position: 'relative', overflow: 'hidden',
  },
  opEdge: {position: 'absolute', top: 0, left: 16, right: 16, height: 1, backgroundColor: 'rgba(255,255,255,0.10)'},
  opDotOuter: {width: 10, height: 10, borderRadius: 5, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)'},
  opDotInner: {width: 8, height: 8, borderRadius: 4, backgroundColor: T.signal,
    shadowColor: T.signal, shadowOpacity: 1, shadowRadius: 10, elevation: 5},
  opLabel: {fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '600', color: T.signal, letterSpacing: 1.4, textTransform: 'uppercase'},
  opSub:   {fontFamily: BravoFont.sans, fontSize: 11, color: T.textMute, marginTop: 2},
  opClock: {fontFamily: BravoFont.mono, fontSize: 13, color: T.text, fontWeight: '600', letterSpacing: 0.5},
  opZone:  {fontFamily: BravoFont.mono, fontSize: 9, color: T.textMute, letterSpacing: 0.8, marginTop: 2},
}));

// ─── Styles ───────────────────────────────────────────────────────────────────
const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},
  scroll: {flex: 1},
  scrollContent: {paddingTop: 0},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 22, paddingTop: 16, paddingBottom: 14,
  },
  headerLogo: {flexDirection: 'row', alignItems: 'center', gap: 10},
  headerTitle: {fontFamily: BravoFont.display, fontWeight: '700', fontSize: 20, color: T.text, letterSpacing: 2.4, lineHeight: 20},
  headerSubtitle: {fontFamily: BravoFont.mono, fontSize: 8.5, color: T.textMute, letterSpacing: 1.2, marginTop: 3, textTransform: 'uppercase'},
  headerRight: {flexDirection: 'row', alignItems: 'center', gap: 10},
  headerBtn: {position: 'relative', width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: T.hair2, alignItems: 'center', justifyContent: 'center'},
  notifDot: {position: 'absolute', top: 8, right: 8, width: 7, height: 7, borderRadius: 4, backgroundColor: T.alert,
    shadowColor: T.alert, shadowOpacity: 1, shadowRadius: 8, elevation: 4},
  avatar: {width: 36, height: 36, borderRadius: 18, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', alignItems: 'center', justifyContent: 'center'},
  avatarText: {color: '#fff', fontSize: 13, fontWeight: '700', letterSpacing: 0.3},

  // Status badge (legacy fallback — kept for backward-compat refs)
  statusWrap: {alignItems: 'center', paddingVertical: 12},
  statusBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 5, borderRadius: 99, backgroundColor: 'rgba(16,185,129,0.1)', borderWidth: 1, borderColor: 'rgba(16,185,129,0.2)'},
  statusDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#10B981'},
  statusText: {color: '#10B981', fontSize: 11, fontWeight: '800', letterSpacing: 1.5},

  // Tiles container
  tilesWrap: {paddingHorizontal: 18, paddingTop: 18, gap: 10, marginBottom: 4},
  // Services section header — "Services" label + "3 ACTIVE" count, per
  // the Command Home design (vbg-command-home.jsx §Services).
  servicesHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 2, paddingBottom: 2},
  servicesCount: {fontFamily: BravoFont.mono, fontSize: 9, color: T.textMute, letterSpacing: 1},
  // Legacy tile styles kept so any external references don't break; new
  // cards use PremiumModuleCard which has its own styles in `p`.
  tile: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.cardSolid, borderRadius: 12, borderWidth: 1, borderColor: T.hair, borderLeftWidth: 4, padding: 14},
  tileIcon: {width: 40, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center'},
  tileBody: {flex: 1},
  tileTitle: {color: T.text, fontSize: 13, fontWeight: '700'},
  tileDesc: {color: T.textDim, fontSize: 11, marginTop: 1},
  tileBadgeWrap: {flexDirection: 'row', alignItems: 'center', gap: 6},
  unreadBadge: {backgroundColor: '#7C3AED', borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2},
  unreadText: {color: '#FFF', fontSize: 9, fontWeight: '800', letterSpacing: 0.5},
  activeDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: T.accent},
  vbgBadge: {borderRadius: 99, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: 'rgba(99,102,241,0.1)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)'},
  vbgBadgeText: {color: '#A5B4FC', fontSize: 9, fontWeight: '800', letterSpacing: 0.5},

  // Recent Activity
  section: {paddingHorizontal: 22, paddingTop: 28},
  sectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 0, paddingBottom: 14},
  sectionLabel: {fontFamily: BravoFont.mono, color: T.textDim, fontSize: 10.5, fontWeight: '600', letterSpacing: 1.8, textTransform: 'uppercase'},
  sectionAction: {fontFamily: BravoFont.sans, color: T.textMute, fontSize: 11, fontWeight: '500'},
  activityList: {gap: 4},
  activityRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 10, backgroundColor: 'rgba(15,23,42,0.6)',
    borderRadius: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  activityDot: {width: 7, height: 7, borderRadius: 4},
  activityBody: {flex: 1},
  activityTitle: {color: T.text, fontSize: 12, fontWeight: '500'},
  activitySub: {color: T.textMute, fontSize: 10, marginTop: 1},
  activityTime: {color: T.textFaint, fontSize: 10, fontWeight: '500'},

  // SOS bar
  // BS-SOS — fixed emergency bar pinned under the header (replaces the old
  // floating FAB that overlaid the booking cards). Red gradient + white
  // edge-light + "!" badge per the Command Home design.
  sosBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 10,
    marginHorizontal: 16, marginTop: 8, marginBottom: 4,
    minHeight: 60, borderRadius: 18, overflow: 'hidden',
    shadowColor: 'rgba(211,35,57,0.42)', shadowOffset: {width: 0, height: 8}, shadowOpacity: 1, shadowRadius: 18, elevation: 8,
  },
  sosBarEdge: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(255,255,255,0.35)'},
  sosBarBadge: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center', justifyContent: 'center',
  },
  sosBarBadgeText: {color: '#D32339', fontSize: 15, fontWeight: '900', lineHeight: 18},
  sosBarText: {color: '#FFF', fontSize: 14, fontWeight: '900', letterSpacing: 1},

  // Notification drawer
  drawerOverlay: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  notifDrawer: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    height: '75%', backgroundColor: T.bgSoft,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    borderTopWidth: 1, borderTopColor: T.hair2,
    shadowColor: '#000', shadowOffset: {width: 0, height: -4}, shadowOpacity: 0.5, shadowRadius: 16, elevation: 20,
  },
  drawerHandle: {alignItems: 'center', paddingVertical: 10},
  drawerHandleBar: {width: 36, height: 4, borderRadius: 2, backgroundColor: T.hair2},
  drawerHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: T.hair},
  drawerTitle: {color: T.text, fontSize: 16, fontWeight: '700'},
  markAllRead: {color: T.accent, fontSize: 12, fontWeight: '600'},
  drawerScroll: {flex: 1, paddingHorizontal: 16, paddingTop: 12},
  notifItem: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 12, borderLeftWidth: 4, borderRadius: 10, marginBottom: 8,
  },
  notifIconWrap: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  notifBody: {flex: 1},
  notifTop: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 3},
  notifTitle: {color: T.text, fontSize: 13, fontWeight: '700', flex: 1},
  notifTime: {color: T.textMute, fontSize: 10, fontWeight: '600'},
  notifText: {color: T.textDim, fontSize: 12, lineHeight: 17},

  // Profile drawer
  profileOverlay: {flex: 1, flexDirection: 'row', backgroundColor: 'rgba(3,5,10,0.7)'},
  profileDrawer: {
    width: '82%', maxWidth: 320, backgroundColor: T.bgSoft,
    borderRightWidth: 1, borderRightColor: T.hair,
    flexDirection: 'column',
    shadowColor: '#000', shadowOffset: {width: 4, height: 0}, shadowOpacity: 0.5, shadowRadius: 20, elevation: 20,
  },
  profileUser: {paddingHorizontal: 20, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: T.hair, flexDirection: 'row', alignItems: 'center', gap: 14},
  profileAvatarWrap: {position: 'relative'},
  profileAvatar: {width: 56, height: 56, borderRadius: 28, overflow: 'hidden', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 2, borderColor: T.accent, alignItems: 'center', justifyContent: 'center'},
  profileAvatarImg: {width: '100%', height: '100%'},
  profileAvatarText: {color: T.accentSoft, fontSize: 18, fontWeight: '700'},
  onlineDot: {position: 'absolute', bottom: 1, right: 1, width: 12, height: 12, borderRadius: 6, backgroundColor: T.signal, borderWidth: 2, borderColor: T.bgSoft},
  profileUserInfo: {flex: 1},
  profileNameRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4},
  profileName: {color: T.text, fontSize: 15, fontWeight: '700'},
  roleBadge: {backgroundColor: 'rgba(91,141,239,0.15)', borderRadius: 99, paddingHorizontal: 8, paddingVertical: 2, borderWidth: 1, borderColor: T.tintBlueBd},
  roleBadgeText: {color: T.accentSoft, fontSize: 10, fontWeight: '700', letterSpacing: 0.5},
  editProfile: {color: T.accent, fontSize: 12, fontWeight: '600'},
  profileMenu: {flex: 1, paddingHorizontal: 16, paddingTop: 8},
  menuItem: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 44, paddingHorizontal: 12, borderRadius: 12},
  menuItemLeft: {flexDirection: 'row', alignItems: 'center', gap: 12},
  menuItemLabel: {color: T.text, fontSize: 13, fontWeight: '600'},
  menuDivider: {height: 1, backgroundColor: T.hair, marginVertical: 6, marginHorizontal: 12},
  profileBottom: {padding: 16, borderTopWidth: 1, borderTopColor: T.hair},
  logoutBtn: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 12},
  logoutText: {color: T.alert, fontSize: 13, fontWeight: '700'},
  versionWrap: {alignItems: 'center', marginTop: 10, opacity: 0.4},
  versionStudio: {color: T.textDim, fontSize: 11, fontWeight: '600'},
  versionNum: {color: T.textMute, fontSize: 10},

  // SOS Modal
  sosModal: {flex: 1, backgroundColor: T.bg},
  sosInner: {flex: 1, backgroundColor: T.bg},
  sosModalHeader: {
    flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: T.hair,
  },
  sosBackBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  sosModalTitle: {color: T.text, fontWeight: '700', letterSpacing: 2, fontSize: 14, marginLeft: 8, flex: 1},
  sosActivatedTime: {color: 'rgba(252,165,165,0.7)', fontSize: 12},
  sosCenterContent: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 20},
  sosHeading: {color: T.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5},
  sosSubtitle: {color: T.textDim, fontSize: 13, textAlign: 'center'},
  sosHoldBtn: {
    width: 80, height: 80, borderRadius: 40,
    backgroundColor: '#DC2626', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#DC2626', shadowOffset: {width: 0, height: 8}, shadowOpacity: 0.6, shadowRadius: 20, elevation: 12,
  },
  sosHoldText: {color: '#FFF', fontSize: 18, fontWeight: '900'},
  sosInfoCards: {width: '100%', gap: 8},
  sosInfoCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 12, backgroundColor: 'rgba(91,141,239,0.06)',
    borderWidth: 1, borderColor: T.hair2, borderRadius: 12,
  },
  sosInfoTitle: {color: T.text, fontSize: 12, fontWeight: '700'},
  sosInfoSub: {color: T.textMute, fontSize: 10},
  sosCountdownWrap: {alignItems: 'center', justifyContent: 'center'},
  sosCountdownCircle: {
    width: 96, height: 96, borderRadius: 48,
    backgroundColor: '#B91C1C', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#DC2626', shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.6, shadowRadius: 24, elevation: 12,
  },
  sosCountdownNum: {color: '#FFF', fontSize: 40, fontWeight: '900'},
  sosReleaseText: {color: '#64748B', fontSize: 11, fontWeight: '700', letterSpacing: 2},
  sosActivatedIcon: {
    width: 160, height: 160, borderRadius: 80,
    backgroundColor: '#B91C1C', alignItems: 'center', justifyContent: 'center',
    shadowColor: '#DC2626', shadowOffset: {width: 0, height: 0}, shadowOpacity: 0.6, shadowRadius: 32, elevation: 14,
  },
  sosActivatedTitle: {color: '#FFF', fontSize: 28, fontWeight: '800', letterSpacing: -0.5},
  sosMapCard: {width: '100%', borderRadius: 12, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(153,27,27,0.4)'},
  sosMapHeader: {paddingHorizontal: 12, paddingVertical: 8, backgroundColor: 'rgba(127,29,29,0.8)', borderBottomWidth: 1, borderBottomColor: 'rgba(153,27,27,0.3)'},
  sosMapLabel: {color: '#FCA5A5', fontSize: 10, fontWeight: '700', letterSpacing: 1.5},
  sosMapBody: {height: 120, backgroundColor: '#1A0606', alignItems: 'center', justifyContent: 'center'},
  sosMapDot: {alignItems: 'center', justifyContent: 'center'},
  sosMapPing: {position: 'absolute', width: 20, height: 20, borderRadius: 10, backgroundColor: '#DC2626'},
  sosMapCenter: {width: 16, height: 16, borderRadius: 8, backgroundColor: '#DC2626', borderWidth: 2, borderColor: '#FFF'},
  cancelSosBtn: {
    width: '100%', borderWidth: 2, borderColor: 'rgba(239,68,68,0.4)',
    borderRadius: 14, paddingVertical: 14, alignItems: 'center',
  },
  cancelSosText: {color: '#FCA5A5', fontSize: 13, fontWeight: '700', letterSpacing: 2},
}));

// N-19 — relative timestamp + row styling for the notification drawer's
// activity rows (populated by recordActivity on each server-event wake).
function relNotifTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60_000);
  if (m < 1) {return 'now';}
  if (m < 60) {return `${m}m`;}
  const h = Math.floor(m / 60);
  if (h < 24) {return `${h}h`;}
  return `${Math.floor(h / 24)}d`;
}

const notifRowStyles = StyleSheet.create(scaleTextStyles({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 12, paddingHorizontal: 16,
    borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)',
  },
  unreadDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#5B8DEF'},
  title: {color: '#E8ECF4', fontSize: 13, fontWeight: '700'},
  subtitle: {color: 'rgba(232,236,244,0.6)', fontSize: 12, marginTop: 2},
  time: {color: 'rgba(232,236,244,0.4)', fontSize: 11},
}));
