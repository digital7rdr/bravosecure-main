/**
 * Booking · Step 04 — Baseline Package
 *
 * Premium redesign (Bravo "Baseline Package" design handoff): obsidian/cobalt
 * palette matching the rest of the booking flow. A glowing price-hero card
 * (86 BC base rate) with three stat tiles (1 CPO · 1 Vehicle · 1 Driver), an
 * edge-lit "What's Included" checklist, and a gradient CTA into Team & Add-ons.
 *
 * Static preview — the always-included baseline. The authoritative, team-aware
 * total is computed on the next step (CustomizeAddOns) and server-side.
 */
import React, {useEffect} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {BASE_RATE_BC} from './pricing';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'BaselinePackage'>;

// Design tokens (Bravo "Baseline Package" handoff — obsidian/cobalt premium).
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
  signal:     '#4ADE80',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type IconName = React.ComponentProps<typeof Icon>['name'];

const STATS: {icon: IconName; n: string; label: string}[] = [
  {icon: 'shield-check', n: '1 CPO',     label: 'Protection'},
  {icon: 'car-estate',   n: '1 Vehicle', label: 'Armoured'},
  {icon: 'account-tie',  n: '1 Driver',  label: 'Vetted'},
];

const INCLUDED: {t: string; s: string}[] = [
  {t: 'Ops room handler',        s: 'Assigned for full mission duration'},
  {t: 'AES-256 encrypted comms', s: 'Dedicated secure channel'},
  {t: 'Real-time GPS tracking',  s: 'Live vehicle telemetry'},
  {t: 'Post-mission report',     s: 'Detailed report & invoice'},
  {t: '24hr escalation line',    s: 'Emergency support, always on'},
];

function StatTile({icon, n, label}: {icon: IconName; n: string; label: string}) {
  return (
    <View style={s.stat}>
      <LinearGradient
        colors={['rgba(91,141,239,0.26)', 'rgba(47,91,224,0.07)']}
        start={{x: 0.2, y: 0}}
        end={{x: 0.85, y: 1}}
        style={s.statIcon}>
        <Icon name={icon} size={20} color={D.accentSoft} importantForAccessibility="no" />
      </LinearGradient>
      <FitLine style={[s.statN, {textAlign: 'center'}]} text={n} />
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

export default function BaselinePackageScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  useServicePricingStore(st => st.overrides);
  const loadServicePricing = useServicePricingStore(st => st.load);
  useEffect(() => { void loadServicePricing(); }, [loadServicePricing]);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* Ambient glow behind the header */}
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
          <Text style={s.headerTitle}>Baseline Package</Text>
          <FitLine style={s.headerSub} text={'STEP 4 · REVIEW INCLUSIONS'} />
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4}}
        showsVerticalScrollIndicator={false}>

        {/* ── Price hero ── */}
        <View style={s.hero}>
          <ImageryBackdrop source={Imagery.packageHero} variant="hero" radius={24} />
          <View style={s.heroTopLight} />
          <View style={s.heroGlow} />
          <Text style={s.heroCap}>ALWAYS INCLUDED</Text>
          <View style={s.heroAmtRow}>
            <Text style={s.heroAmt}>{BASE_RATE_BC}</Text>
            <Text style={s.heroBc}>BC</Text>
          </View>
          <Text style={s.heroRate}>/HR · BASE RATE · BRAVO CREDITS</Text>

          <View style={s.statRow}>
            {STATS.map(st => (
              <StatTile key={st.n} icon={st.icon} n={st.n} label={st.label} />
            ))}
          </View>
        </View>

        {/* ── What's included ── */}
        <View style={s.sectionRow}>
          <Text style={s.sectionLabel}>WHAT'S INCLUDED</Text>
          <Text style={s.sectionMeta}>{INCLUDED.length} ITEMS</Text>
        </View>

        <View style={{gap: 10}}>
          {INCLUDED.map(f => (
            <View key={f.t} style={s.inc}>
              <View style={s.incTopLight} />
              <View style={s.incCheck}>
                <Icon name="check" size={15} color={D.signal} importantForAccessibility="no" />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.incTitle} numberOfLines={1}>{f.t}</Text>
                <Text style={s.incSub}>{f.s}</Text>
              </View>
            </View>
          ))}
        </View>
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity activeOpacity={0.9} onPress={() => navigation.navigate('CustomizeAddOns')} accessibilityRole="button">
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.cta}>
            <Text style={s.ctaText}>Customise Add-ons</Text>
            <Icon name="arrow-right" size={19} color="#fff" />
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
    backgroundColor: 'rgba(91,141,239,0.08)',
  },

  // Header
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

  scroll: {flex: 1},

  // Price hero
  hero: {
    position: 'relative', overflow: 'hidden',
    borderRadius: 24, paddingHorizontal: 20, paddingTop: 22, paddingBottom: 20,
    backgroundColor: 'rgba(20,32,56,0.92)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    shadowColor: '#14285A', shadowOpacity: 0.36, shadowRadius: 22, shadowOffset: {width: 0, height: 16}, elevation: 10,
  },
  heroTopLight: {position: 'absolute', top: 0, left: 24, right: 24, height: 1, backgroundColor: 'rgba(120,160,255,0.45)'},
  heroGlow: {
    position: 'absolute', top: -40, alignSelf: 'center',
    width: 260, height: 140, borderRadius: 130,
    backgroundColor: 'rgba(91,141,239,0.16)',
  },
  heroCap: {
    textAlign: 'center',
    fontFamily: D.fMono, fontSize: 10, fontWeight: '700', letterSpacing: 2.5, color: D.accentSoft,
  },
  heroAmtRow: {flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: 8, marginTop: 12},
  heroAmt: {fontFamily: D.fBold, fontSize: 52, letterSpacing: -2, color: D.text, lineHeight: 54},
  heroBc: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.5, color: D.accentSoft},
  heroRate: {
    textAlign: 'center', marginTop: 9,
    fontFamily: D.fMono, fontSize: 10.5, letterSpacing: 0.6, color: D.textMute,
  },

  // Stat tiles
  statRow: {flexDirection: 'row', gap: 10, marginTop: 20},
  stat: {
    flex: 1, alignItems: 'center', gap: 9, paddingVertical: 16, paddingHorizontal: 6,
    borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
  },
  statIcon: {
    width: 40, height: 40, borderRadius: 12,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.36)',
    shadowColor: D.accent, shadowOpacity: 0.2, shadowRadius: 14, shadowOffset: {width: 0, height: 0}, elevation: 4,
  },
  statN: {fontFamily: D.fBold, fontSize: 15, color: D.text},
  statLabel: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 0.8, color: D.textMute, marginTop: -3},

  // Section label
  sectionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginTop: 22, marginBottom: 14, paddingHorizontal: 2,
  },
  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim},
  sectionMeta: {fontFamily: D.fMono, fontSize: 9, letterSpacing: 1, color: D.signal},

  // Inclusion rows
  inc: {
    position: 'relative', overflow: 'hidden',
    flexDirection: 'row', alignItems: 'center', gap: 13, padding: 13, paddingHorizontal: 15,
    borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  incTopLight: {position: 'absolute', top: 0, left: 15, right: 15, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  incCheck: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  incTitle: {fontFamily: D.fBold, fontSize: 14.5, letterSpacing: -0.2, color: D.text},
  incSub: {fontFamily: D.fSans, fontSize: 11.5, letterSpacing: -0.05, color: D.textMute, marginTop: 3},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16.5, letterSpacing: 0.3, color: '#fff'},
}));
