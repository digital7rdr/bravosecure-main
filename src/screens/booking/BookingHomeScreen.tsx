import React, {useCallback, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar, Image, useWindowDimensions,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@/theme/bravo';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';

// Obsidian design palette (Bravo Secure Home handoff) — deep #07090D base +
// platinum-cobalt accent, replacing the app-wide Command Navy on this screen.
const B = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  glow:       '#A9C5FF',
  amber:      '#E2C893',
} as const;
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useBookingStore} from '@store/bookingStore';
import {describeStatus, findResumableBooking, isUpcomingScheduled, resumeTargetFor} from './bookingStatus';
import {scaleTextStyles} from '@utils/scaling';
import {regionDef} from '@utils/regions';
import {MapPrewarm} from '@/modules/booking/MapPrewarm';
import {useAuthStore} from '@store/authStore';
import {useSecureProStore} from '@store/secureProStore';
import {PRO_STATUS_META} from '@screens/securepro/proStatus';
import {ProfileDrawerModal} from '@components/ProfileDrawerModal';
import ActivityBell from '@components/ActivityBell';
import {navigateOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

type BookingRow = {
  id: string;
  status?: string;
  // LB-ST1 — the live mission phase (DISPATCHED/PICKUP/LIVE), surfaced on the
  // list row after the backend fix so the dashboard reflects mission progress
  // (the booking status itself stays CONFIRMED for the whole mission).
  mission_status?: string | null;
  // B-405 — 'later' rows pre-dispatch are upcoming reservations, not active
  // missions; dispatch_mode tells a parked auto reservation apart from a
  // legacy approved one that owes payment.
  booking_mode?: 'now' | 'later' | null;
  dispatch_mode?: string | null;
  type?: string;
  service?: string;
  start_time?: string;
  created_at?: string;
  total_price?: number;
  total_eur?: number;
  estimated_price?: number;
};

function formatDate(iso: string | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  // UTC so the date matches the backend/ops value regardless of device tz.
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

// B-405 — upcoming reservations need the start TIME too, in the same
// UTC-suffixed format the review screen uses (Wed 12 Aug · 14:30Z). Far-out
// reservations get the year — "book two weeks ahead" makes them first-class.
function formatDateTime(iso: string | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  const withYear = d.getUTCFullYear() !== new Date().getUTCFullYear();
  return d.toLocaleDateString('en-GB', {
    weekday: 'short', day: '2-digit', month: 'short',
    ...(withYear ? {year: 'numeric'} : {}), timeZone: 'UTC',
  }) + ` · ${d.getUTCHours().toString().padStart(2, '0')}:${d.getUTCMinutes().toString().padStart(2, '0')}Z`;
}

function rowLabel(b: BookingRow): string {
  const svc = b.service ?? b.type ?? 'Booking';
  return svc
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

function rowCredits(b: BookingRow): number {
  return b.total_price ?? b.total_eur ?? b.estimated_price ?? 0;
}

function shortRef(id: string): string {
  // Match the ops console — last 12 chars of the dash-stripped UUID, so
  // a booking that shows as `5446C42D8CFF` on the ops side reads the
  // same here.
  return 'BL-' + id.replace(/-/g, '').slice(-12).toUpperCase();
}

const FEATURES = [
  {icon: 'shield-lock', label: 'AES-256', sub: 'Encrypted', img: Imagery.trustEncryption},
  {icon: 'account-tie', label: 'Vetted', sub: 'CPOs', img: Imagery.trustVettedCpos},
  {icon: 'map-marker-check', label: 'Live', sub: 'Tracking', img: Imagery.trustLiveTracking},
  {icon: 'phone-lock', label: 'Secure', sub: 'Comms', img: Imagery.trustSecureComms},
] as const;

const STEPS = [
  {n: '01', title: 'Select Service', desc: 'Choose Transfer or Time Slot protection'},
  {n: '02', title: 'Set Location', desc: 'Pick up and drop-off or time window'},
  {n: '03', title: 'Add-Ons', desc: 'Enhance with additional resources'},
  {n: '04', title: 'Pay & Confirm', desc: 'Pay with Bravo Credits or card'},
] as const;

// Top edge-light — the 1px gradient highlight that sits across the top of
// every premium card, matching the design handoff's edge-lit card recipe.
function EdgeLight() {
  return (
    <LinearGradient
      colors={['transparent', 'rgba(255,255,255,0.13)', 'transparent']}
      start={{x: 0, y: 0}}
      end={{x: 1, y: 0}}
      style={styles.edgeLight}
      pointerEvents="none"
    />
  );
}

export default function BookingHomeScreen() {
  /**
   * B-660 — the header sizes itself from the LIVE window width.
   *
   * Why measured rather than a fixed size + `adjustsFontSizeToFit`: that prop's
   * companion `minimumFontScale` is ignored under the New Architecture and the
   * auto-fit itself is unreliable on Android/Fabric (see the note at the title).
   * A width band is deterministic, identical on both platforms, and immune to
   * both bugs.
   *
   * `useWindowDimensions` rather than the module-level `Dimensions` read in
   * `utils/scaling.ts`: that one is captured once at import, so a foldable that
   * boots folded keeps the narrow value forever. This reflows live.
   *
   * The bands are deliberately conservative — the worst case this row has to
   * survive is a PRO account whose badge reads "PRO · FAMILY" (~3x the width of
   * "LITE"), which is very likely why the same build clipped for one tester and
   * not another: it is the ACCOUNT TIER, not the device.
   */
  const {width: winW} = useWindowDimensions();
  const headerTitleSize = winW >= 430 ? 15 : winW >= 400 ? 13.5 : winW >= 360 ? 12 : 11;
  /** Below this the region chip drops its text and shows the flag alone. */
  const compactRegion = winW < 390;

  const insets = useSafeAreaInsets();
  const {bottomPad, contentBottom} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const bookings = useBookingStore(s => s.bookings) as unknown as BookingRow[];
  const isLoading = useBookingStore(s => s.isLoading);
  const loadBookings = useBookingStore(s => s.loadBookings);
  // B-90 T-07 — the header chip mirrors the region picked in ZoneMap
  // (draft.zone_code) instead of a hardcoded UAE flag.
  const draftZone = useBookingStore(s => s.draft.zone_code);
  const chipRegion = regionDef(draftZone) ?? regionDef('AE')!;
  // B-91 M3 R3 — top-left profile control → shared drawer.
  const user = useAuthStore(s => s.user);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Bravo Secure Pro — surfaces the "My Pro Application" row once one exists.
  const proApplication = useSecureProStore(s => s.application);
  const loadProApplication = useSecureProStore(s => s.loadApplication);
  // Bookings the user has already been routed to — once they navigate back to
  // Home, we don't auto-bounce them again, even if another resumable row exists.
  // LM-U6 — persisted (was in-memory only, so EVERY app restart force-yanked the
  // user back into the in-flight booking the moment Home focused).
  const seenRef = useRef<Set<string>>(new Set());
  const seenHydrated = useRef(false);

  // NAV-20 (2026-08-26 audit) — one live run at a time: rapid back/forward
  // re-fires this focus effect per entry, and each run issued its own
  // AsyncStorage read + loadBookings; the concurrent setState bursts all
  // landed after the transition. A focus during a live run skips (that run's
  // resume check already covers it); the cancelled flag still ends each run's
  // effects on blur.
  const focusRunRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      // LB-ST1 — while an in-flight booking is on screen, refresh it on a slow
      // cadence so the hero/status chip advance without needing a blur/focus. The
      // dashboard previously only reloaded on focus, so a user sitting on Home saw
      // a frozen "Mission in Progress" for the whole detail.
      let poll: ReturnType<typeof setInterval> | null = null;
      const DASH_POLL_MS = 8000;
      void (async () => {
        // The poll below must arm on EVERY focus; only the load + resume
        // check is deduped, so a quick re-entry keeps its refresh cadence.
        const firstRun = !focusRunRef.current;
        if (firstRun) {focusRunRef.current = true;}
        try {
        if (firstRun) {
          if (!seenHydrated.current) {
            try {
              const raw = await AsyncStorage.getItem('booking:resume-seen');
              if (raw) {for (const id of JSON.parse(raw) as string[]) {seenRef.current.add(id);}}
            } catch { /* first run / corrupt — fall through with an empty set */ }
            seenHydrated.current = true;
          }
          // One-shot refresh of the Pro application row (no poll — the status
          // screen owns live updates).
          void loadProApplication();
          await loadBookings();
        }
        if (cancelled) {return;}
        // Keep refreshing while focused; the resume-navigation below runs only
        // once (outside this interval) so we never yank the user on every tick.
        poll = setInterval(() => { void loadBookings(); }, DASH_POLL_MS);
        if (!firstRun) {return;}
        const list = useBookingStore.getState().bookings as unknown as BookingRow[];
        const resumable = findResumableBooking(list, seenRef.current);
        // NAV-20 — the isFocused check: this lands after two awaits, so under
        // rapid back/forward it used to navigate DURING a transition away from
        // this screen.
        if (resumable && navigation.isFocused()) {
          seenRef.current.add(resumable.id);
          void AsyncStorage.setItem(
            'booking:resume-seen',
            JSON.stringify([...seenRef.current].slice(-20)),
          ).catch(() => undefined);
          const target = resumeTargetFor(resumable.id, resumable.status, resumable.mission_status);
          if (target?.screen === 'BookingConfirmation') {
            navigation.navigate('BookingConfirmation', {
              bookingId: target.bookingId,
              amountPaid: rowCredits(resumable),
              currency: 'BC',
              paymentMethod: 'bravo_credits',
              creditsAwarded: 0,
            });
          } else if (target?.screen === 'LiveTracking') {
            navigation.navigate('LiveTracking', {bookingId: target.bookingId});
          } else if (target?.screen === 'OpsRoomReview') {
            navigation.navigate('OpsRoomReview', {bookingId: target.bookingId});
          } else if (target?.screen === 'FindingDetail') {
            // Step 19 — a live auto search must resume into the Finding poll, not
            // dead-end. (NO_PROVIDER is terminal + excluded from findResumableBooking.)
            navigation.navigate('FindingDetail', {bookingId: target.bookingId});
          }
        }
        } finally { if (firstRun) {focusRunRef.current = false;} }
      })();
      return () => { cancelled = true; if (poll) {clearInterval(poll);} };
    }, [loadBookings, loadProApplication, navigation]),
  );

  // One-mission-at-a-time: if any booking is between submission and live,
  // turn the Hero "Book Now" into a "View active mission" CTA so the user
  // can't queue up a second booking on top of an in-flight one.
  // B-405 — a parked FUTURE reservation ('later' + PENDING_OPS/OPS_APPROVED)
  // is NOT an active mission: it renders as an upcoming card below and must
  // not steal the hero, so the client can still book go-now (the server-side
  // guard exempts it the same way).
  const activeBooking = bookings.find(b => {
    if (isUpcomingScheduled(b)) {return false;}
    const s = (b.status ?? '').toUpperCase();
    // DISPATCHING (auto search in progress) is an active mission too — without it the
    // Home hero would offer "Book Now" mid-search and let the user queue a 2nd booking.
    return s === 'DISPATCHING' || s === 'PENDING_OPS' || s === 'OPS_APPROVED' || s === 'PAYMENT_PENDING' || s === 'CONFIRMED' || s === 'LIVE';
  });
  const activeStatus = activeBooking ? describeStatus(activeBooking.status) : null;
  // Soonest first — list order is created_at DESC, which would bury the next
  // departure below newer reservations.
  const upcomingBookings = bookings
    .filter(isUpcomingScheduled)
    .slice()
    .sort((a, b) => new Date(a.start_time ?? 0).getTime() - new Date(b.start_time ?? 0).getTime());

  const goToBooking = (b: BookingRow) => {
    const target = resumeTargetFor(b.id, b.status, b.mission_status);
    if (target?.screen === 'BookingConfirmation') {
      navigation.navigate('BookingConfirmation', {
        bookingId: target.bookingId,
        amountPaid: rowCredits(b),
        currency: 'BC',
        paymentMethod: 'bravo_credits',
        creditsAwarded: 0,
      });
    } else if (target?.screen === 'LiveTracking') {
      navigation.navigate('LiveTracking', {bookingId: target.bookingId});
    } else if (target?.screen === 'OpsRoomReview') {
      navigation.navigate('OpsRoomReview', {bookingId: target.bookingId});
    } else if (target?.screen === 'FindingDetail') {
      navigation.navigate('FindingDetail', {bookingId: target.bookingId});
    } else if (target?.screen === 'NoDetail') {
      navigation.navigate('NoDetail', {bookingId: target.bookingId});
    } else {
      // Terminal status (COMPLETED / CANCELLED) — show the read-only summary.
      navigation.navigate('TripSummary', {bookingId: b.id});
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={B.bg} />
      <AmbientBg bg={B.bg} />

      {/* Header — B-91 M3 R1/R3: product title "SECURE SERVICES" + the
          top-left profile control every product carries (opens the shared
          drawer with Switch Dashboard). Plan badge + region chip stay. */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity
            style={styles.headerAvatar}
            activeOpacity={0.75}
            accessibilityRole="button"
            accessibilityLabel="Open profile drawer"
            onPress={() => setDrawerOpen(true)}>
            {user?.avatar_url ? (
              <Image source={{uri: user.avatar_url}} style={styles.headerAvatarImg} />
            ) : (
              <Text style={styles.headerAvatarText}>
                {(user?.full_name ?? user?.email ?? 'B').slice(0, 2).toUpperCase()}
              </Text>
            )}
          </TouchableOpacity>
          {/**
           * B-660 — the title sizes itself from the MEASURED window, and does
           * NOT rely on `adjustsFontSizeToFit`.
           *
           * B-657 reclaimed width and added `adjustsFontSizeToFit` +
           * `minimumFontScale` as the safety net. Researching the follow-up
           * report showed that net does not exist on this stack:
           *   • `minimumFontScale` is IGNORED under the New Architecture, on
           *     BOTH platforms (facebook/react-native#50248, still open). The
           *     floor silently does not apply, so the text can shrink to
           *     illegible rather than stopping at 85%.
           *   • `adjustsFontSizeToFit` has a long Android/Fabric history of
           *     not resizing — and of rendering NOTHING (#43104, #44075), and
           *     of collapsing to the minimum on some Samsung builds (#32258).
           * `android/gradle.properties` sets `newArchEnabled=true`, so this app
           * is squarely in that path. Depending on it is why the same build
           * clipped on one device and not another.
           *
           * `maxFontSizeMultiplier` is kept — tighter (1.2) than the app-wide 1.3
           * ceiling, which since B-680 is patched directly into RN's Text
           * (patches/react-native+0.81.5.patch; the old defaultProps route in
           * utils/textDefaults.ts was inert under React 19).
           */}
          <Text
            style={[styles.headerTitle, {fontSize: headerTitleSize}]}
            numberOfLines={1}
            maxFontSizeMultiplier={1.2}>
            SECURE SERVICES
          </Text>
          {/* Dynamic plan chip: PRO while a Secure Pro plan is active (own or
              via a family owner), LITE otherwise — flips back on expiry. This
              is the SECURE plan, independent of the messenger subscription
              tier shown in Settings → Pricing. */}
          {proApplication?.status === 'ACTIVE' ? (
            <View style={styles.proBadge}>
              {/* B-660 - numberOfLines so the widest tier label (PRO · FAMILY,
                  roughly 3x LITE) truncates itself instead of pushing the
                  title. This is the likeliest reason the same build clipped
                  for a PRO tester and not a LITE one. */}
              <Text style={styles.proBadgeText} numberOfLines={1} maxFontSizeMultiplier={1.2}>
                {proApplication.via_owner ? 'PRO · FAMILY' : 'PRO'}
              </Text>
            </View>
          ) : (
            <View style={styles.liteBadge}><Text style={styles.liteBadgeText} numberOfLines={1} maxFontSizeMultiplier={1.2}>LITE</Text></View>
          )}
        </View>
        {/* N-18/GAP-3 — the durable-inbox bell, finally mounted. */}
        <ActivityBell onPress={() => navigateOnce(navigation, 'ActivityCenter')} />
        {/* Audit fix 3.1 — wire the region chip to the ZoneMap picker.
             ZoneMap is the canonical region selector and now reads live
             availability from /bookings/regions/availability. */}
        <TouchableOpacity
          style={styles.regionBtn}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel={`Change region, currently ${chipRegion.name}`}
          onPress={() => navigateOnce(navigation, 'ZoneMap')}>
          <Text style={styles.flagText}>{chipRegion.flag}</Text>
          {/* B-660 - on a narrow screen the flag alone carries the region and
              the accessibilityLabel above still names it in full, so nothing
              is lost to a screen reader. Reclaims ~24dp exactly where it is
              scarcest. */}
          {!compactRegion && (
            <Text style={styles.regionText} numberOfLines={1} maxFontSizeMultiplier={1.2}>{chipRegion.badge}</Text>
          )}
          <Icon name="chevron-down" size={14} color={B.textMute} />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingBottom: contentBottom(96)}}>

        {/* Mission hero */}
        <View style={styles.heroWrap}>
          <LinearGradient
            colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
            start={{x: 0.5, y: 0}}
            end={{x: 0.5, y: 1}}
            style={styles.heroCard}>
            {/* Brand imagery behind the hero — the mission photo when a detail is
                live, the close-protection photo when the client is booking. */}
            <ImageryBackdrop
              source={activeBooking ? Imagery.heroMissionActive : Imagery.heroBookProtection}
              variant="hero"
              radius={22}
            />
            <EdgeLight />

            <LinearGradient
              colors={['rgba(91,141,239,0.2)', 'rgba(47,91,224,0.08)']}
              start={{x: 0.2, y: 0}}
              end={{x: 0.9, y: 1}}
              style={styles.heroIconWrap}>
              <Icon name={activeBooking ? 'shield-sync' : 'shield-plus'} size={32} color={B.glow} />
            </LinearGradient>

            <Text style={styles.heroTitle}>
              {activeBooking ? 'Mission in Progress' : 'Book Close Protection'}
            </Text>

            {activeBooking && activeStatus ? (
              <View style={styles.heroStatusRow}>
                <View style={[styles.heroPill, {
                  backgroundColor: activeStatus.color + '1A',
                  borderColor: activeStatus.color + '4D',
                }]}>
                  <Text style={[styles.heroPillText, {color: activeStatus.color}]}>
                    {activeStatus.label}
                  </Text>
                </View>
                <Text style={styles.heroSub}>One mission at a time</Text>
              </View>
            ) : (
              <Text style={[styles.heroSub, styles.heroSubBlock]}>
                Executive transport · VIP security · Personal protection
              </Text>
            )}

            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => {
                if (activeBooking) {goToBooking(activeBooking);}
                // Why (Wave 5a A2): Book Now skips the zone-first step and goes
                // straight to service selection — zone_code defaults to AE in
                // bookingStore.defaultDraft, and the header region chip still
                // opens ZoneMap to change it. Zone folds into the dashboard in 5b.
                else {navigateOnce(navigation, 'ServiceType');}
              }}>
              <LinearGradient
                colors={['#6E9BF5', B.accent, B.accentDeep]}
                locations={[0, 0.55, 1]}
                start={{x: 0.1, y: 0}}
                end={{x: 0.9, y: 1}}
                style={styles.heroBtn}>
                <Icon name={activeBooking ? 'crosshairs-gps' : 'plus'} size={18} color="#FFF" />
                <Text style={styles.heroBtnText}>
                  {activeBooking ? 'View Active Mission' : 'Book Now'}
                </Text>
              </LinearGradient>
            </TouchableOpacity>

            {/* Zone Map | My Credits split */}
            <View style={styles.quickActions}>
              <TouchableOpacity style={styles.quickBtn}
                hitSlop={{top: 10, bottom: 10, left: 8, right: 8}}
                accessibilityRole="button"
                onPress={() => navigateOnce(navigation, 'ZoneMap')} activeOpacity={0.8}>
                <Icon name="map-marker-radius" size={16} color={B.glow} />
                <Text style={styles.quickBtnText}>Zone Map</Text>
              </TouchableOpacity>
              <View style={styles.quickDivider} />
              <TouchableOpacity style={styles.quickBtn}
                hitSlop={{top: 10, bottom: 10, left: 8, right: 8}}
                accessibilityRole="button"
                onPress={() => navigateOnce(navigation, 'Credits')} activeOpacity={0.8}>
                <Icon name="star-four-points" size={16} color={B.amber} />
                <Text style={styles.quickBtnText}>My Credits</Text>
              </TouchableOpacity>
            </View>
          </LinearGradient>
        </View>

        {/* B-405 — upcoming scheduled reservations. Parked 'later' bookings live
            here (not in the hero): the client keeps Book Now and can run a
            go-now detail alongside. Tap resumes into OpsRoomReview, which now
            renders the scheduled/approved state instead of a fake "pending". */}
        {upcomingBookings.length > 0 && (
          <View style={styles.section}>
            <Text style={styles.sectionLabel}>UPCOMING BOOKINGS</Text>
            <View style={styles.bookingList}>
              {upcomingBookings.slice(0, 3).map(b => {
                const display = describeStatus(b.status);
                const startLabel = formatDateTime(b.start_time);
                return (
                  <TouchableOpacity
                    key={b.id}
                    style={styles.bookingCard}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={`Upcoming booking ${shortRef(b.id)}, ${display.label}, starts ${startLabel}`}
                    onPress={() => goToBooking(b)}>
                    <EdgeLight />
                    <View style={styles.bookingLeft}>
                      <View style={styles.bookingIconWrap}>
                        <Icon name="calendar-clock" size={18} color={B.amber} />
                      </View>
                      <View style={styles.bookingMeta}>
                        <Text style={styles.bookingRef} numberOfLines={1}>{rowLabel(b)}</Text>
                        <Text style={styles.bookingType} numberOfLines={1}>Starts {startLabel}</Text>
                      </View>
                    </View>
                    <View style={styles.bookingRight}>
                      <View style={[styles.statusChip, {
                        backgroundColor: display.color + '14',
                        borderColor: display.color + '4D',
                      }]}>
                        <Text style={[styles.statusText, {color: display.color}]}>
                          {display.label}
                        </Text>
                      </View>
                      {rowCredits(b) > 0 && (
                        <Text style={styles.bookingCredits}>
                          {rowCredits(b).toLocaleString()}<Text style={styles.bookingCreditsUnit}> BC</Text>
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}
            </View>
          </View>
        )}

        {/* Trust strip */}
        <View style={styles.featuresRow}>
          {FEATURES.map(f => (
            <View key={f.label} style={styles.featureCell}>
              <ImageryBackdrop source={f.img} variant="tile" radius={15} />
              <View style={styles.featureIcon}>
                <Icon name={f.icon} size={18} color={B.glow} />
              </View>
              <Text style={styles.featureLabel}>{f.label}</Text>
              <Text style={styles.featureSub}>{f.sub}</Text>
            </View>
          ))}
        </View>

        {/* Bravo Secure plans — Pro / Executive chooser + live Pro
            application row once one exists. */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>PLANS & SERVICES</Text>
          <View style={{gap: 10, marginTop: 12}}>
            <TouchableOpacity
              style={styles.planCard}
              activeOpacity={0.8}
              accessibilityRole="button"
              accessibilityLabel="Bravo Secure Service — secure plans Pro and Bravo Secure Lux"
              onPress={() => navigateOnce(navigation, 'SecureServices')}>
              <EdgeLight />
              <View style={styles.planIconWrap}>
                <Icon name="shield-star" size={19} color={B.glow} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={styles.planTitle}>Bravo Secure Service</Text>
                <Text style={styles.planSub} numberOfLines={2}>
                  Secure plans: Pro & Bravo Secure Lux.
                </Text>
              </View>
              <Icon name="chevron-right" size={20} color={B.textMute} />
            </TouchableOpacity>

            {proApplication && (
              <TouchableOpacity
                style={styles.planCard}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel={`My Pro application, ${PRO_STATUS_META[proApplication.status].label}`}
                onPress={() => navigateOnce(navigation, 'SecureProStatus')}>
                <EdgeLight />
                <View style={styles.planIconWrap}>
                  <Icon name="file-document-outline" size={18} color={B.glow} />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.planTitle}>My Pro Application</Text>
                  <Text style={styles.planSub} numberOfLines={1}>Bravo Secure Pro</Text>
                </View>
                <View style={[styles.statusChip, {
                  backgroundColor: PRO_STATUS_META[proApplication.status].color + '14',
                  borderColor: PRO_STATUS_META[proApplication.status].color + '4D',
                }]}>
                  <Text style={[styles.statusText, {color: PRO_STATUS_META[proApplication.status].color}]}>
                    {PRO_STATUS_META[proApplication.status].label}
                  </Text>
                </View>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Recent Bookings */}
        <View style={styles.section}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionLabel}>RECENT BOOKINGS</Text>
            {/* LM-U8 — was a dead button. */}
            <TouchableOpacity activeOpacity={0.7}
              hitSlop={{top: 10, bottom: 10, left: 8, right: 8}}
              accessibilityRole="button"
              accessibilityLabel="View all bookings"
              onPress={() => navigateOnce(navigation, 'BookingHistory')}>
              <Text style={styles.viewAll}>View All</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.bookingList}>
            {bookings.length === 0 ? (
              isLoading ? null : (
                <View style={styles.emptyCard}>
                  <EdgeLight />
                  <Icon name="shield-outline" size={20} color={B.textMute} />
                  <Text style={styles.emptyText}>No bookings yet</Text>
                  <Text style={styles.emptySub}>Tap Book Now to schedule your first protection detail.</Text>
                </View>
              )
            ) : (
              // B-405 — upcoming reservations render in their own section
              // above; don't list the same booking twice.
              bookings.filter(b => !isUpcomingScheduled(b)).slice(0, 5).map(b => {
                const display = describeStatus(b.status);
                const date = formatDate(b.start_time ?? b.created_at);
                const credits = rowCredits(b);
                return (
                  <TouchableOpacity
                    key={b.id}
                    style={styles.bookingCard}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel={`Booking ${shortRef(b.id)}, ${display.label}, ${date}`}
                    onPress={() => goToBooking(b)}>
                    <EdgeLight />
                    <View style={styles.bookingLeft}>
                      <View style={styles.bookingIconWrap}>
                        <Icon name="shield-check" size={18} color={B.glow} />
                      </View>
                      <View style={styles.bookingMeta}>
                        <Text style={styles.bookingRef} numberOfLines={1}>{shortRef(b.id)}</Text>
                        <Text style={styles.bookingType} numberOfLines={1}>{rowLabel(b)} · {date}</Text>
                      </View>
                    </View>
                    <View style={styles.bookingRight}>
                      <View style={[styles.statusChip, {
                        backgroundColor: display.color + '14',
                        borderColor: display.color + '4D',
                      }]}>
                        <Text style={[styles.statusText, {color: display.color}]}>
                          {display.label}
                        </Text>
                      </View>
                      {credits > 0 && (
                        <Text style={styles.bookingCredits}>
                          {credits.toLocaleString()}<Text style={styles.bookingCreditsUnit}> BC</Text>
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })
            )}
          </View>
        </View>

        {/* How it works */}
        <View style={styles.section}>
          <Text style={styles.sectionLabel}>HOW IT WORKS</Text>
          <View style={styles.stepList}>
            {STEPS.map(step => (
              <View key={step.n} style={styles.stepRow}>
                <View style={styles.stepNum}><Text style={styles.stepNumText}>{step.n}</Text></View>
                <View style={styles.stepMeta}>
                  <Text style={styles.stepTitle}>{step.title}</Text>
                  <Text style={styles.stepDesc}>{step.desc}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      </ScrollView>

      {/* FAB — Book Now when idle, View Active Mission when one is in flight */}
      <TouchableOpacity
        style={[styles.fabWrap, {bottom: bottomPad(16)}]}
        accessibilityRole="button"
        accessibilityLabel={activeBooking ? 'View active mission' : 'Book now'}
        onPress={() => {
          if (activeBooking) {goToBooking(activeBooking);}
          // Why (Wave 5a A2): Book Now skips zone-first — see the hero CTA above.
          else {navigateOnce(navigation, 'ServiceType');}
        }}
        activeOpacity={0.85}>
        <LinearGradient
          colors={['#7FA8FF', B.accent, B.accentDeep]}
          locations={[0, 0.6, 1]}
          start={{x: 0.3, y: 0.2}}
          end={{x: 0.9, y: 1}}
          style={styles.fab}>
          <Icon name={activeBooking ? 'crosshairs-gps' : 'shield-plus'} size={24} color="#FFF" />
        </LinearGradient>
      </TouchableOpacity>

      {/* T-07 — invisible one-shot map warm-up so the location picker
          opens hot instead of cold-loading mapbox-gl from the network. */}
      <MapPrewarm countryCode={chipRegion.code} />

      <ProfileDrawerModal visible={drawerOpen} onClose={() => setDrawerOpen(false)} />
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: B.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 8, paddingBottom: 4},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 1, minWidth: 0},
  headerBadge: {width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  headerAvatar: {
    width: 32, height: 32, borderRadius: 16, overflow: 'hidden',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  headerAvatarImg: {width: 32, height: 32, borderRadius: 16},
  headerAvatarText: {color: '#A9C5FF', fontSize: 12, fontWeight: '800'},
  // B-657 - 16/1.5 rendered ~171dp for 15 uppercase chars and overflowed the
  // row. 13.5/0.6 is ~135dp and still reads as the product title.
  headerTitle: {color: B.text, fontFamily: BravoFont.extraBold, fontSize: 13.5, letterSpacing: 0.6, flexShrink: 1},
  liteBadge: {paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(91,141,239,0.13)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  liteBadgeText: {color: B.glow, fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1.2},
  proBadge: {paddingHorizontal: 7, paddingVertical: 3, borderRadius: 6, backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)'},
  proBadgeText: {color: '#4ADE80', fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1.2},
  regionBtn: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 6, borderRadius: 9, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: B.hair2},
  flagText: {fontSize: 14},
  regionText: {color: B.textDim, fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '700', letterSpacing: 0.8},

  edgeLight: {position: 'absolute', top: 0, left: 16, right: 16, height: 1},

  // Mission hero
  heroWrap: {paddingHorizontal: 20, paddingTop: 16},
  heroCard: {borderRadius: 22, paddingTop: 24, paddingBottom: 20, paddingHorizontal: 20, borderWidth: 1, borderColor: B.hair2, overflow: 'hidden'},
  heroIconWrap: {width: 64, height: 64, borderRadius: 18, alignSelf: 'center', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)'},
  heroTitle: {color: B.text, fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.6, textAlign: 'center', marginTop: 16},
  heroStatusRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, marginTop: 9},
  heroPill: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  heroPillText: {fontFamily: BravoFont.mono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1},
  heroSub: {color: B.textMute, fontFamily: BravoFont.regular, fontSize: 12},
  heroSubBlock: {textAlign: 'center', marginTop: 9, lineHeight: 18},
  heroBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11, height: 56, borderRadius: 16, marginTop: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)', shadowColor: B.accent, shadowOffset: {width: 0, height: 12}, shadowOpacity: 0.4, shadowRadius: 24, elevation: 8},
  heroBtnText: {color: '#FFF', fontFamily: BravoFont.bold, fontSize: 16.5, letterSpacing: 0.2},
  quickActions: {flexDirection: 'row', alignItems: 'center', marginTop: 18},
  quickBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, paddingVertical: 4},
  quickDivider: {width: 1, height: 26, backgroundColor: B.hair2},
  quickBtnText: {color: B.textDim, fontFamily: BravoFont.semiBold, fontSize: 13.5},

  // Trust strip
  featuresRow: {flexDirection: 'row', gap: 9, paddingHorizontal: 20, marginTop: 14},
  featureCell: {flex: 1, alignItems: 'center', gap: 8, paddingVertical: 14, paddingHorizontal: 6, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: B.hair},
  featureIcon: {width: 38, height: 38, borderRadius: 11, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)', alignItems: 'center', justifyContent: 'center'},
  featureLabel: {color: B.text, fontFamily: BravoFont.bold, fontSize: 11.5, letterSpacing: -0.1},
  featureSub: {color: B.textMute, fontFamily: BravoFont.mono, fontSize: 8, letterSpacing: 0.6, textTransform: 'uppercase'},

  // Sections
  section: {paddingHorizontal: 20, marginTop: 20},
  sectionHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12},
  sectionLabel: {color: B.textDim, fontFamily: BravoFont.mono, fontSize: 10, fontWeight: '600', letterSpacing: 2, textTransform: 'uppercase'},
  viewAll: {color: B.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12.5},

  bookingList: {gap: 10},
  emptyCard: {alignItems: 'center', justifyContent: 'center', borderRadius: 16, paddingVertical: 24, paddingHorizontal: 16, gap: 6, backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: B.hair, overflow: 'hidden'},
  emptyText: {color: B.textDim, fontFamily: BravoFont.bold, fontSize: 13},
  emptySub: {color: B.textMute, fontFamily: BravoFont.regular, fontSize: 11, textAlign: 'center'},
  bookingCard: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 14, paddingHorizontal: 15, paddingVertical: 14, borderRadius: 16, backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: B.hair, overflow: 'hidden'},
  bookingLeft: {flexDirection: 'row', alignItems: 'center', gap: 14, flex: 1, minWidth: 0},
  bookingIconWrap: {width: 44, height: 44, borderRadius: 13, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)', alignItems: 'center', justifyContent: 'center'},
  bookingMeta: {flex: 1, minWidth: 0},
  bookingRef: {color: B.text, fontFamily: BravoFont.mono, fontSize: 13.5, fontWeight: '700', letterSpacing: 0.3},
  bookingType: {color: B.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 4},
  bookingRight: {alignItems: 'flex-end', gap: 7, flexShrink: 0, maxWidth: '46%'},
  statusChip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  statusText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1, flexShrink: 1},
  bookingCredits: {color: B.glow, fontFamily: BravoFont.bold, fontSize: 14.5, letterSpacing: -0.2},
  bookingCreditsUnit: {color: B.textMute, fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '600'},

  // Plans & services
  planCard: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    paddingHorizontal: 15, paddingVertical: 14, borderRadius: 16,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: B.hair,
    overflow: 'hidden',
  },
  planIconWrap: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  planTitle: {color: B.text, fontFamily: BravoFont.bold, fontSize: 13.5},
  planSub: {color: B.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 3},

  // How it works
  stepList: {gap: 12, marginTop: 4},
  stepRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 14},
  stepNum: {width: 32, height: 32, borderRadius: 9, backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)', alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  stepNumText: {color: B.glow, fontFamily: BravoFont.mono, fontSize: 11, fontWeight: '800'},
  stepMeta: {flex: 1, minWidth: 0},
  stepTitle: {color: B.text, fontFamily: BravoFont.bold, fontSize: 13},
  stepDesc: {color: B.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},

  // FAB
  fabWrap: {position: 'absolute', right: 22, shadowColor: B.accent, shadowOffset: {width: 0, height: 14}, shadowOpacity: 0.45, shadowRadius: 28, elevation: 10},
  fab: {width: 60, height: 60, borderRadius: 30, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
}));
