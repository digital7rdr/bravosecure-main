import React, {useEffect, useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Palette} from '@theme/index';
import {UI} from '@components/ui/tokens';
import LoadingView from '@components/LoadingView';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {isInsufficientCreditsError, creditShortfallFrom} from './creditErrors';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

// Per-add-on presentation, keyed by the backend add-on id
// (lite_booking_add_ons: female_cpo, recon, medical, comms, …). The catalog
// itself — labels, descriptions, prices, ops-approval flags — comes from the
// backend via `/bookings/add-ons`; this map is only icon/colour styling and
// falls back to a neutral default for any id we don't have art for.
type IconName = React.ComponentProps<typeof Icon>['name'];
const ADDON_STYLE: Record<string, {icon: IconName; iconColor: string; iconBg: string}> = {
  female_cpo: {icon: 'account-tie', iconColor: UI.accent, iconBg: 'rgba(37,99,235,0.12)'},
  recon: {icon: 'eye', iconColor: Palette.agentPurple, iconBg: 'rgba(124,58,237,0.12)'},
  medical: {icon: 'medical-bag', iconColor: Palette.redText, iconBg: 'rgba(239,68,68,0.1)'},
  comms: {icon: 'radio-tower', iconColor: UI.signal, iconBg: 'rgba(34,197,94,0.1)'},
};
const DEFAULT_ADDON_STYLE: {icon: IconName; iconColor: string; iconBg: string} =
  {icon: 'shield-plus', iconColor: UI.accent, iconBg: 'rgba(37,99,235,0.12)'};

const BASE_INCLUSIONS = [
  '1 × Close Protection Officer',
  '1 × Driver',
  '1 × Standard Vehicle',
  'Bravo Control System Monitoring',
];

