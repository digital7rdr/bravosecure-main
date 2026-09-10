/**
 * Executive Protection · Step 02 — Schedule Start Time
 *
 * Book Now (immediate dispatch — the team starts as soon as an agency accepts)
 * vs Book Later (native date + time pickers with a REAL 3-hour minimum lead,
 * validated on Continue — unlike the Lite schedule screen, an out-of-window
 * pick is rejected with an inline notice and auto-corrected, never silently
 * rolled). Obsidian/cobalt palette matching the executive/Lite wizard family.
 *
 * Data layer: writes draft.mode + draft.start_time. Continue → LocationPicker
 * (service location, returns into ExecTask — Step 3 of the wizard).
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
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import type {BookingStackParamList} from '@navigation/types';
import {useBookingStore, type BookingMode} from '@store/bookingStore';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {MIN_LEAD_HOURS} from '@screens/booking/scheduleGate';
import {resolveTransferTime, transferTimeOutOfWindow} from './transferTime';

type Nav = NativeStackNavigationProp<BookingStackParamList, 'ExecSchedule'>;

const pad = (n: number) => n.toString().padStart(2, '0');

// Design tokens — obsidian/cobalt premium (mirrors the executive/Lite wizard).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentSoft: '#A9C5FF',
  amber:      '#F5C76B',
  signal:     '#4ADE80',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

/** Earliest bookable "later" start = now + lead, rounded up to 5 min. */
function earliestLater(): Date {
  const d = new Date(Date.now() + MIN_LEAD_HOURS * 3600_000);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5, 0, 0);
  return d;
}

