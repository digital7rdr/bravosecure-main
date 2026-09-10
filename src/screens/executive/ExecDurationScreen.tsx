/**
 * Executive Protection · Step 01 — Select Duration
 *
 * Executive protection booked in FIXED time blocks (3–24 hours, steps of 3).
 * Obsidian/cobalt palette matching the Lite booking wizard (ServiceTypeScreen /
 * ZoneMapScreen) so the two products read as one family.
 *
 * Data layer: seeds a fresh executive draft on entry (bookingStore.startExecutiveDraft —
 * idempotent while an executive draft is in progress so back-nav never wipes state)
 * and writes `duration_hours`. Continue → ExecSchedule.
 */
import React, {useEffect} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {EXEC_DURATIONS} from './executiveProduct';
import {useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ExecDuration'>;

// Design tokens — obsidian/cobalt premium (mirrors the Lite wizard screens).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

function DurationCell({hours, selected, onPress}: {hours: number; selected: boolean; onPress: () => void}) {
  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${hours} hours`}
      accessibilityState={{selected}}
      style={[s.cell, selected ? s.cellSelected : s.cellIdle]}>
      {selected && <View style={s.cellTopLight} />}
      <Text style={[s.cellText, selected && s.cellTextSelected]}>{hours} hrs</Text>
      {/* Badge slot always occupies layout so selection doesn't shift the label. */}
      <View style={[s.cellCheck, !selected && s.cellCheckHidden]}>
        <Icon name="check" size={13} color="#fff" />
      </View>
    </TouchableOpacity>
  );
}

export default function ExecDurationScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  useServicePricingStore(st => st.overrides);
  const loadServicePricing = useServicePricingStore(st => st.load);
  useEffect(() => { void loadServicePricing(); }, [loadServicePricing]);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const startExecutiveDraft = useBookingStore(st => st.startExecutiveDraft);
  const updateDraft = useBookingStore(st => st.updateDraft);
  const durationHours = useBookingStore(st => st.draft.duration_hours);

  // Every entry path (the ServiceType "Executive Protection" card, deep link)
  // funnels through this mount — the one place the executive draft is seeded.
  useEffect(() => { startExecutiveDraft(); }, [startExecutiveDraft]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.back}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back"
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.headerTitle}>Select Duration</Text>
          <FitLine style={s.headerSub} text={'EXECUTIVE PROTECTION · STEP 1 · DURATION'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160}}
        showsVerticalScrollIndicator={false}>
        <Text style={s.lede}>Choose the length of protection you require.</Text>

        <View style={s.infoCard}>
          <View style={s.infoIcon}>
            <Icon name="shield-account" size={18} color={D.accentSoft} />
          </View>
          <Text style={s.infoText}>
            Executive Protection is booked in fixed time blocks from 3 to 24 hours.
          </Text>
        </View>

        <View style={s.grid}>
          {EXEC_DURATIONS.map(h => (
            <DurationCell
              key={h}
              hours={h}
              selected={durationHours === h}
              onPress={() => updateDraft({duration_hours: h})}
            />
          ))}
        </View>

        {/* Long-term upsell — beyond 24 h is a Bravo Secure Pro plan. */}
        <TouchableOpacity
          style={s.proCard}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Need cover for longer than 24 hours? Explore Bravo Secure Pro"
          onPress={() => navigation.navigate('SecureServices')}>
          <View style={s.proIcon}>
            <Icon name="star-four-points" size={16} color={D.accentSoft} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.proTitle}>Need cover for longer than 24 hours?</Text>
            <Text style={s.proSub}>Explore Bravo Secure Pro for Long-Term Bookings.</Text>
          </View>
          <Icon name="chevron-right" size={20} color={D.textMute} />
        </TouchableOpacity>
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => navigation.navigate('ExecSchedule')}
          accessibilityRole="button">
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.cta}>
            <Text style={s.ctaText}>Continue</Text>
            <Icon name="arrow-right" size={19} color="#fff" importantForAccessibility="no" />
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg, overflow: 'hidden'},

  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 280, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  header: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 14,
  },
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerTitle: {fontFamily: D.fBold, fontSize: 21, letterSpacing: -0.5, color: D.text, lineHeight: 24},
  headerSub: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute, marginTop: 5},

  lede: {fontFamily: D.fSans, fontSize: 13, lineHeight: 19, color: D.textDim, marginBottom: 14},

  infoCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 16, marginBottom: 18,
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  infoIcon: {
    width: 38, height: 38, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  infoText: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 12.5, lineHeight: 18, color: D.textDim},

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  cell: {
    flexGrow: 1, flexBasis: '44%', minHeight: 58,
    borderRadius: 16, overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
  },
  cellIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2},
  cellSelected: {
    backgroundColor: 'rgba(16,26,46,0.92)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.55)',
    shadowColor: '#14285A', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: {width: 0, height: 10}, elevation: 7,
  },
  cellTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(120,160,255,0.4)'},
  cellText: {fontFamily: D.fSemi, fontSize: 15.5, letterSpacing: -0.2, color: D.textDim},
  cellTextSelected: {fontFamily: D.fBold, color: D.text},
  cellCheck: {
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: D.accent, alignItems: 'center', justifyContent: 'center',
  },
  cellCheckHidden: {opacity: 0},

  proCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    marginTop: 18, padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2,
  },
  proIcon: {
    width: 34, height: 34, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  proTitle: {fontFamily: D.fBold, fontSize: 13.5, letterSpacing: -0.2, color: D.text},
  proSub: {fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16, color: D.textMute, marginTop: 3},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
