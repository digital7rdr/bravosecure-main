import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  ScrollView,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {scaleTextStyles} from '@utils/scaling';
import {TIER_PRICES_BC} from '@utils/tier';
import {useAuthStore} from '@store/authStore';
import {useWalletStore} from '@store/walletStore';
import {usePaymentFlow} from '@services/stripe';
import {subscriptionApi} from '@services/api';
import {bcToUsd} from '../booking/creditMath';
import {outcomeForSubscribeError} from './proPaywallFlow';
import {TIER_LABELS, TIER_FEATURES} from './tierMatrix';
import {usePlanCatalogStore, planCopy} from '@store/planCatalogStore';

export type PaidTier = 'pro' | 'enterprise';

interface Props {
  tier: PaidTier;
  /**
   * Called when the flow resolves. subscribed=true → the tier is active;
   * false → the user declined and stays on Lite.
   */
  onDone: (subscribed: boolean) => void;
  /**
   * Post-auth "ask at the end" mode (founder rule 5): no back button, and
   * the decline CTA reads "Start as Lite today — explore the app". When
   * false (in-app upgrade), decline is a plain back arrow.
   */
  standalone?: boolean;
  onBack?: () => void;
}

/**
 * M1A — the paid MESSENGER-tier paywall (Bravo Messenger Pro / Enterprise),
 * NOT the Bravo Secure Pro protection plan (that one is request-and-approval
 * via SecureServices and never sold here). Used BOTH as the
 * post-auth subscription ask and as the in-app upgrade surface. Reuses the
 * proven ProPaywall billing flow: subscribe (server debits BC atomically) →
 * on insufficient_credits top up the shortfall via Stripe → retry once.
 * Declining NEVER blocks entry — the account simply stays Lite.
 *
 * Prices are LIVE (ops-editable, GET /subscription/prices) with the
 * compiled constants as offline fallback.
 */
