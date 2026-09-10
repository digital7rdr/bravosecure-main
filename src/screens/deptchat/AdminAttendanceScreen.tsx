import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, ActivityIndicator, TouchableOpacity, Modal, TextInput} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useKeyboardOverlap} from '@hooks/useKeyboardLayout';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles, isSmallPhone} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {DeptAttendStackParamList} from '@navigation/types';
import {attendanceApi, type ShiftSessionDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, attendanceStatusMeta, reviewReasonLabel} from './_obsidian';
import {fmtTime} from './geo';
import ShiftManagementScreen from './ShiftManagementScreen';
import DayStatusScreen from './DayStatusScreen';
import MonthlyRosterScreen from './MonthlyRosterScreen';
import CorrectionsScreen from './CorrectionsScreen';

// PDF p.9 filters — date presets + department, applied server-side.
type IconName = React.ComponentProps<typeof Icon>['name'];
type Seg = 'review' | 'shifts' | 'day' | 'roster' | 'corrections';

/** vs2 item 13 — the one dashboard. Review stays FIRST so the screen still
 *  opens on the queue it opened on before. */
const SEGMENTS: Array<{key: Seg; label: string; icon: IconName}> = [
  {key: 'review',      label: 'Review',     icon: 'clipboard-check-outline'},
  {key: 'shifts',      label: 'Shifts',     icon: 'calendar-edit'},
  {key: 'day',         label: 'Day status', icon: 'calendar-account'},
  {key: 'roster',      label: 'Roster',     icon: 'calendar-month-outline'},
  {key: 'corrections', label: 'Corrections',icon: 'file-document-edit-outline'},
];

const DATE_PRESETS = [
  {key: 'all', label: 'All', days: null},
  {key: 'today', label: 'Today', days: 1},
  {key: '7d', label: '7 days', days: 7},
  {key: '30d', label: '30 days', days: 30},
] as const;
type DateKey = (typeof DATE_PRESETS)[number]['key'];

function fromFor(key: DateKey): string | undefined {
  const preset = DATE_PRESETS.find(p => p.key === key);
  if (!preset?.days) {return undefined;}
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - (preset.days - 1));
  return d.toISOString();
}

// Hosted in the Departmental Attend tab (Step 19). Typed to that stack because
// the pending queue still PUSHES Corrections with a session, and the embedded
// segments navigate to ShiftEditor from here.
type Nav = NativeStackNavigationProp<DeptAttendStackParamList>;
type Summary = {counts: Record<string, number>; total: number; pendingReview: number};

