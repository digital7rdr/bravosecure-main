/**
 * Booking · Step 02 — Select Service
 *
 * Premium redesign (Bravo "Select Service" design handoff): obsidian/cobalt
 * palette matching the Step 01 "Select Zone" screen. Three mission types as
 * edge-lit service cards — Secure Transfer (live, selectable, price chip),
 * Executive Protection (live — routes into the dedicated executive wizard) and
 * Emergency Extraction (locked, COMING SOON). Gradient "Continue to
 * Schedule" CTA, enabled only while a LITE service is selected.
 *
 * Data layer: Lite cards write `service`+`type` to the booking draft and
 * Continue advances to BookingDateTime; the Executive Protection card leaves this wizard
 * for ExecDuration (seeding the executive draft, dirty-guard first — B-91 M3 R5).
 */
import React from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore, isBookingDraftDirty, type ServiceKey} from '@store/bookingStore';
import {scaleTextStyles} from '@utils/scaling';
import {bookingTypeFor} from './scheduleGate';
import {goBackOnce} from '@navigation/tapGuard';
import {Alert} from '@utils/alert';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ServiceType'>;

// Design tokens (Bravo "Select Service" handoff — obsidian/cobalt premium).
// Mirrors ZoneMapScreen so the two booking steps read as one flow.
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
  accentGlow: 'rgba(91,141,239,0.35)',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type IconName = React.ComponentProps<typeof Icon>['name'];

interface ServiceDef {
  key: ServiceKey;
  title: string;
  desc: string;
  icon: IconName;
  price?: string;
  /** Lite tier — only Secure Transfer is live in Phase 1; others are
   *  scaffolded for upcoming release and surface as COMING SOON. */
  comingSoon?: boolean;
}

const SERVICES: ServiceDef[] = [
  {
    key: 'secure_transfer',
    title: 'Secure Transfer Booking',
    desc: 'Protected transport from A to B with a CPO and dedicated vehicle.',
    icon: 'car-estate',
    price: '86',
  },
  {
    // Executive Protection — executive protection in fixed 3–24 h time blocks. Selecting
    // this card leaves the Lite wizard for the dedicated executive flow (its own
    // duration/schedule/task/transport/team steps); the key stays
    // 'executive_protection' as the card marker only — the executive draft itself
    // is seeded with service 'executive_protection' on ExecDuration mount.
    key: 'executive_protection',
    title: 'Executive Protection',
    desc: 'Executive protection in fixed time blocks — CPO team at your location, 3 to 24 hours.',
    icon: 'shield-crown',
    price: '86',
  },
  {
    key: 'emergency_extraction',
    title: 'Emergency Extraction',
    desc: 'Rapid crisis evacuation and safe-zone transfer services.',
    icon: 'run-fast',
    comingSoon: true,
  },
];

