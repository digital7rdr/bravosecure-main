/**
 * Executive Protection · Step 05 — Transport Support (optional)
 *
 * "Do you need secure transfers as part of this booking?" — a toggle adds a
 * secure-transfer leg (one-way / return / both-ways) with its own pickup and
 * drop-off (inherited LocationPicker, merge-param round trip), a pickup time
 * that defaults to the booking start, and a passenger count (1 vehicle per 3
 * passengers — CPO and driver occupy 1 seat each).
 *
 * Data: draft.transport_mode/_pickup/_dropoff/_pickup_time + passengers.
 * Toggling OFF zeroes vehicles + driver_only (they only exist with a leg).
 * Continue → ExecTeam.
 */
import React, {useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar,
  Platform, Modal, Pressable, Switch,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import FitLine from '@components/ui/FitLine';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {openAndroidTimePicker} from '@components/booking/androidPicker';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore} from '@store/bookingStore';
import {vehiclesForPassengers, maxCposForClientVehicle} from '@screens/booking/pricing';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {resolveTransferTime, transferTimeOutOfWindow} from './transferTime';
import {EXEC_TRANSPORT_MODES, type ExecTransportMode} from './executiveProduct';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ExecTransport'>;
type Rt  = RouteProp<BookingStackParamList, 'ExecTransport'>;

const pad = (n: number) => n.toString().padStart(2, '0');

const MODE_LABELS: Record<ExecTransportMode, string> = {
  one_way: 'One Way',
  return: 'Return',
  both_ways: 'Both Ways',
};

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

function LocationRow({label, address, placeholder, filled, onPress}: {
  label: string; address?: string; placeholder: string; filled: boolean; onPress: () => void;
}) {
  return (
    <View>
      <Text style={s.fieldLabel}>{label}</Text>
      <TouchableOpacity
        style={[s.locRow, filled ? s.locRowFilled : s.locRowIdle]}
        onPress={onPress}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={filled ? `${label}: ${address}. Edit` : placeholder}>
        <View style={[s.locPin, filled ? s.locPinFilled : s.locPinIdle]}>
          <Icon name={filled ? 'map-marker' : 'map-marker-outline'} size={16} color={filled ? D.accent : D.textMute} />
        </View>
        <Text style={[s.locText, filled ? s.locTextFilled : s.locTextPlaceholder]} numberOfLines={2}>
          {filled ? address : placeholder}
        </Text>
        <Icon name="chevron-right" size={16} color={D.textMute} />
      </TouchableOpacity>
    </View>
  );
}

