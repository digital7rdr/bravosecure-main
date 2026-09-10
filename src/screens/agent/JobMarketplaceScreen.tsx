/**
 * Agent · Job Marketplace — available assignments for a partner CPO.
 *
 * Premium redesign (Bravo "Job Marketplace" design handoff): obsidian base
 * with a violet agent accent. Type-tinted job cards (CPO / Driver / Recon)
 * with a pulsing shield hero band, From → To route, slot count, date/time/
 * fill mini-tiles, and a gradient Apply button.
 *
 * Data layer is unchanged: /agents/me/available-jobs, filter chips, apply
 * (→ JobDetail dress-pledge sheet) / withdraw (inline), and the loading /
 * empty states.
 */
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, Image,
  TouchableOpacity, StatusBar, Animated, Easing,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi} from '@services/api';
import {buildRouteMapUrl} from '@modules/news/mapbox';
import {scaleTextStyles} from '@utils/scaling';
import {fmtDayMonthUtc, fmtTimeUtc} from '@utils/datetime';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Nav = NativeStackNavigationProp<AgentStackParamList>;
type IconName = React.ComponentProps<typeof Icon>['name'];

// Design tokens (Bravo "Job Marketplace" handoff — obsidian + violet agent accent).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  violet:     '#A78BFA',
  violetSoft: '#C7B6FF',
  violetDeep: '#6D5AE0',
  amber:      '#F5C76B',
  fSans:    'Manrope_500Medium',
  fSemi:    'Manrope_600SemiBold',
  fBold:    'Manrope_700Bold',
  fMono:    'monospace',
};

type FilterType = 'all' | 'transfer' | 'timeslot' | 'closeprotection' | 'surveillance';
type ApplicationStatus = 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';
type JobTint = 'cpo' | 'driver' | 'recon';

// Hero-band tint per derived job type (CPO violet · Driver cobalt · Recon green).
const TINT: Record<JobTint, {label: string; ic: string; bg: string; bd: string; ring: string; tileA: string; tileB: string}> = {
  cpo:    {label: 'CPO',    ic: '#C7B6FF', bg: 'rgba(167,139,250,0.14)', bd: 'rgba(167,139,250,0.4)',  ring: 'rgba(167,139,250,0.4)',  tileA: 'rgba(124,90,214,0.22)', tileB: 'rgba(20,18,40,0.4)'},
  driver: {label: 'DRIVER', ic: '#A9C5FF', bg: 'rgba(91,141,239,0.14)',  bd: 'rgba(91,141,239,0.4)',   ring: 'rgba(91,141,239,0.4)',   tileA: 'rgba(47,91,224,0.22)',  tileB: 'rgba(15,22,40,0.4)'},
  recon:  {label: 'RECON',  ic: '#8FE6B4', bg: 'rgba(74,222,128,0.13)',  bd: 'rgba(74,222,128,0.36)',  ring: 'rgba(74,222,128,0.36)',  tileA: 'rgba(28,126,140,0.22)', tileB: 'rgba(10,30,30,0.4)'},
};

type Job = {
  id: string;
  type: FilterType;
  tint: JobTint;
  from: string;
  to: string;
  region: string;
  dur: string;
  date: string;
  time: string;
  slots: string;        // e.g. "1 CPO"
  slotLabel: string;    // e.g. "slots needed"
  fill: string;         // e.g. "0/1 filled"
  ref: string;          // short code
  rating: string;
  urgent?: boolean;
  pickup: {lng: number; lat: number} | null;
  dropoff: {lng: number; lat: number} | null;
  applicationStatus: ApplicationStatus | null;
};

// Parse a nullable numeric string coordinate pair into {lng,lat} or null.
function toCoord(lat: string | null, lng: string | null): {lng: number; lat: number} | null {
  if (lat === null || lng === null) {return null;}
  const la = Number(lat); const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) {return null;}
  return {lat: la, lng: ln};
}

