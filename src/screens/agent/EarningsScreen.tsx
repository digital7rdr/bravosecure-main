import React, {useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView,
  TouchableOpacity, StatusBar, RefreshControl, ActivityIndicator,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {Colors, Palette} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {agentApi, walletApi, type WalletTransactionDto} from '@services/api';
import {bcFromAed} from '@screens/booking/pricing';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import LoadingView from '@components/LoadingView';

type MissionHistoryRow = Awaited<ReturnType<typeof agentApi.getMissionHistory>>['data'][number];

// Agent wallet identity — now sourced from the centralised Palette so the
// gold/purple isn't a magic hex re-declared per screen.
const PURPLE = Palette.agentPurple;
const GOLD   = Palette.agentGold;

function formatBookingRef(id: string | undefined): string {
  if (!id) {return '';}
  return `BL-${id.replace(/-/g, '').slice(-8).toUpperCase()}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  // UTC so payout/mission times match the backend value on every device.
  return d.toLocaleString('en-GB', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'UTC'}) + 'Z';
}

export default function EarningsScreen() {
  const insets     = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<AgentStackParamList>>();
  const [balance, setBalance]       = useState<number | null>(null);
  const [currency, setCurrency]     = useState<string>('AED');
  const [payouts, setPayouts]       = useState<WalletTransactionDto[]>([]);
  const [jobsTotal, setJobsTotal]   = useState<number>(0);
  const [dutyHrs, setDutyHrs]       = useState<number>(0);
  const [rate, setRate]             = useState<string>('—');
  const [missions, setMissions]     = useState<MissionHistoryRow[]>([]);
  const [loading, setLoading]       = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // Pagination — server cap is 50 per call; load-more bumps the offset
  // and appends. `hasMore` tracks the last response so the button hides
  // once we've drained the ledger.
  const PAGE_SIZE = 50;
  const [offset, setOffset]       = useState(0);
  const [hasMore, setHasMore]     = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [fetchError, setFetchError]   = useState<string | null>(null);

  // Keep all payout rows regardless of `status` so a failed Stripe
  // settlement is visible (with a chip) instead of looking like "No
  // payouts yet" — same UX bug we just fixed for the client wallet.
  const isPayoutTx = (t: WalletTransactionDto) => t.type === 'payout';

  const fetchPage = async (pageOffset: number, append: boolean) => {
    try {
      const [meRes, balRes, txRes, missionRes] = await Promise.all([
        pageOffset === 0 ? agentApi.getMe() : Promise.resolve(null),
        pageOffset === 0 ? walletApi.getBalance() : Promise.resolve(null),
        walletApi.getTransactions({limit: PAGE_SIZE, offset: pageOffset}),
        // Mission history is a single (capped) list, only needed on first page.
        pageOffset === 0 ? agentApi.getMissionHistory() : Promise.resolve(null),
      ]);
      if (meRes) {
        setJobsTotal(meRes.data.agent.jobs_total ?? 0);
        setDutyHrs(meRes.data.agent.duty_hours_mtd ?? 0);
        if (meRes.data.agent.rate_aed_per_hour) {
          setRate(`${bcFromAed(Number(meRes.data.agent.rate_aed_per_hour))} BC/hr`);
        }
      }
      if (missionRes) {
        setMissions(Array.isArray(missionRes.data) ? missionRes.data : []);
      }
      if (balRes) {
        setBalance(balRes.data.bravo_credits);
        setCurrency(balRes.data.currency);
      }
      const page = txRes.data.transactions.filter(isPayoutTx);
      setPayouts(prev => append ? [...prev, ...page] : page);
      // If the server returned fewer than PAGE_SIZE total rows (across
      // all types) we know there's nothing left.
      setHasMore(txRes.data.transactions.length === PAGE_SIZE);
      setFetchError(null);
    } catch (e) {
      // Surface the failure rather than silently rendering "No payouts" —
      // a wallet API outage was previously indistinguishable from
      // "agent has never been paid".
      setFetchError((e as Error)?.message ?? 'Failed to load payouts');
    }
  };

  const fetchAll = async () => {
    setLoading(true);
    setOffset(0);
    await fetchPage(0, false);
    setLoading(false);
  };

  const loadMore = async () => {
    if (loadingMore || !hasMore) {return;}
    setLoadingMore(true);
    const next = offset + PAGE_SIZE;
    setOffset(next);
    await fetchPage(next, true);
    setLoadingMore(false);
  };

  // Mount-only initial fetch — fetchAll closes over setters which are stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void fetchAll(); }, []);

  const onRefresh = async () => {
    setRefreshing(true);
    setOffset(0);
    await fetchPage(0, false);
    setRefreshing(false);
  };

  // Stats roll up only successfully-settled payouts so a failed row
  // doesn't inflate the dashboard. The ledger list below shows ALL
  // payout rows with a status chip.
  const settled = payouts.filter(t => t.status === 'succeeded');
  const totalEarned = settled.reduce((sum, t) => sum + (t.amount ?? 0), 0);
  const thirtyDaysAgo = Date.now() - 30 * 24 * 3600 * 1000;
  const earned30d = settled
    .filter(t => new Date(t.created_at).getTime() > thirtyDaysAgo)
    .reduce((sum, t) => sum + (t.amount ?? 0), 0);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      <View style={styles.header}>
        <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>My Earnings</Text>
        <View style={styles.backBtn} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor={GOLD} />}>

        {/* Earned-balance hero.
            Issue 38 — this is a PAYOUT balance, not a purchasable one. The
            "Top Up Credits" CTA that used to sit here routed into the CLIENT
            purchase flow and conflated the two. Top-up now lives only in the
            client wallet (CreditsScreen). */}
        <View style={styles.heroCard}>
      <ImageryBackdrop source={Imagery.proBilling} variant="hero" radius={20} />
          <Text style={styles.heroLabel}>EARNED BALANCE</Text>
          <View style={styles.heroRow}>
            <Text style={styles.heroAmount}>
              {loading ? '…' : balance !== null ? balance.toLocaleString() : '—'}
            </Text>
            <Text style={styles.heroCurrency}>BC</Text>
          </View>
          <Text style={styles.heroSub}>1 BC = 1 {currency} · settled to your wallet on mission completion</Text>
          <Text style={styles.heroNote}>
            Payout balance — separate from client Bravo Credits.
          </Text>
        </View>

        {/* Stats row */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>EARNED · LAST 30D</Text>
            <Text style={styles.statValue}>{earned30d.toLocaleString()}<Text style={styles.statUnit}> BC</Text></Text>
            <Text style={styles.statSub}>{payouts.filter(t => new Date(t.created_at).getTime() > thirtyDaysAgo).length} missions</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>EARNED · ALL TIME</Text>
            <Text style={styles.statValue}>{totalEarned.toLocaleString()}<Text style={styles.statUnit}> BC</Text></Text>
            <Text style={styles.statSub}>{payouts.length} missions</Text>
          </View>
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>JOBS COMPLETED</Text>
            <Text style={styles.statValue}>{jobsTotal}</Text>
            <Text style={styles.statSub}>All time</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statLabel}>DUTY HOURS · MTD</Text>
            <Text style={styles.statValue}>{dutyHrs}<Text style={styles.statUnit}>h</Text></Text>
            <Text style={styles.statSub}>{rate}</Text>
          </View>
        </View>

        {/* Recent payouts */}
        <Text style={styles.sectionLabel}>RECENT PAYOUTS</Text>
        <View style={styles.payoutList}>
          {loading ? (
            <LoadingView compact label="Loading payouts…" />
          ) : payouts.length === 0 ? (
            <View style={styles.emptyCard}>
              <Icon name="bank-outline" size={28} color="#475569" />
              <Text style={styles.emptyTitle}>No payouts yet</Text>
              <Text style={styles.emptySub}>
                Once a mission you&apos;re assigned to completes, the credits land here.
              </Text>
            </View>
          ) : payouts.map(t => {
            const tappable = !!t.booking_id;
            const isFailed   = t.status === 'failed';
            const isPending  = t.status === 'pending';
            const isRefunded = t.status === 'refunded';
            const isOk       = t.status === 'succeeded';
            const rowContent = (
              <>
                <View style={[
                  styles.payoutIcon,
                  isFailed   && {backgroundColor: 'rgba(248,113,113,0.10)', borderColor: 'rgba(248,113,113,0.3)'},
                  isPending  && {backgroundColor: 'rgba(245,158,11,0.10)', borderColor: 'rgba(245,158,11,0.3)'},
                  isRefunded && {backgroundColor: 'rgba(96,165,250,0.10)', borderColor: 'rgba(96,165,250,0.3)'},
                ]}>
                  <Icon
                    name={isFailed ? 'alert-circle-outline' : isPending ? 'clock-outline' : isRefunded ? 'undo' : 'cash-plus'}
                    size={18}
                    color={isFailed ? '#F87171' : isPending ? '#F59E0B' : isRefunded ? '#60A5FA' : '#4ADE80'}
                  />
                </View>
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={styles.payoutTitle} numberOfLines={1}>
                    {t.description ?? 'Mission payout'}
                  </Text>
                  <Text style={styles.payoutMeta}>
                    {formatDate(t.created_at)}
                    {t.booking_id ? `  ·  ${formatBookingRef(t.booking_id)}` : ''}
                  </Text>
                </View>
                <View style={{alignItems: 'flex-end'}}>
                  <Text style={[
                    styles.payoutAmount,
                    !isOk && {color: '#94A3B8'},
                  ]}>
                    {isOk ? '+' : ''}{t.amount.toLocaleString()} BC
                  </Text>
                  <Text style={[
                    styles.payoutStatus,
                    isFailed   && {color: '#F87171'},
                    isPending  && {color: '#F59E0B'},
                    isRefunded && {color: '#60A5FA'},
                  ]}>
                    {t.status.toUpperCase()}
                  </Text>
                </View>
                {tappable && (
                  <Icon name="chevron-right" size={18} color="#475569" style={{marginLeft: 4}} />
                )}
              </>
            );
            return tappable ? (
              <TouchableOpacity
                key={t.id}
                activeOpacity={0.75}
                style={styles.payoutRow}
                onPress={() => navigation.navigate('MissionSummary', {bookingId: t.booking_id as string})}>
                {rowContent}
              </TouchableOpacity>
            ) : (
              <View key={t.id} style={styles.payoutRow}>{rowContent}</View>
            );
          })}
          {hasMore && payouts.length > 0 && (
            <TouchableOpacity
              style={styles.loadMoreBtn}
              onPress={() => void loadMore()}
              activeOpacity={0.75}
              disabled={loadingMore}>
              {loadingMore
                ? <ActivityIndicator color={PURPLE} />
                : <Text style={styles.loadMoreText}>LOAD MORE</Text>}
            </TouchableOpacity>
          )}
        </View>

        {/* Mission history — every mission the agent crewed (completed or
            aborted), including ones with no payout row. Mirrors what ops sees
            in the console so the two histories stay in sync. */}
        {!loading && missions.length > 0 && (
          <>
            <Text style={styles.sectionLabel}>MISSION HISTORY</Text>
            <View style={styles.payoutList}>
              {missions.map(m => {
                const aborted = m.status === 'ABORTED';
                const km = m.route_distance_m !== null ? (m.route_distance_m / 1000).toFixed(1) : null;
                const route = m.dropoff_address
                  ? `${m.pickup_address} → ${m.dropoff_address}`
                  : m.pickup_address;
                return (
                  <TouchableOpacity
                    key={m.mission_id}
                    activeOpacity={0.75}
                    style={styles.payoutRow}
                    onPress={() => navigation.navigate('MissionSummary', {bookingId: m.booking_id})}>
                    <View style={[
                      styles.payoutIcon,
                      aborted && {backgroundColor: 'rgba(248,113,113,0.10)', borderColor: 'rgba(248,113,113,0.3)'},
                    ]}>
                      <Icon
                        name={aborted ? 'close-octagon-outline' : 'shield-check'}
                        size={18}
                        color={aborted ? '#F87171' : '#4ADE80'}
                      />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={styles.payoutTitle} numberOfLines={1}>
                        {m.short_code}{m.is_lead ? '  · LEAD' : ''}
                      </Text>
                      <Text style={styles.payoutMeta} numberOfLines={1}>
                        {m.ended_at ? formatDate(m.ended_at) : '—'}
                        {km ? `  ·  ${km} km` : ''}
                        {m.region_label ? `  ·  ${m.region_label}` : ''}
                      </Text>
                      <Text style={styles.payoutMeta} numberOfLines={1}>{route}</Text>
                    </View>
                    <View style={{alignItems: 'flex-end'}}>
                      {m.paid_credits !== null ? (
                        <Text style={styles.payoutAmount}>+{m.paid_credits.toLocaleString()} BC</Text>
                      ) : (
                        <Text style={[styles.payoutAmount, {color: '#94A3B8'}]}>—</Text>
                      )}
                      <Text style={[
                        styles.payoutStatus,
                        aborted && {color: '#F87171'},
                      ]}>
                        {m.status}
                      </Text>
                    </View>
                    <Icon name="chevron-right" size={18} color="#475569" style={{marginLeft: 4}} />
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}

        {fetchError && (
          <View style={styles.errorBanner}>
            <Icon name="alert" size={14} color="#F87171" />
            <Text style={styles.errorText} numberOfLines={2}>
              Couldn&apos;t load payouts: {fetchError}
            </Text>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root:         {flex: 1, backgroundColor: Colors.background},
  header:       {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10},
  backBtn:      {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle:  {color: '#F1F5F9', fontSize: 15, fontWeight: '800'},

  content: {paddingHorizontal: 16, paddingTop: 4, gap: 14},

  heroCard: {
    padding: 18, borderRadius: 20,
    backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45',
  },
  heroLabel:    {color: '#94A3B8', fontSize: 10, fontWeight: '700', letterSpacing: 1.8, marginBottom: 8},
  heroRow:      {flexDirection: 'row', alignItems: 'baseline', gap: 8},
  heroAmount:   {color: GOLD, fontSize: 38, fontWeight: '800', letterSpacing: -1},
  heroCurrency: {color: GOLD, fontSize: 18, fontWeight: '800'},
  heroSub:      {color: '#475569', fontSize: 11, marginTop: 8, lineHeight: 15},
  heroNote:     {color: '#475569', fontSize: 10.5, marginTop: 6, lineHeight: 14, fontStyle: 'italic'},

  statsRow:  {flexDirection: 'row', gap: 12},
  statCard:  {flex: 1, padding: 13, borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45'},
  statLabel: {color: '#475569', fontSize: 9.5, fontWeight: '800', letterSpacing: 1.2, marginBottom: 6},
  statValue: {color: '#F1F5F9', fontSize: 22, fontWeight: '800'},
  statUnit:  {color: '#94A3B8', fontSize: 12, fontWeight: '700'},
  statSub:   {color: '#475569', fontSize: 10, marginTop: 4},

  sectionLabel: {color: '#94A3B8', fontSize: 10, fontWeight: '800', letterSpacing: 1.5, marginTop: 6, marginBottom: -2},
  payoutList:   {borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  payoutRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingVertical: 12, paddingHorizontal: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: '#1E2D45',
  },
  payoutIcon: {
    width: 36, height: 36, borderRadius: 9,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(74,222,128,0.10)',
    borderWidth: 1, borderColor: 'rgba(74,222,128,0.3)',
  },
  payoutTitle:  {color: '#E2E8F0', fontSize: 13, fontWeight: '700'},
  payoutMeta:   {color: '#64748B', fontSize: 10.5, marginTop: 2},
  payoutAmount: {color: '#4ADE80', fontSize: 14, fontWeight: '800'},
  payoutStatus: {color: '#475569', fontSize: 9, fontWeight: '700', letterSpacing: 1, marginTop: 2},

  emptyCard: {padding: 28, alignItems: 'center', gap: 8},
  emptyTitle: {color: '#94A3B8', fontSize: 13, fontWeight: '700'},
  emptySub:   {color: '#475569', fontSize: 11, textAlign: 'center', lineHeight: 16},

  loadMoreBtn: {
    paddingVertical: 14, alignItems: 'center', justifyContent: 'center',
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: '#1E2D45',
  },
  loadMoreText: {color: PURPLE, fontSize: 11, fontWeight: '800', letterSpacing: 1.5},

  errorBanner: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 12, borderRadius: 10,
    backgroundColor: 'rgba(248,113,113,0.06)',
    borderWidth: 1, borderColor: 'rgba(248,113,113,0.3)',
  },
  errorText: {flex: 1, color: '#F87171', fontSize: 11, lineHeight: 15},
}));