function ServiceCard({svc, selected, onPress}: {svc: ServiceDef; selected: boolean; onPress: () => void}) {
  const locked = !!svc.comingSoon;
  const iconColor = selected ? D.accentSoft : D.textMute;
  return (
    <TouchableOpacity
      activeOpacity={locked ? 1 : 0.85}
      onPress={locked ? undefined : onPress}
      accessibilityRole="button"
      accessibilityLabel={svc.title}
      accessibilityState={{selected, disabled: locked}}
      style={[s.card, selected ? s.cardSelected : s.cardIdle, locked && s.cardLocked]}>
      {selected && <View style={s.cardTopLight} />}

      {/* icon tile */}
      {selected ? (
        <LinearGradient
          colors={['rgba(91,141,239,0.3)', 'rgba(47,91,224,0.08)']}
          start={{x: 0.2, y: 0}}
          end={{x: 0.85, y: 1}}
          style={[s.icTile, s.icTileSelected]}>
          <Icon name={svc.icon} size={24} color={iconColor} />
        </LinearGradient>
      ) : (
        <View style={[s.icTile, s.icTileIdle]}>
          <Icon name={svc.icon} size={24} color={iconColor} />
        </View>
      )}

      <View style={s.body}>
        <View style={s.titleRow}>
          <Text style={[s.title, locked && s.titleDim]}>{svc.title}</Text>
          {locked && (
            <View style={s.soonPill}>
              <Text style={s.soonPillText}>COMING SOON</Text>
            </View>
          )}
        </View>
        <Text style={s.desc}>{svc.desc}</Text>
        {svc.price && !locked && (
          <View style={s.priceChip}>
            <Text style={s.priceFrom}>FROM</Text>
            <Text style={s.priceValue}>{svc.price}</Text>
            <Text style={s.priceUnit}>BC / hr</Text>
          </View>
        )}
      </View>

      {/* selector / lock */}
      {locked ? (
        <Icon name="lock-outline" size={20} color={D.textFaint} />
      ) : selected ? (
        <LinearGradient
          colors={['#6E9BF5', D.accent, D.accentDeep]}
          locations={[0, 0.7, 1]}
          start={{x: 0.35, y: 0.3}}
          end={{x: 0.9, y: 1}}
          style={[s.radio, s.radioOn]}>
          <View style={s.radioDot} />
        </LinearGradient>
      ) : (
        <View style={[s.radio, s.radioIdle]} />
      )}
    </TouchableOpacity>
  );
}