const FILTERS: {key: FilterType; label: string}[] = [
  {key: 'all', label: 'All'},
  {key: 'transfer', label: 'Transfer'},
  {key: 'timeslot', label: 'Time Slot'},
  {key: 'closeprotection', label: 'Close Protection'},
  {key: 'surveillance', label: 'Surveillance'},
];

// Pulsing concentric rings behind the hero shield — the fallback hero when a
// job has no pickup/dropoff coordinates (so no route map can be drawn).
function ShieldBand({tint}: {tint: JobTint}) {
  const t = TINT[tint];
  const a = useRef(new Animated.Value(0)).current;
  const b = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = (v: Animated.Value, delay: number) =>
      Animated.loop(Animated.sequence([
        Animated.delay(delay),
        Animated.timing(v, {toValue: 1, duration: 2600, easing: Easing.out(Easing.ease), useNativeDriver: true}),
      ]));
    const la = loop(a, 0); const lb = loop(b, 1300);
    la.start(); lb.start();
    return () => { la.stop(); lb.stop(); };
  }, [a, b]);
  const ringStyle = (v: Animated.Value) => ({
    transform: [{scale: v.interpolate({inputRange: [0, 1], outputRange: [0.5, 2.1]})}],
    opacity: v.interpolate({inputRange: [0, 1], outputRange: [0.6, 0]}),
  });
  return (
    <>
      <Animated.View pointerEvents="none" style={[s.heroRing, {borderColor: t.ring}, ringStyle(a)]} />
      <Animated.View pointerEvents="none" style={[s.heroRing, {borderColor: t.ring}, ringStyle(b)]} />
      <View style={[s.heroShield, {backgroundColor: t.bg, borderColor: t.bd}]}>
        <Icon name="shield-check" size={26} color={t.ic} />
      </View>
    </>
  );
}

// Real Mapbox route map (pickup → destination) as the card hero. Falls back to
// the pulsing shield band when coordinates are unavailable.
function HeroBand({tint, pickup, dropoff}: {
  tint: JobTint;
  pickup: {lng: number; lat: number} | null;
  dropoff: {lng: number; lat: number} | null;
}) {
  const t = TINT[tint];
  const [mapFailed, setMapFailed] = useState(false);
  const mapUrl = useMemo(
    () => buildRouteMapUrl(pickup, dropoff, {lineColor: t.ic, width: 700, height: 232}),
    [pickup, dropoff, t.ic],
  );
  const showMap = !!mapUrl && !mapFailed;

  return (
    <LinearGradient
      colors={[t.tileA, t.tileB]}
      start={{x: 0.5, y: 0}} end={{x: 0.5, y: 1}}
      style={s.hero}>
      {showMap ? (
        <>
          <Image
            source={{uri: mapUrl}}
            style={StyleSheet.absoluteFill}
            resizeMode="cover"
            onError={() => setMapFailed(true)}
          />
          {/* legibility scrim + endpoint chips */}
          <LinearGradient
            colors={['rgba(7,9,13,0.05)', 'rgba(7,9,13,0.55)']}
            style={StyleSheet.absoluteFill}
          />
          <View style={s.routeChips}>
            <View style={s.routeChip}>
              <View style={[s.routeChipDot, {backgroundColor: '#22C55E'}]} />
              <Text style={s.routeChipText}>Pick-up</Text>
            </View>
            <Icon name="arrow-right" size={13} color="rgba(255,255,255,0.7)" />
            <View style={s.routeChip}>
              <View style={[s.routeChipDot, {backgroundColor: t.ic}]} />
              <Text style={s.routeChipText}>Drop-off</Text>
            </View>
          </View>
        </>
      ) : (
        <>
          {/* No route map for this job — brand imagery instead of a bare
              gradient. Never drawn OVER the map: that one is real data. */}
          <ImageryBackdrop source={Imagery.jobOfferHero} variant="hero" />
          <ShieldBand tint={tint} />
        </>
      )}
      <View style={[s.typePill, {backgroundColor: t.bg, borderColor: t.bd}]}>
        <Text style={[s.typePillText, {color: t.ic}]}>{t.label}</Text>
      </View>
    </LinearGradient>
  );
}

