/**
 * Provider · CPO Roster — the service-provider org's officer roster.
 *
 * Premium redesign (Bravo "CPO Roster" design handoff): obsidian base with
 * the platinum-cobalt accent. Header with live ACTIVE chip, company /
 * master-licence line, Active·Pending·Deployed stat strip, an illustrated
 * empty state (officer-tile icon + plus badge, skeleton preview rows, and
 * the three perks of registering CPOs), and a gradient footer CTA.
 *
 * Data layer unchanged: orgApi.listCpos / setCpoStatus, navigate →
 * OrgCreateCpo. Populated rows follow the design's preview-row blueprint
 * (avatar · name+meta · status pill) and keep suspend/reinstate.
 */
import React, {useCallback, useEffect, useState} from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity,
  StatusBar, RefreshControl } from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useBottomInset} from '@hooks/useBottomInset';
import {LinearGradient} from 'expo-linear-gradient';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {orgApi, agentApi, type RosterMember} from '@services/api';
import {useAuthStore} from '@/store/authStore';
import {scaleTextStyles} from '@utils/scaling';
import {warnStrandedClaims} from '@utils/strandedClaimsAlert';
import LoadingView from '@components/LoadingView';
import {SuspendMemberModal, type SuspendPayload} from '@components/SuspendMemberModal';
import {goBackOnce} from '@navigation/tapGuard';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

// Design tokens (Bravo "CPO Roster" handoff — obsidian + platinum cobalt).
const D = {
  bg:         '#07090D',
  text:       '#F2F4F8',
  textDim:    'rgba(229,233,242,0.62)',
  textMute:   'rgba(180,188,204,0.45)',
  textFaint:  'rgba(180,188,204,0.28)',
  hair:       'rgba(255,255,255,0.06)',
  hair2:      'rgba(255,255,255,0.09)',
  accent:     '#5B8DEF',
  accentSoft: '#A9C5FF',
  accentDeep: '#2F5BE0',
  amber:      '#F5C76B',
  signal:     '#4ADE80',
  alert:      '#FF5D5D',
  fSans:  'Manrope_500Medium',
  fSemi:  'Manrope_600SemiBold',
  fBold:  'Manrope_700Bold',
  fMono:  'monospace',
};

// Officer is pending until ops approves the agent record.
const PENDING_AGENT = new Set(['DRAFT', 'PROFILE_COMPLETE', 'KYC_PENDING', 'DOCS_PENDING', 'SUBMITTED', 'UNDER_REVIEW']);

function initials(name: string | null): string {
  if (!name) {return 'OF';}
  const p = name.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) {return 'OF';}
  if (p.length === 1) {return p[0].slice(0, 2).toUpperCase();}
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function StatPill({value, label, tint}: {value: number; label: string; tint: string}) {
  return (
    <View style={s.statPill}>
      <Text style={[s.statValue, {color: tint}]}>{value}</Text>
      <Text style={s.statLabel}>{label}</Text>
    </View>
  );
}

function SkeletonRow() {
  return (
    <View style={s.skelRow}>
      <View style={s.skelAvatar} />
      <View style={{flex: 1, gap: 8}}>
        <View style={[s.skelBar, {width: '52%', height: 9}]} />
        <View style={[s.skelBar, {width: '34%', height: 7, backgroundColor: 'rgba(255,255,255,0.04)'}]} />
      </View>
      <View style={s.skelPill} />
    </View>
  );
}

function BenefitLine({icon, title, sub}: {icon: React.ComponentProps<typeof Icon>['name']; title: string; sub: string}) {
  return (
    <View style={s.benefitRow}>
      <View style={s.benefitIcon}>
        <Icon name={icon} size={17} color={D.accentSoft} />
      </View>
      <View style={{flex: 1, minWidth: 0, paddingTop: 1}}>
        <Text style={s.benefitTitle}>{title}</Text>
        <Text style={s.benefitSub}>{sub}</Text>
      </View>
    </View>
  );
}

// Status pill tint per roster/agent state (design: right-hand pill on a row).
/** Whole days from now until `iso`, floored at 0. Null when there is no end date. */
function daysLeft(iso: string | null): number | null {
  if (!iso) {return null;}
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) {return null;}
  return Math.max(0, Math.ceil((t - Date.now()) / 86_400_000));
}

