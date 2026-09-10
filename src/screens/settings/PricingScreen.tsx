import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  ScrollView,
  ActivityIndicator,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {TIER_PRICES_BC, effectiveTier} from '@utils/tier';
import {useAuthStore} from '@store/authStore';
import {subscriptionApi} from '@services/api';
import {TIER_LABELS, TIER_FEATURES} from '@screens/pro/tierMatrix';
import {usePlanCatalogStore, planCopy} from '@store/planCatalogStore';

/** users.subscription_tier -> catalog key (ops-editable copy overlay). */
const TIER_CATALOG_KEY = {
  lite: 'messenger_lite', pro: 'messenger_pro', enterprise: 'messenger_enterprise',
} as const;
type LadderTier = keyof typeof TIER_CATALOG_KEY;

function useTierName(): (tier: LadderTier) => string {
  const byKey = usePlanCatalogStore(st => st.byKey);
  return (tier: LadderTier) =>
    planCopy(byKey, TIER_CATALOG_KEY[tier], TIER_LABELS[tier], '').name;
}
import type {PackageTier} from '@appTypes/index';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'Pricing'>;

const ORDER: PackageTier[] = ['lite', 'pro', 'enterprise'];

/**
 * M1A rule 11 — Settings → Pricing: the full tier matrix, the account's
 * current plan, and easy tier changes in ≤2 taps.
 *
 * - Upgrade (or paid→paid switch) → the TierPaywall route (live price,
 *   BC debit + card top-up fallback, auto-renew toggle).
 * - Downgrade to Lite → cancel every renewal path; the paid tier is kept
 *   until the period a user already paid for lapses (D-2), then the
 *   server sweep flips to Lite.
 *
 * Prices are LIVE (ops-editable); compiled constants are the offline
 * fallback. Service-provider accounts never see this screen (their
 * billing is payouts, not subscriptions — the Profile row is hidden).
 */
