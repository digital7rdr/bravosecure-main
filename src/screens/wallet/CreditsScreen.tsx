import React, {useEffect, useState} from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  StatusBar,
  Modal,
  TextInput,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useWalletStore} from '@store/walletStore';
import {walletApi} from '@services/api';
import {useNavigation, useRoute} from '@react-navigation/native';
import {usePaymentFlow} from '@services/stripe';
import type {CreditBatch} from '@appTypes/index';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {BravoFont} from '@/theme/bravo';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

// Obsidian / cobalt palette — imported "Bravo Credits" design family.
const T = {
  bg:        '#07090D',
  text:      '#F2F4F8',
  textDim:   'rgba(229,233,242,0.62)',
  textMute:  'rgba(180,188,204,0.45)',
  textFaint: 'rgba(180,188,204,0.28)',
  hair:      'rgba(255,255,255,0.06)',
  hair2:     'rgba(255,255,255,0.09)',
  accent:    '#5B8DEF',
  accentDeep:'#2F5BE0',
  accentSoft:'#7FA8FF',
  accentGlow:'rgba(91,141,239,0.35)',
  blue:      '#A9C5FF',
  signal:    '#4ADE80',
  gold:      '#E2C893',
  card:      'rgba(18,22,30,0.85)',
} as const;

function isExpiringSoon(expiresAt: string): boolean {
  const expiry = new Date(expiresAt).getTime();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return expiry - Date.now() < thirtyDays && expiry > Date.now();
}
function isExpired(expiresAt: string): boolean {
  return new Date(expiresAt).getTime() < Date.now();
}
function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).toUpperCase();
}
function earliestExpiry(batches: CreditBatch[]): string | null {
  const active = batches
    .filter(b => !isExpired(b.expires_at))
    .sort((a, b) => new Date(a.expires_at).getTime() - new Date(b.expires_at).getTime());
  return active.length > 0 ? active[0].expires_at : null;
}

// Why: 1 fiat unit = 1 BC (CREDITS_BC_AUDIT F-01/F-02) — the card is charged
// exactly `credits` in fiat and the server awards exactly `credits` BC, so
// the tile, the charge, and the ledger always agree. No bonus tiers: the
// server derives credits from the charged amount, never from the package.
const TOP_UP_PACKAGES = [
  {id:'p1', credits:500,   label:'Starter', best:false},
  {id:'p2', credits:1000,  label:'Value',   best:true},
  {id:'p3', credits:2500,  label:'Pro',     best:false},
  {id:'p4', credits:7500,  label:'Elite',   best:false},
];

const TABS = [
  {k: 'balance', label: 'Balance'},
  {k: 'topup',   label: 'Top Up'},
  {k: 'history', label: 'History'},
] as const;
type TabKey = (typeof TABS)[number]['k'];

function Spark({size = 20}: {size?: number}) {
  return <Icon name="star-four-points" size={size} color={T.gold} />;
}