/** "until 6 Aug" / "indefinite" — the second meta line on a suspended row. */
function suspensionLine(m: RosterMember): string {
  if (!m.suspended_until) {return 'Suspended · indefinite';}
  const d = new Date(m.suspended_until);
  if (Number.isNaN(d.getTime())) {return 'Suspended';}
  return `Suspended · until ${d.toLocaleDateString(undefined, {day: 'numeric', month: 'short'})}`;
}

function memberPill(m: RosterMember): {label: string; fg: string; bg: string; bd: string} {
  if (m.status === 'suspended') {
    const d = daysLeft(m.suspended_until);
    return {
      label: d === null ? 'SUSPENDED' : `SUSPENDED · ${d}D`,
      fg: D.amber, bg: 'rgba(245,181,68,0.10)', bd: 'rgba(245,181,68,0.34)',
    };
  }
  if (m.status === 'removed')   {return {label: 'REMOVED',   fg: D.textMute, bg: 'rgba(255,255,255,0.03)', bd: D.hair2};}
  if (m.agent_status && PENDING_AGENT.has(m.agent_status)) {
    return {label: 'PENDING', fg: D.amber, bg: 'rgba(245,181,68,0.10)', bd: 'rgba(245,181,68,0.34)'};
  }
  return {label: 'ACTIVE', fg: D.signal, bg: 'rgba(74,222,128,0.10)', bd: 'rgba(74,222,128,0.32)'};
}