export default function PricingScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const user = useAuthStore(s => s.user);

  const [prices, setPrices] = useState<{pro: number; enterprise: number}>({
    pro: TIER_PRICES_BC.pro,
    enterprise: TIER_PRICES_BC.enterprise,
  });
  const [cancelling, setCancelling] = useState(false);

  const current = effectiveTier(user);
  const until = user?.pro_active_until ?? null;
  const untilLabel = until
    ? new Date(until).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'})
    : null;

  useEffect(() => {
    let alive = true;
    subscriptionApi.getPrices()
      .then(({data}) => {
        if (!alive) {return;}
        setPrices(p => ({
          pro: data?.pro > 0 ? data.pro : p.pro,
          enterprise: data?.enterprise > 0 ? data.enterprise : p.enterprise,
        }));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const openPaywall = useCallback((tier: 'pro' | 'enterprise') => {
    navigation.navigate('TierPaywall', {tier, returnTo: 'Pricing'});
  }, [navigation]);

  const tierName = useTierName();
  const loadPlanCatalog = usePlanCatalogStore(st => st.load);
  useEffect(() => { void loadPlanCatalog(); }, [loadPlanCatalog]);

  const downgradeToLite = useCallback(() => {
    const label = tierName(current as 'pro' | 'enterprise') ?? 'your plan';
    Alert.alert(
      'Downgrade to Lite',
      untilLabel
        ? `You keep ${label} until ${untilLabel} — you already paid for it. After that your account becomes Lite and renewals stop.`
        : 'Renewals stop and your account becomes Lite when the current period ends.',
      [
        {text: 'Keep my plan', style: 'cancel'},
        {
          text: 'Downgrade',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              setCancelling(true);
              try {
                await subscriptionApi.cancelAutoRenew();
                Alert.alert(
                  'Downgrade scheduled',
                  untilLabel
                    ? `${label} stays active until ${untilLabel}, then you'll be on Lite.`
                    : 'Renewals are off. You will move to Lite at the end of the current period.',
                );
              } catch {
                Alert.alert('Could not downgrade', 'Please check your connection and try again.');
              } finally {
                setCancelling(false);
              }
            })();
          },
        },
      ],
    );
  }, [current, untilLabel, tierName]);

  const ctaFor = (tier: PackageTier): {label: string; onPress?: () => void; muted?: boolean} => {
    if (tier === current) {return {label: 'Current plan', muted: true};}
    if (tier === 'lite') {return {label: 'Downgrade to Lite', onPress: downgradeToLite};}
    const price = prices[tier];
    const verb = ORDER.indexOf(tier) > ORDER.indexOf(current) ? 'Upgrade' : 'Switch';
    return {label: `${verb} · ${price.toLocaleString()} BC / 30 days`, onPress: () => openPaywall(tier)};
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#CBD5E1" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Messenger Plans</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 32}]}>

        {/* Current plan */}
        <View style={styles.currentCard}>
          <View style={styles.currentIcon}>
            <Icon name={current === 'lite' ? 'account' : current === 'pro' ? 'shield-star' : 'office-building'} size={22} color="#A9C5FF" />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.currentLabel}>CURRENT PLAN</Text>
            <Text style={styles.currentTier}>{tierName(current)}</Text>
            {current !== 'lite' && (
              <Text style={styles.currentUntil}>
                {untilLabel ? `Active until ${untilLabel}` : 'No expiry'}
              </Text>
            )}
          </View>
          {cancelling && <ActivityIndicator color="#5B8DEF" />}
        </View>

        {/* Tier cards — full matrix columns, never shorthand (M1A §2). */}
        {ORDER.map(tier => {
          const cta = ctaFor(tier);
          const isCurrent = tier === current;
          return (
            <View key={tier} style={[styles.tierCard, isCurrent && styles.tierCardCurrent]}>
              <View style={styles.tierHead}>
                <Text style={styles.tierName}>{tierName(tier)}</Text>
                <Text style={styles.tierPrice}>
                  {tier === 'lite' ? 'Free' : `${prices[tier].toLocaleString()} BC / 30 days`}
                </Text>
              </View>
              <View style={styles.featureList}>
                {TIER_FEATURES[tier].map(f => (
                  <View key={f} style={styles.featureRow}>
                    <Icon name="check-circle" size={15} color="#34d399" />
                    <Text style={styles.featureText}>{f}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.cta, cta.muted && styles.ctaMuted]}
                disabled={!cta.onPress || cancelling}
                onPress={cta.onPress}
                activeOpacity={0.85}>
                <Text style={[styles.ctaText, cta.muted && styles.ctaTextMuted]}>{cta.label}</Text>
              </TouchableOpacity>
            </View>
          );
        })}

        <Text style={styles.note}>
          Plans are charged in Bravo Credits. Downgrades keep your paid time —
          the change applies when the current period ends. Price changes apply
          from your next renewal.
        </Text>
      </ScrollView>
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

  currentCard: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)', borderRadius: 16, padding: 16},
  currentIcon: {width: 44, height: 44, borderRadius: 13, backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)', alignItems: 'center', justifyContent: 'center'},
  currentLabel: {fontSize: 9, fontWeight: '700', letterSpacing: 1.8, color: T.mute},
  currentTier: {fontSize: 18, fontWeight: '800', color: T.text, marginTop: 2},
  currentUntil: {fontSize: 11.5, color: T.dim, marginTop: 2},

  tierCard: {backgroundColor: T.card, borderWidth: 1, borderColor: T.hair, borderRadius: 18, padding: 16, gap: 12},
  tierCardCurrent: {borderColor: 'rgba(91,141,239,0.45)'},
  tierHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  tierName: {fontSize: 17, fontWeight: '800', color: T.text},
  tierPrice: {fontSize: 12.5, fontWeight: '700', color: '#FBBF24'},
  featureList: {gap: 9},
  featureRow: {flexDirection: 'row', alignItems: 'center', gap: 9},
  featureText: {flex: 1, fontSize: 12.5, fontWeight: '500', color: T.dim},

  cta: {backgroundColor: T.accent, borderRadius: 13, paddingVertical: 13, alignItems: 'center'},
  ctaMuted: {backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair},
  ctaText: {fontSize: 13, fontWeight: '800', color: '#FFF', letterSpacing: 0.3},
  ctaTextMuted: {color: T.mute},

  note: {fontSize: 10.5, color: '#475569', lineHeight: 16, textAlign: 'center', paddingHorizontal: 8},
}));
