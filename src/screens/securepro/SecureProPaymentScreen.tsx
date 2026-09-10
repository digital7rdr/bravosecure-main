/**
 * Bravo Secure Pro — payment & activation (pages 12–13).
 *
 * Shows the accepted proposal's full-period Bravo Credits total against the
 * live wallet balance. Shortfall → Top Up (existing CreditPaywall flow);
 * sufficient → Pay & Activate (server debits + flips ACTIVE atomically).
 * Success state renders in place ("Bravo Secure Pro Activated") with the
 * Pro dashboard CTA.
 */
import React, {useCallback} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useSecureProStore} from '@store/secureProStore';
import {useWalletStore} from '@store/walletStore';
import {useProAppRealtime} from './useProAppRealtime';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'SecureProPayment'>;

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
  amber:      '#F5C76B',
  alert:      '#FF5D5D',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

function fmtDate(iso: string | null | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

export default function SecureProPaymentScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad, contentBottom} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const application = useSecureProStore(st => st.application);
  const isSubmitting = useSecureProStore(st => st.isSubmitting);
  const storeError = useSecureProStore(st => st.error);
  const loadApplication = useSecureProStore(st => st.loadApplication);
  const activate = useSecureProStore(st => st.activate);
  const balance = useWalletStore(st => st.balance);
  const loadBalance = useWalletStore(st => st.loadBalance);

  useFocusEffect(useCallback(() => {
    void loadApplication();
    void loadBalance();
  }, [loadApplication, loadBalance]));
  useProAppRealtime(application?.id, () => { void loadApplication(); });

  const proposal = application?.proposal ?? null;
  const total = proposal?.total_credits ?? 0;
  const credits = balance?.bravo_credits ?? 0;
  const shortfall = Math.max(0, total - credits);
  const isActive = application?.status === 'ACTIVE';
  const payable = application?.status === 'ACCEPTED' && total > 0;

  const handleActivate = async () => {
    try {
      await activate();
      void loadBalance();
    } catch {
      // surfaced inline via storeError; a topup-shortfall message guides to Top Up.
    }
  };

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
          <Text style={s.headerTitle}>{isActive ? 'Plan Activated' : 'Activate Your Pro Plan'}</Text>
          <FitLine style={s.headerSub} text={'BRAVO SECURE PRO · PAYMENT'} />
        </View>
      </View>

      {!application || (!proposal && !isActive) ? (
        <View style={s.centerFill}>
          <ActivityIndicator color={D.accent} />
        </View>
      ) : isActive ? (
        /* ── Page 13 — activated ── */
        <ScrollView
          style={{flex: 1}}
          contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(120), flexGrow: 1, justifyContent: 'center'}}
          showsVerticalScrollIndicator={false}>
          <View style={s.activatedWrap}>
            <View style={s.activatedRing}>
              <Icon name="check" size={40} color={D.signal} />
            </View>
            <Text style={s.activatedTitle}>Bravo Secure Pro{'\n'}Activated</Text>
            <Text style={s.activatedSub}>
              Your account is now active. Your dedicated team and linked family members are
              available from the Pro dashboard.
            </Text>
            <View style={[s.card, {alignSelf: 'stretch'}]}>
              <InfoRow label="PLAN START" value={fmtDate(application.activated_at)} />
              <InfoRow label="COVERED UNTIL" value={fmtDate(application.covered_until ?? application.current_period_end)} border />
              <InfoRow label="PLAN TOTAL" value={`${total.toLocaleString()} BC`} border />
              <View style={[s.infoRow, s.rowBorder]}>
                <Text style={s.infoLabel}>STATUS</Text>
                <View style={s.activePill}>
                  <View style={s.activeDot} />
                  <Text style={s.activePillText}>ACTIVE</Text>
                </View>
              </View>
            </View>
            <TouchableOpacity
              style={{alignSelf: 'stretch'}}
              activeOpacity={0.9}
              onPress={() => navigation.replace('ProDashboard')}
              accessibilityRole="button"
              accessibilityLabel="Open Pro dashboard">
              <LinearGradient
                colors={['#6E9BF5', D.accent, D.accentDeep]}
                locations={[0, 0.55, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={s.cta}>
                <Icon name="view-dashboard-outline" size={18} color="#fff" importantForAccessibility="no" />
                <Text style={s.ctaText}>Open Pro Dashboard</Text>
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </ScrollView>
      ) : (
        /* ── Page 12 — pay ── */
        <>
          <ScrollView
            style={{flex: 1}}
            contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(160)}}
            showsVerticalScrollIndicator={false}>
            <Text style={s.leadCopy}>
              Your plan is ready. Pay {proposal ? proposal.proposal_number : 'your proposal'}'s
              full coverage period with Bravo Credits to activate — one payment, no monthly billing.
            </Text>

            <LinearGradient
              colors={['rgba(20,32,60,0.78)', 'rgba(11,15,23,0.7)']}
              start={{x: 0.5, y: 0}}
              end={{x: 0.5, y: 1}}
              style={s.heroCard}>
      <ImageryBackdrop source={Imagery.packageHero} variant="hero" radius={22} />
              <Text style={s.heroLabel}>REQUIRED · FULL COVERAGE PERIOD</Text>
              <View style={s.heroPriceRow}>
                <Text style={s.heroPrice}>{total.toLocaleString()}</Text>
                <Text style={s.heroPriceUnit}>BC total</Text>
              </View>
            </LinearGradient>

            <Text style={s.sectionLabel}>YOUR BALANCE</Text>
            <View style={s.card}>
              <InfoRow label="AVAILABLE" value={`${credits.toLocaleString()} BC`} />
              <InfoRow label="PLAN TOTAL" value={`−${total.toLocaleString()} BC`} border />
              {shortfall > 0 ? (
                <View style={[s.shortfallBox]}>
                  <Icon name="alert-circle-outline" size={16} color={D.amber} />
                  <Text style={s.shortfallText}>
                    You need <Text style={s.shortfallStrong}>{shortfall.toLocaleString()} BC</Text> more
                    to activate this plan.
                  </Text>
                </View>
              ) : (
                <View style={[s.infoRow, s.rowBorder]}>
                  <Text style={s.infoLabel}>AFTER PAYMENT</Text>
                  <Text style={s.infoValue}>{(credits - total).toLocaleString()} BC</Text>
                </View>
              )}
            </View>

            {proposal ? (
              <>
                <Text style={s.sectionLabel}>COVERAGE</Text>
                <View style={s.card}>
                  <InfoRow label="PERIOD" value={`${fmtDate(proposal.coverage_start)} → ${fmtDate(proposal.coverage_end)}`} />
                  <InfoRow label="BILLING" value="One payment for the full period" border />
                </View>
              </>
            ) : null}

            {storeError ? <Text style={s.errText}>{storeError}</Text> : null}
          </ScrollView>

          <LinearGradient
            colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
            locations={[0, 0.4]}
            style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
            {shortfall > 0 ? (
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => navigation.navigate('CreditPaywall', {source: 'wallet', amountDue: shortfall})}
                accessibilityRole="button"
                accessibilityLabel="Top up Bravo Credits">
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  <Icon name="star-four-points" size={18} color="#fff" importantForAccessibility="no" />
                  <Text style={s.ctaText}>Top Up Bravo Credits</Text>
                </LinearGradient>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={() => { void handleActivate(); }}
                disabled={isSubmitting || !payable}
                accessibilityRole="button"
                accessibilityLabel="Pay and activate"
                accessibilityState={{disabled: isSubmitting || !payable}}>
                <LinearGradient
                  colors={!payable
                    ? ['rgba(91,141,239,0.35)', 'rgba(91,141,239,0.35)', 'rgba(47,91,224,0.35)']
                    : ['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.cta}>
                  {isSubmitting ? (
                    <ActivityIndicator color="#fff" />
                  ) : (
                    <>
                      <Icon name="shield-star" size={18} color="#fff" importantForAccessibility="no" />
                      <Text style={s.ctaText}>Pay & Activate</Text>
                    </>
                  )}
                </LinearGradient>
              </TouchableOpacity>
            )}
          </LinearGradient>
        </>
      )}
    </View>
  );
}

