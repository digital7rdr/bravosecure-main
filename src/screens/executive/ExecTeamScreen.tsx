/**
 * Executive Protection · Step 06 — Team & Add-ons
 *
 * CPO stepper (each CPO is charged per hour), Vehicles & Drivers stepper
 * (enabled only when a secure-transfer leg was added — each vehicle+driver is
 * charged per hour), Driver Only toggle (client vehicle, Bravo driver), and
 * the four optional add-ons. A live rate card shows Current Rate (BC/hr) and
 * the Estimated Total (rate × duration); the authoritative total comes from
 * the debounced server estimate (service 'executive_protection') and wins when present.
 *
 * Data: draft.cpo_count / vehicle_count / driver_only / addon_switches /
 * selected_add_ons / estimated_price. Continue → ExecReview.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, Switch} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {bookingApi} from '@services/api';
import {vehiclesForPassengers, maxCposForClientVehicle, MAX_CPOS} from '@screens/booking/pricing';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {EXEC_ADDONS, execAddOnsBcPerHour, execRateBcPerHour, execTotalBc} from './executivePricing';
import {useServicePricingStore} from '@store/servicePricingStore';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ExecTeam'>;

// Design tokens — obsidian/cobalt premium (mirrors the executive/Lite wizard).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

function Stepper({value, unit, onMinus, onPlus, minusDisabled, plusDisabled}: {
  value: number; unit: string; onMinus: () => void; onPlus: () => void;
  minusDisabled?: boolean; plusDisabled?: boolean;
}) {
  return (
    <View style={s.stepCtrl}>
      <TouchableOpacity
        style={[s.stepBtn, minusDisabled && s.stepBtnDisabled]}
        onPress={onMinus}
        disabled={minusDisabled}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Remove ${unit}`}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Icon name="minus" size={16} color={minusDisabled ? D.textFaint : D.textDim} />
      </TouchableOpacity>
      <Text style={s.stepVal}>{value}</Text>
      <TouchableOpacity
        onPress={onPlus}
        disabled={plusDisabled}
        activeOpacity={0.85}
        accessibilityRole="button"
        accessibilityLabel={`Add ${unit}`}
        hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <LinearGradient
          colors={plusDisabled ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accentDeep]}
          start={{x: 0, y: 0}}
          end={{x: 0, y: 1}}
          style={s.stepBtnPri}>
          <Icon name="plus" size={16} color={plusDisabled ? D.textFaint : '#fff'} />
        </LinearGradient>
      </TouchableOpacity>
    </View>
  );
}

export default function ExecTeamScreen() {
  // Live ops-editable pricing (founder 2026-08-26): subscribe so a
  // hydration re-renders the quote; load is single-flight + fail-open.
  useServicePricingStore(st => st.overrides);
  const loadServicePricing = useServicePricingStore(st => st.load);
  useEffect(() => { void loadServicePricing(); }, [loadServicePricing]);

  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);

  const hasTransport = draft.transport_mode !== 'none';
  const minVehicles = hasTransport && !draft.driver_only
    ? Math.max(1, vehiclesForPassengers(draft.passengers))
    : 0;
  const maxCpos = draft.driver_only ? maxCposForClientVehicle(draft.passengers) : MAX_CPOS;

  // Back-nav guard: a passenger change on the Transport step can shrink the
  // driver-only seat cap below the stored team — clamp on entry so the rate
  // card, the review screen and the server all price the same team.
  useEffect(() => {
    if (draft.cpo_count > maxCpos) {
      updateDraft({cpo_count: Math.max(1, maxCpos)});
    }
    if (!draft.driver_only && hasTransport && draft.vehicle_count < minVehicles) {
      updateDraft({vehicle_count: minVehicles});
    }
  }, [draft.cpo_count, draft.vehicle_count, draft.driver_only, maxCpos, minVehicles, hasTransport, updateDraft]);

  const selectedAddOns = useMemo(
    () => EXEC_ADDONS.filter(a => draft.addon_switches[a.id]).map(a => a.id),
    [draft.addon_switches],
  );

  // Local mirror — instant; server estimate (below) is authoritative.
  const rateBc = execRateBcPerHour({
    cpoCount: draft.cpo_count,
    vehicleCount: draft.vehicle_count,
    driverOnly: draft.driver_only,
    addOnsBcPerHour: execAddOnsBcPerHour(selectedAddOns),
  });
  const [serverTotal, setServerTotal] = useState<number | null>(null);
  const estimateSeq = useRef(0);

  useEffect(() => {
    const seq = ++estimateSeq.current;
    setServerTotal(null);
    const t = setTimeout(() => {
      void (async () => {
        try {
          const {data} = await bookingApi.estimatePrice({
            type: 'timeslot',
            service: 'executive_protection',
            duration_hours: draft.duration_hours,
            add_ons: selectedAddOns,
            region: draft.region,
            cpo_count: draft.cpo_count,
            vehicle_count: draft.vehicle_count,
            driver_only: draft.driver_only,
            passengers: draft.passengers,
            pickup_time: draft.start_time || undefined,
          });
          if (estimateSeq.current === seq) {setServerTotal(data.total);}
        } catch {
          // Offline / transient — the local mirror stays on screen.
        }
      })();
    }, 400);
    return () => clearTimeout(t);
  }, [draft.cpo_count, draft.vehicle_count, draft.driver_only, draft.duration_hours,
    draft.region, draft.start_time, draft.passengers, selectedAddOns]);

  const totalBc = serverTotal ?? execTotalBc(rateBc, draft.duration_hours);

  const setCpos = (n: number) => {
    updateDraft({cpo_count: Math.max(1, Math.min(maxCpos, n))});
  };
  const setVehicles = (n: number) => {
    updateDraft({vehicle_count: Math.max(minVehicles, Math.min(4, n))});
  };
  const setDriverOnly = (on: boolean) => {
    if (on) {
      updateDraft({
        driver_only: true,
        vehicle_count: 0,
        cpo_count: Math.min(draft.cpo_count, maxCposForClientVehicle(draft.passengers)),
      });
    } else {
      updateDraft({
        driver_only: false,
        vehicle_count: Math.max(1, vehiclesForPassengers(draft.passengers)),
      });
    }
  };
  const toggleAddOn = (id: string) => {
    const switches = {...draft.addon_switches, [id]: !draft.addon_switches[id]};
    updateDraft({
      addon_switches: switches,
      selected_add_ons: EXEC_ADDONS.filter(a => switches[a.id]).map(a => a.id),
    });
  };

  const handleContinue = () => {
    updateDraft({
      selected_add_ons: selectedAddOns,
      estimated_price: totalBc,
    });
    navigation.navigate('ExecReview');
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
          <Text style={s.headerTitle}>Team &amp; Add-ons</Text>
          <FitLine style={s.headerSub} text={'EXECUTIVE PROTECTION · STEP 6 · TEAM'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 240, paddingTop: 4, gap: 16}}
        showsVerticalScrollIndicator={false}>
        <Text style={s.lede}>Configure your team and any additional support.</Text>

        {/* Team composition */}
        <View>
          <Text style={s.fieldLabel}>TEAM COMPOSITION</Text>
          <View style={s.teamCard}>
            <View style={s.teamRow}>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.teamLabel}>CPOs</Text>
                <Text style={s.teamSub}>Close Protection Officers · 86 BC/hr each</Text>
              </View>
              <Stepper
                value={draft.cpo_count}
                unit="CPO"
                onMinus={() => setCpos(draft.cpo_count - 1)}
                onPlus={() => setCpos(draft.cpo_count + 1)}
                minusDisabled={draft.cpo_count <= 1}
                plusDisabled={draft.cpo_count >= maxCpos}
              />
            </View>
            <View style={s.teamDivider} />
            <View style={s.teamRow}>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={[s.teamLabel, !hasTransport && s.teamLabelDim]}>Vehicles &amp; Drivers</Text>
                <Text style={s.teamSub}>
                  {hasTransport
                    ? (draft.driver_only ? 'Using your own vehicle' : '30 BC/hr each · min ' + minVehicles + ' for your party')
                    : 'Only if transport added'}
                </Text>
              </View>
              <Stepper
                value={draft.vehicle_count}
                unit="vehicle"
                onMinus={() => setVehicles(draft.vehicle_count - 1)}
                onPlus={() => setVehicles(draft.vehicle_count + 1)}
                minusDisabled={!hasTransport || draft.driver_only || draft.vehicle_count <= minVehicles}
                plusDisabled={!hasTransport || draft.driver_only || draft.vehicle_count >= 4}
              />
            </View>
          </View>
        </View>

        {/* Driver only */}
        <View style={[s.driverCard, !hasTransport && s.cardDisabled]}>
          <View style={s.driverIcon}>
            <Icon name="steering" size={18} color={hasTransport ? D.accentSoft : D.textFaint} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={[s.teamLabel, !hasTransport && s.teamLabelDim]}>Driver Only (Client Vehicle)</Text>
            <Text style={s.teamSub}>
              {hasTransport
                ? 'You provide the vehicle — Bravo driver only · +20 BC/hr'
                : 'Available when transport is added'}
            </Text>
          </View>
          <Switch
            value={draft.driver_only}
            onValueChange={setDriverOnly}
            disabled={!hasTransport}
            trackColor={{false: 'rgba(255,255,255,0.12)', true: D.accentDeep}}
            thumbColor={draft.driver_only ? D.accentSoft : '#8B93A5'}
            accessibilityLabel="Driver only — client vehicle"
          />
        </View>

        {/* Add-ons */}
        <View>
          <Text style={s.fieldLabel}>OPTIONAL ADD-ONS</Text>
          <View style={s.addonsCard}>
            {EXEC_ADDONS.map((a, i) => {
              const on = !!draft.addon_switches[a.id];
              return (
                <View key={a.id} style={[s.addonRow, i > 0 && s.teamDivider2]}>
                  <View style={[s.addonIcon, on && s.addonIconOn]}>
                    <Icon name={a.icon as never} size={16} color={on ? D.accentSoft : D.textMute} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.teamLabel} numberOfLines={1}>{a.label}</Text>
                    <View style={s.addonPriceChip}>
                      <Text style={s.addonPriceText}>+{a.bcPerHour} BC/hr</Text>
                    </View>
                  </View>
                  <Switch
                    value={on}
                    onValueChange={() => toggleAddOn(a.id)}
                    trackColor={{false: 'rgba(255,255,255,0.12)', true: D.accentDeep}}
                    thumbColor={on ? D.accentSoft : '#8B93A5'}
                    accessibilityLabel={`${a.label}, ${a.bcPerHour} BC per hour`}
                  />
                </View>
              );
            })}
          </View>
          <Text style={s.ratesNote}>Rates are per hour and will be applied to the total duration.</Text>
        </View>
      </ScrollView>

      {/* ── Rate card + CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.35]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <View style={s.rateCard}>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.rateLabel}>CURRENT RATE</Text>
            <View style={s.rateRow}>
              <Text style={s.rateValue}>{Math.round(rateBc)}</Text>
              <Text style={s.rateUnit}>BC / hr</Text>
            </View>
          </View>
          <View style={{alignItems: 'flex-end'}}>
            <Text style={s.rateLabel}>ESTIMATED TOTAL · {draft.duration_hours} HRS</Text>
            <View style={s.rateRow}>
              <Text style={s.rateTotal}>{Math.round(totalBc)}</Text>
              <Text style={s.rateUnit}>BC{serverTotal === null ? ' (est.)' : ''}</Text>
            </View>
          </View>
        </View>
        <TouchableOpacity activeOpacity={0.9} onPress={handleContinue} accessibilityRole="button">
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.cta}>
            <Text style={s.ctaText}>Review Booking</Text>
            <Icon name="arrow-right" size={19} color="#fff" importantForAccessibility="no" />
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
    width: 460, height: 260, borderRadius: 230,
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

  lede: {fontFamily: D.fSans, fontSize: 13, lineHeight: 19, color: D.textDim},

  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },

  teamCard: {
    borderRadius: 16, paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  teamRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 13},
  teamDivider: {height: 1, backgroundColor: D.hair},
  teamDivider2: {borderTopWidth: 1, borderTopColor: D.hair},
  teamLabel: {fontFamily: D.fSemi, fontSize: 14, color: D.text, letterSpacing: -0.1},
  teamLabelDim: {color: D.textMute},
  teamSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 3},

  stepCtrl: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0},
  stepBtn: {
    width: 38, height: 38, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  stepBtnDisabled: {opacity: 0.4},
  stepBtnPri: {
    width: 38, height: 38, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  stepVal: {width: 30, textAlign: 'center', fontFamily: D.fBold, fontSize: 18, color: D.text},

  driverCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  cardDisabled: {opacity: 0.55},
  driverIcon: {
    width: 34, height: 34, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },

  addonsCard: {
    borderRadius: 16, paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  addonRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12},
  addonIcon: {
    width: 32, height: 32, borderRadius: 10, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  addonIconOn: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.4)'},
  addonPriceChip: {
    alignSelf: 'flex-start', marginTop: 4,
    paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)',
  },
  addonPriceText: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 0.3, color: D.accentSoft},
  ratesNote: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 9, paddingLeft: 2},

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 24, gap: 10},
  rateCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(16,26,46,0.92)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  rateLabel: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '700', letterSpacing: 1.2, color: D.textMute},
  rateRow: {flexDirection: 'row', alignItems: 'baseline', gap: 5, marginTop: 4},
  rateValue: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.5, color: D.text},
  rateTotal: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.5, color: D.accentSoft},
  rateUnit: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', color: D.textDim},

  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