export default function ExecScheduleScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const updateDraft = useBookingStore(st => st.updateDraft);
  const draft = useBookingStore(st => st.draft);

  // Initial value for the picker only; the BANNER recomputes per render so a
  // screen left open doesn't display a stale "earliest" time (validation
  // already uses the live clock).
  const earliest = useMemo(earliestLater, []);
  const [mode, setMode] = useState<BookingMode>(draft.mode ?? 'now');
  // Resume a previously chosen future start; otherwise the earliest slot.
  const [laterDate, setLaterDate] = useState<Date>(() => {
    const prev = draft.start_time ? new Date(draft.start_time) : null;
    return prev && !Number.isNaN(prev.getTime()) && prev.getTime() >= earliest.getTime()
      ? prev
      : earliest;
  });
  const [pickerMode, setPickerMode] = useState<'date' | 'time' | null>(null);
  const [leadError, setLeadError] = useState<string | null>(null);

  // Sliding pill for the Book Now / Book Later segmented toggle.
  const slide = useRef(new Animated.Value(mode === 'now' ? 0 : 1)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: mode === 'now' ? 0 : 1,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [mode, slide]);

  const onLaterChange = (ev: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setPickerMode(null);}
    if (d) {
      setLaterDate(d);
      setLeadError(null);
      if (pickerMode === 'date' && Platform.OS === 'android') {
        // Chain straight into the time picker.
        setTimeout(() => setPickerMode('time'), 50);
      }
    }
  };

  const handleContinue = () => {
    let start: Date;
    if (mode === 'now') {
      // Immediate dispatch — the server treats auto+now as on-demand (no lead).
      start = new Date();
    } else {
      const floor = Date.now() + MIN_LEAD_HOURS * 3600_000;
      if (laterDate.getTime() < floor) {
        // Reject + auto-correct, never silently book a different time.
        const fixed = earliestLater();
        setLaterDate(fixed);
        setLeadError(
          `Scheduled bookings need a ${MIN_LEAD_HOURS}-hour lead. Earliest start: ` +
          `${fixed.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'})} · ${pad(fixed.getHours())}:${pad(fixed.getMinutes())}.`,
        );
        return;
      }
      start = new Date(laterDate);
    }
    // A custom transfer pickup time was built against the PREVIOUS start
    // date — rebase its clock onto the new date so a reschedule can never
    // strand the transfer leg on the wrong day.
    let transferRebase: {transport_pickup_time: string} | null = null;
    if (draft.transport_pickup_time) {
      const prev = new Date(draft.transport_pickup_time);
      if (Number.isNaN(prev.getTime())) {
        transferRebase = {transport_pickup_time: ''};
      } else {
        // B-382 — rebase through the SAME day-resolver the transport screen uses.
        // A hand-rolled same-day setHours collapsed a next-day transfer (overnight
        // blocks) onto the start day, failed its own window check, and silently
        // wiped the user's chosen time.
        const rebased = resolveTransferTime(start, draft.duration_hours, prev.getHours(), prev.getMinutes());
        const ok = !transferTimeOutOfWindow(rebased.toISOString(), start, draft.duration_hours);
        transferRebase = {transport_pickup_time: ok ? rebased.toISOString() : ''};
      }
    }
    updateDraft({mode, start_time: start.toISOString(), ...transferRebase});
    // Step 3/4 — ExecTask sits BELOW the picker modal (it auto-opens the
    // picker when no location is set), so the picker's merge-navigate POPS
    // back to it — same stack shape as the Lite wizard. Navigating to the
    // picker from here instead would sandwich the modal under ExecTask and
    // every back-press would land on a stale map.
    navigation.navigate('ExecTask');
  };

  // Sliding-pill geometry — measured from the real rendered track (B-93).
  const [toggleTrackW, setToggleTrackW] = useState(0);
  const pillWidth = Math.max(0, (toggleTrackW - 12) / 2);
  const pillX = slide.interpolate({inputRange: [0, 1], outputRange: [0, pillWidth]});

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
          <Text style={s.headerTitle}>Schedule Start Time</Text>
          <FitLine style={s.headerSub} text={'EXECUTIVE PROTECTION · STEP 2 · START TIME'} />
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 160, paddingTop: 4, gap: 16}}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}>
        <Text style={s.lede}>When should your protection begin?</Text>

        {/* Mode toggle — sliding gradient pill */}
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
          <TouchableOpacity
            style={s.toggleSeg}
            onPress={() => { setMode('now'); setLeadError(null); }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{selected: mode === 'now'}}>
            <Text style={[s.toggleT, mode === 'now' && s.toggleTOn]} numberOfLines={1}>Book Now</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={s.toggleSeg}
            onPress={() => { setMode('later'); setLeadError(null); }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityState={{selected: mode === 'later'}}>
            <Text style={[s.toggleT, mode === 'later' && s.toggleTOn]} numberOfLines={1}>Book Later</Text>
          </TouchableOpacity>
        </View>

        {mode === 'now' ? (
          <View style={s.nowCard}>
            <View style={s.nowIcon}>
              <Icon name="flash" size={18} color={D.signal} />
            </View>
            <Text style={s.nowText}>
              Your protection detail is dispatched <Text style={s.nowStrong}>immediately</Text> after
              booking — the {draft.duration_hours}-hour block starts when the team goes live at your location.
            </Text>
          </View>
        ) : (
          <>
            {/* Date */}
            <View>
              <Text style={s.fieldLabel}>DATE</Text>
              <TouchableOpacity
                style={s.pickRow}
                onPress={() => setPickerMode('date')}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Choose date">
                <View style={s.pickIcon}>
                  <Icon name="calendar" size={16} color={D.accent} />
                </View>
                <Text style={s.pickText} numberOfLines={1}>
                  {laterDate.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})}
                </Text>
                <Icon name="chevron-right" size={16} color={D.textMute} />
              </TouchableOpacity>
            </View>

            {/* Start time */}
            <View>
              <Text style={s.fieldLabel}>START TIME</Text>
              <TouchableOpacity
                style={s.pickRow}
                onPress={() => setPickerMode('time')}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Choose start time">
                <View style={s.pickIcon}>
                  <Icon name="clock-outline" size={16} color={D.accent} />
                </View>
                <Text style={s.pickText} numberOfLines={1}>
                  {pad(laterDate.getHours())}:{pad(laterDate.getMinutes())}
                </Text>
                <Icon name="chevron-right" size={16} color={D.textMute} />
              </TouchableOpacity>
            </View>

            {/* Lead-time notice / error — recomputed live so a screen left
                open never shows a stale (or wrong-day) earliest time. */}
            {(() => {
              const live = earliestLater();
              const dayWord = live.getDate() === new Date().getDate() ? 'today' : 'tomorrow';
              return (
                <View style={[s.alertWarn, leadError !== null && s.alertWarnHot]}>
                  <Icon name="alert" size={18} color={D.amber} style={{marginTop: 1}} />
                  <Text style={s.alertText}>
                    {leadError ?? (
                      <>
                        <Text style={s.alertBold}>Minimum {MIN_LEAD_HOURS}-hour lead time</Text> for all
                        scheduled bookings. Earliest available time {dayWord} is{' '}
                        {pad(live.getHours())}:{pad(live.getMinutes())}.
                      </>
                    )}
                  </Text>
                </View>
              );
            })()}
          </>
        )}

        {/* Duration recap */}
        <View style={s.recap}>
          <Icon name="timer-outline" size={16} color={D.accentSoft} style={{marginTop: 1}} />
          <Text style={s.recapText}>
            Protection block: <Text style={s.recapStrong}>{draft.duration_hours} hours</Text> — change it on
            the previous step.
          </Text>
        </View>
      </ScrollView>

      {/* Native date / time pickers */}
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
        <Modal visible transparent animationType="slide" onRequestClose={() => setPickerMode(null)}>
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
        <TouchableOpacity activeOpacity={0.9} onPress={handleContinue} accessibilityRole="button">
          <LinearGradient
            colors={['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}}
            end={{x: 0, y: 1}}
            style={s.cta}>
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

  toggle: {
    flexDirection: 'row', padding: 5, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.035)', borderWidth: 1, borderColor: D.hair2,
  },
  togglePillWrap: {position: 'absolute', top: 5, bottom: 5, left: 5},
  togglePill: {
    flex: 1, borderRadius: 14, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    shadowColor: D.accent, shadowOpacity: 0.5, shadowRadius: 18, shadowOffset: {width: 0, height: 8}, elevation: 8,
  },
  toggleSeg: {flex: 1, paddingVertical: 14, paddingHorizontal: 8, alignItems: 'center'},
  toggleT: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: D.textDim},
  toggleTOn: {color: '#fff'},

  nowCard: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    padding: 14, borderRadius: 16,
    backgroundColor: 'rgba(74,222,128,0.05)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.22)',
  },
  nowIcon: {
    width: 38, height: 38, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  nowText: {flex: 1, minWidth: 0, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim},
  nowStrong: {fontFamily: D.fSemi, color: D.signal},

  fieldLabel: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700',
    letterSpacing: 1.8, color: D.textDim, marginBottom: 9, paddingLeft: 2,
  },
  pickRow: {
    minHeight: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  pickIcon: {
    width: 30, height: 30, borderRadius: 9, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
    alignItems: 'center', justifyContent: 'center',
  },
  pickText: {flex: 1, fontFamily: D.fSemi, fontSize: 14.5, letterSpacing: -0.1, color: D.text},

  alertWarn: {
    flexDirection: 'row', alignItems: 'center', gap: 11, padding: 14,
    borderRadius: 13,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.26)',
  },
  alertWarnHot: {backgroundColor: 'rgba(245,181,68,0.12)', borderColor: 'rgba(245,181,68,0.45)'},
  alertText: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textDim, lineHeight: 16},
  alertBold: {fontFamily: D.fSemi, color: D.amber},

  recap: {
    flexDirection: 'row', gap: 10, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  recapText: {flex: 1, fontFamily: D.fSans, fontSize: 11, color: D.textDim, lineHeight: 16},
  recapStrong: {fontFamily: D.fSemi, color: D.accentSoft},

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
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
