/**
 * Bravo Secure Lux — COMING SOON teaser / future-plan showcase.
 *
 * Entry: Secure Plans → "Bravo Secure Lux" card (tappable even though the
 * tier is locked — the card sells the future). Pure marketing surface: hero
 * medallion, the six pillars of the premium tier (private aviation, armored
 * fleet, maritime, advance teams, dedicated desk, discretion), a 3-step
 * "how it will work", and a local-only "notify me at launch" hook the
 * backend can later pick up. Nothing here books anything.
 */
import React, {useEffect, useState} from 'react';
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
import AsyncStorage from '@react-native-async-storage/async-storage';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {Alert} from '@utils/alert';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureLux'>;

const INTEREST_KEY = 'securelux:launch-interest';

// Design tokens — obsidian/cobalt premium (mirrors the Secure Plans family).
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
  signal:     '#4ADE80',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

const PILLARS = [
  {
    icon: 'airplane',
    title: 'Private Aviation',
    desc: 'Jet and helicopter charter with security-vetted flight crews and secured FBO handling, door to door.',
  },
  {
    icon: 'shield-car',
    title: 'Armored Fleet',
    desc: 'Armored vehicles and escort convoys, pre-positioned wherever you land — never a rental counter.',
  },
  {
    icon: 'sail-boat',
    title: 'Maritime Security',
    desc: 'Yacht and coastal protection details run by maritime-trained close-protection teams.',
  },
  {
    icon: 'earth',
    title: 'Global Advance Teams',
    desc: 'Advance reconnaissance, secured venues and vetted local partners across 190+ countries.',
  },
  {
    icon: 'headset',
    title: 'Dedicated Lux Desk',
    desc: 'One concierge line, 24/7. A single call moves aircraft, vehicles, vessels and teams together.',
  },
  {
    icon: 'shield-lock',
    title: 'Absolute Discretion',
    desc: 'End-to-end encrypted coordination, NDA-backed personnel and zero public footprint.',
  },
] as const;

const STEPS = [
  {n: '01', title: 'Brief your Lux desk', desc: 'One conversation — destinations, party, timing, risk posture.'},
  {n: '02', title: 'Receive the plan', desc: 'A tailored end-to-end proposal: aviation, ground, maritime, teams.'},
  {n: '03', title: 'Just travel', desc: 'Everything is already in place when you arrive. Every leg protected.'},
] as const;

