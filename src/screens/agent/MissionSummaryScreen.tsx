import React, {useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {Colors} from '@theme/index';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type Rt = RouteProp<AgentStackParamList, 'MissionSummary'>;

type Summary = Awaited<ReturnType<typeof agentApi.getPayoutSummary>>['data'];

const GREEN  = '#4ADE80';
const RED    = '#F87171';
const GOLD   = '#D4AF37';

function formatDate(iso: string | null | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  // UTC so mission times match the backend/ops value on every device.
  return d.toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  }) + 'Z';
}

function formatDuration(startedAt: string | null, endedAt: string | null): string {
  if (!startedAt || !endedAt) {return '—';}
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (ms <= 0) {return '—';}
  const mins = Math.round(ms / 60_000);
  if (mins < 60) {return `${mins} min`;}
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export default function MissionSummaryScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation();
  const route      = useRoute<Rt>();
  const {bookingId} = route.params;

  const [data, setData]   = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr]     = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await agentApi.getPayoutSummary(bookingId);
        if (!cancelled) {setData(res.data);}
      } catch (e: unknown) {
        // getPayoutSummary requires a SETTLED mission_payouts row (INNER JOIN)
        // — a mission that completed but whose payout hasn't been decided yet
        // legitimately has none. The mission-history list LEFT JOINs the same
        // table (so it still shows the row with paid_credits: null), which is
        // exactly what put a tappable-but-404ing entry in front of the user.
        const serverMsg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
        const friendly = serverMsg === 'payout_not_found'
          ? "This mission's payout hasn't been settled yet — check back once it's decided."
          : serverMsg ?? 'Failed to load summary';
        if (!cancelled) {setErr(friendly);}
      } finally {
        if (!cancelled) {setLoading(false);}
      }
    })();
    return () => { cancelled = true; };
  }, [bookingId]);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>Mission Summary</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {loading && <LoadingView compact label="Loading summary…" />}

        {err && !loading && (
          <View style={styles.errorCard}>
            <Icon name="alert-circle-outline" size={28} color={RED} />
            <Text style={styles.errorTitle}>Couldn&apos;t load this summary</Text>
            <Text style={styles.errorSub}>{err}</Text>
          </View>
        )}

        {data && !loading && (
          <>
            {/* Hero — mission short code + status pill */}
            <View style={styles.hero}>
      <ImageryBackdrop source={Imagery.svcExecTransport} variant="hero" radius={14} />
              <Text style={styles.heroLabel}>MISSION</Text>
              <Text style={styles.heroCode}>{data.mission.short_code}</Text>
              <View style={styles.statusRow}>
                <View style={[styles.statusPill, statusStyle(data.mission.status)]}>
                  <View style={[styles.statusDot, {backgroundColor: statusColor(data.mission.status)}]}/>
                  <Text style={[styles.statusText, {color: statusColor(data.mission.status)}]}>
                    {data.mission.status}
                  </Text>
                </View>
                <Text style={styles.regionText}>{data.booking.region_label}</Text>
              </View>
            </View>

            {/* Payout block — the headline number */}
            <View style={styles.payoutCard}>
              <Text style={styles.payoutLabel}>YOU EARNED</Text>
              <View style={styles.payoutAmountRow}>
                <Text style={styles.payoutAmount}>{data.payout.paid_credits.toLocaleString()}</Text>
                <Text style={styles.payoutCurrency}>BC</Text>
              </View>
              {data.payout.deduction_credits > 0 ? (
                <View style={styles.deductionRow}>
                  <Icon name="alert-octagon-outline" size={14} color={GOLD} />
                  <Text style={styles.deductionText}>
                    Docked {data.payout.deduction_credits} BC from {data.payout.proposed_credits} BC proposed
                  </Text>
                </View>
              ) : (
                <Text style={styles.payoutSub}>
                  Even split · {data.booking.cpo_count} CPO{data.booking.cpo_count > 1 ? 's' : ''} on this mission
                </Text>
              )}
              {data.payout.deduction_reason && (
                <View style={styles.reasonBox}>
                  <Text style={styles.reasonLabel}>OPS NOTE</Text>
                  <Text style={styles.reasonText}>{data.payout.deduction_reason}</Text>
                </View>
              )}
            </View>

            {/* Route block */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>ROUTE</Text>
              <View style={styles.routeCard}>
                <View style={styles.routeStop}>
                  <View style={[styles.stopDot, {backgroundColor: GREEN}]}/>
                  <View style={{flex: 1}}>
                    <Text style={styles.stopLabel}>PICKUP</Text>
                    <Text style={styles.stopAddr}>{data.booking.pickup_address}</Text>
                  </View>
                </View>
                <View style={styles.routeLine}/>
                <View style={styles.routeStop}>
                  <View style={[styles.stopDot, {backgroundColor: GOLD}]}/>
                  <View style={{flex: 1}}>
                    <Text style={styles.stopLabel}>DROPOFF</Text>
                    <Text style={styles.stopAddr}>{data.booking.dropoff_address ?? '—'}</Text>
                  </View>
                </View>
              </View>
            </View>

            {/* Stats grid */}
            <View style={styles.statsRow}>
              <Stat
                label="DISTANCE"
                value={data.mission.route_distance_m
                  ? `${(Number(data.mission.route_distance_m) / 1000).toFixed(1)} km`
                  : '—'}
              />
              <Stat
                label="DURATION"
                value={formatDuration(data.mission.started_at, data.mission.ended_at)}
              />
            </View>
            <View style={styles.statsRow}>
              <Stat label="STARTED"  value={formatDate(data.mission.started_at)} />
              <Stat label="ENDED"    value={formatDate(data.mission.ended_at)} />
            </View>

            {/* Booking metadata — service, when, crew size. The client's
                invoice total is intentionally NOT shown to the CPO; it
                exposes the platform margin (booking total minus their
                payout). The agent only needs to see their own payout,
                which is rendered above this card. */}
            <View style={styles.section}>
              <Text style={styles.sectionLabel}>BOOKING</Text>
              <View style={styles.bookingCard}>
                <Row left="Service"      right={data.booking.service.replace(/_/g, ' ').toUpperCase()} />
                <Row left="Pickup time"  right={formatDate(data.booking.pickup_time)} />
                <Row left="Crew size"    right={`${data.booking.cpo_count} CPO`} last />
              </View>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

function Stat({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.statCard}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={styles.statValue}>{value}</Text>
    </View>
  );
}

function Row({left, right, last}: {left: string; right: string; last?: boolean}) {
  return (
    <View style={[styles.row, last && {borderBottomWidth: 0}]}>
      <Text style={styles.rowLeft}>{left}</Text>
      <Text style={styles.rowRight}>{right}</Text>
    </View>
  );
}

function statusColor(status: string): string {
  if (status === 'COMPLETED') {return GREEN;}
  if (status === 'ABORTED')   {return RED;}
  if (status === 'SOS')       {return RED;}
  return '#60A5FA';
}

function statusStyle(status: string) {
  return {
    backgroundColor: status === 'COMPLETED' ? 'rgba(74,222,128,0.10)'
      : status === 'ABORTED' ? 'rgba(248,113,113,0.12)'
      : 'rgba(96,165,250,0.10)',
    borderColor: status === 'COMPLETED' ? 'rgba(74,222,128,0.35)'
      : status === 'ABORTED' ? 'rgba(248,113,113,0.35)'
      : 'rgba(96,165,250,0.35)',
  };
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12,
    backgroundColor: Colors.background,
  },
  backBtn: {width: 36, height: 36, alignItems: 'flex-start', justifyContent: 'center'},
  headerTitle: {color: '#E2E8F0', fontFamily: 'Manrope-ExtraBold', fontSize: 17, letterSpacing: 0.4},
  content: {paddingHorizontal: 16, paddingTop: 24},

  hero: {
    backgroundColor: 'rgba(124,58,237,0.10)',
    borderColor: 'rgba(124,58,237,0.35)', borderWidth: 1,
    borderRadius: 14, padding: 18, marginBottom: 16,
  },
  heroLabel: {fontFamily: 'JetBrains Mono', fontSize: 10, color: '#94A3B8', letterSpacing: 1.4, fontWeight: '700'},
  heroCode: {fontFamily: 'JetBrains Mono', fontSize: 22, color: '#FFFFFF', fontWeight: '800', marginTop: 6, letterSpacing: 0.5},
  statusRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 12},
  statusPill: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 9, paddingVertical: 4, borderRadius: 6, borderWidth: 1,
  },
  statusDot: {width: 6, height: 6, borderRadius: 3},
  statusText: {fontFamily: 'JetBrains Mono', fontSize: 10, fontWeight: '800', letterSpacing: 1},
  regionText: {fontFamily: 'JetBrains Mono', fontSize: 10, color: '#94A3B8', letterSpacing: 1, fontWeight: '700'},

  payoutCard: {
    backgroundColor: '#0F1729',
    borderColor: 'rgba(74,222,128,0.30)', borderWidth: 1,
    borderRadius: 14, padding: 18, marginBottom: 18,
  },
  payoutLabel: {fontFamily: 'JetBrains Mono', fontSize: 10.5, color: '#94A3B8', letterSpacing: 1.4, fontWeight: '700'},
  payoutAmountRow: {flexDirection: 'row', alignItems: 'baseline', marginTop: 8, gap: 8},
  payoutAmount: {fontFamily: 'JetBrains Mono', fontSize: 38, color: GREEN, fontWeight: '800', letterSpacing: -1},
  payoutCurrency: {fontFamily: 'JetBrains Mono', fontSize: 16, color: GREEN, fontWeight: '700', letterSpacing: 1},
  payoutSub: {fontFamily: 'JetBrains Mono', fontSize: 11, color: '#94A3B8', marginTop: 8, letterSpacing: 0.4},
  deductionRow: {flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8},
  deductionText: {fontFamily: 'JetBrains Mono', fontSize: 11, color: GOLD, fontWeight: '700'},
  reasonBox: {marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: '#1E293B', borderWidth: 1, borderColor: '#334155'},
  reasonLabel: {fontFamily: 'JetBrains Mono', fontSize: 9, color: GOLD, letterSpacing: 1.4, fontWeight: '700', marginBottom: 4},
  reasonText: {fontFamily: 'Manrope', fontSize: 13, color: '#E2E8F0', lineHeight: 18},

  section: {marginBottom: 16},
  sectionLabel: {fontFamily: 'JetBrains Mono', fontSize: 10, color: '#64748B', letterSpacing: 1.4, fontWeight: '700', marginBottom: 8, marginLeft: 4},

  routeCard: {backgroundColor: '#0F1729', borderColor: '#1E293B', borderWidth: 1, borderRadius: 12, padding: 14},
  routeStop: {flexDirection: 'row', alignItems: 'flex-start', gap: 12},
  routeLine: {width: 1, height: 18, backgroundColor: '#334155', marginLeft: 5, marginVertical: 4},
  stopDot: {width: 11, height: 11, borderRadius: 6, marginTop: 4},
  stopLabel: {fontFamily: 'JetBrains Mono', fontSize: 9.5, color: '#64748B', letterSpacing: 1.2, fontWeight: '700'},
  stopAddr: {fontFamily: 'Manrope', fontSize: 13.5, color: '#E2E8F0', fontWeight: '600', marginTop: 2, lineHeight: 18},

  statsRow: {flexDirection: 'row', gap: 10, marginBottom: 10},
  statCard: {flex: 1, backgroundColor: '#0F1729', borderColor: '#1E293B', borderWidth: 1, borderRadius: 10, padding: 12},
  statLabel: {fontFamily: 'JetBrains Mono', fontSize: 9.5, color: '#64748B', letterSpacing: 1.2, fontWeight: '700'},
  statValue: {fontFamily: 'JetBrains Mono', fontSize: 16, color: '#E2E8F0', fontWeight: '800', marginTop: 6},

  bookingCard: {backgroundColor: '#0F1729', borderColor: '#1E293B', borderWidth: 1, borderRadius: 12, paddingHorizontal: 14},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 11, borderBottomWidth: 1, borderBottomColor: '#1E293B'},
  rowLeft: {fontFamily: 'JetBrains Mono', fontSize: 11, color: '#94A3B8', letterSpacing: 0.4, fontWeight: '600'},
  rowRight: {fontFamily: 'JetBrains Mono', fontSize: 12, color: '#E2E8F0', fontWeight: '700'},

  errorCard: {alignItems: 'center', padding: 32, gap: 8},
  errorTitle: {fontFamily: 'Manrope-Bold', fontSize: 15, color: '#E2E8F0'},
  errorSub: {fontFamily: 'JetBrains Mono', fontSize: 11, color: '#94A3B8', textAlign: 'center'},
}));