export default function AdminAttendanceScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-13 — Android Modal windows don't resize for the IME.
  const keyboardOverlap = useKeyboardOverlap();
  const navigation = useNavigation<Nav>();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [pending, setPending] = useState<ShiftSessionDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [tab, setTab] = useState<Seg>('review');
  const [busyId, setBusyId] = useState<string | null>(null);
  // PDF p.9 — approve/reject must support admin notes; collected in a modal
  // (Alert.prompt is iOS-only) and stored in the session's admin_notes.
  const [reviewTarget, setReviewTarget] = useState<{id: string; decision: 'approve' | 'reject'} | null>(null);
  const [notes, setNotes] = useState('');
  const [dateKey, setDateKey] = useState<DateKey>('all');
  const [department, setDepartment] = useState<string | null>(null);
  const [departments, setDepartments] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const from = fromFor(dateKey);
      const dept = department ?? undefined;
      const [sum, pend, shifts] = await Promise.all([
        attendanceApi.orgSummary({from, department: dept}).then(r => r.data).catch(() => null),
        attendanceApi.pendingQueue(dept ? {department: dept} : undefined).then(r => r.data).catch(() => []),
        attendanceApi.listShifts().then(r => r.data).catch(() => []),
      ]);
      setSummary(sum);
      setPending(pend);
      setDepartments(Array.from(new Set(shifts.map(sh => sh.department).filter((d): d is string => !!d))));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [dateKey, department]);

  useFocusEffect(useCallback(() => { void load(); }, [load]));
  // The host route stays FOCUSED across segment switches, so the focus effect
  // alone leaves the header pill and the Present/Late/Absent stats frozen at
  // whatever they were when the screen opened — after setting someone to leave
  // in another segment they are simply wrong. Refresh when the segment
  // changes; the header pill sits above the bar and has no other refresh.
  useEffect(() => { void load(); }, [tab, load]);

  const review = (id: string, decision: 'approve' | 'reject') => {
    setNotes('');
    setReviewTarget({id, decision});
  };

  const doReview = async (id: string, decision: 'approve' | 'reject', reviewNotes?: string) => {
    if (busyId) {return;}
    setBusyId(id);
    try {
      const trimmed = reviewNotes?.trim();
      await attendanceApi.reviewSession(id, decision, trimmed ? trimmed : undefined);
      await load();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Review', msg ?? 'Could not update. Please try again.');
    } finally {
      setBusyId(null);
    }
  };

  const c = summary?.counts ?? {};

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title="Admin Attendance"
        onBack={() => navigation.goBack()}
        pill={summary ? `${summary.pendingReview} PENDING` : undefined}
        pillTone={summary && summary.pendingReview > 0 ? 'warn' : 'good'}
      />

      {/* Client review vs2 item 13 — "Manage Shifts, Set Day Status and Monthly
          Roster must be combined on one attendance dashboard rather than
          treated as separate disconnected areas."
          These were four cards that navigated AWAY. They are now segments of
          this screen, rendering the same components with `embedded` so the
          standalone routes keep working byte-identically (deep links from the
          pending queue and the roster still push them). */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.segScroll}
        contentContainerStyle={s.segRow}>
        {SEGMENTS.map(seg => (
          <TouchableOpacity
            key={seg.key}
            style={[s.seg, tab === seg.key && s.segOn]}
            activeOpacity={0.85}
            accessibilityRole="button"
            // The visible label is a nested <Text>, so without this a screen
            // reader announces the pill unnamed and nothing can address an
            // individual segment — the same fix ObsidianTabBar carries.
            accessibilityLabel={seg.label}
            accessibilityState={{selected: tab === seg.key}}
            onPress={() => setTab(seg.key)}>
            <Icon name={seg.icon} size={15} color={tab === seg.key ? OB.accentSoft : OB.textMute} />
            <Text style={[s.segText, tab === seg.key && s.segTextOn]} numberOfLines={1}>{seg.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {tab === 'shifts' ? <ShiftManagementScreen embedded /> :
       tab === 'day' ? <DayStatusScreen embedded /> :
       tab === 'roster' ? <MonthlyRosterScreen embedded onOpenShifts={() => setTab('shifts')} /> :
       tab === 'corrections' ? <CorrectionsScreen embedded /> : (
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 32}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        {/* PDF p.9 — date + department filters (server-side). */}
        <View style={s.filterRow}>
          {DATE_PRESETS.map(p => (
            <TouchableOpacity
              key={p.key}
              style={[s.filterChip, dateKey === p.key && s.filterChipOn]}
              activeOpacity={0.8}
              onPress={() => setDateKey(p.key)}>
              <Text style={[s.filterText, dateKey === p.key && s.filterTextOn]}>{p.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
        {departments.length > 0 ? (
          <View style={s.filterRow}>
            <TouchableOpacity
              style={[s.filterChip, department === null && s.filterChipOn]}
              activeOpacity={0.8}
              onPress={() => setDepartment(null)}>
              <Text style={[s.filterText, department === null && s.filterTextOn]}>All depts</Text>
            </TouchableOpacity>
            {departments.map(d => (
              <TouchableOpacity
                key={d}
                style={[s.filterChip, department === d && s.filterChipOn]}
                activeOpacity={0.8}
                onPress={() => setDepartment(cur => (cur === d ? null : d))}>
                <Text style={[s.filterText, department === d && s.filterTextOn]} numberOfLines={1}>{d}</Text>
              </TouchableOpacity>
            ))}
          </View>
        ) : null}

        <View style={s.statsRow}>
          <Stat label="Present" value={c.present ?? 0} color={OB.signal} />
          <Stat label="Late" value={c.late ?? 0} color={OB.amber} />
          <Stat label="Absent" value={c.absent ?? 0} color={OB.alert} />
        </View>

        <View style={{marginTop: 22}}>
          <SectionLabel>PENDING REVIEW</SectionLabel>
          {loading ? (
            <LoadingView compact label="Loading attendance…" />
          ) : pending.length === 0 ? (
            <Card><Text style={s.empty}>Nothing waiting for review.</Text></Card>
          ) : (
            <View style={{gap: 10}}>
              {pending.map(p => {
                const meta = attendanceStatusMeta(p.attendance_status);
                const reason = reviewReasonLabel(p.review_reason);
                const busy = busyId === p.id;
                return (
                  <Card key={p.id} style={{gap: 12}}>
                    <View style={s.pendTop}>
                      <Icon name={meta.icon} size={18} color={meta.color} />
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.pendIn}>{fmtTime(p.clock_in_at)}</Text>
                        <Text style={s.pendReason} numberOfLines={2}>{reason ?? 'Pending review'}</Text>
                        {/* A7.4 — the member's own dispute words, where the
                            decision is made. */}
                        {p.review_reason === 'disputed' && p.dispute_note ? (
                          <Text style={s.disputeNote} numberOfLines={3}>"{p.dispute_note}"</Text>
                        ) : null}
                      </View>
                    </View>
                    <View style={s.actions}>
                      <TouchableOpacity style={[s.actBtn, s.correct]} activeOpacity={0.8} disabled={busy}
                        accessibilityRole="button" accessibilityLabel="Correct this session"
                        onPress={() => navigation.navigate('Corrections', {session: p})}>
                        <Icon name="pencil-outline" size={15} color={OB.accentSoft} />
                        <Text style={[s.actText, {color: OB.accentSoft}]} numberOfLines={1}>Correct</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.actBtn, s.reject]} activeOpacity={0.8} disabled={busy} onPress={() => review(p.id, 'reject')}>
                        <Icon name="close" size={15} color={OB.alert} />
                        <Text style={[s.actText, {color: OB.alert}]} numberOfLines={1}>Reject</Text>
                      </TouchableOpacity>
                      <TouchableOpacity style={[s.actBtn, s.approve]} activeOpacity={0.8} disabled={busy} onPress={() => review(p.id, 'approve')}>
                        {busy ? <ActivityIndicator size="small" color={OB.signal} /> : <Icon name="check" size={15} color={OB.signal} />}
                        <Text style={[s.actText, {color: OB.signal}]} numberOfLines={1}>Approve</Text>
                      </TouchableOpacity>
                    </View>
                  </Card>
                );
              })}
            </View>
          )}
        </View>
      </ScrollView>
      )}

      <Modal visible={reviewTarget !== null} transparent animationType="fade" onRequestClose={() => setReviewTarget(null)}>
        {/* B-184 — one rule, both platforms: the backdrop shrinks by the IME
            overlap so the centered card re-centres above the keyboard. */}
        <View style={[s.modalBackdrop, {paddingBottom: keyboardOverlap}]}>
          <View style={s.modalCard}>
            <Text style={s.modalTitle}>
              {reviewTarget?.decision === 'approve' ? 'Approve check-in' : 'Reject check-in'}
            </Text>
            <Text style={s.modalSub}>
              {reviewTarget?.decision === 'approve'
                ? 'Mark this attendance as confirmed?'
                : 'Reject this check-in? It stays flagged.'}
            </Text>
            <TextInput
              style={s.modalInput}
              value={notes}
              onChangeText={setNotes}
              placeholder="Notes (optional)"
              placeholderTextColor={OB.textMute}
              multiline
              maxLength={500}
            />
            <View style={s.actions}>
              <TouchableOpacity style={[s.actBtn, s.cancel]} activeOpacity={0.8} onPress={() => setReviewTarget(null)}>
                <Text style={[s.actText, {color: OB.textDim}]}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.actBtn, reviewTarget?.decision === 'reject' ? s.reject : s.approve]}
                activeOpacity={0.8}
                onPress={() => {
                  const t = reviewTarget;
                  setReviewTarget(null);
                  if (t) { void doReview(t.id, t.decision, notes); }
                }}>
                <Text style={[s.actText, {color: reviewTarget?.decision === 'reject' ? OB.alert : OB.signal}]}>
                  {reviewTarget?.decision === 'approve' ? 'Approve' : 'Reject'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function Stat({label, value, color}: {label: string; value: number; color: string}) {
  return (
    <Card style={s.statCell}>
      <Text style={[s.statValue, {color}]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </Card>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  // vs2 item 13 — the segmented dashboard bar. `flexGrow: 0` because a
  // horizontal ScrollView inside a column would otherwise claim the remaining
  // height and squeeze the segment content it is meant to size to.
  // No maxHeight: flexGrow:0 alone stops a horizontal ScrollView claiming the
  // column, and a cap CLIPS rather than scrolls once the OS font scale pushes
  // the pills past it (~fontScale 1.3).
  segScroll: {flexGrow: 0},
  segRow: {flexDirection: 'row', gap: 8, paddingHorizontal: isSmallPhone ? 10 : 20, paddingVertical: 8},
  seg: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 13, paddingVertical: 8, borderRadius: 11,
    borderWidth: 1, borderColor: OB.hair, backgroundColor: OB.card,
  },
  segOn: {borderColor: OB.accent + '66', backgroundColor: OB.accent + '14'},
  segText: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 12.5},
  segTextOn: {color: OB.accentSoft},

  filterRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8},
  filterChip: {
    paddingHorizontal: 12, paddingVertical: 7, borderRadius: 16, borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.10)', backgroundColor: 'rgba(255,255,255,0.03)',
  },
  filterChipOn: {borderColor: 'rgba(91,141,239,0.55)', backgroundColor: 'rgba(91,141,239,0.14)'},
  filterText: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 11.5},
  filterTextOn: {color: OB.accentSoft},
  statsRow: {flexDirection: 'row', gap: 10, marginTop: 8},
  statCell: {flex: 1, alignItems: 'center', paddingVertical: 18},
  statValue: {fontFamily: BravoFont.extraBold, fontSize: 26, letterSpacing: -0.5},
  statLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 9, letterSpacing: 1, textTransform: 'uppercase', marginTop: 4},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  pendTop: {flexDirection: 'row', alignItems: 'center', gap: 12},
  pendIn: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 13.5},
  pendReason: {color: OB.amber, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  actions: {flexDirection: 'row', gap: 10},
  actBtn: {flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, minHeight: 42, paddingVertical: 6, borderRadius: 12, borderWidth: 1},
  reject: {backgroundColor: 'rgba(245,139,151,0.10)', borderColor: 'rgba(245,139,151,0.4)'},
  approve: {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: 'rgba(74,222,128,0.4)'},
  correct: {backgroundColor: OB.accent + '14', borderColor: OB.accent + '4D'},
  disputeNote: {color: OB.textDim, fontSize: 12, fontStyle: 'italic', marginTop: 3, lineHeight: 16},
  // Same fit rule as the day-status chips: three equal-share buttons on a
  // 320dp screen leave ~51dp for a label that measures ~49dp at fontScale 1.0,
  // so it overflows from ~1.15 up. Let the label shrink rather than the button.
  actText: {fontFamily: BravoFont.bold, fontSize: 12.5, flexShrink: 1},
  modalBackdrop: {flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24},
  modalCard: {
    width: '100%', borderRadius: 18, padding: 20, gap: 10,
    backgroundColor: '#0C1017', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  modalTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 17, letterSpacing: -0.3},
  modalSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, lineHeight: 18},
  modalInput: {
    minHeight: 72, maxHeight: 140, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10,
    color: OB.text, fontFamily: BravoFont.regular, fontSize: 13, textAlignVertical: 'top',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.09)',
  },
  cancel: {backgroundColor: 'rgba(255,255,255,0.04)', borderColor: 'rgba(255,255,255,0.12)'},
}));
