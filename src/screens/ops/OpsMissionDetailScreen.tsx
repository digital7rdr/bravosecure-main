import React, {useEffect, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  Modal,
  } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Colors} from '@theme/index';
import {useNavigation, useRoute, type CompositeNavigationProp, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import type {BookingStackParamList, MainTabParamList} from '@navigation/types';
import {opsApi} from '@services/api';
import {scaleTextStyles} from '@utils/scaling';
import {goBackOnce} from '@navigation/tapGuard';

// Composite nav — local booking-stack moves PLUS cross-tab jumps to
// MessengerTab.Chat. Chat lives on MessengerStackParamList, not on
// BookingStack, so opening the mission group from this screen has to
// hop tabs.
type Nav = CompositeNavigationProp<
  NativeStackNavigationProp<BookingStackParamList, 'OpsMissionDetail'>,
  BottomTabNavigationProp<MainTabParamList>
>;
type RouteParams = RouteProp<BookingStackParamList, 'OpsMissionDetail'>;

// Hoisted to module scope so the useEffect that consumes it doesn't
// need it in its deps array — the regex is constant, not a closure cap.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CrewMember {
  agentId: string; role: string; callSign: string | null; isLead: boolean;
}
interface MissionData {
  shortCode: string;
  commsChannelId: string | null;
  crewCount: number;
  crew: CrewMember[];
}

const OPS = '#0EA5E9';

type TabKey = 'overview' | 'team' | 'log';
type CpoId = 'marcus' | 'aisha' | null;

const STAGES = [
  {key: 'received', label: 'Received', status: 'done'},
  {key: 'approved', label: 'Approved', status: 'done'},
  {key: 'assigned', label: 'Assigned', status: 'done'},
  {key: 'active', label: 'Active', status: 'active'},
  {key: 'done', label: 'Done', status: 'wait'},
];

const CPOS = [
  {id: 'marcus' as CpoId, initials: 'MJ', name: 'Marcus Johnson', level: 'Level 3 CPO', missions: '48 missions', rating: '4.9★', availability: 'AVAILABLE', availColor: '#4ade80', availBg: 'rgba(34,197,94,0.1)', avatarGrad: ['#7C3AED', '#6D28D9'], disabled: false},
  {id: 'aisha' as CpoId, initials: 'AR', name: 'Aisha Rahman', level: 'Level 3 CPO', missions: '61 missions', rating: '5.0★', availability: 'AVAILABLE', availColor: '#4ade80', availBg: 'rgba(34,197,94,0.1)', avatarGrad: ['#D4AF37', '#B8962E'], disabled: false},
];

