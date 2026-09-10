import React, {useCallback, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Platform,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useFocusEffect, useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BookingStackParamList} from '@navigation/types';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';
import {useProPlanGate} from '@hooks/useProPlanGate';
import {secureProApi, type ProTeamMember, type ProAssignedVehicle, type ProAssignedResource, type ProPlanMission} from '@services/api';
import {missionTeamSections} from './missionTeam';
import {useSecureProStore} from '@store/secureProStore';
import {useProAppRealtime} from '@screens/securepro/useProAppRealtime';
import {fmtDayMonthUtc} from '@utils/datetime';

type Nav = NativeStackNavigationProp<BookingStackParamList>;

type TabKey = 'CPOs' | 'Vehicles' | 'Resources';

// Vehicles + Resources are assigned by Ops at mission dispatch. There is NO
// Pro-side assignment model yet: pro_cpo_assignments / protection_sessions carry
// no vehicle/registration/resource link, and vehicle_pool is bound to the Lite
// booking product (lite_bookings.vehicle_id) only. So these tabs show an honest,
// Issue-30-accurate empty state until that model exists — never a hardcoded
// vehicle. The CPOs tab IS live (secureProApi.team → pro_cpo_assignments),
// pushed over WS with a poll fallback.

function initialsOf(name: string | null): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) {return 'PO';}
  return parts.slice(0, 2).map(p => p[0]!.toUpperCase()).join('');
}

const RESOURCE_KINDS = ['comms', 'medical', 'tactical', 'other'] as const;
const KIND_LABEL: Record<(typeof RESOURCE_KINDS)[number], string> = {
  comms: 'Comms',
  medical: 'Medical',
  tactical: 'Tactical',
  other: 'Other',
};

