/**
 * Suspend a roster member — the dialog `Alert.alert` cannot be.
 *
 * It needs a date range and a mandatory reason, and RN's Alert only renders
 * title/message/buttons. So this is a bespoke Modal that borrows the exact
 * BravoAlertHost vocabulary via `@components/ui/dialogTokens` — same card
 * gradient, medallion, backdrop and button metrics — so it reads as the same
 * design system rather than a lookalike.
 *
 * Rules mirrored from the server (OrgCpoService.resolveSuspensionWindow):
 *   · reason is REQUIRED — the CPO is shown it when they try to log back in
 *   · `until` omitted  ⇒ indefinite
 *   · `until` must be after `from`, and at most 365 days
 */
import React, {useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, Modal, Pressable, ScrollView, TextInput,
  Platform, useWindowDimensions, ActivityIndicator,
} from 'react-native';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {DIALOG, CARD_GRADIENT, FILL_GRADIENT, DIALOG_METRICS as M} from '@components/ui/dialogTokens';

const MAX_DAYS = 365;
const DAY_MS = 86_400_000;
const QUICK_PICKS = [7, 14, 30] as const;

export interface SuspendPayload {
  suspended_from: string;
  suspended_until: string | null;
  suspend_reason: string;
}

interface Props {
  visible: boolean;
  memberName: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (payload: SuspendPayload) => void;
}

function fmt(d: Date): string {
  return d.toLocaleDateString(undefined, {day: 'numeric', month: 'short', year: 'numeric'});
}