function InfoRow({label, value, border}: {label: string; value: string; border?: boolean}) {
  return (
    <View style={[s.infoRow, border && s.rowBorder]}>
      <Text style={s.infoLabel}>{label}</Text>
      <Text style={s.infoValue} numberOfLines={1}>{value}</Text>
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

  centerFill: {flex: 1, alignItems: 'center', justifyContent: 'center'},

  leadCopy: {color: D.textDim, fontFamily: D.fSans, fontSize: 13, lineHeight: 19, marginBottom: 16},

  heroCard: {
    borderRadius: 22, padding: 22, borderWidth: 1, borderColor: D.hair2,
    overflow: 'hidden', alignItems: 'center',
  },
  heroLabel: {color: D.textMute, fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.8},
  heroPriceRow: {flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 10},
  heroPrice: {color: D.text, fontFamily: D.fBold, fontSize: 38, letterSpacing: -1},
  heroPriceUnit: {color: D.accentSoft, fontFamily: D.fSemi, fontSize: 14},

  sectionLabel: {
    color: D.textDim, fontFamily: D.fMono, fontSize: 10, fontWeight: '600',
    letterSpacing: 2, textTransform: 'uppercase', marginTop: 22, marginBottom: 10,
  },
  card: {
    borderRadius: 16, backgroundColor: 'rgba(22,27,37,0.72)',
    borderWidth: 1, borderColor: D.hair, overflow: 'hidden',
  },
  rowBorder: {borderTopWidth: 1, borderTopColor: D.hair},

  infoRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    gap: 12, paddingHorizontal: 14, paddingVertical: 13,
  },
  infoLabel: {flexShrink: 1, minWidth: 0, color: D.textMute, fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.2},
  infoValue: {flexShrink: 1, minWidth: 0, color: D.text, fontFamily: D.fBold, fontSize: 13.5},

  shortfallBox: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    margin: 12, padding: 12, borderRadius: 12,
    backgroundColor: 'rgba(245,199,107,0.08)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.3)',
  },
  shortfallText: {flex: 1, minWidth: 0, color: D.textDim, fontFamily: D.fSans, fontSize: 12, lineHeight: 17},
  shortfallStrong: {color: D.amber, fontFamily: D.fBold},

  errText: {color: D.alert, fontFamily: D.fSemi, fontSize: 11.5, textAlign: 'center', marginTop: 14},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 56, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.3, color: '#fff'},

  activatedWrap: {alignItems: 'center', gap: 16},
  activatedRing: {
    width: 88, height: 88, borderRadius: 44,
    backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1.5, borderColor: 'rgba(74,222,128,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  activatedTitle: {color: D.text, fontFamily: D.fBold, fontSize: 26, letterSpacing: -0.6, textAlign: 'center', lineHeight: 32},
  activatedSub: {color: D.textDim, fontFamily: D.fSans, fontSize: 13, lineHeight: 19, textAlign: 'center', paddingHorizontal: 8},
  activePill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingVertical: 4, paddingHorizontal: 10, borderRadius: 99,
    backgroundColor: 'rgba(74,222,128,0.1)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.4)',
  },
  activeDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: D.signal},
  activePillText: {color: D.signal, fontFamily: D.fMono, fontSize: 9.5, fontWeight: '800', letterSpacing: 1.2},
}));
