import React, {useCallback, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@/theme/bravo';
import LoadingView from '@components/LoadingView';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {agentApi, bookingApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {resumeTargetFor, type ResumeTarget} from '@screens/booking/bookingStatus';
import type {Booking} from '@appTypes/index';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const PRO_INDIGO = '#5B8DEF';
const PRO_INDIGO_LIGHT = '#7FA8FF';

const T = {
  bg:        '#07090D',
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  accent:    '#5B8DEF',
  blue:      '#A9C5FF',
  card:      'rgba(18,22,30,0.85)',
} as const;

type TripTag = 'completed' | 'incident' | 'ongoing';
type FilterType = 'all' | TripTag;

interface TripItem {
  id: string;
  title: string;
  meta: string;
  credits: string;
  riskTag: {label: string; color: string; bg: string};
  status: string;
  tag: TripTag[];
  progressColor?: string;
  borderLeft?: string;
  ongoing?: boolean;
  target?: ResumeTarget | null;
}

function toTrip(m: {
  mission_id: string; short_code: string; status: string; role: string;
  pickup_address: string; dropoff_address: string | null; region_label: string | null;
  paid_credits: number | null;
}): TripItem {
  const route = m.dropoff_address ? `${m.pickup_address} → ${m.dropoff_address}` : m.pickup_address;
  const status = (m.status || '').toUpperCase();
  const incident = status === 'ABORTED';
  return {
    id: m.mission_id,
    title: route || m.short_code,
    meta: [m.role, m.region_label].filter(Boolean).join(' · '),
    credits: typeof m.paid_credits === 'number' ? `${m.paid_credits.toLocaleString()} BC` : '—',
    riskTag: incident
      ? {label: 'INCIDENT', color: '#fca5a5', bg: 'rgba(239,68,68,0.15)'}
      : {label: status || 'DONE', color: '#86efac', bg: 'rgba(34,197,94,0.1)'},
    status,
    tag: [status === 'COMPLETED' ? 'completed' : null, incident ? 'incident' : null].filter(Boolean) as ('completed' | 'incident')[],
    progressColor: incident ? '#ef4444' : PRO_INDIGO,
    borderLeft: incident ? '#ef4444' : undefined,
  };
}

// Client bookings → trip cards. Ongoing (resumable) bookings get a blue badge
// and a tap-through to their live screen; the rest are read-only history.
function bookingToTrip(b: Booking): TripItem {
  const pick = b.pickup?.address ?? b.pickup?.label ?? 'Pickup';
  const drop = b.dropoff?.address ?? b.dropoff?.label;
  const target = resumeTargetFor(b.id, b.status, b.mission_status); // MOB-8 — mission_status wins for a live mission
  const ongoing = !!target;
  const cancelled = b.status === 'CANCELLED';
  return {
    id: b.id,
    title: drop ? `${pick} → ${drop}` : pick,
    meta: [b.service, b.region_label].filter(Boolean).join(' · '),
    // Why: total_eur is the canonical BC amount (1 BC = 1 EUR); total_aed is 4.07× and display-only.
    credits: Number(b.total_eur) > 0 ? `${Math.round(Number(b.total_eur)).toLocaleString()} BC` : '—',
    riskTag: ongoing
      ? {label: 'ONGOING', color: '#A9C5FF', bg: 'rgba(91,141,239,0.16)'}
      : cancelled
      ? {label: 'CANCELLED', color: '#FCA5A5', bg: 'rgba(239,68,68,0.15)'}
      : {label: b.status, color: '#86efac', bg: 'rgba(34,197,94,0.1)'},
    status: b.status,
    tag: [b.status === 'COMPLETED' ? 'completed' : null, ongoing ? 'ongoing' : null].filter(Boolean) as TripTag[],
    progressColor: ongoing ? '#5B8DEF' : cancelled ? '#ef4444' : PRO_INDIGO,
    ongoing,
    target,
  };
}

export default function TripHistoryScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {user} = useAuthStore();
  const isAgent = user?.role === 'agent';
  const [filter, setFilter] = useState<FilterType>('all');
  const [trips, setTrips] = useState<TripItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      if (isAgent) {
        const {data} = await agentApi.getMissionHistory();
        setTrips(data.map(toTrip));
      } else {
        const {data} = await bookingApi.list();
        const items = (data.bookings ?? []).map(bookingToTrip);
        // Ongoing bookings first so the active one is right at the top.
        items.sort((a, b) => (b.ongoing ? 1 : 0) - (a.ongoing ? 1 : 0));
        setTrips(items);
      }
    } catch {
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [isAgent]);
  // Refetch on focus so a freshly-created/updated booking shows immediately.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const openTarget = (t: ResumeTarget) => {
    if (t.screen === 'LiveTracking') {navigation.navigate('LiveTracking', {bookingId: t.bookingId});}
    else if (t.screen === 'BookingConfirmation') {navigation.navigate('BookingConfirmation', {bookingId: t.bookingId});}
    // Step 19 — auto-dispatch targets must not fall through to the legacy ops-review screen.
    else if (t.screen === 'FindingDetail') {navigation.navigate('FindingDetail', {bookingId: t.bookingId});}
    else if (t.screen === 'NoDetail') {navigation.navigate('NoDetail', {bookingId: t.bookingId});}
    else {navigation.navigate('OpsRoomReview', {bookingId: t.bookingId});}
  };

  const FILTERS: FilterType[] = isAgent ? ['all', 'completed', 'incident'] : ['all', 'ongoing', 'completed'];
  const filtered = trips.filter(t =>
    filter === 'all' ? true : t.tag.includes(filter),
  );
  const midCount = isAgent
    ? trips.filter(t => t.tag.includes('incident')).length
    : trips.filter(t => t.ongoing).length;
  const totalCredits = trips.reduce((n, t) => {
    const v = parseInt(t.credits.replace(/[^0-9]/g, ''), 10);
    return n + (Number.isFinite(v) ? v : 0);
  }, 0);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#CBD5E1" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>{isAgent ? 'Activity History' : 'My Bookings'}</Text>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {/* Stats grid */}
        <View style={styles.statsGrid}>
          <View style={[styles.statCard, {borderColor: '#1E2D45'}]}>
            <Text style={[styles.statValue, {color: PRO_INDIGO_LIGHT}]}>{trips.length}</Text>
            <Text style={styles.statLabel}>{isAgent ? 'Missions' : 'Bookings'}</Text>
          </View>
          <View style={[styles.statCard, {borderColor: isAgent ? 'rgba(239,68,68,0.25)' : 'rgba(91,141,239,0.25)'}]}>
            <Text style={[styles.statValue, {color: isAgent ? '#F87171' : '#A9C5FF'}]}>{midCount}</Text>
            <Text style={styles.statLabel}>{isAgent ? 'Incident' : 'Ongoing'}</Text>
          </View>
          <View style={[styles.statCard, {borderColor: 'rgba(99,102,241,0.2)'}]}>
            <Text style={[styles.statValue, {color: '#A5B4FC', fontSize: 13}]}>
              {totalCredits >= 1000 ? `${Math.round(totalCredits / 1000)}K` : totalCredits}
            </Text>
            <Text style={styles.statLabel}>{isAgent ? 'Credits' : 'Spent'}</Text>
          </View>
        </View>

        {/* Filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filtersWrap}
          contentContainerStyle={styles.filtersContent}>
          {FILTERS.map(f => (
            <TouchableOpacity key={f}
              style={[styles.chip, filter === f && styles.chipActive]}
              onPress={() => setFilter(f)} activeOpacity={0.8}>
              <Text style={[styles.chipText, filter === f && styles.chipTextActive]}>
                {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {loading && (
          <View style={{paddingVertical: 40, alignItems: 'center'}}>
            <LoadingView compact label="Loading trips…" />
          </View>
        )}
        {!loading && filtered.length === 0 && (
          <View style={{paddingVertical: 40, alignItems: 'center', gap: 8, paddingHorizontal: 24}}>
            <Icon name={isAgent ? 'history' : 'calendar-blank-outline'} size={32} color="#334155" />
            <Text style={{fontSize: 14, fontWeight: '700', color: '#F1F5F9'}}>{isAgent ? 'No missions yet' : 'No bookings yet'}</Text>
            <Text style={{fontSize: 12, color: '#64748B', textAlign: 'center'}}>{isAgent ? 'Your completed missions will appear here.' : 'Your bookings — ongoing and past — will appear here.'}</Text>
          </View>
        )}

        {/* Trip cards */}
        {filtered.map(trip => (
          <TouchableOpacity key={trip.id}
            disabled={!trip.target}
            activeOpacity={trip.target ? 0.8 : 1}
            onPress={() => { if (trip.target) {openTarget(trip.target);} }}
            style={[
              styles.tripCard,
              {borderLeftWidth: 3, borderLeftColor: trip.ongoing ? '#5B8DEF' : trip.borderLeft ?? '#1E2D45'},
            ]}>
            <View style={styles.tripTop}>
              <View style={styles.tripLeft}>
                <Text style={[styles.tripTitle, trip.tag.includes('incident') && {color: '#FCA5A5'}]}>
                  {trip.title}
                </Text>
                {!!trip.meta && <Text style={styles.tripMeta}>{trip.meta}</Text>}
              </View>
              <View style={styles.tripRight}>
                <Text style={[styles.tripCredits, trip.tag.includes('incident') && {color: '#FCA5A5'}]}>
                  {trip.credits}
                </Text>
                <View style={[styles.riskBadge, {backgroundColor: trip.riskTag.bg}]}>
                  <Text style={[styles.riskBadgeText, {color: trip.riskTag.color}]}>{trip.riskTag.label}</Text>
                </View>
              </View>
            </View>

            <View style={styles.tripBottom}>
              <View style={[styles.completedBadge, trip.ongoing && {backgroundColor: 'rgba(91,141,239,0.12)', borderColor: 'rgba(91,141,239,0.3)'}]}>
                <Text style={[styles.completedBadgeText, trip.ongoing && {color: '#A9C5FF'}]}>● {trip.status || 'COMPLETED'}</Text>
              </View>
              {trip.target && (
                <View style={{flexDirection: 'row', alignItems: 'center', gap: 3}}>
                  <Text style={{color: '#A9C5FF', fontSize: 9, fontWeight: '800', letterSpacing: 0.5}}>TAP TO TRACK</Text>
                  <Icon name="chevron-right" size={13} color="#A9C5FF" />
                </View>
              )}
            </View>

            {/* Progress bar */}
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, {backgroundColor: trip.progressColor ?? PRO_INDIGO}]} />
            </View>
          </TouchableOpacity>
        ))}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 6},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontFamily: BravoFont.bold, fontSize: 17, letterSpacing: -0.3, color: T.text},

  content: {paddingHorizontal: 20, paddingTop: 4, gap: 14},

  statsGrid: {flexDirection: 'row', gap: 10},
  statCard: {flex: 1, backgroundColor: T.card, borderRadius: 16, paddingVertical: 14, alignItems: 'center', borderWidth: 1},
  statValue: {fontFamily: BravoFont.extraBold, fontSize: 18, letterSpacing: -0.4},
  statLabel: {fontFamily: BravoFont.mono, fontSize: 8.5, color: T.textMute, letterSpacing: 1.2, textTransform: 'uppercase', marginTop: 3},

  filtersWrap: {flexGrow: 0},
  filtersContent: {gap: 8, paddingRight: 4},
  chip: {paddingHorizontal: 14, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: T.hair2},
  chipActive: {backgroundColor: 'rgba(91,141,239,0.2)', borderColor: 'rgba(91,141,239,0.4)'},
  chipText: {fontFamily: BravoFont.semiBold, fontSize: 11.5, color: T.textMute},
  chipTextActive: {color: T.text},

  tripCard: {backgroundColor: T.card, borderRadius: 18, borderWidth: 1, borderColor: T.hair2, overflow: 'hidden', padding: 16, gap: 12},
  tripTop: {flexDirection: 'row', justifyContent: 'space-between', gap: 10},
  tripLeft: {flex: 1, minWidth: 0},
  tripTitle: {fontFamily: BravoFont.semiBold, fontSize: 13.5, lineHeight: 19, letterSpacing: -0.2, color: T.text},
  tripMeta: {fontFamily: BravoFont.regular, fontSize: 10.5, color: T.textMute, marginTop: 4},
  tripRight: {alignItems: 'flex-end', flexShrink: 0, gap: 4},
  tripCredits: {fontFamily: BravoFont.extraBold, fontSize: 15, letterSpacing: -0.3, color: PRO_INDIGO_LIGHT},
  riskBadge: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7},
  riskBadgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.5},

  tripBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  completedBadge: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 7, backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.22)'},
  completedBadgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.5, color: '#86efac'},

  progressTrack: {height: 3, backgroundColor: T.hair2, borderRadius: 3, overflow: 'hidden'},
  progressFill: {height: '100%', width: '100%', borderRadius: 3},
});