export default function SecureLuxScreen() {
  const insets = useSafeAreaInsets();
  const {contentBottom} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const [interested, setInterested] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(INTEREST_KEY)
      .then(v => { if (v === '1') {setInterested(true);} })
      .catch(() => undefined);
  }, []);

  const registerInterest = () => {
    setInterested(true);
    AsyncStorage.setItem(INTEREST_KEY, '1').catch(() => undefined);
    Alert.alert(
      'You’re on the list',
      'Bravo Secure Lux is in preparation. We’ll announce the launch here in the app — you’ll be among the first to know.',
    );
  };

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
          <Text style={s.headerTitle}>Bravo Secure Lux</Text>
          <FitLine style={s.headerSub} text={'PREMIUM TIER · COMING SOON'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(28), gap: 16}}
        showsVerticalScrollIndicator={false}>

        {/* Hero */}
        <View style={s.hero}>
          <ImageryBackdrop source={Imagery.svcAviation} variant="hero" radius={24} />
          <View style={s.heroGlow} pointerEvents="none" />
          <LinearGradient
            colors={['rgba(91,141,239,0.30)', 'rgba(47,91,224,0.08)']}
            start={{x: 0.2, y: 0}}
            end={{x: 0.85, y: 1}}
            style={s.medallion}>
            <Icon name="shield-crown" size={40} color={D.accentSoft} />
          </LinearGradient>
          <Text style={s.heroTitle}>The white-glove tier</Text>
          <Text style={s.heroCopy}>
            Beyond protection — complete secure logistics. Private aviation, armored fleets and
            elite teams, arranged end-to-end by your dedicated Lux desk.
          </Text>
          <View style={s.soonPill}>
            <Icon name="clock-outline" size={12} color={D.amber} importantForAccessibility="no" />
            <Text style={s.soonPillText}>COMING SOON</Text>
          </View>
        </View>

        {/* Pillars */}
        <Text style={s.sectionLabel}>THE FUTURE PLAN INCLUDES</Text>
        <View style={s.grid}>
          {PILLARS.map(p => (
            <View key={p.title} style={s.pillar}>
              <View style={s.pillarTopLight} />
              <View style={s.pillarIcon}>
                <Icon name={p.icon as never} size={20} color={D.accentSoft} />
              </View>
              <Text style={s.pillarTitle}>{p.title}</Text>
              <Text style={s.pillarDesc}>{p.desc}</Text>
            </View>
          ))}
        </View>

        {/* How it will work */}
        <Text style={s.sectionLabel}>HOW IT WILL WORK</Text>
        <View style={s.stepsCard}>
          {STEPS.map((st, i) => (
            <View key={st.n} style={[s.stepRow, i > 0 && s.stepDivider]}>
              <Text style={s.stepNum}>{st.n}</Text>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.stepTitle}>{st.title}</Text>
                <Text style={s.stepDesc}>{st.desc}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* Notify CTA */}
        {interested ? (
          <View style={s.interestedCard}>
            <Icon name="check-decagram" size={18} color={D.signal} />
            <Text style={s.interestedText}>
              You’re on the launch list — we’ll announce Bravo Secure Lux here first.
            </Text>
          </View>
        ) : (
          <TouchableOpacity
            activeOpacity={0.9}
            onPress={registerInterest}
            accessibilityRole="button"
            accessibilityLabel="Get notified when Bravo Secure Lux launches">
            <LinearGradient
              colors={['#6E9BF5', D.accent, D.accentDeep]}
              locations={[0, 0.55, 1]}
              start={{x: 0, y: 0}}
              end={{x: 0, y: 1}}
              style={s.cta}>
              <Icon name="bell-ring-outline" size={18} color="#fff" importantForAccessibility="no" />
              <Text style={s.ctaText}>Get notified at launch</Text>
            </LinearGradient>
          </TouchableOpacity>
        )}

        <View style={s.noteCard}>
          <Icon name="information-outline" size={16} color={D.textMute} />
          <Text style={s.noteText}>
            Bravo Secure Lite and Pro are fully available today — Lux extends them with premium
            logistics when it launches.
          </Text>
        </View>
      </ScrollView>
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

  hero: {
    alignItems: 'center', paddingVertical: 26, paddingHorizontal: 18,
    borderRadius: 24, overflow: 'hidden',
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
  },
  heroGlow: {
    position: 'absolute', top: -60, alignSelf: 'center',
    width: 260, height: 180, borderRadius: 130,
    backgroundColor: 'rgba(91,141,239,0.12)',
  },
  medallion: {
    width: 84, height: 84, borderRadius: 26,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    shadowColor: D.accent, shadowOpacity: 0.4, shadowRadius: 24, shadowOffset: {width: 0, height: 0}, elevation: 8,
  },
  heroTitle: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.4, color: D.text, marginTop: 16},
  heroCopy: {
    fontFamily: D.fSans, fontSize: 13, lineHeight: 19, color: D.textDim,
    textAlign: 'center', marginTop: 8,
  },
  soonPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 14, paddingVertical: 6, paddingHorizontal: 12, borderRadius: 999,
    backgroundColor: 'rgba(245,181,68,0.10)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.34)',
  },
  soonPillText: {fontFamily: D.fBold, fontSize: 10, letterSpacing: 1.4, color: D.amber},

  sectionLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginTop: 4, paddingLeft: 2,
  },

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  pillar: {
    flexGrow: 1, flexBasis: '44%', minWidth: 0,
    padding: 14, borderRadius: 18, overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2,
  },
  pillarTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(120,160,255,0.3)'},
  pillarIcon: {
    width: 40, height: 40, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  pillarTitle: {fontFamily: D.fBold, fontSize: 13.5, letterSpacing: -0.2, color: D.text, marginTop: 10},
  pillarDesc: {fontFamily: D.fSans, fontSize: 11, lineHeight: 16, color: D.textMute, marginTop: 5},

  stepsCard: {
    borderRadius: 18, paddingHorizontal: 16,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2,
  },
  stepRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 14},
  stepDivider: {borderTopWidth: 1, borderTopColor: D.hair},
  stepNum: {fontFamily: D.fMono, fontSize: 12, fontWeight: '700', letterSpacing: 1, color: D.accentSoft, marginTop: 1},
  stepTitle: {fontFamily: D.fBold, fontSize: 14, letterSpacing: -0.2, color: D.text},
  stepDesc: {fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16, color: D.textMute, marginTop: 3},

  cta: {
    minHeight: 56, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.3, color: '#fff'},

  interestedCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 16, borderRadius: 18,
    backgroundColor: 'rgba(74,222,128,0.06)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.28)',
  },
  interestedText: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 12.5, lineHeight: 18, color: D.textDim},

  noteCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  noteText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textMute},
}));
