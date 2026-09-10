/**
 * Provider · Mission Detail (SP-MISSION-DETAIL #2nd) — tap a mission on the agency
 * board to see the full picture: step flow, schedule, route, crew, escrow payout,
 * and a live-monitor entry. Obsidian theme to match OrgMissions; reuses the shared
 * MissionStepper. Privacy: no client phone/email — crew + addresses only.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, TouchableOpacity, StatusBar} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi, type OrgMissionDto} from '@services/api';
import MissionStepper from '@components/mission/MissionStepper';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type Rt = RouteProp<AgentStackParamList, 'OrgMissionDetail'>;

interface Escrow {
  status: string; basis: string | null; currency: string | null;
  gross_credits: number; to_provider_credits: number | null; platform_fee_credits: number | null;
}

const D = {
  bg: '#07090D', card: '#11151D', text: '#F2F4F8',
  textDim: 'rgba(229,233,242,0.62)', textMute: 'rgba(180,188,204,0.45)',
  hair: 'rgba(255,255,255,0.07)', accent: '#5B8DEF', accentSoft: '#A9C5FF',
  amber: '#F5C76B', signal: '#4ADE80',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold', fMono: 'monospace',
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleString(undefined, {weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

function CrewRow({callSign, role, lead}: {callSign: string | null; role: string; lead?: boolean}) {
  return (
    <View style={s.crewRow}>
      <Text style={s.crewName}>{lead ? '★ ' : ''}{callSign ?? '—'}</Text>
      <Text style={s.crewRole}>{role}</Text>
    </View>
  );
}

export default function OrgMissionDetailScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const {job: jobParam} = useRoute<Rt>().params;

  // LM-A1 — the nav param is a snapshot frozen when the board card was tapped;
  // crew/status changed elsewhere rendered a stale page (and the stepper lied).
  // Keep the param for instant paint, then re-fetch + poll the live row.
  const [job, setJob] = useState<OrgMissionDto>(jobParam);
  const [escrow, setEscrow] = useState<Escrow | null>(null);
  const [escrowLoaded, setEscrowLoaded] = useState(false);
  const [escrowError, setEscrowError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // Executive Protection — the hourly "all smooth" record + transfer legs/brief for the
  // desk (from the org live read; the board row only carries a presence flag).
  const [execCheckins, setExecCheckins] = useState<Array<{hour_index: number; comment: string | null}>>([]);
  const [execDetail, setExecDetail] = useState<{
    transport?: {mode?: string; pickup?: {address?: string}; dropoff?: {address?: string}; passengers?: number} | null;
    notes?: string | null;
  }>({});

  const load = useCallback(async () => {
    try {
      const {data} = await orgApi.getMissionEscrow(jobParam.booking_id);
      setEscrow(data);
      setEscrowError(false);
    } catch (e: unknown) {
      // LM-A7 — a legacy booking (404, no hold) is fine; anything else is a real
      // failure and must not silently render like "no payout".
      const status = (e as {response?: {status?: number}})?.response?.status;
      setEscrowError(status !== 404);
    } finally {
      setEscrowLoaded(true);
    }
    try {
      const {data} = await orgApi.listMissions();
      const fresh = [...data.needs_crew, ...data.active, ...data.recent]
        .find(j => j.booking_id === jobParam.booking_id);
      if (fresh) {setJob(fresh);}
      if (fresh?.service === 'executive_protection' && fresh.mission_id) {
        try {
          const {data: live} = await orgApi.getMissionLive(fresh.mission_id);
          setExecCheckins(live.hourly_checkins ?? []);
          setExecDetail({
            transport: (live.booking as {exec_transport?: typeof execDetail.transport} | null)?.exec_transport ?? null,
            notes: (live.booking as {notes?: string | null} | null)?.notes ?? null,
          });
        } catch { /* keep the last known timeline */ }
      }
    } catch { /* keep the last known row */ }
  }, [jobParam.booking_id]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, 8_000);
    return () => clearInterval(t);
  }, [load]);

  const lead = job.crew.find(c => c.is_lead);
  const others = job.crew.filter(c => !c.is_lead);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity onPress={() => goBackOnce(navigation)} style={s.back} activeOpacity={0.7}>
          <Icon name="chevron-left" size={26} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.title} numberOfLines={1}>{job.short_code ?? `Booking ${job.booking_id.slice(0, 8)}`}</Text>
          <Text style={s.sub} numberOfLines={1}>
            {job.region_label} · {job.service === 'executive_protection' ? 'Executive Protection' : job.service}
          </Text>
        </View>
      </View>

      <ScrollView contentContainerStyle={{padding: 18, paddingBottom: insets.bottom + 24, gap: 14}}>
        <MissionStepper booking={{status: job.booking_status}} mission={{status: job.mission_status}} />

        <View style={s.card}>
          <Text style={s.cardLabel}>SCHEDULE</Text>
          <View style={s.kv}>
            <Icon name="clock-outline" size={15} color={D.accentSoft} />
            <Text style={s.kvText}>{fmtTime(job.pickup_time)}</Text>
          </View>
        </View>

        {/* Executive Protection — the detail brief: task, fixed block, transfer legs, brief. */}
        {job.service === 'executive_protection' && (
          <View style={s.card}>
            <Text style={s.cardLabel}>EXECUTIVE DETAIL</Text>
            <View style={s.kv}>
              <Icon name="shield-crown" size={15} color={D.accentSoft} />
              <Text style={s.kvText}>
                {(job.task_type ?? 'site_protection').replace(/_/g, ' ')} · {job.duration_hours ?? '—'}h block
                {job.has_transport ? ' · secure transfer' : ' · protection only'}
              </Text>
            </View>
            {execDetail.transport && (
              <View style={s.kv}>
                <Icon name="car-estate" size={14} color={D.amber} />
                <Text style={s.kvText} numberOfLines={3}>
                  {String(execDetail.transport.mode ?? '').replace(/_/g, ' ')} ·{' '}
                  {execDetail.transport.pickup?.address ?? '—'} → {execDetail.transport.dropoff?.address ?? '—'}
                  {' · '}{execDetail.transport.passengers ?? '—'} pax
                </Text>
              </View>
            )}
            {!!execDetail.notes && (
              <View style={s.kv}>
                <Icon name="text" size={14} color={D.textMute} />
                <Text style={s.kvText} numberOfLines={4}>{execDetail.notes}</Text>
              </View>
            )}
          </View>
        )}

        <View style={s.card}>
          <View style={s.cardLabelRow}>
            <Text style={s.cardLabel}>{job.service === 'executive_protection' ? 'SERVICE LOCATION' : 'ROUTE'}</Text>
            {job.armed_required ? <View style={s.armedPill}><Text style={s.armedText}>ARMED</Text></View> : null}
          </View>
          <View style={s.kv}>
            <Icon name="circle-outline" size={13} color={D.accentSoft} />
            <Text style={s.kvText} numberOfLines={2}>{job.pickup_address}</Text>
          </View>
          {(job.service !== 'executive_protection' || job.dropoff_address) && (
            <View style={s.kv}>
              <Icon name="map-marker" size={14} color={D.accent} />
              <Text style={s.kvText} numberOfLines={2}>{job.dropoff_address ?? '—'}</Text>
            </View>
          )}
        </View>

        {/* Executive Protection — hourly check-ins as they land (lead confirms each hour). */}
        {job.service === 'executive_protection' && job.mission_id && (
          <View style={s.card}>
            <Text style={s.cardLabel}>
              HOURLY CHECK-INS · {execCheckins.length}/{job.duration_hours ?? '—'}
            </Text>
            {execCheckins.length === 0 ? (
              <Text style={s.muted}>Confirmations appear here once the detail is live.</Text>
            ) : (
              execCheckins.map(h => (
                <View key={h.hour_index} style={s.kv}>
                  <Icon
                    name={(h as {status?: string}).status === 'ISSUE' ? 'alert-circle' : 'check-circle'}
                    size={14}
                    color={(h as {status?: string}).status === 'ISSUE' ? D.amber : D.signal}
                  />
                  <Text style={s.kvText} numberOfLines={2}>
                    Hour {h.hour_index} — {(h as {status?: string}).status === 'ISSUE' ? 'issue reported' : 'all smooth'}
                    {h.comment ? ` · ${h.comment}` : ''}
                  </Text>
                </View>
              ))
            )}
          </View>
        )}

        <View style={s.card}>
          <Text style={s.cardLabel}>CREW · {job.crew.length}/{job.cpo_count}</Text>
          {lead ? <CrewRow callSign={lead.call_sign} role={lead.role} lead /> : <Text style={s.muted}>No crew assigned yet.</Text>}
          {others.map(c => <CrewRow key={c.user_id} callSign={c.call_sign} role={c.role} />)}
        </View>

        {escrowLoaded && escrow ? (
          <View style={s.card}>
            <Text style={s.cardLabel}>PAYOUT</Text>
            <View style={s.kvRow}><Text style={s.muted}>Status</Text><Text style={s.kvStrong}>{escrow.status}</Text></View>
            <View style={s.kvRow}><Text style={s.muted}>Mission value</Text><Text style={s.kvStrong}>{escrow.gross_credits.toLocaleString()} BC</Text></View>
            {/* LM-A7 — the fee was fetched but never shown; a fleet operator must
                see the full split, not just the net. */}
            {typeof escrow.platform_fee_credits === 'number' ? (
              <View style={s.kvRow}><Text style={s.muted}>Platform fee</Text><Text style={s.kvStrong}>−{escrow.platform_fee_credits.toLocaleString()} BC</Text></View>
            ) : null}
            {typeof escrow.to_provider_credits === 'number' ? (
              <View style={s.kvRow}><Text style={s.muted}>Your payout</Text><Text style={[s.kvStrong, {color: D.signal}]}>+{escrow.to_provider_credits.toLocaleString()} BC</Text></View>
            ) : null}
          </View>
        ) : escrowLoaded && escrowError ? (
          <View style={s.card}>
            <Text style={s.cardLabel}>PAYOUT</Text>
            <Text style={s.muted}>Couldn’t load the payout right now — pull back in shortly.</Text>
          </View>
        ) : null}

        {/* A completed mission has no live GPS to watch — the CTA is a dead
            end once mission_status settles, so it must disappear with it. */}
        {job.mission_id && job.mission_status !== 'COMPLETED' ? (
          <TouchableOpacity style={s.cta} activeOpacity={0.9}
            onPress={() => navigation.navigate('AgentLiveTracker', {missionId: job.mission_id as string, mode: 'monitor'})}>
            <Icon name="map-marker-radius" size={18} color="#fff" />
            <Text style={s.ctaText}>Live monitor</Text>
          </TouchableOpacity>
        ) : null}

        {/* LM-C7 — the agency closes a finished mission the lead can't (phone
            died / a crew member requested completion). Same money-safe path as
            the lead Finish — the proof gate + release sweep still stand. */}
        {job.mission_id && (job.mission_status === 'LIVE' || job.mission_status === 'SOS') ? (
          <TouchableOpacity style={s.confirmBtn} activeOpacity={0.85} disabled={confirming}
            onPress={() => {
              Alert.alert('Confirm completion?',
                'Close this mission on behalf of your crew. Only confirm once the principal is safely handed over.',
                [{text: 'Cancel', style: 'cancel'},
                 {text: 'Confirm completion', style: 'destructive', onPress: () => {
                   setConfirming(true);
                   orgApi.completeMission(job.mission_id as string)
                     .then(() => load())
                     .catch((e: unknown) => Alert.alert('Could not complete', (e as Error).message ?? 'Try again.'))
                     .finally(() => setConfirming(false));
                 }}]);
            }}>
            <Icon name="flag-checkered" size={16} color={D.accentSoft} />
            <Text style={s.confirmText}>{confirming ? 'Completing…' : 'Confirm completion'}</Text>
          </TouchableOpacity>
        ) : null}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: D.hair},
  back: {width: 34, height: 34, alignItems: 'center', justifyContent: 'center'},
  title: {fontFamily: D.fBold, fontSize: 18, color: D.text, letterSpacing: -0.3},
  sub: {fontFamily: D.fMono, fontSize: 11, color: D.textMute, marginTop: 2, letterSpacing: 0.3},
  card: {backgroundColor: D.card, borderRadius: 16, padding: 14, borderWidth: StyleSheet.hairlineWidth, borderColor: D.hair, gap: 9},
  cardLabel: {fontFamily: D.fSemi, fontSize: 10, color: D.textMute, letterSpacing: 1.4},
  cardLabelRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  kv: {flexDirection: 'row', alignItems: 'center', gap: 9},
  kvText: {flex: 1, fontFamily: D.fSans, fontSize: 13, color: D.textDim},
  kvRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  kvStrong: {fontFamily: D.fSemi, fontSize: 13, color: D.text},
  muted: {fontFamily: D.fSans, fontSize: 12.5, color: D.textMute},
  armedPill: {borderWidth: 1, borderColor: '#F5C76B55', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2},
  armedText: {fontFamily: D.fSemi, fontSize: 9, color: D.amber, letterSpacing: 0.8},
  crewRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  crewName: {fontFamily: D.fSemi, fontSize: 13, color: D.text},
  crewRole: {fontFamily: D.fMono, fontSize: 10.5, color: D.textMute, letterSpacing: 0.4},
  cta: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, backgroundColor: D.accent, borderRadius: 14, paddingVertical: 14, marginTop: 4},
  ctaText: {fontFamily: D.fBold, fontSize: 14.5, color: '#fff', letterSpacing: 0.2},
  confirmBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 14, paddingVertical: 13,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)'},
  confirmText: {fontFamily: D.fBold, fontSize: 13.5, color: D.accentSoft, letterSpacing: 0.2},
}));
