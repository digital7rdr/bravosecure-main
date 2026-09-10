/**
 * Compact 12-hour time field for the booking dashboards.
 *
 * Founder call 2026-08-24 (B-646 r3): this used to open a hand-rolled scroll
 * wheel (`WheelTimePicker`). The wheel had to reimplement snapping, momentum and
 * a centre-rail highlight in JS, and each of those cost a bug — the rail sat over
 * the selected row and swallowed drags on Android, `disableIntervalMomentum`
 * threw the fling velocity away so flicks did nothing, and an unmemoised prop
 * made the column re-scroll itself on every render. The instruction was to stop
 * fighting it on every screen, so the field now opens the PLATFORM picker, which
 * owns all of that behaviour natively and is what a user already knows.
 *
 * The public API is UNCHANGED on purpose (`hour`/`minute` in and out are 0-23,
 * `onChange` still hands back a 24-hour hour, the imperative `open()` handle
 * still works), so every call site — Secure Transfer, Executive review, the
 * Android date-to-time chain — keeps working without edits.
 *
 * Android: the native clock dialog, opened IMPERATIVELY from the press gesture
 * (see androidPicker.ts for why a mounted <DateTimePicker> is a trap).
 * iOS: the native spinner in a sheet, because iOS has no modal time dialog.
 */
import React, {useState} from 'react';
import {
  Text, StyleSheet, TouchableOpacity, Modal, Pressable, Platform,
  type StyleProp, type ViewStyle,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {openAndroidTimePicker} from './androidPicker';
import {formatTime12h} from './time12h';

// Obsidian/cobalt palette — mirrors the dashboards' pick rows + iOS sheets.
const D = {
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

interface Props {
  /** 0-23. */
  hour: number;
  minute: number;
  /** Always receives a 0-23 hour. */
  onChange: (hour: number, minute: number) => void;
  /** Sheet heading on iOS, e.g. "PICK-UP TIME". */
  title?: string;
  /** Closed-field text; defaults to the 12-hour label of hour/minute. */
  displayText?: string;
  /** Prefix for the field's accessibility label. */
  accessibilityLabel?: string;
  minuteStep?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** A Date carrying only the clock time — the picker ignores the date part. */
function atTime(hour: number, minute: number): Date {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * Snap to the caller's step. The native clock has no minute interval on Android,
 * so the field enforces it — rounding the TOTAL minutes so 11:58 at a 5-minute
 * step becomes 12:00 rather than 11:60, and midnight wraps instead of
 * overflowing into hour 24.
 */
export function snapToStep(hour: number, minute: number, step: number): {hour: number; minute: number} {
  if (!Number.isFinite(step) || step <= 1) {return {hour, minute};}
  const snapped = Math.round((hour * 60 + minute) / step) * step;
  const wrapped = ((snapped % 1440) + 1440) % 1440;
  return {hour: Math.floor(wrapped / 60), minute: wrapped % 60};
}

export default function TimeDropdownField({
  hour, minute, onChange, title, displayText, accessibilityLabel, minuteStep = 5, style, testID,
}: Props) {
  const insets = useSafeAreaInsets();
  const [iosOpen, setIosOpen] = useState(false);
  const [pending, setPending] = useState(() => atTime(hour, minute));
  const label = displayText ?? formatTime12h(hour, minute);

  const commit = (h: number, m: number) => {
    const snapped = snapToStep(h, m, minuteStep);
    onChange(snapped.hour, snapped.minute);
  };

  const show = () => {
    if (Platform.OS === 'android') {
      openAndroidTimePicker({
        value: atTime(hour, minute),
        // 12-hour clock with AM/PM — B-615's rule, now the platform's own UI.
        is24Hour: false,
        onPicked: d => commit(d.getHours(), d.getMinutes()),
      });
      return;
    }
    setPending(atTime(hour, minute));
    setIosOpen(true);
  };

  const done = () => {
    setIosOpen(false);
    commit(pending.getHours(), pending.getMinutes());
  };

  return (
    <>
      <TouchableOpacity
        style={[s.field, style]}
        onPress={show}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ? `${accessibilityLabel}: ${label}` : label}
        accessibilityHint="Opens a time picker"
        testID={testID}>
        <Icon name="clock-outline" size={15} color={D.accent} />
        <Text style={s.fieldText} numberOfLines={1} ellipsizeMode="tail">{label}</Text>
        <Icon name="chevron-down" size={16} color={D.textMute} />
      </TouchableOpacity>

      {/* iOS only — Android never mounts a picker; it opens the dialog above. */}
      {Platform.OS === 'ios' && (
        <Modal visible={iosOpen} transparent animationType="slide" onRequestClose={() => setIosOpen(false)}>
          <Pressable
            style={s.backdrop}
            onPress={() => setIosOpen(false)}
            accessibilityRole="button"
            accessibilityLabel="Close time picker"
            testID={testID ? `${testID}-backdrop` : undefined}>
            <Pressable style={[s.card, {paddingBottom: Math.max(insets.bottom, 12)}]} onPress={() => {}}>
              {!!title && <Text style={s.title}>{title}</Text>}
              <DateTimePicker
                value={pending}
                mode="time"
                display="spinner"
                minuteInterval={minuteStep as 1 | 5 | 10 | 15 | 30}
                textColor={D.text}
                onChange={(ev: DateTimePickerEvent, d?: Date) => {
                  if (ev.type !== 'set' || !d) {return;}
                  setPending(d);
                }}
              />
              <TouchableOpacity
                activeOpacity={0.9}
                onPress={done}
                accessibilityRole="button"
                testID={testID ? `${testID}-done` : undefined}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}}
                  end={{x: 0, y: 1}}
                  style={s.done}>
                  <Text style={s.doneText}>Done</Text>
                </LinearGradient>
              </TouchableOpacity>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </>
  );
}

const s = StyleSheet.create({
  field: {
    minHeight: 50, borderRadius: 12, paddingHorizontal: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    flexDirection: 'row', alignItems: 'center', gap: 8,
  },
  fieldText: {flex: 1, minWidth: 0, fontFamily: D.fSemi, fontSize: 13.5, color: D.text, letterSpacing: 0.2},

  backdrop: {flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2,6,15,0.72)'},
  card: {
    backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingTop: 14, paddingHorizontal: 16, gap: 12,
    borderTopWidth: 1, borderTopColor: D.hair2,
  },
  title: {
    fontFamily: D.fMono, fontSize: 9.5, fontWeight: '700', letterSpacing: 1.8,
    color: D.textDim, paddingLeft: 2,
  },
  done: {
    height: 52, borderRadius: 16, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
  },
  doneText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
});
