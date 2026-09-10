/**
 * DepartmentalHomeScreen (Dept Chat v2 — Step 19, PDF p.3) — the Home tab of the
 * dedicated Departmental module. ONE component, two variants branched on the
 * canonical `isManager` (mirrors DepartmentChannelsScreen):
 *   · member  → welcome, secure/device-trust cue, today's attendance status, and
 *               quick actions that deep-link into the Attend / Incident / Channels
 *               / Vault tabs.
 *   · manager → the above PLUS role-gated alert tiles — Pending Review count and
 *               Open Incidents count — each deep-linking to the manager root of
 *               the relevant tab.
 * No incident details ever render in the member preview (PDF p.3). Authorization
 * stays server-side; the role-branch only chooses what to surface first.
 */
import React, {useCallback, useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, TouchableOpacity, type ImageSourcePropType} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {BottomTabNavigationProp} from '@react-navigation/bottom-tabs';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import {useActiveWorkspace, contextManagerRole} from '@store/activeWorkspace';
import {attendanceApi, incidentApi, type ShiftSessionDto, type ShiftDto, enterpriseApi, orgApi} from '@services/api';
import type {DepartmentalTabParamList} from '@navigation/types';
import {findNavigatorWithRoute, openJoinFlowScreen} from '@navigation/departmentalEntry';
import {Imagery} from '@theme/imagery';
import ImageryBackdrop from '@components/ui/ImageryBackdrop';
import {OB, Card, SectionLabel, attendanceStatusMeta} from './_obsidian';
import {moduleVisible, hiddenModulesFor, type WorkspaceSettings} from './hiddenModules';
import {ModuleVisibilitySheet} from './ModuleVisibilitySheet';

type IconName = React.ComponentProps<typeof Icon>['name'];
type Nav = BottomTabNavigationProp<DepartmentalTabParamList>;

const isToday = (iso?: string | null): boolean => {
  if (!iso) {return false;}
  const d = new Date(iso);
  const n = new Date();
  return d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate();
};