export default function ServiceTypeScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const startExecutiveDraft = useBookingStore(st => st.startExecutiveDraft);
  const service = useBookingStore(st => st.draft.service);

  // An abandoned executive draft leaves service:'executive_protection' —
  // that card exists but is a ROUTER (excluded below), so the CTA must not
  // carry a wizard draft into the Lite schedule (the server would only
  // reject it at final submit).
  const liteSelected = SERVICES.some(
    sv => sv.key === service && !sv.comingSoon && sv.key !== 'executive_protection',
  );

  const handleContinue = () => {
    if (!liteSelected) {return;}
    // Pin the booking type from the selected service on Continue — the Secure
    // Transfer card is pre-selected by default, so a user can proceed WITHOUT
    // tapping it, leaving `type` at its 'timeslot' default and letting a
    // TRANSFER submit with no drop-off (canAdvanceSchedule gate). Re-pin here.
    updateDraft({service, type: bookingTypeFor(service)});
    // Wave 5b (PDF-2) — the 6-screen wizard collapsed into one dashboard grown on
    // CustomizeAddOns (zone + schedule + baseline + team fold in as sections).
    // BookingDateTime / BaselinePackage stay registered but are skipped here.
    navigation.navigate('CustomizeAddOns');
  };

  const openExecutive = () => {
    const goExecutive = () => {
      // Seed before navigating so the dashboard's duration grid renders selected
      // on its first frame; the screen's own mount seed is the deep-link backstop.
      startExecutiveDraft();
      // Wave 5c (PDF-2) — the 7-screen executive wizard collapsed into ONE dashboard
      // grown on ExecReview (duration/schedule/task/transport/team fold in as
      // sections). The six exec step screens stay registered but are skipped here.
      navigation.navigate('ExecReview');
    };
    // B-91 M3 R5 — entering executive re-seeds the shared draft; a dirty Lite form
    // must warn first (same rule as the dashboard switcher). An executive draft in
    // progress resumes silently (startExecutiveDraft is a no-op then).
    if (service !== 'executive_protection' && isBookingDraftDirty()) {
      Alert.alert(
        'Booking in progress',
        'You have an unfinished booking. Switch to Executive Protection and discard it?',
        [
          {text: 'Stay', style: 'cancel'},
          {text: 'Discard & continue', style: 'destructive', onPress: goExecutive},
        ],
      );
      return;
    }
    goExecutive();
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* Ambient glow behind the header */}
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
          <Text style={s.headerTitle}>Select Service</Text>
          <FitLine style={s.headerSub} text={'STEP 2 · CHOOSE PROTECTION TYPE'} />
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, gap: 13}}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled">
        {SERVICES.map(svc => (
          <ServiceCard
            key={svc.key}
            svc={svc}
            selected={svc.key === service && !svc.comingSoon}
            onPress={() => {
              // Executive Protection is its own wizard, not a Lite service selection.
              if (svc.key === 'executive_protection') {
                openExecutive();
                return;
              }
              updateDraft({
                service: svc.key, type: bookingTypeFor(svc.key),
                // Returning from an abandoned executive draft: restore the Lite
                // defaults the executive seed changed (3 h block ≠ 4 h default, no
                // vehicle) and drop executive-specific work (brief, transfer legs)
                // so none of it silently rides into a Lite booking.
                ...(service === 'executive_protection' ? {
                  duration_hours: 4, vehicle_count: 1, notes: '',
                  driver_only: false,
                  addon_switches: {}, selected_add_ons: [],
                  estimated_price: null,
                  transport_mode: 'none' as const,
                  transport_pickup: null, transport_dropoff: null,
                  transport_pickup_time: '',
                } : null),
              });
            }}
          />
        ))}
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={0.9}
          onPress={handleContinue}
          disabled={!liteSelected}
          accessibilityRole="button"
          accessibilityState={{disabled: !liteSelected}}>
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, !liteSelected && s.ctaDisabled]}>
            <Text style={s.ctaText}>Continue to Schedule</Text>
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
    width: 460, height: 280, borderRadius: 230,
    backgroundColor: 'rgba(91,141,239,0.07)',
  },

  // Header
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

  scroll: {flex: 1},

  // Service card
  card: {
    flexDirection: 'row', alignItems: 'center', gap: 15,
    padding: 16, borderRadius: 22, overflow: 'hidden',
  },
  cardIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  cardSelected: {
    backgroundColor: 'rgba(16,26,46,0.92)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.55)',
    shadowColor: '#14285A', shadowOpacity: 0.4, shadowRadius: 18, shadowOffset: {width: 0, height: 14}, elevation: 9,
  },
  cardLocked: {opacity: 0.55},
  cardTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(120,160,255,0.4)'},

  icTile: {
    width: 52, height: 52, borderRadius: 15, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  icTileIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  icTileSelected: {
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.45)',
    shadowColor: D.accent, shadowOpacity: 0.3, shadowRadius: 20, shadowOffset: {width: 0, height: 0}, elevation: 6,
  },

  body: {flex: 1, minWidth: 0},
  titleRow: {flexDirection: 'row', alignItems: 'center', gap: 9, flexWrap: 'wrap'},
  title: {fontFamily: D.fBold, fontSize: 17, letterSpacing: -0.3, color: D.text},
  titleDim: {color: D.textDim},
  desc: {fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, letterSpacing: -0.05, color: D.textDim, marginTop: 6},

  soonPill: {
    paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6,
    backgroundColor: 'rgba(245,181,68,0.10)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.34)',
    overflow: 'hidden',
  },
  soonPillText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 1.2, color: D.amber},

  priceChip: {
    alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'baseline', gap: 5,
    marginTop: 12, paddingVertical: 5, paddingHorizontal: 11, borderRadius: 9,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    overflow: 'hidden',
  },
  priceFrom: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 1, color: D.textMute},
  priceValue: {fontFamily: D.fBold, fontSize: 15, letterSpacing: -0.2, color: D.accentSoft},
  priceUnit: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', letterSpacing: 0.4, color: D.textDim},

  // Selector / lock
  radio: {
    width: 24, height: 24, borderRadius: 12, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  radioIdle: {borderWidth: 1.5, borderColor: D.hair2},
  radioOn: {
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
    shadowColor: D.accent, shadowOpacity: 0.6, shadowRadius: 14, shadowOffset: {width: 0, height: 4}, elevation: 6,
  },
  radioDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff'},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
  ctaDisabled: {opacity: 0.45},
}));
