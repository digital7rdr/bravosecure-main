/**
 * ShiftEditorScreen (Dept Chat v2 — Step 21, PDF p.5 admin-logic) — the manager
 * surface that creates a shift (department, site label, geofence centre + radius,
 * start/end window) and assigns CPOs to it. Without this nothing ever calls
 * attendanceApi.createShift/assignCpos, so myTodayShift is always null and EVERY
 * CPO check-in is blocked ("No active shift assigned"). This unblocks the whole
 * attendance loop (G2). Manager-only — reached from the manager Attend tab; the
 * server still enforces OrgManagerGuard + assertOrgScope on every route.
 *
 * Geofence centre is OPTIONAL and set by the manager ("Use current location" or
 * manual lat/lng) — there is NO background/continuous tracking (PDF p.16). A shift
 * with no centre simply skips the radius check server-side.
 */
import React, {useCallback, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity,
  Platform, Pressable, Modal, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import DateTimePicker, {type DateTimePickerEvent} from '@react-native-community/datetimepicker';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, orgApi, type RosterMember} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton, ErrorState, loadErrorText, useInDepartmentalShell} from './_obsidian';
import {openEmployees} from '@navigation/departmentalEntry';
import {getGeo, fmtWindow} from './geo';
import {validateShiftDraft} from './shiftValidation';
import {deptMemberNoun} from './deptNoun';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type Rt = RouteProp<DeptAttendStackParamList, 'ShiftEditor'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

const nextTopOfHour = (): Date => {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return d;
};

// Q6 — apply the shared time window to each selected local date. An end at or
// before the start rolls to the NEXT day (overnight shift), so a 22:00–06:00
// window means what a manager means by it.
const windowsForDates = (dates: string[], start: Date, end: Date) =>
  dates.map(d => {
    const [y, m, dd] = d.split('-').map(Number);
    const st = new Date(y, m - 1, dd, start.getHours(), start.getMinutes(), 0, 0);
    let en = new Date(y, m - 1, dd, end.getHours(), end.getMinutes(), 0, 0);
    if (en.getTime() <= st.getTime()) {en = new Date(en.getTime() + 86_400_000);}
    return {start_at: st.toISOString(), end_at: en.toISOString()};
  });

const fmtShortDate = (d: string) => {
  const [y, m, dd] = d.split('-').map(Number);
  return new Date(y, m - 1, dd).toLocaleDateString(undefined, {day: 'numeric', month: 'short'});
};

