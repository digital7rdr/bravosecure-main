import React, {useState, useEffect} from 'react';
import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  } from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Alert} from '@utils/alert';
import {Colors, Spacing} from '@theme/index';
import {useWalletStore} from '@store/walletStore';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

interface StoragePlan {
  id: string;
  label: string;
  subLabel: string;
  incrementMb: number;
  eurPrice: number;
  aedPrice: number;
  isPopular?: boolean;
}

const STORAGE_PLANS: StoragePlan[] = [
  {id: '500mb', label: '500 MB', subLabel: '+1× 500 MB increment', incrementMb: 500,  eurPrice: 4.99,  aedPrice: 18},
  {id: '1gb',   label: '1 GB',   subLabel: '+2× 500 MB increments', incrementMb: 1024, eurPrice: 8.49,  aedPrice: 34},
  {id: '2gb',   label: '2.5 GB', subLabel: '+5× 500 MB increments', incrementMb: 2560, eurPrice: 22.99, aedPrice: 84, isPopular: true},
  {id: '5gb',   label: '5 GB',   subLabel: '+10× 500 MB increments', incrementMb: 5120, eurPrice: 44.99, aedPrice: 186},
];

function usagePct(used: number, total: number): number {
  if (total === 0) {return 0;}
  return Math.min(100, Math.round((used / total) * 100));
}

function mbLabel(mb: number): string {
  if (mb >= 1024) {return `${(mb / 1024).toFixed(1).replace('.0', '')} GB`;}
  return `${mb} MB`;
}

