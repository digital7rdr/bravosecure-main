/**
 * Booking · Step 03 — Schedule
 *
 * Premium redesign (Bravo "Schedule" design handoff): obsidian/cobalt palette
 * matching the Select Zone / Select Service steps. Book Now / Book Later
 * segmented toggle with a sliding gradient pill, amber lead-time notice,
 * labeled pick-up / drop-off location rows (Mapbox LocationPicker modal),
 * a cobalt-banded scroll-wheel time picker, and a passenger stepper. Gradient
 * "Confirm Schedule" CTA.
 *
 * Data layer is unchanged from the original: LocationPicker round-trip,
 * 3-hour lead-time validation, Book Later native date/time pickers, draft
 * write, then navigate to BaselinePackage.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  Platform, Modal, Pressable, Animated,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore, type BookingMode} from '@store/bookingStore';
import {useSecureProStore} from '@store/secureProStore';
import WheelTimePicker from '@components/booking/WheelTimePicker';
import {vehiclesForPassengers} from './pricing';
import {canAdvanceSchedule, MIN_LEAD_HOURS} from './scheduleGate';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'BookingDateTime'>;
type Rt  = RouteProp<BookingStackParamList, 'BookingDateTime'>;

const pad = (n: number) => n.toString().padStart(2, '0');

// Design tokens (Bravo "Schedule" handoff — obsidian/cobalt premium).
// Mirrors ZoneMapScreen / ServiceTypeScreen so the booking steps read as one
// flow; the app-wide Command Navy theme isn't applied here on purpose.
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

interface PickedLocation {
  address: string;
  lat: number;
  lng: number;
}

function LocationRow({
  label, address, placeholder, filled, onPress,
}: {
  label: string;
  address?: string;
  placeholder: string;
  filled: boolean;
  onPress: () => void;
}) {
  return (
    <View>
      <Text style={s.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[s.locRow, filled ? s.locRowFilled : s.locRowIdle]}
        onPress={onPress}
        activeOpacity={0.8}>
        <View style={s.locTopLight} />
        <View style={[s.locPin, filled ? s.locPinFilled : s.locPinIdle]}>
          <Icon
            name={filled ? 'map-marker' : 'map-marker-outline'}
            size={16}
            color={filled ? D.accent : D.textMute}
          />
        </View>
        <Text
          style={[s.locText, filled ? s.locTextFilled : s.locTextPlaceholder]}
          numberOfLines={1}>
          {filled ? address : placeholder}
        </Text>
        <Icon name="chevron-right" size={16} color={D.textMute} />
      </TouchableOpacity>
    </View>
  );
}

export default function BookingDateTimeScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();

  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);

  const [mode, setMode] = useState<BookingMode>(draft.mode ?? 'now');

  /**
   * Founder 2026-08-26 — an ACTIVE Pro member books NOW only here. Scheduled
   * protection is what the Pro plan itself sells (Booking Requests -> ops
   * approval), so 'Book Later' in the ad-hoc flow duplicates that product.
   * Read the store directly rather than useProPlanGate: the gate REDIRECTS
   * non-Pro users away, and this screen serves everyone.
   */
  const proApplication = useSecureProStore(st => st.application);
  const loadProApplication = useSecureProStore(st => st.loadApplication);
  const proActive = proApplication?.status === 'ACTIVE';
  useEffect(() => { void loadProApplication(); }, [loadProApplication]);
  // A stale 'later' draft (or the plan activating mid-flow) must not leave a
  // Pro member on a mode the UI no longer offers.
  useEffect(() => {
    if (proActive && mode === 'later') {setMode('now');}
  }, [proActive, mode]);
  const [passengers, setPassengers] = useState<number>(draft.passengers ?? 2);
  const [pickup, setPickup] = useState<PickedLocation | null>(
    draft.pickup
      ? {address: draft.pickup.address ?? 'Pick-up', lat: draft.pickup.latitude, lng: draft.pickup.longitude}
      : null,
  );
  const [dropoff, setDropoff] = useState<PickedLocation | null>(
    draft.dropoff
      ? {address: draft.dropoff.address ?? 'Drop-off', lat: draft.dropoff.latitude, lng: draft.dropoff.longitude}
      : null,
  );

  // Earliest bookable time = now + 3h, rounded up to next 5-min boundary.
  const earliest = useMemo(() => {
    const d = new Date(Date.now() + MIN_LEAD_HOURS * 3600_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
    return d;
  }, []);

  const [hour, setHour] = useState<number>(earliest.getHours());
  const [minute, setMinute] = useState<number>(earliest.getMinutes());

  // Book Later: a full Date so we capture the day too.
  const [laterDate, setLaterDate] = useState<Date>(earliest);
  const [pickerMode, setPickerMode] = useState<'date' | 'time' | null>(null);

  // Sliding pill for the Book Now / Book Later segmented toggle.
  const slide = useRef(new Animated.Value(mode === 'now' ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: mode === 'now' ? 0 : 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [mode, slide]);

  // ── When the LocationPicker navigates back with params, merge into state ──
  useEffect(() => {
    const p = route.params;
    if (!p?.pickedAt || typeof p.pickedLat !== 'number' || typeof p.pickedLng !== 'number') {return;}
    const picked: PickedLocation = {
      address: p.pickedAddress ?? 'Selected location',
      lat: p.pickedLat,
      lng: p.pickedLng,
    };
    if (p.pickedKind === 'pickup') {setPickup(picked);}
    else if (p.pickedKind === 'dropoff') {setDropoff(picked);}
    // Clear the params so re-renders don't reapply the same pick.
    navigation.setParams({
      pickedAt: undefined,
      pickedAddress: undefined,
      pickedLat: undefined,
      pickedLng: undefined,
      pickedKind: undefined,
    } as never);
  }, [route.params, navigation]);

  const openPicker = (kind: 'pickup' | 'dropoff') => {
    // Prefer the previously-picked spot for this slot; if the dropoff has
    // never been picked, fall back to the pickup so the picker opens in
    // the right country (and the search is scoped correctly from frame 1).
    const init = kind === 'pickup' ? pickup : (dropoff ?? pickup);
    navigation.navigate('LocationPicker', {
      kind,
      countryCode: draft.zone_code || 'AE',
      initial: init ? {latitude: init.lat, longitude: init.lng, address: init.address} : undefined,
    });
  };

  const onLaterChange = (ev: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setPickerMode(null);}
    if (d) {
      setLaterDate(d);
      if (pickerMode === 'date') {
        // On Android, chain straight into the time picker.
        if (Platform.OS === 'android') {setTimeout(() => setPickerMode('time'), 50);}
      }
    }
  };

  // Why: a point-to-point transfer needs both ends; hourly/itinerary bookings
  // legitimately have no single drop-off, so dropoff is required only for transfers.
  const requiresDropoff = draft.type === 'transfer';
  const canContinue = canAdvanceSchedule(draft.type, pickup, dropoff);

  const handleContinue = () => {
    if (!canContinue || !pickup || (requiresDropoff && !dropoff)) {return;}

    let start: Date;
    if (mode === 'now') {
      start = new Date();
      start.setHours(hour, minute, 0, 0);
      if (start.getTime() < Date.now() + MIN_LEAD_HOURS * 3600_000) {
        start.setDate(start.getDate() + 1);
      }
    } else {
      start = new Date(laterDate);
    }

    // Passengers drive the minimum vehicle count (1 per 3 pax). Carry that
    // forward so Team & Add-ons starts correctly sized; the user can still
    // ADD vehicles there but not drop below this minimum.
    const minVehicles = vehiclesForPassengers(passengers);

    updateDraft({
      mode,
      passengers,
      vehicle_count: Math.max(draft.vehicle_count ?? 1, minVehicles),
      pickup: {address: pickup.address, latitude: pickup.lat, longitude: pickup.lng, label: 'Pick-up'},
      dropoff: dropoff
        ? {address: dropoff.address, latitude: dropoff.lat, longitude: dropoff.lng, label: 'Drop-off'}
        : null,
      start_time: start.toISOString(),
    });
    navigation.navigate('BaselinePackage');
  };

  const laterLabel =
    laterDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'}) +
    ` · ${pad(laterDate.getHours())}:${pad(laterDate.getMinutes())}`;

  // Sliding-pill geometry — measured from the REAL rendered track via
  // onLayout. The old arithmetic (`Math.min(width, 402) - 40 - 10`) guessed
  // the page padding from the window width and broke on wide/scaled
  // viewports: the pill rendered too narrow and slid too little, floating
  // between the two labels (B-93). layout.width includes the container's
  // 5px padding + 1px border per side, hence the −12.
  const [toggleTrackW, setToggleTrackW] = useState(0);
  const pillWidth = Math.max(0, (toggleTrackW - 12) / 2);
  const pillX = slide.interpolate({inputRange: [0, 1], outputRange: [0, pillWidth]});

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
          <Text style={s.headerTitle}>Schedule</Text>
          <FitLine style={s.headerSub} text={'STEP 3 · PICK-UP & TIME'} />
        </View>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4, gap: 16}}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled>

        {/* Mode toggle — sliding gradient pill. Hidden for an ACTIVE Pro
            member (now-only; see the proActive block above): a rendered
            toggle that snaps back would read as broken, and B-590's rule
            applies — hide the door, never no-op it. */}
        {proActive ? (
          <View style={s.proNowOnly}>
            <Icon name="shield-check" size={15} color={D.accentSoft} />
            <Text style={s.proNowOnlyText} numberOfLines={2}>
              Pro plan — instant bookings here. Schedule protection dates via Booking Requests.
            </Text>
          </View>
        ) : (
        <View style={s.toggle} onLayout={e => setToggleTrackW(e.nativeEvent.layout.width)}>
          {toggleTrackW > 0 && (
            <Animated.View style={[s.togglePillWrap, {width: pillWidth, transform: [{translateX: pillX}]}]}>
              <LinearGradient
                colors={['#6E9BF5', D.accent, D.accentDeep]}
                locations={[0, 0.6, 1]}
                start={{x: 0, y: 0}}
                end={{x: 0, y: 1}}
                style={s.togglePill}
              />
            </Animated.View>
          )}
          <TouchableOpacity style={s.toggleSeg} onPress={() => setMode('now')} activeOpacity={0.85}>
            <Text style={[s.toggleT, mode === 'now' && s.toggleTOn]} numberOfLines={1}>Book Now</Text>
            <Text style={[s.toggleS, mode === 'now' && s.toggleSOn]} numberOfLines={1}>
              Earliest {pad(earliest.getHours())}:{pad(earliest.getMinutes())}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.toggleSeg} onPress={() => setMode('later')} activeOpacity={0.85}>
            <Text style={[s.toggleT, mode === 'later' && s.toggleTOn]} numberOfLines={1}>Book Later</Text>
            <Text style={[s.toggleS, mode === 'later' && s.toggleSOn]} numberOfLines={1}>Choose date &amp; time</Text>
          </TouchableOpacity>
        </View>
        )}

        {/* Min lead warning (Book Now only) */}
        {mode === 'now' && (
          <View style={s.alertWarn}>
            <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
            <Text style={s.alertText}>
              <Text style={s.alertBold}>Minimum 3-hour lead time</Text> for all bookings · earliest{' '}
              {pad(earliest.getHours())}:{pad(earliest.getMinutes())} today.
            </Text>
          </View>
        )}

        {/* Pickup / Drop-off */}
        <LocationRow
          label="PICK-UP LOCATION"
          address={pickup?.address}
          placeholder="Select pick-up…"
          filled={!!pickup}
          onPress={() => openPicker('pickup')}
        />
        <LocationRow
          label="DROP-OFF LOCATION"
          address={dropoff?.address}
          placeholder="Select destination…"
          filled={!!dropoff}
          onPress={() => openPicker('dropoff')}
        />

        {!canContinue && (
          <Text style={s.gateHint}>
            {!pickup
              ? 'Add a pick-up location to continue.'
              : 'Add a drop-off location to continue.'}
          </Text>
        )}

        {/* Time picker — now vs later */}
        {mode === 'now' ? (
          <View>
            <Text style={s.fieldLabel}>PICK-UP TIME</Text>
            <WheelTimePicker
              hour={hour}
              minute={minute}
              onChange={(h, m) => {
                setHour(h);
                setMinute(m);
              }}
              minuteStep={5}
            />
          </View>
        ) : (
          <View>
            <Text style={s.fieldLabel}>MISSION START</Text>
            <View style={s.laterBox}>
              <View style={s.laterRow}>
                <TouchableOpacity style={s.laterBtn} onPress={() => setPickerMode('date')} activeOpacity={0.8}>
                  <Icon name="calendar" size={15} color={D.accent} />
                  <FitLine style={s.laterBtnText} floorScale={0.75} text={laterDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})} />
                </TouchableOpacity>
                <TouchableOpacity style={s.laterBtn} onPress={() => setPickerMode('time')} activeOpacity={0.8}>
                  <Icon name="clock-outline" size={15} color={D.accent} />
                  <Text style={s.laterBtnText} numberOfLines={1} ellipsizeMode="tail">
                    {pad(laterDate.getHours())}:{pad(laterDate.getMinutes())}
                  </Text>
                </TouchableOpacity>
              </View>
              <Text style={s.laterHint}>{laterLabel}</Text>
            </View>
          </View>
        )}

        {/* Passengers */}
        <View>
          <Text style={s.fieldLabel}>PASSENGERS</Text>
          <View style={s.counter}>
            <View style={s.counterTopLight} />
            <View style={s.counterLeft}>
              <View style={s.counterIcon}>
                <Icon name="account" size={17} color={D.accent} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.counterLabel} numberOfLines={2}>Number of passengers</Text>
                <Text style={s.counterSub} numberOfLines={2}>Excluding CPO and driver</Text>
              </View>
            </View>
            <View style={s.counterCtrl}>
              <TouchableOpacity
                style={s.counterBtn}
                onPress={() => setPassengers(Math.max(1, passengers - 1))}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel="Remove passenger"
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="minus" size={16} color={D.textDim} />
              </TouchableOpacity>
              <Text style={s.counterVal}>{passengers}</Text>
              <TouchableOpacity
                onPress={() => setPassengers(Math.min(12, passengers + 1))}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Add passenger"
                hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <LinearGradient
                  colors={['#6E9BF5', D.accentDeep]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.counterBtnPri}>
                  <Icon name="plus" size={16} color="#fff" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>

        <View style={s.hint}>
          <Icon name="information-outline" size={16} color={D.accentSoft} style={{marginTop: 1}} />
          <Text style={s.hintText}>
            Each vehicle carries up to 3 passengers (CPO and driver occupy 1 seat each).{' '}
            {passengers > 3 ? (
              <Text style={s.hintStrong}>
                {vehiclesForPassengers(passengers)} vehicles will be assigned — adjust on the next step.
              </Text>
            ) : '1 vehicle covers this party.'}
          </Text>
        </View>
      </ScrollView>

      {/* Inline date / time picker modals */}
      {Platform.OS === 'android' && pickerMode && (
        <DateTimePicker
          value={laterDate}
          mode={pickerMode}
          is24Hour
          display="default"
          minimumDate={new Date(Date.now() + MIN_LEAD_HOURS * 3600_000)}
          onChange={onLaterChange}
        />
      )}
      {Platform.OS === 'ios' && pickerMode && (
        <Modal
          visible
          transparent
          animationType="slide"
          onRequestClose={() => setPickerMode(null)}>
          <Pressable style={s.iosBackdrop} onPress={() => setPickerMode(null)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker
                value={laterDate}
                mode={pickerMode}
                is24Hour
                display="spinner"
                minimumDate={new Date(Date.now() + MIN_LEAD_HOURS * 3600_000)}
                textColor={D.text}
                onChange={onLaterChange}
              />
              <TouchableOpacity activeOpacity={0.9} onPress={() => setPickerMode(null)}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.iosDone}>
                  <Text style={s.iosDoneText}>Done</Text>
                </LinearGradient>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* ── Footer CTA ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.5]}
        style={[s.ctaWrap, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          activeOpacity={canContinue ? 0.9 : 1}
          disabled={!canContinue}
          onPress={handleContinue}>
          <LinearGradient
            colors={canContinue ? ['#6E9BF5', D.accent, D.accentDeep] : ['#27324A', '#1C2436']}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, !canContinue && s.ctaDisabled]}>
            <Text style={s.ctaText}>Confirm Schedule</Text>
            <Icon name="arrow-right" size={19} color="#fff" />
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

  // Segmented toggle
  toggle: {
    flexDirection: 'row', padding: 5, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.035)', borderWidth: 1, borderColor: D.hair2,
  },
  togglePillWrap: {position: 'absolute', top: 5, bottom: 5, left: 5},
  togglePill: {
    flex: 1, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8,
  },
  toggleSeg: {flex: 1, paddingVertical: 12, paddingHorizontal: 8, alignItems: 'center'},
  toggleT: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: D.textDim},
  toggleTOn: {color: '#fff'},
  toggleS: {fontFamily: D.fMono, fontSize: 9.5, letterSpacing: 0.4, color: D.textMute, marginTop: 4},
  toggleSOn: {color: 'rgba(255,255,255,0.8)'},

  // Lead-time notice
  alertWarn: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 14,
    borderRadius: 13,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  alertText: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textDim, lineHeight: 16},
  alertBold: {fontFamily: D.fSemi, color: D.amber},

  // Field label
  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },

  // Location rows
  locRow: {
    position: 'relative', overflow: 'hidden',
    minHeight: 58, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
  },
  locRowFilled: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locRowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  locTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  locPin: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  locPinFilled: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  locPinIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locText: {flex: 1, fontSize: 14.5, letterSpacing: -0.1},
  locTextFilled: {fontFamily: D.fSemi, color: D.text},
  locTextPlaceholder: {fontFamily: D.fSans, color: D.textFaint},

  // Book Later
  proNowOnly: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
  },
  proNowOnlyText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textDim},
  laterBox: {
    padding: 14, borderRadius: 16, gap: 10,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  laterRow: {flexDirection: 'row', gap: 10},
  laterBtn: {
    flex: 1, paddingVertical: 13, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center',
  },
  laterBtnText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.text, letterSpacing: 0.2},
  laterHint: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, textAlign: 'center'},

  // Passenger stepper
  counter: {
    position: 'relative', overflow: 'hidden',
    minHeight: 60, paddingVertical: 10, borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: 14, paddingRight: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  counterTopLight: {position: 'absolute', top: 0, left: 14, right: 14, height: 1, backgroundColor: 'rgba(255,255,255,0.08)'},
  counterLeft: {flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1, minWidth: 0, paddingRight: 8},
  counterIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  counterLabel: {fontFamily: D.fSemi, fontSize: 14, color: D.text, letterSpacing: -0.1},
  counterSub: {fontFamily: D.fSans, fontSize: 10.5, color: D.textMute, marginTop: 2},
  counterCtrl: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0},
  counterBtn: {
    width: 38, height: 38, borderRadius: 11,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  counterBtnPri: {
    width: 38, height: 38, borderRadius: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 6}, elevation: 6,
  },
  counterVal: {minWidth: 34, textAlign: 'center', fontFamily: D.fBold, fontSize: 20, color: D.text},

  // Info hint
  hint: {
    flexDirection: 'row', gap: 10, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  hintText: {flex: 1, fontFamily: D.fSans, fontSize: 11, color: D.textDim, lineHeight: 16},
  hintStrong: {fontFamily: D.fSemi, color: D.accentSoft},
  gateHint: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginTop: 2, marginBottom: 6},

  // iOS picker modal
  iosBackdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,6,15,0.72)'},
  iosCard: {
    backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 10, paddingHorizontal: 16,
    borderTopWidth: 1, borderTopColor: D.hair2,
  },
  iosDone: {
    height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    marginTop: 10, marginBottom: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  iosDoneText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},

  // CTA
  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16.5, letterSpacing: 0.3, color: '#fff'},
}));
