/**
 * Bravo Secure Pro — introduction / benefits screen.
 *
 * Entry: Bravo Secure plan chooser → Pro. Overview of Pro benefits with NO
 * pricing (pricing is a custom proposal from the Bravo Control System after
 * the requirements form). CTA: "Apply for Bravo Secure Pro" → requirements
 * form. The user keeps full Lite access while an application is reviewed.
 */
import React from 'react';
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
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProIntro'>;

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
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type IconName = React.ComponentProps<typeof Icon>['name'];

const FEATURES: Array<{icon: IconName; title: string; sub: string}> = [
  {icon: 'account-group', title: 'Dedicated Support Team', sub: 'A named protection team assigned to your profile for the whole coverage period.'},
  {icon: 'headset', title: 'Operational Assistance', sub: 'The Bravo Control System coordinates logistics, mobility and day-to-day support.'},
  {icon: 'map-marker-path', title: 'Journey Monitoring', sub: 'Live tracking and route oversight for every movement under your plan.'},
  {icon: 'phone-lock', title: 'Secure Communications', sub: 'End-to-end encrypted messaging and calls with your team.'},
  {icon: 'auto-fix', title: 'AI Itinerary Planning', sub: 'Upload travel plans — coverage, routes and standby slots are scheduled for you.'},
  {icon: 'chart-box-outline', title: 'Activity & Reports', sub: 'A full operational log of missions, movements and incidents.'},
];

const BENEFITS = ['Dedicated support', 'Long-term bookings', 'Priority operations'] as const;

const STEPS = [
  {n: '01', title: 'Tell us what you need', desc: 'One form — coverage, duration, team size and services.'},
  {n: '02', title: 'Receive your proposal', desc: 'The Bravo Control System prepares a custom plan and pricing.'},
  {n: '03', title: 'Accept & activate', desc: 'Pay with Bravo Credits and your Pro plan goes live.'},
] as const;

export default function SecureProIntroScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

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
          <Text style={s.headerTitle}>Bravo Secure Pro</Text>
          <FitLine style={s.headerSub} text={'CUSTOM PROTECTION · MOBILITY · OPERATIONS'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingBottom: 150}}
        showsVerticalScrollIndicator={false}>

        {/* Hero */}
        <View style={s.heroWrap}>
          <LinearGradient
            colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
            start={{x: 0.5, y: 0}}
            end={{x: 0.5, y: 1}}
            style={s.heroCard}>
            <ImageryBackdrop source={Imagery.proHero} variant="hero" radius={22} />
            <LinearGradient
              colors={['rgba(91,141,239,0.25)', 'rgba(47,91,224,0.08)']}
              start={{x: 0.2, y: 0}}
              end={{x: 0.9, y: 1}}
              style={s.heroIcon}>
              <Icon name="shield-star" size={30} color={D.accentSoft} />
            </LinearGradient>
            <Text style={s.heroTitle}>Need more than 24 hours?</Text>
            <Text style={s.heroSub}>
              For protection periods longer than a single booking, Bravo Secure Pro builds a
              custom plan around you — a dedicated team, coordinated mobility and continuous
              operational support.
            </Text>
            <View style={s.benefitRow}>
              {BENEFITS.map(b => (
                <View key={b} style={s.benefitPill}>
                  <Icon name="check" size={12} color={D.accentSoft} />
                  <Text style={s.benefitText}>{b}</Text>
                </View>
              ))}
            </View>
          </LinearGradient>
        </View>

        {/* Features */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>WHAT'S INCLUDED</Text>
          <View style={s.featureList}>
            {FEATURES.map(f => (
              <View key={f.title} style={s.featCard}>
                <View style={s.featIcon}>
                  <Icon name={f.icon} size={19} color={D.accentSoft} />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.featTitle}>{f.title}</Text>
                  <Text style={s.featSub}>{f.sub}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>

        {/* How it works */}
        <View style={s.section}>
          <Text style={s.sectionLabel}>HOW IT WORKS</Text>
          <View style={s.stepList}>
            {STEPS.map(step => (
              <View key={step.n} style={s.stepRow}>
                <View style={s.stepNum}><Text style={s.stepNumText}>{step.n}</Text></View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.stepTitle}>{step.title}</Text>
                  <Text style={s.stepDesc}>{step.desc}</Text>
                </View>
              </View>
            ))}
          </View>
          <View style={s.noPriceNote}>
            <Icon name="information-outline" size={15} color={D.textMute} />
            <Text style={s.noPriceText}>
              Pricing is tailored to your requirements — you'll receive a full proposal before
              anything is charged, and you can keep using Bravo Secure Lite while you wait.
            </Text>
          </View>
        </View>
      </ScrollView>

      {/* Footer CTA */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={() => navigation.navigate('SecureProApply')}
          accessibilityRole="button"
          accessibilityLabel="Apply for Bravo Secure Pro">
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.cta}>
            <Icon name="shield-star" size={19} color="#fff" importantForAccessibility="no" />
            <Text style={s.ctaText}>Apply for Bravo Secure Pro</Text>
          </LinearGradient>
        </TouchableOpacity>
        <TouchableOpacity
          style={s.laterBtn}
          activeOpacity={0.7}
          onPress={() => goBackOnce(navigation)}
          accessibilityRole="button"
          accessibilityLabel="Maybe later">
          <Text style={s.laterText}>Maybe later</Text>
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

  heroWrap: {paddingHorizontal: 20},
  heroCard: {borderRadius: 22, padding: 22, borderWidth: 1, borderColor: D.hair2, overflow: 'hidden'},
  heroIcon: {
    width: 60, height: 60, borderRadius: 17, alignSelf: 'center',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  heroTitle: {color: D.text, fontFamily: D.fBold, fontSize: 23, letterSpacing: -0.5, textAlign: 'center', marginTop: 14},
  heroSub: {color: D.textDim, fontFamily: D.fSans, fontSize: 13, lineHeight: 20, textAlign: 'center', marginTop: 10},
  benefitRow: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 16},
  benefitPill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingVertical: 5, paddingHorizontal: 10, borderRadius: 99,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  benefitText: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 11},

  section: {paddingHorizontal: 20, marginTop: 24},
  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginBottom: 12,
  },

  featureList: {gap: 10},
  featCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 13,
    padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(22,27,37,0.72)', borderWidth: 1, borderColor: D.hair,
  },
  featIcon: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  featTitle: {color: D.text, fontFamily: D.fBold, fontSize: 13.5},
  featSub: {color: D.textMute, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16.5, marginTop: 3},

  stepList: {gap: 12},
  stepRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 14},
  stepNum: {
    width: 32, height: 32, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepNumText: {color: D.accentSoft, fontFamily: D.fMono, fontSize: 11, fontWeight: '800'},
  stepTitle: {color: D.text, fontFamily: D.fBold, fontSize: 13},
  stepDesc: {color: D.textMute, fontFamily: D.fSans, fontSize: 11, marginTop: 2, lineHeight: 16},

  noPriceNote: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginTop: 16, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  noPriceText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 11.5, lineHeight: 17, color: D.textMute},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
  laterBtn: {alignSelf: 'center', paddingVertical: 12, paddingHorizontal: 24, marginTop: 2},
  laterText: {color: D.textMute, fontFamily: D.fSemi, fontSize: 13},
}));
