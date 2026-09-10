/**
 * BookingHistoryScreen (LM-U8) — the full booking list behind Home's "View All"
 * (which was a dead button; Home shows only the 5 most recent). Same edge-lit
 * card recipe + status chips as the Recent Bookings section; tapping a row
 * resumes an in-flight booking or opens the read-only Trip Summary.
 */
import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, FlatList, TouchableOpacity, StatusBar, RefreshControl} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {describeStatus, resumeTargetFor} from './bookingStatus';
import {UI} from '@components/ui/tokens';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

type BookingRow = {
  id: string;
  status?: string;
  // MOB-8 — the list DTO carries mission_status (LB-ST1); resumeTargetFor needs it so a
  // live-mission row resumes into LiveTracking, not the static confirmation screen.
  mission_status?: string;
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
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

function rowLabel(b: BookingRow): string {
  const svc = b.service ?? b.type ?? 'Booking';
  if (svc === 'executive_protection') {return 'Executive Protection';}
  return svc.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function rowCredits(b: BookingRow): number {
  return b.total_price ?? b.total_eur ?? b.estimated_price ?? 0;
}

function shortRef(id: string): string {
  return 'BL-' + id.replace(/-/g, '').slice(-12).toUpperCase();
}

export default function BookingHistoryScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const bookings = useBookingStore(s => s.bookings) as unknown as BookingRow[];
  const loadBookings = useBookingStore(s => s.loadBookings);
  const isLoading = useBookingStore(s => s.isLoading);
  const error = useBookingStore(s => s.error);
  const clearError = useBookingStore(s => s.clearError);
  const [refreshing, setRefreshing] = useState(false);

  useFocusEffect(useCallback(() => { void loadBookings(); }, [loadBookings]));

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadBookings(); } finally { setRefreshing(false); }
  }, [loadBookings]);

  const open = useCallback((b: BookingRow) => {
    const target = resumeTargetFor(b.id, b.status, b.mission_status); // MOB-8 — mission_status wins for a live mission
    if (target?.screen === 'BookingConfirmation') {
      navigation.navigate('BookingConfirmation', {
        bookingId: target.bookingId, amountPaid: rowCredits(b),
        currency: 'BC', paymentMethod: 'bravo_credits', creditsAwarded: 0,
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
      navigation.navigate('TripSummary', {bookingId: b.id});
    }
  }, [navigation]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Icon name="chevron-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle}>Booking History</Text>
          <FitLine style={s.headerSub} text={`${bookings.length} BOOKING${bookings.length === 1 ? '' : 'S'}`} />
        </View>
      </View>

      <FlatList
        data={bookings}
        keyExtractor={b => b.id}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 24, gap: 10}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={UI.accent} />}
        ListEmptyComponent={
          isLoading && bookings.length === 0 ? (
            <View style={s.emptyCard}>
              <LoadingView compact label="Loading bookings…" />
            </View>
          ) : error ? (
            <View style={s.emptyCard}>
              <Icon name="alert-circle-outline" size={22} color={UI.alert} importantForAccessibility="no" />
              <Text style={s.errText}>{error}</Text>
              <TouchableOpacity
                style={s.retryBtn}
                activeOpacity={0.85}
                onPress={() => { clearError(); void loadBookings(); }}
                accessibilityRole="button"
                accessibilityLabel="Retry loading bookings">
                <Text style={s.retryText}>Retry</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={s.emptyCard}>
              <Icon name="shield-outline" size={20} color={UI.textMute} importantForAccessibility="no" />
              <Text style={s.emptyText}>No bookings yet</Text>
            </View>
          )
        }
        renderItem={({item: b}) => {
          const display = describeStatus(b.status);
          const credits = rowCredits(b);
          return (
            <TouchableOpacity style={s.card} activeOpacity={0.8} onPress={() => open(b)}
              accessibilityRole="button"
              accessibilityLabel={`Booking ${shortRef(b.id)}, ${display.label}, ${formatDate(b.start_time ?? b.created_at)}`}>
              <View style={s.cardLeft}>
                <View style={s.iconWrap}><Icon name="shield-check" size={18} color={UI.accentSoft} /></View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.ref} numberOfLines={1}>{shortRef(b.id)}</Text>
                  <Text style={s.meta} numberOfLines={1}>{rowLabel(b)} · {formatDate(b.start_time ?? b.created_at)}</Text>
                </View>
              </View>
              <View style={s.cardRight}>
                <View style={[s.chip, {backgroundColor: display.color + '14', borderColor: display.color + '4D'}]}>
                  <Text style={[s.chipText, {color: display.color}]} numberOfLines={1} ellipsizeMode="tail">{display.label}</Text>
                </View>
                {credits > 0 && (
                  <Text style={s.credits}>{credits.toLocaleString()}<Text style={s.creditsUnit}> cr</Text></Text>
                )}
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 20, paddingVertical: 14},
  back: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: UI.hair},
  headerTitle: {fontFamily: UI.fBold, fontSize: 18, color: UI.text, letterSpacing: -0.2},
  headerSub: {fontFamily: UI.fSemi, fontSize: 10, letterSpacing: 1.6, color: UI.textMute, marginTop: 1},
  card: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    paddingHorizontal: 14, paddingVertical: 13, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: UI.hair},
  cardLeft: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1, minWidth: 0},
  iconWrap: {width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)'},
  ref: {fontFamily: UI.fBold, fontSize: 13, color: UI.text, letterSpacing: 0.3},
  meta: {fontFamily: UI.fSans, fontSize: 11.5, color: UI.textDim, marginTop: 1},
  cardRight: {alignItems: 'flex-end', gap: 4, flexShrink: 1, maxWidth: '48%'},
  chip: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, borderWidth: 1, maxWidth: '100%'},
  chipText: {fontFamily: UI.fSemi, fontSize: 9.5, letterSpacing: 0.6},
  credits: {fontFamily: UI.fBold, fontSize: 12, color: UI.text},
  creditsUnit: {fontFamily: UI.fSans, fontSize: 10, color: UI.textMute},
  emptyCard: {alignItems: 'center', gap: 8, paddingVertical: 42},
  emptyText: {fontFamily: UI.fSemi, fontSize: 13, color: UI.textDim},
  errText: {fontFamily: UI.fSans, fontSize: 12.5, color: UI.textDim, textAlign: 'center'},
  retryBtn: {paddingHorizontal: 18, paddingVertical: 9, borderRadius: 999, marginTop: 4,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)'},
  retryText: {fontFamily: UI.fBold, fontSize: 12.5, color: UI.accentSoft},
}));