export default function OrgRosterScreen() {
  const insets = useSafeAreaInsets();
  const {bottomPad} = useBottomInset();
  const navigation = useNavigation<Nav>();
  const [roster, setRoster] = useState<RosterMember[]>([]);
  const [company, setCompany] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Non-null while the suspend dialog is open for that member.
  const [suspendTarget, setSuspendTarget] = useState<RosterMember | null>(null);
  const [suspendBusy, setSuspendBusy] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{data}, me] = await Promise.all([
        orgApi.listCpos(),
        agentApi.getMe().catch(() => null),
      ]);
      setRoster(data);
      if (me?.data.agent.display_name) {setCompany(me.data.agent.display_name);}
    } catch (e: unknown) {
      setError((e as Error).message ?? 'Failed to load roster');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const visible = roster.filter(m => m.status !== 'removed');
  const activeCount   = visible.filter(m => m.status === 'active' && !(m.agent_status && PENDING_AGENT.has(m.agent_status))).length;
  const pendingCount  = visible.filter(m => m.status === 'active' && m.agent_status && PENDING_AGENT.has(m.agent_status)).length;
  // LM-A5 — was hardcoded 0; server now reports per-member on_mission (F11).
  const deployedCount = visible.filter(m => m.on_mission).length;
  const suspendedCount = visible.filter(m => m.status === 'suspended').length;
  // Step 20 — managed-CPO roster is capped (D5: ~10 login accounts, one email = one agency).
  const cpoUsed = visible.filter(m => m.member_role === 'cpo').length;
  const ROSTER_CAP = 10;
  const empty = !loading && visible.length === 0;

  // RS-10 — promote/demote is OWNER-only (the company account). Delegated
  // managers are account_kind 'cpo'; the server enforces the same rule.
  const isOwner = useAuthStore(st => st.user?.account_kind === 'agency');

  const setStatus = useCallback((
    m: RosterMember,
    next: 'active' | 'suspended' | 'removed',
    window?: {suspended_from?: string; suspended_until?: string | null; suspend_reason?: string},
  ) => {
    void (async () => {
      try {
        const {data} = await orgApi.setCpoStatus(m.member_user_id, next, window);
        warnStrandedClaims(data.stranded_room_claims);
        await load();
      } catch (e: unknown) {
        Alert.alert('Error', (e as Error).message ?? 'Update failed');
      }
    })();
  }, [load]);

  const setRole = useCallback((m: RosterMember, next: 'cpo' | 'manager') => {
    void (async () => {
      try {
        const {data} = await orgApi.setCpoRole(m.member_user_id, next);
        warnStrandedClaims(data.stranded_room_claims);
        await load();
      } catch (e: unknown) {
        // Q7 batch — the widened server rules have refusal codes this screen
        // can hit (e.g. a promoted workspace manager landing here); raw Axios
        // prose ("Request failed with status code 403") explains nothing.
        const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
        const copy: Record<string, string> = {
          only_org_owner_can_demote_managers: 'Only the owner can remove a manager’s role.',
          role_change_not_allowed: 'That role does not fit this member — office staff are managed from the Employees screen.',
          role_changed_concurrently: 'Another admin changed this member’s role at the same time — refresh and try again.',
          cannot_modify_org_owner: 'The owner’s role cannot be changed.',
          scoped_manager_cannot_change_roles: 'Your manager role is scoped to one branch, so you cannot change roles.',
          member_not_active: 'Reinstate this member before changing their role.',
        };
        Alert.alert('Error', (code && copy[code]) || (e as Error).message || 'Update failed');
      }
    })();
  }, [load]);

  // LM-A6 — was an undiscoverable long-press that could ONLY suspend/reinstate;
  // permanent offboarding ('removed', which the API always supported) had no UI.
  const openMemberActions = useCallback((m: RosterMember) => {
    const name = m.display_name ?? 'this member';
    const buttons: Array<{text: string; style?: 'cancel' | 'destructive' | 'default'; onPress?: () => void}> = [];
    // A CPO standing on a live detail must not be cut off mid-mission — both
    // suspend and remove revoke their sessions and pull them from the ops room.
    // The server refuses too (member_on_live_mission); this is the friendly half.
    if (m.on_mission) {
      buttons.push({
        text: 'On a live mission — cannot suspend',
        onPress: () => Alert.alert(
          'Officer is on a live mission',
          `${name} cannot be suspended or removed until their current mission is completed or aborted.`,
        ),
      });
    } else if (m.status === 'active') {
      buttons.push({text: 'Suspend…', onPress: () => setSuspendTarget(m)});
    } else if (m.status === 'suspended') {
      buttons.push({
        text: 'Lift suspension',
        onPress: () => Alert.alert('Lift suspension?',
          `${name} regains access immediately and becomes assignable to missions.`, [
            {text: 'Cancel', style: 'cancel'},
            {text: 'Lift', onPress: () => setStatus(m, 'active')},
          ]),
      });
    }
    if (isOwner && m.status === 'active') {
      if (m.member_role === 'cpo') {
        buttons.push({
          text: 'Promote to Manager',
          onPress: () => Alert.alert('Promote to Manager?',
            `${name} gains manager access: all department channels (including restricted ones) and roster management.`, [
              {text: 'Cancel', style: 'cancel'},
              {text: 'Promote', onPress: () => setRole(m, 'manager')},
            ]),
        });
      } else if (m.member_role === 'manager') {
        buttons.push({
          text: 'Demote to CPO',
          onPress: () => Alert.alert('Demote to CPO?',
            `${name} loses manager access. They are removed from restricted channels and their keys are rotated.`, [
              {text: 'Cancel', style: 'cancel'},
              {text: 'Demote', style: 'destructive', onPress: () => setRole(m, 'cpo')},
            ]),
        });
      }
    }
    buttons.push({
      text: 'View profile',
      onPress: () => navigation.navigate('OrgCpoProfile', {
        memberUserId: m.member_user_id, displayName: m.display_name,
      }),
    });
    if (!m.on_mission) {
      buttons.push({
        text: 'Remove from roster', style: 'destructive',
        onPress: () => Alert.alert('Remove member?',
          `${name} loses roster access permanently. Their mission history is kept.`, [
            {text: 'Cancel', style: 'cancel'},
            {text: 'Remove', style: 'destructive', onPress: () => setStatus(m, 'removed')},
          ]),
      });
    }
    buttons.push({text: 'Cancel', style: 'cancel'});
    Alert.alert(name, m.on_mission ? 'On a live mission right now.' : undefined, buttons);
  }, [setStatus, setRole, isOwner, navigation]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />

      {/* ── Header ── */}
      <View style={s.header}>
        <TouchableOpacity style={s.backBtn} onPress={() => goBackOnce(navigation)} activeOpacity={0.7}
          hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Icon name="chevron-left" size={22} color={D.text} />
        </TouchableOpacity>
        <View style={s.accentBar} />
        <Text style={s.headerTitle}>CPO ROSTER</Text>
        <View style={s.activeChip}>
          <View style={[s.activeDot, activeCount > 0 && {backgroundColor: D.signal}]} />
          <Text style={s.activeChipText}>{activeCount} ACTIVE</Text>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={s.body}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} tintColor={D.accent}
            onRefresh={() => { setRefreshing(true); void load(); }} />
        }>

        {/* company / master licence line */}
        <View style={s.companyRow}>
          <Icon name="office-building-outline" size={14} color={D.textMute} />
          <Text style={s.companyText}>{company ?? 'Your company'} · Master licence</Text>
        </View>

        {/* stat strip */}
        <View style={{flexDirection: 'row', gap: 10}}>
          <StatPill value={activeCount}   label="ACTIVE"   tint={D.text} />
          <StatPill value={pendingCount}  label="PENDING"  tint={D.amber} />
          <StatPill value={deployedCount} label="DEPLOYED" tint={D.accentSoft} />
          {suspendedCount > 0 && (
            <StatPill value={suspendedCount} label="SUSPENDED" tint={D.amber} />
          )}
        </View>

        <View style={{flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'}}>
          <Text style={s.sectionLabel}>YOUR REGISTERED OFFICERS</Text>
          <View style={{paddingHorizontal: 9, paddingVertical: 4, borderRadius: 999,
            backgroundColor: cpoUsed >= ROSTER_CAP ? 'rgba(245,199,107,0.12)' : 'rgba(255,255,255,0.04)',
            borderWidth: 1, borderColor: cpoUsed >= ROSTER_CAP ? 'rgba(245,199,107,0.34)' : D.hair2}}>
            <Text style={{fontFamily: D.fBold, fontSize: 10, letterSpacing: 0.6,
              color: cpoUsed >= ROSTER_CAP ? D.amber : D.textDim}}>{cpoUsed}/{ROSTER_CAP} CPOs</Text>
          </View>
        </View>

        {loading ? (
          <LoadingView compact label="Loading roster…" />
        ) : error ? (
          <Text style={s.error}>{error}</Text>
        ) : empty ? (
          <>
            {/* ── Empty state card ── */}
            <LinearGradient
              colors={['rgba(18,24,38,0.7)', 'rgba(11,15,24,0.6)']}
              style={s.emptyCard}>
      <ImageryBackdrop source={Imagery.cpoStandby} variant="card" radius={24} />
              {/* officer icon + plus badge */}
              <View style={{alignItems: 'center'}}>
                <View style={s.emptyIconTile}>
                  <Icon name="account-group-outline" size={34} color={D.accentSoft} />
                  <LinearGradient colors={['#7FA8FF', D.accent, D.accentDeep]} style={s.plusBadge}>
                    <Icon name="plus" size={13} color="#fff" />
                  </LinearGradient>
                </View>
              </View>

              <Text style={s.emptyTitle}>No officers yet</Text>
              <Text style={s.emptySub}>
                Add your first CPO to register them under your master licence and start dispatching jobs.
              </Text>

              {/* skeleton preview */}
              <Text style={s.previewLabel}>PREVIEW</Text>
              <View style={{gap: 9, opacity: 0.6}}>
                <SkeletonRow />
                <SkeletonRow />
              </View>
            </LinearGradient>

            {/* ── Benefits ── */}
            <View style={{gap: 15, paddingHorizontal: 2}}>
              <BenefitLine icon="card-account-details-outline" title="Inherits your master licence"
                sub="Each officer is covered under your company compliance pack." />
              <BenefitLine icon="send-outline" title="Assign & track deployment"
                sub="Dispatch CPOs to jobs and monitor them in real time." />
              <BenefitLine icon="wallet-outline" title="Consolidated payouts"
                sub="All officer earnings settle into your provider account." />
            </View>
          </>
        ) : (
          /* ── Populated roster (preview-row blueprint) ── */
          <View style={{gap: 9}}>
            {visible.map(m => {
              const pill = memberPill(m);
              return (
                <TouchableOpacity key={m.member_user_id}
                  style={[s.memberRow, m.status === 'suspended' && s.memberRowSuspended]}
                  activeOpacity={0.8}
                  onPress={() => navigation.navigate('OrgCpoProfile', {memberUserId: m.member_user_id, displayName: m.display_name})}
                  onLongPress={() => openMemberActions(m)}>
                  <View style={s.memberAvatar}>
                    <Text style={s.memberInitials}>{initials(m.display_name)}</Text>
                    {/* F11 — live duty signal on the avatar. Always visible so the
                        indicator reads as a status light (green = on duty, grey =
                        off), not an easy-to-miss presence-only badge. */}
                    <View style={[s.dutyBadge, {backgroundColor: m.on_duty ? D.signal : D.textMute}]} />
                  </View>
                  <View style={{flex: 1, minWidth: 0}}>
                    <View style={s.nameRow}>
                      <Text style={s.memberName} numberOfLines={1}>{m.display_name ?? '—'}</Text>
                      {/* Step 20 — surface delegated Department Managers in the roster. */}
                      {m.member_role === 'manager' ? (
                        <View style={s.roleBadge}><Text style={s.roleBadgeText}>MANAGER</Text></View>
                      ) : null}
                      {m.on_mission ? (
                        <View style={s.deployedBadge}><Text style={s.deployedBadgeText}>DEPLOYED</Text></View>
                      ) : null}
                    </View>
                    <Text style={s.memberMeta} numberOfLines={1}>
                      {m.call_sign ? `${m.call_sign} · ` : ''}{m.member_role === 'manager' ? 'Manager' : 'CPO'}
                      {m.missions_completed > 0 ? ` · ${m.missions_completed} mission${m.missions_completed === 1 ? '' : 's'}` : ''}
                      {m.on_duty && !m.on_mission ? ' · On duty' : ''}
                    </Text>
                    {m.status === 'suspended' && (
                      <Text style={s.suspendMeta} numberOfLines={1}>{suspensionLine(m)}</Text>
                    )}
                  </View>
                  {/* LM-A6 — a visible affordance for the member actions sheet. */}
                  <TouchableOpacity onPress={() => openMemberActions(m)} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
                    <Icon name="dots-vertical" size={18} color={D.textMute} />
                  </TouchableOpacity>
                  <View style={[s.memberPill, {backgroundColor: pill.bg, borderColor: pill.bd}]}>
                    <Text style={[s.memberPillText, {color: pill.fg}]}>{pill.label}</Text>
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}

        <View style={{height: 12}} />
      </ScrollView>

      {/* ── Footer CTA ── */}
      <LinearGradient colors={['rgba(7,9,13,0)', 'rgba(7,9,13,1)']} locations={[0, 0.3]}
        style={{paddingHorizontal: 20, paddingTop: 14, paddingBottom: bottomPad(14)}}>
        <TouchableOpacity activeOpacity={0.85} onPress={() => navigation.navigate('OrgCreateCpo')}>
          <LinearGradient colors={['#6E9BF5', D.accent, D.accentDeep]} style={s.cta}>
            <Icon name="plus" size={19} color="#fff" />
            <Text style={s.ctaText}>{empty ? 'Add Your First CPO' : 'Add CPO'}</Text>
          </LinearGradient>
        </TouchableOpacity>
      </LinearGradient>

      <SuspendMemberModal
        visible={suspendTarget !== null}
        memberName={suspendTarget?.display_name ?? 'this officer'}
        busy={suspendBusy}
        onCancel={() => setSuspendTarget(null)}
        onConfirm={(p: SuspendPayload) => {
          const target = suspendTarget;
          if (!target) {return;}
          setSuspendBusy(true);
          void (async () => {
            try {
              const {data} = await orgApi.setCpoStatus(target.member_user_id, 'suspended', p);
              warnStrandedClaims(data.stranded_room_claims);
              setSuspendTarget(null);
              await load();
            } catch (e: unknown) {
              Alert.alert('Could not suspend', (e as Error).message ?? 'Update failed');
            } finally {
              setSuspendBusy(false);
            }
          })();
        }}
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},

  // header
  header: {flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 20, paddingVertical: 14},
  backBtn: {
    width: 42, height: 42, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair2,
    alignItems: 'center', justifyContent: 'center',
  },
  accentBar: {
    width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent,
    shadowColor: D.accent, shadowOpacity: 0.8, shadowRadius: 8, shadowOffset: {width: 0, height: 0},
  },
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2.2, color: D.text},
  activeChip: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  activeDot: {width: 6, height: 6, borderRadius: 3, backgroundColor: D.textMute},
  activeChipText: {fontFamily: D.fBold, fontSize: 10, letterSpacing: 0.8, color: D.accentSoft},

  body: {paddingHorizontal: 20, paddingTop: 2, gap: 18},

  companyRow: {flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: -2},
  companyText: {fontFamily: D.fSans, fontSize: 12.5, color: D.textDim, letterSpacing: -0.05},

  // stat strip
  statPill: {
    flex: 1, paddingVertical: 14, paddingHorizontal: 12, borderRadius: 16, alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.022)', borderWidth: 1, borderColor: D.hair,
  },
  statValue: {fontFamily: D.fBold, fontSize: 26, letterSpacing: -0.6, lineHeight: 28},
  statLabel: {fontFamily: D.fSemi, fontSize: 8.5, letterSpacing: 1.3, color: D.textMute, marginTop: 7},

  sectionLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.5, color: D.textMute, marginLeft: 2},

  error: {color: D.alert, fontSize: 12, textAlign: 'center', marginTop: 28, fontFamily: D.fSans},

  // empty state
  emptyCard: {
    borderRadius: 24, paddingTop: 30, paddingHorizontal: 22, paddingBottom: 24, marginTop: -6,
    borderWidth: 1, borderColor: D.hair2, overflow: 'hidden',
  },
  emptyIconTile: {
    width: 72, height: 72, borderRadius: 22,
    backgroundColor: 'rgba(91,141,239,0.16)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
    alignItems: 'center', justifyContent: 'center',
    shadowColor: D.accent, shadowOpacity: 0.22, shadowRadius: 18, shadowOffset: {width: 0, height: 14},
    elevation: 8,
  },
  plusBadge: {
    position: 'absolute', right: -6, bottom: -6, width: 26, height: 26, borderRadius: 13,
    borderWidth: 2, borderColor: '#0A0D12', alignItems: 'center', justifyContent: 'center',
  },
  emptyTitle: {
    fontFamily: D.fBold, fontSize: 19, letterSpacing: -0.3, color: D.text,
    textAlign: 'center', marginTop: 18,
  },
  emptySub: {
    fontFamily: D.fSans, fontSize: 13, color: D.textDim, lineHeight: 19,
    textAlign: 'center', marginTop: 7, maxWidth: 260, alignSelf: 'center',
  },
  previewLabel: {fontFamily: D.fSemi, fontSize: 8, letterSpacing: 1.4, color: D.textFaint, marginTop: 22, marginBottom: 8},

  // skeleton preview rows
  skelRow: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.015)',
    borderWidth: 1, borderColor: D.hair2, borderStyle: 'dashed',
  },
  skelAvatar: {
    width: 42, height: 42, borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.05)', borderWidth: 1, borderColor: D.hair,
  },
  skelBar: {borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.06)'},
  skelPill: {width: 56, height: 22, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: D.hair},

  // benefits
  benefitRow: {flexDirection: 'row', alignItems: 'flex-start', gap: 13},
  benefitIcon: {
    width: 36, height: 36, borderRadius: 11,
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
    alignItems: 'center', justifyContent: 'center',
  },
  benefitTitle: {fontFamily: D.fBold, fontSize: 13.5, letterSpacing: -0.2, color: D.text},
  benefitSub: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 2, lineHeight: 15.5},

  // populated rows (preview-row blueprint, solid)
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: 13,
    paddingVertical: 13, paddingHorizontal: 14, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2,
  },
  memberAvatar: {
    width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  memberInitials: {fontFamily: D.fBold, fontSize: 13, color: D.accentSoft, letterSpacing: 0.5},
  nameRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  memberName: {flexShrink: 1, fontFamily: D.fBold, fontSize: 14, color: D.text, letterSpacing: -0.2},
  roleBadge: {
    paddingHorizontal: 7, paddingVertical: 2, borderRadius: 5,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)',
  },
  roleBadgeText: {fontFamily: D.fBold, fontSize: 8, letterSpacing: 1, color: D.accentSoft},
  memberMeta: {fontFamily: D.fSans, fontSize: 11.5, color: D.textMute, marginTop: 2},
  // A suspended officer must be legible as such at a glance, not only via the pill.
  memberRowSuspended: {opacity: 0.55, borderLeftWidth: 2, borderLeftColor: D.amber},
  suspendMeta: {fontFamily: D.fMono, fontSize: 10, color: D.amber, marginTop: 3, letterSpacing: 0.3},
  memberPill: {paddingHorizontal: 10, paddingVertical: 5, borderRadius: 999, borderWidth: 1},
  memberPillText: {fontFamily: D.fBold, fontSize: 9, letterSpacing: 1},
  // F11/LM-A6 additions
  dutyBadge: {position: 'absolute', right: -1, bottom: -1, width: 11, height: 11, borderRadius: 6,
    borderWidth: 2, borderColor: D.bg},
  deployedBadge: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 999,
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.34)'},
  deployedBadgeText: {fontFamily: D.fBold, fontSize: 7.5, letterSpacing: 0.8, color: D.accentSoft},

  // CTA
  cta: {
    height: 58, borderRadius: 18, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 11,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)',
    shadowColor: D.accent, shadowOpacity: 0.45, shadowRadius: 19, shadowOffset: {width: 0, height: 8},
    elevation: 10,
  },
  ctaText: {fontFamily: D.fBold, fontSize: 16, letterSpacing: 0.3, color: '#fff'},
}));
