/**
 * CPO · On Duty home (BUILD_RUNBOOK Step 21) — the guard's idle/standby surface. Duty toggle
 * (agentApi.setDuty + the Step-5 location heartbeat), the "you belong to {agency}" banner, the
 * assigned-mission card (getActiveMission → tap into the Mission tab), and today's shifts.
 * Calm "no active mission — stand by" empty state. Obsidian + cobalt, matching the CPO shell.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar, RefreshControl, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useShowOrgLabels, orgLabelFor} from '@screens/deptchat/crossOrgLabel';
import {useAuthStore} from '@store/authStore';
import {agentApi, attendanceApi} from '@services/api';
import {startOnDutyHeartbeat, stopOnDutyHeartbeat} from '@services/onDutyHeartbeat';
import MissionStepper from '@components/mission/MissionStepper';
import LoadingView from '@components/LoadingView';
import {scaleTextStyles} from '@utils/scaling';
import {DEPT_CHAT_V2} from '@utils/constants';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.09)', accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', amber: '#F5C76B', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

type ActiveMission = {mission_id: string; short_code: string; status: string; is_lead: boolean; pickup_address: string; dropoff_address: string | null; pickup_time: string} | null;
// org_name — this list is cross-org (vs2 item 4) and must name its rows.
type Shift = {id: string; status: string; clock_in_at: string; clock_out_at: string | null;
  org_name?: string | null};

export default function OnDutyHomeScreen() {
  const showOrgLabels = useShowOrgLabels();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<{navigate: (n: string) => void}>();
  const orgName = useAuthStore(s => s.user?.org?.name) ?? 'your agency';
  const recheckMembership = useAuthStore(s => s.recheckMembership);
  const [onDuty, setOnDuty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [mission, setMission] = useState<ActiveMission>(null);
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const load = useCallback(async () => {
    try {
      const [me, am, sh] = await Promise.all([
        agentApi.getMe().then(r => r.data).catch(() => null),
        agentApi.getActiveMission().then(r => r.data).catch(() => null),
        attendanceApi.myShifts().then(r => r.data).catch(() => []),
        // A promotion to manager must take effect on this screen's own
        // 15s poll / pull-to-refresh, not wait for the app to background
        // and foreground again. recheckMembership refreshes is_org_manager
        // from /auth/me; resolveAuthedRoute picks up the change on the next
        // render and swaps this whole shell for AgentNavigator.
        recheckMembership().catch(() => {}),
      ]);
      if (!mounted.current) { return; } // tab switched / unmounted mid-request
      if (me) { setOnDuty(me.agent.on_duty); }
      setMission(am as ActiveMission);
      setShifts((sh as Shift[]).slice(0, 4));
    } finally { if (mounted.current) { setLoading(false); setRefreshing(false); } }
  }, [recheckMembership]);

  useEffect(() => { void load(); }, [load]);

  // LM-C1 — the landing tab previously loaded ONCE, so a new assignment never
  // appeared until a manual pull. Reload on focus + poll every 15s while focused
  // (the mission tab polls 8s; this is the discovery surface, so it must move).
  useFocusEffect(useCallback(() => {
    void load();
    const t = setInterval(() => { void load(); }, 15_000);
    return () => clearInterval(t);
  }, [load]));

  // Drive the duty location heartbeat off the on-duty flag (Step 5).
  useEffect(() => {
    if (onDuty) { startOnDutyHeartbeat(); } else { stopOnDutyHeartbeat(); }
    return () => stopOnDutyHeartbeat();
  }, [onDuty]);

  const toggleDuty = useCallback(async () => {
    if (busy) {return;}
    const next = !onDuty;
    setBusy(true);
    setOnDuty(next); // optimistic
    try {
      await agentApi.setDuty(next);
      const {data} = await agentApi.getMe();
      if (mounted.current) { setOnDuty(data.agent.on_duty); }
    } catch {
      if (mounted.current) { setOnDuty(!next); } // rollback
    } finally { if (mounted.current) { setBusy(false); } }
  }, [busy, onDuty]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>ON DUTY</Text>
        <View style={[s.dutyDot, {backgroundColor: onDuty ? D.signal : D.textMute}]} />
      </View>

      <ScrollView contentContainerStyle={[s.body, {paddingBottom: insets.bottom + 24}]} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent} onRefresh={() => { setRefreshing(true); void load(); }} />}>
        {/* Agency banner */}
        <View style={s.orgBanner}>
          <Icon name="shield-account" size={18} color={D.accentSoft} />
          <Text style={s.orgText}>You belong to <Text style={s.orgName}>{orgName}</Text></Text>
        </View>

        {/* Dept Chat v2 (Step 19) — the CPO's single entry into the dedicated
            Departmental module (attendance check-in, channels, report incident,
            vault). Pushed full-screen over the guard shell. Dark behind the flag. */}
        {DEPT_CHAT_V2 && (
          <TouchableOpacity activeOpacity={0.9} onPress={() => navigation.navigate('Departmental')} style={s.deptCard}>
            <View style={s.deptIcon}><Icon name="office-building-outline" size={20} color={D.accentSoft} /></View>
            <View style={{flex: 1}}>
              <Text style={s.deptTitle}>Department</Text>
              <Text style={s.deptSub}>Attendance · channels · report incident</Text>
            </View>
            <Icon name="chevron-right" size={18} color={D.accentSoft} />
          </TouchableOpacity>
        )}

        {/* Duty toggle */}
        <TouchableOpacity activeOpacity={0.9} onPress={() => void toggleDuty()} disabled={busy}
          style={[s.dutyCard, onDuty && s.dutyCardOn]}>
          <View style={{flex: 1}}>
            <Text style={[s.dutyLabel, onDuty && {color: D.signal}]}>{onDuty ? 'ON DUTY' : 'OFF DUTY'}</Text>
            <Text style={s.dutySub}>{onDuty ? 'Your agency can dispatch you. Location shared while on duty.' : 'Go on duty to be dispatched to details.'}</Text>
          </View>
          {busy ? <ActivityIndicator color={D.accent} /> : (
            <View style={[s.switch, onDuty && s.switchOn]}><View style={[s.knob, onDuty && s.knobOn]} /></View>
          )}
        </TouchableOpacity>

        {/* Protection sessions (spec §6) — CPO monitoring surface */}
        <Text style={s.sectionLabel}>PROTECTION</Text>
        <TouchableOpacity activeOpacity={0.9} onPress={() => navigation.navigate('CpoProtection')} style={s.missionCard}
          accessibilityRole="button" accessibilityLabel="Open protection sessions">
          <Text style={s.missionRoute} numberOfLines={1}>Assigned customers & live sessions</Text>
          <View style={s.openRow}>
            <Text style={s.openText}>Open protection</Text>
            <Icon name="chevron-right" size={16} color={D.accentSoft} />
          </View>
        </TouchableOpacity>

        {/* Assigned mission card */}
        <Text style={s.sectionLabel}>YOUR MISSION</Text>
        {loading ? <View style={{marginTop: 12}}><LoadingView compact label="Loading mission…" /></View>
          : mission ? (
            <TouchableOpacity activeOpacity={0.9} onPress={() => navigation.navigate('CpoMission')} style={s.missionCard}>
              <View style={s.missionTop}>
                <Text style={s.missionCode}>{mission.short_code}</Text>
                <View style={[s.chip, mission.is_lead ? {borderColor: 'rgba(245,199,107,0.4)', backgroundColor: 'rgba(245,199,107,0.10)'} : {borderColor: D.hair}]}>
                  <Text style={[s.chipText, {color: mission.is_lead ? D.amber : D.textDim}]}>{mission.is_lead ? '★ LEAD' : 'CREW'}</Text>
                </View>
              </View>
              <Text style={s.missionRoute} numberOfLines={1}>
                {mission.pickup_address.split(',')[0]} → {(mission.dropoff_address ?? '—').split(',')[0]}
              </Text>
              <View style={{marginTop: 8}}>
                <MissionStepper booking={{status: 'CONFIRMED'}} mission={{status: mission.status}} />
              </View>
              <View style={s.openRow}>
                <Text style={s.openText}>Open mission</Text>
                <Icon name="chevron-right" size={16} color={D.accentSoft} />
              </View>
            </TouchableOpacity>
          ) : (
            <View style={s.empty}>
              <ImageryBackdrop source={Imagery.cpoStandby} variant="card" radius={18} />
              <Icon name="shield-outline" size={32} color={D.textMute} />
              <Text style={s.emptyTitle}>No active mission</Text>
              <Text style={s.emptySub}>Stand by — your agency will assign you to a detail.</Text>
            </View>
          )}

        {/* Today's shifts */}
        {shifts.length > 0 && (
          <>
            <Text style={s.sectionLabel}>RECENT SHIFTS</Text>
            {shifts.map(sh => (
              <View key={sh.id} style={s.shiftRow}>
                <Icon name={sh.status === 'open' ? 'clock-outline' : 'check-circle-outline'} size={16} color={sh.status === 'open' ? D.signal : D.textMute} />
                <Text style={s.shiftText}>{new Date(sh.clock_in_at).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</Text>
                {/* Cross-org list under a banner that names ONE company — the
                    misattribution the labelling decision exists to remove. */}
                {orgLabelFor(sh, showOrgLabels) ? (
                  <Text style={s.shiftOrg} numberOfLines={1}>{orgLabelFor(sh, showOrgLabels)}</Text>
                ) : null}
                <Text style={s.shiftStatus}>{sh.status === 'open' ? 'ON SHIFT' : 'CLOSED'}</Text>
              </View>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 22, paddingVertical: 16},
  accentBar: {width: 3, height: 16, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  dutyDot: {width: 9, height: 9, borderRadius: 5},
  body: {paddingHorizontal: 22, paddingTop: 4, gap: 12},
  orgBanner: {flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13, borderRadius: 14,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)'},
  orgText: {fontFamily: D.fSans, fontSize: 13, color: D.textDim},
  orgName: {fontFamily: D.fBold, color: D.text},
  deptCard: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 15, borderRadius: 16,
    backgroundColor: 'rgba(91,141,239,0.09)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.32)'},
  deptIcon: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  deptTitle: {fontFamily: D.fBold, fontSize: 15, color: D.text, letterSpacing: 0.2},
  deptSub: {fontFamily: D.fSans, fontSize: 12, color: D.textDim, marginTop: 2},
  dutyCard: {flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair},
  dutyCardOn: {borderColor: 'rgba(74,222,128,0.30)', backgroundColor: 'rgba(74,222,128,0.05)'},
  dutyLabel: {fontFamily: D.fBold, fontSize: 16, color: D.text, letterSpacing: 0.5},
  dutySub: {fontFamily: D.fSans, fontSize: 12, lineHeight: 17, color: D.textMute, marginTop: 3},
  switch: {width: 50, height: 30, borderRadius: 15, padding: 3, backgroundColor: 'rgba(255,255,255,0.08)', justifyContent: 'center'},
  switchOn: {backgroundColor: 'rgba(74,222,128,0.30)'},
  knob: {width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff'},
  knobOn: {alignSelf: 'flex-end'},
  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginTop: 8, marginLeft: 2},
  missionCard: {borderRadius: 18, padding: 16, gap: 4, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair},
  missionTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  missionCode: {fontFamily: D.fBold, fontSize: 16, color: D.text, letterSpacing: 0.5},
  chip: {paddingHorizontal: 9, paddingVertical: 4, borderRadius: 7, borderWidth: 1},
  chipText: {fontFamily: D.fBold, fontSize: 9.5, letterSpacing: 0.8},
  missionRoute: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, marginTop: 2},
  openRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 2, marginTop: 8},
  openText: {fontFamily: D.fSemi, fontSize: 12, color: D.accentSoft},
  empty: {alignItems: 'center', gap: 7, paddingVertical: 30, borderRadius: 18, borderWidth: 1, borderColor: D.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  emptyTitle: {fontFamily: D.fBold, fontSize: 16, color: D.text, marginTop: 6},
  emptySub: {fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, textAlign: 'center', maxWidth: 240, lineHeight: 18},
  shiftRow: {flexDirection: 'row', alignItems: 'center', gap: 10, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.02)', borderWidth: 1, borderColor: D.hair},
  shiftText: {flex: 1, fontFamily: D.fSemi, fontSize: 12.5, color: D.textDim},
  shiftOrg: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 0.5, color: D.signal, maxWidth: 90},
  shiftStatus: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1, color: D.textMute},
}));
