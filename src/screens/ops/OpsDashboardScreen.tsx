import React, {useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {useAuthStore} from '@store/authStore';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

const OPS = '#0EA5E9';

type Filter = 'All Missions' | 'Active' | 'Staged' | 'Scheduled' | 'Completed';

const FILTERS: Filter[] = ['All Missions', 'Active', 'Staged', 'Scheduled', 'Completed'];

interface PendingItem {
  id: string; title: string; sub: string; credits: string; date: string;
  tags: string[]; tagColors: string[];
}
interface MissionItem {
  id: string; title: string; sub: string; status: string;
  statusColor: string; statusBg: string; statusBorder: string; barColor: string;
  progress: number | null; icon: string; iconBg: string; iconColor: string;
  meta: string; filter: string;
}

// NOTE: the mobile ops surface has no list endpoint (the Next.js ops-console
// owns mission/approval management). These start empty + show honest empty
// states; full ops command lives in the web console.
const PENDING: PendingItem[] = [];
const MISSIONS: MissionItem[] = [];

export default function OpsDashboardScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const user = useAuthStore(s => s.user);
  const [filter, setFilter] = useState<Filter>('All Missions');
  const [approvedIds, setApprovedIds] = useState<Set<string>>(new Set());
  const [rejectedIds, setRejectedIds] = useState<Set<string>>(new Set());

  const operatorName = user?.full_name || 'Operator';
  const operatorInitials = operatorName.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'OP';

  const visibleMissions = MISSIONS.filter(m => {
    if (filter === 'All Missions') {return true;}
    return m.filter === filter.toLowerCase();
  });
  const activeCount = MISSIONS.filter(m => m.filter === 'active').length;
  const pendingCount = PENDING.filter(p => !approvedIds.has(p.id) && !rejectedIds.has(p.id)).length;

  const approveMission = (id: string) => setApprovedIds(prev => new Set([...prev, id]));
  const rejectMission = (id: string) => setRejectedIds(prev => new Set([...prev, id]));

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.agentRow}>
          <View style={styles.agentAvatar}>
            <Text style={styles.agentInitials}>{operatorInitials}</Text>
            <View style={styles.agentOnline} />
          </View>
          {/* B-657 - flex:1 + minWidth:0, or a long operator name pushes the
              two header buttons off the right edge (min-width:auto floors a
              flex child at its content size). */}
          <View style={styles.agentNameCol}>
            <View style={styles.agentMeta}>
              <Text style={styles.agentRole} numberOfLines={1}>OPS COMMAND</Text>
            </View>
            <Text style={styles.agentName} numberOfLines={1}>{operatorName}</Text>
          </View>
        </View>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerBtn} activeOpacity={0.7}>
            <Icon name="bell" size={20} color="#94A3B8" />
            {/* N-22 — removed the hardcoded always-lit dot: it asserted unread
                notifications that never existed (no store behind it). */}
          </TouchableOpacity>
          <TouchableOpacity style={styles.headerBtn} activeOpacity={0.7}>
            <Icon name="tune" size={20} color="#94A3B8" />
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 24}]}>

        {/* Stats row */}
        <View style={styles.statsRow}>
          {[
            {v: String(activeCount), l: 'Active', c: '#4ADE80', border: '#1E2D45'},
            {v: String(pendingCount), l: 'Pending', c: '#FBBF24', border: 'rgba(245,158,11,0.35)'},
            {v: String(MISSIONS.length), l: 'Missions', c: '#38BDF8', border: '#1E2D45'},
            {v: '0', l: 'Alert', c: '#F87171', border: 'rgba(239,68,68,0.3)'},
          ].map((s, i) => (
            <View key={i} style={[styles.statCard, {borderColor: s.border}]}>
              <Text style={[styles.statValue, {color: s.c}]}>{s.v}</Text>
              <Text style={styles.statLabel}>{s.l}</Text>
            </View>
          ))}
        </View>

        {/* Pending Approvals — only when there are real pending items */}
        {pendingCount > 0 && (
        <View>
          <View style={styles.pendingHeader}>
            <View style={styles.pendingDot} />
            <Text style={styles.pendingLabel}>Pending Approval</Text>
            <Text style={styles.pendingCount}>{pendingCount} request{pendingCount > 1 ? 's' : ''}</Text>
          </View>
          {PENDING.filter(p => !approvedIds.has(p.id) && !rejectedIds.has(p.id)).map(pending => (
            <View key={pending.id} style={styles.pendingCard}>
              <View style={styles.pendingTopAccent} />
              <View style={styles.pendingBody}>
                <View style={styles.pendingTop}>
                  <View style={styles.pendingInfo}>
                    <View style={styles.pendingTopRow}>
                      <View style={styles.pendingBadge}><Text style={styles.pendingBadgeText}>Pending</Text></View>
                      <Text style={styles.pendingId}>{pending.id}</Text>
                    </View>
                    <Text style={styles.pendingTitle}>{pending.title}</Text>
                    <Text style={styles.pendingSub}>{pending.sub}</Text>
                  </View>
                  <View style={styles.pendingRight}>
                    <Text style={styles.pendingCredits}>{pending.credits}</Text>
                    <Text style={styles.pendingDate}>{pending.date}</Text>
                  </View>
                </View>
                <View style={styles.pendingTags}>
                  {pending.tags.map((tag, ti) => (
                    <Text key={ti} style={[styles.pendingTag, {color: pending.tagColors[ti]}]}>{tag}</Text>
                  ))}
                </View>
                <View style={styles.pendingActions}>
                  <TouchableOpacity onPress={() => rejectMission(pending.id)} activeOpacity={0.7}>
                    <Text style={styles.rejectText}>✕ Reject</Text>
                  </TouchableOpacity>
                  <View style={styles.pendingActionsRight}>
                    <TouchableOpacity onPress={() => navigation.navigate('OpsMissionDetail', {missionId: pending.id})} activeOpacity={0.7}>
                      <Text style={styles.detailLink}>Full Detail →</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.approveBtn} onPress={() => approveMission(pending.id)} activeOpacity={0.85}>
                      <Icon name="check" size={14} color="#FFF" />
                      <Text style={styles.approveBtnText}>Approve</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            </View>
          ))}
        </View>
        )}

        {/* Filter chips */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={styles.filterRow}>
            {FILTERS.map(f => (
              <TouchableOpacity
                key={f}
                style={[styles.filterChip, filter === f && styles.filterChipActive]}
                onPress={() => setFilter(f)}
                activeOpacity={0.7}>
                <Text style={[styles.filterText, filter === f && styles.filterTextActive]}>{f}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </ScrollView>

        {/* Missions list */}
        <Text style={styles.sectionLabel}>Missions</Text>
        {visibleMissions.length === 0 && (
          <View style={{paddingVertical: 32, alignItems: 'center', gap: 6, paddingHorizontal: 24}}>
            <Icon name="crosshairs-gps" size={30} color="#334155" />
            <Text style={{fontSize: 14, fontWeight: '700', color: '#F1F5F9'}}>No active missions</Text>
            <Text style={{fontSize: 12, color: '#64748B', textAlign: 'center'}}>Mission command is managed from the Bravo Ops console.</Text>
          </View>
        )}
        {visibleMissions.map(m => (
          <View key={m.id} style={styles.missionCard}>
            <View style={[styles.missionAccent, {backgroundColor: m.barColor}]} />
            <View style={styles.missionBody}>
              <View style={[styles.missionIcon, {backgroundColor: m.iconBg}]}>
                <Icon name={m.icon} size={20} color={m.iconColor} />
              </View>
              <View style={styles.missionInfo}>
                <View style={styles.missionTitleRow}>
                  <Text style={styles.missionTitle}>{m.title}</Text>
                  <View style={[styles.missionBadge, {backgroundColor: m.statusBg, borderColor: m.statusBorder}]}>
                    <Text style={[styles.missionBadgeText, {color: m.statusColor}]}>{m.status}</Text>
                  </View>
                </View>
                <Text style={styles.missionSub}>{m.id} · {m.sub}</Text>
                {m.progress !== null && m.progress !== undefined && m.progress < 1 && (
                  <View style={styles.progressBar}>
                    <View style={[styles.progressFill, {width: `${m.progress * 100}%`, backgroundColor: m.barColor}]} />
                  </View>
                )}
                <View style={styles.missionBottom}>
                  <Text style={styles.missionMeta}>{m.meta}</Text>
                  <TouchableOpacity onPress={() => navigation.navigate('OpsMissionDetail', {missionId: m.id})} activeOpacity={0.7}>
                    <Text style={styles.manageLink}>Manage →</Text>
                  </TouchableOpacity>
                </View>
              </View>
            </View>
          </View>
        ))}

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 16},
  agentRow: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0},
  agentNameCol: {flex: 1, minWidth: 0},
  agentAvatar: {width: 44, height: 44, borderRadius: 12, backgroundColor: OPS, alignItems: 'center', justifyContent: 'center', position: 'relative'},
  agentInitials: {fontSize: 14, fontWeight: '700', color: '#FFF'},
  agentOnline: {position: 'absolute', bottom: 0, right: 0, width: 10, height: 10, borderRadius: 5, backgroundColor: '#4ADE80', borderWidth: 2, borderColor: Colors.background},
  agentMeta: {flexDirection: 'row', alignItems: 'center', gap: 6},
  agentRole: {fontSize: 9, fontWeight: '700', color: OPS, letterSpacing: 1.5, textTransform: 'uppercase'},
  agentLocation: {fontSize: 9, fontWeight: '600', color: '#64748B', textTransform: 'uppercase'},
  agentName: {fontSize: 16, fontWeight: '800', color: '#F1F5F9'},
  // B-657 - the actionable half never yields.
  headerActions: {flexDirection: 'row', gap: 8, flexShrink: 0},
  headerBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', alignItems: 'center', justifyContent: 'center', position: 'relative'},
  notifDot: {position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444', borderWidth: 1, borderColor: Colors.background},

  content: {paddingHorizontal: 20, gap: 20},

  statsRow: {flexDirection: 'row', gap: 8},
  statCard: {flex: 1, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, padding: 10, alignItems: 'center'},
  statValue: {fontSize: 18, fontWeight: '800'},
  statLabel: {fontSize: 8, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 2, lineHeight: 12},

  pendingHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12},
  pendingDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#F59E0B'},
  pendingLabel: {fontSize: 11, fontWeight: '700', color: '#F59E0B', textTransform: 'uppercase', letterSpacing: 1.5, flex: 1},
  pendingCount: {fontSize: 10, fontWeight: '600', color: '#64748B'},

  pendingCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)', overflow: 'hidden', marginBottom: 12},
  pendingTopAccent: {height: 3, backgroundColor: '#F59E0B'},
  pendingBody: {padding: 14},
  pendingTop: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 8},
  pendingInfo: {flex: 1},
  pendingTopRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4},
  pendingBadge: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: 'rgba(245,158,11,0.3)'},
  pendingBadgeText: {fontSize: 9, fontWeight: '700', color: '#FBBF24'},
  pendingId: {fontSize: 10, color: '#64748B'},
  pendingTitle: {fontSize: 14, fontWeight: '700', color: '#F1F5F9'},
  pendingSub: {fontSize: 12, color: '#64748B', marginTop: 2},
  pendingRight: {alignItems: 'flex-end'},
  pendingCredits: {fontSize: 16, fontWeight: '800', color: '#D4AF37'},
  pendingDate: {fontSize: 9, color: '#475569', marginTop: 2},
  pendingTags: {flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 10},
  pendingTag: {fontSize: 10},
  pendingActions: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderTopWidth: 1, borderTopColor: '#1A2840', paddingTop: 10},
  pendingActionsRight: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rejectText: {fontSize: 12, fontWeight: '600', color: '#64748B'},
  detailLink: {fontSize: 12, fontWeight: '600', color: OPS},
  approveBtn: {flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8, backgroundColor: '#16A34A'},
  approveBtnText: {fontSize: 12, fontWeight: '700', color: '#FFF'},

  filterRow: {flexDirection: 'row', gap: 8, paddingRight: 4},
  filterChip: {paddingHorizontal: 14, paddingVertical: 6, borderRadius: 99, borderWidth: 1.5, borderColor: '#1E2D45'},
  filterChipActive: {backgroundColor: 'rgba(14,165,233,0.15)', borderColor: OPS},
  filterText: {fontSize: 12, fontWeight: '700', color: '#64748B'},
  filterTextActive: {color: '#38BDF8'},

  sectionLabel: {fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginBottom: -12},

  missionCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  missionAccent: {height: 3},
  missionBody: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, padding: 14},
  missionIcon: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  missionInfo: {flex: 1},
  missionTitleRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4},
  missionTitle: {fontSize: 14, fontWeight: '700', color: '#F1F5F9', flex: 1},
  missionBadge: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, borderWidth: 1, marginLeft: 8},
  missionBadgeText: {fontSize: 9, fontWeight: '700'},
  missionSub: {fontSize: 12, color: '#64748B', marginBottom: 6},
  progressBar: {height: 4, borderRadius: 99, backgroundColor: '#1E2D45', marginBottom: 6, overflow: 'hidden'},
  progressFill: {height: '100%', borderRadius: 99},
  missionBottom: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  missionMeta: {fontSize: 10, color: '#64748B'},
  manageLink: {fontSize: 10, fontWeight: '700', color: OPS},
}));