// W4/B-685 — exported through withPaymentBoundary (bottom of file): the Stripe
// provider mounts with THIS screen, not at the App root. See PaymentBoundary.tsx.
function CreditsScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  // B-84 / KB-08 — Modal windows don't resize for the IME; re-center the
  // promo-code card in the space above the keyboard.
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<{goBack: () => void; navigate: (s: string, p?: unknown) => void}>();
  const route = useRoute();
  const {balance, creditBatches, transactions, isLoading, loadBalance, loadCreditBatches, loadTransactions} = useWalletStore();
  const {topUpAndCharge} = usePaymentFlow();
  const initialTab = (route.params as {tab?: TabKey} | undefined)?.tab ?? 'balance';
  const [activeTab, setActiveTab] = useState<TabKey>(initialTab);
  const [selectedPkg, setSelectedPkg] = useState('p2');
  const [purchasing, setPurchasing] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [promoCode, setPromoCode] = useState('');
  const [redeeming, setRedeeming] = useState(false);

  const applyPromo = async () => {
    const code = promoCode.trim();
    if (!code || redeeming) {return;}
    setRedeeming(true);
    try {
      const {data} = await walletApi.redeemPromo(code);
      setPromoOpen(false);
      setPromoCode('');
      await Promise.all([loadBalance(), loadCreditBatches(), loadTransactions()]);
      setActiveTab('balance');
      Alert.alert('Promo applied', `${data.credits_awarded.toLocaleString()} BC added to your balance.`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Invalid or expired code.';
      const friendly =
        msg.includes('already_redeemed') ? "You've already used this code." :
        msg.includes('code_expired') ? 'This code has expired.' :
        msg.includes('code_exhausted') ? 'This code has reached its limit.' :
        msg.includes('invalid_code') ? "That code isn't valid." : msg;
      Alert.alert('Could not apply code', friendly);
    } finally {
      setRedeeming(false);
    }
  };

  const handlePurchase = async () => {
    const pkg = TOP_UP_PACKAGES.find(p => p.id === selectedPkg);
    if (!pkg || purchasing) {return;}
    setPurchasing(true);
    // Re-arm the button the moment the topup attempt settles — not after the
    // post-success refresh — so a hung reload can't strand it.
    let charged = false;
    let awarded = pkg.credits;
    try {
      const r = await topUpAndCharge({amountFiat: pkg.credits, currency: 'aed'});
      charged = r.charged;
      awarded = r.result.credits_awarded || pkg.credits;
    } catch (e) {
      setPurchasing(false);
      Alert.alert('Top-up failed', e instanceof Error ? e.message : 'Please try again.');
      return;
    }
    setPurchasing(false);
    if (!charged) {return;}
    try {
      await Promise.all([loadBalance(), loadCreditBatches(), loadTransactions()]);
    } catch { /* refresh failed — the credit still landed */ }
    Alert.alert('Credits added', `${awarded.toLocaleString()} BC added to your balance.`);
    setActiveTab('balance');
  };

  useEffect(() => {
    void loadBalance();
    void loadCreditBatches();
    void loadTransactions();
  }, [loadBalance, loadCreditBatches, loadTransactions]);

  const totalCredits = balance?.bravo_credits ?? 0;
  const earliest = earliestExpiry(creditBatches);
  const soonExpiry = earliest ? isExpiringSoon(earliest) : false;
  const selectedCredits = TOP_UP_PACKAGES.find(p => p.id === selectedPkg)?.credits ?? 0;

  // Money IN vs money OUT: payouts are earnings (agents/orgs), not spend.
  const CREDIT_TYPES = ['topup', 'refund', 'payout'];
  const toppedUp = transactions.filter(tx => CREDIT_TYPES.includes(tx.type)).reduce((n, tx) => n + tx.amount, 0);
  const spent = transactions.filter(tx => !CREDIT_TYPES.includes(tx.type)).reduce((n, tx) => n + tx.amount, 0);

  if (isLoading && creditBatches.length === 0 && transactions.length === 0) {
    return (
      <View style={styles.loader}>
        <LoadingView label="Loading your credits…" />
      </View>
    );
  }

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={T.bg} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={22} color={T.text} />
        </TouchableOpacity>
        <View style={styles.headerTitle}>
          <Spark size={17} />
          <Text style={styles.headerTitleText}>Bravo Credits</Text>
        </View>
        <View style={{width: 36}} />
      </View>

      {/* Segmented tabs */}
      <View style={styles.seg}>
        {TABS.map(tb => {
          const on = activeTab === tb.k;
          return (
            <TouchableOpacity key={tb.k} style={[styles.segItem, on && styles.segItemOn]} onPress={() => setActiveTab(tb.k)} activeOpacity={0.8}>
              <Text style={[styles.segText, on && styles.segTextOn]}>{tb.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ── BALANCE ── */}
      {activeTab === 'balance' && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>
          <BalanceHero total={totalCredits} earliest={earliest} soon={soonExpiry} />
          <TouchableOpacity activeOpacity={0.85} onPress={() => setActiveTab('topup')}>
            <LinearGradient colors={['#6E9BF5', T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={styles.topUpShortcut}>
              <Icon name="plus-circle" size={18} color="#fff" />
              <Text style={styles.topUpShortcutText}>Top Up Credits</Text>
            </LinearGradient>
          </TouchableOpacity>

          <Text style={styles.sectionLabel}>CREDIT BATCHES</Text>
          {creditBatches.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No credit batches yet.</Text>
              <Text style={styles.emptySub}>Credits are earned from bookings and top-ups.</Text>
            </View>
          ) : (
            creditBatches.map(batch => {
              const expired = isExpired(batch.expires_at);
              const expiringSoon = !expired && isExpiringSoon(batch.expires_at);
              return (
                <View key={batch.id} style={[styles.batchCard, expired && {opacity: 0.5}, expiringSoon && {borderColor: 'rgba(245,181,68,0.4)'}]}>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={styles.batchLabel}>{batch.label}</Text>
                    <Text style={styles.batchSub}>
                      {batch.source === 'booking'
                        ? `Booking #${batch.booking_id?.slice(0, 8).toUpperCase() ?? '—'} · earned`
                        : 'Purchased · top-up'}
                    </Text>
                  </View>
                  <View style={{alignItems: 'flex-end'}}>
                    <Text style={styles.batchAmount}>{batch.source === 'topup' ? '' : '+'}{batch.amount.toLocaleString()} BC</Text>
                    <Text style={[styles.batchExpiry, expiringSoon && {color: '#F5B544'}, expired && {color: '#F5485A'}]}>
                      {expired ? 'EXPIRED' : `Exp ${formatDate(batch.expires_at)}`}
                    </Text>
                  </View>
                </View>
              );
            })
          )}
          <RefundNotice />
        </ScrollView>
      )}

      {/* ── TOP UP ── */}
      {activeTab === 'topup' && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 110}]}>
          <BalanceHero total={totalCredits} earliest={earliest} soon={soonExpiry} />

          <Text style={styles.sectionLabel}>SELECT TOP-UP AMOUNT</Text>
          <View style={{gap: 14}}>
            {TOP_UP_PACKAGES.map(pkg => {
              const on = selectedPkg === pkg.id;
              return (
                <TouchableOpacity key={pkg.id} activeOpacity={0.85} onPress={() => setSelectedPkg(pkg.id)}>
                  {pkg.best && (
                    <View style={styles.bestTag}>
                      <Text style={styles.bestTagText}>BEST VALUE</Text>
                    </View>
                  )}
                  <View style={[styles.optCard, on && styles.optCardOn]}>
                    <Spark size={22} />
                    <View style={{flex: 1, minWidth: 0}}>
                      <View style={{flexDirection: 'row', alignItems: 'baseline', gap: 6}}>
                        <Text style={styles.optBc}>{pkg.credits.toLocaleString()}</Text>
                        <Text style={styles.optBcUnit}>BC</Text>
                      </View>
                      <Text style={styles.optSub}>{pkg.label} · pay {pkg.credits.toLocaleString()} on card</Text>
                    </View>
                    <View style={[styles.radio, on && styles.radioOn]}>
                      {on && <Icon name="check" size={14} color="#fff" />}
                    </View>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>

          <Text style={[styles.sectionLabel, {marginTop: 22}]}>PAYMENT METHOD</Text>
          <TouchableOpacity style={styles.payCard} activeOpacity={0.8} onPress={() => navigation.navigate('PaymentMethods')}>
            <View style={styles.payIcon}>
              <Icon name="credit-card-outline" size={22} color={T.blue} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={styles.payTitle}>Card payment</Text>
              <Text style={styles.paySub}>Choose or save a card</Text>
            </View>
            <Icon name="chevron-right" size={18} color={T.textMute} />
          </TouchableOpacity>

          <TouchableOpacity style={styles.promoLink} onPress={() => setPromoOpen(true)} activeOpacity={0.7}>
            <Icon name="ticket-percent-outline" size={16} color={T.blue} />
            <Text style={styles.promoLinkText}>Have a promo code?</Text>
          </TouchableOpacity>

          <RefundNotice />
        </ScrollView>
      )}

      {/* ── HISTORY ── */}
      {activeTab === 'history' && (
        <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>
          <View style={styles.summaryRow}>
            <View style={[styles.summaryCard, {backgroundColor: 'rgba(74,222,128,0.06)', borderColor: 'rgba(74,222,128,0.22)'}]}>
              <Text style={[styles.summaryLabel, {color: 'rgba(74,222,128,0.8)'}]}>TOPPED UP</Text>
              <Text style={[styles.summaryValue, {color: T.signal}]}>+{toppedUp.toLocaleString()}</Text>
            </View>
            <View style={[styles.summaryCard, {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: T.hair2}]}>
              <Text style={styles.summaryLabel}>SPENT</Text>
              <Text style={[styles.summaryValue, {color: T.text}]}>−{spent.toLocaleString()}</Text>
            </View>
          </View>

          <Text style={styles.sectionLabel}>TRANSACTION HISTORY</Text>
          {transactions.length === 0 ? (
            <View style={styles.emptyCard}>
              <Text style={styles.emptyText}>No transactions yet.</Text>
              <Text style={styles.emptySub}>Top-ups, payments and refunds will appear here.</Text>
            </View>
          ) : (
            <View style={styles.txCard}>
              {transactions.map((tx, i) => {
                const credit = CREDIT_TYPES.includes(tx.type);
                return (
                  <View key={tx.id} style={[styles.txRow, i < transactions.length - 1 && styles.txRowBorder]}>
                    <View style={[styles.txIcon, {backgroundColor: credit ? 'rgba(74,222,128,0.1)' : 'rgba(91,141,239,0.1)', borderColor: credit ? 'rgba(74,222,128,0.3)' : 'rgba(91,141,239,0.26)'}]}>
                      <Icon name={credit ? 'arrow-down' : 'arrow-up'} size={18} color={credit ? T.signal : T.blue} />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={styles.txDesc} numberOfLines={1}>{tx.description || tx.type}</Text>
                      <Text style={styles.txMeta}>{formatDate(tx.created_at)} · {tx.type.toUpperCase()}</Text>
                    </View>
                    <Text style={[styles.txAmount, {color: credit ? T.signal : T.text}]}>
                      {credit ? '+' : '−'}{tx.amount.toLocaleString()} <Text style={styles.txAmountUnit}>{tx.currency}</Text>
                    </Text>
                  </View>
                );
              })}
            </View>
          )}
          <RefundNotice />
        </ScrollView>
      )}

      {/* Top Up sticky CTA */}
      {activeTab === 'topup' && (
        <View style={[styles.footer, {paddingBottom: bottomPad(14)}]}>
          <TouchableOpacity testID="purchase-btn" activeOpacity={0.9} disabled={purchasing} onPress={() => { void handlePurchase(); }}>
            <LinearGradient colors={['#6E9BF5', T.accent, T.accentDeep]} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={[styles.purchaseBtn, purchasing && {opacity: 0.8}]}>
              {purchasing ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Spark size={18} />
                  <Text style={styles.purchaseBtnText}>Top Up · {selectedCredits.toLocaleString()} BC</Text>
                </>
              )}
            </LinearGradient>
          </TouchableOpacity>
        </View>
      )}

      {/* Promo code popup */}
      <Modal visible={promoOpen} transparent animationType="fade" onRequestClose={() => setPromoOpen(false)}>
        <View style={[styles.modalOverlay, {paddingBottom: keyboardOverlap}]}>
          <View style={styles.modalCard}>
            <View style={styles.modalIcon}><Icon name="ticket-percent" size={22} color={T.blue} /></View>
            <Text style={styles.modalTitle}>Promo code</Text>
            <Text style={styles.modalSub}>Enter a code to add bonus credits to your wallet.</Text>
            <TextInput
              style={styles.modalInput}
              value={promoCode}
              onChangeText={t => setPromoCode(t.toUpperCase())}
              placeholder="e.g. BRAVO50"
              placeholderTextColor={T.textMute}
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              maxLength={40}
              returnKeyType="done"
              onSubmitEditing={() => { void applyPromo(); }}
            />
            <Text style={styles.modalNote}>Promotional credits are non-refundable under the Bravo Refund Policy.</Text>
            <View style={styles.modalRow}>
              <TouchableOpacity style={styles.modalCancel} onPress={() => setPromoOpen(false)} activeOpacity={0.8}>
                <Text style={styles.modalCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modalApply, (!promoCode.trim() || redeeming) && {opacity: 0.4}]}
                disabled={!promoCode.trim() || redeeming}
                onPress={() => { void applyPromo(); }}
                activeOpacity={0.85}>
                {redeeming ? <ActivityIndicator color="#fff" /> : <Text style={styles.modalApplyText}>Apply</Text>}
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

/** PDF-1 #8 — the refund/redemption disclaimer, shown on every tab (near Top Up / History). */
function RefundNotice() {
  return (
    <View style={styles.noteCard}>
      <Icon name="information-outline" size={15} color={T.blue} />
      <View style={{flex: 1, minWidth: 0}}>
        <Text style={styles.noteTitle}>Refund notice</Text>
        <Text style={styles.noteText}>
          Eligible credit refunds are returned to the original payment method within 7 working
          days after approval. Credits already used, expired, promotional, or otherwise
          non-refundable under the Bravo Refund Policy are excluded.
        </Text>
      </View>
    </View>
  );
}

function BalanceHero({total, earliest, soon}: {total: number; earliest: string | null; soon: boolean}) {
  return (
    <View style={styles.hero}>
      <ImageryBackdrop source={Imagery.creditsHero} variant="hero" radius={22} />
      <LinearGradient colors={['rgba(20,32,60,0.8)', 'rgba(12,17,27,0.7)']} start={{x: 0, y: 0}} end={{x: 1, y: 1}} style={StyleSheet.absoluteFill} />
      <View style={styles.heroGlow} pointerEvents="none" />
      <View style={styles.heroLabelRow}>
        <Spark size={16} />
        <Text style={styles.heroLabel}>CURRENT BALANCE</Text>
      </View>
      <Text style={styles.heroValue}>{total.toLocaleString()}</Text>
      <Text style={styles.heroUnit}>BRAVO CREDITS</Text>
      {earliest && (
        <View style={[styles.heroExpiry, soon && {backgroundColor: 'rgba(245,181,68,0.12)', borderColor: 'rgba(245,181,68,0.34)'}]}>
          <Text style={[styles.heroExpiryText, soon && {color: '#F5B544'}]}>
            {soon ? '⚠ ' : ''}EARLIEST EXPIRY · {formatDate(earliest)}
          </Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: T.bg},
  loader: {flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: T.bg},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8},
  back: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {flexDirection: 'row', alignItems: 'center', gap: 8},
  headerTitleText: {fontFamily: BravoFont.bold, fontSize: 17, letterSpacing: -0.3, color: T.text},

  seg: {flexDirection: 'row', gap: 4, padding: 4, marginHorizontal: 20, marginBottom: 6, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: T.hair, borderRadius: 14},
  segItem: {flex: 1, alignItems: 'center', paddingVertical: 11, borderRadius: 11, borderWidth: 1, borderColor: 'transparent'},
  segItemOn: {backgroundColor: 'rgba(91,141,239,0.2)', borderColor: 'rgba(91,141,239,0.32)'},
  segText: {fontFamily: BravoFont.semiBold, fontSize: 13, letterSpacing: 0.2, color: T.textMute},
  segTextOn: {fontFamily: BravoFont.bold, color: T.text},

  content: {paddingHorizontal: 20, paddingTop: 8, gap: 14},

  // hero
  hero: {position: 'relative', overflow: 'hidden', borderRadius: 22, padding: 22, borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  heroGlow: {position: 'absolute', top: -60, right: -40, width: 200, height: 200, borderRadius: 100, backgroundColor: 'rgba(212,179,122,0.1)'},
  heroLabelRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  heroLabel: {fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 2, color: T.textMute},
  heroValue: {fontFamily: BravoFont.extraBold, fontSize: 50, letterSpacing: -2, color: T.text, textAlign: 'center', marginTop: 14},
  heroUnit: {fontFamily: BravoFont.mono, fontSize: 11, letterSpacing: 3, color: T.textMute, textAlign: 'center', marginTop: 6},
  heroExpiry: {alignSelf: 'center', marginTop: 14, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(91,141,239,0.1)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)'},
  heroExpiryText: {fontFamily: BravoFont.mono, fontSize: 9.5, letterSpacing: 0.8, color: T.blue},

  topUpShortcut: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, height: 50, borderRadius: 15, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  topUpShortcutText: {fontFamily: BravoFont.bold, fontSize: 15, color: '#fff'},

  sectionLabel: {fontFamily: BravoFont.semiBold, fontSize: 10.5, letterSpacing: 2, color: T.textMute, textTransform: 'uppercase', marginLeft: 4, marginTop: 4},

  // batches
  batchCard: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 16, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2},
  batchLabel: {fontFamily: BravoFont.bold, fontSize: 14, color: T.text},
  batchSub: {fontFamily: BravoFont.regular, fontSize: 11, color: T.textMute, marginTop: 3},
  batchAmount: {fontFamily: BravoFont.extraBold, fontSize: 14, color: T.accentSoft},
  batchExpiry: {fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 0.5, color: T.textMute, marginTop: 4},

  // top-up option cards
  bestTag: {position: 'absolute', top: -10, right: 16, zIndex: 2, paddingHorizontal: 11, paddingVertical: 4, borderRadius: 999, backgroundColor: T.accent},
  bestTagText: {fontFamily: BravoFont.mono, fontSize: 9, fontWeight: '800', letterSpacing: 1, color: '#fff'},
  optCard: {flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair},
  optCardOn: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.5)'},
  optBc: {fontFamily: BravoFont.extraBold, fontSize: 21, letterSpacing: -0.5, color: T.text},
  optBcUnit: {fontFamily: BravoFont.mono, fontSize: 11, letterSpacing: 1, color: T.textDim},
  optSub: {fontFamily: BravoFont.regular, fontSize: 12.5, color: T.textDim, marginTop: 3},
  radio: {width: 26, height: 26, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1.6, borderColor: T.hair2},
  radioOn: {backgroundColor: T.accent, borderColor: T.accent},

  // payment method card
  payCard: {flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18, backgroundColor: 'rgba(91,141,239,0.06)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  payIcon: {width: 44, height: 44, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  payTitle: {fontFamily: BravoFont.bold, fontSize: 15, color: T.text},
  paySub: {fontFamily: BravoFont.regular, fontSize: 12, color: T.textDim, marginTop: 2},

  promoLink: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 12},
  promoLinkText: {fontFamily: BravoFont.bold, fontSize: 13, color: T.blue},

  // Refund/redemption disclaimer (obsidian info-card, matches ProDashboard noteCard).
  noteCard: {flexDirection: 'row', alignItems: 'flex-start', gap: 10, marginTop: 4, padding: 14, borderRadius: 14, backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)'},
  noteTitle: {fontFamily: BravoFont.bold, fontSize: 12, color: T.text, marginBottom: 3},
  noteText: {flex: 1, minWidth: 0, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 17, color: T.textDim},

  // history
  summaryRow: {flexDirection: 'row', gap: 12},
  summaryCard: {flex: 1, borderRadius: 16, padding: 14, borderWidth: 1},
  summaryLabel: {fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1, color: T.textMute, textTransform: 'uppercase'},
  summaryValue: {fontFamily: BravoFont.extraBold, fontSize: 19, letterSpacing: -0.4, marginTop: 4},
  txCard: {borderRadius: 20, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2, overflow: 'hidden'},
  txRow: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14},
  txRowBorder: {borderBottomWidth: 1, borderBottomColor: T.hair},
  txIcon: {width: 42, height: 42, borderRadius: 13, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  txDesc: {fontFamily: BravoFont.semiBold, fontSize: 14, letterSpacing: -0.2, color: T.text},
  txMeta: {fontFamily: BravoFont.mono, fontSize: 9.5, letterSpacing: 0.5, color: T.textMute, marginTop: 4},
  txAmount: {fontFamily: BravoFont.extraBold, fontSize: 15, letterSpacing: -0.3},
  txAmountUnit: {fontFamily: BravoFont.semiBold, fontSize: 11, color: T.textDim},

  // empty
  emptyCard: {alignItems: 'center', gap: 6, paddingVertical: 30, borderRadius: 18, backgroundColor: T.card, borderWidth: 1, borderColor: T.hair2},
  emptyText: {fontFamily: BravoFont.bold, fontSize: 15, color: T.text},
  emptySub: {fontFamily: BravoFont.regular, fontSize: 12.5, color: T.textMute, textAlign: 'center', paddingHorizontal: 24},

  // footer CTA
  footer: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12, backgroundColor: T.bg, borderTopWidth: 1, borderTopColor: T.hair},
  purchaseBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, height: 56, borderRadius: 17, borderWidth: 1, borderColor: 'rgba(255,255,255,0.22)'},
  purchaseBtnText: {fontFamily: BravoFont.extraBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},

  // promo modal
  modalOverlay: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28},
  modalCard: {width: '100%', backgroundColor: '#11151D', borderRadius: 22, borderWidth: 1, borderColor: T.hair2, padding: 22, alignItems: 'center'},
  modalIcon: {width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)', marginBottom: 12},
  modalTitle: {fontFamily: BravoFont.extraBold, fontSize: 18, letterSpacing: -0.3, color: T.text},
  modalSub: {fontFamily: BravoFont.regular, fontSize: 12.5, color: T.textMute, textAlign: 'center', marginTop: 6, lineHeight: 18},
  modalInput: {width: '100%', height: 52, borderRadius: 14, paddingHorizontal: 16, marginTop: 16, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: T.hair2, fontFamily: BravoFont.bold, fontSize: 16, letterSpacing: 1, color: T.text, textAlign: 'center'},
  modalNote: {fontFamily: BravoFont.regular, fontSize: 11, lineHeight: 16, color: T.textMute, textAlign: 'center', marginTop: 12, paddingHorizontal: 4},
  modalRow: {flexDirection: 'row', gap: 12, marginTop: 16, width: '100%'},
  modalCancel: {flex: 1, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: T.hair2},
  modalCancelText: {fontFamily: BravoFont.bold, fontSize: 14, color: T.textDim},
  modalApply: {flex: 1, height: 48, borderRadius: 13, alignItems: 'center', justifyContent: 'center', backgroundColor: T.accent},
  modalApplyText: {fontFamily: BravoFont.bold, fontSize: 14, color: '#fff'},
});

import {withPaymentBoundary} from '@components/PaymentBoundary';
export default withPaymentBoundary(CreditsScreen);
