/**
 * Provider · Missions board (BUILD_RUNBOOK Step 13) — the agency's accepted jobs grouped
 * NEEDS CREW / ACTIVE / RECENT. Tapping a needs-crew job opens the assign-crew sheet: pick
 * guards from the roster (free/busy badges), star one as Leader, confirm → that single
 * action CREATES the mission (orgApi.assignCrew) and queues the guards into the encrypted
 * Ops Room. Obsidian + platinum-cobalt theme, matching OrgRosterScreen.
 *
 * The open-jobs browse moved to its own JobPortalScreen (JOB_PORTAL_MARKETPLACE_SPEC
 * Fix B); a needs-crew job gained "Withdraw" — hand it back to the portal (relist)
 * while no crew is assigned.
 */
import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Modal,
  StatusBar, RefreshControl, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi, type RosterMember, type OrgMissionDto} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {drainDispatchRoomIntents} from '@/modules/messenger/orgWorkspace/dispatchRoomIntents';
import {goBackOnce} from '@navigation/tapGuard';

// Step 20 — map the assign-crew server validation codes to friendly, actionable copy.
const ASSIGN_ERRORS: Record<string, string> = {
  crew_count_mismatch: 'Pick exactly the number of guards the job needs.',
  cpo_not_in_org: 'One of those guards isn’t on your active roster.',
  cpo_not_approved_for_deployment: 'A selected guard isn’t verified for deployment yet.',
  cpo_not_on_duty: 'A selected guard just went off duty. They must be on duty to be assigned.',
  cpo_busy: 'A selected guard is already on another live mission. Pick someone free.',
  requirement_unmet_armed: 'This job needs armed authorisation that a selected guard doesn’t hold for the region.',
  lead_not_in_crew: 'The leader must be one of the selected guards.',
  booking_not_assignable: 'This job can no longer be crewed — refresh the board.',
  reassign_leader_first: 'Reassign the team leader before changing this crew.',
  // Issue 11 — the mission could not be given a secure Ops Room, so the server
  // rolled the whole assign back rather than dispatch a crew that cannot be
  // reached. The job is back on the board untouched; retrying is safe.
  comms_room_unavailable:
    'Secure comms could not be opened for this mission, so nothing was dispatched. The job is still on your board — please try again.',
};
function assignErrorMessage(e: unknown): string {
  const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
  const code = Array.isArray(raw) ? raw[0] : raw;
  return (code && ASSIGN_ERRORS[code]) ?? (typeof code === 'string' ? code : null) ?? (e as Error).message ?? 'Could not assign crew';
}

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// The RECENT list can grow unbounded (every completed job stays forever) —
// page it instead of rendering the whole history on one screen.
const RECENT_PAGE_SIZE = 5;

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', accentDeep: '#2F5BE0',
  amber: '#F5C76B', signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    // UTC so mission times match the backend/ops value on every device.
    return d.toLocaleString('en-GB', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'}) + 'Z';
  } catch { return iso; }
}
function initials(name: string | null): string {
  if (!name) {return 'OF';}
  const p = name.trim().split(/\s+/).filter(Boolean);
  return p.length === 1 ? p[0].slice(0, 2).toUpperCase() : (p[0]?.[0] ?? 'O') + (p[p.length - 1]?.[0] ?? 'F');
}