export function SuspendMemberModal({visible, memberName, busy, onCancel, onConfirm}: Props) {
  const {width, height} = useWindowDimensions();
  const [from, setFrom] = useState(() => new Date());
  const [until, setUntil] = useState<Date | null>(() => new Date(Date.now() + 7 * DAY_MS));
  const [reason, setReason] = useState('');
  const [picker, setPicker] = useState<'from' | 'until' | null>(null);

  const indefinite = until === null;

  const error = useMemo(() => {
    if (!reason.trim()) {return 'A reason is required.';}
    if (!until) {return null;}
    if (until.getTime() <= from.getTime()) {return 'The end date must be after the start date.';}
    if ((until.getTime() - from.getTime()) / DAY_MS > MAX_DAYS) {
      return 'A suspension cannot exceed 365 days — remove the member instead.';
    }
    return null;
  }, [reason, from, until]);

  const summary = useMemo(() => {
    if (!until) {return 'Indefinite — until you lift it';}
    const days = Math.max(1, Math.round((until.getTime() - from.getTime()) / DAY_MS));
    return `${days} day${days === 1 ? '' : 's'} · returns ${fmt(until)}`;
  }, [from, until]);

  const onPickChange = (_e: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setPicker(null);}
    if (!d) {return;}
    if (picker === 'from') {setFrom(d);} else if (picker === 'until') {setUntil(d);}
  };

  const submit = () => {
    if (error || busy) {return;}
    onConfirm({
      suspended_from: from.toISOString(),
      suspended_until: until ? until.toISOString() : null,
      suspend_reason: reason.trim(),
    });
  };

  return (
    <Modal visible={visible} transparent statusBarTranslucent animationType="fade" onRequestClose={onCancel}>
      <Pressable style={s.backdrop} onPress={onCancel} accessibilityLabel="Dismiss">
        <Pressable style={{width: Math.min(M.cardMaxWidth, width - 48)}}>
          <LinearGradient colors={CARD_GRADIENT} start={{x: 0, y: 0}} end={{x: 0, y: 1}} style={s.card}>
            <View style={s.medallion}>
              <Icon name="account-clock-outline" size={22} color={DIALOG.amber} />
            </View>
            <Text style={s.title} numberOfLines={2}>Suspend {memberName}?</Text>
            <Text style={s.message}>
              They will be signed out and lose access to agency chat until the suspension ends.
              They cannot be assigned to any mission while suspended.
            </Text>

            <ScrollView style={{maxHeight: Math.round(height * 0.42), alignSelf: 'stretch'}}
              showsVerticalScrollIndicator={false} bounces={false}>

              <Text style={s.label}>DURATION</Text>
              <View style={s.chipRow}>
                {QUICK_PICKS.map(d => {
                  const active = until !== null
                    && Math.round((until.getTime() - from.getTime()) / DAY_MS) === d;
                  return (
                    <Pressable key={d} onPress={() => setUntil(new Date(from.getTime() + d * DAY_MS))}
                      style={[s.chip, active && s.chipOn]}>
                      <Text style={[s.chipText, active && s.chipTextOn]}>{d} days</Text>
                    </Pressable>
                  );
                })}
                <Pressable onPress={() => setUntil(indefinite ? new Date(from.getTime() + 7 * DAY_MS) : null)}
                  style={[s.chip, indefinite && s.chipOn]}>
                  <Text style={[s.chipText, indefinite && s.chipTextOn]}>Indefinite</Text>
                </Pressable>
              </View>

              <Pressable style={s.dateRow} onPress={() => setPicker('from')}>
                <Icon name="calendar-start" size={16} color={DIALOG.onAccent} />
                <Text style={s.dateLabel}>From</Text>
                <Text style={s.dateValue}>{fmt(from)}</Text>
              </Pressable>

              {until !== null && (
                <Pressable style={s.dateRow} onPress={() => setPicker('until')}>
                  <Icon name="calendar-end" size={16} color={DIALOG.onAccent} />
                  <Text style={s.dateLabel}>Until</Text>
                  <Text style={s.dateValue}>{fmt(until)}</Text>
                </Pressable>
              )}

              <Text style={s.summary}>{summary}</Text>

              <Text style={s.label}>REASON (SHOWN TO THE OFFICER)</Text>
              <TextInput
                value={reason}
                onChangeText={setReason}
                placeholder="e.g. Equipment not returned after last detail"
                placeholderTextColor={DIALOG.textMute}
                style={s.input}
                multiline
                maxLength={280}
                accessibilityLabel="Suspension reason"
              />
              <Text style={s.counter}>{reason.length}/280</Text>

              {!!error && reason.length > 0 && <Text style={s.error}>{error}</Text>}
            </ScrollView>

            <View style={s.buttonRow}>
              <Pressable onPress={onCancel} style={[s.button, s.buttonCancel, {flex: 1}]}>
                <Text style={[s.buttonText, {color: DIALOG.textDim}]}>Cancel</Text>
              </Pressable>
              <Pressable
                onPress={submit}
                disabled={!!error || busy}
                accessibilityRole="button"
                // Stable label: the visible text is swapped for a spinner while
                // the request is in flight, so screen readers (and tests) need a
                // name that survives that swap.
                accessibilityLabel="Suspend"
                accessibilityState={{disabled: !!error || !!busy}}
                style={[s.button, s.buttonPrimary, {flex: 1}, (!!error || busy) && s.buttonDisabled]}>
                {!error && !busy && (
                  <LinearGradient colors={FILL_GRADIENT} start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                    pointerEvents="none" style={[StyleSheet.absoluteFill, {borderRadius: M.buttonRadius}]} />
                )}
                {busy
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={[s.buttonText, {color: '#fff'}]}>Suspend</Text>}
              </Pressable>
            </View>
          </LinearGradient>
        </Pressable>
      </Pressable>

      {picker && (
        <DateTimePicker
          mode="date"
          display={Platform.OS === 'ios' ? 'spinner' : 'default'}
          value={picker === 'from' ? from : (until ?? new Date())}
          minimumDate={picker === 'until' ? from : undefined}
          onChange={onPickChange}
        />
      )}
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
    backgroundColor: DIALOG.backdrop, padding: M.backdropPadding,
  },
  card: {
    borderRadius: M.cardRadius, borderWidth: 1, borderColor: DIALOG.hair2,
    paddingHorizontal: 20, paddingTop: 24, paddingBottom: 20, alignItems: 'center',
  },
  medallion: {
    width: M.medallionSize, height: M.medallionSize, borderRadius: M.medallionSize / 2,
    alignItems: 'center', justifyContent: 'center', borderWidth: 1, marginBottom: 12,
    backgroundColor: 'rgba(245,199,107,0.12)', borderColor: 'rgba(245,199,107,0.35)',
  },
  title: {color: DIALOG.text, fontSize: 16, fontWeight: '800', textAlign: 'center', marginBottom: 8},
  message: {color: DIALOG.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center', marginBottom: 12},
  label: {
    color: DIALOG.textMute, fontSize: 10, fontWeight: '800',
    letterSpacing: 1, marginTop: 12, marginBottom: 8,
  },
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: DIALOG.hair2, backgroundColor: DIALOG.glassFill,
  },
  chipOn: {borderColor: 'rgba(91,141,239,0.45)', backgroundColor: 'rgba(91,141,239,0.16)'},
  chipText: {color: DIALOG.textDim, fontSize: 12, fontWeight: '700'},
  chipTextOn: {color: DIALOG.onAccent},
  dateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
    paddingHorizontal: 12, paddingVertical: 12, borderRadius: 12,
    borderWidth: 1, borderColor: DIALOG.hair2, backgroundColor: DIALOG.glassFill,
  },
  dateLabel: {color: DIALOG.textDim, fontSize: 13, flex: 1},
  dateValue: {color: DIALOG.text, fontSize: 13, fontWeight: '700'},
  summary: {color: DIALOG.onAccent, fontSize: 12, fontWeight: '700', textAlign: 'center', marginTop: 12},
  input: {
    color: DIALOG.text, fontSize: 13, minHeight: 72, textAlignVertical: 'top',
    borderRadius: 12, borderWidth: 1, borderColor: DIALOG.hair2,
    backgroundColor: DIALOG.glassFill, padding: 12,
  },
  counter: {color: DIALOG.textMute, fontSize: 10, textAlign: 'right', marginTop: 4},
  error: {color: DIALOG.danger, fontSize: 12, marginTop: 8, textAlign: 'center'},
  buttonRow: {alignSelf: 'stretch', flexDirection: 'row', gap: 10, marginTop: 20},
  button: {
    minHeight: M.buttonMinHeight, borderRadius: M.buttonRadius, alignItems: 'center',
    justifyContent: 'center', paddingHorizontal: 12, overflow: 'hidden',
  },
  buttonCancel: {borderWidth: 1, borderColor: DIALOG.hair2, backgroundColor: DIALOG.glassFill},
  buttonPrimary: {},
  buttonDisabled: {backgroundColor: 'rgba(255,255,255,0.06)', opacity: 0.6},
  buttonText: {fontSize: 13, fontWeight: '800', letterSpacing: 0.2, textAlign: 'center'},
});
