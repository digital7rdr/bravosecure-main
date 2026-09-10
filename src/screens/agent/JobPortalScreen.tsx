/**
 * JobPortalScreen (JOB_PORTAL_MARKETPLACE_SPEC §2 / Fix B) — the agency's standalone
 * open-jobs marketplace, promoted out of OrgMissionsScreen to its own dashboard entry.
 * Every agency sees every open job (LB1 coarse cards — region + zone, time window,
 * service, headcount, armed flag, price; never exact addresses or client identity).
 * First agency to tap ACCEPT wins the job server-side; it lands on their Missions
 * board (NEEDS CREW) and vanishes from everyone's portal on the next poll. A raced
 * accept 409s cleanly ("another agency took it") and the card drops locally.
 * Obsidian + platinum-cobalt theme, matching OrgMissionsScreen.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, RefreshControl, ActivityIndicator } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi, type OpenJobDto} from '@services/api';
import {SUPPORTED_REGIONS} from '@utils/constants';
import {extractMsg} from '@screens/agent/agentFlowHelpers';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair: 'rgba(255,255,255,0.06)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', accentDeep: '#2F5BE0',
  amber: '#F5C76B', signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

// Claim server codes → friendly, actionable copy (same pattern as ASSIGN_ERRORS).
const CLAIM_ERRORS: Record<string, string> = {
  job_taken: 'Another agency took this job. The board has been refreshed.',
  booking_state_changed_concurrently: 'Another agency took this job. The board has been refreshed.',
  job_not_approved: 'This job is still awaiting ops approval.',
  job_not_claimable: 'This job is assigned through ops, not the portal.',
  job_unavailable: 'This job is no longer available.',
  job_not_found: 'This job is no longer available.',
  provider_excluded: 'Your agency previously passed on or withdrew from this job.',
  provider_on_cooldown: 'Your agency is temporarily paused from taking new jobs.',
  no_free_cpo_capacity: 'Not enough free guards — crew or finish your active jobs first.',
  provider_not_eligible: 'Your agency isn’t verified for this region yet (licence / insurance / armed).',
  agent_not_approved: 'Your agency account isn’t active yet.',
  provider_only: 'Only agency accounts can accept portal jobs.',
};
function claimErrorMessage(e: unknown): string {
  const code = extractMsg(e);
  return CLAIM_ERRORS[code] ?? code ?? 'Could not accept this job';
}

// All + the canonical region list (constants.ts mirror).
const REGION_CHIPS: Array<{code: string; label: string}> = [
  {code: 'ALL', label: 'All'},
  ...SUPPORTED_REGIONS.map(r => ({code: r.code, label: r.label})),
];

function fmtTime(iso: string): string {
  try {
    const d = new Date(iso);
    // UTC so mission times match the backend/ops value on every device.
    return d.toLocaleString('en-GB', {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'}) + 'Z';
  } catch { return iso; }
}

// Coarse open-job card (LB1) + the marketplace ACCEPT action. PENDING_OPS rows are
// visible but not claimable (ops hasn't approved yet); legacy (non-auto) bookings are
// browse-only — their client never consented to charge-on-accept.
function OpenJobCard({job, accepting, onAccept}: {job: OpenJobDto; accepting: boolean; onAccept: () => void}) {
  const isAuto = job.dispatch_mode === undefined || job.dispatch_mode === 'auto';
  const claimable = isAuto && (job.status === 'OPS_APPROVED' || job.status === 'DISPATCHING');
  const pendingLabel = !isAuto ? 'VIA OPS ASSIGNMENT' : 'AWAITING OPS APPROVAL';
  return (
    <View style={s.card}>
      <View style={s.cardTop}>
        <Text style={s.cardService} numberOfLines={1}>{job.service.replace(/_/g, ' ')}</Text>
        {job.armed_required && (
          <View style={s.armedPill}><Icon name="pistol" size={11} color={D.amber} /><Text style={s.armedText}>ARMED</Text></View>
        )}
      </View>
      <Text style={s.cardMeta} numberOfLines={1}>
        <Icon name="map-marker-outline" size={11} color={D.textMute} /> {job.region_label}{job.pickup_area ? ` · ${job.pickup_area}` : ''} · {fmtTime(job.pickup_time)} · {job.duration_hours}h
      </Text>
      <View style={s.cardBottom}>
        <Text style={s.cardCount}>
          <Icon name="account-multiple-outline" size={12} color={D.textDim} /> {job.cpo_count} CPO{job.cpo_count > 1 ? 's' : ''} · {Math.round(Number(job.total_eur)).toLocaleString()} BC
        </Text>
        {claimable ? (
          <TouchableOpacity activeOpacity={0.85} disabled={accepting} onPress={onAccept}
            style={[s.acceptBtn, accepting && {opacity: 0.55}]}>
            {accepting
              ? <ActivityIndicator size="small" color={D.accentSoft} />
              : (<><Icon name="check-bold" size={13} color={D.accentSoft} /><Text style={s.acceptText}>ACCEPT JOB</Text></>)}
          </TouchableOpacity>
        ) : (
          <Text style={s.pendingChip}>{pendingLabel}</Text>
        )}
      </View>
    </View>
  );
}

export default function JobPortalScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();

  const [region, setRegion] = useState('ALL');
  const regionTouched = useRef(false);
  const [openJobs, setOpenJobs] = useState<OpenJobDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);

  // Default selection = the provider's own region; falls back to All.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const {data: meResp} = await agentApi.getMe();
        const rc = (meResp.agent.region_code ?? '').toUpperCase();
        if (alive && !regionTouched.current && SUPPORTED_REGIONS.some(r => r.code === rc)) {
          setRegion(rc);
        }
      } catch { /* keep All */ }
    })();
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    try {
      const {data: jobsResp} = await agentApi.getOpenJobs(region);
      setOpenJobs(jobsResp.jobs);
    } catch {
      // transient — keep the last board rather than flashing empty
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [region]);

  // Spec R8 — a job claimed elsewhere must drop off this board without a manual
  // refresh (and a relisted one must reappear). Same 10s focused cadence as the
  // Missions board. `load` changes identity on region change, so a chip tap also
  // re-fetches here (its onPress sets the spinner); refocus refreshes silently.
  useFocusEffect(useCallback(() => {
    void load();
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load]));

  const accept = useCallback((job: OpenJobDto) => {
    Alert.alert(
      'Accept this job?',
      `${job.cpo_count} CPO${job.cpo_count > 1 ? 's' : ''} · ${job.region_label} · ${fmtTime(job.pickup_time)} · ${Math.round(Number(job.total_eur)).toLocaleString()} BC\n\nYour agency commits to crewing it within 15 minutes.`,
      [
        {text: 'Not now', style: 'cancel'},
        {text: 'Accept', style: 'default', onPress: () => void (async () => {
          setAcceptingId(job.booking_id);
          try {
            await agentApi.claimOpenJob(job.booking_id);
            Alert.alert('Job accepted', 'It’s on your Missions board — assign your crew and a leader to dispatch.', [
              {text: 'Assign crew', onPress: () => navigation.navigate('OrgMissions')},
              {text: 'Later', style: 'cancel'},
            ]);
          } catch (e: unknown) {
            Alert.alert('Could not accept', claimErrorMessage(e));
          } finally {
            setAcceptingId(null);
            // Won or lost, the board changed — reflect the truth immediately.
            void load();
          }
        })()},
      ],
    );
  }, [navigation, load]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={D.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>JOB PORTAL</Text>
        {openJobs.length > 0 && (
          <View style={s.countChip}><Text style={s.countChipText}>{openJobs.length} OPEN</Text></View>
        )}
      </View>

      <ScrollView contentContainerStyle={s.body} showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={D.accent} onRefresh={() => { setRefreshing(true); void load(); }} />}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.regionRow}>
          {REGION_CHIPS.map(r => {
            const on = region === r.code;
            return (
              <TouchableOpacity key={r.code} activeOpacity={0.8}
                onPress={() => { regionTouched.current = true; setLoading(true); setRegion(r.code); }}
                style={[s.regionChip, on && s.regionChipOn]}>
                <Text style={[s.regionChipText, on && s.regionChipTextOn]}>{r.label}</Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
        {loading ? (
          <LoadingView compact label="Loading jobs…" />
        ) : openJobs.length === 0 ? (
          <View style={s.emptyCard}>
      <ImageryBackdrop source={Imagery.jobOfferHero} variant="card" radius={22} />
            <Icon name="briefcase-search-outline" size={34} color={D.accentSoft} />
            <Text style={s.emptyTitle}>No open jobs</Text>
            <Text style={s.emptySub}>
              {region === 'ALL'
                ? 'New client requests appear here for every agency. First to accept wins the job.'
                : `No open jobs in ${SUPPORTED_REGIONS.find(r => r.code === region)?.label ?? region} right now.`}
            </Text>
          </View>
        ) : (
          openJobs.map(j => (
            <OpenJobCard key={j.booking_id} job={j}
              accepting={acceptingId === j.booking_id}
              onAccept={() => accept(j)} />
          ))
        )}
        <View style={{height: 20}} />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {width: 42, height: 42, borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center'},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  countChip: {paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  countChipText: {fontFamily: D.fBold, fontSize: 10, letterSpacing: 0.8, color: D.accentSoft},
  body: {paddingHorizontal: 20, paddingTop: 4, gap: 12},

  regionRow: {gap: 8, paddingRight: 8, paddingBottom: 4},
  regionChip: {paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2},
  regionChipOn: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.34)'},
  regionChipText: {fontFamily: D.fSemi, fontSize: 12, color: D.textDim, letterSpacing: 0.2},
  regionChipTextOn: {fontFamily: D.fBold, color: D.accentSoft},

  card: {borderRadius: 18, padding: 15, gap: 9, backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  cardTop: {flexDirection: 'row', alignItems: 'center', gap: 10},
  cardService: {flex: 1, fontFamily: D.fBold, fontSize: 15, color: D.text, letterSpacing: -0.2},
  armedPill: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(245,199,107,0.10)', borderWidth: 1, borderColor: 'rgba(245,199,107,0.30)'},
  armedText: {fontFamily: D.fBold, fontSize: 8.5, letterSpacing: 0.8, color: D.amber},
  cardMeta: {fontFamily: D.fSans, fontSize: 12, color: D.textDim},
  cardBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 2},
  cardCount: {fontFamily: D.fSemi, fontSize: 12, color: D.textDim},
  acceptBtn: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 12, paddingVertical: 7,
    borderRadius: 999, backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.40)'},
  acceptText: {fontFamily: D.fBold, fontSize: 10, letterSpacing: 0.8, color: D.accentSoft},
  pendingChip: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 0.8, color: D.textMute},

  emptyCard: {alignItems: 'center', gap: 8, borderRadius: 22, paddingVertical: 40, paddingHorizontal: 24, borderWidth: 1, borderColor: D.hair2, backgroundColor: 'rgba(255,255,255,0.02)', marginTop: 8},
  emptyTitle: {fontFamily: D.fBold, fontSize: 18, color: D.text, marginTop: 8},
  emptySub: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, textAlign: 'center', lineHeight: 19, maxWidth: 280},
}));