export default function AddOnsScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  useServicePricingStore(st => st.overrides);
  const loadServicePricing = useServicePricingStore(st => st.load);
  useEffect(() => { void loadServicePricing(); }, [loadServicePricing]);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();

  const region         = useBookingStore(s => s.draft.region);
  const selectedAddOns = useBookingStore(s => s.draft.selected_add_ons);
  const estimatedPrice = useBookingStore(s => s.draft.estimated_price);
  const availableAddOns = useBookingStore(s => s.availableAddOns);
  const storeError     = useBookingStore(s => s.error);
  const loadAddOns     = useBookingStore(s => s.loadAddOns);
  const estimatePrice  = useBookingStore(s => s.estimatePrice);
  const updateDraft    = useBookingStore(s => s.updateDraft);
  const confirmBooking = useBookingStore(s => s.confirmBooking);

  const [submitting, setSubmitting] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(true);

  // Load the live add-on catalog + a baseline estimate (no add-ons) on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await loadAddOns(region);
      } catch {
        // Non-fatal: surface via the empty-state below; the booking can still
        // proceed with the baseline package.
      } finally {
        if (!cancelled) {setLoadingCatalog(false);}
      }
      await estimatePrice();
    })();
    return () => {cancelled = true;};
    // region is the only input that changes which catalog/price applies.
  }, [region, loadAddOns, estimatePrice]);

  const toggle = (id: string) => {
    const next = selectedAddOns.includes(id)
      ? selectedAddOns.filter(i => i !== id)
      : [...selectedAddOns, id];
    updateDraft({selected_add_ons: next});
    // Re-price against the backend so the total reflects the new selection,
    // the team size, the driver-only discount and any peak surcharge.
    void estimatePrice();
  };

  const priceLabel = useMemo(
    () => (estimatedPrice === null ? '—' : `${Math.round(estimatedPrice)} BC`),
    [estimatedPrice],
  );

  const handleConfirm = async () => {
    if (submitting) {return;}
    setSubmitting(true);
    try {
      // selected_add_ons + a fresh estimate are already in the draft; make
      // one final estimate call so the persisted price can't be stale, then
      // create the booking on the backend (which recomputes authoritatively).
      await estimatePrice();
      const booking = await confirmBooking();
      if (booking.booking_mode === 'later') {
        // B-405 — scheduled reservations return to home (upcoming card);
        // approval + the T-60 reminder arrive as pushes.
        navigation.popToTop();
        Alert.alert(
          'Booking scheduled',
          'Your request is with the Bravo Control System for approval. ' +
          "We'll notify you when it's approved and remind you 1 hour before start. " +
          'You can keep using the app in the meantime — and book another service while this one waits.',
        );
        return;
      }
      navigation.replace('OpsRoomReview', {bookingId: booking.id});
    } catch (e) {
      // Issue 25 — a short balance routes to top-up, never to "Booking failed".
      // Same rule as CustomizeAddOnsScreen; this legacy path had no check at all.
      if (isInsufficientCreditsError(e)) {
        navigation.navigate('CreditPaywall', {
          source: 'booking-flow',
          amountDue: creditShortfallFrom(e),
        });
        return;
      }
      Alert.alert('Booking failed', e instanceof Error ? e.message : 'Could not submit booking. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={UI.bg} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          accessibilityRole="button" accessibilityLabel="Go back"
          hitSlop={{top:8, bottom:8, left:8, right:8}}>
          <Icon name="arrow-left" size={20} color={UI.text} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Add-Ons</Text>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        <View style={styles.titleWrap}>
          <Text style={styles.title}>Enhance Your{'\n'}<Text style={styles.titleHighlight}>Protection</Text></Text>
          <Text style={styles.subtitle}>Optionally add resources to strengthen your security detail.</Text>
        </View>

        {/* Base package */}
        <View style={styles.baseCard}>
          <Text style={styles.baseLabel}>Base Package Included</Text>
          <View style={styles.baseItems}>
            {BASE_INCLUSIONS.map(item => (
              <View key={item} style={styles.baseItem}>
                <Icon name="check-circle" size={14} color={UI.signal} />
                <Text style={styles.baseItemText}>{item}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* Add-ons */}
        <Text style={styles.sectionLabel}>Optional Add-Ons</Text>
        {loadingCatalog ? (
          <View style={styles.catalogState}>
            <LoadingView compact label="Loading available add-ons…" />
          </View>
        ) : availableAddOns.length === 0 ? (
          <View style={styles.catalogState}>
            <Icon name="information-outline" size={18} color={UI.textMute} />
            <Text style={styles.catalogStateText}>
              No optional add-ons for this region. You can continue with the base package.
            </Text>
          </View>
        ) : (
          <View style={styles.addonList}>
            {availableAddOns.map(addon => {
              const active = selectedAddOns.includes(addon.id);
              const style = ADDON_STYLE[addon.id] ?? DEFAULT_ADDON_STYLE;
              const perHour = Number(addon.price_eur_per_hour);
              return (
                <TouchableOpacity key={addon.id}
                  style={[styles.addonCard, active && styles.addonCardActive]}
                  onPress={() => toggle(addon.id)}
                  activeOpacity={0.85}>
                  <View style={[styles.addonIcon, {backgroundColor: style.iconBg}]}>
                    <Icon name={style.icon} size={20} color={style.iconColor} />
                  </View>
                  <View style={styles.addonInfo}>
                    <View style={styles.addonTitleRow}>
                      <Text style={styles.addonTitle} numberOfLines={1} ellipsizeMode="tail">{addon.label}</Text>
                      {addon.requires_ops_approval && (
                        <View style={styles.opsBadge}>
                          <Icon name="shield-alert" size={10} color="#F59E0B" />
                          <Text style={styles.opsBadgeText} numberOfLines={1}>Control System Approval</Text>
                        </View>
                      )}
                    </View>
                    {addon.description ? (
                      <Text style={styles.addonDesc}>{addon.description}</Text>
                    ) : null}
                    <Text style={styles.addonPrice}>
                      {Number.isFinite(perHour) ? `+${Math.round(perHour)} BC/hr` : ''}
                    </Text>
                  </View>
                  <View style={[styles.checkbox, active && styles.checkboxActive]}>
                    {active && <Icon name="check" size={14} color="#FFF" />}
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        {/* Ops approval note */}
        <View style={styles.opsNote}>
          <Icon name="information" size={15} color={UI.accent} />
          <Text style={styles.opsNoteText}>Items marked "Control System Approval" require review by the Bravo Control System before confirmation.</Text>
        </View>

        {storeError ? (
          <View style={styles.errNote}>
            <Icon name="alert-circle-outline" size={15} color="#F87171" />
            <Text style={styles.errNoteText}>{storeError} — the estimate may be out of date.</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, {paddingBottom: bottomPad(16)}]}>
        <View style={styles.totalRow}>
          <Text style={styles.totalLabel}>Estimated Total</Text>
          <Text style={styles.totalValue}>{priceLabel}</Text>
        </View>
        <TouchableOpacity
          style={[styles.btn, submitting && {opacity: 0.6}]}
          onPress={() => { void handleConfirm(); }}
          disabled={submitting}
          activeOpacity={0.85}>
          <Text style={styles.btnText}>{submitting ? 'Submitting…' : 'Confirm & Pay'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex:1, backgroundColor:UI.bg},
  header: {flexDirection:'row', alignItems:'center', gap:12, paddingHorizontal:16, paddingTop:6, paddingBottom:12, borderBottomWidth:1, borderBottomColor:UI.hair},
  backBtn: {width:36, height:36, borderRadius:18, alignItems:'center', justifyContent:'center'},
  headerTitle: {color:UI.textDim, fontSize:11, fontWeight:'800', letterSpacing:2, textTransform:'uppercase'},

  content: {paddingHorizontal:16, paddingTop:20, gap:16},

  titleWrap: {gap:6},
  title: {color:UI.text, fontSize:26, fontWeight:'800', lineHeight:32},
  titleHighlight: {color:UI.accent},
  subtitle: {color:UI.textDim, fontSize:13, lineHeight:20},

  baseCard: {backgroundColor:UI.surface, borderWidth:1, borderColor:UI.hair, borderRadius:16, padding:16},
  baseLabel: {color:UI.signal, fontSize:10, fontWeight:'800', letterSpacing:2, textTransform:'uppercase', marginBottom:10},
  baseItems: {gap:6},
  baseItem: {flexDirection:'row', alignItems:'center', gap:8},
  baseItemText: {color:UI.textDim, fontSize:12},

  sectionLabel: {color:UI.textMute, fontSize:10, fontWeight:'800', letterSpacing:3, textTransform:'uppercase'},

  catalogState: {flexDirection:'row', alignItems:'center', gap:10, backgroundColor:UI.surface, borderWidth:1, borderColor:UI.hair, borderRadius:14, padding:16},
  catalogStateText: {flex:1, color:UI.textDim, fontSize:12, lineHeight:18},

  addonList: {gap:10},
  addonCard: {flexDirection:'row', alignItems:'center', gap:12, backgroundColor:UI.surface, borderWidth:1.5, borderColor:UI.hair, borderRadius:14, padding:14},
  addonCardActive: {borderColor:UI.accent, backgroundColor:'rgba(37,99,235,0.07)'},
  addonIcon: {width:44, height:44, borderRadius:12, alignItems:'center', justifyContent:'center', flexShrink:0},
  addonInfo: {flex:1, minWidth:0},
  addonTitleRow: {flexDirection:'row', alignItems:'center', gap:6, marginBottom:2},
  addonTitle: {color:UI.text, fontSize:13, fontWeight:'700', flexShrink:1},
  opsBadge: {flexDirection:'row', alignItems:'center', gap:3, flexShrink:1, minWidth:0, paddingHorizontal:6, paddingVertical:2, borderRadius:99, backgroundColor:'rgba(245,158,11,0.1)', borderWidth:1, borderColor:'rgba(245,158,11,0.25)'},
  opsBadgeText: {color:Palette.amberText, fontSize:8, fontWeight:'800', letterSpacing:0.5},
  addonDesc: {color:UI.textDim, fontSize:11, lineHeight:16},
  addonPrice: {color:UI.accent, fontSize:11, fontWeight:'700', marginTop:4},
  checkbox: {width:22, height:22, borderRadius:11, borderWidth:1.5, borderColor:'rgba(255,255,255,0.22)', alignItems:'center', justifyContent:'center', flexShrink:0},
  checkboxActive: {backgroundColor:UI.accent, borderColor:UI.accent},

  opsNote: {flexDirection:'row', alignItems:'flex-start', gap:8, backgroundColor:'rgba(37,99,235,0.05)', borderWidth:1, borderColor:UI.hair, borderRadius:10, padding:12},
  opsNoteText: {flex:1, color:UI.textDim, fontSize:11, lineHeight:17},

  errNote: {flexDirection:'row', alignItems:'flex-start', gap:8, backgroundColor:'rgba(248,113,113,0.06)', borderWidth:1, borderColor:'rgba(248,113,113,0.25)', borderRadius:10, padding:12},
  errNoteText: {flex:1, color:Palette.redText, fontSize:11, lineHeight:17},

  footer: {paddingHorizontal:16, paddingTop:12, borderTopWidth:1, borderTopColor:UI.hair, backgroundColor:UI.bg, gap:10},
  totalRow: {flexDirection:'row', justifyContent:'space-between', alignItems:'center'},
  totalLabel: {color:UI.textMute, fontSize:12, fontWeight:'700'},
  totalValue: {color:UI.text, fontSize:18, fontWeight:'800'},
  btn: {paddingVertical:16, borderRadius:12, backgroundColor:UI.accent, alignItems:'center', shadowColor:UI.accent, shadowOffset:{width:0,height:6}, shadowOpacity:0.35, shadowRadius:16, elevation:6},
  btnText: {color:'#FFF', fontSize:14, fontWeight:'800', letterSpacing:0.5},
}));
