/**
 * Wave 5d (PDF-2 A7) — the Secure shell's "Summary" tab: the active-booking
 * surface.
 *
 * It does NOT invent a backend. It reads the SAME `useBookingStore` list the
 * Book-Now home already polls, picks the one in-flight booking with the shared
 * `findResumableBooking` predicate, and offers to resume it via the shared
 * `resumeTargetFor` resolver (the single source of truth for status → screen —
 * OpsRoomReview / FindingDetail / LiveTracking / BookingConfirmation / NoDetail).
 * When there is nothing in flight it shows an honest empty state; a resume
 * navigate bubbles up to BookingNavigator, which owns every one of those routes.
 */
import React, {useCallback} from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ScrollView, StatusBar, ActivityIndicator} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {BravoFont} from '@/theme/bravo';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useBookingStore} from '@store/bookingStore';
import {describeStatus, findResumableBooking, resumeTargetFor} from './bookingStatus';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const B = {
  bg:       '#07090D',
  text:     '#F2F4F8',
  textDim:  'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)',
  hair:     'rgba(255,255,255,0.09)',
  card:     'rgba(255,255,255,0.04)',
  accent:   '#5B8DEF',
} as const;

type BookingRow = {
  id: string;
  status?: string;
  mission_status?: string | null;
  booking_mode?: 'now' | 'later' | null;
  service?: string;
  type?: string;
  total_price?: number;
  total_eur?: number;
  estimated_price?: number;
};

function rowLabel(b: BookingRow): string {
  const svc = b.service ?? b.type ?? 'Booking';
  return svc.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function rowCredits(b: BookingRow): number {
  return b.total_price ?? b.total_eur ?? b.estimated_price ?? 0;
}

export default function SecureSummaryScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const bookings = useBookingStore(s => s.bookings) as unknown as BookingRow[];
  const isLoading = useBookingStore(s => s.isLoading);
  const loadBookings = useBookingStore(s => s.loadBookings);

  // Refresh on focus — no auto-navigate. Unlike the Home hero, the Summary tab
  // is where the user CHOSE to look at their mission, so it must not yank them
  // straight into it; it presents a card and lets them tap.
  useFocusEffect(
    useCallback(() => {
      void loadBookings();
    }, [loadBookings]),
  );

  // `undefined` seen-set: the tab always considers every in-flight booking (the
  // "don't re-yank" dedup that BookingHome keeps is about auto-navigation, which
  // this surface deliberately does not do).
  const active = findResumableBooking(bookings) as BookingRow | undefined;
  const status = active ? describeStatus(active.status) : null;

  const resume = (b: BookingRow) => {
    const target = resumeTargetFor(b.id, b.status, b.mission_status);
    // Bubbles up to BookingNavigator, which owns all of these routes.
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
      navigation.navigate('TripSummary', {bookingId: b.id});
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={B.bg} />
      <AmbientBg />
      <ScrollView
        contentContainerStyle={[styles.scroll, {paddingTop: insets.top + 20, paddingBottom: contentBottom(24)}]}
        showsVerticalScrollIndicator={false}>
        <Text style={styles.eyebrow}>BRAVO SECURE</Text>
        <Text style={styles.title}>Summary</Text>

        {active && status ? (
          <TouchableOpacity
            style={styles.card}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Resume ${rowLabel(active)}, ${status.label}`}
            onPress={() => resume(active)}>
            <View style={styles.cardTop}>
              <View style={[styles.statusDot, {backgroundColor: status.color}]} />
              <Text style={[styles.statusLabel, {color: status.color}]} numberOfLines={1}>
                {status.label}
              </Text>
            </View>
            <Text style={styles.cardTitle} numberOfLines={1}>{rowLabel(active)}</Text>
            <Text style={styles.cardSub} numberOfLines={1}>
              {rowCredits(active) > 0 ? `${rowCredits(active)} BC` : 'Active mission'}
            </Text>
            <View style={styles.cardCta}>
              <Text style={styles.cardCtaText}>View mission</Text>
              <Icon name="arrow-right" size={16} color={B.accent} />
            </View>
          </TouchableOpacity>
        ) : isLoading ? (
          <View style={styles.empty}>
            <ActivityIndicator size="large" color={B.accent} />
          </View>
        ) : (
          <View style={styles.empty}>
            <Icon name="shield-check-outline" size={44} color={B.textMute} />
            <Text style={styles.emptyTitle}>No active booking</Text>
            <Text style={styles.emptyBody}>
              When you have a protection detail in progress it will show here, ready
              to open in one tap.
            </Text>
            <TouchableOpacity
              style={styles.emptyBtn}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Book protection"
              onPress={() => navigation.navigate('ServiceType')}>
              <Text style={styles.emptyBtnText}>Book protection</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: B.bg},
  scroll: {paddingHorizontal: 20, flexGrow: 1},
  eyebrow: {
    color: B.textMute, fontFamily: BravoFont.sans, fontSize: 11,
    letterSpacing: 2.5, fontWeight: '700',
  },
  title: {color: B.text, fontFamily: BravoFont.bold, fontSize: 28, marginTop: 4, marginBottom: 24},
  card: {
    backgroundColor: B.card, borderRadius: 16, borderWidth: 1, borderColor: B.hair,
    padding: 18, gap: 6,
  },
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2},
  statusDot: {width: 8, height: 8, borderRadius: 4},
  statusLabel: {fontFamily: BravoFont.bold, fontSize: 11, letterSpacing: 1},
  cardTitle: {color: B.text, fontFamily: BravoFont.semiBold, fontSize: 18},
  cardSub: {color: B.textDim, fontFamily: BravoFont.regular, fontSize: 13},
  cardCta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 10},
  cardCtaText: {color: B.accent, fontFamily: BravoFont.semiBold, fontSize: 14},
  empty: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingTop: 80, gap: 12},
  emptyTitle: {color: B.text, fontFamily: BravoFont.semiBold, fontSize: 18, textAlign: 'center'},
  emptyBody: {
    color: B.textDim, fontFamily: BravoFont.regular, fontSize: 13,
    textAlign: 'center', lineHeight: 20, maxWidth: 280,
  },
  emptyBtn: {
    marginTop: 8, minHeight: 48, justifyContent: 'center', paddingHorizontal: 28,
    borderRadius: 12, backgroundColor: B.accent,
  },
  emptyBtnText: {color: '#fff', fontFamily: BravoFont.semiBold, fontSize: 15},
});
