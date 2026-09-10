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
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {agentApi} from '@services/api';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const QUICK_ACTIONS = [
  {icon: 'briefcase', label: 'Jobs', color: '#93c5fd', screen: 'JobMarketplace' as keyof AgentStackParamList},
  {icon: 'calendar-month', label: 'Schedule', color: '#60a5fa', screen: null},
  {icon: 'currency-usd', label: 'Earnings', color: '#D4AF37', screen: 'Earnings' as keyof AgentStackParamList},
  {icon: 'headset', label: 'Support', color: '#2dd4bf', screen: null},
];

interface ActivityRow {
  icon: string; iconColor: string; iconBg: string;
  title: string; sub: string; value: string; valueColor: string;
}

function initialsOf(name: string): string {
  return name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase() || 'AG';
}

export default function AgentHomeScreen() {
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('Agent');
  const [rating, setRating] = useState<string | null>(null);
  const [jobsTotal, setJobsTotal] = useState(0);
  const [activity, setActivity] = useState<ActivityRow[]>([]);

  const load = useCallback(async () => {
    try {
      const [me, history] = await Promise.all([
        agentApi.getMe().then(r => r.data).catch(() => null),
        agentApi.getMissionHistory().then(r => r.data).catch(() => []),
      ]);
      if (me?.agent) {
        setName(me.agent.display_name || me.agent.call_sign || 'Agent');
        setRating(me.agent.rating);
        setJobsTotal(me.agent.jobs_total ?? 0);
      }
      // Recent activity = completed missions with payouts, newest first.
      setActivity((history ?? []).slice(0, 5).map(m => ({
        icon: 'check-circle', iconColor: '#4ade80', iconBg: 'rgba(34,197,94,0.12)',
        title: m.dropoff_address ? `${m.pickup_address} → ${m.dropoff_address}` : m.pickup_address || m.short_code,
        sub: [m.role, m.region_label].filter(Boolean).join(' · '),
        value: typeof m.paid_credits === 'number' ? `+${m.paid_credits.toLocaleString()} BC` : '',
        valueColor: '#4ade80',
      })));
    } catch { /* keep defaults / empty */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const stats = [
    {label: 'Jobs Done', value: String(jobsTotal), color: '#c084fc'},
    {label: 'Rating', value: rating ? `${rating}★` : '—', color: '#F59E0B'},
  ];
  const avatarInitials = initialsOf(name);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <View style={styles.avatarWrap}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{avatarInitials}</Text>
            </View>
            <View style={styles.onlineDot} />
          </View>
          {/* B-657 - flex:1 + minWidth:0. A flex child defaults to
              min-width:auto, which floors it at CONTENT size, so without
              minWidth:0 the flex is inert and a long name pushes the LIVE
              pill and bell off the right edge. */}
          <View style={styles.headerNameCol}>
            <Text style={styles.greeting} numberOfLines={1}>Welcome back</Text>
            <Text style={styles.name} numberOfLines={1}>{name}</Text>
          </View>
        </View>
        <View style={styles.headerRight}>
          <View style={styles.liveBadge}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
          <View style={styles.notifBtnWrap}>
            <TouchableOpacity style={styles.notifBtn} activeOpacity={0.7}>
              <Icon name="bell" size={20} color="#94A3B8" />
            </TouchableOpacity>
            {/* N-22 — removed the hardcoded always-lit dot (no store behind it). */}
          </View>
        </View>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Stats row */}
        <View style={styles.statsRow}>
          {stats.map((s, i) => (
            <View key={i} style={styles.statCard}>
              <Text style={[styles.statValue, {color: s.color}]}>{s.value}</Text>
              <Text style={styles.statLabel}>{s.label}</Text>
            </View>
          ))}
        </View>

        {/* Find work CTA — real entry point to the job marketplace. */}
        <TouchableOpacity
          style={styles.findWorkCard}
          onPress={() => navigation.navigate('JobMarketplace')}
          activeOpacity={0.85}>
          <View style={styles.findWorkIcon}>
            <Icon name="briefcase-search" size={22} color="#93c5fd" />
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.findWorkTitle}>Find available jobs</Text>
            <Text style={styles.findWorkSub}>Browse the job marketplace and apply</Text>
          </View>
          <Icon name="chevron-right" size={20} color="#334155" />
        </TouchableOpacity>

        {/* Quick actions */}
        <View>
          <Text style={[styles.sectionLabel, {marginBottom: 10}]}>QUICK ACTIONS</Text>
          <View style={styles.actionsGrid}>
            {QUICK_ACTIONS.map((a, i) => (
              <TouchableOpacity
                key={i}
                style={styles.actionBtn}
                onPress={() => a.screen && navigation.navigate(a.screen as keyof AgentStackParamList as never)}
                activeOpacity={0.8}>
                <Icon name={a.icon} size={22} color={a.color} />
                <Text style={styles.actionLabel}>{a.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Recent activity — real completed missions */}
        <View>
          <Text style={[styles.sectionLabel, {marginBottom: 10}]}>RECENT ACTIVITY</Text>
          <View style={styles.activityCard}>
            {activity.length === 0 ? (
              <Text style={styles.activityEmpty}>No completed missions yet.</Text>
            ) : activity.map((item, i) => (
              <View key={i} style={[styles.activityRow, i < activity.length - 1 && styles.activityRowBorder]}>
                <View style={[styles.activityIcon, {backgroundColor: item.iconBg}]}>
                  <Icon name={item.icon} size={16} color={item.iconColor} />
                </View>
                <View style={styles.activityInfo}>
                  <Text style={styles.activityTitle} numberOfLines={1}>{item.title}</Text>
                  {!!item.sub && <Text style={styles.activitySub}>{item.sub}</Text>}
                </View>
                {!!item.value && <Text style={[styles.activityValue, {color: item.valueColor}]}>{item.value}</Text>}
              </View>
            ))}
          </View>
        </View>

        {/* Earnings shortcut — full report lives in the Earnings screen. */}
        <TouchableOpacity
          style={styles.findWorkCard}
          onPress={() => navigation.navigate('Earnings')}
          activeOpacity={0.85}>
          <View style={[styles.findWorkIcon, {backgroundColor: 'rgba(212,175,55,0.12)'}]}>
            <Icon name="currency-usd" size={22} color="#D4AF37" />
          </View>
          <View style={{flex: 1}}>
            <Text style={styles.findWorkTitle}>Earnings & payouts</Text>
            <Text style={styles.findWorkSub}>View your full earnings report</Text>
          </View>
          <Icon name="chevron-right" size={20} color="#334155" />
        </TouchableOpacity>

      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 20, paddingBottom: 16},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, minWidth: 0},
  headerNameCol: {flex: 1, minWidth: 0},
  avatarWrap: {position: 'relative'},
  avatar: {width: 48, height: 48, borderRadius: 24, backgroundColor: Colors.primary, alignItems: 'center', justifyContent: 'center'},
  avatarText: {fontSize: 16, fontWeight: '700', color: '#FFF'},
  onlineDot: {position: 'absolute', bottom: 0, right: 0, width: 12, height: 12, borderRadius: 6, backgroundColor: '#4ade80', borderWidth: 2, borderColor: Colors.background},
  greeting: {fontSize: 11, color: '#64748B', fontWeight: '600'},
  name: {fontSize: 16, fontWeight: '800', color: '#E2E8F0'},
  // B-657 - never yield: the LIVE state and the bell are the actionable half.
  headerRight: {flexDirection: 'row', alignItems: 'center', gap: 8, flexShrink: 0},
  liveBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: 'rgba(34,197,94,0.12)', borderWidth: 1, borderColor: 'rgba(34,197,94,0.3)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 99},
  liveDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ade80'},
  liveText: {fontSize: 11, fontWeight: '700', color: '#4ade80'},
  notifBtnWrap: {position: 'relative'},
  notifBtn: {width: 36, height: 36, borderRadius: 18, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', alignItems: 'center', justifyContent: 'center'},
  notifDot: {position: 'absolute', top: 6, right: 6, width: 8, height: 8, borderRadius: 4, backgroundColor: '#EF4444', borderWidth: 1.5, borderColor: Colors.background},

  content: {paddingHorizontal: 20, paddingTop: 4, gap: 20},

  statsRow: {flexDirection: 'row', gap: 10},
  findWorkCard: {flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45', borderRadius: 14, padding: 14},
  findWorkIcon: {width: 42, height: 42, borderRadius: 12, backgroundColor: 'rgba(59,130,246,0.12)', alignItems: 'center', justifyContent: 'center'},
  findWorkTitle: {fontSize: 14, fontWeight: '700', color: '#F1F5F9'},
  findWorkSub: {fontSize: 11.5, color: '#64748B', marginTop: 2},
  activityEmpty: {fontSize: 12.5, color: '#64748B', textAlign: 'center', paddingVertical: 16},
  statCard: {flex: 1, padding: 10, borderRadius: 12, alignItems: 'center', backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45'},
  statValue: {fontSize: 15, fontWeight: '800'},
  statLabel: {fontSize: 9, textTransform: 'uppercase', color: '#64748B', fontWeight: '700', letterSpacing: 1, marginTop: 2, textAlign: 'center'},

  missionCard: {backgroundColor: '#0D1929', borderRadius: 16, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(37,99,235,0.35)'},
  missionTopBar: {height: 2, width: '100%', backgroundColor: Colors.primary},
  missionInner: {padding: 14},
  missionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  activeMissionRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  redDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#f87171'},
  activeMissionText: {fontSize: 10, fontWeight: '700', color: '#f87171', textTransform: 'uppercase', letterSpacing: 1},
  missionId: {fontSize: 10, color: '#64748B', fontWeight: '600'},
  missionTitle: {fontSize: 14, fontWeight: '700', color: '#E2E8F0', marginBottom: 4},
  missionLoc: {flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 12},
  missionLocText: {fontSize: 12, color: '#64748B'},
  progressWrap: {marginBottom: 12},
  progressLabel: {flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4},
  progressLabelText: {fontSize: 10, color: '#64748B'},
  progressPct: {fontSize: 10, fontWeight: '700', color: '#60A5FA'},
  progressTrack: {height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  progressFill: {width: '68%', height: '100%', borderRadius: 3, backgroundColor: Colors.primary},
  missionFooter: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  missionMeta: {flexDirection: 'row', alignItems: 'center', gap: 12},
  metaItem: {flexDirection: 'row', alignItems: 'center', gap: 4},
  metaText: {fontSize: 12, color: '#94A3B8'},
  viewDetailBtn: {backgroundColor: 'rgba(37,99,235,0.2)', borderWidth: 1, borderColor: 'rgba(37,99,235,0.4)', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8},
  viewDetailText: {fontSize: 12, fontWeight: '700', color: '#93c5fd'},

  sectionHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  sectionLabel: {fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 2},
  viewAll: {fontSize: 11, fontWeight: '700', color: '#60A5FA'},
  jobList: {gap: 10},
  jobRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45'},
  jobIcon: {width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', borderWidth: 1, flexShrink: 0},
  jobInfo: {flex: 1},
  jobTitle: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  jobSub: {fontSize: 12, color: '#64748B', marginTop: 2},
  jobPay: {fontSize: 13, fontWeight: '700', color: '#D4AF37', flexShrink: 0},

  actionsGrid: {flexDirection: 'row', gap: 8},
  actionBtn: {flex: 1, flexDirection: 'column', alignItems: 'center', gap: 4, padding: 10, borderRadius: 12, backgroundColor: '#0D1929', borderWidth: 1, borderColor: '#1E2D45'},
  actionLabel: {fontSize: 10, color: '#94A3B8', fontWeight: '600'},

  activityCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  activityRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 12},
  activityRowBorder: {borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  activityIcon: {width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  activityInfo: {flex: 1},
  activityTitle: {fontSize: 12, fontWeight: '700', color: '#E2E8F0'},
  activitySub: {fontSize: 10, color: '#64748B', marginTop: 1},
  activityValue: {fontSize: 12, fontWeight: '700', flexShrink: 0},

  weekCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 16},
  weekHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12},
  weekTitle: {fontSize: 12, fontWeight: '700', color: '#CBD5E1'},
  barsWrap: {flexDirection: 'row', alignItems: 'flex-end', gap: 6, height: 56, marginBottom: 8},
  bar: {flex: 1, borderRadius: 2},
  weekDays: {flexDirection: 'row', justifyContent: 'space-between'},
  weekDay: {fontSize: 9, color: '#475569', fontWeight: '700', textTransform: 'uppercase', flex: 1, textAlign: 'center'},
}));