export default function ProAssignedTeamScreen() {
  useProPlanGate(); // Audit Rev2 SP-01 — activation gate (see the hook)
  const navigation = useNavigation<Nav>();
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const [activeTab, setActiveTab] = useState<TabKey>('CPOs');
  const [team, setTeam] = useState<ProTeamMember[] | null>(null);
  const [vehicles, setVehicles] = useState<ProAssignedVehicle[] | null>(null);
  const [resources, setResources] = useState<ProAssignedResource[] | null>(null);
  const [missions, setMissions] = useState<ProPlanMission[] | null>(null);

  const application = useSecureProStore(st => st.application);
  const appId = application?.status === 'ACTIVE' ? application.id : undefined;

  const loadTeam = useCallback(async () => {
    if (!appId) {setTeam([]); setVehicles([]); setResources([]); setMissions([]); return;}
    try {
      // B-681: the scheduled booking-request teams live on the MISSION rows
      // (assigned_team labels), not in pro_cpo_assignments — fetch both.
      // allSettled, NOT all: a missions failure (transient 500, or an older
      // deployed server) must never blank the dedicated-team list (critic P1-1).
      const [r, mi] = await Promise.allSettled([secureProApi.team(appId), secureProApi.missions(appId)]);
      if (mi.status === 'fulfilled') {setMissions(mi.value.data.missions ?? []);} else {setMissions(prev => prev ?? []);}
      if (r.status !== 'fulfilled') {throw r.reason;}
      setTeam(r.value.data.team);
      // Why: an older server (deploy window before auth-service ships the Issue-30
      // fields) returns only {team}; default to [] so the tab shows its empty
      // state instead of crashing on `undefined.length`.
      setVehicles(r.value.data.vehicles ?? []);
      setResources(r.value.data.resources ?? []);
    } catch {
      setTeam(prev => prev ?? []);
      setVehicles(prev => prev ?? []);
      setResources(prev => prev ?? []);
      setMissions(prev => prev ?? []);
    }
  }, [appId]);

  useFocusEffect(useCallback(() => {
    void loadTeam();
    const t = setInterval(() => { void loadTeam(); }, 10_000);
    return () => clearInterval(t);
  }, [loadTeam]));
  useProAppRealtime(appId, () => { void loadTeam(); });

  const tabs: TabKey[] = ['CPOs', 'Vehicles', 'Resources'];
  const todayIso = new Date().toISOString().slice(0, 10);
  const missionSections = missionTeamSections(missions ?? [], todayIso);

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <TouchableOpacity style={styles.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
            <Icon name="arrow-left" size={20} color="#94A3B8" />
          </TouchableOpacity>
          <Text style={styles.headerTitle}>Assigned Team</Text>
        </View>
      </View>


      {/* Tabs */}
      <View style={styles.tabBar}>
        {tabs.map(tab => (
          <TouchableOpacity
            key={tab}
            style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
            onPress={() => setActiveTab(tab)}
            activeOpacity={0.8}>
            <Text style={[styles.tabBtnText, activeTab === tab && styles.tabBtnTextActive]} numberOfLines={1}>{tab}</Text>
          </TouchableOpacity>
        ))}
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {activeTab === 'CPOs' && team === null && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Checking your protection team…</Text>
          </View>
        )}
        {activeTab === 'CPOs' && team !== null && team.length === 0 && missionSections.length === 0 && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Your protection team is assigned by Ops once a mission is confirmed.</Text>
          </View>
        )}
        {activeTab === 'Vehicles' && vehicles === null && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Checking your assigned vehicle…</Text>
          </View>
        )}
        {activeTab === 'Vehicles' && vehicles !== null && vehicles.length === 0 && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Your assigned vehicle — make, model, colour and registration plate — will appear here once it's allocated to your protection detail.</Text>
          </View>
        )}

        {activeTab === 'Vehicles' && (vehicles ?? []).map(v => (
          <View key={v.id} style={[styles.vehCard, v.live_today && styles.vehCardLive]}>
            <View style={styles.vehTopRow}>
              <View style={styles.vehCallSignWrap}>
                <Icon name="car" size={16} color="#5B8DEF" />
                <Text style={styles.vehCallSignText}>{v.call_sign ?? 'Protection Vehicle'}</Text>
              </View>
              <View style={styles.availRow}>
                <View style={[styles.availDot, !v.live_today && styles.availDotIdle]} />
                <Text style={[styles.availText, !v.live_today && styles.availTextIdle]}>
                  {v.live_today ? 'ON DUTY' : 'SCHEDULED'}
                </Text>
              </View>
            </View>

            <View style={styles.plateHero}>
              <Text style={styles.plateLabel}>REGISTRATION</Text>
              <Text style={styles.plateValue}>{v.plate}</Text>
            </View>

            <Text style={styles.vehMakeModel}>
              {[v.make_model, v.colour].filter(Boolean).join(' · ')}
            </Text>

            <View style={styles.vehBadges}>
              {v.armored && (
                <View style={styles.vehBadge}>
                  <Text style={styles.vehBadgeText}>{v.armor_grade ? `ARMORED · ${v.armor_grade}` : 'ARMORED'}</Text>
                </View>
              )}
              <View style={styles.vehBadge}>
                <Text style={styles.vehBadgeText}>{v.capacity} SEATS</Text>
              </View>
              <View style={styles.vehBadge}>
                <Text style={styles.vehBadgeText}>{fmtDayMonthUtc(v.starts_on)} – {fmtDayMonthUtc(v.ends_on)}</Text>
              </View>
            </View>
          </View>
        ))}

        {activeTab === 'CPOs' && (team ?? []).map(member => (
          <View key={member.id} style={[styles.cpoCard, member.live_today && styles.cpoCardAssigned]}>
            <View style={styles.cpoHeader}>
              <View style={[styles.cpoAvatar, {backgroundColor: '#6366F1'}]}>
                <Text style={styles.cpoAvatarText}>{initialsOf(member.cpo_name)}</Text>
              </View>
              <View style={styles.cpoInfo}>
                <View style={styles.certRow}>
                  <View style={[styles.certBadge, {backgroundColor: 'rgba(99,102,241,0.08)', borderColor: 'rgba(99,102,241,0.3)'}]}>
                    <Text style={[styles.certText, {color: '#A5B4FC'}]}>DEDICATED CPO</Text>
                  </View>
                </View>
                <Text style={styles.cpoName}>{member.cpo_name ?? 'Protection Officer'}</Text>
                <Text style={styles.cpoRole}>
                  {[member.call_sign, member.org_name].filter(Boolean).join(' · ') || 'Close Protection Officer'}
                </Text>
              </View>
              <View style={styles.availRow}>
                <View style={[styles.availDot, !member.live_today && styles.availDotIdle]} />
                <Text style={[styles.availText, !member.live_today && styles.availTextIdle]}>
                  {member.live_today ? 'ON DUTY' : 'SCHEDULED'}
                </Text>
              </View>
            </View>
            <View style={styles.cpoStats}>
              <View style={styles.cpoStatItem}>
                <Text style={styles.cpoStatValue}>{fmtDayMonthUtc(member.starts_on)}</Text>
                <Text style={styles.cpoStatLabel}>FROM</Text>
              </View>
              <View style={styles.cpoStatItem}>
                <Text style={styles.cpoStatValue}>{fmtDayMonthUtc(member.ends_on)}</Text>
                <Text style={styles.cpoStatLabel}>UNTIL</Text>
              </View>
            </View>
          </View>
        ))}

        {/* B-681 — teams assigned on SCHEDULED booking-request dates (the
            founder screenshot: these appear on Booking Requests but were
            absent here, so scheduled dates read as "no designated team"). */}
        {activeTab === 'CPOs' && missionSections.length > 0 && (
          <View style={styles.resGroup}>
            <Text style={styles.resGroupHeader}>Mission teams — scheduled dates</Text>
            {missionSections.map(sec => (
              <View key={sec.id} style={[styles.cpoCard, sec.liveToday && styles.cpoCardAssigned]}>
                <View style={styles.missionHead}>
                  <View style={styles.missionDatesWrap}>
                    <Icon name="calendar-check" size={15} color="#5B8DEF" />
                    <Text style={styles.missionDates} numberOfLines={2}>{sec.datesLabel}</Text>
                  </View>
                  <View style={styles.availRow}>
                    <View style={[styles.availDot, !sec.liveToday && styles.availDotIdle]} />
                    <Text style={[styles.availText, !sec.liveToday && styles.availTextIdle]}>
                      {sec.liveToday ? 'ON DUTY' : 'SCHEDULED'}
                    </Text>
                  </View>
                </View>
                {sec.rows.map((row, i) => (
                  <View key={`${sec.id}-${i}`} style={styles.missionRow}>
                    <Icon name="account-group" size={14} color="#94A3B8" />
                    <Text style={styles.missionRole}>
                      {row.count}× {row.role}
                      {row.names.length > 0 ? <Text style={styles.missionNames}> — {row.names.join(', ')}</Text> : null}
                    </Text>
                  </View>
                ))}
              </View>
            ))}
          </View>
        )}

        {activeTab === 'Resources' && resources === null && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Checking your assigned resources…</Text>
          </View>
        )}
        {activeTab === 'Resources' && resources !== null && resources.length === 0 && (
          <View style={styles.resourcesCard}>
            <Text style={styles.resourcesText}>Assigned resources — comms equipment, medical kit and tactical gear — will appear here once they're allocated to your protection detail.</Text>
          </View>
        )}

        {activeTab === 'Resources' && (resources ?? []).length > 0 && RESOURCE_KINDS.map(kind => {
          const rows = (resources ?? []).filter(r => r.kind === kind);
          if (rows.length === 0) {return null;}
          return (
            <View key={kind} style={styles.resGroup}>
              <Text style={styles.resGroupHeader}>{KIND_LABEL[kind]}</Text>
              {rows.map(r => (
                <View key={r.id} style={[styles.resRow, r.live_today && styles.resRowLive]}>
                  <View style={styles.resKindDot} />
                  <Text style={styles.resLabel}>{r.label}</Text>
                  {r.qty > 1 && <Text style={styles.resQty}>×{r.qty}</Text>}
                </View>
              ))}
            </View>
          );
        })}

      </ScrollView>

      {/* Footer CTA */}
      <View style={[styles.footer, {paddingBottom: bottomPad(20)}]}>
        <TouchableOpacity
          style={styles.ctaBtn}
          onPress={() => navigation.navigate('ProLiveMission')}
          activeOpacity={0.85}>
          <Text style={styles.ctaBtnText}>CONFIRM TEAM → MISSION MONITORING</Text>
          <Icon name="arrow-right" size={16} color="#FFF" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingBottom: 12},
  headerLeft: {flexDirection: 'row', alignItems: 'center', gap: 8},
  backBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerTitle: {fontSize: 12, fontWeight: '700', color: '#6366F1', letterSpacing: 1.5, textTransform: 'uppercase'},
  stepBadge: {paddingHorizontal: 8, paddingVertical: 4, borderRadius: 99, backgroundColor: 'rgba(99,102,241,0.08)', borderWidth: 1, borderColor: 'rgba(99,102,241,0.3)'},
  stepText: {fontSize: 10, fontWeight: '700', color: '#6366F1'},

  dots: {flexDirection: 'row', gap: 5, alignItems: 'center', paddingHorizontal: 20, paddingBottom: 8},
  dot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#1E2D45'},
  dotDone: {backgroundColor: '#6366F1'},
  dotActive: {width: 18, borderRadius: 3, backgroundColor: '#6366F1'},

  tabBar: {flexDirection: 'row', backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 4, gap: 4, marginHorizontal: 16, marginBottom: 12},
  tabBtn: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center'},
  tabBtnActive: {backgroundColor: '#6366F1'},
  tabBtnText: {fontSize: 12, fontWeight: '700', color: '#64748B'},
  tabBtnTextActive: {color: '#FFF'},

  content: {paddingHorizontal: 16, gap: 12},

  cpoCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', padding: 14},
  cpoCardAssigned: {borderColor: '#6366F1', backgroundColor: 'rgba(99,102,241,0.06)'},
  cpoHeader: {flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 12},
  cpoAvatar: {width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', flexShrink: 0},
  cpoAvatarText: {fontSize: 14, fontWeight: '700', color: '#FFF'},
  cpoInfo: {flex: 1, minWidth: 0},
  certRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginBottom: 4},
  certBadge: {paddingHorizontal: 8, paddingVertical: 2, borderRadius: 99, borderWidth: 1},
  certText: {fontSize: 9, fontWeight: '800', letterSpacing: 0.5},
  cpoName: {fontSize: 14, fontWeight: '700', color: '#F1F5F9'},
  cpoRole: {fontSize: 10, color: '#64748B', marginTop: 2},
  availRow: {flexDirection: 'row', alignItems: 'center', gap: 4, flexShrink: 0},
  availDot: {width: 7, height: 7, borderRadius: 4, backgroundColor: '#22C55E'},
  availDotIdle: {backgroundColor: '#6366F1'},
  availText: {fontSize: 10, fontWeight: '700', color: '#4ADE80'},
  availTextIdle: {color: '#A5B4FC'},
  cpoStats: {flexDirection: 'row', gap: 8},
  cpoStatItem: {flex: 1, backgroundColor: '#07111F', borderRadius: 8, borderWidth: 1, borderColor: '#1E2D45', padding: 8, alignItems: 'center'},
  cpoStatValue: {fontSize: 16, fontWeight: '800', color: '#A5B4FC'},
  cpoStatLabel: {fontSize: 9, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 1.5, marginTop: 2},

  resourcesCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', padding: 20, alignItems: 'center'},
  resourcesText: {fontSize: 13, color: '#64748B', textAlign: 'center', lineHeight: 20},

  // Vehicles — registration plate is the Issue-30 hero field (cobalt accent).
  vehCard: {backgroundColor: '#0D1929', borderRadius: 16, borderWidth: 1, borderColor: '#1E2D45', padding: 14, gap: 12},
  vehCardLive: {borderColor: '#5B8DEF', backgroundColor: 'rgba(91,141,239,0.06)'},
  vehTopRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  vehCallSignWrap: {flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 1},
  vehCallSignText: {fontSize: 12, fontWeight: '700', color: '#94A3B8', letterSpacing: 0.5},
  plateHero: {backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)', borderRadius: 12, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center'},
  plateLabel: {fontSize: 9, fontWeight: '700', color: '#5B8DEF', letterSpacing: 2, marginBottom: 4},
  plateValue: {fontSize: 26, fontWeight: '800', color: '#E8EEFB', letterSpacing: 3, fontFamily: Platform.select({ios: 'Courier', default: 'monospace'})},
  vehMakeModel: {fontSize: 14, fontWeight: '700', color: '#F1F5F9'},
  vehBadges: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  vehBadge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99, backgroundColor: '#07111F', borderWidth: 1, borderColor: '#1E2D45'},
  vehBadgeText: {fontSize: 9, fontWeight: '700', color: '#94A3B8', letterSpacing: 0.5},

  // Resources — grouped by kind, cobalt section headers.
  missionHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 8},
  missionDatesWrap: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: 7},
  missionDates: {flexShrink: 1, minWidth: 0, fontSize: 12.5, fontWeight: '700', color: '#F1F5F9'},
  missionRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 7, marginTop: 5},
  missionRole: {flex: 1, minWidth: 0, fontSize: 12, color: '#CBD5E1', lineHeight: 17},
  missionNames: {color: '#94A3B8'},
  resGroup: {gap: 8},
  resGroupHeader: {fontSize: 10, fontWeight: '800', color: '#5B8DEF', letterSpacing: 1.5, textTransform: 'uppercase', marginTop: 4},
  resRow: {flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', paddingVertical: 12, paddingHorizontal: 14},
  resRowLive: {borderColor: '#5B8DEF', backgroundColor: 'rgba(91,141,239,0.06)'},
  resKindDot: {width: 8, height: 8, borderRadius: 4, backgroundColor: '#5B8DEF'},
  resLabel: {flex: 1, minWidth: 0, fontSize: 13, fontWeight: '600', color: '#F1F5F9'},
  resQty: {fontSize: 13, fontWeight: '800', color: '#5B8DEF'},

  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: Colors.background},
  ctaBtn: {backgroundColor: '#6366F1', borderRadius: 12, paddingVertical: 14, paddingHorizontal: 20, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  ctaBtnText: {color: '#FFF', fontSize: 13, fontWeight: '700', letterSpacing: 0.3},
}));