// W4/B-685 — exported through withPaymentBoundary (bottom of file): the Stripe
// provider mounts with THIS screen, not at the App root. See PaymentBoundary.tsx.
function TierPaywall({tier, onDone, standalone = false, onBack}: Props) {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const subscribeToTier = useAuthStore(s => s.subscribeToTier);
  const {balance, loadBalance} = useWalletStore();
  const {topUpAndCharge} = usePaymentFlow();

  const [phase, setPhase] = useState<'idle' | 'subscribing' | 'topup'>('idle');
  const [autoRenew, setAutoRenew] = useState(true);
  const [price, setPrice] = useState<number>(TIER_PRICES_BC[tier]);

  const catalogByKey = usePlanCatalogStore(st => st.byKey);
  const loadPlanCatalog = usePlanCatalogStore(st => st.load);
  useEffect(() => { void loadPlanCatalog(); }, [loadPlanCatalog]);
  const label = planCopy(
    catalogByKey, tier === 'pro' ? 'messenger_pro' : 'messenger_enterprise',
    TIER_LABELS[tier], '',
  ).name;
  const currentBalance = balance?.bravo_credits ?? 0;
  const shortfall = Math.max(0, price - currentBalance);

  useEffect(() => {
    void loadBalance();
    let alive = true;
    subscriptionApi.getPrices()
      .then(({data}) => { if (alive && data?.[tier] > 0) {setPrice(data[tier]);} })
      .catch(() => undefined); // offline → compiled fallback already shown
    return () => { alive = false; };
  }, [loadBalance, tier]);

  const stayOnLite = useCallback((title: string, message: string) => {
    setPhase('idle');
    Alert.alert(title, message);
  }, []);

  const handleSubscribe = useCallback(async () => {
    if (phase !== 'idle') {return;}
    setPhase('subscribing');
    try {
      await subscribeToTier(tier, autoRenew);
      onDone(true);
    } catch (e) {
      const outcome = outcomeForSubscribeError(e);
      if (outcome.kind === 'stay-on-lite') {
        stayOnLite('Subscription failed', outcome.reason);
        return;
      }
      // Not enough BC — top up the shortfall, then retry the subscribe once.
      setPhase('topup');
      try {
        const {charged} = await topUpAndCharge({
          amountFiat: +(bcToUsd(shortfall)).toFixed(2),
          currency: 'usd',
        });
        if (!charged) {
          setPhase('idle');   // user cancelled PaymentSheet — silent, stays Lite
          return;
        }
        await loadBalance().catch(() => undefined);
        await subscribeToTier(tier, autoRenew);
        onDone(true);
      } catch (topupErr) {
        stayOnLite(
          'Payment failed',
          topupErr instanceof Error
            ? topupErr.message
            : 'We could not complete the payment. You are still on Lite.',
        );
      }
    }
  }, [phase, subscribeToTier, tier, autoRenew, topUpAndCharge, shortfall, loadBalance, stayOnLite, onDone]);

  const busy = phase !== 'idle';
  const busyLabel = phase === 'topup' ? 'Processing payment…' : `Activating ${label}…`;

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={styles.header}>
        {!standalone && onBack ? (
          <TouchableOpacity style={styles.backBtn} onPress={onBack} activeOpacity={0.7} disabled={busy}>
            <Icon name="arrow-left" size={20} color="#CBD5E1" />
          </TouchableOpacity>
        ) : <View style={styles.backBtn} />}
        <Text style={styles.headerTitle}>{label}</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 168}]}>

        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.heroIcon}>
            <Icon name={tier === 'enterprise' ? 'office-building' : 'shield-star'} size={36} color="#FFF" />
          </View>
          <Text style={styles.heroTitle}>
            {standalone ? `One step from ${label}` : `Upgrade to ${label}`}
          </Text>
          <Text style={styles.heroSub}>
            {standalone
              ? 'Your account is ready. Activate your plan now, or start on Lite and upgrade whenever you like.'
              : 'Activate your plan below. You keep everything you already have on Lite.'}
          </Text>
        </View>

        {/* Price card */}
        <View style={styles.priceCard}>
          <View style={styles.priceRow}>
            <Icon name="star-four-points" size={22} color="#FBBF24" />
            <Text style={styles.priceValue}>{price.toLocaleString()}</Text>
            <Text style={styles.priceUnit}>BC<Text style={styles.pricePeriod}> / 30 days</Text></Text>
          </View>
          <View style={styles.balanceRow}>
            <Text style={styles.balanceLabel}>Your balance</Text>
            <Text style={[styles.balanceVal, shortfall > 0 && {color: '#F59E0B'}]}>
              {currentBalance.toLocaleString()} BC
            </Text>
          </View>
          {shortfall > 0 && (
            <View style={styles.shortfallNote}>
              <Icon name="information-outline" size={13} color="#F59E0B" />
              <Text style={styles.shortfallText}>
                You need {shortfall.toLocaleString()} more BC. We'll top up the
                difference via card, then activate {label}.
              </Text>
            </View>
          )}
        </View>

        {/* Full feature column — the complete M1A matrix list, never shorthand. */}
        <Text style={styles.sectionLabel}>Everything in {label}</Text>
        <View style={styles.featureCard}>
          {TIER_FEATURES[tier].map(f => (
            <View key={f} style={styles.featureRow}>
              <Icon name="check-circle" size={16} color="#34d399" />
              <Text style={styles.featureLabel}>{f}</Text>
            </View>
          ))}
        </View>

        {/* Auto-renew toggle */}
        <TouchableOpacity
          style={styles.renewRow}
          activeOpacity={0.8}
          onPress={() => setAutoRenew(v => !v)}
          disabled={busy}>
          <View style={{flex: 1}}>
            <Text style={styles.renewLabel}>Auto-renew every 30 days</Text>
            <Text style={styles.renewSub}>
              Renews from your Bravo Credits (or card, when enabled) so {label} never lapses. Cancel anytime.
            </Text>
          </View>
          <View style={[styles.toggle, autoRenew && styles.toggleOn]}>
            <View style={[styles.toggleThumb, autoRenew && styles.toggleThumbOn]} />
          </View>
        </TouchableOpacity>

        <View style={styles.secureRow}>
          <Icon name="lock" size={12} color="#475569" />
          <Text style={styles.secureText}>
            Charged in Bravo Credits. Card top-up (if needed) secured by Stripe.
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.footer, {paddingBottom: bottomPad(14)}]}>
        <TouchableOpacity
          style={[styles.cta, busy && {opacity: 0.7}]}
          onPress={() => { void handleSubscribe(); }}
          disabled={busy}
          activeOpacity={0.85}>
          {busy ? (
            <>
              <ActivityIndicator color="#FFF" />
              <Text style={styles.ctaText}>{busyLabel}</Text>
            </>
          ) : (
            <>
              <Icon name={tier === 'enterprise' ? 'office-building' : 'shield-star'} size={18} color="#FFF" />
              <Text style={styles.ctaText}>
                {shortfall > 0 ? 'Top up & Subscribe' : `Subscribe · ${price.toLocaleString()} BC`}
              </Text>
            </>
          )}
        </TouchableOpacity>
        {/* Founder rule 10 — declining is an explicit, honest path to Lite. */}
        <TouchableOpacity
          style={styles.declineBtn}
          onPress={() => onDone(false)}
          disabled={busy}
          activeOpacity={0.8}>
          <Text style={styles.declineText}>
            {standalone ? 'Start as Lite today — explore the app' : 'Not now — stay on my current plan'}
          </Text>
        </TouchableOpacity>
        <Text style={styles.footerHint}>
          You can change your plan any time in Profile → Messenger Plans.
        </Text>
      </View>
    </View>
  );
}

