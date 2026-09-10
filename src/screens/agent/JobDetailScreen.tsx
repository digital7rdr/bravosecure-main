/**
 * Agent · Job Details
 *
 * Premium redesign (Bravo "Job Details" design handoff): obsidian/cobalt
 * palette. EVERYTHING is driven by the live `/agents/me/jobs/:id` payload —
 * no hardcoded values:
 *   - Real Mapbox route map (pickup → drop-off coords), distance/ETA from
 *     those coords.
 *   - Type pill + title from `service` / `region_label`.
 *   - Dispatch countdown from `dispatch_at`; date/pickup from `pickup_time`.
 *   - Payout = booking total_eur evenly split across cpo_slots (BC == total_eur).
 *   - Requirements synthesised from real booking flags (dress brief, notes,
 *     driver-only, crew, passengers, region) — a generic line is only added
 *     when the booking carries no specifics.
 * The dress-pledge apply flow (audited by ops) is preserved.
 */
import React, {useState, useEffect, useRef, useMemo} from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image, Pressable,
  TouchableOpacity, StatusBar, Animated, Modal, TextInput,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import type {AgentStackParamList} from '@navigation/types';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {agentApi} from '@services/api';
import {extractMsg} from './agentFlowHelpers';
import {buildRouteMapUrl} from '@modules/news/mapbox';
import {scaleTextStyles} from '@utils/scaling';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {fmtDateUtc, fmtTimeUtc} from '@utils/datetime';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Props = NativeStackScreenProps<AgentStackParamList, 'JobDetail'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

// Design tokens (Bravo "Job Details" handoff — obsidian/cobalt premium).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentDeep: '#2F5BE0',
  accentGlow: 'rgba(91,141,239,0.35)',
  accentSoft: '#A9C5FF',
  signal:     '#4ADE80',
  amber:      '#F5C76B',
  alert:      '#F58B97',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