export default function ShiftEditorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  // Edit mode (PDF p.9 shift management): prefilled from the shift; Save patches
  // via updateShift (audited server-side). Assignments are managed separately.
  const routeParams = useRoute<Rt>().params;
  const editing = routeParams?.shift ?? null;
  // Q6 — multi-date create (roster calendar multi-select). Local YYYY-MM-DD;
  // the time pickers below supply the shared window, applied to every date.
  // Ignored in edit mode; >1 date replaces the weekly repeat.
  const multiDates = !editing && routeParams?.dates && routeParams.dates.length > 0
    ? routeParams.dates : null;

  const [department, setDepartment] = useState(editing?.department ?? '');
  // G-d — 1 = no repeat; 2..12 materialise weekly occurrences server-side.
  const [repeatWeeks, setRepeatWeeks] = useState(1);
  const [siteLabel, setSiteLabel] = useState(editing?.site_label ?? '');
  const [coords, setCoords] = useState<{lat: number; lng: number} | null>(
    editing?.site_lat !== null && editing?.site_lat !== undefined &&
    editing?.site_lng !== null && editing?.site_lng !== undefined
      ? {lat: editing.site_lat, lng: editing.site_lng}
      : null,
  );
  const [radius, setRadius] = useState(String(editing?.approved_radius_m ?? 150));
  const [startDate, setStartDate] = useState<Date>(() => (editing ? new Date(editing.start_at) : nextTopOfHour()));
  const [endDate, setEndDate] = useState<Date>(() =>
    editing ? new Date(editing.end_at) : new Date(nextTopOfHour().getTime() + 8 * 3600_000));
  const [picker, setPicker] = useState<{field: 'start' | 'end'; mode: 'date' | 'time'} | null>(null);

  const [cpos, setCpos] = useState<RosterMember[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // G-ab — edit mode prefills the CURRENT assignment set and diffs on save.
  // `initialAssigned` is what the server holds; add = selected−initial,
  // remove = initial−selected.
  const [initialAssigned, setInitialAssigned] = useState<Set<string>>(new Set());
  // Names for assignees who are NOT in the pickable roster (suspended,
  // promoted, out of branch) — rendered as a distinct un-checkable-back
  // section so they are visible and removable, never silently carried.
  const [assignedNames, setAssignedNames] = useState<Map<string, string | null>>(new Map());
  const [loadingCpos, setLoadingCpos] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadCpos = useCallback(async () => {
    // F15 rule (this screen missed it): a failed load must never read as
    // "no members yet" — and a failed ASSIGNMENT fetch must not discard the
    // roster that already loaded, fabricate an empty list, and walk the
    // manager into a lying "Remove everyone?" dialog (G-ab MEDIUM-1/HIGH-3).
    setLoadError(null);
    try {
      const {data} = await orgApi.listCpos();
      setCpos(data.filter(m => m.status === 'active' && m.member_role !== 'manager'));
    } catch (e) {
      setCpos([]);
      setLoadError(loadErrorText(e));
      setLoadingCpos(false);
      return;
    }
    if (editing) {
      try {
        const {data: a} = await attendanceApi.listShiftAssignments(editing.id);
        const ids = new Set(a.assignments.map(x => x.cpo_user_id));
        setInitialAssigned(ids);
        setSelected(new Set(ids));
        setAssignedNames(new Map(a.assignments.map(x => [x.cpo_user_id, x.display_name])));
      } catch (e) {
        setLoadError(loadErrorText(e));
      }
    }
    setLoadingCpos(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // vs2 item 13 — FOCUS, not mount. The new "Add people to the roster" CTA
  // pushes the roster ON TOP of this screen, so a mount-only load left the
  // empty state (and the CTA) showing after the admin had just added someone —
  // the guided flow could never close its own loop.
  useFocusEffect(useCallback(() => { void loadCpos(); }, [loadCpos]));

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  };

  const captureLocation = async () => {
    if (capturing) {return;}
    setCapturing(true);
    try {
      const geo = await getGeo();
      if (geo) {
        setCoords({lat: geo.lat, lng: geo.lng});
      } else {
        Alert.alert('Location', 'Could not read your location. Grant permission or enter coordinates manually.');
      }
    } finally {
      setCapturing(false);
    }
  };

  const onPickChange = (_ev: DateTimePickerEvent, d?: Date) => {
    if (Platform.OS === 'android') {setPicker(null);}
    if (d && picker) {
      if (picker.field === 'start') {setStartDate(d);} else {setEndDate(d);}
    }
  };

  const saveEdit = async () => {
    const body = {
      department: department.trim() || undefined,
      site_label: siteLabel.trim() || undefined,
      site_lat: coords?.lat,
      site_lng: coords?.lng,
      approved_radius_m: coords ? (Number(radius) || 150) : undefined,
      start_at: startDate.toISOString(),
      end_at: endDate.toISOString(),
    };
    await attendanceApi.updateShift(editing!.id, body);
    // G-ab — diff the assignment set; skip the round-trip when unchanged.
    const add = [...selected].filter(id => !initialAssigned.has(id));
    const remove = [...initialAssigned].filter(id => !selected.has(id));
    if (add.length > 0 || remove.length > 0) {
      await attendanceApi.patchShiftAssignments(editing!.id, {
        ...(add.length > 0 ? {add} : {}),
        ...(remove.length > 0 ? {remove} : {}),
      });
    }
  };

  const onSave = async () => {
    if (busy) {return;}
    // Edit mode must not validate against assignment state that never loaded:
    // a failed GET left initialAssigned/selected empty, and Save then fired
    // the lying "Remove everyone?" dialog over an ErrorState (G-ab NEW-3).
    if (editing && (loadError || loadingCpos)) {
      Alert.alert('Shift', 'Could not load the current assignments — retry the load before saving.');
      return;
    }
    // The latch goes up BEFORE the confirm await (G-ab NEW-4: moving the
    // check alone was a no-op — busy stayed false for the whole life of the
    // dialog, so two taps queued two confirms and the second re-fired the
    // save from an unmounted screen). Every exit path releases via finally.
    setBusy(true);
    try {
    // Q6 — in multi-date mode the pickers supply TIME only; the concrete
    // windows come from the selected dates (overnight rolls handled inside).
    const wins = multiDates ? windowsForDates(multiDates, startDate, endDate) : null;
    const draft = {
      startMs: wins ? Date.parse(wins[0].start_at) : startDate.getTime(),
      endMs: wins ? Date.parse(wins[0].end_at) : endDate.getTime(),
      selectedCount: selected.size,
      hasCoords: !!coords, radius: Number(radius) || 0,
      noun: deptMemberNoun(),
    };
    const err = validateShiftDraft(draft);
    // Create keeps the ≥1 rule; EDIT may go to zero — behind a confirm,
    // because a shift nobody is assigned to can no longer be checked into.
    // Keyed on the CODE, never message prose (LOW-3).
    if (err) {
      if (!(editing && err.code === 'assignees')) {
        Alert.alert('Shift', err.message); return;
      }
      const proceed = await new Promise<boolean>(resolve => Alert.alert(
        'Remove everyone?',
        'No one will be able to check in to this shift until someone is assigned again.',
        [
          {text: 'Cancel', style: 'cancel', onPress: () => resolve(false)},
          {text: 'Remove all', style: 'destructive', onPress: () => resolve(true)},
        ],
        // Android back / backdrop dismiss must resolve, or this closure
        // hangs forever (LOW-1). Dismiss ≡ Cancel.
        {onDismiss: () => resolve(false)},
      ));
      if (!proceed) {return;}
      // The validator returns only the FIRST failure — proceeding past the
      // assignees confirm must not swallow a LATER one (a cleared radius was
      // silently becoming 150 m — MEDIUM-5). Re-run with the confirm's
      // question answered.
      const rest = validateShiftDraft({...draft, selectedCount: 1});
      if (rest) {Alert.alert('Shift', rest.message); return;}
    }
      if (editing) {
        await saveEdit();
      } else {
        // G-d — ONE call, one server transaction: shift(s) + assignments
        // commit together, so the create-then-assign orphan window (G-ab
        // NEW-2's root) is structurally gone from this flow. repeat_weeks
        // materialises real weekly rows server-side.
        const body = {
          department: department.trim() || undefined,
          site_label: siteLabel.trim() || undefined,
          site_lat: coords?.lat,
          site_lng: coords?.lng,
          approved_radius_m: coords ? (Number(radius) || 150) : undefined,
          // Q6 — start/end always carry the FIRST window so an old server
          // (which strips `occurrences`) degrades to one real shift on the
          // first selected day, never a garbled one.
          start_at: wins ? wins[0].start_at : startDate.toISOString(),
          end_at: wins ? wins[0].end_at : endDate.toISOString(),
          cpo_user_ids: [...selected],
          ...(wins && wins.length > 1 ? {occurrences: wins} : {}),
          ...(!wins && repeatWeeks > 1 ? {repeat_weeks: repeatWeeks} : {}),
        };
        let data: {shift: unknown; occurrences: number};
        try {
          ({data} = await attendanceApi.createShift(body));
        } catch (e) {
          // A strict-validation server that predates `occurrences` refuses the
          // unknown field with a raw validator message — translate it instead
          // of showing class-validator prose (edge review MEDIUM-8).
          const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
          const txt = Array.isArray(raw) ? raw.join(' ') : raw ?? '';
          if (wins && /occurrences/.test(txt) && /should not exist|property/.test(txt)) {
            Alert.alert('Shift', 'The server needs an update before multi-day shifts work. Create single days for now.');
            return;
          }
          throw e;
        }
        if (wins && wins.length > 1 && data.occurrences < wins.length) {
          Alert.alert('Shift',
            `Only ${data.occurrences} of ${wins.length} days were created — the server needs an update for multi-day shifts.`);
        } else if (data.occurrences > 1) {
          Alert.alert('Shift', multiDates
            ? `Created ${data.occurrences} shifts, one per selected day.`
            : `Created ${data.occurrences} weekly shifts.`);
        }
      }
      navigation.goBack();
    } catch (e: unknown) {
      Alert.alert('Shift', errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const pickerValue = picker?.field === 'end' ? endDate : startDate;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title={editing ? 'Edit Shift' : 'New Shift'} onBack={() => navigation.goBack()} pill="ADMIN" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}>

        {/* Where */}
        <SectionLabel>WHERE</SectionLabel>
        <Card style={{gap: 14}}>
          <Field label="Department" value={department} onChangeText={setDepartment} placeholder="e.g. Operations" />
          <Field label="Site" value={siteLabel} onChangeText={setSiteLabel} placeholder="e.g. Main Office" />

          <View style={s.geoRow}>
            <TouchableOpacity style={s.geoBtn} activeOpacity={0.85} onPress={() => { void captureLocation(); }} disabled={capturing}>
              {capturing ? <ActivityIndicator size="small" color={OB.accentSoft} /> : <Icon name="crosshairs-gps" size={16} color={OB.accentSoft} />}
              <Text style={s.geoBtnText}>{coords ? 'Update location' : 'Use current location'}</Text>
            </TouchableOpacity>
            {coords ? (
              <TouchableOpacity onPress={() => setCoords(null)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                <Icon name="close-circle" size={18} color={OB.textMute} />
              </TouchableOpacity>
            ) : null}
          </View>
          {coords ? (
            <View style={s.coordRow}>
              <Icon name="map-marker-radius" size={14} color={OB.signal} />
              <Text style={s.coordText}>{coords.lat.toFixed(5)}, {coords.lng.toFixed(5)}</Text>
              <View style={s.radiusWrap}>
                <TextInput
                  style={s.radiusInput}
                  value={radius}
                  onChangeText={t => setRadius(t.replace(/[^0-9]/g, ''))}
                  keyboardType="number-pad"
                  maxLength={5}
                  placeholder="150"
                  placeholderTextColor={OB.textMute}
                />
                <Text style={s.radiusUnit}>m radius</Text>
              </View>
            </View>
          ) : (
            <Text style={s.hint}>Optional — sets the approved check-in radius. Without it, attendance records the time only.</Text>
          )}
        </Card>

        {/* When */}
        <View style={{marginTop: 22}}>
          <SectionLabel>{multiDates ? `WHEN · ${multiDates.length} DAYS` : 'WHEN'}</SectionLabel>
          <Card style={{gap: 12}}>
            {/* Q6 — multi-date mode: the dates came from the calendar; the
                pickers here set the shared TIME window only. */}
            {multiDates && (
              <>
                <View style={s.dateChipRow}>
                  {multiDates.map(d => (
                    <View key={d} style={s.dateChip}>
                      <Text style={s.dateChipText}>{fmtShortDate(d)}</Text>
                    </View>
                  ))}
                </View>
                <View style={s.divider} />
              </>
            )}
            <WindowRow label="Start" date={startDate} timeOnly={!!multiDates} onDate={() => setPicker({field: 'start', mode: 'date'})} onTime={() => setPicker({field: 'start', mode: 'time'})} />
            <View style={s.divider} />
            <WindowRow label="End" date={endDate} timeOnly={!!multiDates} onDate={() => setPicker({field: 'end', mode: 'date'})} onTime={() => setPicker({field: 'end', mode: 'time'})} />
            {multiDates ? (
              <Text style={s.windowSummary}>
                Same window on every selected day. An end at or before the start continues
                into the next day (equal times make a 24-hour shift).
              </Text>
            ) : (
              <Text style={s.windowSummary}>{fmtWindow(startDate.toISOString(), endDate.toISOString())}</Text>
            )}
          </Card>

          {/* G-d — weekly repeat, CREATE only (a series is materialised as N
              real rows at +7 days; editing one occurrence edits that row
              alone — series edit is deferred and stated). Hidden in multi-date
              mode — the selected dates ARE the schedule. */}
          {!editing && !multiDates && (
            <>
              <View style={{height: 14}} />
              <SectionLabel>REPEAT WEEKLY</SectionLabel>
              <Card style={s.repeatRow}>
                <TouchableOpacity style={[s.repeatChip, repeatWeeks === 1 && s.repeatOn]}
                  activeOpacity={0.8} accessibilityRole="button" accessibilityLabel="No repeat"
                  onPress={() => setRepeatWeeks(1)}>
                  <Text style={[s.repeatText, repeatWeeks === 1 && {color: OB.text}]}>Off</Text>
                </TouchableOpacity>
                {[2, 3, 4, 6, 8, 12].map(w => (
                  <TouchableOpacity key={w} style={[s.repeatChip, repeatWeeks === w && s.repeatOn]}
                    activeOpacity={0.8} accessibilityRole="button"
                    accessibilityLabel={`Repeat for ${w} weeks`}
                    onPress={() => setRepeatWeeks(w)}>
                    <Text style={[s.repeatText, repeatWeeks === w && {color: OB.text}]}>{w} wks</Text>
                  </TouchableOpacity>
                ))}
              </Card>
              {repeatWeeks > 1 && (
                <Text style={s.repeatHint}>
                  Creates {repeatWeeks} shifts, one per week, all with the assignees below.
                </Text>
              )}
            </>
          )}
        </View>

        {/* Assign — BOTH modes since G-ab: edit prefills the current set and
            diffs on save (un-assign finally exists; before this a
            mis-assignment was permanent). */}
        <View style={{marginTop: 22}}>
          <SectionLabel right={<Text style={s.count}>{selected.size} selected</Text>}>{`ASSIGN ${deptMemberNoun(true).toUpperCase()}`}</SectionLabel>
          {loadingCpos ? (
            <LoadingView compact label="Loading shift…" />
          ) : loadError ? (
            // F15 — a failed load must never read as an empty roster.
            <ErrorState message={loadError} onRetry={() => { setLoadingCpos(true); void loadCpos(); }} />
          ) : cpos.length === 0 && initialAssigned.size === 0 ? (
            // vs2 item 13 — this is THE screen the client's "must be shown how
            // to add a member to a shift" is about, and it told the admin to go
            // somewhere without saying where or taking them there.
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
              {/* G-c — per-branch bulk select (client-side over the visible
                  roster; the server's assign_department expansion serves API
                  parity). Chips render only when branches exist. */}
              {(() => {
                const branches = [...new Set(cpos.map(m => m.department).filter((d): d is string => !!d))].sort();
                if (branches.length === 0) {return null;}
                return (
                  <View style={s.branchRow}>
                    {branches.map(b => {
                      const ids = cpos.filter(m => m.department === b).map(m => m.member_user_id);
                      const allOn = ids.length > 0 && ids.every(id => selected.has(id));
                      return (
                        // A TOGGLE, not add-only: a mistaken branch tap (or a
                        // scoped manager tapping a sibling branch the server
                        // will refuse) must be one tap to undo, not one per
                        // member (edge review F2).
                        <TouchableOpacity key={b} style={[s.branchChip, allOn && s.branchChipOn]} activeOpacity={0.8}
                          accessibilityRole="button"
                          accessibilityLabel={allOn ? `Deselect everyone in ${b}` : `Select everyone in ${b}`}
                          onPress={() => setSelected(prev => {
                            const next = new Set(prev);
                            ids.forEach(id => (allOn ? next.delete(id) : next.add(id)));
                            return next;
                          })}>
                          <Icon name={allOn ? 'account-multiple-minus-outline' : 'account-multiple-plus-outline'}
                            size={13} color={OB.accentSoft} />
                          <Text style={s.branchChipText} numberOfLines={1}>{b}</Text>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                );
              })()}
              {/* Assignees NOT in the pickable roster (suspended / promoted /
                  out of branch): visible + removable, never silently carried,
                  and never re-checkable from here (G-ab MEDIUM-6 — the
                  un-assign-the-suspended case the endpoint exists for had no
                  UI). */}
              {[...initialAssigned].filter(id => !cpos.some(m => m.member_user_id === id)).map(id => {
                const on = selected.has(id);
                return (
                  <Card key={id} style={[s.cpoCard, {opacity: 0.75}]}
                    onPress={() => { if (on) {toggle(id);} }}>
                    <View style={[s.check, on && s.checkOn]}>
                      {on ? <Icon name="check" size={14} color="#FFF" /> : null}
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.cpoName} numberOfLines={1}>{assignedNames.get(id) ?? 'Former member'}</Text>
                      <Text style={s.cpoSub}>No longer on the pickable roster — uncheck to un-assign</Text>
                    </View>
                  </Card>
                );
              })}
              {cpos.map(m => {
                const on = selected.has(m.member_user_id);
                return (
                  <Card key={m.member_user_id} style={s.cpoCard} onPress={() => toggle(m.member_user_id)}>
                    <View style={[s.check, on && s.checkOn]}>
                      {on ? <Icon name="check" size={14} color="#FFF" /> : null}
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.cpoName} numberOfLines={1}>{m.display_name ?? m.email ?? deptMemberNoun()}</Text>
                      {m.call_sign ? <Text style={s.cpoSub}>{m.call_sign}</Text> : null}
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>

      <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 12 : insets.bottom + 12}]}>
        <PrimaryButton
          label={editing ? 'Save Changes' : 'Create & Assign Shift'}
          icon={editing ? 'content-save-outline' : 'calendar-plus'}
          busy={busy}
          onPress={() => { void onSave(); }}
        />
      </View>

      {/* Android: native dialog. iOS: bottom-sheet spinner with Done. */}
      {picker && Platform.OS === 'android' && (
        <DateTimePicker value={pickerValue} mode={picker.mode} is24Hour display="default" onChange={onPickChange} />
      )}
      {picker && Platform.OS === 'ios' && (
        <Modal transparent animationType="fade" visible onRequestClose={() => setPicker(null)}>
          <Pressable style={s.iosBackdrop} onPress={() => setPicker(null)}>
            <Pressable style={s.iosCard} onPress={() => {}}>
              <DateTimePicker value={pickerValue} mode={picker.mode} is24Hour display="spinner" textColor={OB.text} themeVariant="dark" onChange={onPickChange} />
              <PrimaryButton label="Done" onPress={() => setPicker(null)} />
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

function Field({label, value, onChangeText, placeholder}: {
  label: string; value: string; onChangeText: (t: string) => void; placeholder: string;
}) {
  return (
    <View style={{gap: 6}}>
      <Text style={s.fieldLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={OB.textMute}
      />
    </View>
  );
}

function WindowRow({label, date, onDate, onTime, timeOnly}: {
  label: string; date: Date; onDate: () => void; onTime: () => void; timeOnly?: boolean;
}) {
  return (
    <View style={s.winRow}>
      <Text style={s.winLabel}>{label}</Text>
      <View style={s.winBtns}>
        {/* Q6 — multi-date mode hides the date chip: the dates are fixed by
            the calendar selection, only the time window is editable here. */}
        {!timeOnly && (
          <Chip icon="calendar" text={date.toLocaleDateString(undefined, {day: '2-digit', month: 'short'})} onPress={onDate} />
        )}
        <Chip icon="clock-outline" text={date.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})} onPress={onTime} />
      </View>
    </View>
  );
}

function Chip({icon, text, onPress}: {icon: IconName; text: string; onPress: () => void}) {
  return (
    <TouchableOpacity style={s.chip} activeOpacity={0.8} onPress={onPress}>
      <Icon name={icon} size={14} color={OB.accentSoft} />
      <Text style={s.chipText}>{text}</Text>
    </TouchableOpacity>
  );
}

function errMsg(e: unknown): string {
  const data = (e as {response?: {data?: {message?: string; member_ids?: string[]}}})?.response?.data;
  switch (data?.message) {
    case 'cpo_not_active_member_of_org':
      return `${data?.member_ids?.length ?? 'Some'} selected member(s) can’t be assigned — inactive, or outside your branch. Deselect them and try again.`;
    case 'shift_not_found_in_org':
      return 'This shift isn’t in your branch (or was removed).';
    case 'roster_month_archived':
      return 'This shift (or one of its weekly repeats) lands in an ARCHIVED roster month, where no one could ever see it. Un-archive isn’t possible — pick different dates.';
    case 'invalid_shift_window':
      return 'The end time must be after the start time.';
    default:
      return data?.message ?? (e as Error)?.message ?? 'Please try again.';
  }
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  fieldLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9.5, letterSpacing: 1.2, textTransform: 'uppercase'},
  input: {
    height: 46, borderRadius: 12, paddingHorizontal: 14, color: OB.text,
    fontFamily: BravoFont.semiBold, fontSize: 14,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },

  geoRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  geoBtn: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 12,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)',
  },
  geoBtnText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 13},
  coordRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  coordText: {color: OB.text, fontFamily: BravoFont.mono, fontSize: 12, flex: 1},
  radiusWrap: {flexDirection: 'row', alignItems: 'center', gap: 6},
  radiusInput: {
    width: 56, height: 36, borderRadius: 9, paddingHorizontal: 8, textAlign: 'center', color: OB.text,
    fontFamily: BravoFont.bold, fontSize: 13, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: OB.hair2,
  },
  radiusUnit: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5},
  hint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, lineHeight: 16},

  divider: {height: 1, backgroundColor: OB.hair},
  winRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  winLabel: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 14},
  winBtns: {flexDirection: 'row', gap: 8},
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, height: 36, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  chipText: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  windowSummary: {color: OB.accentSoft, fontFamily: BravoFont.mono, fontSize: 11, marginTop: 2},

  count: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 12},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  cpoCard: {flexDirection: 'row', alignItems: 'center', gap: 12},
  check: {
    width: 24, height: 24, borderRadius: 7, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: OB.hair2, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  checkOn: {backgroundColor: OB.accent, borderColor: OB.accent},
  cpoName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  cpoSub: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10.5, marginTop: 2},
  repeatRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  repeatChip: {paddingVertical: 7, paddingHorizontal: 13, borderRadius: 16, borderWidth: 1, borderColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  repeatOn: {borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12'},
  repeatText: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 12},
  repeatHint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 8, lineHeight: 16},
  branchRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  branchChip: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 11, borderRadius: 14, borderWidth: 1, borderColor: OB.accent + '33', backgroundColor: OB.accent + '0D', maxWidth: 180},
  branchChipOn: {borderColor: OB.accent + '66', backgroundColor: OB.accent + '1F'},
  branchChipText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  dateChipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  dateChip: {paddingVertical: 5, paddingHorizontal: 10, borderRadius: 12, borderWidth: 1, borderColor: OB.accent + '4D', backgroundColor: OB.accent + '14'},
  dateChipText: {color: OB.accentSoft, fontFamily: BravoFont.semiBold, fontSize: 11.5},

  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },

  iosBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end'},
  iosCard: {backgroundColor: '#10141C', padding: 16, paddingBottom: 28, gap: 12, borderTopLeftRadius: 20, borderTopRightRadius: 20},
}));