export default function DepartmentalHomeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const user = useAuthStore(s => s.user);
  // Prefer the server-resolved is_org_manager flag (mirrors OrgManagerGuard);
  // fall back to the account_kind heuristic for a pre-flag cached session.
  const activeWs = useActiveWorkspace(st => st.workspace);
  // Phase B — a hub-selected context decides via the ONE shared predicate
  // (contextManagerRole — see its guard-mirroring rationale); otherwise the
  // global flags, exactly as before (mirrors DepartmentalNavigator).
  const ctxManager = contextManagerRole(activeWs, user?.owns_workspace === true);
  const isManager = ctxManager !== null
    ? ctxManager
    : !!user && (user.is_org_manager ?? (user.role === 'service_provider' || user.account_kind === 'agency'));

  const [shifts, setShifts] = useState<ShiftSessionDto[]>([]);
  const [todayShift, setTodayShift] = useState<ShiftDto | null>(null);
  const [pendingReview, setPendingReview] = useState(0);
  const [pendingApprovals, setPendingApprovals] = useState(0);
  const [openIncidents, setOpenIncidents] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const [wsSettings, setWsSettings] = useState<WorkspaceSettings | null>(null);
  // Keyed on the org the RESPONSE names, not the one the request asked with.
  const modules = hiddenModulesFor(wsSettings, activeWs?.org_id);
  const showAttendance = moduleVisible(modules, 'attendance');
  const showIncidents = moduleVisible(modules, 'incidents');
  const [modulesOpen, setModulesOpen] = useState(false);

  const load = useCallback(async () => {
    /**
     * FIRST, and NOT awaited.
     *
     * As the last of six sequential awaits this arrived ~1.8s in, so a
     * workspace that hides both modules rendered them, then removed them and
     * reflowed the grid under the user's thumb. Fail-open is the right
     * DIRECTION; the flash was just the request being queued behind five
     * others it does not depend on. The directory already fires it this way.
     */
    void orgApi.workspaceSettings()
      .then(res => setWsSettings(res.data))
      .catch(() => { /* keep what we had — everything stays visible */ });
    // NAV-21 (2026-08-26 audit) — PARALLEL, not sequential. These awaits do
    // not depend on one another; strung out they took ~1.8 s and painted five
    // staggered render passes after EVERY focus (this screen is the
    // backBehavior="firstRoute" target, so every module back lands here).
    // Each request keeps its own catch so a failure leaves the prior value.
    const tasks: Array<Promise<void>> = [
      attendanceApi.myShifts().then(({data}) => setShifts(data)).catch(() => { /* none */ }),
      attendanceApi.myTodayShift().then(({data}) => setTodayShift(data ?? null)).catch(() => { /* flag off / none */ }),
    ];
    if (isManager) {
      tasks.push(
        attendanceApi.orgSummary().then(({data}) => setPendingReview(data.pendingReview)).catch(() => { /* none */ }),
        incidentApi.queue().then(({data}) =>
          setOpenIncidents(data.filter(i => i.status !== 'closed' && i.status !== 'resolved').length),
        ).catch(() => { /* none */ }),
        // A6 — the pending-approvals badge.
        enterpriseApi.listJoinRequests().then(({data}) => setPendingApprovals((data.requests ?? []).length)).catch(() => { /* none */ }),
      );
    }
    await Promise.all(tasks);
    setRefreshing(false);
  }, [isManager]);

  // NAV-21 — one live run at a time; rapid back/forward re-focuses used to
  // stack concurrent full reloads whose setStates all landed post-transition.
  const loadInFlightRef = useRef(false);
  useFocusEffect(useCallback(() => {
    if (loadInFlightRef.current) {return;}
    loadInFlightRef.current = true;
    void load().finally(() => { loadInFlightRef.current = false; });
  }, [load]));

  const name = (user?.full_name ?? user?.email ?? 'there').split(' ')[0];
  // Phase B — the hub-selected workspace names the surface; primary org
  // otherwise (today's behaviour).
  const orgName = activeWs?.name ?? user?.org?.name ?? 'your organisation';
  // Render-time probe (pure getState reads) so the row is tappable only where
  // a hub door actually exists — never a silent no-op.
  const hubNav = findNavigatorWithRoute(navigation, 'WorkspaceHub');

  // Member "today" chip — mirrors AttendanceScreen's derivation.
  const openShift = shifts.find(s => s.status === 'open') ?? null;
  const todaySession = shifts.find(s => isToday(s.clock_in_at)) ?? null;
  const today = openShift
    ? {label: 'On shift', color: OB.signal, icon: 'shield-check' as IconName}
    : todaySession?.attendance_status
      ? {...attendanceStatusMeta(todaySession.attendance_status)}
      : todayShift
        ? {label: 'Not checked in', color: OB.amber, icon: 'shield-alert-outline' as IconName}
        : {label: 'No shift today', color: OB.textMute, icon: 'shield-outline' as IconName};

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />

      {/* Header — exit returns to the host shell (CPO tabs / Agent dashboard). */}
      <View style={s.header}>
        <TouchableOpacity
          style={s.exit}
          onPress={() => navigation.getParent()?.goBack()}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>
        <Text style={s.headerTitle}>Channels</Text>
        <View style={{width: 36}} />
      </View>

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 28}}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => { setRefreshing(true); void load(); }}
            tintColor={OB.accentSoft}
          />
        }>

        {/* Welcome */}
        <Text style={s.welcome}>Welcome, {name}</Text>
        {/* F-WSHUB — the workspace name is the door to the Workspace Hub. The
            hub route lives on MessengerNavigator, an ANCESTOR of this shell in
            the client tree only — resolved first, and the Agent/CPO-hosted
            shells (no hub route anywhere above) keep the plain label rather
            than a dead tap. */}
        {hubNav ? (
          <TouchableOpacity
            onPress={() => (hubNav as {navigate: (name: string) => void}).navigate('WorkspaceHub')}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Open Workspaces"
            hitSlop={{top: 6, bottom: 6, left: 6, right: 6}}>
            <View style={s.orgRow}>
              <Text style={s.org}>{orgName} · Workspace</Text>
              <Icon name="chevron-right" size={14} color={OB.textMute} style={{marginTop: 3}} />
            </View>
          </TouchableOpacity>
        ) : (
          <Text style={s.org}>{orgName} · Workspace</Text>
        )}

        {/* Secure / device-trust indicator (E2EE is always on). */}
        <Card style={s.secureCard} img={Imagery.deptSecureConnection} imgVariant="art">
          <View style={s.secureIcon}>
            <Icon name="shield-lock" size={18} color={OB.signal} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.secureTitle}>Secure connection</Text>
            <Text style={s.secureSub}>End-to-end encrypted · device trusted</Text>
          </View>
          <View style={s.secureDot} />
        </Card>

        {/* Client review vs2 item 10 — no Broadcast/Announcements card here.
            Broadcasts belong inside Channels; this dashboard is operational
            actions only. */}

        {/* Member: today's attendance status. */}
        {!isManager && showAttendance && (
          <Card style={s.statusCard} onPress={() => navigation.navigate('Attend')}>
            <View style={[s.statusIcon, {borderColor: today.color + '66', backgroundColor: today.color + '14'}]}>
              <Icon name={today.icon} size={22} color={today.color} />
            </View>
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.statusLabel}>Today's attendance</Text>
              <Text style={[s.statusValue, {color: today.color}]}>{today.label}</Text>
            </View>
            <Icon name="chevron-right" size={18} color={OB.textMute} />
          </Card>
        )}

        {/* Manager: role-gated alert tiles.
            vs2 item 17b — each tile follows its own module, and the whole
            section goes when both are hidden: a "NEEDS ATTENTION" header over
            an empty row is worse than no header. */}
        {isManager && (showAttendance || showIncidents) && (
          <>
            <SectionLabel style={s.sectionGap}>NEEDS ATTENTION</SectionLabel>
            <View style={s.tileRow}>
              {showAttendance && (
                <AlertTile
                  icon="clipboard-check-outline"
                  count={pendingReview}
                  label="Pending review"
                  tint={OB.amber}
                  onPress={() => navigation.navigate('Attend')}
                />
              )}
              {showIncidents && (
                <AlertTile
                  icon="alert-decagram-outline"
                  count={openIncidents}
                  label="Open incidents"
                  tint={OB.alert}
                  // item 09 — this tile counts QUEUE items, so it must open the
                  // queue by name. The Incident tab now roots at the report
                  // screen, and a bare navigate would land a manager who tapped
                  // "3 open incidents" on a blank category grid.
                  onPress={() => navigation.navigate('Incident', {screen: 'IncidentQueue', initial: false})}
                />
              )}
            </View>
          </>
        )}

        {/* Quick actions — deep-link into the tabs. */}
        <SectionLabel style={s.sectionGap}>QUICK ACTIONS</SectionLabel>
        <View style={s.grid}>
          {showAttendance && (
          <ActionCard
              icon="calendar-check"
              title={isManager ? 'Attendance' : 'My attendance'}
              sub={isManager ? 'Review & approve' : 'Check in & history'}
              img={Imagery.deptAttendance}
              onPress={() => navigation.navigate('Attend')}
            />
          )}
          {showIncidents && (
          <ActionCard
              icon={isManager ? 'alert-decagram-outline' : 'alert-octagon-outline'}
              title="Report incident"
              sub={isManager ? 'Log one, or review the queue' : 'Log an incident'}
              img={Imagery.deptIncident}
              onPress={() => {
                // The member card must LAND on the wizard, so it names it.
                //
                // A bare navigate re-enters a stack wherever it was left, and the
                // Done button now deliberately leaves it on My Reports — so "Log
                // an incident" would have opened the reports list instead.
                // `initial: false` stays even though the grid IS the member's
                // initial route (so R10-1's re-rooting cannot bite here): the
                // rule is repo-wide and enforced by a scan, and carving out a
                // "provably inert" exception is how blanket invariants rot.
                // item 09 — BOTH roles land on the wizard now. A bare navigate
                // re-enters a persistent stack wherever it was left, so naming
                // the screen is what makes "opens directly to logging" true on
                // the second visit as well as the first. The manager's queue is
                // reached from the "Review incidents" row on that screen and
                // from the Open-incidents tile above.
                navigation.navigate('Incident', {screen: 'ReportIncidentCategory', initial: false});
              }}
            />
          )}
          <ActionCard
            icon="forum-outline"
            title="Channels"
            sub="Secure team comms"
            img={Imagery.deptChannels}
            onPress={() => navigation.navigate('Channels')}
          />
          <ActionCard
            icon="shield-lock-outline"
            title="Vault"
            sub="Files · MFA protected"
            img={Imagery.messengerVault}
            onPress={() => navigation.navigate('Vault')}
          />
          {/* vs2 item 17b — the admin's own control over the two cards above.
              Manager-only, and last in the grid so it never displaces work.

              The sheet writes the WHOLE hidden set, and the server re-checks
              manager rights: this card being absent is presentation, exactly
              like the modules it toggles. */}
          {isManager && (
            <ActionCard
              icon="tune-variant"
              title="Modules"
              sub="Show or hide on Home"
              onPress={() => setModulesOpen(true)}
            />
          )}
          {/* A6 mockup — "Approval requests" card with a pending badge, listed
              as "Pending approvals badge". This is also the ONLY entry point to
              the A11 inbox: without it the whole join → approve loop was
              built but unreachable.

              Routed through the shared openJoinFlowScreen resolver, never a
              bare navigate('Approvals'): this screen is mounted in more than
              one shell, so a hard-coded navigate is silently DROPPED in the
              others (Issues 18/19). The raw finder is not enough here either —
              see the note on the handler. */}
          {isManager && (
            <ActionCard
              icon="account-clock-outline"
              title="Approvals"
              sub={pendingApprovals > 0
                ? `${pendingApprovals} waiting to join`
                : 'Join requests'}
              img={Imagery.deptApprovals}
              badge={pendingApprovals > 0 ? pendingApprovals : undefined}
              onPress={() => {
                // This is the Home TAB, so inside the workspace Approvals sits
                // on the SIBLING Channels stack, which findNavigatorWithRoute
                // cannot see (it walks UP only) — the old version therefore
                // fell through to "not available here yet" for every admin, on
                // the very screen that shows their pending badge. The resolver
                // picks per host: tab hop inside the shell, direct where this
                // screen is hosted by MessengerNavigator.
                openJoinFlowScreen(navigation, 'Approvals');
              }}
            />
          )}
        </View>
      </ScrollView>
      <ModuleVisibilitySheet
        visible={modulesOpen}
        onClose={() => setModulesOpen(false)}
        onSaved={next => setWsSettings(next)}
      />
    </View>
  );
}