export default function ExecTransportScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const route = useRoute<Rt>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);

  const enabled = draft.transport_mode !== 'none';
  const [timePicker, setTimePicker] = useState(false);

  // Booking start — the default (and floor reference) for the transfer pickup.
  const startDate = draft.start_time ? new Date(draft.start_time) : new Date();
  const startLabel = `${pad(startDate.getHours())}:${pad(startDate.getMinutes())}`;

  // ── Drain the LocationPicker's merge-params into the transport legs ──
  useEffect(() => {
    const p = route.params;
    if (!p?.pickedAt || typeof p.pickedLat !== 'number' || typeof p.pickedLng !== 'number') {return;}
    const loc = {
      address: p.pickedAddress ?? 'Selected location',
      latitude: p.pickedLat,
      longitude: p.pickedLng,
    };
    if (p.pickedKind === 'pickup') {
      updateDraft({transport_pickup: {...loc, label: 'Transfer pick-up'}});
    } else if (p.pickedKind === 'dropoff') {
      updateDraft({transport_dropoff: {...loc, label: 'Transfer drop-off'}});
    }
    navigation.setParams({
      pickedAt: undefined,
      pickedAddress: undefined,
      pickedLat: undefined,
      pickedLng: undefined,
      pickedKind: undefined,
    } as never);
  }, [route.params, navigation, updateDraft]);

  const openPicker = (kind: 'pickup' | 'dropoff') => {
    const current = kind === 'pickup' ? draft.transport_pickup : draft.transport_dropoff;
    // Fall back to the service location so the map opens in the right area.
    const init = current ?? draft.pickup;
    navigation.navigate('LocationPicker', {
      kind,
      countryCode: draft.zone_code || 'AE',
      initial: init ? {latitude: init.latitude, longitude: init.longitude, address: init.address} : undefined,
      onPickRouteKey: 'ExecTransport',
    });
  };

  const setEnabled = (on: boolean) => {
    if (on) {
      updateDraft({
        transport_mode: 'one_way',
        // Vehicles exist only with a transfer leg — seed the pax-driven floor.
        vehicle_count: Math.max(1, vehiclesForPassengers(draft.passengers)),
      });
    } else {
      updateDraft({
        transport_mode: 'none',
        vehicle_count: 0,
        driver_only: false,
      });
    }
  };

  const setPassengers = (n: number) => {
    const passengers = Math.max(1, Math.min(12, n));
    updateDraft({
      passengers,
      // Auto-size to the pax floor — Team & Add-ons (the NEXT step) is where
      // extras are added, so resizing here must not ratchet a stale count up
      // or leave a too-small one behind.
      vehicle_count: draft.driver_only ? 0 : Math.max(1, vehiclesForPassengers(passengers)),
      // Driver-only shares the client's car: fewer free seats when the party
      // grows. Re-clamp so the Team step (and the server) never see a team
      // that physically can't board — the quote must equal the charge.
      ...(draft.driver_only
        ? {cpo_count: Math.max(1, Math.min(draft.cpo_count, maxCposForClientVehicle(passengers)))}
        : null),
    });
  };

  // B-382 — day-resolution + window gate live in transferTime.ts (pure, pinned
  // by the booking Jest project). The picker only chooses a clock time; the
  // resolver picks the in-window day so overnight blocks can express next-day
  // transfers (previously a raw 400 at the LAST wizard step).
  const durationH = draft.duration_hours || 3;

  const commitTime = (d: Date) => {
    updateDraft({transport_pickup_time:
      resolveTransferTime(startDate, durationH, d.getHours(), d.getMinutes()).toISOString()});
  };

  // iOS spinner only — Android goes through openTime() below.
  const onTimeChange = (ev: DateTimePickerEvent, d?: Date) => {
    if (ev.type === 'set' && d) {commitTime(d);}
  };

  // Android opens the native dialog IMPERATIVELY from the gesture; a declarative
  // mount re-opens and resets it on every re-render (see androidPicker.ts).
  const openTime = () => {
    if (Platform.OS !== 'android') {setTimePicker(true); return;}
    openAndroidTimePicker({
      value: draft.transport_pickup_time ? new Date(draft.transport_pickup_time) : startDate,
      is24Hour: true,
      onPicked: commitTime,
    });
  };

  const transferOutOfWindow = enabled && !!draft.transport_pickup_time
    && transferTimeOutOfWindow(draft.transport_pickup_time, startDate, durationH);

  const legsMissing = enabled && (!draft.transport_pickup || !draft.transport_dropoff);
  const canContinue = !legsMissing && !transferOutOfWindow;

  const handleContinue = () => {
    if (!canContinue) {return;}
    navigation.navigate('ExecTeam');
  };

  const transferTimeLabel = draft.transport_pickup_time
    ? (() => {
        const t = new Date(draft.transport_pickup_time);
        const dayDelta = Math.round(
          (new Date(t).setHours(0, 0, 0, 0) - new Date(startDate).setHours(0, 0, 0, 0)) / 86_400_000);
        const daySuffix = dayDelta === 1 ? ' (next day)' : dayDelta === -1 ? ' (day before)' : '';
        return `${pad(t.getHours())}:${pad(t.getMinutes())}${daySuffix}`;
      })()
    : `Same as start time (${startLabel})`;

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
          <Text style={s.headerTitle}>Transport Support</Text>
          <FitLine style={s.headerSub} text={'EXECUTIVE PROTECTION · STEP 5 · OPTIONAL'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4, gap: 16}}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <Text style={s.lede}>Do you need secure transfers as part of this booking?</Text>

        {/* Toggle card */}
        <View style={s.toggleCard}>
          <View style={s.toggleIcon}>
            <Icon name="car-estate" size={18} color={D.accentSoft} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.toggleTitle}>Add Secure Transfer</Text>
            <Text style={s.toggleSub}>to this booking</Text>
          </View>
          <Switch
            value={enabled}
            onValueChange={setEnabled}
            trackColor={{false: 'rgba(255,255,255,0.12)', true: D.accentDeep}}
            thumbColor={enabled ? D.accentSoft : '#8B93A5'}
            accessibilityLabel="Add secure transfer to this booking"
          />
        </View>

        {!enabled ? (
          <View style={s.optionalCard}>
            <View style={s.optionalIcon}>
              <Icon name="information-outline" size={16} color={D.accentSoft} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.optionalTitle}>Transport is optional</Text>
              <Text style={s.optionalText}>
                Add transfers if required. You can continue without adding transport — your
                protection detail operates at the service location.
              </Text>
            </View>
          </View>
        ) : (
          <>
            {/* Transfer type */}
            <View>
              <Text style={s.fieldLabel}>TRANSFER TYPE</Text>
              <View style={s.modeRow}>
                {EXEC_TRANSPORT_MODES.map(m => {
                  const on = draft.transport_mode === m;
                  return (
                    <TouchableOpacity
                      key={m}
                      style={[s.modeChip, on ? s.modeChipOn : s.modeChipIdle]}
                      onPress={() => updateDraft({transport_mode: m})}
                      activeOpacity={0.85}
                      accessibilityRole="button"
                      accessibilityState={{selected: on}}>
                      <Text style={[s.modeChipText, on && s.modeChipTextOn]}>
                        {MODE_LABELS[m]}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>

            <LocationRow
              label="PICKUP LOCATION"
              address={draft.transport_pickup?.address}
              placeholder="Search or enter pickup location…"
              filled={!!draft.transport_pickup}
              onPress={() => openPicker('pickup')}
            />
            <LocationRow
              label="DROP-OFF LOCATION"
              address={draft.transport_dropoff?.address}
              placeholder="Search or enter drop-off location…"
              filled={!!draft.transport_dropoff}
              onPress={() => openPicker('dropoff')}
            />

            {legsMissing && (
              <Text style={s.gateHint}>
                {!draft.transport_pickup
                  ? 'Add the transfer pickup location to continue.'
                  : 'Add the transfer drop-off location to continue.'}
              </Text>
            )}

            {/* Pickup time */}
            <View>
              <Text style={s.fieldLabel}>PICKUP TIME</Text>
              <View style={s.timeRow}>
                <TouchableOpacity
                  style={s.timeBtn}
                  onPress={openTime}
                  activeOpacity={0.8}
                  accessibilityRole="button"
                  accessibilityLabel={`Transfer pickup time: ${transferTimeLabel}`}>
                  <Icon name="clock-outline" size={15} color={D.accent} />
                  <Text style={s.timeBtnText} numberOfLines={1}>{transferTimeLabel}</Text>
                </TouchableOpacity>
                {!!draft.transport_pickup_time && (
                  <TouchableOpacity
                    style={s.timeReset}
                    onPress={() => updateDraft({transport_pickup_time: ''})}
                    activeOpacity={0.8}
                    accessibilityRole="button"
                    accessibilityLabel="Reset to same as start time">
                    <Icon name="restore" size={16} color={D.textMute} />
                  </TouchableOpacity>
                )}
              </View>
              {transferOutOfWindow && (
                <Text style={s.gateHint}>
                  The transfer must fall between 2 hours before the start and the end of the
                  protection block. Pick a time inside that window (or reset to the start time).
                </Text>
              )}
            </View>

            {/* Passengers */}
            <View>
              <Text style={s.fieldLabel}>NUMBER OF PASSENGERS</Text>
              <View style={s.counter}>
                <View style={s.counterLeft}>
                  <View style={s.counterIcon}>
                    <Icon name="account" size={17} color={D.accent} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={s.counterLabel} numberOfLines={2}>Passengers</Text>
                    <Text style={s.counterSub} numberOfLines={2}>Excluding CPO and driver</Text>
                  </View>
                </View>
                <View style={s.counterCtrl}>
                  <TouchableOpacity
                    style={s.counterBtn}
                    onPress={() => setPassengers(draft.passengers - 1)}
                    activeOpacity={0.7}
                    accessibilityRole="button"
                    accessibilityLabel="Remove passenger"
                    hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                    <Icon name="minus" size={16} color={D.textDim} />
                  </TouchableOpacity>
                  <Text style={s.counterVal}>{draft.passengers}</Text>
                  <TouchableOpacity
                    onPress={() => setPassengers(draft.passengers + 1)}
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
          </>
        )}

        <View style={s.hint}>
          <Icon name="car-multiple" size={16} color={D.accentSoft} style={{marginTop: 1}} />
          <Text style={s.hintText}>
            Each vehicle carries up to 3 passengers (CPO and driver occupy 1 seat each).{' '}
            {enabled && !draft.driver_only && draft.passengers > 3 && (
              <Text style={s.hintStrong}>
                {vehiclesForPassengers(draft.passengers)} vehicles will be assigned — adjust on the next step.
              </Text>
            )}
            {enabled && draft.driver_only && (
              <Text style={s.hintStrong}>
                Driver only: your own vehicle — no Bravo vehicles are assigned.
              </Text>
            )}
          </Text>
        </View>
      </ScrollView>

      {/* Native time picker. Android has no mount here on purpose: openTime()
          opens the dialog imperatively so a re-render cannot re-open and reset it. */}
      {Platform.OS === 'ios' && timePicker && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setTimePicker(false)}>
          <Pressable style={s.iosBackdrop} onPress={() => setTimePicker(false)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker
                value={draft.transport_pickup_time ? new Date(draft.transport_pickup_time) : startDate}
                mode="time"
                is24Hour
                display="spinner"
                textColor={D.text}
                onChange={onTimeChange}
              />
              <TouchableOpacity activeOpacity={0.9} onPress={() => setTimePicker(false)}>
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
          onPress={handleContinue}
          accessibilityRole="button"
          accessibilityState={{disabled: !canContinue}}>
          <LinearGradient
            colors={canContinue ? ['#6E9BF5', D.accent, D.accentDeep] : ['#27324A', '#1C2436']}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={[s.cta, !canContinue && s.ctaDisabled]}>
            <Text style={s.ctaText}>Continue</Text>
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

  toggleCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(16,26,46,0.6)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.22)',
  },
  toggleIcon: {
    width: 38, height: 38, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  toggleTitle: {fontFamily: D.fBold, fontSize: 14.5, letterSpacing: -0.2, color: D.text},
  toggleSub: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 2},

  optionalCard: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12,
    padding: 16, borderRadius: 16,
    borderWidth: 1, borderColor: D.hair2, borderStyle: 'dashed',
    backgroundColor: 'rgba(255,255,255,0.015)',
  },
  optionalIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  optionalTitle: {fontFamily: D.fSemi, fontSize: 13.5, color: D.text},
  optionalText: {fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textMute, marginTop: 4},

  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },

  modeRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  modeChip: {
    flexGrow: 1, flexBasis: '28%', minHeight: 44,
    borderRadius: 12, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10,
  },
  modeChipIdle: {backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  modeChipOn: {
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.5)',
  },
  modeChipText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},
  modeChipTextOn: {color: D.text},

  locRow: {
    minHeight: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 8,
  },
  locRowFilled: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locRowIdle: {backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair},
  locPin: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  locPinFilled: {backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  locPinIdle: {backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2},
  locText: {flex: 1, minWidth: 0, fontSize: 13.5, letterSpacing: -0.1, lineHeight: 18},
  locTextFilled: {fontFamily: D.fSemi, color: D.text},
  locTextPlaceholder: {fontFamily: D.fSans, color: D.textFaint},

  timeRow: {flexDirection: 'row', gap: 10, alignItems: 'center'},
  timeBtn: {
    flex: 1, minHeight: 50, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    flexDirection: 'row', alignItems: 'center', gap: 8, justifyContent: 'center', paddingHorizontal: 12,
  },
  timeBtnText: {fontFamily: D.fSemi, fontSize: 12.5, color: D.text, letterSpacing: 0.2},
  timeReset: {
    width: 44, height: 50, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },

  counter: {
    minHeight: 60, paddingVertical: 10, borderRadius: 16, flexDirection: 'row', alignItems: 'center',
    justifyContent: 'space-between', paddingLeft: 14, paddingRight: 12,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
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
  counterVal: {width: 34, textAlign: 'center', fontFamily: D.fBold, fontSize: 20, color: D.text},

  hint: {
    flexDirection: 'row', gap: 10, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  hintText: {flex: 1, fontFamily: D.fSans, fontSize: 11, color: D.textDim, lineHeight: 16},
  hintStrong: {fontFamily: D.fSemi, color: D.accentSoft},
  gateHint: {fontFamily: D.fSans, fontSize: 11.5, color: D.amber, textAlign: 'center', marginTop: 2},

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

  ctaWrap: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 28},
  cta: {
    minHeight: 58, borderRadius: 18,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 24, shadowOffset: {width: 0, height: 14}, elevation: 10,
  },
  ctaDisabled: {borderColor: D.hair2, shadowOpacity: 0, elevation: 0},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
