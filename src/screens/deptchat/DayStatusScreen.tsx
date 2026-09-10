/**
 * DayStatusScreen (Dept Chat v2 — Step 22, G5, PDF p.8) — lets a manager set a
 * non-check-in day status (Leave / Sick leave / Off duty / Absent) for a CPO on a
 * given day. Reached from the manager Attend root (Admin Attendance). Writes go
 * through the audited attendanceApi.setDayStatus (OrgManagerGuard server-side);
 * the original captured attendance is never overwritten (Step 6 invariant).
 */
import React, {useCallback, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity,
  Platform, Pressable, Modal } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles, isSmallPhone} from '@utils/scaling';
import {openEmployees} from '@navigation/departmentalEntry';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, orgApi, type RosterMember} from '@services/api';
import {useKeyboardLayout, useRevealOnKeyboard} from '@hooks/useKeyboardLayout';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton, ErrorState, loadErrorText, attendanceStatusMeta, useInDepartmentalShell} from './_obsidian';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type DayStatus = 'leave' | 'sick_leave' | 'emergency_leave' | 'off_duty' | 'absent' | 'mission';

// A7.3 — the six PDF statuses, in the PDF's order. dayStatusServerContract
// parses THIS array and compares it (order included) with the server DTO's
// DAY_STATUSES and the service's marker IN-lists — keep the declaration shape.
const DAY_STATUSES: DayStatus[] = ['leave', 'sick_leave', 'emergency_leave', 'off_duty', 'absent', 'mission'];

type DateMode = 'single' | 'multiple' | 'range';
const MAX_DATES = 62;

/** Inclusive local-day range expansion, hard-capped (the server's DTO caps
 *  dates[] at 62 too — a year-long fat-finger must not become 365 markers). */