// Service → type-pill tint (real `service` string drives this, not a constant).
function servicePill(service: string, driverOnly: boolean): {label: string; c: string; bg: string; bd: string} {
  const svc = (service || '').toLowerCase();
  if (driverOnly)                  {return {label: 'DRIVER ONLY',         c: D.accentSoft, bg: 'rgba(91,141,239,0.12)', bd: 'rgba(91,141,239,0.34)'};}
  if (svc.includes('executive') || svc.includes('protection'))
                                   {return {label: 'CLOSE PROTECTION',    c: D.alert,      bg: 'rgba(245,72,90,0.1)',  bd: 'rgba(245,72,90,0.34)'};}
  if (svc.includes('recon') || svc.includes('surveillance') || svc.includes('extraction'))
                                   {return {label: 'RECON',               c: '#8FE6B4',    bg: 'rgba(74,222,128,0.12)', bd: 'rgba(74,222,128,0.32)'};}
  return {label: 'SECURE TRANSFER', c: D.accentSoft, bg: 'rgba(91,141,239,0.12)', bd: 'rgba(91,141,239,0.34)'};
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// UTC display so the pickup date/time matches the backend value and the ops
// console exactly (see @utils/datetime).
function formatDate(iso: string | null | undefined): string {
  return fmtDateUtc(iso);
}

function formatTime(iso: string | null | undefined): string {
  return fmtTimeUtc(iso);
}

// Great-circle km between two WGS-84 coords (no routing API on the client).
function distanceKm(a: {lat: number; lng: number}, b: {lat: number; lng: number}): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function num(v: string | null | undefined): number | null {
  if (v === null || v === undefined) {return null;}
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface JobData {
  job: {
    id: string; booking_id: string; short_code: string; status: string;
    region_code: string; route_label: string; dispatch_at: string;
    duration_hours: number; cpo_slots: number; slots_filled: number;
  };
  booking: {
    pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
    dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
    pickup_time: string; total_aed: string; total_eur: string;
    cpo_count: number; vehicle_count: number; driver_only: boolean;
    passengers?: number; service: string; region_label: string; notes: string | null;
    dress_instructions: string | null;
    /** R-6 — executive brief (null on non-executive bookings; transfer legs are
     *  location-gated server-side until the agent has a stake). */
    task_type?: string | null; duration_hours?: number;
    exec_transport?: {mode: string; passengers?: number} | null;
  } | null;
  application: {id: string; status: string; applied_at: string} | null;
}

export default function JobDetailScreen({route, navigation}: Props) {
  const {jobId} = route.params;
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  // B-84 / KB-06 — Android Modal windows never resize for the IME; lift
  // the pledge sheet by the keyboard height (KAV is iOS-only here).
  const {overlap: keyboardOverlap, safeBottom} = useKeyboardLayout();
  const [data, setData] = useState<JobData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const timerPulse = useRef(new Animated.Value(1)).current;
  // Live "now" tick so the dispatch countdown actually counts down.
  const [nowTick, setNowTick] = useState(0);

  const fetchJob = React.useCallback(async () => {
    const res = await agentApi.getJob(jobId);
    return res.data as JobData;
  }, [jobId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const d = await fetchJob();
        if (!cancelled) {setData(d);}
      } catch (e) {
        if (!cancelled) {setErr(extractMsg(e));}
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [fetchJob]);

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(timerPulse, {toValue: 0.5, duration: 600, useNativeDriver: true}),
        Animated.timing(timerPulse, {toValue: 1,   duration: 600, useNativeDriver: true}),
      ]),
    ).start();
  }, [timerPulse]);

  // Tick every 30s so the countdown stays live without a refetch.
  useEffect(() => {
    const t = setInterval(() => setNowTick(n => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const b = data?.booking ?? null;

  const pickup = useMemo(() => {
    const lat = num(b?.pickup_lat); const lng = num(b?.pickup_lng);
    return lat !== null && lng !== null ? {lat, lng} : null;
  }, [b?.pickup_lat, b?.pickup_lng]);
  const dropoff = useMemo(() => {
    const lat = num(b?.dropoff_lat); const lng = num(b?.dropoff_lng);
    return lat !== null && lng !== null ? {lat, lng} : null;
  }, [b?.dropoff_lat, b?.dropoff_lng]);

  const mapUrl = useMemo(
    () => buildRouteMapUrl(pickup, dropoff, {width: 720, height: 336}),
    [pickup, dropoff],
  );
  const showMap = !!mapUrl && !mapFailed;

  // Distance + ETA from the real coords (Haversine, ~40 km/h urban).
  const distLabel = useMemo(() => {
    if (!pickup || !dropoff) {return null;}
    const km = distanceKm(pickup, dropoff);
    const etaMin = Math.max(1, Math.round((km / 40) * 60));
    return `${km.toFixed(1)} km · ~${etaMin} min`;
  }, [pickup, dropoff]);

  // Dispatch countdown from real dispatch_at.
  const minsToDispatch = useMemo(() => {
    if (!data?.job?.dispatch_at) {return null;}
    const ms = new Date(data.job.dispatch_at).getTime() - Date.now();
    return ms <= 0 ? 0 : Math.floor(ms / 60_000);
    // `nowTick` (30s interval) forces re-derivation so the countdown ticks down.
  }, [data?.job?.dispatch_at, nowTick]);

  // Real payout: even split of booking total_eur across cpo_slots — mirrors the
  // server's disburseMissionPayout (floor(round(total_eur) / crew)). Why total_eur:
  // BC == total_eur 1:1; the old total_aed math overstated the payout ~4.07×.
  const payoutBc = useMemo(() => {
    if (!b) {return null;}
    const total = Math.round(Number(b.total_eur));
    if (!Number.isFinite(total)) {return null;}
    const slots = Math.max(1, data?.job.cpo_slots ?? b.cpo_count ?? 1);
    return Math.floor(total / slots);
  }, [b, data?.job.cpo_slots]);

  const myStatus = data?.application?.status ?? null;
  const alreadyApplied = !!myStatus && myStatus !== 'WITHDRAWN' && myStatus !== 'REJECTED';

  const pickupName = b?.pickup_address?.split(',')[0]?.trim() ?? '—';
  const dropName = (b?.dropoff_address ?? 'TBC').split(',')[0]?.trim();

  // Requirements synthesised from REAL booking flags (no generic boilerplate
  // unless the booking carries nothing actionable).
  const requirements = useMemo(() => {
    if (!b) {return [];}
    const out: string[] = [];
    if (b.dress_instructions?.trim()) {
      out.push(`Dress brief: ${b.dress_instructions.trim()}`);
    }
    if (b.driver_only) {
      out.push('Driver-only detail — client provides the vehicle; deploy as a vetted security driver.');
    } else {
      out.push(`Crew: ${b.cpo_count}× CPO · ${b.vehicle_count}× vehicle. Be at pickup 15 min before dispatch.`);
    }
    if (typeof b.passengers === 'number' && b.passengers > 0) {
      out.push(`${b.passengers} passenger${b.passengers === 1 ? '' : 's'} to protect across the detail.`);
    }
    out.push(`Operating zone: ${b.region_label}. Encrypted comms handset issued at dispatch; ops check-in every 30 min.`);
    if (b.notes?.trim()) {
      out.push(`Client note: ${b.notes.trim()}`);
    }
    return out;
  }, [b]);

  const pill = b ? servicePill(b.service, b.driver_only) : null;

  // ── Dress pledge sheet ──
  const [pledgeOpen, setPledgeOpen] = useState(false);
  const [pledge, setPledge] = useState('');
  // Two mutually-exclusive ways to pledge attire:
  //   'match'  → wear exactly the Ops brief (pledge = the brief verbatim)
  //   'custom' → describe your own attire in the text box
  const [pledgeMode, setPledgeMode] = useState<'match' | 'custom' | null>(null);

  const opsBrief = b?.dress_instructions?.trim() ?? '';
  const hasOpsBrief = opsBrief.length > 0;
  // A pledge is ready once a mode is chosen and the resulting text is non-trivial.
  const canSubmitPledge = pledgeMode !== null && pledge.trim().length >= 4;

  const chooseMatch = () => {
    if (!hasOpsBrief) {return;}
    setPledgeMode('match');
    setPledge(opsBrief);   // pledge IS the ops brief — what ops audits against
  };
  const chooseCustom = () => {
    setPledgeMode('custom');
    // Don't keep the auto-filled brief as the "custom" answer — start fresh
    // unless the agent had already typed something different.
    setPledge(p => (p === opsBrief ? '' : p));
  };

  const openPledge = () => {
    if (applying || alreadyApplied) {return;}
    setPledge('');
    setPledgeMode(null);
    setPledgeOpen(true);
  };

  const submitPledge = async () => {
    if (pledgeMode === null) {
      Alert.alert('Choose an option', 'Match the Ops brief, or describe what you’ll be wearing.');
      return;
    }
    const trimmed = pledge.trim();
    if (trimmed.length < 4) {
      Alert.alert('Add a dress pledge', "Tell ops what you'll be wearing — at least a few words.");
      return;
    }
    setApplying(true);
    try {
      await agentApi.applyToJob(jobId, trimmed);
      setPledgeOpen(false);
      setData(await fetchJob());
    } catch (e) {
      Alert.alert('Apply failed', extractMsg(e));
    } finally {
      setApplying(false);
    }
  };

  // Suggested dress chips seeded from the real service type.
  const dressChips = useMemo(() => {
    const svc = (b?.service ?? '').toLowerCase();
    if (b?.driver_only) {return ['Driver uniform', 'Smart casual, plainclothes', 'Black suit + tie'];}
    if (svc.includes('recon') || svc.includes('surveillance')) {return ['Plainclothes, low-profile', 'Smart casual', 'Tactical kit'];}
    return ['Black suit + white shirt + black tie', 'Smart casual, plainclothes', 'Tactical kit, plate carrier'];
  }, [b?.service, b?.driver_only]);

  const isExecJob = b?.service === 'executive_protection';
  const detailCells: {icon: IconName; label: string; value: string}[] = b ? [
    {icon: 'calendar-blank-outline',  label: 'Date',      value: formatDate(b.pickup_time)},
    {icon: 'clock-outline',           label: 'Pickup',    value: formatTime(b.pickup_time)},
    {icon: 'timer-sand',              label: 'Duration',  value: `${data?.job.duration_hours ?? '—'}h`},
    {icon: 'shield-account-outline',  label: 'Crew',      value: b.driver_only ? '1× Driver' : `${b.cpo_count}× CPO · ${b.vehicle_count}× VEH`},
    // R-6 — the executive brief: what the detail is for + whether a transfer leg exists.
    ...(isExecJob ? [
      {icon: 'shield-crown' as IconName, label: 'Task',
       value: (b.task_type ?? 'site_protection').replace(/_/g, ' ')},
      {icon: 'car-estate' as IconName, label: 'Transfer',
       value: b.exec_transport ? `Yes · ${String(b.exec_transport.mode).replace(/_/g, ' ')}` : 'None'},
    ] : []),
    {icon: 'map-marker-outline',      label: 'Pickup at', value: pickupName},
    {icon: 'flag-checkered',          label: 'Drop at',   value: dropName},
  ] : [];

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity style={s.iconBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <View style={{flex: 1, minWidth: 0, alignItems: 'center'}}>
          <Text style={s.headerKicker}>JOB DETAILS</Text>
          <Text style={s.headerRef} numberOfLines={1}>{data?.job?.short_code ?? '—'}</Text>
        </View>
        <View style={s.iconBtn}>
          <Icon name="dots-vertical" size={18} color={D.textDim} />
        </View>
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[s.scroll, {paddingBottom: insets.bottom + 110}]}>

        {/* ── Route map (real Mapbox) ── */}
        <View style={s.mapCard}>
          {showMap ? (
            <>
              <Image
                source={{uri: mapUrl}}
                style={StyleSheet.absoluteFill}
                resizeMode="cover"
                onError={() => setMapFailed(true)}
              />
              <LinearGradient
                colors={['rgba(7,9,13,0.1)', 'rgba(7,9,13,0.6)']}
                style={StyleSheet.absoluteFill}
              />
            </>
          ) : (
            <LinearGradient colors={['#0C1220', '#080C16']} style={StyleSheet.absoluteFill} />
          )}

          {distLabel && (
            <View style={s.distBadge}>
              <Text style={s.distText}>{distLabel}</Text>
            </View>
          )}
          {/* endpoint labels — real addresses */}
          <View style={s.mapLabels}>
            <View style={s.mapLabelChip}>
              <View style={[s.mapDot, {backgroundColor: D.signal}]} />
              <Text style={s.mapLabelText} numberOfLines={1}>{pickupName.toUpperCase()}</Text>
            </View>
            <View style={s.mapLabelChip}>
              <View style={[s.mapDot, {backgroundColor: D.accentSoft}]} />
              <Text style={s.mapLabelText} numberOfLines={1}>{(dropName ?? 'TBC').toUpperCase()}</Text>
            </View>
          </View>
        </View>

        {/* ── Dispatch countdown ── */}
        <View style={s.timerBanner}>
          <Animated.View style={{opacity: timerPulse}}>
            <Icon name="timer-outline" size={18} color={D.amber} />
          </Animated.View>
          <Text style={s.timerText}>
            {minsToDispatch === null
              ? 'Loading dispatch time…'
              : minsToDispatch <= 0
                ? <>Dispatch <Text style={s.timerCount}>NOW</Text></>
                : <>Dispatch in <Text style={s.timerCount}>{minsToDispatch < 60 ? `${minsToDispatch}m` : `${Math.floor(minsToDispatch / 60)}h ${minsToDispatch % 60}m`}</Text></>}
          </Text>
        </View>

        {loading && <LoadingView compact label="Loading job…" />}
        {err && (
          <View style={s.errBox}>
            <Icon name="alert-circle-outline" size={16} color={D.alert} />
            <Text style={s.errText}>Failed to load job: {err}</Text>
          </View>
        )}

        {/* ── Mission card ── */}
        {b && pill && (
          <View style={s.missionCard}>
            <LinearGradient
              colors={[D.accent, D.accentDeep]}
              start={{x: 0, y: 0}} end={{x: 0, y: 1}}
              style={s.missionRail}
            />
            <View style={s.cardTopLight} />
            <View style={s.missionTop}>
              <View style={[s.typePill, {backgroundColor: pill.bg, borderColor: pill.bd}]}>
                <Text style={[s.typePillText, {color: pill.c}]}>{pill.label}</Text>
              </View>
              <View style={{alignItems: 'flex-end'}}>
                <Text style={s.earnLabel}>YOU EARN</Text>
                <Text style={s.earnNum}>
                  {payoutBc !== null ? payoutBc.toLocaleString() : '—'}
                  {payoutBc !== null && <Text style={s.earnUnit}> BC</Text>}
                </Text>
              </View>
            </View>
            <Text style={s.missionTitle}>{titleCase(b.service)} · {b.region_label}</Text>

            <View style={s.divider} />

            {/* detail grid */}
            <View style={s.detailGrid}>
              {detailCells.map(c => (
                <View key={c.label} style={s.detailCell}>
                  <View style={s.detailIcon}>
                    <Icon name={c.icon} size={17} color={D.accentSoft} />
                  </View>
                  <View style={{minWidth: 0, flex: 1}}>
                    <Text style={s.detailLabel}>{c.label.toUpperCase()}</Text>
                    <Text style={s.detailValue} numberOfLines={1}>{c.value}</Text>
                  </View>
                </View>
              ))}
            </View>

            <View style={s.divider} />

            {/* slots */}
            <View style={s.slotRow}>
              <SlotRing filled={data?.job.slots_filled ?? 0} total={data?.job.cpo_slots ?? 1} />
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.slotTitle}>{data?.job.slots_filled ?? 0} / {data?.job.cpo_slots ?? 1} slots filled</Text>
                <View style={s.slotMeta}>
                  <Icon name="map-marker-outline" size={12} color={D.textMute} />
                  <Text style={s.slotMetaText} numberOfLines={1}>{b.region_label}</Text>
                </View>
              </View>
              {alreadyApplied && (
                <View style={s.statusBadge}>
                  <Text style={s.statusText}>{myStatus}</Text>
                </View>
              )}
            </View>
          </View>
        )}

        {/* ── Requirements (real, synthesised from booking) ── */}
        {b && requirements.length > 0 && (
          <View>
            <Text style={s.sectionLabel}>JOB REQUIREMENTS</Text>
            <View style={{gap: 9, marginTop: 12}}>
              {requirements.map((req, i) => (
                <View key={i} style={s.reqRow}>
                  <View style={s.reqCheck}>
                    <Icon name="check" size={13} color={D.signal} />
                  </View>
                  <Text style={s.reqText}>{req}</Text>
                </View>
              ))}
            </View>
          </View>
        )}

        {/* ── Earnings breakdown (agent-facing only) ── */}
        {b && (
          <View style={s.payCard}>
            <View style={s.payHeader}>
              <Icon name="cash-multiple" size={15} color={D.accentSoft} />
              <Text style={s.payHeaderText}>YOUR EARNINGS</Text>
            </View>
            <View style={s.payRow}>
              <Text style={s.payRowLabel}>Mission rate</Text>
              <Text style={[s.payRowVal, {color: D.signal}]}>{payoutBc !== null ? `${payoutBc.toLocaleString()} BC` : '—'}</Text>
            </View>
            <View style={s.payRow}>
              <Text style={s.payRowLabel}>Duration</Text>
              <Text style={[s.payRowVal, {color: D.textDim}]}>{data?.job.duration_hours ?? '—'}h</Text>
            </View>
            <View style={s.payTotal}>
              <Text style={s.payTotalLabel}>You earn</Text>
              <Text style={s.payTotalVal}>{payoutBc !== null ? `${payoutBc.toLocaleString()} BC` : '—'}</Text>
            </View>
            <Text style={s.payNote}>
              Settled to your wallet on mission completion. Ops may deduct with a written reason if standards aren&apos;t met.
            </Text>
          </View>
        )}
      </ScrollView>

      {/* ── Footer ── */}
      <LinearGradient
        colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']}
        locations={[0, 0.4]}
        style={[s.footer, {paddingBottom: bottomPad(16)}]}>
        {!alreadyApplied && (
          <TouchableOpacity style={s.declineBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.8}>
            <Icon name="close" size={16} color={D.alert} />
            <Text style={s.declineText}>Decline</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          activeOpacity={applying || alreadyApplied || loading || !!err ? 1 : 0.9}
          disabled={applying || alreadyApplied || loading || !!err}
          onPress={openPledge}
          style={{flex: alreadyApplied ? 1 : 2}}>
          <LinearGradient
            colors={alreadyApplied ? ['#27324A', '#1C2436'] : ['#6E9BF5', D.accent, D.accentDeep]}
            locations={[0, 0.55, 1]}
            start={{x: 0, y: 0}} end={{x: 0, y: 1}}
            style={[s.applyBtn, (applying || loading || !!err) && !alreadyApplied && {opacity: 0.7}]}>
            <Icon name={alreadyApplied ? 'check-circle' : 'briefcase-check-outline'} size={18} color="#fff" />
            <Text style={s.applyText}>
              {alreadyApplied ? `Applied · ${myStatus}` : applying ? 'Applying…' : 'Apply for Job'}
            </Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>

      {/* ── Dress pledge sheet ── */}
      <Modal visible={pledgeOpen} transparent animationType="slide" onRequestClose={() => !applying && setPledgeOpen(false)}>
        {/* B-184 — the backdrop lifts by the true IME overlap; the sheet's
            own safe-area pad collapses so the two never stack. */}
        <View style={[s.pledgeBackdrop, {paddingBottom: keyboardOverlap}]}>
          {/* Tap-to-dismiss backdrop sits BEHIND the sheet (absolute), so the
              sheet itself is pushed to the bottom by justifyContent:flex-end. */}
          <Pressable style={StyleSheet.absoluteFill} onPress={() => !applying && setPledgeOpen(false)} />
          <View style={[s.pledgeSheet, {paddingBottom: safeBottom + 16}]}>
            <View style={s.pledgeHandle} />
            <Text style={s.pledgeTitle}>Dress brief from Ops</Text>

            <ScrollView
              showsVerticalScrollIndicator={false}
              keyboardShouldPersistTaps="handled"
              bounces={false}>
              <View style={s.pledgeOpsBox}>
                <Icon name="hanger" size={16} color={D.accentSoft} style={{marginTop: 1}} />
                <Text style={s.pledgeOpsText}>
                  {/* eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing */}
                  {b?.dress_instructions?.trim() || 'Ops did not include a dress brief on this booking.'}
                </Text>
              </View>

              <Text style={s.pledgeSectionLabel}>WHAT YOU&apos;LL BE WEARING</Text>

              {/* Option 1 — match the Ops brief exactly (checkbox). Disabled
                  when Ops left no brief, so there's nothing to match. */}
              <TouchableOpacity
                activeOpacity={hasOpsBrief ? 0.8 : 1}
                onPress={chooseMatch}
                disabled={!hasOpsBrief || applying}
                style={[
                  s.pledgeOption,
                  pledgeMode === 'match' && s.pledgeOptionOn,
                  !hasOpsBrief && s.pledgeOptionDisabled,
                ]}>
                <View style={[s.pledgeCheck, pledgeMode === 'match' && s.pledgeCheckOn]}>
                  {pledgeMode === 'match' && <Icon name="check" size={13} color="#fff" />}
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={[s.pledgeOptionTitle, !hasOpsBrief && {color: D.textMute}]}>
                    I&apos;ll wear exactly what Ops specified
                  </Text>
                  <Text style={s.pledgeOptionSub} numberOfLines={2}>
                    {hasOpsBrief ? opsBrief : 'No brief provided — describe your attire below.'}
                  </Text>
                </View>
              </TouchableOpacity>

              {/* Option 2 — describe something different (reveals the box). */}
              <TouchableOpacity
                activeOpacity={0.8}
                onPress={chooseCustom}
                disabled={applying}
                style={[s.pledgeOption, pledgeMode === 'custom' && s.pledgeOptionOn]}>
                <View style={[s.pledgeRadio, pledgeMode === 'custom' && s.pledgeRadioOn]}>
                  {pledgeMode === 'custom' && <View style={s.pledgeRadioDot} />}
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.pledgeOptionTitle}>Something different</Text>
                  <Text style={s.pledgeOptionSub}>Describe what you&apos;ll actually be wearing.</Text>
                </View>
              </TouchableOpacity>

              {/* Custom entry — only when 'Something different' is chosen. */}
              {pledgeMode === 'custom' && (
                <View style={{marginTop: 12}}>
                  <View style={s.pledgeChipRow}>
                    {dressChips.map(p => (
                      <TouchableOpacity key={p} onPress={() => setPledge(p)} activeOpacity={0.8}
                        style={[s.pledgeChip, pledge === p && s.pledgeChipActive]}>
                        <Text style={[s.pledgeChipText, pledge === p && s.pledgeChipTextActive]}>{p}</Text>
                      </TouchableOpacity>
                    ))}
                  </View>
                  <TextInput
                    style={s.pledgeInput}
                    placeholder="e.g. Black two-piece, white shirt, no tie. Concealed earpiece."
                    placeholderTextColor={D.textMute}
                    value={pledge}
                    onChangeText={setPledge}
                    multiline numberOfLines={3} maxLength={240}
                    editable={!applying}
                    autoFocus
                  />
                  <Text style={s.pledgeHint}>{pledge.trim().length} / 240 · ops audits this against the brief above</Text>
                </View>
              )}
            </ScrollView>

            <View style={s.pledgeFooter}>
              <TouchableOpacity style={s.pledgeCancel} onPress={() => !applying && setPledgeOpen(false)} activeOpacity={0.7} disabled={applying}>
                <Text style={s.pledgeCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity
                activeOpacity={0.9}
                disabled={applying || !canSubmitPledge}
                onPress={() => { void submitPledge(); }}
                style={{flex: 2}}>
                <LinearGradient
                  colors={['#6E9BF5', D.accent, D.accentDeep]}
                  locations={[0, 0.55, 1]}
                  start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                  style={[s.pledgeSubmit, (applying || !canSubmitPledge) && {opacity: 0.5}]}>
                  <Icon name="check" size={16} color="#fff" />
                  <Text style={s.pledgeSubmitText}>{applying ? 'Applying…' : 'Confirm & Apply'}</Text>
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

function SlotRing({filled, total}: {filled: number; total: number}) {
  const pct = total > 0 ? Math.min(1, filled / total) : 0;
  // Simple conic-free ring: a tinted track + a progress arc faked with border
  // weight isn't possible in RN, so render a filled fraction via two stacked
  // circles is overkill — use a labelled tinted ring (the fraction is the label).
  return (
    <View style={s.ring}>
      <View style={[s.ringTrack, pct >= 1 && {borderColor: D.signal}, pct > 0 && pct < 1 && {borderColor: D.accent}]} />
      <Text style={s.ringText}>{filled}/{total}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 18, paddingTop: 12, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: D.hair,
  },
  iconBtn: {
    width: 38, height: 38, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  headerKicker: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 1.6, color: D.textMute},
  headerRef: {fontFamily: D.fMono, fontSize: 13.5, fontWeight: '700', letterSpacing: 1.5, color: D.text, marginTop: 3},

  scroll: {paddingHorizontal: 18, paddingTop: 16, gap: 14},

  cardTopLight: {position: 'absolute', top: 0, left: 18, right: 18, height: 1, backgroundColor: 'rgba(120,160,255,0.3)'},

  // Map
  mapCard: {
    height: 168, borderRadius: 20, overflow: 'hidden',
    borderWidth: 1, borderColor: D.hair2,
  },
  distBadge: {
    position: 'absolute', top: 14, alignSelf: 'center',
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(10,16,28,0.85)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.4)',
  },
  distText: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', letterSpacing: 0.8, color: D.accentSoft},
  mapLabels: {position: 'absolute', bottom: 12, left: 12, right: 12, flexDirection: 'row', justifyContent: 'space-between', gap: 8},
  mapLabelChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6, maxWidth: '48%',
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999,
    backgroundColor: 'rgba(10,13,20,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  mapDot: {width: 6, height: 6, borderRadius: 3},
  mapLabelText: {fontFamily: D.fMono, fontSize: 9, fontWeight: '600', letterSpacing: 0.6, color: '#fff', flexShrink: 1},

  // Timer
  timerBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14,
    backgroundColor: 'rgba(245,181,68,0.07)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.28)',
  },
  timerText: {fontFamily: D.fSans, fontSize: 14, color: D.textDim, letterSpacing: -0.05},
  timerCount: {fontFamily: D.fBold, color: D.amber},

  errBox: {
    flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(245,72,90,0.08)', borderWidth: 1, borderColor: 'rgba(245,72,90,0.4)',
  },
  errText: {flex: 1, fontFamily: D.fSans, fontSize: 12, color: D.alert},

  // Mission card
  missionCard: {
    position: 'relative', overflow: 'hidden', borderRadius: 22, padding: 18,
    backgroundColor: 'rgba(20,28,46,0.85)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.26)',
    shadowColor: '#14285A', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: {width: 0, height: 14}, elevation: 8,
  },
  missionRail: {position: 'absolute', top: 0, bottom: 0, left: 0, width: 3},
  missionTop: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12},
  typePill: {paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderWidth: 1},
  typePillText: {fontFamily: D.fMono, fontSize: 9, fontWeight: '800', letterSpacing: 1.2},
  earnLabel: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 1.4, color: D.textMute},
  earnNum: {fontFamily: D.fBold, fontSize: 22, letterSpacing: -0.6, color: D.amber, marginTop: 3},
  earnUnit: {fontFamily: D.fBold, fontSize: 13, color: D.amber},
  missionTitle: {fontFamily: D.fBold, fontSize: 18, letterSpacing: -0.3, color: D.text, marginTop: 14, lineHeight: 23},

  divider: {height: 1, backgroundColor: D.hair, marginVertical: 16},

  detailGrid: {gap: 16},
  detailCell: {flexDirection: 'row', alignItems: 'center', gap: 11, flex: 1},
  detailIcon: {
    width: 38, height: 38, borderRadius: 11, flexShrink: 0,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  detailLabel: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '600', letterSpacing: 1.2, color: D.textMute},
  detailValue: {fontFamily: D.fBold, fontSize: 14, letterSpacing: -0.2, color: D.text, marginTop: 3},

  slotRow: {flexDirection: 'row', alignItems: 'center', gap: 13},
  ring: {width: 44, height: 44, flexShrink: 0, alignItems: 'center', justifyContent: 'center'},
  ringTrack: {
    position: 'absolute', width: 44, height: 44, borderRadius: 22,
    borderWidth: 4, borderColor: 'rgba(255,255,255,0.08)',
  },
  ringText: {fontFamily: D.fMono, fontSize: 11, fontWeight: '700', color: D.textDim},
  slotTitle: {fontFamily: D.fBold, fontSize: 14.5, letterSpacing: -0.2, color: D.text},
  slotMeta: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4},
  slotMetaText: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, letterSpacing: -0.05, flexShrink: 1},
  statusBadge: {
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
  },
  statusText: {fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 0.6, color: D.signal},

  // Requirements
  sectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '600', letterSpacing: 2, color: D.textDim, marginLeft: 2},
  reqRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 13, paddingHorizontal: 15, borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  reqCheck: {
    width: 24, height: 24, borderRadius: 12, flexShrink: 0, marginTop: 1,
    backgroundColor: 'rgba(74,222,128,0.12)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
    alignItems: 'center', justifyContent: 'center',
  },
  reqText: {flex: 1, fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textDim, letterSpacing: -0.05},

  // Earnings
  payCard: {
    borderRadius: 16, padding: 14, gap: 9,
    backgroundColor: 'rgba(91,141,239,0.05)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  payHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 2},
  payHeaderText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1.8, color: D.accentSoft},
  payRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  payRowLabel: {fontFamily: D.fSans, fontSize: 12, color: D.textMute},
  payRowVal: {fontFamily: D.fBold, fontSize: 12},
  payTotal: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 10, borderTopWidth: 1, borderTopColor: 'rgba(91,141,239,0.2)', marginTop: 2},
  payTotalLabel: {fontFamily: D.fBold, fontSize: 12, color: D.textDim},
  payTotalVal: {fontFamily: D.fBold, fontSize: 15, color: D.accentSoft},
  payNote: {fontFamily: D.fSans, fontSize: 10, color: D.textMute, lineHeight: 14},

  // Footer
  footer: {position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 18, paddingTop: 28, flexDirection: 'row', gap: 12},
  declineBtn: {
    flex: 1, height: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: 'rgba(245,72,90,0.08)', borderWidth: 1, borderColor: 'rgba(245,72,90,0.34)',
  },
  declineText: {fontFamily: D.fBold, fontSize: 15, letterSpacing: 0.2, color: D.alert},
  applyBtn: {
    height: 56, borderRadius: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.45, shadowRadius: 20, shadowOffset: {width: 0, height: 12}, elevation: 8,
  },
  applyText: {fontFamily: D.fBold, fontSize: 15.5, letterSpacing: 0.2, color: '#fff'},

  // Pledge sheet
  pledgeBackdrop: {flex: 1, backgroundColor: 'rgba(2,6,15,0.72)', justifyContent: 'flex-end'},
  pledgeSheet: {
    backgroundColor: '#0E1320', borderTopLeftRadius: 22, borderTopRightRadius: 22,
    paddingHorizontal: 18, paddingTop: 10, borderTopWidth: 1, borderColor: D.hair2,
    // Cap so a tall brief + chips never push the sheet off the top of the
    // screen; the body scrolls if it exceeds this.
    maxHeight: '88%',
  },
  pledgeHandle: {width: 40, height: 4, borderRadius: 2, backgroundColor: D.hair2, alignSelf: 'center', marginBottom: 14},
  pledgeTitle: {fontFamily: D.fBold, fontSize: 16, color: D.text, marginBottom: 8},
  pledgeOpsBox: {
    flexDirection: 'row', gap: 10, padding: 12, borderRadius: 12, marginBottom: 16,
    backgroundColor: 'rgba(91,141,239,0.06)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
  },
  pledgeOpsText: {flex: 1, fontFamily: D.fSans, fontSize: 12, color: D.textDim, lineHeight: 17},
  pledgeSectionLabel: {fontFamily: D.fMono, fontSize: 10, fontWeight: '700', letterSpacing: 1.5, color: D.textMute, marginBottom: 10},

  // Two-option attire picker
  pledgeOption: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14, borderRadius: 14, marginBottom: 10,
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair2,
  },
  pledgeOptionOn: {backgroundColor: 'rgba(91,141,239,0.1)', borderColor: 'rgba(91,141,239,0.45)'},
  pledgeOptionDisabled: {opacity: 0.5},
  pledgeOptionTitle: {fontFamily: D.fBold, fontSize: 13.5, letterSpacing: -0.1, color: D.text},
  pledgeOptionSub: {fontFamily: D.fSans, fontSize: 11.5, lineHeight: 16, color: D.textMute, marginTop: 3},
  pledgeCheck: {
    width: 22, height: 22, borderRadius: 7, flexShrink: 0, marginTop: 1,
    borderWidth: 1.5, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center',
  },
  pledgeCheckOn: {backgroundColor: D.accent, borderColor: D.accent},
  pledgeRadio: {
    width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 1,
    borderWidth: 1.5, borderColor: D.hair2, alignItems: 'center', justifyContent: 'center',
  },
  pledgeRadioOn: {borderColor: D.accent},
  pledgeRadioDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: D.accent},
  pledgeChipRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 10},
  pledgeChip: {paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999, borderWidth: 1, borderColor: D.hair2, backgroundColor: 'rgba(255,255,255,0.04)'},
  pledgeChipActive: {borderColor: 'rgba(91,141,239,0.5)', backgroundColor: 'rgba(91,141,239,0.14)'},
  pledgeChipText: {fontFamily: D.fSemi, fontSize: 11, color: D.textDim},
  pledgeChipTextActive: {color: D.accentSoft, fontFamily: D.fBold},
  pledgeInput: {
    minHeight: 70, padding: 12, borderRadius: 12, backgroundColor: '#07090D',
    borderWidth: 1, borderColor: D.hair2, color: D.text, fontFamily: D.fSans, fontSize: 13, lineHeight: 18, textAlignVertical: 'top',
  },
  pledgeHint: {fontFamily: D.fSans, fontSize: 10, color: D.textMute, marginTop: 6, textAlign: 'right'},
  pledgeFooter: {flexDirection: 'row', gap: 10, marginTop: 16},
  pledgeCancel: {
    flex: 1, paddingVertical: 15, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: D.hair2, backgroundColor: 'rgba(255,255,255,0.04)',
  },
  pledgeCancelText: {fontFamily: D.fSemi, fontSize: 12, color: D.textDim, letterSpacing: 0.4},
  pledgeSubmit: {paddingVertical: 15, borderRadius: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  pledgeSubmitText: {fontFamily: D.fBold, fontSize: 13, color: '#fff', letterSpacing: 0.3},
}));