export default function OpsMissionDetailScreen() {
  const navigation = useNavigation<Nav>();
  const route = useRoute<RouteParams>();
  const {missionId} = route.params;
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [selectedCpo, setSelectedCpo] = useState<CpoId>('marcus');
  const [approveOverlay, setApproveOverlay] = useState(false);
  const [approved, setApproved] = useState(false);

  // Live mission data — comms_channel_id powers the group chat button.
  // Server provisions the group at dispatch (ops.service.ts:dispatchBooking),
  // so for LIVE/PICKUP/SOS missions this is non-null. UUID guard skips the
  // fetch for the static mock ids (e.g. 'BS-8830') used by the dashboard
  // preview, so dev work on those screens doesn't spam a 400.
  const [mission, setMission] = useState<MissionData | null>(null);

  useEffect(() => {
    if (!UUID_RE.test(missionId)) {return;}
    let cancelled = false;
    void (async () => {
      try {
        const {data} = await opsApi.getMission(missionId);
        if (cancelled) {return;}
        setMission({
          shortCode:      data.mission.short_code,
          commsChannelId: data.mission.comms_channel_id,
          crewCount:      data.crew.length,
          crew:           data.crew.map(c => ({
            agentId: c.agent_id, role: c.role, callSign: c.call_sign, isLead: c.is_lead,
          })),
        });
      } catch (e) {
        if (!cancelled) {
          console.warn('[ops-mission-detail] fetch failed:', (e as Error).message);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [missionId]);

  const confirmApprove = () => {
    setApproved(true);
    setApproveOverlay(false);
  };

  const openGroupChat = () => {
    const cid = mission?.commsChannelId;
    if (!cid) {
      Alert.alert(
        'Group chat not ready',
        'The mission group is provisioned automatically when ops dispatches the booking. If this mission is already LIVE, pull to refresh.',
      );
      return;
    }
    // Real ChatScreen handles the encrypted send + receipt flow. The
    // conversation row + participants are populated by MessengerHomeScreen's
    // /conversations/mine sync; if the user hasn't visited that screen yet
    // the runtime will lazy-load on first send. Chat lives on the
    // MessengerStack, so we hop tabs via the composite parent navigator.
    // B-85 — `initial: false` is LOAD-BEARING: without it the nested
    // `screen` overrides the messenger stack's initialRouteName on first
    // mount and back from Chat falls out to the previous tab.
    navigation.navigate('MessengerTab', {
      screen: 'Chat',
      initial: false,
      params: {
        conversationId: cid,
        name:           `Mission ${mission?.shortCode ?? ''}`.trim(),
        isGroup:        true,
      },
    });
  };

  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />

      {/* Header */}
      <View style={styles.header}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}>
          <Icon name="arrow-left" size={20} color="#94A3B8" />
        </TouchableOpacity>
        <View style={styles.headerCenter}>
          <Text style={styles.headerTitle}>Mission BS-8829</Text>
          <View style={styles.activeRow}>
            <View style={styles.activeDot} />
            <Text style={styles.activeText}>ACTIVE</Text>
          </View>
        </View>
        <TouchableOpacity style={styles.iconBtn} activeOpacity={0.7}>
          <Icon name="dots-vertical" size={20} color="#94A3B8" />
        </TouchableOpacity>
      </View>

      <ScrollView showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.content, {paddingBottom: insets.bottom + 100}]}>

        {/* Stage progress */}
        <View style={styles.stageCard}>
          <View style={styles.stageRow}>
            {STAGES.map((stage, i) => (
              <React.Fragment key={stage.key}>
                <View style={styles.stageItem}>
                  <View style={[
                    styles.stageDot,
                    stage.status === 'done' && styles.stageDone,
                    stage.status === 'active' && styles.stageActive,
                    stage.status === 'wait' && styles.stageWait,
                  ]} />
                  <Text style={[
                    styles.stageLabel,
                    stage.status === 'done' && styles.stageLabelDone,
                    stage.status === 'active' && styles.stageLabelActive,
                    stage.status === 'wait' && styles.stageLabelWait,
                  ]}>{stage.label}</Text>
                </View>
                {i < STAGES.length - 1 && (
                  <View style={[
                    styles.stageLine,
                    {backgroundColor: i < 2 ? '#22c55e' : i === 2 ? OPS : '#1E2D45'},
                  ]} />
                )}
              </React.Fragment>
            ))}
          </View>
        </View>

        {/* Section tabs */}
        <View style={styles.tabBar}>
          {(['overview', 'team', 'log'] as TabKey[]).map(tab => (
            <TouchableOpacity
              key={tab}
              style={[styles.tabBtn, activeTab === tab && styles.tabBtnActive]}
              onPress={() => setActiveTab(tab)}
              activeOpacity={0.8}>
              <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
                {tab.charAt(0).toUpperCase() + tab.slice(1)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* ── OVERVIEW TAB ── */}
        {activeTab === 'overview' && (
          <>
            {/* Ops Decision card */}
            <View style={styles.decisionCard}>
              <View style={styles.decisionHeader}>
                <Icon name="gavel" size={16} color={OPS} />
                <Text style={styles.decisionTitle}>OPS DECISION</Text>
              </View>
              {!approved ? (
                <View style={styles.decisionBody}>
                  <Text style={styles.decisionDesc}>
                    Review this booking and approve for dispatch or reject with a reason. Client will be notified immediately.
                  </Text>
                  <View style={styles.decisionBtns}>
                    <TouchableOpacity style={styles.rejectBtn} activeOpacity={0.8}>
                      <Icon name="close" size={16} color="#f87171" />
                      <Text style={styles.rejectBtnText}>Reject</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.approveBtn} onPress={() => setApproveOverlay(true)} activeOpacity={0.85}>
                      <Icon name="check" size={16} color="#FFF" />
                      <Text style={styles.approveBtnText}>Approve Mission</Text>
                    </TouchableOpacity>
                  </View>
                </View>
              ) : (
                <View style={styles.approvedBanner}>
                  <Icon name="check-circle" size={16} color="#4ade80" />
                  <Text style={styles.approvedBannerText}>Mission approved and dispatched.</Text>
                </View>
              )}
            </View>

            {/* Job info card */}
            <View style={styles.jobCard}>
              <View style={styles.clientRow}>
                <View style={styles.clientAvatar}>
                  <Text style={styles.clientAvatarText}>AA</Text>
                </View>
                <View style={{flex: 1}}>
                  <Text style={styles.clientName}>Abdullah Al-Rashid</Text>
                  <View style={styles.clientMeta}>
                    <Icon name="star" size={11} color="#F59E0B" />
                    <Text style={styles.clientMetaText}>4.9 · 47 bookings · VIP</Text>
                  </View>
                </View>
                <View style={styles.vipBadge}>
                  <Text style={styles.vipText}>VIP</Text>
                </View>
              </View>
              <View style={styles.jobGrid}>
                <View style={[styles.jobCell, styles.jobCellBorderR, styles.jobCellBorderB]}>
                  <Text style={styles.jobCellLabel}>TYPE</Text>
                  <Text style={styles.jobCellValue}>Close Protection</Text>
                </View>
                <View style={[styles.jobCell, styles.jobCellBorderB]}>
                  <Text style={styles.jobCellLabel}>PAYOUT</Text>
                  <Text style={[styles.jobCellValue, {color: '#D4AF37'}]}>1,175 credits</Text>
                </View>
                <View style={[styles.jobCell, styles.jobCellBorderR, styles.jobCellBorderB]}>
                  <Text style={styles.jobCellLabel}>DATE</Text>
                  <Text style={styles.jobCellValue}>18 March 2026</Text>
                </View>
                <View style={[styles.jobCell, styles.jobCellBorderB]}>
                  <Text style={styles.jobCellLabel}>DURATION</Text>
                  <Text style={styles.jobCellValue}>8 hours</Text>
                </View>
                <View style={[styles.jobCell, {flexBasis: '100%'}]}>
                  <Text style={styles.jobCellLabel}>LOCATION</Text>
                  <Text style={styles.jobCellValue}>DXB Terminal 3 → DIFC Tower, Dubai</Text>
                </View>
              </View>
            </View>

            {/* Assign CPO Leader */}
            <View>
              <View style={styles.cpoHeader}>
                <Text style={styles.cpoSectionLabel}>ASSIGN CPO LEADER</Text>
                <Text style={styles.cpoSelectedLabel}>
                  {selectedCpo ? (selectedCpo === 'marcus' ? 'Marcus Johnson' : 'Aisha Rahman') : 'None selected'}
                </Text>
              </View>
              <View style={styles.cpoList}>
                {CPOS.map(cpo => {
                  const isSelected = selectedCpo === cpo.id;
                  return (
                    <TouchableOpacity
                      key={cpo.id}
                      style={[styles.cpoChip, isSelected && styles.cpoChipSelected]}
                      onPress={() => setSelectedCpo(cpo.id)}
                      activeOpacity={0.85}>
                      <View style={[styles.cpoAvatar, {backgroundColor: cpo.avatarGrad[0]}]}>
                        <Text style={styles.cpoAvatarText}>{cpo.initials}</Text>
                      </View>
                      <View style={{flex: 1}}>
                        <View style={styles.cpoNameRow}>
                          <Text style={styles.cpoName}>{cpo.name}</Text>
                          <View style={[styles.availBadge, {backgroundColor: cpo.availBg}]}>
                            <Text style={[styles.availText, {color: cpo.availColor}]}>{cpo.availability}</Text>
                          </View>
                        </View>
                        <View style={styles.cpoMeta}>
                          <Text style={styles.cpoMetaText}>{cpo.level}</Text>
                          <Text style={styles.cpoMetaDot}>·</Text>
                          <Text style={styles.cpoMetaText}>{cpo.missions}</Text>
                          <Text style={styles.cpoMetaDot}>·</Text>
                          <Text style={styles.cpoRating}>{cpo.rating}</Text>
                        </View>
                      </View>
                      <Icon
                        name={isSelected ? 'check-circle' : 'radiobox-blank'}
                        size={18}
                        color={isSelected ? OPS : '#334155'}
                      />
                    </TouchableOpacity>
                  );
                })}
                {/* James Tate - disabled */}
                <View style={[styles.cpoChip, {opacity: 0.5}]}>
                  <View style={[styles.cpoAvatar, {backgroundColor: '#1E2D45'}]}>
                    <Text style={[styles.cpoAvatarText, {color: '#64748B'}]}>JT</Text>
                  </View>
                  <View style={{flex: 1}}>
                    <View style={styles.cpoNameRow}>
                      <Text style={[styles.cpoName, {color: '#94A3B8'}]}>James Tate</Text>
                      <View style={{backgroundColor: 'rgba(245,158,11,0.1)', paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4}}>
                        <Text style={{fontSize: 9, fontWeight: '700', color: '#fbbf24'}}>ON MISSION</Text>
                      </View>
                    </View>
                    <View style={styles.cpoMeta}>
                      <Text style={[styles.cpoMetaText, {color: '#475569'}]}>Level 2 CPO</Text>
                      <Text style={[styles.cpoMetaDot, {color: '#334155'}]}>·</Text>
                      <Text style={[styles.cpoMetaText, {color: '#475569'}]}>29 missions</Text>
                    </View>
                  </View>
                  <Icon name="block-helper" size={18} color="#334155" />
                </View>
              </View>
            </View>
          </>
        )}

        {/* ── TEAM TAB ── */}
        {activeTab === 'team' && (
          <>
            <View style={styles.teamHeaderRow}>
              <Text style={styles.cpoSectionLabel}>MISSION TEAM</Text>
              <TouchableOpacity style={styles.addBtn} activeOpacity={0.8}>
                <Icon name="account-plus" size={14} color="#38bdf8" />
                <Text style={styles.addBtnText}>Add</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.teamCard}>
              {(mission?.crew ?? []).length === 0 ? (
                <Text style={styles.teamEmpty}>
                  {mission ? 'No crew assigned yet.' : 'Loading team…'}
                </Text>
              ) : (mission?.crew ?? []).map((m, i, arr) => (
                <View key={m.agentId} style={[styles.teamRow, i < arr.length - 1 && styles.teamRowBorder]}>
                  <View style={[styles.teamAvatar, {backgroundColor: m.isLead ? '#7C3AED' : '#0EA5E9'}]}>
                    <Text style={styles.teamAvatarText}>{(m.callSign ?? m.role ?? '?').slice(0, 2).toUpperCase()}</Text>
                  </View>
                  <View style={{flex: 1}}>
                    <View style={styles.teamNameRow}>
                      <Text style={styles.teamName}>{m.callSign ?? `Agent ${m.agentId.slice(0, 6)}`}</Text>
                      <View style={[styles.teamBadge, {backgroundColor: m.isLead ? 'rgba(124,58,237,0.12)' : 'rgba(14,165,233,0.12)'}]}>
                        <Text style={[styles.teamBadgeText, {color: m.isLead ? '#a78bfa' : '#38bdf8'}]}>
                          {m.isLead ? 'CPO LEAD' : m.role.toUpperCase()}
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.teamSub}>{m.role}</Text>
                  </View>
                </View>
              ))}
            </View>
            <TouchableOpacity style={styles.groupChatBtn} activeOpacity={0.85} onPress={openGroupChat}>
              <Icon name="forum" size={16} color="#FFF" />
              <Text style={styles.groupChatText}>
                {mission?.commsChannelId ? 'Open Mission Group Chat' : 'Group chat — pending dispatch'}
              </Text>
            </TouchableOpacity>
          </>
        )}

        {/* ── LOG TAB ── */}
        {activeTab === 'log' && (
          <View style={styles.logList}>
            <View style={styles.logEntry}>
              <View style={styles.logLeft}>
                <View style={[styles.logDot, {backgroundColor: '#1E2D45'}]} />
              </View>
              <View style={styles.logBody}>
                <Text style={styles.logWaiting}>
                  The full mission audit trail is available in the Bravo Ops console.
                </Text>
              </View>
            </View>
          </View>
        )}

      </ScrollView>

      {/* Footer */}
      <View style={[styles.footer, {paddingBottom: bottomPad(16)}]}>
        <TouchableOpacity style={styles.chatBtn} activeOpacity={0.85} onPress={openGroupChat}>
          <Icon name="forum" size={16} color="#38bdf8" />
          <Text style={styles.chatBtnText}>Open Mission Group Chat</Text>
          <View style={styles.chatBadge}>
            <View style={styles.chatBadgeDot} />
            <Text style={styles.chatBadgeText}>
              {mission ? `${mission.crewCount + 1} members` : '— members'}
            </Text>
          </View>
        </TouchableOpacity>
      </View>

      {/* Approve overlay */}
      <Modal visible={approveOverlay} transparent animationType="fade">
        <View style={styles.overlayBg}>
          <View style={styles.overlayCard}>
            <View style={styles.overlayIcon}>
              <Icon name="check-decagram" size={32} color={OPS} />
            </View>
            <Text style={styles.overlayTitle}>Approve Mission BS-8829?</Text>
            <Text style={styles.overlayDesc}>
              This will notify the client and dispatch job to available agents on the marketplace.
            </Text>
            <View style={styles.overlayBtns}>
              <TouchableOpacity style={styles.overlayCancelBtn} onPress={() => setApproveOverlay(false)} activeOpacity={0.8}>
                <Text style={styles.overlayCancelText}>Cancel</Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.overlayConfirmBtn} onPress={confirmApprove} activeOpacity={0.85}>
                <Text style={styles.overlayConfirmText}>Confirm</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},

  header: {flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, paddingBottom: 10, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  iconBtn: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  headerCenter: {flex: 1, alignItems: 'center'},
  headerTitle: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  activeRow: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2},
  activeDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#4ade80'},
  activeText: {fontSize: 10, fontWeight: '700', color: '#4ade80', textTransform: 'uppercase'},

  content: {paddingHorizontal: 16, paddingTop: 16, gap: 16},

  // Stage progress
  stageCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', padding: 14},
  stageRow: {flexDirection: 'row', alignItems: 'flex-start'},
  stageItem: {alignItems: 'center', gap: 4, flex: 1},
  stageDot: {width: 10, height: 10, borderRadius: 5, borderWidth: 2},
  stageDone: {backgroundColor: '#22c55e', borderColor: '#22c55e'},
  stageActive: {backgroundColor: OPS, borderColor: OPS, shadowColor: OPS, shadowRadius: 8, shadowOpacity: 0.6, elevation: 4},
  stageWait: {backgroundColor: 'transparent', borderColor: '#1E2D45'},
  stageLabel: {fontSize: 9, fontWeight: '700', textTransform: 'uppercase', textAlign: 'center'},
  stageLabelDone: {color: '#4ade80'},
  stageLabelActive: {color: '#38bdf8'},
  stageLabelWait: {color: '#475569'},
  stageLine: {height: 1, flex: 1, marginBottom: 14, marginHorizontal: 2},

  // Tabs
  tabBar: {flexDirection: 'row', gap: 4, padding: 4, backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45'},
  tabBtn: {flex: 1, paddingVertical: 8, borderRadius: 8, alignItems: 'center'},
  tabBtnActive: {backgroundColor: 'rgba(14,165,233,0.15)'},
  tabText: {fontSize: 12, fontWeight: '700', color: '#64748B'},
  tabTextActive: {color: '#38bdf8'},

  // Decision card
  decisionCard: {borderRadius: 16, overflow: 'hidden', backgroundColor: '#0D1929', borderWidth: 1, borderColor: 'rgba(14,165,233,0.3)'},
  decisionHeader: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 8},
  decisionTitle: {fontSize: 10, fontWeight: '700', color: OPS, textTransform: 'uppercase', letterSpacing: 2},
  decisionBody: {paddingHorizontal: 14, paddingBottom: 14},
  decisionDesc: {fontSize: 12, color: '#94A3B8', lineHeight: 18, marginBottom: 12},
  decisionBtns: {flexDirection: 'row', gap: 10},
  rejectBtn: {flex: 1, paddingVertical: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(239,68,68,0.07)', borderWidth: 1, borderColor: 'rgba(239,68,68,0.25)'},
  rejectBtnText: {fontSize: 13, fontWeight: '700', color: '#f87171'},
  approveBtn: {flex: 2, paddingVertical: 12, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: OPS},
  approveBtnText: {fontSize: 13, fontWeight: '700', color: '#FFF'},
  approvedBanner: {flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingBottom: 14},
  approvedBannerText: {fontSize: 13, color: '#4ade80', fontWeight: '600'},

  // Job card
  jobCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  clientRow: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 14, borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  clientAvatar: {width: 40, height: 40, borderRadius: 20, backgroundColor: OPS, alignItems: 'center', justifyContent: 'center'},
  clientAvatarText: {fontSize: 13, fontWeight: '700', color: '#FFF'},
  clientName: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  clientMeta: {flexDirection: 'row', alignItems: 'center', gap: 3, marginTop: 2},
  clientMetaText: {fontSize: 10, color: '#94A3B8', fontWeight: '600'},
  vipBadge: {backgroundColor: 'rgba(212,175,55,0.1)', borderWidth: 1, borderColor: 'rgba(212,175,55,0.25)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99},
  vipText: {fontSize: 10, fontWeight: '700', color: '#D4AF37'},
  jobGrid: {flexDirection: 'row', flexWrap: 'wrap'},
  jobCell: {paddingHorizontal: 14, paddingVertical: 10, flexBasis: '50%'},
  jobCellBorderR: {borderRightWidth: 1, borderRightColor: '#1E2D45'},
  jobCellBorderB: {borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  jobCellLabel: {fontSize: 9, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', marginBottom: 2},
  jobCellValue: {fontSize: 12, fontWeight: '700', color: '#E2E8F0'},

  // CPO section
  cpoHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  cpoSectionLabel: {fontSize: 11, fontWeight: '700', color: '#64748B', textTransform: 'uppercase', letterSpacing: 2},
  cpoSelectedLabel: {fontSize: 10, fontWeight: '700', color: '#475569'},
  cpoList: {gap: 10},
  cpoChip: {flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, paddingHorizontal: 14, borderRadius: 12, borderWidth: 1.5, borderColor: '#1E2D45', backgroundColor: '#0D1929'},
  cpoChipSelected: {borderColor: OPS, backgroundColor: 'rgba(14,165,233,0.12)'},
  cpoAvatar: {width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center'},
  cpoAvatarText: {fontSize: 11, fontWeight: '700', color: '#FFF'},
  cpoNameRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  cpoName: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  availBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4},
  availText: {fontSize: 9, fontWeight: '700'},
  cpoMeta: {flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2},
  cpoMetaText: {fontSize: 10, color: '#64748B'},
  cpoMetaDot: {fontSize: 10, color: '#475569'},
  cpoRating: {fontSize: 10, color: '#F59E0B'},

  // Team tab
  teamHeaderRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10},
  addBtn: {flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(14,165,233,0.12)', borderWidth: 1, borderColor: 'rgba(14,165,233,0.3)', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8},
  addBtnText: {fontSize: 11, fontWeight: '700', color: '#38bdf8'},
  teamCard: {backgroundColor: '#0D1929', borderRadius: 12, borderWidth: 1, borderColor: '#1E2D45', overflow: 'hidden'},
  teamRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  teamRowBorder: {borderBottomWidth: 1, borderBottomColor: '#1E2D45'},
  teamAvatar: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center'},
  teamAvatarText: {fontSize: 12, fontWeight: '700', color: '#FFF'},
  teamNameRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  teamName: {fontSize: 13, fontWeight: '700', color: '#E2E8F0'},
  teamBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4},
  teamBadgeText: {fontSize: 9, fontWeight: '700'},
  teamSub: {fontSize: 12, color: '#64748B', marginTop: 2},
  teamEmpty: {fontSize: 12.5, color: '#64748B', textAlign: 'center', paddingVertical: 16},
  removeText: {fontSize: 10, color: '#f87171', fontWeight: '600'},
  teamAddRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 14, paddingVertical: 12},
  teamAddAvatar: {width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(14,165,233,0.12)', borderWidth: 1, borderColor: 'rgba(14,165,233,0.4)', borderStyle: 'dashed'},
  teamAddText: {fontSize: 13, color: '#64748B', fontStyle: 'italic'},
  groupChatBtn: {backgroundColor: OPS, borderRadius: 12, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8},
  groupChatText: {fontSize: 13, fontWeight: '700', color: '#FFF'},

  // Log tab
  logList: {gap: 0},
  logEntry: {flexDirection: 'row', gap: 12},
  logLeft: {alignItems: 'center', width: 16},
  logDot: {width: 8, height: 8, borderRadius: 4, marginTop: 4, flexShrink: 0},
  logStem: {width: 1, flex: 1, backgroundColor: '#1E2D45', minHeight: 36},
  logBody: {flex: 1, paddingBottom: 16},
  logText: {fontSize: 12, fontWeight: '700', color: '#E2E8F0'},
  logSub: {fontSize: 10, color: '#64748B', marginTop: 2},
  logWaiting: {fontSize: 12, color: '#475569', fontStyle: 'italic'},

  // Footer
  footer: {paddingHorizontal: 16, paddingTop: 8, backgroundColor: 'transparent'},
  chatBtn: {flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingVertical: 14, paddingHorizontal: 16, backgroundColor: 'rgba(14,165,233,0.06)', borderWidth: 1, borderColor: 'rgba(14,165,233,0.3)'},
  chatBtnText: {fontSize: 13, fontWeight: '700', color: '#38bdf8', flex: 1},
  chatBadge: {flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: 'rgba(14,165,233,0.15)', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 99},
  chatBadgeDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: '#38bdf8'},
  chatBadgeText: {fontSize: 10, fontWeight: '700', color: '#38bdf8'},

  // Approve overlay
  overlayBg: {flex: 1, backgroundColor: 'rgba(0,0,0,0.75)', alignItems: 'center', justifyContent: 'center'},
  overlayCard: {marginHorizontal: 24, width: '85%', backgroundColor: '#0D1929', borderRadius: 20, borderWidth: 1, borderColor: 'rgba(14,165,233,0.4)', padding: 24, alignItems: 'center'},
  overlayIcon: {width: 64, height: 64, borderRadius: 32, backgroundColor: 'rgba(14,165,233,0.15)', borderWidth: 2, borderColor: 'rgba(14,165,233,0.4)', alignItems: 'center', justifyContent: 'center', marginBottom: 16},
  overlayTitle: {fontSize: 15, fontWeight: '800', color: '#E2E8F0', marginBottom: 6, textAlign: 'center'},
  overlayDesc: {fontSize: 12, color: '#94A3B8', lineHeight: 18, textAlign: 'center', marginBottom: 20},
  overlayBtns: {flexDirection: 'row', gap: 12, width: '100%'},
  overlayCancelBtn: {flex: 1, paddingVertical: 12, borderRadius: 12, alignItems: 'center', borderWidth: 1, borderColor: '#1E2D45'},
  overlayCancelText: {fontSize: 12, fontWeight: '700', color: '#94A3B8'},
  overlayConfirmBtn: {flex: 2, paddingVertical: 12, borderRadius: 12, alignItems: 'center', backgroundColor: OPS},
  overlayConfirmText: {fontSize: 13, fontWeight: '700', color: '#FFF'},
}));