const expandRange = (start: Date, end: Date): string[] => {
  const out: string[] = [];
  const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const last = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  while (d.getTime() <= last.getTime() && out.length < MAX_DATES) {
    out.push(toDayString(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
};

// Local calendar day (YYYY-MM-DD) — represents the intended day unambiguously
// regardless of timezone, rather than a full timestamp.
const toDayString = (d: Date): string => {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
};

/**
 * `embedded` — rendered as a SEGMENT of AdminAttendanceScreen rather than as
 * its own route (client review vs2 item 13: the four areas must be one
 * dashboard, not "separate disconnected areas"). The host owns the safe-area
 * inset, the status bar, the backdrop and the header, so the screen suppresses
 * its own. Defaults false, so the standalone route is byte-identical to before.
 */
export default function DayStatusScreen({embedded = false}: {embedded?: boolean} = {}) {
  const insets = useSafeAreaInsets();
  // B-84 / KB-15 — no keyboard handling existed; the bottom note input
  // was covered by the IME. kb padding shrinks the scroll area (native
  // ScrollView then keeps the focused field visible) + reveal on focus.
  const {bottomPad, overlap} = useKeyboardLayout();
  const scrollRef = useRef<ScrollView>(null);
  const revealField = useRevealOnKeyboard(scrollRef);
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();

  const [cpos, setCpos] = useState<RosterMember[]>([]);
  const [loadingCpos, setLoadingCpos] = useState(true);
  // A7.3 — one, many, or all: a checkbox SET, not a radio (PDF: "apply to one
  // Member, multiple Members, a team or department").
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<DayStatus | null>(null);
  const [dateMode, setDateMode] = useState<DateMode>('single');
  const [date, setDate] = useState<Date>(() => new Date());
  const [rangeEnd, setRangeEnd] = useState<Date>(() => new Date());
  const [multiDates, setMultiDates] = useState<string[]>([]);
  // Which control the native picker feeds: the single/multiple day, or the
  // range's end date.
  const [pickerFor, setPickerFor] = useState<'day' | 'rangeEnd' | null>(null);
  // iOS multiple-mode's spinner draft — deliberately separate from `date`.
  const [draftDay, setDraftDay] = useState<Date>(() => new Date());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  // F15 — an empty roster and a failed roster fetch used to look identical, on a
  // screen whose only job is picking someone from that roster.
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadCpos = useCallback(async () => {
    try {
      const {data} = await orgApi.listCpos();
      setCpos(data.filter(m => m.status === 'active' && m.member_role !== 'manager'));
      setLoadError(null);
    } catch (e) {
      setCpos([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoadingCpos(false);
    }
  }, []);
  // vs2 item 13 — FOCUS, not mount. The new "Add people to the roster" CTA
  // pushes the roster ON TOP of this screen, so a mount-only load left the
  // empty state (and the CTA) showing after the admin had just added someone —
  // the guided flow could never close its own loop.
  useFocusEffect(useCallback(() => { void loadCpos(); }, [loadCpos]));

  // Add-only, with a LOUD cap (silent no-op at 62 is the truncation class M6
  // banned). Removal has its own affordance — the chips below.
  const addMultiDay = (day: string) => {
    if (multiDates.includes(day)) {return;}
    if (multiDates.length >= MAX_DATES) {
      Alert.alert('Day status', `You can pick at most ${MAX_DATES} days.`);
      return;
    }
    setMultiDates(prev => [...prev, day].sort());
  };

  const onPickChange = (_ev: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setPickerFor(null);}
    if (!d) {return;}
    if (pickerFor === 'rangeEnd') {setRangeEnd(d); return;}
    if (dateMode === 'multiple') {
      // iOS's spinner fires onChange on EVERY detent — toggling here added a
      // phantom day per wheel tick (F review MEDIUM-2). iOS holds a DRAFT
      // (its own state — not `date`, which is single/range's anchor: sharing
      // it let the multiple-mode wheel silently move the range start, LOW-C)
      // and commits from the Add-day button only; Android's dialog fires once.
      if (Platform.OS === 'ios') {setDraftDay(d); return;}
      addMultiDay(toDayString(d));
      return;
    }
    setDate(d);
  };

  // Plain dismissal — the backdrop and the hardware back must NEVER mutate
  // the selection (MEDIUM-B: every exit committed a day, so the universal
  // iOS cancel gesture ADDED one and a second "Add day" press deleted it).
  const closePicker = () => setPickerFor(null);
  const commitDraftDay = () => {
    addMultiDay(toDayString(draftDay));
    setPickerFor(null);
  };

  /** Inclusive day count of the picked range BEFORE the cap — the honest
   *  number the UI must show. UTC-normalized: local-midnight arithmetic is
   *  one hour short across a spring-forward, which undercounted a 63-day
   *  range to 62 and re-opened the silent truncation (LOW-E). */
  const rangeRawCount = (): number => {
    const ms = Date.UTC(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate())
      - Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
    return Math.round(ms / 86400000) + 1;
  };

  const resolvedDates = (): string[] => {
    if (dateMode === 'multiple') {return multiDates;}
    if (dateMode === 'range') {return expandRange(date, rangeEnd);}
    return [toDayString(date)];
  };

  const toggleMember = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) {next.delete(id);} else {next.add(id);}
    return next;
  });

  const onSave = async () => {
    const dates = resolvedDates();
    if (selected.size === 0 || !status || dates.length === 0) {
      // Why: render the noun, never compare it. The old `=== 'Employee'` branch
      // silently fell through to "a CPO" for Enterprise accounts the moment
      // A7.3 renamed the label to Member (pinned by deptNoun.test.ts).
      Alert.alert('Day status', dateMode === 'range' && rangeRawCount() <= 0
        ? 'The range end is before its start.'
        : `Pick a ${deptMemberNoun()}, a status and at least one day.`);
      return;
    }
    // Refuse over-cap HERE, with the real numbers — never silently truncate
    // and never let the server bounce a fully-filled form with a raw code.
    if (dateMode === 'range' && rangeRawCount() > MAX_DATES) {
      Alert.alert('Day status', `Ranges are limited to ${MAX_DATES} days (you picked ${rangeRawCount()}).`);
      return;
    }
    if (selected.size * dates.length > 500) {
      Alert.alert('Day status',
        `${selected.size} ${deptMemberNoun(true)} × ${dates.length} days is ${selected.size * dates.length} markers — the limit is 500. Split the batch.`);
      return;
    }
    if (busy) {return;}
    setBusy(true);
    try {
      await attendanceApi.setDayStatus({
        member_ids: [...selected],
        status,
        dates,
        notes: note.trim() || undefined,
      });
      navigation.goBack();
    } catch (e: unknown) {
      Alert.alert('Day status', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, embedded ? {backgroundColor: 'transparent'} : {paddingTop: insets.top}]}>
      {!embedded && <StatusBar barStyle="light-content" backgroundColor={OB.bg} />}
      {!embedded && <AmbientBg bg={OB.bg} />}
      {!embedded && <ObHeader title="Set Day Status" onBack={() => navigation.goBack()} pill="ADMIN" />}

      <ScrollView
        ref={scrollRef}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

        {/* Status */}
        <SectionLabel>STATUS</SectionLabel>
        <View style={s.grid}>
          {DAY_STATUSES.map(st => {
            const meta = attendanceStatusMeta(st);
            const on = status === st;
            return (
              <TouchableOpacity
                key={st}
                style={[s.statCell, on && {borderColor: meta.color, backgroundColor: meta.color + '1A'}]}
                activeOpacity={0.85}
                onPress={() => setStatus(st)}>
                <Icon name={meta.icon} size={20} color={on ? meta.color : OB.textMute} />
                {/* Why flex + numberOfLines: the cell is a fixed-width row, so a
                    long label had no way to wrap or shrink and crossed the card
                    border on narrow screens and at large font scales. */}
                <Text style={[s.statText, on && {color: meta.color}]} numberOfLines={2}>{meta.label}</Text>
              </TouchableOpacity>
            );
          })}
        </View>

        {/* Day — A7.3: single date, selected dates, or an inclusive range. */}
        <View style={{marginTop: 22}}>
          <SectionLabel>DAY</SectionLabel>
          <View style={s.segRow}>
            {(['single', 'multiple', 'range'] as const).map(m => (
              <TouchableOpacity
                key={m}
                style={[s.segCell, dateMode === m && s.segCellOn]}
                activeOpacity={0.85}
                onPress={() => setDateMode(m)}>
                <Text style={[s.segText, dateMode === m && s.segTextOn]}>
                  {m === 'single' ? 'Single' : m === 'multiple' ? 'Multiple' : 'Range'}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <TouchableOpacity style={[s.dateRow, {marginTop: 10}]} activeOpacity={0.8} onPress={() => setPickerFor('day')}>
            <Icon name="calendar" size={16} color={OB.accentSoft} />
            <Text style={s.dateText}>
              {dateMode === 'multiple'
                ? (multiDates.length === 0 ? 'Add dates…' : `${multiDates.length} day${multiDates.length === 1 ? '' : 's'} selected · tap to add`)
                : date.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})}
            </Text>
            <Icon name="chevron-down" size={16} color={OB.textMute} />
          </TouchableOpacity>
          {dateMode === 'range' ? (
            <TouchableOpacity style={[s.dateRow, {marginTop: 10}]} activeOpacity={0.8} onPress={() => setPickerFor('rangeEnd')}>
              <Icon name="calendar-end" size={16} color={OB.accentSoft} />
              <Text style={[s.dateText, rangeRawCount() > MAX_DATES && {color: OB.alert}]}>
                to {rangeEnd.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'})}
                {'  ·  '}
                {rangeRawCount() > MAX_DATES
                  ? `${rangeRawCount()} days — limit is ${MAX_DATES}`
                  : `${Math.max(rangeRawCount(), 0)} day${rangeRawCount() === 1 ? '' : 's'}`}
              </Text>
              <Icon name="chevron-down" size={16} color={OB.textMute} />
            </TouchableOpacity>
          ) : null}
          {dateMode === 'multiple' && multiDates.length > 0 ? (
            <View style={s.chipWrap}>
              {multiDates.map(d => (
                <TouchableOpacity key={d} style={s.dayChip} activeOpacity={0.8}
                  onPress={() => setMultiDates(prev => prev.filter(x => x !== d))}>
                  <Text style={s.dayChipText}>{d.slice(5)}</Text>
                  <Icon name="close" size={12} color={OB.textMute} />
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </View>

        {/* Staff picker — A7.3: the heading follows the tenant's noun, same as
            ShiftEditorScreen's ASSIGN section. It used to be a hardcoded "CPO"
            sitting directly above a line that already rendered the live noun,
            so an Enterprise admin read "CPO" over "No active Members…". */}
        <View style={{marginTop: 22}}>
          <View style={s.pickerHead}>
            <SectionLabel>{deptMemberNoun(true).toUpperCase()}</SectionLabel>
            {cpos.length > 1 ? (
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={() => setSelected(prev => prev.size === cpos.length
                  ? new Set()
                  : new Set(cpos.map(m => m.member_user_id)))}>
                <Text style={s.selectAll}>
                  {selected.size === cpos.length ? 'Clear all' : 'Select all'}
                </Text>
              </TouchableOpacity>
            ) : null}
          </View>
          {loadingCpos ? (
            <LoadingView compact label="Loading day status…" />
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={() => { setLoadingCpos(true); void loadCpos(); }} />
          ) : cpos.length === 0 ? (
            // vs2 item 13 — "the user must be shown how to add a member".
            // This used to be a dead end: it stated the problem and offered no
            // way out, on the one screen that cannot work without a roster.
            <Card style={{gap: 10}}>
              <Text style={s.empty}>No active {deptMemberNoun(true)} in your roster yet.</Text>
              <GhostButton
                label="Add people to the roster"
                icon="account-plus-outline"
                onPress={() => openEmployees(navigation)}
              />
            </Card>
          ) : (
            <View style={{gap: 10}}>
              {/* Grouped by branch (org_members.department) — the PDF's "team". */}
              {[...new Set(cpos.map(m => m.department ?? ''))].sort().map(dept => (
                <View key={dept || '(none)'} style={{gap: 10}}>
                  {dept ? (
                    <View style={s.pickerHead}>
                      <Text style={s.deptHead}>{dept.toUpperCase()}</Text>
                      {/* A7.3 "apply to a team or department" — one tap selects
                          the branch (F review LOW-9: the mode existed only in
                          the API before this control). */}
                      <TouchableOpacity activeOpacity={0.8} onPress={() => {
                        const ids = cpos.filter(m => (m.department ?? '') === dept).map(m => m.member_user_id);
                        setSelected(prev => {
                          const next = new Set(prev);
                          const allOn = ids.every(id => next.has(id));
                          ids.forEach(id => allOn ? next.delete(id) : next.add(id));
                          return next;
                        });
                      }}>
                        <Text style={s.selectAll}>Select branch</Text>
                      </TouchableOpacity>
                    </View>
                  ) : null}
                  {cpos.filter(m => (m.department ?? '') === dept).map(m => {
                    const on = selected.has(m.member_user_id);
                    return (
                      <Card key={m.member_user_id} style={s.cpoCard} onPress={() => toggleMember(m.member_user_id)}>
                        <View style={[s.checkbox, on && s.checkboxOn]}>
                          {on ? <Icon name="check" size={13} color="#FFFFFF" /> : null}
                        </View>
                        <View style={{flex: 1, minWidth: 0}}>
                          <Text style={s.cpoName} numberOfLines={1}>{m.display_name ?? m.email ?? deptMemberNoun()}</Text>
                          {m.call_sign ? <Text style={s.cpoSub}>{m.call_sign}</Text> : null}
                        </View>
                      </Card>
                    );
                  })}
                </View>
              ))}
            </View>
          )}
        </View>

        {/* Note */}
        <View style={{marginTop: 22, gap: 8}}>
          <SectionLabel>NOTE (OPTIONAL)</SectionLabel>
          <TextInput
            style={s.note}
            value={note}
            onChangeText={setNote}
            placeholder="Reason or context"
            placeholderTextColor={OB.textMute}
            multiline
            onFocus={revealField}
          />
        </View>
      </ScrollView>

      {/* B-184 — the sticky footer is the bottom-most node: it owns the
          keyboard inset. Inside the departmental shell the shell already pads
          the safe area, so with the keyboard CLOSED we pad a flat 12; open,
          bottomPad replaces the inset either way. */}
      <View style={[s.footer, {paddingBottom: inDepartmentalShell && overlap === 0 ? 12 : bottomPad(12)}]}>
        <PrimaryButton label="Set Status" icon="check" busy={busy} onPress={() => { void onSave(); }} />
      </View>

      {pickerFor !== null && Platform.OS === 'android' && (
        <DateTimePicker
          value={pickerFor === 'rangeEnd' ? rangeEnd : date}
          mode="date" display="default" onChange={onPickChange} />
      )}
      {pickerFor !== null && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" visible onRequestClose={closePicker}>
          <Pressable style={s.iosBackdrop} onPress={closePicker}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker
                value={pickerFor === 'rangeEnd' ? rangeEnd
                  : dateMode === 'multiple' && pickerFor === 'day' ? draftDay : date}
                mode="date" display="spinner" textColor={OB.text} themeVariant="dark" onChange={onPickChange} />
              <PrimaryButton
                label={dateMode === 'multiple' && pickerFor === 'day' ? 'Add day' : 'Done'}
                onPress={dateMode === 'multiple' && pickerFor === 'day' ? commitDraftDay : closePicker} />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

function errMsg(e: unknown): string {
  const data = (e as {response?: {data?: {message?: string; pairs?: unknown[]}}})?.response?.data;
  // Raw server codes are honest but unreadable on a form this long — map the
  // knowable ones; anything else falls through verbatim (F review MEDIUM-3/4).
  switch (data?.message) {
    case 'session_under_correction':
      return `${data?.pairs?.length ?? 'Some'} of the selected days already have corrected records. Deselect those and try again.`;
    case 'cpo_not_active_member_of_org':
      return 'Someone you selected is no longer an active member (or is outside your branch). Refresh the roster and try again.';
    case 'day_status_batch_too_large':
      return 'That batch is over the 500-marker limit. Split it up.';
    case 'no_active_members_in_department':
      return 'That branch has no active members.';
    default:
      return data?.message ?? (e as Error)?.message ?? 'Please try again.';
  }
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 10},
  // Why the width branch: two-up leaves ~75dp for the label on a 320dp screen,
  // and the longest status ("Emergency leave") needs ~84dp once the OS font
  // scale reaches 1.3 — so it would break mid-word even with wrapping allowed.
  // One-up on small phones is the only layout where every status name fits.
  statCell: {
    width: isSmallPhone ? '100%' : '47.5%',
    flexGrow: 1, flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 15, paddingHorizontal: 14, borderRadius: 14,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
  },
  statText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 13.5, flex: 1, minWidth: 0},

  dateRow: {
    flexDirection: 'row', alignItems: 'center', gap: 10, height: 50, paddingHorizontal: 14, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  segRow: {flexDirection: 'row', gap: 8},
  segCell: {
    flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
  },
  segCellOn: {borderColor: OB.accentSoft, backgroundColor: 'rgba(91,141,239,0.12)'},
  segText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  segTextOn: {color: OB.accentSoft},
  chipWrap: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 10},
  dayChip: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: OB.hair2,
  },
  dayChipText: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12},
  pickerHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  selectAll: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  deptHead: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 11, letterSpacing: 1.2, marginTop: 4},
  checkbox: {
    width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: OB.hair2, backgroundColor: 'transparent',
  },
  checkboxOn: {backgroundColor: OB.accentSoft, borderColor: OB.accentSoft},
  dateText: {flex: 1, color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},

  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  cpoCard: {flexDirection: 'row', alignItems: 'center', gap: 12},
  cpoName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  cpoSub: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, marginTop: 2},

  note: {
    minHeight: 70, borderRadius: 12, padding: 14, color: OB.text,
    fontFamily: BravoFont.regular, fontSize: 13.5, textAlignVertical: 'top',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
  iosBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  iosCard: {backgroundColor: '#10141C', padding: 16, paddingBottom: 28, gap: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20},
}));