const T = {bg: '#07090D', card: '#0D1421', hair: '#1C2536', text: '#F2F4F8', dim: '#94A3B8', mute: '#64748B', accent: '#5B8DEF'};

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: T.hair},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 14, fontWeight: '800', color: T.text, letterSpacing: 0.5},

  scroll: {padding: 16, gap: 14},

  hero: {alignItems: 'center', gap: 10, paddingTop: 8},
  heroIcon: {width: 72, height: 72, borderRadius: 22, backgroundColor: T.accent, alignItems: 'center', justifyContent: 'center', shadowColor: T.accent, shadowOpacity: 0.45, shadowRadius: 18, shadowOffset: {width: 0, height: 6}, elevation: 6},
  heroTitle: {fontSize: 22, fontWeight: '800', color: T.text},
  heroSub: {fontSize: 13, color: T.dim, textAlign: 'center', lineHeight: 19, paddingHorizontal: 12},

  priceCard: {backgroundColor: T.card, borderRadius: 18, padding: 18, borderWidth: 1, borderColor: T.hair, gap: 12},
  priceRow: {flexDirection: 'row', alignItems: 'flex-end', gap: 8},
  priceValue: {fontSize: 34, fontWeight: '800', color: T.text, letterSpacing: -1},
  priceUnit: {fontSize: 16, fontWeight: '700', color: T.dim, marginBottom: 5},
  pricePeriod: {fontSize: 13, fontWeight: '600', color: T.mute},
  balanceRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', borderTopWidth: 1, borderTopColor: T.hair, paddingTop: 12},
  balanceLabel: {fontSize: 12, color: T.dim},
  balanceVal: {fontSize: 14, fontWeight: '700', color: '#34d399'},
  shortfallNote: {flexDirection: 'row', gap: 8, backgroundColor: 'rgba(245,158,11,0.08)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.25)', borderRadius: 10, padding: 10},
  shortfallText: {flex: 1, fontSize: 11, color: '#F59E0B', lineHeight: 16},

  sectionLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: T.mute, marginTop: 4},
  featureCard: {backgroundColor: T.card, borderWidth: 1, borderColor: T.hair, borderRadius: 14, padding: 14, gap: 11},
  featureRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  featureLabel: {flex: 1, fontSize: 13, fontWeight: '600', color: T.text},

  renewRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair, borderRadius: 14, padding: 14, marginTop: 4},
  renewLabel: {fontSize: 13, fontWeight: '700', color: T.text},
  renewSub: {fontSize: 11, color: T.mute, marginTop: 2, lineHeight: 15},
  toggle: {width: 44, height: 26, borderRadius: 13, backgroundColor: T.hair, justifyContent: 'center', paddingHorizontal: 3},
  toggleOn: {backgroundColor: T.accent},
  toggleThumb: {width: 20, height: 20, borderRadius: 10, backgroundColor: T.mute},
  toggleThumbOn: {backgroundColor: '#FFF', marginLeft: 18},

  secureRow: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, marginTop: 4},
  secureText: {flex: 1, fontSize: 10.5, color: '#475569', lineHeight: 15},

  footer: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: T.hair, backgroundColor: T.bg},
  cta: {backgroundColor: T.accent, borderRadius: 16, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, shadowColor: T.accent, shadowOpacity: 0.35, shadowRadius: 14, shadowOffset: {width: 0, height: 4}, elevation: 5},
  ctaText: {fontSize: 14, fontWeight: '800', color: '#FFF', letterSpacing: 0.5},
  declineBtn: {alignItems: 'center', paddingVertical: 12, marginTop: 2},
  declineText: {fontSize: 13, fontWeight: '700', color: T.dim},
  footerHint: {textAlign: 'center', fontSize: 10, color: '#475569'},
}));

import {withPaymentBoundary} from '@components/PaymentBoundary';
export default withPaymentBoundary(TierPaywall);
