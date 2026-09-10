/**
 * CPO · Assigned Mission (BUILD_RUNBOOK Step 21) — the guard's Mission tab. Shows the brief
 * (principal, route, dress), the crew roster with the lead ★starred + "YOU", the shared
 * MissionStepper, and — for the LEAD only — the ONE context-aware control:
 *   DISPATCHED → Arrived at pickup · PICKUP → Client Picked Up (confirm) ·
 *   LIVE → Client Dropped Off (confirm).
 * Non-leads see the same job read-only ("the lead is advancing") with chat + SOS. A floating
 * SOS is always one tap once the detail is PICKUP/LIVE. On a failed transition the state never
 * lies (stays put); a re-tap after a lost-200 is safe (idempotency-keyed). Obsidian + cobalt.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, ActivityIndicator, RefreshControl,
  TextInput,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useNavigation} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {agentApi} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import {missionActionView, missionActionConfirm} from './missionAction';
import {useMissionAdvance} from './useMissionAdvance';
import {useLeadTelemetry} from './useLeadTelemetry';
import {scaleTextStyles} from '@utils/scaling';
import LoadingView from '@components/LoadingView';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.09)', accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

type Deployment = Awaited<ReturnType<typeof agentApi.getMissionDeployment>>['data'];
const POLL_MS = 8000;

const CHECK_LABELS: Record<string, string> = {
  dress: 'Dress code', vehicle: 'Vehicle ready', equip: 'Equipment', briefing: 'Briefing done',
};

export default function AssignedMissionDetailScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  // B-184 — the executive hourly-comment TextInput sits in the scroll body; padding
  // the scroll by the IME overlap lets it scroll clear of the keyboard.
  const {overlap} = useKeyboardLayout();
  const navigation = useNavigation<{navigate: (n: string, p?: Record<string, unknown>) => void}>();
  const [missionId, setMissionId] = useState<string | null>(null);
  const [dep, setDep] = useState<Deployment | null>(null);
  const [status, setStatus] = useState<string>('');
  const [isLead, setIsLead] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [sosBusy, setSosBusy] = useState(false);
  const [marking, setMarking] = useState(false);
  const mounted = useRef(true);
  // Monotonic request token: only the LATEST-issued load() may write state. Prevents an
  // older in-flight poll (that read a pre-transition status) from clobbering the truth a
  // newer read just wrote — e.g. resurrecting the Finish button after a successful complete.
  const reqGen = useRef(0);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    const gen = ++reqGen.current;
    const fresh = () => mounted.current && gen === reqGen.current;
    try {
      const {data: am} = await agentApi.getActiveMission();
      if (!fresh()) { return; }
      if (!am) { setMissionId(null); setDep(null); setStatus(''); return; }
      setMissionId(am.mission_id);
      setStatus(am.status);
      setIsLead(am.is_lead);
      // Mission-scoped latch: a poll that momentarily lags a just-submitted stamp
      // cannot un-verify THIS mission (the latch holds while the id matches), but a
      // NEW active mission resets it — the critic's F1: a persistent-tab OR-latch
      // carried mission A's verified into mission B and blocked B's handshake.
      setVerifiedMission(v =>
        am.identity_verified ? am.mission_id
          : (v === am.mission_id ? v : null));
      try {
        const {data} = await agentApi.getMissionDeployment(am.mission_id);
        if (!fresh()) { return; }
        setDep(data);
        if (data.mission?.status) { setStatus(data.mission.status); }
        if (data.crew_role) { setIsLead(data.crew_role.is_lead); }
      } catch { /* keep the active-mission summary */ }
    } finally { if (fresh()) { setLoading(false); setRefreshing(false); } }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // LM-C5 — stream the lead's GPS while the Mission tab is open (previously the
  // dot only moved while the buried lead-console overlay was mounted).
  useLeadTelemetry(missionId, isLead, status);

  const av = missionActionView(status, isLead);

  // The transition itself lives in useMissionAdvance so the driver's live tracker
  // renders the SAME contextual action through the SAME call — never a second copy.
  const {acting, runAction} = useMissionAdvance(missionId, load);

  // LM-C2 — self-acknowledge a deploy check; all four gate the lead's Start.
  const [ackBusy, setAckBusy] = useState<string | null>(null);
  const ackCheck = useCallback(async (key: string) => {
    if (!missionId || ackBusy) {return;}
    setAckBusy(key);
    try {
      await agentApi.acknowledgeDeployCheck(missionId, key);
      await load();
    } catch (e: unknown) {
      Alert.alert('Could not acknowledge', (e as Error).message ?? 'Try again.');
    } finally { setAckBusy(null); }
  }, [missionId, ackBusy, load]);

  // LM-C4 — non-lead "I'm in position" check-in.
  const [checkinBusy, setCheckinBusy] = useState(false);
  const [checkedIn, setCheckedIn] = useState(false);
  const checkIn = useCallback(async () => {
    if (!missionId || checkinBusy) {return;}
    setCheckinBusy(true);
    try {
      await agentApi.crewCheckIn(missionId);
      setCheckedIn(true);
    } catch (e: unknown) {
      Alert.alert('Check-in failed', (e as Error).message ?? 'Try again.');
    } finally { setCheckinBusy(false); }
  }, [missionId, checkinBusy]);

  // F3 — the lead's half of the on-arrival identity handshake: the rotating
  // code the CLIENT compares against. Fetched while DISPATCHED/PICKUP.
  const [verifyCode, setVerifyCode] = useState<string | null>(null);
  // FRAUD-2 / P0 — the lead ENTERS the arrival code the principal shows, proving
  // presence. `verified` seeds from the mission read so the badge persists across
  // reopens; the guard ref is a synchronous double-tap latch (NAV_RAPID_USE_LOOP).
  const [arrivalInput, setArrivalInput] = useState('');
  const [verifyBusy, setVerifyBusy] = useState(false);
  // The MISSION the handshake succeeded for (locally or server-read) — NOT a bare
  // boolean. This screen is a persistent tab (never unmounts across a duty session),
  // so a component-scoped latch would carry mission A's "verified" into mission B,
  // hide B's entry input, and (once the flag is on) silently block B's escrow release.
  const [verifiedMission, setVerifiedMission] = useState<string | null>(null);
  const verified = verifiedMission !== null && verifiedMission === missionId;
  const [verifyErr, setVerifyErr] = useState<string | null>(null);
  const verifyGuard = useRef(false);
  const submitArrival = useCallback(async () => {
    const code = arrivalInput.trim();
    if (!missionId || verifyGuard.current || code.length !== 6) {return;}
    verifyGuard.current = true;
    setVerifyBusy(true);
    setVerifyErr(null);
    try {
      const {data} = await agentApi.verifyArrival(missionId, code);
      if (!mounted.current) {return;}
      if (data.verified) {
        setVerifiedMission(missionId);
        setArrivalInput('');
      }
    } catch (e: unknown) {
      if (!mounted.current) {return;}
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      setVerifyErr(
        msg === 'verify_code_mismatch' ? 'That code doesn’t match. Ask the principal to read it again.'
          : msg === 'lead_only' ? 'Only the lead officer can confirm the arrival code.'
          : 'Could not confirm the code. Check your connection and try again.',
      );
    } finally {
      if (mounted.current) {setVerifyBusy(false);}
      verifyGuard.current = false;
    }
  }, [arrivalInput, missionId]);
  useEffect(() => {
    const stNow = status.toUpperCase();
    if (!missionId || !isLead || (stNow !== 'DISPATCHED' && stNow !== 'PICKUP')) {
      setVerifyCode(null);
      return undefined;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const pull = async () => {
      try {
        const {data} = await agentApi.missionVerifyCode(missionId);
        if (!alive) {return;}
        setVerifyCode(data.code);
        const ms = Math.max(5_000, new Date(data.rotates_at).getTime() - Date.now());
        timer = setTimeout(() => { void pull(); }, Math.min(ms, 60_000));
      } catch {
        if (alive) {timer = setTimeout(() => { void pull(); }, 20_000);}
      }
    };
    void pull();
    return () => { alive = false; if (timer) {clearTimeout(timer);} };
  }, [missionId, isLead, status]);

  // Executive Protection — the lead confirms each ELAPSED hour ("all smooth" + comment).
  const [hourBusy, setHourBusy] = useState(false);
  const [hourComment, setHourComment] = useState('');
  const confirmHour = useCallback(async (hourIndex: number) => {
    if (!missionId || hourBusy) {return;}
    setHourBusy(true);
    try {
      await agentApi.hourlyCheckin(missionId, hourIndex, hourComment);
      setHourComment('');
      await load();
    } catch (e: unknown) {
      const raw = (e as {response?: {data?: {code?: string; message?: string}}})?.response?.data;
      Alert.alert('Could not confirm hour',
        raw?.code === 'hour_not_elapsed'
          ? 'This hour hasn’t fully elapsed yet — try again shortly.'
          : raw?.message ?? (e as Error).message ?? 'Try again.');
    } finally { setHourBusy(false); }
  }, [missionId, hourBusy, hourComment, load]);

  // B-377 (Issue 41) — the officer's own accept/decline. The /respond endpoint
  // shipped 2026-07 with no client: `accepted_at` could never be written, so the
  // client's rail never reached "Team dispatched" and a decline went nowhere.
  const [respondBusy, setRespondBusy] = useState(false);
  const respond = useCallback(async (action: 'accept' | 'decline') => {
    if (!missionId || respondBusy) {return;}
    setRespondBusy(true);
    try {
      await agentApi.respondToMission(missionId, action);
      await load();
    } catch (e: unknown) {
      Alert.alert('Could not send response', (e as Error).message ?? 'Try again.');
    } finally { setRespondBusy(false); }
  }, [missionId, respondBusy, load]);
  const onDecline = useCallback(() => {
    if (respondBusy) {return;}   // guard BEFORE the dialog, or a fast double-tap stacks two
    Alert.alert('Decline this assignment?',
      'Your agency will be notified to re-assign the mission. You can still accept while the mission is waiting to start.',
      [{text: 'Cancel', style: 'cancel'},
       {text: 'Decline', style: 'destructive', onPress: () => { void respond('decline'); }}]);
  }, [respond, respondBusy]);

  // LM-C7 — crew asks the agency to close the mission (lead unreachable).
  const [reqBusy, setReqBusy] = useState(false);
  const requestCompletion = useCallback(() => {
    if (!missionId) {return;}
    Alert.alert('Request completion?',
      'Use this when the mission is finished but your lead can’t close it (phone dead / unreachable). Your agency will confirm.',
      [{text: 'Cancel', style: 'cancel'},
       {text: 'Request', onPress: () => {
         setReqBusy(true);
         agentApi.requestComplete(missionId)
           .then(() => Alert.alert('Requested', 'Your agency has been notified.'))
           .catch((e: unknown) => Alert.alert('Could not request', (e as Error).message ?? 'Try again.'))
           .finally(() => setReqBusy(false));
       }}]);
  }, [missionId]);

  // CPO-WAYPOINTS (#12) — lead-only manual waypoint mark from the Mission tab, so
  // the timeline fills as the lead advances without the buried lead console.
  const markWp = useCallback(async (tag: 'DISPATCH' | 'RECON' | 'PICKUP' | 'DROPOFF') => {
    if (!missionId || marking) {return;}
    setMarking(true);
    try {
      await agentApi.markWaypoint(missionId, tag);
      await load();
    } catch (e: unknown) {
      Alert.alert('Mark failed', (e as Error).message ?? 'Try again.');
    } finally { setMarking(false); }
  }, [missionId, marking, load]);

  const onAdvance = useCallback(() => {
    if (av.action === 'none') {return;}
    if (!av.confirm) {
      void runAction(av.action);
      return;
    }
    // Why: the confirm branch used to hard-code runAction('finish') because Finish
    // was the only confirmed action. Client Picked Up now confirms too, so the
    // action MUST come from `av` — otherwise confirming a pickup would complete
    // the mission and release payment.
    const advance = av.action;
    const copy = missionActionConfirm(advance);
    if (!copy) { void runAction(advance); return; }
    Alert.alert(copy.title, copy.body, [
      {text: 'Cancel', style: 'cancel'},
      {text: copy.cta, style: copy.destructive ? 'destructive' : 'default', onPress: () => { void runAction(advance); }},
    ]);
  }, [av, runAction]);

  const raiseSos = useCallback(async () => {
    if (!missionId || sosBusy) {return;}
    setSosBusy(true);
    try {
      await agentApi.raiseSos(missionId, {reason: 'cpo_field_sos'});
      Alert.alert('SOS raised', 'Your crew and ops have been alerted.');
    } catch (e: unknown) {
      Alert.alert('SOS failed', (e as Error).message ?? 'Try again.');
    } finally { setSosBusy(false); }
  }, [missionId, sosBusy]);

  const st = status.toUpperCase();
  const showSos = !!missionId && (st === 'PICKUP' || st === 'LIVE' || st === 'SOS');

  if (loading) {
    return <View style={[s.root, {paddingTop: insets.top}]}><StatusBar barStyle="light-content" backgroundColor={D.bg} /><View style={s.center}><LoadingView label="Loading mission…" /></View></View>;
  }
  if (!missionId) {
    return (
      <View style={[s.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={D.bg} />
        <View style={s.center}>
          <View style={s.emptyIcon}><Icon name="shield-outline" size={34} color={D.textMute} /></View>
          <Text style={s.emptyTitle}>No active mission</Text>
          <Text style={s.emptySub}>When your agency assigns you to a detail it appears here.</Text>
          {/* Bravo Secure Pro — operations hands out a mission code instead. */}
          <TouchableOpacity
            style={s.proCodeBtn}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Enter a Pro mission code"
            onPress={() => navigation.navigate('CpoProMission' as never)}>
            <Icon name="shield-key-outline" size={16} color={D.accentSoft ?? '#A9C5FF'} />
            <Text style={s.proCodeBtnText}>Have a Mission Code?</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const crew = dep?.crew ?? [];
  const wp = dep?.waypoints ?? [];

  // B-377 — response card state: pending only while DISPATCHED and unanswered.
  const roleResp = dep?.crew_role;
  const responsePending = !!roleResp && !roleResp.accepted_at && !roleResp.declined_at && st === 'DISPATCHED';
  // A decline must be recoverable: mission_crew rows are PK'd on (mission, agent)
  // and re-crew is ON CONFLICT DO NOTHING, so nothing ever clears declined_at —
  // without this the officer is stuck on the banner and the client's rail never
  // advances. The server still allows accept while accepted_at IS NULL.
  const hasDeclined = !!roleResp?.declined_at && !roleResp?.accepted_at;
  const canUndoDecline = hasDeclined && st === 'DISPATCHED';

  // Executive Protection — no waypoints; the lead confirms each elapsed hour instead.
  const isExecMission = dep?.booking?.service === 'executive_protection';
  const execDuration = dep?.booking?.duration_hours ?? 0;
  const liveAtMs = dep?.mission?.live_at ? new Date(dep.mission.live_at).getTime() : null;
  const checkins = dep?.hourly_checkins ?? [];
  const confirmedHours = new Set(checkins.map(c => c.hour_index));
  // An hour is confirmable once it has elapsed (server allows a 2-min grace).
  const elapsedHours = liveAtMs
    ? Math.min(execDuration, Math.floor((Date.now() - liveAtMs + 120_000) / 3600_000))
    : 0;
  const nextDueHour = (() => {
    for (let h = 1; h <= elapsedHours; h++) {
      if (!confirmedHours.has(h)) {return h;}
    }
    return null;
  })();

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>{dep?.mission?.short_code ?? 'MISSION'}</Text>
        <Text style={[s.statusBadge, st === 'SOS' && {color: D.alert}]}>{st}</Text>
      </View>

      <ScrollView contentContainerStyle={[s.body, {paddingBottom: insets.bottom + (showSos ? 150 : 90) + overlap}]} showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent} onRefresh={() => { setRefreshing(true); void load(); }} />}>
        <View style={{marginBottom: 4}}><MissionStepper booking={{status: dep?.booking?.booking_status ?? 'CONFIRMED'}} mission={{status}} /></View>

        {/* B-377 — the officer confirms or declines the assignment (Issue 41). */}
        {responsePending && (
          <View style={s.respondCard}>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
              <Icon name="account-check-outline" size={16} color={D.accentSoft} />
              <Text style={s.respondTitle}>Confirm your assignment</Text>
            </View>
            <Text style={s.respondSub}>
              Accept to confirm you’re taking this detail, or decline so your agency can re-assign it.
            </Text>
            <View style={{flexDirection: 'row', gap: 10, marginTop: 4}}>
              <TouchableOpacity
                style={[s.respondBtn, s.respondAccept, respondBusy && {opacity: 0.6}]}
                disabled={respondBusy}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Accept assignment"
                onPress={() => { void respond('accept'); }}>
                {respondBusy ? <ActivityIndicator color="#fff" /> : (
                  <>
                    <Icon name="check" size={15} color="#fff" />
                    <Text style={s.respondBtnText}>ACCEPT</Text>
                  </>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.respondBtn, s.respondDecline, respondBusy && {opacity: 0.6}]}
                disabled={respondBusy}
                activeOpacity={0.85}
                accessibilityRole="button"
                accessibilityLabel="Decline assignment"
                onPress={onDecline}>
                <Text style={[s.respondBtnText, {color: D.alert}]}>DECLINE</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        {hasDeclined && (
          <View style={s.declinedBanner}>
            <Icon name="account-cancel-outline" size={15} color={D.alert} />
            <View style={{flex: 1, minWidth: 0, gap: 8}}>
              <Text style={s.declinedText}>You declined this assignment — your agency is re-assigning it.</Text>
              {canUndoDecline && (
                <TouchableOpacity
                  style={[s.undoDeclineBtn, respondBusy && {opacity: 0.6}]}
                  disabled={respondBusy}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel="Accept this assignment after all"
                  onPress={() => { void respond('accept'); }}>
                  {respondBusy ? <ActivityIndicator color={D.accentSoft} /> : (
                    <Text style={s.undoDeclineText}>ACCEPT AFTER ALL</Text>
                  )}
                </TouchableOpacity>
              )}
            </View>
          </View>
        )}

        {/* Principal + route */}
        <View style={s.card}>
          {dep?.booking?.client_name && (
            <View style={s.cardRow}><Icon name="account-tie" size={15} color={D.accentSoft} /><Text style={s.cardVal}>{dep.booking.client_name}</Text></View>
          )}
          {isExecMission && (
            <View style={s.cardRow}>
              <Icon name="shield-crown" size={15} color={D.accentSoft} />
              <Text style={s.cardVal}>
                Executive Protection · {(dep?.booking?.task_type ?? 'site_protection').replace(/_/g, ' ')} · {execDuration}h block
              </Text>
            </View>
          )}
          <View style={s.cardRow}><Icon name="map-marker" size={15} color={D.signal} /><Text style={s.cardVal} numberOfLines={2}>{dep?.booking?.pickup_address ?? '—'}</Text></View>
          {dep?.booking?.dropoff_address && (
            <View style={s.cardRow}><Icon name="map-marker-check" size={15} color={D.amber} /><Text style={s.cardVal} numberOfLines={2}>{dep.booking.dropoff_address}</Text></View>
          )}
          {isExecMission && dep?.booking?.exec_transport && (
            <View style={s.cardRow}>
              <Icon name="car-estate" size={15} color={D.amber} />
              <Text style={s.cardSub} numberOfLines={3}>
                Transfer ({String(dep.booking.exec_transport.mode).replace(/_/g, ' ')}) ·{' '}
                {dep.booking.exec_transport.pickup?.address ?? '—'} → {dep.booking.exec_transport.dropoff?.address ?? '—'}
                {' · '}{dep.booking.exec_transport.passengers} pax
              </Text>
            </View>
          )}
          {isExecMission && !!dep?.booking?.notes && (
            <View style={s.cardRow}><Icon name="text" size={15} color={D.textMute} /><Text style={s.cardSub} numberOfLines={12}>{dep.booking.notes}</Text></View>
          )}
          {dep?.dress_instructions && (
            <View style={s.cardRow}><Icon name="tshirt-crew" size={15} color={D.textMute} /><Text style={s.cardSub}>{dep.dress_instructions}</Text></View>
          )}
        </View>

        {/* F3 — the lead shows this code to the client on arrival; it must match
            the client's screen. Rotates server-side. */}
        {isLead && verifyCode && (st === 'DISPATCHED' || st === 'PICKUP') && (
          <View style={s.verifyCard}>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
              <Icon name="shield-account" size={15} color={D.accentSoft} />
              <Text style={s.verifyTitle}>Arrival code — show the principal</Text>
            </View>
            <Text style={s.verifyCode}>{verifyCode}</Text>
          </View>
        )}

        {/* FRAUD-2 / P0 — the lead ENTERS the arrival code the principal reads out,
            proving presence server-side (gates escrow release once the flag is on). */}
        {isLead && (st === 'DISPATCHED' || st === 'PICKUP') && (
          <View style={s.verifyCard}>
            <View style={{flexDirection: 'row', alignItems: 'center', gap: 8}}>
              <Icon name={verified ? 'shield-check' : 'shield-key'} size={15} color={verified ? D.signal : D.accentSoft} />
              <Text style={s.verifyTitle}>{verified ? 'Principal identity confirmed' : 'Confirm the principal'}</Text>
            </View>
            {verified ? (
              <Text style={s.verifySub}>You entered the principal’s arrival code — presence is verified.</Text>
            ) : (
              <>
                <Text style={s.verifySub}>Ask the principal for the arrival code on their screen and enter it here:</Text>
                <TextInput
                  style={s.arrivalInput}
                  value={arrivalInput}
                  onChangeText={t => { setArrivalInput(t.replace(/[^0-9]/g, '').slice(0, 6)); setVerifyErr(null); }}
                  keyboardType="number-pad"
                  maxLength={6}
                  placeholder="000000"
                  placeholderTextColor={D.textMute}
                  editable={!verifyBusy}
                  returnKeyType="done"
                  onSubmitEditing={() => { void submitArrival(); }}
                  accessibilityLabel="Principal arrival code"
                />
                {verifyErr && <Text style={s.arrivalErr}>{verifyErr}</Text>}
                <TouchableOpacity
                  style={[s.arrivalBtn, (arrivalInput.length !== 6 || verifyBusy) && {opacity: 0.5}]}
                  activeOpacity={0.85}
                  disabled={arrivalInput.length !== 6 || verifyBusy}
                  onPress={() => { void submitArrival(); }}
                  accessibilityRole="button"
                  accessibilityLabel="Confirm the principal's arrival code">
                  <Text style={s.arrivalBtnText}>{verifyBusy ? 'Confirming…' : 'Confirm code'}</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}

        {/* LM-C2 — the four deploy checks (seeded at crew-assign, previously
            invisible on the CPO shell). All four gate the lead's Start. */}
        {st === 'DISPATCHED' && (dep?.checks?.length ?? 0) > 0 && (
          <>
            <Text style={s.sectionLabel}>DEPLOY CHECKS · {(dep?.checks ?? []).filter(c => c.state !== 'pending').length}/{dep?.checks?.length ?? 0}</Text>
            {(dep?.checks ?? []).map(c => {
              const done = c.state !== 'pending';
              return (
                <TouchableOpacity key={c.check_key} style={s.wpRow} activeOpacity={done ? 1 : 0.8}
                  disabled={done || ackBusy !== null}
                  onPress={() => { void ackCheck(c.check_key); }}>
                  <Icon name={done ? 'check-circle' : 'circle-outline'} size={15}
                    color={done ? D.signal : (ackBusy === c.check_key ? D.accentSoft : D.textMute)} />
                  <Text style={s.wpText}>{CHECK_LABELS[c.check_key] ?? c.check_key}</Text>
                  <Text style={s.wpEvent}>{done ? 'Confirmed' : ackBusy === c.check_key ? 'Confirming…' : 'Tap to confirm'}</Text>
                </TouchableOpacity>
              );
            })}
          </>
        )}

        {/* Crew roster */}
        {crew.length > 0 && (
          <>
            <Text style={s.sectionLabel}>CREW</Text>
            {crew.map((c, i) => (
              <View key={`${c.team_idx}-${i}`} style={[s.crewRow, c.is_me && s.crewRowMe]}>
                <Icon name={c.is_lead ? 'star' : 'shield-account'} size={16} color={c.is_lead ? D.amber : D.accentSoft} />
                <Text style={s.crewName}>{c.call_sign ?? `Officer ${c.team_idx + 1}`}</Text>
                {c.is_me && <Text style={s.youTag}>YOU</Text>}
                <Text style={s.crewRole}>{c.is_lead ? 'LEAD' : c.role}</Text>
              </View>
            ))}
          </>
        )}

        {/* Executive Protection — hourly check-ins replace the waypoint timeline: the
            lead confirms each ELAPSED hour ("all smooth" + optional comment). */}
        {isExecMission && execDuration > 0 && (
          <>
            <Text style={s.sectionLabel}>
              HOURLY CHECK-INS · {checkins.length}/{execDuration}
            </Text>
            {st !== 'LIVE' && st !== 'SOS' && st !== 'COMPLETED' && (
              <View style={s.wpRow}>
                <Icon name="clock-outline" size={15} color={D.textMute} />
                <Text style={s.wpEvent}>The hourly clock starts when you go live.</Text>
              </View>
            )}
            {Array.from({length: execDuration}, (_, i) => i + 1).map(h => {
              const done = confirmedHours.has(h);
              const checkin = checkins.find(c => c.hour_index === h);
              const due = !done && h <= elapsedHours;
              return (
                <View key={h} style={[s.wpRow, due && s.hourRowDue]}>
                  <Icon
                    name={done ? 'check-circle' : due ? 'progress-clock' : 'circle-outline'}
                    size={15}
                    color={done ? D.signal : due ? D.amber : D.textMute}
                  />
                  <Text style={s.wpText}>Hour {h}</Text>
                  <Text style={s.wpEvent} numberOfLines={2}>
                    {done
                      ? `${checkin?.status === 'ISSUE' ? 'Issue reported' : 'All smooth'}${checkin?.comment ? ` — ${checkin.comment}` : ''}`
                      : due ? 'Elapsed — confirm below' : 'Upcoming'}
                  </Text>
                </View>
              );
            })}
            {isLead && nextDueHour !== null && (st === 'LIVE' || st === 'SOS') && (
              <>
                <TextInput
                  style={s.hourComment}
                  value={hourComment}
                  onChangeText={t => setHourComment(t.slice(0, 300))}
                  placeholder={`Hour ${nextDueHour} note (optional) — anything to report?`}
                  placeholderTextColor={D.textMute}
                  multiline
                  maxLength={300}
                  accessibilityLabel="Hourly check-in comment"
                />
                <TouchableOpacity
                  style={[s.hourConfirmBtn, hourBusy && {opacity: 0.6}]}
                  activeOpacity={0.85}
                  disabled={hourBusy}
                  accessibilityRole="button"
                  accessibilityLabel={`Confirm hour ${nextDueHour} — everything is going smooth`}
                  onPress={() => { void confirmHour(nextDueHour); }}>
                  {hourBusy ? <ActivityIndicator color="#fff" /> : (
                    <>
                      <Icon name="check-decagram" size={17} color="#fff" />
                      <Text style={s.hourConfirmText}>Confirm Hour {nextDueHour} — all smooth</Text>
                    </>
                  )}
                </TouchableOpacity>
              </>
            )}
            {!isLead && nextDueHour !== null && (st === 'LIVE' || st === 'SOS') && (
              <View style={s.wpRow}>
                <Icon name="account-supervisor" size={15} color={D.textMute} />
                <Text style={s.wpEvent}>Your team lead confirms the hourly check-ins.</Text>
              </View>
            )}
          </>
        )}

        {/* Waypoints — CPO-WAYPOINTS (#12): they fill as the lead advances (FSM
            auto-settles on Start/Finish; the lead can also mark the next one here). */}
        {wp.length > 0 && (() => {
          const MANUAL = ['DISPATCH', 'RECON', 'PICKUP', 'DROPOFF'] as const;
          const done = wp.filter(w => w.state === 'done').length;
          const active = status === 'DISPATCHED' || status === 'PICKUP' || status === 'LIVE';
          const nextManual = MANUAL.find(tag => {
            const w = wp.find(x => x.tag === tag);
            return w && w.state !== 'done';
          });
          return (
          <>
            <Text style={s.sectionLabel}>WAYPOINTS · {done}/{wp.length}</Text>
            {wp.map(w => (
              <View key={w.seq} style={s.wpRow}>
                <Icon name={w.state === 'done' ? 'check-circle' : 'circle-outline'} size={15} color={w.state === 'done' ? D.signal : D.textMute} />
                <Text style={s.wpText}>{w.tag}</Text>
                <Text style={s.wpEvent}>{w.event}</Text>
              </View>
            ))}
            {isLead && active && nextManual ? (
              <TouchableOpacity style={s.commsBtn} activeOpacity={0.85} disabled={marking}
                onPress={() => { void markWp(nextManual); }}>
                <Icon name="map-marker-check" size={16} color={D.accentSoft} />
                <Text style={s.commsText}>{marking ? 'Marking…' : `Mark ${nextManual}`}</Text>
              </TouchableOpacity>
            ) : null}
          </>
          );
        })()}

        {(st === 'DISPATCHED' || st === 'PICKUP' || st === 'LIVE') && (
          <TouchableOpacity style={s.navBtn} activeOpacity={0.85}
            onPress={() => navigation.navigate('CpoLiveTracker', {missionId, mode: 'cpo'})}>
            <Icon name="navigation-variant" size={17} color="#fff" />
            <Text style={s.navBtnText}>Open live map · Navigate</Text>
          </TouchableOpacity>
        )}

        <TouchableOpacity style={s.commsBtn} activeOpacity={0.85} onPress={() => navigation.navigate('CpoComms')}>
          <Icon name="message-text" size={17} color={D.accentSoft} />
          <Text style={s.commsText}>Open Ops Room</Text>
        </TouchableOpacity>

        {/* LM-C4 — non-lead "I'm in position" (the lead's Start speaks for them). */}
        {!isLead && (st === 'DISPATCHED' || st === 'PICKUP') && (
          <TouchableOpacity style={[s.commsBtn, checkedIn && {opacity: 0.55}]} activeOpacity={0.85}
            disabled={checkinBusy || checkedIn} onPress={() => void checkIn()}>
            <Icon name={checkedIn ? 'check-circle' : 'map-marker-account'} size={17} color={checkedIn ? D.signal : D.accentSoft} />
            <Text style={[s.commsText, checkedIn && {color: D.signal}]}>
              {checkedIn ? 'Checked in — in position' : checkinBusy ? 'Checking in…' : 'I’m in position'}
            </Text>
          </TouchableOpacity>
        )}

        {/* LM-C7 — crew fallback when the lead can't close a finished mission. */}
        {!isLead && (st === 'LIVE' || st === 'SOS') && (
          <TouchableOpacity style={s.commsBtn} activeOpacity={0.85} disabled={reqBusy} onPress={requestCompletion}>
            <Icon name="flag-checkered" size={17} color={D.accentSoft} />
            <Text style={s.commsText}>{reqBusy ? 'Requesting…' : 'Request completion via agency'}</Text>
          </TouchableOpacity>
        )}
      </ScrollView>

      {/* Floating SOS (PICKUP/LIVE) */}
      {showSos && (
        <TouchableOpacity style={[s.sosFab, {bottom: bottomPad(av.action !== 'none' ? 80 : 18)}]} activeOpacity={0.85}
          disabled={sosBusy} onPress={() => void raiseSos()}>
          {sosBusy ? <ActivityIndicator color="#fff" /> : <><Icon name="alarm-light" size={18} color="#fff" /><Text style={s.sosText}>SOS</Text></>}
        </TouchableOpacity>
      )}

      {/* Context-aware lead control (or read-only note for non-lead) */}
      <View style={[s.footer, {paddingBottom: bottomPad(14)}]}>
        {av.action !== 'none' ? (
          <TouchableOpacity activeOpacity={0.85} disabled={acting} onPress={onAdvance}
            style={[s.advanceBtn, av.confirm && {backgroundColor: D.signal}, acting && {opacity: 0.6}]}>
            {acting ? <ActivityIndicator color="#fff" /> : (
              <><Icon name={av.action === 'finish' ? 'flag-checkered' : av.action === 'go-live' ? 'shield-check' : 'play'} size={19} color="#fff" />
                <Text style={s.advanceText}>{av.label}</Text></>
            )}
          </TouchableOpacity>
        ) : (
          <View style={s.readonly}>
            <Icon name={isLead ? 'check-circle-outline' : 'account-supervisor'} size={16} color={D.textMute} />
            <Text style={s.readonlyText}>{isLead ? 'No action right now' : 'Your team lead is advancing this mission'}</Text>
          </View>
        )}
      </View>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 36, gap: 10},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 22, paddingVertical: 16},
  accentBar: {width: 3, height: 16, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 15, letterSpacing: 1, color: D.text},
  statusBadge: {fontFamily: D.fBold, fontSize: 11, letterSpacing: 1.2, color: D.signal},
  body: {paddingHorizontal: 22, paddingTop: 4, gap: 10},
  emptyIcon: {width: 80, height: 80, borderRadius: 26, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair},
  proCodeBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 18,
    paddingVertical: 11, paddingHorizontal: 18, borderRadius: 13,
    backgroundColor: 'rgba(91,141,239,0.1)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
  },
  proCodeBtnText: {fontFamily: D.fBold, fontSize: 13, color: '#A9C5FF'},
  emptyTitle: {fontFamily: D.fBold, fontSize: 18, color: D.text, marginTop: 6},
  emptySub: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', lineHeight: 19, maxWidth: 250},
  card: {borderRadius: 16, padding: 15, gap: 9, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair},
  cardRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 10},
  cardVal: {flex: 1, fontFamily: D.fSemi, fontSize: 13.5, color: D.text, lineHeight: 19},
  cardSub: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, lineHeight: 18},
  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginTop: 8, marginLeft: 2},
  crewRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair},
  crewRowMe: {borderColor: 'rgba(91,141,239,0.3)', backgroundColor: 'rgba(91,141,239,0.06)'},
  crewName: {flex: 1, fontFamily: D.fBold, fontSize: 13.5, color: D.text},
  youTag: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 0.8, color: D.accentSoft, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 5, backgroundColor: 'rgba(91,141,239,0.14)'},
  crewRole: {fontFamily: D.fSemi, fontSize: 9.5, letterSpacing: 0.8, color: D.textMute},
  wpRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 11, backgroundColor: 'rgba(255,255,255,0.015)'},
  wpText: {fontFamily: D.fBold, fontSize: 12, color: D.textDim, width: 80},
  wpEvent: {flex: 1, fontFamily: D.fSans, fontSize: 11.5, color: D.textMute},
  navBtn: {flexDirection: 'row', gap: 8, height: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  navBtnText: {fontFamily: D.fBold, fontSize: 14.5, color: '#fff', letterSpacing: 0.3},
  commsBtn: {flexDirection: 'row', gap: 8, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  commsText: {fontFamily: D.fBold, fontSize: 14, color: D.accentSoft},
  sosFab: {position: 'absolute', right: 22, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, height: 48, borderRadius: 999,
    backgroundColor: D.alert, shadowColor: D.alert, shadowOpacity: 0.5, shadowRadius: 12, shadowOffset: {width: 0, height: 4}, elevation: 8},
  sosText: {fontFamily: D.fBold, fontSize: 14, letterSpacing: 0.5, color: '#fff'},
  footer: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 22, paddingTop: 12, borderTopWidth: 1, borderTopColor: D.hair, backgroundColor: D.bg},
  advanceBtn: {flexDirection: 'row', gap: 9, height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  advanceText: {fontFamily: D.fBold, fontSize: 15.5, color: '#fff', letterSpacing: 0.3},
  readonly: {flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', height: 48},
  readonlyText: {fontFamily: D.fSemi, fontSize: 13, color: D.textMute},
  // F3 — arrival-code card
  verifyCard: {borderRadius: 16, padding: 14, gap: 6, backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  verifyTitle: {fontFamily: D.fSemi, fontSize: 12, color: D.text},
  verifyCode: {fontFamily: D.fBold, fontSize: 26, letterSpacing: 6, color: D.accentSoft, textAlign: 'center', paddingVertical: 2},
  verifySub: {fontFamily: D.fSans, fontSize: 12, color: D.textDim, lineHeight: 17},
  arrivalInput: {
    height: 52, borderRadius: 13, paddingHorizontal: 14, marginTop: 2,
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair,
    fontFamily: D.fBold, fontSize: 24, letterSpacing: 8, color: D.text, textAlign: 'center',
  },
  arrivalErr: {fontFamily: D.fSans, fontSize: 11.5, color: D.alert, lineHeight: 16},
  arrivalBtn: {marginTop: 2, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: D.accent},
  arrivalBtnText: {fontFamily: D.fBold, fontSize: 13.5, color: '#0A1020'},
  // Executive Protection — hourly check-ins
  hourRowDue: {borderWidth: 1, borderColor: 'rgba(245,199,107,0.3)', backgroundColor: 'rgba(245,199,107,0.05)'},
  hourComment: {
    minHeight: 64, borderRadius: 13, padding: 12, marginTop: 8,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair,
    fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.text, textAlignVertical: 'top',
  },
  hourConfirmBtn: {
    flexDirection: 'row', gap: 8, minHeight: 50, borderRadius: 14, alignItems: 'center', justifyContent: 'center', marginTop: 8,
    paddingVertical: 8, paddingHorizontal: 12,
    backgroundColor: D.signal, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  hourConfirmText: {fontFamily: D.fBold, fontSize: 14, color: '#fff', letterSpacing: 0.2},
  // B-377 — assignment response card
  respondCard: {borderRadius: 16, padding: 14, gap: 8, backgroundColor: 'rgba(91,141,239,0.08)',
    borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  respondTitle: {fontFamily: D.fBold, fontSize: 13.5, color: D.text},
  respondSub: {fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textDim},
  respondBtn: {flex: 1, flexDirection: 'row', gap: 7, minHeight: 46, borderRadius: 13,
    alignItems: 'center', justifyContent: 'center'},
  respondAccept: {backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)'},
  respondDecline: {backgroundColor: 'rgba(239,91,91,0.08)', borderWidth: 1, borderColor: 'rgba(239,91,91,0.35)'},
  respondBtnText: {fontFamily: D.fBold, fontSize: 13.5, color: '#fff', letterSpacing: 0.4},
  declinedBanner: {flexDirection: 'row', alignItems: 'flex-start', gap: 9, borderRadius: 13, padding: 12,
    backgroundColor: 'rgba(239,91,91,0.06)', borderWidth: 1, borderColor: 'rgba(239,91,91,0.25)'},
  declinedText: {fontFamily: D.fSemi, fontSize: 12, lineHeight: 17, color: D.textDim},
  undoDeclineBtn: {alignSelf: 'flex-start', minHeight: 38, justifyContent: 'center',
    paddingHorizontal: 14, borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)'},
  undoDeclineText: {fontFamily: D.fBold, fontSize: 12, letterSpacing: 0.4, color: D.accentSoft},
}));
