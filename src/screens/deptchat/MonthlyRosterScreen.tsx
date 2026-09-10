import React, {useCallback, useMemo, useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {attendanceApi, type RosterMonthDto, type RosterConflictDto, type ShiftDto} from '@services/api';
import type {DeptAttendStackParamList} from '@navigation/types';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton, ErrorState, loadErrorText, useInDepartmentalShell} from './_obsidian';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type Rt = RouteProp<DeptAttendStackParamList, 'MonthlyRoster'>;

/**
 * A7.2 (B2) — the manager's monthly roster calendar.
 *
 * Draft / Published / Amended / Archived states with conflict flagging before
 * publish. The calendar NEVER mutates shifts — a day tap goes to
 * ShiftManagement, which owns creation/editing. And the month row is created
 * ONLY by the explicit "Start planning" tap: a focus handler fires on every
 * back-swipe, so ensuring on focus would mint phantom draft months through the
 * POST and defeat the B1 verb split.
 */

const monthKeyOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number);
  return monthKeyOf(new Date(y, m - 1 + delta, 1));
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {month: 'long', year: 'numeric'});
}

const fmtDayTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'});

const STATE_META: Record<RosterMonthDto['status'], {label: string; tint: string; body: string}> = {
  draft:     {label: 'DRAFT', tint: '#E8B34B', body: 'Not visible to your team until you publish.'},
  published: {label: 'PUBLISHED', tint: '#39C27C', body: 'Live — your team sees these shifts.'},
  amended:   {label: 'AMENDED', tint: '#39C27C', body: 'Live, with changes published after the first release.'},
  archived:  {label: 'ARCHIVED', tint: '#8B93A7', body: 'Read-only. This month is closed.'},
};

/**
 * `embedded` — rendered as a SEGMENT of AdminAttendanceScreen rather than as
 * its own route (client review vs2 item 13: the four areas must be one
 * dashboard, not "separate disconnected areas"). The host owns the safe-area
 * inset, the status bar, the backdrop and the header, so the screen suppresses
 * its own. Defaults false, so the standalone route is byte-identical to before.
 */