export default function FileVaultPurchaseScreen() {
  // This screen is registered with `headerShown: false` in every navigator that
  // hosts it, and it had no safe-area handling at all — so the "‹ Back" row,
  // which B-98b added precisely so a paywall is always escapable, rendered
  // UNDER the status bar and its clock.
  const insets = useSafeAreaInsets();
  const {vaultUsedMb, vaultTotalMb, isLoading, loadVaultStorage, purchaseVaultStorage} =
    useWalletStore();
  const navigation = useNavigation();

  const [selected, setSelected] = useState<string | null>(null);
  const [isPurchasing, setIsPurchasing] = useState(false);

  useEffect(() => {
    void loadVaultStorage();
  }, [loadVaultStorage]);

  const pct = usagePct(vaultUsedMb, vaultTotalMb);
  const isHighUsage = pct >= 80;

  const handlePurchase = async () => {
    if (!selected) {
      Alert.alert('Select a Plan', 'Please select a storage plan to continue.');
      return;
    }
    const plan = STORAGE_PLANS.find(p => p.id === selected);
    if (!plan) {return;}

    setIsPurchasing(true);
    try {
      await purchaseVaultStorage(plan.incrementMb);
      Alert.alert(
        'Storage Upgraded',
        `${plan.label} has been added to your vault. Your new total is ${mbLabel(vaultTotalMb + plan.incrementMb)}.`,
        [{text: 'OK', onPress: () => navigation.goBack()}],
      );
    } catch (e: unknown) {
      Alert.alert('Purchase Failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      setIsPurchasing(false);
    }
  };

  if (isLoading && vaultTotalMb === 100 && vaultUsedMb === 0) {
    return (
      <View style={styles.loader}>
        <LoadingView label="Loading storage plans…" />
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        {paddingTop: insets.top + Spacing.base, paddingBottom: insets.bottom + Spacing['4xl']},
      ]}>

      {/* B-98b G2 — a paywall must always be escapable: the only goBack used
          to live inside the post-purchase Alert. */}
      <TouchableOpacity
        style={styles.backRow}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        onPress={() => goBackOnce(navigation)}>
        <Text style={styles.backRowText}>‹  Back</Text>
      </TouchableOpacity>

      {/* ── Storage Usage Bar ── */}
      <View style={styles.usageCard}>
        <View style={styles.usageHeader}>
          <Text style={styles.usageLabel}>VAULT STORAGE</Text>
          <Text style={styles.usageNumbers}>
            {mbLabel(vaultUsedMb)} / {mbLabel(vaultTotalMb)}
          </Text>
        </View>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              {width: `${pct}%` as `${number}%`},
              isHighUsage && styles.progressFillWarn,
            ]}
          />
        </View>

        {isHighUsage && (
          <View style={styles.usageWarning}>
            <Text style={styles.usageWarningText}>
              ⚠  You've used {pct}% of your vault. Upgrade to continue.
            </Text>
          </View>
        )}
      </View>

      {/* ── MFA Notice ── */}
      <View style={styles.mfaNotice}>
        <Text style={styles.mfaIcon}>🔒</Text>
        <Text style={styles.mfaText}>
          File Vault access requires Multi-Factor Authentication every session for your security.
        </Text>
      </View>

      {/* ── Storage Plans ── */}
      <Text style={styles.sectionLabel}>ADD STORAGE — CHOOSE INCREMENT</Text>

      {STORAGE_PLANS.map(plan => (
        <TouchableOpacity
          key={plan.id}
          style={[styles.planCard, selected === plan.id && styles.planSelected]}
          onPress={() => setSelected(plan.id)}
          activeOpacity={0.8}>
          <View style={styles.planLeft}>
            <View style={styles.planLabelRow}>
              <Text style={[styles.planLabel, selected === plan.id && styles.planLabelSelected]}>
                {plan.label}
              </Text>
              {plan.isPopular && (
                <View style={styles.popularBadge}>
                  <Text style={styles.popularText}>POPULAR</Text>
                </View>
              )}
            </View>
            <Text style={styles.planSub}>{plan.subLabel}</Text>
          </View>
          <View style={styles.planRight}>
            <Text style={[styles.planPrice, selected === plan.id && styles.planPriceSelected]}>
              {plan.eurPrice} BC
            </Text>
          </View>
        </TouchableOpacity>
      ))}

      {/* ── CTA ── */}
      <TouchableOpacity
        style={[styles.cta, (!selected || isPurchasing) && styles.ctaDisabled]}
        onPress={() => { void handlePurchase(); }}
        disabled={!selected || isPurchasing}
        activeOpacity={0.85}>
        {isPurchasing
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.ctaText}>PURCHASE STORAGE →</Text>}
      </TouchableOpacity>

      <Text style={styles.baseNote}>
        Your first 100 MB of encrypted cloud storage is free. Storage expands immediately after purchase.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  container: {
    flex: 1,
    backgroundColor: Colors.background,
  },
  backRow: {
    alignSelf: 'flex-start',
    paddingVertical: 10,
    paddingRight: 16,
    marginBottom: 4,
  },
  backRowText: {
    color: Colors.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  content: {
    // Vertical padding is applied at the call site from the live safe-area
    // insets; only the horizontal pad is static.
    paddingHorizontal: Spacing.base,
  },
  loader: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: Colors.background,
  },

  usageCard: {backgroundColor:'#0C1018', borderRadius:16, padding:16, marginBottom:12, borderWidth:1, borderColor:'rgba(255,255,255,0.06)'},
  usageHeader: {flexDirection:'row', justifyContent:'space-between', marginBottom:10},
  usageLabel: {fontSize:11, fontWeight:'700', color:'rgba(180,188,204,0.45)', letterSpacing:2, textTransform:'uppercase'},
  usageNumbers: {fontSize:13, fontWeight:'700', color:'#F2F4F8'},
  progressTrack: {height:8, backgroundColor:'rgba(255,255,255,0.06)', borderRadius:4, overflow:'hidden'},
  progressFill: {height:'100%', backgroundColor:'#5B8DEF', borderRadius:4},
  progressFillWarn: {backgroundColor:'#F59E0B'},
  usageWarning: {backgroundColor:'rgba(245,158,11,0.08)', borderRadius:8, padding:10, marginTop:10, borderWidth:1, borderColor:'#F59E0B'},
  usageWarningText: {fontSize:12, color:'#F59E0B', fontWeight:'600'},

  mfaNotice: {flexDirection:'row', alignItems:'flex-start', backgroundColor:'rgba(91,141,239,0.05)', borderRadius:10, padding:12, marginBottom:4, borderWidth:1, borderColor:'rgba(255,255,255,0.06)', gap:10},
  mfaIcon: {fontSize:16, marginTop:1},
  mfaText: {fontSize:12, color:'rgba(229,233,242,0.62)', flex:1, lineHeight:18},

  sectionLabel: {fontSize:11, fontWeight:'700', color:'rgba(180,188,204,0.45)', letterSpacing:2, textTransform:'uppercase', marginBottom:10},

  planCard: {flexDirection:'row', justifyContent:'space-between', alignItems:'center', backgroundColor:'#0C1018', borderRadius:14, padding:16, marginBottom:10, borderWidth:1.5, borderColor:'rgba(255,255,255,0.06)'},
  planSelected: {borderColor:'#5B8DEF', backgroundColor:'rgba(91,141,239,0.07)'},
  planLeft: {flex:1},
  planLabelRow: {flexDirection:'row', alignItems:'center', gap:8},
  planLabel: {fontSize:16, fontWeight:'700', color:'#F2F4F8'},
  planLabelSelected: {color:'#5B8DEF'},
  planSub: {fontSize:12, color:'rgba(180,188,204,0.45)', marginTop:3},
  popularBadge: {backgroundColor:'#5B8DEF', borderRadius:99, paddingHorizontal:8, paddingVertical:2},
  popularText: {fontSize:9, fontWeight:'800', color:'#FFF', letterSpacing:0.8},
  planRight: {alignItems:'flex-end', marginLeft:12},
  planPrice: {fontSize:17, fontWeight:'800', color:'#F2F4F8'},
  planPriceSelected: {color:'#5B8DEF'},

  cta: {backgroundColor:'#5B8DEF', borderRadius:12, paddingVertical:16, alignItems:'center', marginTop:4, shadowColor:'#5B8DEF', shadowOffset:{width:0,height:6}, shadowOpacity:0.35, shadowRadius:16, elevation:6},
  ctaDisabled: {opacity:0.45},
  ctaText: {fontSize:14, fontWeight:'800', color:'#FFF', letterSpacing:0.5},
  baseNote: {textAlign:'center', fontSize:12, color:'rgba(180,188,204,0.45)', marginTop:12, lineHeight:18},
}));
