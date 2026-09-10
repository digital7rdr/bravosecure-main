import React, {useCallback, useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import LoadingView from '@components/LoadingView';
import {useNavigation} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {agentApi} from '@services/api';
import {goBackOnce} from '@navigation/tapGuard';
import {useProPlanGate} from '@hooks/useProPlanGate';

const PRO = '#6366F1';

type TripTag = 'all' | 'completed' | 'incident' | 'high-risk';

interface Trip {
  id: string;
  title: string;
  sub: string;
  credits: string;
  status: string;
  tags: string[];
}

// Map a mission-history row into the card shape this screen renders.
function toTrip(m: {
  mission_id: string; short_code: string; status: string; role: string;
  started_at: string | null; ended_at: string | null;
  pickup_address: string; dropoff_address: string | null; region_label: string | null;
  paid_credits: number | null;
}): Trip {
  const route = m.dropoff_address
    ? `${m.pickup_address} → ${m.dropoff_address}`
    : m.pickup_address;
  const status = (m.status || '').toUpperCase();
  const tags = ['all', status === 'COMPLETED' ? 'completed' : '', status === 'ABORTED' ? 'incident' : '']
    .filter(Boolean);
  return {
    id: m.mission_id,
    title: route || m.short_code,
    sub: [m.role, m.region_label].filter(Boolean).join(' · '),
    credits: typeof m.paid_credits === 'number' ? `${m.paid_credits.toLocaleString()} BC` : '—',
    status,
    tags,
  };
}

const FILTERS: {key: TripTag; label: string}[] = [
  {key: 'all', label: 'All'},
  {key: 'completed', label: 'Completed'},
  {key: 'incident', label: 'Incident'},
];

export default function ProActivityHistoryScreen() {
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (see the hook)
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const [filter, setFilter] = useState<TripTag>('all');
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const {data} = await agentApi.getMissionHistory();
      setTrips(data.map(toTrip));
    } catch {
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = trips.filter(t =>
    filter === 'all' ? true : t.tags.includes(filter),
  );
  const incidentCount = trips.filter(t => t.tags.includes('incident')).length;
  const totalCredits = trips.reduce((n, t) => {
    const v = parseInt(t.credits.replace(/[^0-9]/g, ''), 10);
    return n + (Number.isFinite(v) ? v : 0);
  }, 0);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Activity History</Text>
        </View>
      </View>

      <ScrollView
        style={{flex: 1}}
        contentContainerStyle={[styles.scroll, {paddingBottom: insets.bottom + 100}]}
        showsVerticalScrollIndicator={false}>

        {/* Stats */}
        <View style={styles.statsRow}>
          <View style={[styles.statCard, {borderColor: '#1E2D45'}]}>
            <Text style={[styles.statVal, {color: '#a5b4fc'}]}>{trips.length}</Text>
            <Text style={styles.statLbl}>Missions</Text>
          </View>
          <View style={[styles.statCard, {borderColor: 'rgba(239,68,68,0.25)'}]}>
            <Text style={[styles.statVal, {color: '#f87171'}]}>{incidentCount}</Text>
            <Text style={styles.statLbl}>Incident</Text>
          </View>
          <View style={[styles.statCard, {borderColor: 'rgba(99,102,241,0.2)'}]}>
            <Text style={[styles.statVal, {color: '#a5b4fc', fontSize: 11}]}>
              {totalCredits >= 1000 ? `${Math.round(totalCredits / 1000)}K` : totalCredits}
            </Text>
            <Text style={styles.statLbl}>Credits</Text>
          </View>
        </View>

        {/* Filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.filterScroll} contentContainerStyle={styles.filterContent}>
          {FILTERS.map(f => (
            <TouchableOpacity
              key={f.key}
              style={[styles.chip, filter === f.key && styles.chipActive]}
              onPress={() => setFilter(f.key)}
              activeOpacity={0.8}>
              <Text style={[styles.chipText, filter === f.key && styles.chipTextActive]}>{f.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Trip cards */}
        {loading ? (
          <View style={styles.loadingBox}>
            <LoadingView compact label="Loading activity…" />
          </View>
        ) : visible.length === 0 ? (
          <View style={styles.loadingBox}>
            <Icon name="history" size={34} color="#334155" />
            <Text style={styles.emptyTitle}>No missions yet</Text>
            <Text style={styles.emptySub}>Your completed missions will appear here.</Text>
          </View>
        ) : (
          <View style={styles.tripList}>
            {visible.map(t => {
              const incident = t.tags.includes('incident');
              return (
                <View key={t.id} style={[styles.tripCard, incident && styles.tripCardIncident]}>
                  <View style={styles.tripInner}>
                    <View style={styles.tripTopRow}>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={styles.tripTitle} numberOfLines={2}>{t.title}</Text>
                        {!!t.sub && <Text style={styles.tripSub}>{t.sub}</Text>}
                      </View>
                      <Text style={styles.tripCredits}>{t.credits}</Text>
                    </View>

                    <View style={styles.tripBottomRow}>
                      <View style={[styles.completedBadge, incident && {backgroundColor: 'rgba(239,68,68,0.12)'}]}>
                        <Text style={[styles.completedBadgeText, incident && {color: '#fca5a5'}]}>
                          ● {t.status || 'COMPLETED'}
                        </Text>
                      </View>
                    </View>

                    <View style={styles.miniBar}>
                      <View style={[styles.miniBarFill, incident ? styles.miniBarRed : styles.miniBarPro]} />
                    </View>
                  </View>
                </View>
              );
            })}
          </View>
        )}

      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, {paddingBottom: bottomPad(12)}]}>
        <TouchableOpacity
          style={styles.dashBtn}
          onPress={() => navigation.navigate('BookingHome' as never)}
          activeOpacity={0.85}>
          <Icon name="home" size={18} color="#FFF" />
          <Text style={styles.dashBtnText}>BACK TO DASHBOARD</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  loadingBox: {alignItems: 'center', justifyContent: 'center', gap: 8, paddingVertical: 48, paddingHorizontal: 32},
  emptyTitle: {fontSize: 15, fontWeight: '700', color: '#F1F5F9', marginTop: 4},
  emptySub: {fontSize: 12.5, color: '#64748B', textAlign: 'center'},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 8},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', color: PRO, letterSpacing: 2, textTransform: 'uppercase'},
  stepBadge: {backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99},
  stepText: {fontSize: 10, fontWeight: '700', color: PRO},

  dotRow: {flexDirection: 'row', gap: 5, paddingHorizontal: 20, paddingBottom: 12, alignItems: 'center'},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotDone: {backgroundColor: PRO},
  dotActive: {width: 18, height: 6, borderRadius: 3, backgroundColor: PRO},

  scroll: {paddingHorizontal: 16, gap: 14},

  statsRow: {flexDirection: 'row', gap: 8},
  statCard: {flex: 1, backgroundColor: '#0D1929', borderWidth: 1, borderRadius: 12, padding: 10, alignItems: 'center'},
  statVal: {fontSize: 15, fontWeight: '800'},
  statLbl: {fontSize: 8, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 2},

  filterScroll: {marginHorizontal: -4},
  filterContent: {paddingHorizontal: 4, gap: 8},
  chip: {paddingHorizontal: 12, paddingVertical: 5, borderRadius: 99, borderWidth: 1, borderColor: '#1E2D45'},
  chipActive: {backgroundColor: PRO, borderColor: PRO},
  chipText: {fontSize: 11, fontWeight: '600', color: '#64748B'},
  chipTextActive: {color: '#FFF'},

  tripList: {gap: 10},
  tripCard: {backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 16, overflow: 'hidden', borderLeftWidth: 3, borderLeftColor: '#1E2D45'},
  tripCardIncident: {borderLeftColor: '#ef4444'},
  tripCardHighRisk: {borderLeftColor: '#f59e0b'},
  tripInner: {padding: 14},
  tripTopRow: {flexDirection: 'row', gap: 8, marginBottom: 8},
  tripTitle: {fontSize: 12, fontWeight: '700', color: '#F1F5F9', lineHeight: 17},
  tripSub: {fontSize: 10, color: '#64748B', marginTop: 4},
  tripCredits: {fontSize: 13, fontWeight: '800', color: '#a5b4fc'},
  riskBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, marginTop: 3},
  riskBadgeText: {fontSize: 9, fontWeight: '700'},

  incidentRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 8},
  incidentTag: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.3)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 6},
  incidentTagText: {fontSize: 9, fontWeight: '700', color: '#fca5a5'},
  incidentNote: {fontSize: 10, color: '#64748B'},

  tripBottomRow: {flexDirection: 'row', alignItems: 'center', marginBottom: 8},
  starsRow: {flexDirection: 'row', gap: 2},
  completedBadge: {marginLeft: 'auto', backgroundColor: 'rgba(34,197,94,0.1)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.2)', paddingHorizontal: 6, paddingVertical: 3, borderRadius: 4},
  completedBadgeText: {fontSize: 9, fontWeight: '700', color: '#86efac'},

  miniBar: {height: 3, backgroundColor: '#1E2D45', borderRadius: 99, overflow: 'hidden'},
  miniBarFill: {height: '100%', width: '100%', borderRadius: 99},
  miniBarPro: {backgroundColor: PRO},
  miniBarRed: {backgroundColor: '#ef4444'},
  miniBarAmber: {backgroundColor: '#f59e0b'},

  piSection: {gap: 10, paddingTop: 4},
  piTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  piSectionTitle: {fontSize: 10, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 2},
  piCard: {backgroundColor: '#0D1929', borderWidth: 1, borderColor: 'rgba(99,102,241,0.2)', borderRadius: 16, padding: 16, gap: 12},
  piCardTitle: {fontSize: 11, fontWeight: '700', color: '#CBD5E1'},

  riskBarRow: {gap: 6},
  riskBarLabelRow: {flexDirection: 'row', justifyContent: 'space-between'},
  riskBarLabel: {fontSize: 11, color: '#94A3B8'},
  riskBarScore: {fontSize: 11, fontWeight: '700'},
  riskTrack: {height: 6, backgroundColor: '#1E2D45', borderRadius: 99, overflow: 'hidden'},
  riskFill: {height: '100%', borderRadius: 99},

  footer: {paddingHorizontal: 20, paddingTop: 12, backgroundColor: Colors.background},
  dashBtn: {backgroundColor: PRO, borderRadius: 12, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  dashBtnText: {fontSize: 13, fontWeight: '700', color: '#FFF', letterSpacing: 1.5},
}));