function JobCard({job, onAssign, onMonitor, onOpen, onWithdraw}: {job: OrgMissionDto; onAssign?: () => void; onMonitor?: () => void; onOpen?: () => void; onWithdraw?: () => void}) {
  const lead = job.crew.find(c => c.is_lead);
  // SP-MISSION-DETAIL (#2nd) — needs-crew cards keep the assign sheet as the primary
  // tap; active/recent cards (no onAssign) open the detail page instead of being dead.
  const press = onAssign ?? onOpen;
  return (
    <TouchableOpacity activeOpacity={press ? 0.85 : 1} onPress={press} disabled={!press} style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.cardService} numberOfLines={1}>
          {job.service === 'executive_protection'
            ? `Executive Protection${job.duration_hours ? ` · ${job.duration_hours}h` : ''}`
            : job.service}
        </Text>
        {job.armed_required && (
          <View style={s.armedPill}><Icon name="pistol" size={11} color={D.amber} /><Text style={s.armedText}>ARMED</Text></View>
        )}
      </View>
      <Text style={s.cardMeta} numberOfLines={1}>
        <Icon name="map-marker-outline" size={11} color={D.textMute} /> {job.region_label} · {fmtTime(job.pickup_time)}
      </Text>
      <View style={s.cardBottom}>
        <Text style={s.cardCount}>
          <Icon name="account-multiple-outline" size={12} color={D.textDim} /> {job.crew.length}/{job.cpo_count} crew
          {lead ? ` · ★ ${lead.call_sign ?? 'Lead'}` : ''}
        </Text>
        {onAssign ? (
          <View style={s.assignChip}><Text style={s.assignChipText}>ASSIGN CREW</Text><Icon name="chevron-right" size={14} color={D.accentSoft} /></View>
        ) : job.mission_status === 'SOS' ? (
          // F5 — a crew SOS must scream on the fleet board, not read as a green status.
          <View style={s.sosPill}><Icon name="alarm-light" size={11} color="#fff" /><Text style={s.sosPillText}>SOS</Text></View>
        ) : (
          <Text style={s.statusChip}>{job.mission_status ?? job.booking_status}</Text>
        )}
      </View>
      {/* Step 20 — the shared 6-step stepper, same bar the client + CPO see. */}
      <View style={{marginTop: 4}}>
        <MissionStepper booking={{status: job.booking_status}} mission={job.mission_status ? {status: job.mission_status} : undefined} />
      </View>
      {/* Step 32 — org desk monitor: open the dual-marker live map (CPO leader + user). */}
      {onMonitor && (
        <TouchableOpacity style={s.monitorBtn} activeOpacity={0.85} onPress={onMonitor}>
          <Icon name="map-marker-radius" size={14} color={D.accentSoft} />
          <Text style={s.monitorText}>Live monitor · CPO + principal</Text>
          <Icon name="chevron-right" size={14} color={D.accentSoft} />
        </TouchableOpacity>
      )}
      {/* JOB_PORTAL_MARKETPLACE_SPEC §3 — pre-crew escape hatch: relist to the portal.
          Nested touchable wins the gesture over the card's assign tap (monitorBtn pattern). */}
      {onWithdraw && (
        <TouchableOpacity style={s.withdrawBtn} activeOpacity={0.85} onPress={onWithdraw}>
          <Icon name="undo-variant" size={13} color={D.textMute} />
          <Text style={s.withdrawText}>Withdraw · relist to Job Portal</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

export default function OrgMissionsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [data, setData] = useState<{needs_crew: OrgMissionDto[]; active: OrgMissionDto[]; recent: OrgMissionDto[]}>({needs_crew: [], active: [], recent: []});
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recentPage, setRecentPage] = useState(0);

  // Assign sheet state.
  const [sheetJob, setSheetJob] = useState<OrgMissionDto | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [leadId, setLeadId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [missions, cpos] = await Promise.all([orgApi.listMissions(), orgApi.listCpos()]);
      setData(missions.data);
      setRoster(cpos.data);
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load missions');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // LM-A1 — the board previously loaded ONCE on mount: a mission that went
  // live/completed/SOS'd elsewhere stayed stale until a manual pull. Reload on
  // focus and poll every 10s while the screen is focused (same cadence family
  // as the dashboard's capacity strip).
  useFocusEffect(useCallback(() => {
    void load();
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]));

  // LM-A4 — a guard is unavailable if the SERVER says they're on any live
  // mission (any org, `on_mission`) — the old local guess only saw THIS org's
  // active board. The local set stays as a fallback for stale roster data.
  const busy = useMemo(() => {
    const b = new Set<string>();
    for (const j of data.active) {for (const c of j.crew) {b.add(c.user_id);}}
    for (const m of roster) {if (m.on_mission) {b.add(m.member_user_id);}}
    return b;
  }, [data.active, roster]);

  const openSheet = (job: OrgMissionDto) => {
    setSheetJob(job);
    setSelected(new Set());
    setLeadId(null);
  };
  const closeSheet = () => { setSheetJob(null); setSelected(new Set()); setLeadId(null); };

  const toggleSelect = (id: string) => {
    if (busy.has(id)) {return;}
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); if (leadId === id) {setLeadId(null);} }
      else if (sheetJob && next.size < sheetJob.cpo_count) {next.add(id);}
      return next;
    });
  };

  const confirm = async () => {
    if (!sheetJob) {return;}
    const ids = Array.from(selected);
    if (ids.length !== sheetJob.cpo_count) { Alert.alert('Crew incomplete', `Pick exactly ${sheetJob.cpo_count} guard(s).`); return; }
    if (!leadId) { Alert.alert('No leader', 'Tap ★ to name one guard as the team leader.'); return; }
    setSubmitting(true);
    try {
      await orgApi.assignCrew(sheetJob.booking_id, {cpo_user_ids: ids, lead_user_id: leadId});
      // B-209 — this device is the one that just CREATED the Ops Room's pending
      // key-delivery intents (assignCrew enqueues one per client/crew/manager).
      // Previously nothing delivered them until the agency separately visited
      // AgentDashboard or Messenger — so a founder who assigned crew and moved
      // on without a second visit left everyone keyless indefinitely, even
      // though this exact screen's success copy already claims "your guards
      // are joining the Ops Room" right now. Drain immediately, on the same
      // warm session, instead of waiting for a future unrelated screen visit.
      // Fire-and-forget: a transient failure here just leaves the intents
      // pending for the next drain trigger (dashboard/Messenger focus), same
      // as today — this call only makes the common case instant.
      void drainDispatchRoomIntents().catch(() => {});
      closeSheet();
      await load();
      Alert.alert('Crew dispatched', 'The mission is created and your guards are joining the Ops Room.');
    } catch (e: unknown) {
      // Refresh the board so busy/free badges reflect the race that rejected us.
      void load();
      Alert.alert('Assign failed', assignErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  };

  // JOB_PORTAL_MARKETPLACE_SPEC §3 — hand an uncrewed job back to the portal. The
  // client keeps their escrow hold; another agency accepts and takes it over.
  const withdraw = useCallback((job: OrgMissionDto) => {
    Alert.alert(
      'Withdraw from this job?',
      'It returns to the Job Portal for other agencies. Repeated withdrawals lower your agency’s ranking.',
      [
        {text: 'Keep it', style: 'cancel'},
        {text: 'Withdraw', style: 'destructive', onPress: () => void (async () => {
          try {
            await orgApi.withdrawBooking(job.booking_id, 'agency_withdraw');
          } catch (e: unknown) {
            const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
            const code = Array.isArray(raw) ? raw[0] : raw;
            Alert.alert('Could not withdraw',
              code === 'crew_already_assigned'
                ? 'Crew is already assigned — stand the mission down with ops instead.'
                : code === 'booking_not_withdrawable'
                  ? 'This job has moved on — refresh the board.'
                  : (typeof code === 'string' ? code : 'Try again.'));
          }
          void load();
        })()},
      ],
    );
  }, [load]);

  // Only real, DEPLOYABLE, ON-DUTY CPOs are assignable to a mission crew:
  //  - member_role === 'cpo'         → not managers / employees / the owner (B-201)
  //  - agent_status ACTIVE/APPROVED  → documents verified by ops; a freshly
  //    created CPO is seeded DOCS_PENDING and must NOT appear until approved (B-200)
  //  - on_duty                       → an off-duty guard is NOT available; they
  //    must not appear NOR be assignable (B-202). The server rejects all three
  //    (cpo_not_in_org / cpo_not_approved_for_deployment / cpo_not_on_duty), so
  //    this just stops them showing as selectable and fires the empty state.
  const activeRoster = roster.filter(m =>
    m.status === 'active' &&
    m.member_role === 'cpo' &&
    (m.agent_status === 'ACTIVE' || m.agent_status === 'APPROVED') &&
    m.on_duty,
  );

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={D.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>MISSIONS</Text>
        {data.needs_crew.length > 0 && (
          <View style={s.needChip}><Text style={s.needChipText}>{data.needs_crew.length} NEEDS CREW</Text></View>
        )}
      </View>

      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent} onRefresh={() => { setRefreshing(true); void load(); }} />}>
        {loading ? (
          <LoadingView compact label="Loading missions…" />
        ) : error ? (
          <Text style={s.error}>{error}</Text>
        ) : data.needs_crew.length + data.active.length + data.recent.length === 0 ? (
          <View style={s.emptyCard}>
      <ImageryBackdrop source={Imagery.opsDispatch} variant="card" radius={22} />
            <Icon name="shield-check-outline" size={34} color={D.accentSoft} />
            <Text style={s.emptyTitle}>No jobs yet</Text>
            <Text style={s.emptySub}>Accepted jobs land here. Crew one with a leader to dispatch your team.</Text>
          </View>
        ) : (
          <>
            {data.needs_crew.length > 0 && (
              <View style={{gap: 10}}>
                <Text style={s.sectionLabel}>NEEDS CREW</Text>
                {data.needs_crew.map(j => <JobCard key={j.booking_id} job={j} onAssign={() => openSheet(j)} onWithdraw={() => withdraw(j)} />)}
              </View>
            )}
            {data.active.length > 0 && (
              <View style={{gap: 10}}>
                <Text style={s.sectionLabel}>ACTIVE</Text>
                {data.active.map(j => (
                  <JobCard key={j.booking_id} job={j}
                    onOpen={() => navigation.navigate('OrgMissionDetail', {job: j})}
                    onMonitor={j.mission_id ? () => navigation.navigate('AgentLiveTracker', {missionId: j.mission_id as string, mode: 'monitor'}) : undefined} />
                ))}
              </View>
            )}
            {data.recent.length > 0 && (() => {
              const pageCount = Math.ceil(data.recent.length / RECENT_PAGE_SIZE);
              const page = Math.min(recentPage, pageCount - 1);
              const pageItems = data.recent.slice(page * RECENT_PAGE_SIZE, page * RECENT_PAGE_SIZE + RECENT_PAGE_SIZE);
              return (
                <View style={{gap: 10}}>
                  <Text style={s.sectionLabel}>RECENT</Text>
                  {pageItems.map(j => <JobCard key={j.booking_id} job={j} onOpen={() => navigation.navigate('OrgMissionDetail', {job: j})} />)}
                  {pageCount > 1 && (
                    <View style={s.pager}>
                      {Array.from({length: pageCount}, (_, i) => i).map(i => (
                        <TouchableOpacity key={i} style={[s.pageBtn, i === page && s.pageBtnActive]}
                          activeOpacity={0.75} onPress={() => setRecentPage(i)}>
                          <Text style={[s.pageBtnText, i === page && s.pageBtnTextActive]}>{i + 1}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>
              );
            })()}
          </>
        )}

        <View style={{height: 20}} />
      </ScrollView>

      {/* ── Assign-crew sheet ── */}
      <Modal visible={!!sheetJob} transparent animationType="slide" onRequestClose={closeSheet}>
        <View style={s.sheetWrap}>
          <TouchableOpacity style={s.sheetScrim} activeOpacity={1} onPress={closeSheet} />
          <View style={[s.sheet, {paddingBottom: insets.bottom + 16}]}>
            <View style={s.sheetHandle} />
            <Text style={s.sheetTitle}>Assign crew</Text>
            <Text style={s.sheetSub}>
              Pick {sheetJob?.cpo_count ?? 0} guard{(sheetJob?.cpo_count ?? 0) > 1 ? 's' : ''} · {selected.size}/{sheetJob?.cpo_count ?? 0} selected · tap ★ for the leader
            </Text>
            <ScrollView style={{maxHeight: 380}} showsVerticalScrollIndicator={false}>
              {activeRoster.length === 0 ? (
                <View style={{alignItems: 'center', gap: 10, paddingVertical: 12}}>
                  <Text style={s.error}>No CPO is available. Officers must be verified by ops and on duty to be assigned.</Text>
                  {/* LM-A8 — was a dead end; jump straight to onboarding a guard. */}
                  <TouchableOpacity style={s.addCpoBtn} activeOpacity={0.85}
                    onPress={() => { closeSheet(); navigation.navigate('OrgCreateCpo'); }}>
                    <Icon name="account-plus" size={15} color={D.accentSoft} />
                    <Text style={s.addCpoText}>Add CPOs</Text>
                  </TouchableOpacity>
                </View>
              ) : activeRoster.map(m => {
                // LM-A4 — server-truth availability. Off-duty CPOs are filtered
                // out of activeRoster entirely (B-202), so the only remaining
                // blockers here are: already on another live mission, or missing
                // armed authorisation for an armed job.
                const isBusy = busy.has(m.member_user_id);
                const armedBlocked = !!sheetJob?.armed_required && !m.armed_authorized;
                const blocked = isBusy || armedBlocked;
                const isSel = selected.has(m.member_user_id);
                const isLead = leadId === m.member_user_id;
                const metaText = isBusy ? 'On a live mission'
                  : armedBlocked ? 'No armed authorisation'
                  : 'Available';
                return (
                  <View key={m.member_user_id} style={[s.pickRow, isSel && s.pickRowSel, blocked && {opacity: 0.45}]}>
                    <TouchableOpacity style={s.pickMain} activeOpacity={0.8} disabled={blocked} onPress={() => toggleSelect(m.member_user_id)}>
                      <View style={[s.checkBox, isSel && s.checkBoxOn]}>
                        {isSel && <Icon name="check" size={13} color="#fff" />}
                      </View>
                      <View style={s.pickAvatar}><Text style={s.pickInitials}>{initials(m.display_name)}</Text></View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <View style={{flexDirection: 'row', alignItems: 'center', gap: 6}}>
                          <Text style={s.pickName} numberOfLines={1}>{m.display_name ?? '—'}</Text>
                          {m.on_duty && !isBusy && <View style={s.dutyDot} />}
                          {m.armed_authorized && <Icon name="pistol" size={11} color={D.amber} />}
                        </View>
                        <Text style={s.pickMeta} numberOfLines={1}>{m.call_sign ? `${m.call_sign} · ` : ''}{metaText}</Text>
                      </View>
                    </TouchableOpacity>
                    <TouchableOpacity disabled={!isSel} onPress={() => setLeadId(m.member_user_id)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}} style={{paddingHorizontal: 6}}>
                      <Icon name={isLead ? 'star' : 'star-outline'} size={20} color={isLead ? D.amber : (isSel ? D.textMute : 'rgba(255,255,255,0.12)')} />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </ScrollView>
            <TouchableOpacity activeOpacity={0.85} disabled={submitting} onPress={() => void confirm()} style={{marginTop: 14}}>
              <LinearGradient colors={['#6E9BF5', D.accent, D.accentDeep]} style={[s.cta, submitting && {opacity: 0.6}]}>
                {submitting ? <ActivityIndicator color="#fff" /> : (
                  <><Icon name="send" size={18} color="#fff" /><Text style={s.ctaText}>Dispatch team</Text></>
                )}
              </LinearGradient>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  needChip: {paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(245,199,107,0.10)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.34)'},
  needChipText: {fontFamily: D.fBold, fontSize: 10, letterSpacing: 0.8, color: D.amber},
  body: {paddingHorizontal: 20, paddingTop: 4, gap: 20},
  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginLeft: 2},
  error: {color: D.alert, fontSize: 12, textAlign: 'center', marginTop: 24, fontFamily: D.fSans},

  card: {borderRadius: 18, padding: 15, gap: 9, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 10},
  cardService: {flex: 1, fontFamily: D.fBold, fontSize: 15, color: D.text, letterSpacing: -0.2},
  armedPill: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(245,199,107,0.10)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.30)'},
  armedText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 0.8, color: D.amber},
  cardMeta: {fontFamily: D.fSans, fontSize: 12, color: D.textDim},
  cardBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2},
  cardCount: {fontFamily: D.fSemi, fontSize: 12, color: D.textDim},
  assignChip: {flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  assignChipText: {fontFamily: D.fBold, fontSize: 9.5, letterSpacing: 0.8, color: D.accentSoft},
  statusChip: {fontFamily: D.fBold, fontSize: 9.5, letterSpacing: 1, color: D.signal},
  monitorBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 8, height: 40, borderRadius: 12,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  monitorText: {fontFamily: D.fBold, fontSize: 13, color: D.accentSoft, letterSpacing: 0.2},

  emptyCard: {alignItems: 'center', gap: 8, borderRadius: 22, paddingVertical: 40, paddingHorizontal: 24, borderWidth: 1, borderColor: D.hair2, backgroundColor: 'rgba(255,255,255,0.02)'},
  emptyTitle: {fontFamily: D.fBold, fontSize: 18, color: D.text, marginTop: 8},
  emptySub: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', lineHeight: 19, maxWidth: 260},

  // sheet
  sheetWrap: {flex: 1, justifyContent: 'flex-end'},
  sheetScrim: {...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)'},
  sheet: {backgroundColor: '#0C1018', borderTopLeftRadius: 26, borderTopRightRadius: 26, paddingHorizontal: 20, paddingTop: 12, borderWidth: 1, borderColor: D.hair2},
  sheetHandle: {alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.14)', marginBottom: 14},
  sheetTitle: {fontFamily: D.fBold, fontSize: 18, color: D.text, letterSpacing: -0.3},
  sheetSub: {fontFamily: D.fSans, fontSize: 12, color: D.textDim, marginTop: 4, marginBottom: 14},

  pickRow: {flexDirection: 'row', alignItems: 'center', borderRadius: 14, marginBottom: 8, paddingRight: 8, backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair2},
  pickRowSel: {backgroundColor: 'rgba(91,141,239,0.08)', borderColor: 'rgba(91,141,239,0.34)'},
  pickMain: {flex: 1, flexDirection: 'row', alignItems: 'center', gap: 11, paddingVertical: 11, paddingLeft: 12},
  checkBox: {width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  checkBoxOn: {backgroundColor: D.accent, borderColor: D.accent},
  pickAvatar: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  pickInitials: {fontFamily: D.fBold, fontSize: 12, color: D.accentSoft},
  pickName: {fontFamily: D.fBold, fontSize: 13.5, color: D.text, letterSpacing: -0.2},
  pickMeta: {fontFamily: D.fSans, fontSize: 11, color: D.textMute, marginTop: 1},

  cta: {height: 56, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
  // LM-A4/A8/F5 additions
  dutyDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: D.signal},
  addCpoBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 9,
    borderRadius: 999, backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  addCpoText: {fontFamily: D.fBold, fontSize: 12, color: D.accentSoft, letterSpacing: 0.3},
  sosPill: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 999, backgroundColor: D.alert},
  sosPillText: {fontFamily: D.fBold, fontSize: 9.5, letterSpacing: 1, color: '#fff'},

  // RECENT pagination — page-number strip under the 5-item page.
  pager: {flexDirection: 'row', justifyContent: 'center', gap: 8, marginTop: 4},
  pageBtn: {minWidth: 30, height: 30, borderRadius: 10, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  pageBtnActive: {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: 'rgba(91,141,239,0.4)'},
  pageBtnText: {fontFamily: D.fBold, fontSize: 12, color: D.textMute},
  pageBtnTextActive: {color: D.accentSoft},

  // JOB_PORTAL_MARKETPLACE_SPEC §3 — needs-crew withdraw row
  withdrawBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, marginTop: 6, height: 34,
    borderRadius: 10, backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair},
  withdrawText: {fontFamily: D.fSemi, fontSize: 11.5, color: D.textMute, letterSpacing: 0.2},
}));
