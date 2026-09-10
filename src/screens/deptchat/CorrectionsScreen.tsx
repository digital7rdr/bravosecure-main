import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import LoadingView from '@components/LoadingView';
import {attendanceApi, type ShiftSessionDto, type CorrectionRowDto, type AttendanceStatusDto} from '@services/api';
import type {DeptAttendStackParamList} from '@navigation/types';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton, ErrorState, loadErrorText, attendanceStatusMeta, reviewReasonLabel, useInDepartmentalShell} from './_obsidian';

type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type Rt = RouteProp<DeptAttendStackParamList, 'Corrections'>;

/**
 * A7.4 (C1) — attendance corrections. Append-only: the original session is
 * never edited; every correction stores before/after with actor + server time,
 * and readers fold "the latest correction naming the field wins" (C2, live
 * server-side since 2026-08-07).
 *
 * Two modes in one screen: no session → the pick-a-session list (pending
 * review first, then recent closed sessions); with a session → the editor.
 */

// Mirrors the server's CORRECTABLE_STATUSES (roster.dto.ts) — pinned by
// correctionsServerContract.test.ts. Order matters to the pin.
const CORRECTABLE_STATUSES: AttendanceStatusDto[] = [
  'present', 'late', 'absent', 'early_checkout', 'leave',
  'sick_leave', 'off_duty', 'pending_review', 'emergency_leave', 'mission',
];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, {weekday: 'short', day: 'numeric', month: 'short'});
const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'}) : '—';
const toHHMM = (iso: string | null | undefined) => {
  if (!iso) {return '';}
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** History values: timestamps as readable date·time, everything else verbatim
 *  (a raw ISO blob in the audit list defeated the list's purpose). */
const fmtHistVal = (k: string, v: unknown) =>
  k.endsWith('_at') && typeof v === 'string' ? `${fmtDate(v)} ${fmtTime(v)}` : String(v ?? '—');

/** Apply an HH:MM entry to the session's own calendar day (local). */
function hhmmToIso(hhmm: string, anchorIso: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(anchorIso);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

/**
 * `embedded` — rendered as a SEGMENT of AdminAttendanceScreen rather than as
 * its own route (client review vs2 item 13: the four areas must be one
 * dashboard, not "separate disconnected areas"). The host owns the safe-area
 * inset, the status bar, the backdrop and the header, so the screen suppresses
 * its own. Defaults false, so the standalone route is byte-identical to before.
 */
export default function CorrectionsScreen({embedded = false}: {embedded?: boolean} = {}) {
  const insets = useSafeAreaInsets();
  const {overlap} = useKeyboardLayout();
  const inDepartmentalShell = useInDepartmentalShell();
  const restBottom = inDepartmentalShell ? 0 : insets.bottom;
  const bottomPad = (gap = 0) => (overlap > 0 ? overlap : restBottom) + gap;
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();

  // The editor's session. Rows are effective-folded server-side (C2), so the
  // param row IS the "recorded value"; after a successful correction the local
  // copy is re-folded with the accepted `after`.
  const [session, setSession] = useState<ShiftSessionDto | null>(params?.session ?? null);
  const cameWithSession = (params?.session ?? null) !== null;

  // ── list mode state ──
  const [pending, setPending] = useState<ShiftSessionDto[]>([]);
  const [recent, setRecent] = useState<ShiftSessionDto[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── editor state ──
  const [history, setHistory] = useState<CorrectionRowDto[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [status, setStatus] = useState<AttendanceStatusDto | null>(null);
  const [inTime, setInTime] = useState('');
  const [outTime, setOutTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const [p, all] = await Promise.all([
        attendanceApi.pendingQueue(),
        attendanceApi.orgSessions(),
      ]);
      const pendingRows = p.data ?? [];
      const pendingIds = new Set(pendingRows.map(r => r.id));
      setPending(pendingRows);
      // Recent CLOSED sessions — open ones cannot be corrected (the server
      // refuses cannot_correct_open_session), so they are not offered.
      setRecent((all.data ?? [])
        .filter(r => r.status !== 'open' && !pendingIds.has(r.id))
        .slice(0, 30));
      setLoadError(null);
    } catch (e) {
      setLoadError(loadErrorText(e));
    } finally {
      setListLoading(false);
    }
  }, []);

  const loadHistory = useCallback(async (sessionId: string) => {
    try {
      const {data} = await attendanceApi.listCorrections(sessionId);
      setHistory(data.corrections ?? []);
      setHistoryError(null);
    } catch (e) {
      setHistoryError(loadErrorText(e));
    }
  }, []);

  useFocusEffect(useCallback(() => {
    if (session) { void loadHistory(session.id); }
    else { void loadList(); }
  }, [session, loadHistory, loadList]));

  const openEditor = useCallback((row: ShiftSessionDto) => {
    setSession(row);
    setStatus(null); setInTime(''); setOutTime(''); setReason('');
    setHistory([]); setHistoryError(null);
  }, []);

  const closeEditor = useCallback(() => {
    // In LIST mode (or when the editor was opened with a param), back means
    // LEAVE — `setSession(null)` on an already-null session re-renders nothing
    // and the focus effect never re-fires, which wedged the screen on a
    // permanent spinner (both reviewers, round 1).
    if (!session || cameWithSession) { navigation.goBack(); return; }
    setSession(null);
    setListLoading(true);
  }, [session, cameWithSession, navigation]);

  /** What the correction would change — empty object = nothing changed. */
  const proposedAfter = useMemo(() => {
    if (!session) {return {};}
    const after: Record<string, unknown> = {};
    if (status && status !== (session.attendance_status ?? null)) {after.attendance_status = status;}
    const inTrim = inTime.trim();
    if (inTrim && HHMM.test(inTrim) && inTrim !== toHHMM(session.clock_in_at)) {
      after.clock_in_at = hhmmToIso(inTrim, session.clock_in_at);
    }
    const outTrim = outTime.trim();
    if (outTrim && HHMM.test(outTrim)
        && outTrim !== toHHMM(session.clock_out_at)) {
      // Anchored to the EFFECTIVE clock-in instant's own day; if that lands at
      // or before clock-in, the shift crossed midnight → next calendar day
      // (setDate, not +86400000ms, so DST days keep the wall-clock time).
      // Anchoring to the old clock-OUT day could not express "pull an
      // overnight end back before midnight" and silently GREW the shift ~24h
      // (edge review, round 1). This construction keeps out strictly inside
      // (in, in+24h], so a negative duration is inexpressible from this form.
      const effIn = (after.clock_in_at as string | undefined) ?? session.clock_in_at;
      let iso = hhmmToIso(outTrim, effIn);
      if (Date.parse(iso) <= Date.parse(effIn)) {
        const d = new Date(iso);
        d.setDate(d.getDate() + 1);
        iso = d.toISOString();
      }
      after.clock_out_at = iso;
    }
    return after;
  }, [session, status, inTime, outTime]);

  const submit = useCallback(async () => {
    if (busy || !session) {return;}
    const badIn = inTime.trim() !== '' && !HHMM.test(inTime.trim());
    const badOut = outTime.trim() !== '' && !HHMM.test(outTime.trim());
    if (badIn || badOut) {
      Alert.alert('Correction', 'Times must be HH:MM, e.g. 08:30 or 17:05.');
      return;
    }
    if (Object.keys(proposedAfter).length === 0) {
      Alert.alert('Nothing changed', 'Pick a different status or time before saving.');
      return;
    }
    if (!reason.trim()) {
      Alert.alert('Correction', 'A reason is required — it is kept forever with the change.');
      return;
    }
    setBusy(true);
    try {
      await attendanceApi.recordCorrection({
        session_id: session.id, reason: reason.trim(), after: proposedAfter,
      });
      // Fold the accepted change into the local copy so "Recorded value" shows
      // the new effective state (which is exactly what every reader now sees
      // via C2), then reload the append-only history.
      setSession(prev => (prev ? {...prev, ...proposedAfter} as ShiftSessionDto : prev));
      setStatus(null); setInTime(''); setOutTime(''); setReason('');
      await loadHistory(session.id);
      Alert.alert('Correction recorded',
        'The change is live everywhere the session appears. The original values stay in the history below.');
    } catch (e) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      const copy: Record<string, string> = {
        correction_changes_nothing: 'Nothing changed — the values you entered match the current record.',
        cannot_correct_open_session: 'This session is still open. It can be corrected once it closes.',
        correction_reason_required: 'A reason is required.',
        invalid_attendance_status: 'That status is not a valid attendance value.',
        invalid_clock_in_at: 'The clock-in time could not be understood.',
        invalid_clock_out_at: 'The clock-out time could not be understood.',
        correction_out_before_in: 'That would put the clock-out before the clock-in. Check both times.',
        session_not_found_in_org: 'This session is outside your branch or no longer exists.',
      };
      Alert.alert('Could not save', (msg && copy[msg]) || 'Please check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }, [busy, session, proposedAfter, reason, inTime, outTime, loadHistory]);

  const renderRow = (row: ShiftSessionDto) => {
    const meta = attendanceStatusMeta(row.attendance_status);
    const disputed = row.review_reason === 'disputed';
    return (
      <TouchableOpacity key={row.id} style={s.row} activeOpacity={0.8}
        accessibilityRole="button" accessibilityLabel={`Correct session from ${fmtDate(row.clock_in_at)}`}
        onPress={() => openEditor(row)}>
        <Icon name={meta.icon} size={18} color={meta.color} />
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.rowTitle} numberOfLines={1}>
            {fmtDate(row.clock_in_at)} · {fmtTime(row.clock_in_at)}–{fmtTime(row.clock_out_at)}
          </Text>
          <Text style={s.rowSub} numberOfLines={1}>
            {meta.label}
            {disputed ? ' · Disputed by the member' : ''}
          </Text>
        </View>
        <Icon name="pencil-outline" size={16} color={OB.textMute} />
      </TouchableOpacity>
    );
  };

  return (
    <View style={[s.root, embedded ? {backgroundColor: 'transparent'} : {paddingTop: insets.top}]}>
      {!embedded && <StatusBar barStyle="light-content" backgroundColor={OB.bg} />}
      {!embedded && <AmbientBg bg={OB.bg} />}
      {!embedded && <ObHeader title="Corrections" onBack={closeEditor} pill="ADMIN" />}

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: bottomPad(24)}}>

        {!session ? (
          /* ── LIST MODE ── */
          listLoading ? (
            <LoadingView compact label="Loading sessions…" />
          ) : loadError ? (
            <ErrorState message={loadError} onRetry={() => { setListLoading(true); void loadList(); }} />
          ) : (
            <>
              <SectionLabel>NEEDS REVIEW</SectionLabel>
              {pending.length === 0 ? (
                <Card><Text style={s.empty}>Nothing waiting for review.</Text></Card>
              ) : (
                <Card style={{gap: 4}}>{pending.map(renderRow)}</Card>
              )}
              <View style={{height: 16}} />
              <SectionLabel>RECENT SESSIONS</SectionLabel>
              {recent.length === 0 ? (
                <Card><Text style={s.empty}>No closed sessions yet.</Text></Card>
              ) : (
                <Card style={{gap: 4}}>{recent.map(renderRow)}</Card>
              )}
            </>
          )
        ) : (
          /* ── EDITOR MODE ── */
          <>
            {/* vs2 item 13 — the editor's ONLY exit was the ObHeader's back
                arrow, which the embedded segment suppresses: opening the wrong
                session became a one-way door with no back, no cancel, and (as
                the Attend stack's initial route) nothing to swipe back to.
                `closeEditor` already does the right thing here — it was simply
                left with no caller in this mode. */}
            {embedded && !cameWithSession ? (
              <View style={{marginBottom: 12}}>
                <GhostButton label="Back to sessions" icon="arrow-left" onPress={closeEditor} />
              </View>
            ) : null}
            <SectionLabel>RECORDED VALUE</SectionLabel>
            <Card style={{gap: 6}}>
              <View style={s.recRow}>
                <Icon name={attendanceStatusMeta(session.attendance_status).icon} size={18}
                  color={attendanceStatusMeta(session.attendance_status).color} />
                <Text style={s.recTitle}>
                  {attendanceStatusMeta(session.attendance_status).label}
                </Text>
                <Text style={s.recDate}>{fmtDate(session.clock_in_at)}</Text>
              </View>
              <Text style={s.recTimes}>
                Clock in {fmtTime(session.clock_in_at)} · Clock out {fmtTime(session.clock_out_at)}
              </Text>
              {session.review_reason ? (
                <Text style={s.recFlag}>{reviewReasonLabel(session.review_reason) ?? ''}</Text>
              ) : null}
              {/* A7.4 — the member's own words travel with the editor. */}
              {session.dispute_note ? (
                <Text style={s.dispute}>"{session.dispute_note}"</Text>
              ) : null}
            </Card>

            <View style={{height: 16}} />
            <SectionLabel>CORRECT STATUS</SectionLabel>
            <Card style={s.chips}>
              {/* pending_review is server-correctable but OFFERS nothing here:
                  the review queue keys on review_status, so a session
                  corrected to it reads "Pending review" everywhere yet never
                  enters the queue — a label with no workflow. Filtered from
                  the picker; the pinned 10-list itself stays untouched. */}
              {CORRECTABLE_STATUSES.filter(st => st !== 'pending_review').map(st => {
                const meta = attendanceStatusMeta(st);
                const on = (status ?? session.attendance_status) === st;
                return (
                  <TouchableOpacity key={st} style={[s.chip, on && s.chipOn]} activeOpacity={0.8}
                    accessibilityRole="button" accessibilityLabel={`Set status ${meta.label}`}
                    onPress={() => setStatus(st)}>
                    <Icon name={meta.icon} size={14} color={on ? OB.accentSoft : OB.textMute} />
                    <Text style={[s.chipText, on && {color: OB.text}]}>{meta.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </Card>

            <View style={{height: 16}} />
            <SectionLabel>CORRECT TIMES</SectionLabel>
            <Card style={{gap: 10}}>
              <View style={s.field}>
                <Icon name="clock-in" size={18} color={OB.textMute} />
                <TextInput style={s.input} placeholder={`Clock in (now ${toHHMM(session.clock_in_at) || '—'})`}
                  placeholderTextColor={OB.textMute} value={inTime} onChangeText={setInTime}
                  keyboardType="numbers-and-punctuation" maxLength={5} autoCorrect={false} />
              </View>
              <View style={s.field}>
                <Icon name="clock-out" size={18} color={OB.textMute} />
                <TextInput style={s.input} placeholder={`Clock out (now ${toHHMM(session.clock_out_at) || '—'})`}
                  placeholderTextColor={OB.textMute} value={outTime} onChangeText={setOutTime}
                  keyboardType="numbers-and-punctuation" maxLength={5} autoCorrect={false} />
              </View>
              <Text style={s.hint}>
                HH:MM. Leave blank to keep a time. An end at or before the start rolls to
                the next day (overnight shift).
              </Text>
              {/* Say OUT LOUD when the roll fired — a day-shift typo (out
                  "08:00" under an 09:00 start) otherwise lands a silent ~23h
                  shift in the CSV (edge review R1). */}
              {(() => {
                const outIso = proposedAfter.clock_out_at as string | undefined;
                if (!outIso) {return null;}
                const effInIso = (proposedAfter.clock_in_at as string | undefined) ?? session.clock_in_at;
                if (new Date(outIso).getDate() === new Date(effInIso).getDate()) {return null;}
                return (
                  <Text style={s.nextDay}>
                    ⚠ Ends NEXT DAY at {outTime.trim()} — this makes the shift cross midnight.
                    If that's not right, check both times.
                  </Text>
                );
              })()}
            </Card>

            <View style={{height: 16}} />
            <SectionLabel>REASON (REQUIRED)</SectionLabel>
            <Card>
              <TextInput style={[s.input, s.multiline]}
                placeholder="Why this correction is right — kept forever with the change"
                placeholderTextColor={OB.textMute} value={reason} onChangeText={setReason}
                multiline maxLength={500} />
            </Card>

            <View style={{height: 18}} />
            <PrimaryButton
              label={busy ? 'Saving…' : 'Record correction'}
              icon="file-document-edit-outline"
              disabled={busy}
              onPress={() => { void submit(); }}
            />

            <View style={{height: 18}} />
            <SectionLabel>HISTORY</SectionLabel>
            {historyError ? (
              <ErrorState message={historyError} onRetry={() => { void loadHistory(session.id); }} />
            ) : history.length === 0 ? (
              <Card><Text style={s.empty}>No corrections yet. The full before/after trail appears here.</Text></Card>
            ) : (
              <Card style={{gap: 10}}>
                {history.map(h => (
                  <View key={h.id} style={s.histRow}>
                    <Text style={s.histWhen}>{fmtDate(h.corrected_at)} · {fmtTime(h.corrected_at)}</Text>
                    {Object.keys(h.after_value).map(k => (
                      <Text key={k} style={s.histChange} numberOfLines={2}>
                        {`${k.replace(/_/g, ' ')}: ${fmtHistVal(k, h.before_value[k])} → ${fmtHistVal(k, h.after_value[k])}`}
                      </Text>
                    ))}
                    <Text style={s.histReason} numberOfLines={3}>{h.reason}</Text>
                  </View>
                ))}
              </Card>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:     {flex: 1, backgroundColor: OB.bg},
  empty:    {color: OB.textMute, fontSize: 13, lineHeight: 19},
  row:      {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8},
  rowTitle: {color: OB.text, fontSize: 13, fontWeight: '600'},
  rowSub:   {color: OB.textMute, fontSize: 11, marginTop: 2},
  recRow:   {flexDirection: 'row', alignItems: 'center', gap: 8},
  recTitle: {color: OB.text, fontSize: 15, fontWeight: '700', flex: 1},
  recDate:  {color: OB.textMute, fontSize: 12},
  recTimes: {color: OB.textDim, fontSize: 13},
  recFlag:  {color: OB.amber, fontSize: 12},
  dispute:  {color: OB.textDim, fontSize: 12, fontStyle: 'italic', lineHeight: 17},
  chips:    {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  chip:     {flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 7, paddingHorizontal: 11, borderRadius: 16, borderWidth: 1, borderColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  chipOn:   {borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12'},
  chipText: {color: OB.textMute, fontSize: 12, fontWeight: '600'},
  field:    {flexDirection: 'row', alignItems: 'center', gap: 12},
  input:    {flex: 1, color: OB.text, fontSize: 15, paddingVertical: 6},
  multiline:{minHeight: 72, textAlignVertical: 'top'},
  hint:     {color: OB.textMute, fontSize: 11, lineHeight: 16},
  nextDay:  {color: OB.amber, fontSize: 12, lineHeight: 17, marginTop: 2},
  histRow:  {gap: 3, borderTopWidth: 1, borderTopColor: OB.hair, paddingTop: 8},
  histWhen: {color: OB.textMute, fontSize: 11},
  histChange: {color: OB.text, fontSize: 12},
  histReason: {color: OB.textDim, fontSize: 12, fontStyle: 'italic'},
}));