function AlertTile({icon, count, label, tint, onPress}: {
  icon: IconName; count: number; label: string; tint: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={s.tile} activeOpacity={0.85} onPress={onPress}>
      <View style={s.tileTop}>
        <Icon name={icon} size={18} color={tint} />
        <Text style={[s.tileCount, {color: count > 0 ? tint : OB.textMute}]}>{count}</Text>
      </View>
      <Text style={s.tileLabel}>{label}</Text>
    </TouchableOpacity>
  );
}

function ActionCard({icon, title, sub, onPress, badge, img}: {
  icon: IconName; title: string; sub: string; onPress: () => void; badge?: number;
  img?: ImageSourcePropType;
}) {
  return (
    <TouchableOpacity style={s.action} activeOpacity={0.85} onPress={onPress}>
      {/* `card`, NOT `art`. The art scrim is a HORIZONTAL ramp (obsidian at the
          left edge, clear at the right), which only protects copy that stays
          inside that left field — true for the plated dashboard ROWS. Here the
          title and description span the full card width, so their right half
          landed on the bright part of the photo and went unreadable on device
          (founder screenshot 2026-08-31). `card` ramps along the bottom-left
          diagonal, under the copy, with a pinned 0.82 floor. */}
      {!!img && <ImageryBackdrop source={img} variant="card" radius={16} />}
      <View style={s.actionIcon}>
        {/* A6 mockup renders a red count on the approvals card. */}
        {badge ? (
          <View style={s.actionBadge}>
            <Text style={s.actionBadgeText}>{badge > 99 ? '99+' : String(badge)}</Text>
          </View>
        ) : null}
        <Icon name={icon} size={20} color={OB.accentSoft} />
      </View>
      <Text style={s.actionTitle}>{title}</Text>
      <Text style={s.actionSub} numberOfLines={1}>{sub}</Text>
    </TouchableOpacity>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},

  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 6, gap: 10,
  },
  exit: {
    width: 36, height: 36, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  headerTitle: {flex: 1, textAlign: 'center', color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 15, letterSpacing: 0.4},

  welcome: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 24, letterSpacing: -0.5, marginTop: 12},
  org: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13, marginTop: 3},
  orgRow: {flexDirection: 'row', alignItems: 'center', gap: 3, alignSelf: 'flex-start'},

  secureCard: {flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 18},
  secureIcon: {
    width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(74,222,128,0.10)', borderWidth: 1, borderColor: 'rgba(74,222,128,0.32)',
  },
  secureTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  secureSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5, marginTop: 2},
  secureDot: {width: 9, height: 9, borderRadius: 5, backgroundColor: OB.signal},

  statusCard: {flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 12},
  statusIcon: {width: 48, height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', borderWidth: 1},
  statusLabel: {color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 10, letterSpacing: 1.2, textTransform: 'uppercase'},
  statusValue: {fontFamily: BravoFont.bold, fontSize: 17, marginTop: 3, letterSpacing: -0.2},

  // `sectionHeader` carries a marginBottom but no marginTop, so a label sat
  // flush under the card above it. Scoped here rather than added to the shared
  // style: ~10 other deptchat screens already hand-roll their own spacer View
  // before a SectionLabel, and a global marginTop would double up there.
  sectionGap: {marginTop: 20},

  tileRow: {flexDirection: 'row', gap: 12},
  tile: {
    flex: 1, borderRadius: 16, padding: 15, gap: 10,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
  },
  tileTop: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  tileCount: {fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5},
  tileLabel: {color: OB.textDim, fontFamily: BravoFont.semiBold, fontSize: 12.5},

  grid: {flexDirection: 'row', flexWrap: 'wrap', gap: 12},
  action: {
    width: '47.5%', flexGrow: 1, borderRadius: 16, padding: 15, gap: 7,
    backgroundColor: OB.card, borderWidth: 1, borderColor: OB.hair,
    // The brand backdrop is an absoluteFill child, so the card has to clip it.
    overflow: 'hidden',
  },
  actionBadge: {position:'absolute', top:-4, right:-4, minWidth:18, height:18, borderRadius:9, paddingHorizontal:4, alignItems:'center', justifyContent:'center', backgroundColor:OB.alert, zIndex:2},
  actionBadgeText: {color:'#1A0A0D', fontSize:10, fontWeight:'800'},
  actionIcon: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)',
  },
  actionTitle: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14, marginTop: 3},
  actionSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11.5},
}));
