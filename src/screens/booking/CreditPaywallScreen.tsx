import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  StatusBar,
  TextInput,
  ActivityIndicator,
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  type DimensionValue,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {UI} from '@components/ui/tokens';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';
import {useBookingStore} from '@store/bookingStore';
import {useWalletStore} from '@store/walletStore';
import {usePaymentFlow} from '@services/stripe';
import {bookingApi} from '@services/api';
import {
  buildPackages,
  recommendPackageKey,
  shortfallFor,
  afterBalanceFor,
} from './creditMath';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'CreditPaywall'>;
type Rt  = RouteProp<BookingStackParamList, 'CreditPaywall'>;

// W4/B-685 — exported through withPaymentBoundary (bottom of file): the Stripe
// provider mounts with THIS screen, not at the App root. See PaymentBoundary.tsx.
function CreditPaywallScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const insets = useSafeAreaInsets();
  const {safeBottom} = useKeyboardLayout();
  const {height: winH} = useWindowDimensions();

  const draftEstimate = useBookingStore(st => st.draft.estimated_price);
  const confirmBooking = useBookingStore(st => st.confirmBooking);
  const updateDraft    = useBookingStore(st => st.updateDraft);
  const loadActiveBooking = useBookingStore(st => st.loadActiveBooking);
  const {balance, loadBalance} = useWalletStore();
  const {topUpAndCharge} = usePaymentFlow();

  // Route-driven source so the success CTA does the right thing for the
  // entry point. Legacy callers without params fall back to the draft-
  // estimate heuristic to preserve the old behaviour.
  const routeParams = route.params ?? {};
  const opsroomBookingId = routeParams.source === 'opsroom' ? routeParams.bookingId : undefined;
  const fromBookingFlow = routeParams.source === 'booking-flow' || (!routeParams.source && (draftEstimate ?? 0) > 0);
  const fromOpsRoom = routeParams.source === 'opsroom' && !!opsroomBookingId;
  const fromWallet = routeParams.source === 'wallet';

  const currentBalance = balance?.bravo_credits ?? 0;
  const required = routeParams.amountDue ?? draftEstimate ?? 1880;
  const shortfall = shortfallFor(required, currentBalance);

  const PACKAGES = useMemo(() => buildPackages(required), [required]);
  const recommendedKey = useMemo(
    () => recommendPackageKey(PACKAGES, shortfall),
    [PACKAGES, shortfall],
  );

  const [selectedPkg, setSelectedPkg] = useState(recommendedKey);
  const [useNewCard, setUseNewCard] = useState(false);
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [cardName, setCardName] = useState('');
  const [saveCard, setSaveCard] = useState(false);
  const [success, setSuccess] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Double-tap guard for the success-screen CTA. Without this, a fast
  // second tap fires payWithCredits twice — the second call lands after
  // the booking is already CONFIRMED and 400s with a misleading "Charge
  // failed" Alert.
  const [activating, setActivating] = useState(false);
  // Cancellation flag for the settle-wait poll. Without it, navigation.replace
  // can fire after the screen has unmounted (e.g. user gestured back during
  // the 6s window) and silently no-op.
  const unmountedRef = useRef(false);
  useEffect(() => () => { unmountedRef.current = true; }, []);

  useEffect(() => { void loadBalance(); }, [loadBalance]);
  useEffect(() => { setSelectedPkg(recommendedKey); }, [recommendedKey]);

  // Custom amount — founder spec 2026-08-03: free-typed top-up next to the
  // fixed tiers (1:1 peg, same server path — credits derive from the charge).
  const [customText, setCustomText] = useState('');
  const customCredits = parseInt(customText, 10);
  const customValid = Number.isFinite(customCredits) && customCredits >= 50 && customCredits <= 1_000_000;
  const pkg = selectedPkg === 'custom'
    ? {
        key: 'custom',
        credits: customValid ? customCredits : 0,
        priceUsd: customValid ? customCredits : 0,
        label: customValid ? customCredits.toLocaleString() : '—',
        sub: 'Custom amount',
        recommended: false,
        badge: null,
      }
    : (PACKAGES.find(p => p.key === selectedPkg) ?? PACKAGES[0]);
  const afterBalance = afterBalanceFor(currentBalance, pkg.credits);
  const balanceProgress = required > 0 ? Math.min((currentBalance / required) * 100, 100) : 0;

  // Tapping "Top Up" opens the themed payment-confirmation sheet. The
  // actual charge happens from that sheet's Pay button so the client can
  // review the card + total before we hit Stripe.
  const handleTopUp = () => {
    if (selectedPkg === 'custom' && !customValid) {
      Alert.alert('Enter a custom amount', 'Between 50 and 1,000,000 BC.');
      return;
    }
    setConfirmOpen(true);
  };

  // NAV-12 (2026-08-26 rapid-use audit) — a REF, not the `processing` state:
  // the disabled prop below needs a committed re-render, which lands late
  // exactly when the JS thread is backed up (the founder's ×20-tap repro),
  // and every queued repeat here is a Stripe PaymentIntent. Same idiom as the
  // chat composer's textRef double-send guard and CreditsScreen's purchasing
  // check.
  const processingRef = useRef(false);
  const runPayment = async () => {
    if (processingRef.current) {return;}
    processingRef.current = true;
    setConfirmOpen(false);
    setProcessing(true);
    try {
      // Mint a PaymentIntent server-side + charge via PaymentSheet. When
      // auth-service is in fallback mode (no STRIPE_SECRET_KEY), the
      // server credits locally and `charged` is still true.
      const {charged, result} = await topUpAndCharge({
        amountFiat: pkg.priceUsd,
        currency: 'usd',
      });
      if (!charged) {
        // User cancelled PaymentSheet — leave the pending ledger row
        // on the server (it'll never settle) and bail out cleanly.
        return;
      }
      // Reflect the server's awarded credits locally so the success
      // screen renders the right balance even before the webhook lands.
      useWalletStore.setState(st => ({
        ...st,
        balance: {
          bravo_credits: (st.balance?.bravo_credits ?? 0) + (result.credits_awarded || pkg.credits),
          currency: st.balance?.currency ?? 'AED',
        },
      }));
      await loadBalance().catch(() => undefined);
      setSuccess(true);
    } catch (e) {
      Alert.alert('Top-up failed', e instanceof Error ? e.message : 'Please try again.');
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };

  if (success) {
    return (
      <View style={[styles.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={UI.bg} />
        <View style={styles.successOverlay}>
          <View style={styles.successIconWrap}>
            <View style={styles.pulseBig} />
            <View style={styles.pulseMid} />
            <View style={styles.successIcon}>
              <Icon name="check-circle" size={42} color="#34d399" />
            </View>
          </View>
          <Text style={styles.successTitle}>Credits Added!</Text>
          <Text style={styles.successSub}>Your Bravo Credits balance has been updated</Text>
          <View style={styles.successBalance}>
            <Icon name="star-four-points" size={16} color="#FBBF24" />
            {/* Server-refreshed balance when available; client estimate as fallback. */}
            <Text style={styles.successBalanceText}>{(balance?.bravo_credits ?? afterBalance).toLocaleString()} BC</Text>
          </View>
          <TouchableOpacity
            style={[styles.continueBtn, activating && {opacity: 0.7}]}
            disabled={activating}
            onPress={() => {
              if (activating) {return;}
              // OpsRoom flow — the booking already exists. Retry the
              // pay-with-credits debit against THIS booking, briefly poll
              // for the status flip (PAYMENT_PENDING/OPS_APPROVED →
              // CONFIRMED), then route to BookingConfirmation.
              if (fromOpsRoom && opsroomBookingId) {
                setActivating(true);
                void (async () => {
                  try {
                    // Stable per-booking idempotency key — server-side
                    // interceptor (when enabled) collapses retries onto
                    // the same charge so a network blip + auto-retry
                    // can't double-debit the wallet.
                    await bookingApi.payWithCredits(opsroomBookingId);
                    if (unmountedRef.current) {return;}
                    await loadBalance().catch(() => undefined);
                    // Settle-wait: poll for status to advance past
                    // OPS_APPROVED so BookingConfirmation doesn't flash
                    // "Awaiting Dispatch" before the server has actually
                    // recorded the payment. ~6s cap is plenty for the
                    // auth-service round-trip.
                    for (let i = 0; i < 20; i++) {
                      if (unmountedRef.current) {return;}
                      await loadActiveBooking(opsroomBookingId).catch(() => undefined);
                      const status = (useBookingStore.getState().activeBooking?.status ?? '').toUpperCase();
                      if (status === 'CONFIRMED' || status === 'LIVE') {break;}
                      await new Promise(r => setTimeout(r, 300));
                    }
                    if (unmountedRef.current) {return;}
                    navigation.replace('BookingConfirmation', {
                      bookingId: opsroomBookingId,
                      amountPaid: routeParams.amountDue ?? draftEstimate ?? 0,
                      currency: 'BC',
                      paymentMethod: 'bravo_credits',
                      creditsAwarded: 0,
                    });
                  } catch (e) {
                    if (unmountedRef.current) {return;}
                    Alert.alert(
                      'Charge failed',
                      e instanceof Error ? e.message : 'Top-up succeeded but we couldn’t charge your booking. Returning to ops review.',
                    );
                    setActivating(false);
                    navigation.goBack();
                  }
                })();
                return;
              }
              // Wallet flow — no booking is involved. Pop back to the
              // ProfileTab where the user opened the top-up from.
              if (fromWallet) {
                const parent = navigation.getParent?.();
                if (parent) {
                  parent.navigate('ProfileTab' as never);
                } else {
                  navigation.goBack();
                }
                return;
              }
              // Booking-flow — no booking row exists yet, create one.
              if (fromBookingFlow) {
                setActivating(true);
                void (async () => {
                  try {
                    updateDraft({payment_method: 'bravo_credits'});
                    const booking = await confirmBooking();
                    if (unmountedRef.current) {return;}
                    navigation.replace('BookingConfirmation', {
                      bookingId: booking.id,
                      amountPaid: draftEstimate ?? 0,
                      currency: 'BC',
                      paymentMethod: 'bravo_credits',
                      creditsAwarded: 0,
                    });
                  } catch (e) {
                    if (unmountedRef.current) {return;}
                    Alert.alert(
                      'Booking failed',
                      e instanceof Error ? e.message : 'We took the top-up but couldn’t finalise the booking. Contact ops.',
                    );
                    setActivating(false);
                  }
                })();
                return;
              }
              navigation.goBack();
            }}
            activeOpacity={0.85}>
            {activating ? (
              <ActivityIndicator color="#FFF" />
            ) : (
              <Text style={styles.continueBtnText}>
                {fromOpsRoom ? 'Activate Mission →' : fromBookingFlow ? 'Confirm Booking →' : fromWallet ? 'Back to Profile' : 'Done'}
              </Text>
            )}
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backBtn}
          onPress={() => goBackOnce(navigation)}
          activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
          accessibilityRole="button"
          accessibilityLabel="Go back">
          <Icon name="arrow-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <View style={styles.headerMeta}>
          <Text style={styles.headerTitle} numberOfLines={1}>Top Up Bravo Credits</Text>
          <Text style={styles.headerSub} numberOfLines={2}>
            {fromWallet ? 'Add credits to your wallet' : 'Booking paused · insufficient balance'}
          </Text>
        </View>
        {!fromWallet && (
          <View style={styles.blockedBadge}>
            <View style={styles.blockedDot} />
            <Text style={styles.blockedText}>Blocked</Text>
          </View>
        )}
      </View>

      <KeyboardAvoidingScreen
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 100}]}
        // B-184 — the CTA rides INSIDE the keyboard-avoiding box so it stays
        // reachable while a field is focused; its safe-area pad collapses there.
        footer={
          <View style={[styles.footer, {paddingBottom: safeBottom + 12}]}>
            <TouchableOpacity
              style={[styles.topUpBtn, processing && {opacity: 0.7}]}
              onPress={handleTopUp}
              disabled={processing}
              activeOpacity={0.85}>
              {processing ? (
                <ActivityIndicator color="#FFF" />
              ) : (
                <>
                  <Icon name="star-four-points" size={18} color="#FFF" />
                  <Text style={styles.topUpBtnText}>TOP UP {pkg.label} BC</Text>
                </>
              )}
            </TouchableOpacity>
            <Text style={styles.footerHint}>
              {fromWallet
                ? 'Credits are added to your wallet immediately after payment'
                : "You'll return to your booking immediately after top-up"}
            </Text>
          </View>
        }>

        {/* Balance / shortfall card */}
        {fromWallet ? (
          <View style={styles.shortfallCard}>
            <View style={[styles.shortfallBar, {backgroundColor: UI.accent}]} />
            <View style={styles.shortfallContent}>
              <View style={styles.shortfallTitleRow}>
                <Icon name="star-four-points" size={16} color="#FBBF24" />
                <Text style={[styles.shortfallTitle, {color: UI.textDim}]}>Current Balance</Text>
              </View>
              <View style={styles.shortfallGrid}>
                <View style={[styles.shortfallCell, {flex: 1}]}>
                  <Text style={styles.shortfallCellLabel}>You Have</Text>
                  <Text style={styles.shortfallCellVal}>{currentBalance.toLocaleString()}</Text>
                  <Text style={styles.shortfallCellUnit}>BC</Text>
                </View>
              </View>
            </View>
          </View>
        ) : (
          <View style={styles.shortfallCard}>
            <View style={styles.shortfallBar} />
            <View style={styles.shortfallContent}>
              <View style={styles.shortfallTitleRow}>
                <Icon name="alert" size={16} color="#f87171" />
                <Text style={styles.shortfallTitle}>Insufficient Bravo Credits</Text>
              </View>
              <View style={styles.shortfallGrid}>
                <View style={styles.shortfallCell}>
                  <Text style={styles.shortfallCellLabel}>Required</Text>
                  <Text style={styles.shortfallCellVal}>{required.toLocaleString()}</Text>
                  <Text style={styles.shortfallCellUnit}>BC</Text>
                </View>
                <View style={[styles.shortfallCell, {borderColor: 'rgba(239,68,68,0.2)'}]}>
                  <Text style={styles.shortfallCellLabel}>You Have</Text>
                  <Text style={[styles.shortfallCellVal, {color: '#f87171'}]}>{currentBalance.toLocaleString()}</Text>
                  <Text style={styles.shortfallCellUnit}>BC</Text>
                </View>
                <View style={[styles.shortfallCell, {borderColor: 'rgba(245,158,11,0.25)'}]}>
                  <Text style={styles.shortfallCellLabel}>You Need</Text>
                  <Text style={[styles.shortfallCellVal, {color: '#F59E0B'}]}>{shortfall.toLocaleString()}</Text>
                  <Text style={styles.shortfallCellUnit}>More BC</Text>
                </View>
              </View>
            </View>
            <View style={styles.progressSection}>
              <View style={styles.progressLabelRow}>
                <Text style={styles.progressLabel}>Balance progress</Text>
                {/* LM-U5 — was a hardcoded "40%" that disagreed with the bar. */}
                <Text style={styles.progressPct}>{Math.round(balanceProgress)}% of required</Text>
              </View>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, {width: `${balanceProgress}%` as DimensionValue}]} />
              </View>
            </View>
          </View>
        )}

        {/* Select amount */}
        <Text style={styles.sectionLabel}>Select Top-Up Amount</Text>

        {PACKAGES.map(p => {
          const isSelected = selectedPkg === p.key;
          return (
            <TouchableOpacity
              key={p.key}
              style={[
                styles.pkgCard,
                isSelected && styles.pkgCardSelected,
                p.recommended && styles.pkgCardRecommended,
                isSelected && p.recommended && styles.pkgCardSelected,
              ]}
              onPress={() => setSelectedPkg(p.key)}
              activeOpacity={0.85}>
              {p.badge && (
                <View style={[styles.pkgBadge, {backgroundColor: p.badge.color}]}>
                  <Text style={styles.pkgBadgeText}>{p.badge.label}</Text>
                </View>
              )}
              <View style={styles.pkgRow}>
                <View>
                  <View style={styles.pkgTitleRow}>
                    <Icon name="star-four-points" size={16} color="#FBBF24" />
                    <Text style={styles.pkgCredits}>{p.label} <Text style={styles.pkgCreditsUnit}>BC</Text></Text>
                  </View>
                  <View style={styles.pkgSubRow}>
                    <Text style={styles.pkgSub}>{p.sub}</Text>
                  </View>
                </View>
                <View style={[styles.checkCircle, isSelected && styles.checkCircleSelected]}>
                  {isSelected && <Icon name="check" size={13} color="#FFF" />}
                </View>
              </View>
            </TouchableOpacity>
          );
        })}

        {/* Custom amount tile */}
        <TouchableOpacity
          style={[styles.pkgCard, selectedPkg === 'custom' && styles.pkgCardSelected]}
          onPress={() => setSelectedPkg('custom')}
          activeOpacity={0.85}>
          <View style={styles.pkgRow}>
            <View style={{flex: 1, minWidth: 0}}>
              <View style={styles.pkgTitleRow}>
                <Icon name="pencil-outline" size={16} color="#FBBF24" />
                <Text style={styles.pkgCredits}>Custom <Text style={styles.pkgCreditsUnit}>BC</Text></Text>
              </View>
              <TextInput
                style={styles.customInput}
                value={customText}
                onChangeText={t => {
                  setCustomText(t.replace(/[^\d]/g, ''));
                  setSelectedPkg('custom');
                }}
                onFocus={() => setSelectedPkg('custom')}
                placeholder="Type any amount — e.g. 4500"
                placeholderTextColor={UI.textMute}
                selectionColor={UI.accent}
                keyboardType="number-pad"
                maxLength={7}
              />
            </View>
            <View style={[styles.checkCircle, selectedPkg === 'custom' && styles.checkCircleSelected]}>
              {selectedPkg === 'custom' && <Icon name="check" size={13} color="#FFF" />}
            </View>
          </View>
        </TouchableOpacity>

        {/* Payment method */}
        <Text style={[styles.sectionLabel, {marginTop: 12}]}>Payment Method</Text>

        {/* Payment method placeholder — the actual card selection happens
            inside Stripe PaymentSheet at charge time, so we can't show a
            real saved-card label here without a /wallet/cards endpoint
            (none exists). The previous hardcoded "Visa ••••4242" was
            misleading; replaced with a generic "managed by Stripe" row. */}
        <View style={[styles.paymentRow, styles.paymentRowActive]}>
          <View style={styles.paymentIcon}>
            <Icon name="credit-card" size={18} color={UI.accent} />
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.paymentTitle}>Card payment</Text>
            <Text style={styles.paymentSub}>Choose or save a card on the next screen</Text>
          </View>
          <Icon name="chevron-right" size={16} color={UI.textMute} />
        </View>

        {/* Add new card */}
        <TouchableOpacity
          style={styles.addCardRow}
          onPress={() => setUseNewCard(v => !v)}
          activeOpacity={0.8}>
          <View style={styles.addCardIcon}>
            <Icon name="credit-card-plus-outline" size={18} color={UI.textDim} />
          </View>
          <Text style={styles.addCardText}>Use a different card</Text>
          <Icon name={useNewCard ? 'chevron-up' : 'chevron-down'} size={18} color={UI.textMute} style={{marginLeft: 'auto'}} />
        </TouchableOpacity>

        {useNewCard && (
          <View style={styles.cardForm}>
            <TextInput style={styles.cardInput} placeholder="Card number" placeholderTextColor={UI.textMute} value={cardNumber} onChangeText={setCardNumber} keyboardType="number-pad" maxLength={19} />
            <View style={styles.cardRow2}>
              <TextInput style={[styles.cardInput, {flex: 1}]} placeholder="MM / YY" placeholderTextColor={UI.textMute} value={expiry} onChangeText={setExpiry} maxLength={7} />
              <TextInput style={[styles.cardInput, {flex: 1}]} placeholder="CVV" placeholderTextColor={UI.textMute} value={cvv} onChangeText={setCvv} keyboardType="number-pad" maxLength={4} />
            </View>
            <TextInput style={styles.cardInput} placeholder="Cardholder name" placeholderTextColor={UI.textMute} value={cardName} onChangeText={setCardName} />
            <TouchableOpacity style={styles.saveCardRow} onPress={() => setSaveCard(v => !v)} activeOpacity={0.8}>
              <View style={[styles.toggle, saveCard && styles.toggleOn]}>
                <View style={[styles.toggleThumb, saveCard && styles.toggleThumbOn]} />
              </View>
              <Text style={styles.saveCardText}>Save card for future bookings</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Security note */}
        <View style={styles.securityNote}>
          <Icon name="lock" size={13} color={UI.textMute} />
          <Text style={styles.securityText}>Secured by Stripe · 3D Secure · PCI DSS compliant</Text>
        </View>

        {/* Balance preview */}
        <View style={styles.balancePreview}>
          <View>
            <Text style={styles.balancePreviewLabel}>Balance after top-up</Text>
            <Text style={styles.balancePreviewVal}>{afterBalance.toLocaleString()} BC</Text>
          </View>
          {!fromWallet && (
            <View style={{alignItems: 'flex-end'}}>
              <Text style={styles.balanceCheck}>
                {afterBalance >= required ? '✓ Booking can proceed' : '⚠ Still short'}
              </Text>
              <Text style={styles.balanceBuffer}>
                {afterBalance >= required
                  ? `+${(afterBalance - required).toLocaleString()} BC buffer`
                  : `${(required - afterBalance).toLocaleString()} BC still needed`}
              </Text>
            </View>
          )}
        </View>

      </KeyboardAvoidingScreen>

      {/* Payment confirmation bottom sheet */}
      <Modal
        visible={confirmOpen}
        transparent
        statusBarTranslucent
        animationType="slide"
        onRequestClose={() => setConfirmOpen(false)}>
        <Pressable style={paySheet.backdrop} onPress={() => setConfirmOpen(false)}>
          {/* Issue 26 — the sheet was `rgba(255,255,255,0.045)`: 4.5% white over
              the backdrop, i.e. effectively transparent, so the screen behind it
              showed THROUGH every label and read as overlapping text. It is
              opaque now, height-capped with an internal scroll, and its action
              row is a fixed footer padded past the Android nav bar. */}
          <Pressable
            style={[paySheet.sheet, {maxHeight: winH * 0.85}]}
            onPress={() => {}}>
            <View style={paySheet.handle} />

            <ScrollView
              style={{flexShrink: 1}}
              contentContainerStyle={paySheet.scrollBody}
              showsVerticalScrollIndicator={false}
              bounces={false}>
            <Text style={paySheet.title}>Confirm payment</Text>
            <Text style={paySheet.sub}>Review your top-up before charging the card</Text>

            {/* Receipt rows */}
            <View style={paySheet.row}>
              <Text style={paySheet.k}>Top-up</Text>
              <Text style={paySheet.v}>{pkg.credits.toLocaleString()} BC</Text>
            </View>
            <View style={paySheet.row}>
              <Text style={paySheet.k}>New balance</Text>
              <Text style={paySheet.v}>{afterBalance.toLocaleString()} BC</Text>
            </View>
            <View style={paySheet.totalRow}>
              <Text style={paySheet.totalK}>Charge</Text>
              <Text style={paySheet.totalV}>{pkg.credits.toLocaleString()} BC</Text>
            </View>

            <View style={paySheet.card}>
              <View style={paySheet.cardIc}>
                <Icon name="credit-card" size={18} color={UI.accent} />
              </View>
              <View style={{flex: 1}}>
                <Text style={paySheet.cardT}>Card payment</Text>
                <Text style={paySheet.cardS}>Choose or save a card via Stripe</Text>
              </View>
              <Icon name="chevron-right" size={16} color={UI.textMute} />
            </View>

            <View style={paySheet.secureRow}>
              <Icon name="lock" size={12} color={UI.textMute} />
              <Text style={paySheet.secureText}>Secured by Stripe · 3D Secure</Text>
            </View>

            </ScrollView>

            {/* Fixed action footer — never scrolls away, never sits under the
                system navigation bar. */}
            <View style={[paySheet.actions, {paddingBottom: Math.max(insets.bottom, 12)}]}>
              <TouchableOpacity
                style={paySheet.cancelBtn}
                onPress={() => setConfirmOpen(false)}
                activeOpacity={0.85}>
                <Text style={paySheet.cancelText}>CANCEL</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={paySheet.payBtn}
                onPress={() => { void runPayment(); }}
                disabled={processing}
                activeOpacity={0.85}>
                <Text style={paySheet.payText}>PAY {pkg.credits.toLocaleString()} BC</Text>
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

const paySheet = StyleSheet.create(scaleTextStyles({
  backdrop: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(2, 6, 15, 0.72)',
  },
  sheet: {
    paddingTop: 12,
    // Issue 26 — OPAQUE. A translucent sheet let the screen behind bleed into
    // the receipt rows, which is what read as "severe text overlap".
    backgroundColor: UI.bg,
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderTopWidth: 1, borderColor: UI.hair,
  },
  scrollBody: {paddingHorizontal: 20, paddingBottom: 4},
  handle: {
    width: 42, height: 4, borderRadius: 2,
    backgroundColor: UI.hair, alignSelf: 'center',
    marginBottom: 14,
  },
  title: {
    fontSize: 17, fontWeight: '800', color: UI.text,
    letterSpacing: -0.2,
  },
  sub: {
    fontSize: 12, color: UI.textMute, marginTop: 2, marginBottom: 14,
  },
  row: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingVertical: 8,
    borderTopWidth: 1, borderTopColor: UI.hair,
  },
  k: {fontSize: 13, color: UI.textDim},
  v: {fontSize: 13, color: UI.text, fontWeight: '600'},
  totalRow: {
    flexDirection: 'row', justifyContent: 'space-between',
    paddingTop: 12, paddingBottom: 4,
    borderTopWidth: 1, borderTopColor: UI.hair, marginTop: 2,
  },
  totalK: {
    fontSize: 11, fontWeight: '800', letterSpacing: 1.2,
    color: UI.textMute, textTransform: 'uppercase',
  },
  totalV: {
    fontSize: 18, fontWeight: '800', color: UI.text,
    letterSpacing: -0.3,
  },
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: UI.surface, borderRadius: 12,
    padding: 12, marginTop: 14,
    borderWidth: 1, borderColor: UI.accent,
  },
  cardIc: {
    width: 36, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(91,141,239,0.12)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
    alignItems: 'center', justifyContent: 'center',
  },
  cardT: {fontSize: 13, fontWeight: '700', color: UI.text},
  cardS: {fontSize: 10.5, color: UI.textMute, marginTop: 2},
  secureRow: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    marginTop: 10, marginBottom: 16, paddingHorizontal: 4,
  },
  secureText: {fontSize: 10.5, color: UI.textMute},
  actions: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 20, paddingTop: 14,
    borderTopWidth: 1, borderTopColor: UI.hair,
  },
  cancelBtn: {
    flex: 1, height: 48, borderRadius: 12,
    borderWidth: 1, borderColor: UI.hair, backgroundColor: 'transparent',
    alignItems: 'center', justifyContent: 'center',
  },
  cancelText: {
    fontSize: 12, fontWeight: '800', letterSpacing: 1.4,
    color: UI.textDim,
  },
  payBtn: {
    flex: 2, height: 48, borderRadius: 12,
    backgroundColor: UI.accent,
    alignItems: 'center', justifyContent: 'center',
    shadowColor: UI.accent, shadowOpacity: 0.4, shadowRadius: 12,
    shadowOffset: {width: 0, height: 4}, elevation: 6,
  },
  payText: {
    fontSize: 13, fontWeight: '800', color: '#FFF',
    letterSpacing: 1.2,
  },
}));

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: UI.bg},

  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: UI.hair},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  headerMeta: {flex: 1, minWidth: 0},
  headerTitle: {fontSize: 13, fontWeight: '800', color: UI.text},
  headerSub: {fontSize: 10, color: UI.textMute, fontWeight: '500', marginTop: 1},
  blockedBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(239,68,68,0.1)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)', paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99},
  blockedDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#ef4444'},
  blockedText: {fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#f87171'},

  scroll: {padding: 16, gap: 8},

  shortfallCard: {backgroundColor: UI.surface, borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', borderRadius: 16, overflow: 'hidden'},
  shortfallBar: {height: 4, backgroundColor: '#ef4444'},
  shortfallContent: {padding: 16},
  shortfallTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12},
  shortfallTitle: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: '#f87171'},
  shortfallGrid: {flexDirection: 'row', gap: 8},
  shortfallCell: {flex: 1, backgroundColor: UI.bg, borderWidth: 1, borderColor: UI.hair, borderRadius: 12, padding: 12, alignItems: 'center'},
  shortfallCellLabel: {fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: UI.textMute, marginBottom: 4},
  shortfallCellVal: {fontSize: 15, fontWeight: '800', color: UI.text},
  shortfallCellUnit: {fontSize: 9, color: UI.textMute, marginTop: 2},
  progressSection: {paddingHorizontal: 16, paddingBottom: 16},
  progressLabelRow: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6},
  progressLabel: {fontSize: 9, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: UI.textMute},
  progressPct: {fontSize: 9, fontWeight: '700', color: '#f87171'},
  progressTrack: {height: 8, backgroundColor: UI.hair, borderRadius: 99, overflow: 'hidden'},
  progressFill: {height: '100%', borderRadius: 99, backgroundColor: '#ef4444'},

  sectionLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: UI.textMute},

  pkgCard: {backgroundColor: UI.surface, borderWidth: 1.5, borderColor: UI.hair, borderRadius: 16, padding: 14},
  pkgCardSelected: {borderColor: UI.accent, backgroundColor: 'rgba(91,141,239,0.08)'},
  pkgCardRecommended: {borderColor: 'rgba(34,197,94,0.5)', backgroundColor: 'rgba(34,197,94,0.05)'},
  pkgBadge: {position: 'absolute', top: -9, right: 14, paddingHorizontal: 10, paddingVertical: 2, borderRadius: 20},
  pkgBadgeText: {fontSize: 8, fontWeight: '800', letterSpacing: 1.5, textTransform: 'uppercase', color: '#FFF'},
  pkgRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  pkgTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  pkgCredits: {fontSize: 15, fontWeight: '800', color: UI.text},
  pkgCreditsUnit: {fontSize: 13, fontWeight: '600', color: UI.textDim},
  customInput: {
    marginTop: 8, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair,
    color: UI.text, fontSize: 14,
  },
  pkgSubRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4},
  pkgSub: {fontSize: 11, color: UI.textMute},
  discountBadge: {backgroundColor: 'rgba(91,141,239,0.12)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4},
  discountText: {fontSize: 9, fontWeight: '700', color: UI.accentSoft},
  checkCircle: {width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: UI.hair, alignItems: 'center', justifyContent: 'center'},
  checkCircleSelected: {backgroundColor: UI.accent, borderColor: UI.accent},

  paymentRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: UI.surface, borderWidth: 1, borderColor: UI.hair, borderRadius: 16, padding: 14},
  paymentRowActive: {borderColor: UI.accent},
  paymentIcon: {width: 36, height: 36, borderRadius: 12, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)', alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  paymentTitle: {fontSize: 13, fontWeight: '700', color: UI.text},
  paymentSub: {fontSize: 10, color: UI.textMute, marginTop: 2},

  addCardRow: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: UI.surface, borderWidth: 1, borderColor: UI.hair, borderRadius: 16, padding: 14},
  addCardIcon: {width: 36, height: 36, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: UI.hair, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  addCardText: {fontSize: 13, fontWeight: '600', color: UI.textDim},

  cardForm: {gap: 8, marginTop: -4},
  cardInput: {backgroundColor: UI.bg, borderWidth: 1, borderColor: UI.hair, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, fontSize: 13, fontWeight: '600', color: UI.text},
  cardRow2: {flexDirection: 'row', gap: 8},
  saveCardRow: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4},
  toggle: {width: 36, height: 20, borderRadius: 10, backgroundColor: UI.hair, justifyContent: 'center', paddingHorizontal: 2},
  toggleOn: {backgroundColor: UI.accent},
  toggleThumb: {width: 16, height: 16, borderRadius: 8, backgroundColor: UI.textMute},
  toggleThumbOn: {backgroundColor: '#FFF', marginLeft: 16},
  saveCardText: {fontSize: 11, color: UI.textDim},

  securityNote: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4},
  securityText: {fontSize: 10, color: UI.textMute},

  balancePreview: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', backgroundColor: 'rgba(34,197,94,0.05)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.2)', borderRadius: 12, padding: 14},
  balancePreviewLabel: {fontSize: 10, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 2, color: UI.textMute},
  balancePreviewVal: {fontSize: 15, fontWeight: '800', color: '#34d399', marginTop: 2},
  balanceCheck: {fontSize: 10, fontWeight: '700', color: '#34d399'},
  balanceBuffer: {fontSize: 10, color: UI.textMute, marginTop: 2},

  footer: {paddingHorizontal: 16, paddingTop: 12, borderTopWidth: 1, borderTopColor: UI.hair, backgroundColor: UI.bg},
  topUpBtn: {backgroundColor: UI.accent, borderRadius: 16, paddingVertical: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  topUpBtnText: {fontSize: 14, fontWeight: '800', color: '#FFF', letterSpacing: 1.5},
  footerHint: {textAlign: 'center', fontSize: 10, color: UI.textMute, marginTop: 8},

  successOverlay: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  successIconWrap: {position: 'relative', width: 160, height: 160, alignItems: 'center', justifyContent: 'center', marginBottom: 24},
  pulseBig: {position: 'absolute', width: 128, height: 128, borderRadius: 64, backgroundColor: 'rgba(34,197,94,0.15)'},
  pulseMid: {position: 'absolute', width: 96, height: 96, borderRadius: 48, backgroundColor: 'rgba(34,197,94,0.1)'},
  successIcon: {width: 80, height: 80, borderRadius: 40, backgroundColor: 'rgba(34,197,94,0.15)', borderWidth: 2, borderColor: 'rgba(34,197,94,0.35)', alignItems: 'center', justifyContent: 'center', zIndex: 1},
  successTitle: {fontSize: 22, fontWeight: '800', color: UI.text, marginBottom: 4},
  successSub: {fontSize: 13, color: UI.textDim, marginBottom: 16},
  successBalance: {flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.2)', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 99, marginBottom: 32},
  successBalanceText: {fontSize: 14, fontWeight: '800', color: '#34d399'},
  continueBtn: {paddingHorizontal: 32, paddingVertical: 14, borderRadius: 12, backgroundColor: UI.accent},
  continueBtnText: {fontSize: 14, fontWeight: '800', color: '#FFF'},
}));

import {withPaymentBoundary} from '@components/PaymentBoundary';
export default withPaymentBoundary(CreditPaywallScreen);