export default function MonthlyRosterScreen({embedded = false, onOpenShifts}: {embedded?: boolean; onOpenShifts?: () => void} = {}) {
  const insets = useSafeAreaInsets();
  const inDepartmentalShell = useInDepartmentalShell();
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();

  const [monthKey, setMonthKey] = useState(params?.month ?? monthKeyOf(new Date()));
  const [monthRow, setMonthRow] = useState<RosterMonthDto | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [shifts, setShifts] = useState<ShiftDto[]>([]);
  const [conflicts, setConflicts] = useState<RosterConflictDto[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | 'plan' | 'publish' | 'force' | 'archive'>(null);
  // Set when a publish came back {ok:false} — the inline blocking-conflict list
  // with the destructive override.
  const [publishBlock, setPublishBlock] = useState<RosterConflictDto[] | null>(null);
  // Q6 — multi-day plan mode: non-null = selecting; day taps toggle membership
  // instead of navigating. "Plan shift" hands the chosen dates to ShiftEditor,
  // which creates one shift per date in one server transaction.
  const [multiDays, setMultiDays] = useState<Set<number> | null>(null);

  // Stale-response guard: month switches race their loads, and whichever
  // response resolved LAST used to win — month A's status/conflicts could
  // render under month B's title, one card above a Publish button that
  // targets B (edge review, round 1). Every await checks it still speaks for
  // the newest request before touching state.
  const reqRef = useRef(0);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    // Cross-month leftovers die FIRST: a failed conflicts fetch used to keep
    // the previous month's "double-booked" list on screen (critic, round 1),
    // and a stale publishBlock offered a force-publish over shifts the manager
    // had since fixed.
    setConflicts([]);
    setPublishBlock(null);
    try {
      // READ only — the GET never writes (B1). listShifts is branch-forced
      // server-side; the month filter is by OVERLAP below so overnight shifts
      // appear in both months they touch.
      const [mo, sh] = await Promise.all([
        attendanceApi.rosterMonth(monthKey),
        attendanceApi.listShifts(),
      ]);
      if (req !== reqRef.current) {return;}
      setMonthRow(mo.data.month);
      setShifts(sh.data ?? []);
      setLoadError(null);
      if (mo.data.month) {
        try {
          const {data} = await attendanceApi.rosterConflicts(mo.data.month.id);
          if (req !== reqRef.current) {return;}
          setConflicts(data.conflicts ?? []);
        } catch { /* the pre-publish warning degrades to ABSENT; publish still checks */ }
      }
    } catch (e) {
      if (req !== reqRef.current) {return;}
      setLoadError(loadErrorText(e));
      // 404 = the whole roster controller sits behind DeptChatV2Guard —
      // override the generic copy with the honest one.
      const status = (e as {response?: {status?: number}})?.response?.status;
      if (status === 404) {setLoadError("This feature isn't enabled for your workspace yet.");}
    } finally {
      // Guarded too: a superseded request's finally must not flip `loaded`
      // while the newest one is still in flight (stale row under a new title).
      if (req === reqRef.current) {setLoaded(true);}
    }
  }, [monthKey]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const startPlanning = useCallback(async () => {
    if (busy) {return;}
    setBusy('plan');
    try {
      const {data} = await attendanceApi.ensureRosterMonth(monthKey);
      setMonthRow(data.month);
    } catch {
      Alert.alert('Could not start planning', 'Please check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }, [busy, monthKey]);

  const publish = useCallback(async (force: boolean) => {
    if (busy) {return;}
    setBusy(force ? 'force' : 'publish');
    try {
      const {data} = await attendanceApi.publishRosterMonth(monthKey, force || undefined);
      if (data.ok) {
        setMonthRow(data.month);
        setPublishBlock(null);
        setConflicts(data.conflicts ?? []);
      } else {
        setPublishBlock(data.conflicts ?? []);
      }
    } catch (e) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Could not publish',
        msg === 'roster_month_archived'
          ? 'This month is archived and can no longer change.'
          : 'Please check your connection and try again.');
    } finally {
      setBusy(null);
    }
  }, [busy, monthKey]);

  const archive = useCallback(() => {
    Alert.alert('Archive this month?',
      'The roster becomes read-only. Members keep seeing published shifts; nothing new can be published for this month.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Archive', style: 'destructive', onPress: () => {
          void (async () => {
            if (busy) {return;}
            setBusy('archive');
            try {
              const {data} = await attendanceApi.archiveRosterMonth(monthKey);
              setMonthRow(data.month);
              setPublishBlock(null);
            } catch {
              Alert.alert('Could not archive', 'Please check your connection and try again.');
            } finally {
              setBusy(null);
            }
          })();
        }},
      ]);
  }, [busy, monthKey]);

  // Calendar grid: weeks of 7, per-day count of OVERLAPPING, unarchived shifts.
  //
  // LOCAL day boundaries, deliberately: the manager plans in their own wall
  // clock. The server's month bucket and conflict scan are UTC (documented in
  // roster.service.ts), so a shift within a few hours of the month edge can
  // sit in the grid of one month and the conflicts list of its neighbour —
  // display drift only; publish always re-checks server-side.
  const grid = useMemo(() => {
    const [y, m] = monthKey.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const firstWeekday = new Date(y, m - 1, 1).getDay();
    const monthStart = new Date(y, m - 1, 1).getTime();
    const monthEnd = new Date(y, m, 1).getTime();
    const inMonth = shifts.filter(sh => !sh.archived_at
      && new Date(sh.start_at).getTime() < monthEnd
      && new Date(sh.end_at).getTime() > monthStart);
    const counts = Array.from({length: daysInMonth}, (_, i) => {
      const dayStart = new Date(y, m - 1, i + 1).getTime();
      const dayEnd = new Date(y, m - 1, i + 2).getTime();
      return inMonth.filter(sh =>
        new Date(sh.start_at).getTime() < dayEnd && new Date(sh.end_at).getTime() > dayStart).length;
    });
    const cells: Array<{day: number; count: number} | null> = [
      ...Array.from({length: firstWeekday}, () => null),
      ...counts.map((count, i) => ({day: i + 1, count})),
    ];
    while (cells.length % 7 !== 0) {cells.push(null);}
    const weeks: Array<Array<{day: number; count: number} | null>> = [];
    for (let i = 0; i < cells.length; i += 7) {weeks.push(cells.slice(i, i + 7));}
    return {weeks, shiftCount: inMonth.length};
  }, [monthKey, shifts]);

  const state = monthRow ? STATE_META[monthRow.status] : null;
  const live = monthRow?.status === 'published' || monthRow?.status === 'amended';

  return (
    <View style={[s.root, embedded ? {backgroundColor: 'transparent'} : {paddingTop: insets.top}]}>
      {!embedded && <StatusBar barStyle="light-content" backgroundColor={OB.bg} />}
      {!embedded && <AmbientBg bg={OB.bg} />}
      {!embedded && <ObHeader title="Monthly roster" onBack={() => navigation.goBack()}
        pill={state?.label ?? 'PLAN'} pillTone={monthRow?.status === 'draft' ? 'warn' : live ? 'good' : 'default'} />}

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: (inDepartmentalShell ? 0 : insets.bottom) + 28}}>

        {/* Month switcher — switching resets the publish-block panel, which was
            about the month it came from. */}
        <View style={s.monthRow}>
          {/* Locked while a mutation is in flight: plan/publish/archive write
              state for THIS month, and switching mid-flight would land their
              response under another month's title — the same stale-card class
              the load() guard closes for reads (edge review R2). */}
          <TouchableOpacity style={[s.monthBtn, busy !== null && {opacity: 0.5}]} activeOpacity={0.8}
            disabled={busy !== null}
            accessibilityRole="button" accessibilityLabel="Previous month"
            onPress={() => { setPublishBlock(null); setMultiDays(null); setLoaded(false); setMonthKey(k => shiftMonth(k, -1)); }}>
            <Icon name="chevron-left" size={22} color={OB.accentSoft} />
          </TouchableOpacity>
          <Text style={s.monthLabel}>{monthLabel(monthKey)}</Text>
          <TouchableOpacity style={[s.monthBtn, busy !== null && {opacity: 0.5}]} activeOpacity={0.8}
            disabled={busy !== null}
            accessibilityRole="button" accessibilityLabel="Next month"
            onPress={() => { setPublishBlock(null); setMultiDays(null); setLoaded(false); setMonthKey(k => shiftMonth(k, 1)); }}>
            <Icon name="chevron-right" size={22} color={OB.accentSoft} />
          </TouchableOpacity>
        </View>

        {!loaded ? (
          <LoadingView compact label="Loading roster…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoaded(false); void load(); }} />
        ) : (
          <>
            {monthRow && state ? (
              <Card style={[s.stateCard, {borderColor: state.tint + '4D', backgroundColor: state.tint + '12'}]}>
                <Text style={[s.stateLabel, {color: state.tint}]}>{state.label}</Text>
                <Text style={s.stateBody}>{state.body}</Text>
                {monthRow.published_at ? (
                  <Text style={s.stamp}>Published {fmtDayTime(monthRow.published_at)}</Text>
                ) : null}
                {monthRow.amended_at ? (
                  <Text style={s.stamp}>Amended {fmtDayTime(monthRow.amended_at)}</Text>
                ) : null}
              </Card>
            ) : (
              <Card style={{gap: 10}}>
                <Text style={s.stateBody}>
                  This month has no roster yet. Start planning to open a draft — your team
                  sees nothing until you publish.
                </Text>
                <PrimaryButton
                  label={busy === 'plan' ? 'Opening…' : 'Start planning'}
                  icon="calendar-plus"
                  disabled={busy !== null}
                  onPress={() => { void startPlanning(); }}
                />
              </Card>
            )}

            <View style={{height: 14}} />
            <SectionLabel right={`${grid.shiftCount} shift${grid.shiftCount === 1 ? '' : 's'}`}>CALENDAR</SectionLabel>
            <Card>
              <View style={s.weekHeader}>
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
                  <Text key={i} style={s.weekDay}>{d}</Text>
                ))}
              </View>
              {grid.weeks.map((week, wi) => (
                <View key={wi} style={s.week}>
                  {week.map((cell, ci) => cell ? (
                    <TouchableOpacity key={ci}
                      style={[s.day, multiDays?.has(cell.day) && s.daySelected]}
                      activeOpacity={0.75}
                      accessibilityRole="button"
                      accessibilityLabel={multiDays
                        ? `Day ${cell.day}, ${multiDays.has(cell.day) ? 'selected' : 'not selected'}`
                        : `Day ${cell.day}, ${cell.count} shifts`}
                      onPress={() => {
                        if (multiDays) {
                          setMultiDays(prev => {
                            const next = new Set(prev);
                            if (next.has(cell.day)) {next.delete(cell.day);} else {next.add(cell.day);}
                            return next;
                          });
                        } else {
                          // Embedded, the dashboard switches SEGMENT — pushing
                          // the standalone route here would re-create the
                          // "separate disconnected area" item 13 removes.
                          if (onOpenShifts) { onOpenShifts(); return; }
                          navigation.navigate('ShiftManagement');
                        }
                      }}>
                      <Text style={[s.dayNum, multiDays?.has(cell.day) && {color: OB.text, fontWeight: '800'}]}>{cell.day}</Text>
                      {cell.count > 0 && (
                        <View style={s.dayBadge}><Text style={s.dayBadgeText}>{cell.count}</Text></View>
                      )}
                    </TouchableOpacity>
                  ) : (
                    <View key={ci} style={s.day} />
                  ))}
                </View>
              ))}
            </Card>
            {/* Q6 — enter/leave multi-day plan mode + the create handoff. */}
            {multiDays ? (
              <View style={{gap: 10, marginTop: 12}}>
                <PrimaryButton
                  label={`Plan shift · ${multiDays.size} day${multiDays.size === 1 ? '' : 's'}`}
                  icon="calendar-multiselect"
                  disabled={multiDays.size === 0}
                  onPress={() => {
                    const dates = [...multiDays].sort((a, b) => a - b)
                      .map(d => `${monthKey}-${String(d).padStart(2, '0')}`);
                    setMultiDays(null);
                    navigation.navigate('ShiftEditor', {dates});
                  }}
                />
                <GhostButton label="Cancel selection" icon="close"
                  onPress={() => setMultiDays(null)} />
                <Text style={s.hint}>
                  Tap days to add or remove them — one shift is created per selected day,
                  same time window and assignees.
                </Text>
              </View>
            ) : (
              <>
                {/* Hidden for an ARCHIVED month — nothing can be created into
                    it, so offering the selection would only fail at Create. */}
                {monthRow?.status !== 'archived' && (
                  <View style={{marginTop: 12}}>
                    <GhostButton label="Select multiple days" icon="calendar-multiselect"
                      onPress={() => setMultiDays(new Set())} />
                  </View>
                )}
                <Text style={s.hint}>
                  Tap a day to manage shifts. The calendar shows every shift overlapping this
                  month{monthRow?.department ? ` in ${monthRow.department}` : ''}.
                </Text>
              </>
            )}

            {/* Pre-publish conflict warning (advisory while editing). */}
            {conflicts.length > 0 && !publishBlock && (
              <>
                <View style={{height: 14}} />
                <SectionLabel>CONFLICTS</SectionLabel>
                <Card style={s.warnCard}>
                  {conflicts.map((c, i) => (
                    <Text key={i} style={s.conflictText}>
                      {`${c.cpo_name ?? 'A member'} is double-booked: ${fmtDayTime(c.start_a)} and ${fmtDayTime(c.start_b)}.`}
                    </Text>
                  ))}
                </Card>
              </>
            )}

            {/* Publish refused — the blocking list plus the audited override. */}
            {publishBlock && (
              <>
                <View style={{height: 14}} />
                <SectionLabel>PUBLISH BLOCKED</SectionLabel>
                <Card style={s.blockCard}>
                  <Text style={s.blockTitle}>These overlaps block publishing:</Text>
                  {publishBlock.map((c, i) => (
                    <Text key={i} style={s.conflictText}>
                      {`${c.cpo_name ?? 'A member'}: ${fmtDayTime(c.start_a)}–${fmtDayTime(c.end_a)} overlaps ${fmtDayTime(c.start_b)}–${fmtDayTime(c.end_b)}.`}
                    </Text>
                  ))}
                  <Text style={s.hint}>
                    Fix the shifts, or publish anyway — the override is recorded in the audit log.
                  </Text>
                  <GhostButton
                    label={busy === 'force' ? 'Publishing…' : 'Publish anyway'}
                    icon="alert-circle-outline"
                    disabled={busy !== null}
                    onPress={() => { void publish(true); }}
                  />
                </Card>
              </>
            )}

            {/* Actions exist only once the month row exists — the server 404s
                both verbs on an unplanned month anyway. */}
            {monthRow && monthRow.status !== 'archived' && (
              <>
                <View style={{height: 18}} />
                <PrimaryButton
                  label={busy === 'publish' ? 'Publishing…'
                    : live ? 'Publish changes' : 'Publish roster'}
                  icon="send-check-outline"
                  disabled={busy !== null}
                  onPress={() => { void publish(false); }}
                />
                <View style={{height: 10}} />
                <GhostButton label="Archive month" icon="archive-outline"
                  disabled={busy !== null} onPress={archive} />
              </>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:       {flex: 1, backgroundColor: OB.bg},
  monthRow:   {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 6},
  monthBtn:   {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  monthLabel: {color: OB.text, fontSize: 17, fontWeight: '800'},
  stateCard:  {gap: 4},
  stateLabel: {fontSize: 12, fontWeight: '800', letterSpacing: 1},
  stateBody:  {color: OB.textDim, fontSize: 13, lineHeight: 19},
  stamp:      {color: OB.textMute, fontSize: 11, marginTop: 2},
  weekHeader: {flexDirection: 'row', marginBottom: 6},
  weekDay:    {flex: 1, textAlign: 'center', color: OB.textMute, fontSize: 11, fontWeight: '700'},
  week:       {flexDirection: 'row'},
  day:        {flex: 1, aspectRatio: 1, alignItems: 'center', justifyContent: 'center'},
  daySelected: {borderRadius: 10, backgroundColor: OB.accent + '2E', borderWidth: 1, borderColor: OB.accent + '66'},
  dayNum:     {color: OB.text, fontSize: 13},
  dayBadge:   {position: 'absolute', bottom: 4, minWidth: 15, height: 15, borderRadius: 8, paddingHorizontal: 3, alignItems: 'center', justifyContent: 'center', backgroundColor: OB.accent + '33', borderWidth: 1, borderColor: OB.accent + '55'},
  dayBadgeText: {color: OB.accentSoft, fontSize: 9, fontWeight: '800'},
  hint:       {color: OB.textMute, fontSize: 12, marginTop: 8, lineHeight: 17},
  warnCard:   {gap: 6, borderColor: OB.amber + '4D', backgroundColor: OB.amber + '12'},
  blockCard:  {gap: 8, borderColor: OB.alert + '4D', backgroundColor: OB.alert + '12'},
  blockTitle: {color: OB.text, fontSize: 13, fontWeight: '700'},
  conflictText: {color: OB.textDim, fontSize: 12, lineHeight: 17},
}));