export default function JobMarketplaceScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const [filter, setFilter] = useState<FilterType>('all');
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  // Track jobs that are mid-apply / mid-withdraw so we don't double-fire.
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const {data} = await agentApi.getAvailableJobs();
      setJobs(data.jobs.map(j => {
        const dt = new Date(j.dispatch_at);
        const svc = (j.service ?? '').toLowerCase();
        // Derive the filter type from the backend `service`.
        const type: FilterType =
          svc.includes('transfer')                            ? 'transfer' :
          svc.includes('surveillance')                        ? 'surveillance' :
          svc.includes('recon') || svc.includes('extraction') ? 'timeslot' :
                                                                 'closeprotection';
        // Map the type to a hero-band tint.
        const tint: JobTint =
          type === 'transfer'                          ? 'driver' :
          type === 'surveillance' || type === 'timeslot' ? 'recon' :
                                                          'cpo';
        // route_label is typically "From → To"; fall back gracefully.
        const parts = (j.route_label || j.short_code).split(/→|->/).map(p => p.trim());
        const from = parts[0] || j.short_code;
        const to = parts[1] || '—';
        return {
          id: j.id,
          type,
          tint,
          from,
          to,
          region: j.region_code,
          dur: `${j.duration_hours}h`,
          date: fmtDayMonthUtc(dt),
          time: fmtTimeUtc(dt),
          slots: `${j.cpo_slots} ${TINT[tint].label.charAt(0) + TINT[tint].label.slice(1).toLowerCase()}`,
          slotLabel: j.cpo_slots > 1 ? 'slots needed' : 'slot needed',
          fill: `${j.slots_filled}/${j.cpo_slots} filled`,
          ref: j.short_code,
          rating: '—',
          pickup: toCoord(j.pickup_lat, j.pickup_lng),
          dropoff: toCoord(j.dropoff_lat, j.dropoff_lng),
          applicationStatus: j.application_status,
        };
      }));
    } catch { /* swallow — empty list will render */ }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const visible = filter === 'all' ? jobs : jobs.filter(j => j.type === filter);

  const handleApply = async (id: string, currentStatus: ApplicationStatus | null) => {
    if (busyId === id) {return;}
    // Withdraw stays inline (no pledge needed). New applies / re-applies bounce
    // into JobDetail so the dress pledge sheet is unavoidable — ops audits these.
    if (currentStatus === 'PENDING' || currentStatus === 'SHORTLISTED') {
      setBusyId(id);
      try { await agentApi.withdrawApplication(id); await refresh(); }
      catch { /* swallow */ }
      finally { setBusyId(null); }
      return;
    }
    if (currentStatus === 'ASSIGNED') {return;}
    navigation.navigate('JobDetail', {jobId: id});
  };

  function applyBtn(status: ApplicationStatus | null): {
    label: string; icon: IconName; fg: string; bg?: string; bd?: string; gradient?: boolean; disabled?: boolean;
  } {
    switch (status) {
      case 'PENDING':
      case 'SHORTLISTED':
        return {label: 'Applied', icon: 'check-circle', fg: '#7FE6A8',
                bg: 'rgba(74,222,128,0.12)', bd: 'rgba(74,222,128,0.34)'};
      case 'ASSIGNED':
        return {label: 'On Team', icon: 'shield-check', fg: '#A9C5FF',
                bg: 'rgba(91,141,239,0.14)', bd: 'rgba(91,141,239,0.4)', disabled: true};
      case 'REJECTED':
        return {label: 'Not Selected', icon: 'close-circle', fg: '#F58B97',
                bg: 'rgba(245,72,90,0.12)', bd: 'rgba(245,72,90,0.3)', disabled: true};
      default:
        return {label: 'Apply', icon: 'lightning-bolt', fg: '#fff', gradient: true};
    }
  }

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View pointerEvents="none" style={s.ambient} />

      {/* ── Top bar ── */}
      <View style={s.topbar}>
        <TouchableOpacity style={s.back} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={D.text} />
        </TouchableOpacity>
        <Text style={s.topbarTitle}>Available Jobs</Text>
      </View>

      {/* ── Title row ── */}
      <View style={s.titleRow}>
        <View style={{flex: 1, minWidth: 0}}>
          <Text style={s.title}>Job Marketplace</Text>
          <Text style={s.subtitle}>Available assignments near you</Text>
        </View>
        <View style={s.titleBtns}>
          <View style={s.iconBtn}>
            <Icon name="bell-outline" size={19} color={D.textDim} />
            {/* N-22 — removed the hardcoded always-lit dot (no store behind it). */}
          </View>
          <View style={s.iconBtn}>
            <Icon name="tune-variant" size={19} color={D.textDim} />
          </View>
        </View>
      </View>

      {/* ── Filter chips ── */}
      <ScrollView
        horizontal showsHorizontalScrollIndicator={false}
        style={s.filterScroll} contentContainerStyle={s.filterContent}>
        {FILTERS.map(f => {
          const on = filter === f.key;
          return (
            <TouchableOpacity key={f.key} onPress={() => setFilter(f.key)} activeOpacity={0.8}>
              {on ? (
                <LinearGradient
                  colors={['rgba(167,139,250,0.22)', 'rgba(124,90,214,0.1)']}
                  start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                  style={[s.chip, s.chipOn]}>
                  <Text style={[s.chipText, s.chipTextOn]}>{f.label}</Text>
                </LinearGradient>
              ) : (
                <View style={s.chip}>
                  <Text style={s.chipText}>{f.label}</Text>
                </View>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>

      {/* ── Job list ── */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[s.content, {paddingBottom: insets.bottom + 24}]}>

        {loading && (
          <View style={s.stateBox}>
            <LoadingView compact label="Loading jobs…" />
          </View>
        )}
        {!loading && visible.length === 0 && (
          <View style={s.stateBox}>
            <Icon name="clipboard-search-outline" size={36} color={D.textFaint} />
            <Text style={s.stateTitle}>No jobs available</Text>
            <Text style={s.stateSub}>Published jobs will appear here once ops dispatches them.</Text>
          </View>
        )}

        {visible.map(job => {
          const t = TINT[job.tint];
          const btn = applyBtn(job.applicationStatus);
          const busyHere = busyId === job.id;
          return (
            <TouchableOpacity
              key={job.id}
              style={s.card}
              onPress={() => navigation.navigate('JobDetail', {jobId: job.id})}
              activeOpacity={0.9}>
              <HeroBand tint={job.tint} pickup={job.pickup} dropoff={job.dropoff} />
              {job.urgent && (
                <View style={s.urgentBadge}>
                  <View style={s.urgentDot} />
                  <Text style={s.urgentText}>URGENT</Text>
                </View>
              )}

              <View style={s.cardBody}>
                {/* route + slots */}
                <View style={s.cardTop}>
                  <View style={{flex: 1, minWidth: 0}}>
                    <View style={s.routeRow}>
                      <Text style={s.routeText} numberOfLines={1}>{job.from}</Text>
                      <Icon name="arrow-right" size={16} color={t.ic} />
                      <Text style={s.routeText} numberOfLines={1}>{job.to}</Text>
                    </View>
                    <View style={s.locRow}>
                      <Icon name="map-marker-outline" size={13} color={D.textMute} />
                      <Text style={s.locText}>{job.region} · {job.dur}</Text>
                    </View>
                  </View>
                  <View style={{alignItems: 'flex-end', flexShrink: 0}}>
                    <Text style={s.slots}>{job.slots}</Text>
                    <Text style={s.slotLabel}>{job.slotLabel}</Text>
                  </View>
                </View>

                {/* detail mini-tiles */}
                <View style={s.tiles}>
                  <MiniTile icon="calendar-blank-outline" label={job.date} />
                  <MiniTile icon="clock-outline" label={job.time} />
                  <MiniTile icon="account-multiple-outline" label={job.fill} />
                </View>

                {/* footer */}
                <View style={s.cardBottom}>
                  <View style={s.metaRow}>
                    <Icon name="star" size={13} color={D.amber} />
                    <Text style={s.metaRating}>{job.rating}</Text>
                    <View style={s.metaSep} />
                    <Text style={s.metaRef} numberOfLines={1}>{job.ref}</Text>
                  </View>
                  <TouchableOpacity
                    activeOpacity={busyHere || btn.disabled ? 1 : 0.85}
                    disabled={busyHere || btn.disabled}
                    onPress={(e) => { e.stopPropagation?.(); void handleApply(job.id, job.applicationStatus); }}>
                    {btn.gradient ? (
                      <LinearGradient
                        colors={['#9F8CFB', D.violetDeep]}
                        start={{x: 0, y: 0}} end={{x: 0, y: 1}}
                        style={[s.applyBtn, s.applyBtnGrad, busyHere && {opacity: 0.6}]}>
                        <Icon name={btn.icon} size={16} color={btn.fg} />
                        <Text style={[s.applyText, {color: btn.fg}]}>{busyHere ? '…' : btn.label}</Text>
                      </LinearGradient>
                    ) : (
                      <View style={[s.applyBtn, {backgroundColor: btn.bg, borderWidth: 1, borderColor: btn.bd}, (busyHere || btn.disabled) && {opacity: 0.6}]}>
                        <Icon name={btn.icon} size={16} color={btn.fg} />
                        <Text style={[s.applyText, {color: btn.fg}]}>{busyHere ? '…' : btn.label}</Text>
                      </View>
                    )}
                  </TouchableOpacity>
                </View>
              </View>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

function MiniTile({icon, label}: {icon: IconName; label: string}) {
  return (
    <View style={s.tile}>
      <Icon name={icon} size={17} color={D.textDim} />
      <Text style={s.tileLabel} numberOfLines={1}>{label}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  ambient: {
    position: 'absolute', top: -100, alignSelf: 'center',
    width: 460, height: 270, borderRadius: 235,
    backgroundColor: 'rgba(124,90,214,0.09)',
  },

  // Top bar
  topbar: {flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 20, paddingTop: 12},
  back: {
    width: 40, height: 40, borderRadius: 12, flexShrink: 0,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  topbarTitle: {fontFamily: D.fBold, fontSize: 20, letterSpacing: -0.3, color: D.text},

  // Title row
  titleRow: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', paddingHorizontal: 20, paddingTop: 18},
  title: {fontFamily: D.fBold, fontSize: 26, letterSpacing: -0.8, color: D.text, lineHeight: 28},
  subtitle: {fontFamily: D.fSans, fontSize: 12.5, color: D.textMute, marginTop: 7, letterSpacing: -0.05},
  titleBtns: {flexDirection: 'row', gap: 9, flexShrink: 0},
  iconBtn: {
    width: 42, height: 42, borderRadius: 21, position: 'relative',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  bellDot: {position: 'absolute', top: 9, right: 10, width: 7, height: 7, borderRadius: 4, backgroundColor: D.violet, borderWidth: 1.5, borderColor: D.bg},

  // Filters
  filterScroll: {flexGrow: 0, marginTop: 16},
  filterContent: {paddingHorizontal: 20, paddingBottom: 4, gap: 9},
  chip: {
    paddingHorizontal: 17, paddingVertical: 9, borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  chipOn: {borderColor: 'rgba(167,139,250,0.5)'},
  chipText: {fontFamily: D.fSemi, fontSize: 13.5, color: D.textDim, letterSpacing: -0.1},
  chipTextOn: {fontFamily: D.fBold, color: D.violetSoft},

  content: {paddingHorizontal: 20, paddingTop: 14, gap: 14},

  // State boxes
  stateBox: {paddingVertical: 48, alignItems: 'center', gap: 10},
  stateTitle: {fontFamily: D.fBold, fontSize: 15, color: D.textDim},
  stateSub: {fontFamily: D.fSans, fontSize: 12, color: D.textMute, marginTop: 2, textAlign: 'center', paddingHorizontal: 30, lineHeight: 17},

  // Card
  card: {
    borderRadius: 22, overflow: 'hidden',
    backgroundColor: 'rgba(18,22,32,0.78)', borderWidth: 1, borderColor: D.hair,
    shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 18, shadowOffset: {width: 0, height: 12}, elevation: 7,
  },

  // Hero band
  hero: {height: 116, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderBottomWidth: 1, borderBottomColor: D.hair},
  heroRing: {position: 'absolute', width: 54, height: 54, borderRadius: 27, borderWidth: 1.5},
  heroShield: {width: 54, height: 54, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center'},
  typePill: {position: 'absolute', top: 12, right: 12, paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999, borderWidth: 1},
  typePillText: {fontFamily: D.fMono, fontSize: 9, fontWeight: '800', letterSpacing: 1.2},
  routeChips: {position: 'absolute', bottom: 10, left: 12, flexDirection: 'row', alignItems: 'center', gap: 8},
  routeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999,
    backgroundColor: 'rgba(10,13,20,0.7)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  routeChipDot: {width: 6, height: 6, borderRadius: 3},
  routeChipText: {fontFamily: D.fMono, fontSize: 9, fontWeight: '700', letterSpacing: 0.4, color: '#fff'},

  urgentBadge: {
    position: 'absolute', top: 12, left: 12, flexDirection: 'row', alignItems: 'center', gap: 5,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
    backgroundColor: 'rgba(245,181,68,0.12)', borderWidth: 1, borderColor: 'rgba(245,181,68,0.34)',
  },
  urgentDot: {width: 5, height: 5, borderRadius: 3, backgroundColor: D.amber},
  urgentText: {fontFamily: D.fMono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1, color: D.amber},

  // Card body
  cardBody: {padding: 16, paddingTop: 15},
  cardTop: {flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12},
  routeRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  routeText: {fontFamily: D.fBold, fontSize: 17, letterSpacing: -0.3, color: D.text, flexShrink: 1},
  locRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 6},
  locText: {fontFamily: D.fMono, fontSize: 10.5, color: D.textMute, letterSpacing: 0.4},
  slots: {fontFamily: D.fBold, fontSize: 19, letterSpacing: -0.4, color: D.amber},
  slotLabel: {fontFamily: D.fMono, fontSize: 9, color: D.textMute, letterSpacing: 0.5, marginTop: 3, textTransform: 'uppercase'},

  // Detail tiles
  tiles: {flexDirection: 'row', gap: 9, marginTop: 14},
  tile: {
    flex: 1, alignItems: 'center', gap: 7, paddingVertical: 11, paddingHorizontal: 4,
    borderRadius: 13, backgroundColor: 'rgba(255,255,255,0.03)', borderWidth: 1, borderColor: D.hair2,
  },
  tileLabel: {fontFamily: D.fBold, fontSize: 12.5, letterSpacing: -0.1, color: D.text},

  // Footer
  cardBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 15, gap: 10},
  metaRow: {flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1, minWidth: 0},
  metaRating: {fontFamily: D.fMono, fontSize: 9.5, fontWeight: '600', color: D.textDim, letterSpacing: 0.3},
  metaSep: {width: 3, height: 3, borderRadius: 2, backgroundColor: D.textFaint},
  metaRef: {fontFamily: D.fMono, fontSize: 9, color: D.textMute, letterSpacing: 0.3, flexShrink: 1},

  applyBtn: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 18, paddingVertical: 10, borderRadius: 13},
  applyBtnGrad: {
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.violetDeep, shadowOpacity: 0.45, shadowRadius: 16, shadowOffset: {width: 0, height: 8}, elevation: 6,
  },
  applyText: {fontFamily: D.fBold, fontSize: 14.5, letterSpacing: 0.2},
}));
