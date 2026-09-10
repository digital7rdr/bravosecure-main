/**
 * DepartmentalNavigator (Dept Chat v2 — Step 19) — the dedicated "Departmental"
 * 5-tab module from the PDF Product Map (Home · Channels · Attend · Incident ·
 * Vault). ONE shell, opened by BOTH parties: a managed CPO/member (pushed from
 * CpoNavigator) and a service-provider company/manager (pushed from
 * AgentNavigator). Only each tab's ROOT screen differs by role; authorization is
 * still decided server-side — this only picks which already-guarded screen shows
 * first. Pushed as a FULL-SCREEN route so its own obsidian footer is the only
 * one on screen (no nested-tab double footer). Every feature screen (PDF p.4–15)
 * is reused verbatim from Steps 12–18 — nothing is rebuilt here.
 */
import React from 'react';
import {createBottomTabNavigator} from '@react-navigation/bottom-tabs';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {useAuthStore} from '@store/authStore';
import {useNavigation, useIsFocused} from '@react-navigation/native';
import {findNavigatorWithRoute, navigateVia, type ResolvableNavigation} from './departmentalEntry';
import {useActiveWorkspace, contextManagerRole} from '@store/activeWorkspace';
import {View, Text, StyleSheet, TouchableOpacity} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {OB} from '@screens/deptchat/_obsidian';
import {ObsidianTabBar, type ObsidianTabIcon} from './ObsidianTabBar';
import {navigateToMessengerScreen} from './messengerDeepLink';
import type {
  DepartmentalTabParamList,
  DeptChannelsStackParamList,
  DeptAttendStackParamList,
  DeptIncidentStackParamList,
  DeptVaultStackParamList,
} from './types';

// Home (NEW, Step 19) + reused feature screens.
import NewsNavigator from './NewsNavigator';
import DepartmentalHomeScreen from '@screens/deptchat/DepartmentalHomeScreen';
import DepartmentChannelsScreen from '@screens/messenger/DepartmentChannelsScreen';
import DepartmentChatScreen from '@screens/messenger/DepartmentChatScreen';
import ManageChannelsScreen from '@screens/deptchat/ManageChannelsScreen';
import EmployeesScreen from '@screens/deptchat/EmployeesScreen';
import ChannelEditorScreen from '@screens/deptchat/ChannelEditorScreen';
import ChannelMembersScreen from '@screens/deptchat/ChannelMembersScreen';
import ApprovalsScreen from '@screens/deptchat/ApprovalsScreen';
import JoinWorkspaceScreen from '@screens/deptchat/JoinWorkspaceScreen';
import EnterpriseSetupScreen from '@screens/deptchat/EnterpriseSetupScreen';
import CreateWorkspaceScreen from '@screens/deptchat/CreateWorkspaceScreen';
import ApprovalStatusScreen from '@screens/deptchat/ApprovalStatusScreen';
import InviteMemberScreen from '@screens/deptchat/InviteMemberScreen';
import AttendanceScreen from '@screens/agent/AttendanceScreen';
import VerifyAttendanceScreen from '@screens/deptchat/VerifyAttendanceScreen';
import AttendanceResultScreen from '@screens/deptchat/AttendanceResultScreen';
import MyAttendanceScreen from '@screens/deptchat/MyAttendanceScreen';
import AdminAttendanceScreen from '@screens/deptchat/AdminAttendanceScreen';
import ShiftManagementScreen from '@screens/deptchat/ShiftManagementScreen';
import ShiftEditorScreen from '@screens/deptchat/ShiftEditorScreen';
import DayStatusScreen from '@screens/deptchat/DayStatusScreen';
import MonthlyRosterScreen from '@screens/deptchat/MonthlyRosterScreen';
import CorrectionsScreen from '@screens/deptchat/CorrectionsScreen';
import ReportIncidentCategoryScreen from '@screens/deptchat/ReportIncidentCategoryScreen';
import ReportIncidentDetailsScreen from '@screens/deptchat/ReportIncidentDetailsScreen';
import IncidentSubmittedScreen from '@screens/deptchat/IncidentSubmittedScreen';
import IncidentQueueScreen from '@screens/deptchat/IncidentQueueScreen';
import IncidentDetailScreen from '@screens/deptchat/IncidentDetailScreen';
import MyIncidentsScreen from '@screens/deptchat/MyIncidentsScreen';
import MyIncidentDetailScreen from '@screens/deptchat/MyIncidentDetailScreen';
import FilesScreen from '@screens/messenger/FilesScreen';
import VaultScreen from '@screens/messenger/VaultScreen';
import VaultLockScreen from '@screens/messenger/VaultLockScreen';
import VaultNewPinScreen from '@screens/messenger/VaultNewPinScreen';
import VaultForgotScreen from '@screens/messenger/VaultForgotScreen';
import VaultOTPVerifyScreen from '@screens/messenger/VaultOTPVerifyScreen';
import FileVaultPurchaseScreen from '@screens/messenger/FileVaultPurchaseScreen';
import MessengerSettingsScreen from '@screens/messenger/MessengerSettingsScreen';
import BackupSetupScreen from '@screens/messenger/BackupSetupScreen';

// Role resolution — prefers the server-resolved `is_org_manager` flag from
// /auth/me, which mirrors OrgManagerGuard exactly (company account OR an active
// org_members manager). This fixes the under-privilege case where a user who is
// a CPO of one org but a manager of another resolved to account_kind='cpo' and
// was shown the member surface. Falls back to the account_kind heuristic for a
// session cached before /auth/me carried the flag. The branch only chooses each
// tab's first screen; the server guards still decide.
//
// Phase B — when the Workspace Hub set an explicit context, ITS role decides
// via the ONE shared predicate (contextManagerRole — see its guard-mirroring
// rationale): an owner browsing a workspace they joined must get the member
// UI, or their manager chrome would point at their OWN org's data inside the
// other workspace. No context (every non-hub entry) = the global flags,
// exactly as before.
function useIsManager(): boolean {
  const user = useAuthStore(s => s.user);
  const active = useActiveWorkspace(s => s.workspace);
  if (!user) {return false;}
  const fromContext = contextManagerRole(active, user.owns_workspace === true);
  if (fromContext !== null) {return fromContext;}
  return user.is_org_manager ?? (user.role === 'service_provider' || user.account_kind === 'agency');
}

// NAV-23 (2026-08-26 audit) — freezeOnBlur: see the stack navigators.
const stackOpts = {headerShown: false as const, freezeOnBlur: true, contentStyle: {backgroundColor: OB.bg}};

// Icon map for the shared ObsidianTabBar — the SAME renderer the root app
// shell and CpoNavigator use, so this bar is pixel-identical to those.
const TAB_ICONS: Record<string, ObsidianTabIcon> = {
  Home:     {default: 'home-outline',            active: 'home',            label: 'Home'},
  // UI corrections 2026-08-15 item 07 — the mockup draws Channels as a hash.
  Channels: {default: 'pound-box-outline',        active: 'pound-box',       label: 'Channels'},
  Attend:   {default: 'calendar-check-outline',   active: 'calendar-check',  label: 'Attend'},
  Incident: {default: 'alert-octagon-outline',    active: 'alert-octagon',   label: 'Incident'},
  Vault:    {default: 'shield-lock-outline',      active: 'shield-lock',     label: 'Vault'},
  Messenger: {default: 'message-outline',         active: 'message',         label: 'Messenger'},
  // item 07 — MISSING THIS KEY IS SILENT: ObsidianTabBar falls back to
  // 'help-circle-outline' plus the raw route name, so the tab renders as a
  // question mark labelled "News" and nothing fails.
  News:     {default: 'newspaper-variant-outline', active: 'newspaper-variant', label: 'News'},
};

// ─── Channels tab (reused Step 12/18 screens) ────────────────────────────────
const ChannelsStack = createNativeStackNavigator<DeptChannelsStackParamList>();
function ChannelsTab() {
  return (
    <ChannelsStack.Navigator screenOptions={stackOpts}>
      <ChannelsStack.Screen name="DepartmentChannels" component={DepartmentChannelsScreen} />
      {/* getId keyed by channel — see the MessengerNavigator registration for
          why. Both shells mount this route, so a fix on one is half a fix. */}
      <ChannelsStack.Screen
        name="DepartmentChat"
        component={DepartmentChatScreen}
        getId={({params}) => (params as {channelId?: string} | undefined)?.channelId}
      />
      <ChannelsStack.Screen name="ManageChannels" component={ManageChannelsScreen} />
      {/* UI corrections 2026-08-15 items 03/06 RETIRED OrgChannelTree.
          "Every hierarchy level must be collapsible/expandable" is one screen
          with dropdowns, not a drill-down, so DepartmentChannelsScreen now
          renders the whole tree inline and nothing navigates here any more.
          Verified before removal: no MessengerTarget union or route set in
          messengerDeepLink referenced it, so no push or ActivityCenter row can
          land on it. */}
      {/* F11 — `Employees` was registered ONLY in MessengerNavigator, and this
          workspace stack does not sit under it. DepartmentChannelsScreen
          (registered on BOTH this stack and MessengerNavigator) calls
          `navigation.navigate('Employees')` from its empty-state "add your team"
          CTA, so entering the workspace by a route that is NOT under
          MessengerNavigator left the ancestor walk with no such route: the
          action bubbled to the root and was DROPPED — silently, in release.
          That is AgentNavigator (which mounts `Departmental` and no
          MessengerNavigator at all) and the CPO shell's own root `Departmental`
          route. Note CpoNavigator DOES mount MessengerNavigator as its
          `CpoComms` tab — so the CPO break was per-entry-path, not per-shell;
          the earlier "neither shell mounts it" reading was wrong.
          Same class as Issues 18/19: a screen in N shells, its target in one.
          Registered HERE, beside ManageChannels/ChannelEditor/ChannelMembers —
          the siblings that same screen also opens — so every tree that hosts the
          directory hosts its doors. */}
      <ChannelsStack.Screen name="Employees" component={EmployeesScreen} />
      <ChannelsStack.Screen name="ChannelEditor" component={ChannelEditorScreen} />
      <ChannelsStack.Screen name="ChannelMembers" component={ChannelMembersScreen} />
      <ChannelsStack.Screen name="Approvals" component={ApprovalsScreen} />
      <ChannelsStack.Screen name="JoinWorkspace" component={JoinWorkspaceScreen} />
      {/* A4/M4 + A5 — registered on the SAME stack as JoinWorkspace, its
          sibling in the fork. Registering the fork somewhere JoinWorkspace is
          not would make one arm reachable and the other silently dropped. */}
      <ChannelsStack.Screen name="EnterpriseSetup" component={EnterpriseSetupScreen} />
      <ChannelsStack.Screen name="CreateWorkspace" component={CreateWorkspaceScreen} />
      <ChannelsStack.Screen name="ApprovalStatus" component={ApprovalStatusScreen} />
      {/* Item E — dual-mounted beside its callers (Approvals + ChannelMembers),
          same rule as every sibling above: registered where the tap happens. */}
      <ChannelsStack.Screen name="InviteMember" component={InviteMemberScreen} />
    </ChannelsStack.Navigator>
  );
}

// ─── Attend tab — role-branched root (member: Attendance / manager: Admin) ────
const AttendStack = createNativeStackNavigator<DeptAttendStackParamList>();
function AttendTab() {
  const isManager = useIsManager();
  return (
    <AttendStack.Navigator
      initialRouteName={isManager ? 'AdminAttendance' : 'Attendance'}
      screenOptions={stackOpts}>
      <AttendStack.Screen name="Attendance" component={AttendanceScreen} />
      <AttendStack.Screen name="VerifyAttendance" component={VerifyAttendanceScreen} />
      <AttendStack.Screen name="AttendanceResult" component={AttendanceResultScreen} options={{gestureEnabled: false}} />
      <AttendStack.Screen name="MyAttendance" component={MyAttendanceScreen} />
      <AttendStack.Screen name="AdminAttendance" component={AdminAttendanceScreen} />
      <AttendStack.Screen name="ShiftManagement" component={ShiftManagementScreen} />
      <AttendStack.Screen name="ShiftEditor" component={ShiftEditorScreen} />
      <AttendStack.Screen name="DayStatus" component={DayStatusScreen} />
      <AttendStack.Screen name="MonthlyRoster" component={MonthlyRosterScreen} />
      <AttendStack.Screen name="Corrections" component={CorrectionsScreen} />
    </AttendStack.Navigator>
  );
}

// ─── Incident tab — ONE root for both roles (item 09: log, don't queue) ──────
//
// The role branch is gone deliberately. It used to send a manager to the queue,
// which is the screen the client review crossed out: "This screen is not
// relevant, as the very next screen allows you to log your incidents."
// `useIsManager` is still used by AttendTab, whose roots DO legitimately differ.
const IncidentStack = createNativeStackNavigator<DeptIncidentStackParamList>();
function IncidentTab() {
  return (
    <IncidentStack.Navigator
      /**
       * UI corrections 2026-08-15 item 09 — "This screen is not relevant, as the
       * very next screen allows you to log your incidents. So please remove this
       * screen." Opening Incident Reporting now lands on the LOGGING screen for
       * BOTH roles; the manager's queue is one deliberate tap away instead of
       * being the thing in the way.
       *
       * ⚠️ THE ROUTE STAYS REGISTERED. IncidentQueue is a push-notification and
       * ActivityCenter deep-link target (messengerDeepLink's DEPT_INCIDENT_ROUTES),
       * so unregistering it would silently drop those wakes — the B-414 class.
       * Only the DEFAULT changes.
       *
       * ⚠️ AND initialRouteName ONLY DECIDES THE COLD ROOT. This is a persistent
       * tab stack, so the second and later visits resume wherever it was left.
       * That is why every Home/quick-link door below names the report screen
       * explicitly rather than relying on this line.
       */
      initialRouteName="ReportIncidentCategory"
      screenOptions={stackOpts}>
      {/* Client review vs2 item 15 — "this should be the first Dashboard you
          see when you enter Incident Report". The member root is the category
          grid; My Reports stays one tap away from its header. Manager root is
          unchanged: Queue → Detail. */}
      <IncidentStack.Screen name="MyIncidents" component={MyIncidentsScreen} />
      <IncidentStack.Screen name="MyIncidentDetail" component={MyIncidentDetailScreen} />
      <IncidentStack.Screen name="ReportIncidentCategory" component={ReportIncidentCategoryScreen} />
      <IncidentStack.Screen name="ReportIncidentDetails" component={ReportIncidentDetailsScreen} />
      <IncidentStack.Screen name="IncidentSubmitted" component={IncidentSubmittedScreen} options={{gestureEnabled: false}} />
      <IncidentStack.Screen name="IncidentQueue" component={IncidentQueueScreen} />
      <IncidentStack.Screen name="IncidentDetail" component={IncidentDetailScreen} />
    </IncidentStack.Navigator>
  );
}

// ─── Vault tab — reuses the messenger vault flow + File-Vault MFA gate ────────
const VaultStack = createNativeStackNavigator<DeptVaultStackParamList>();
function VaultTab() {
  return (
    <VaultStack.Navigator screenOptions={stackOpts}>
      {/* Why: VaultLockScreen's hardware-back resets to a route literally named
          'MessengerHome' (its anti-leak exit). Naming the vault tab's root that
          routes the reset back to the Files landing instead of erroring, keeping
          the File-Vault MFA gate's exit behaviour intact inside this shell. */}
      <VaultStack.Screen name="MessengerHome" component={FilesScreen} />
      <VaultStack.Screen name="VaultLock" component={VaultLockScreen} />
      <VaultStack.Screen name="VaultScreen" component={VaultScreen} />
      <VaultStack.Screen name="VaultNewPin" component={VaultNewPinScreen} />
      <VaultStack.Screen name="VaultForgot" component={VaultForgotScreen} />
      <VaultStack.Screen name="VaultOTPVerify" component={VaultOTPVerifyScreen} />
      <VaultStack.Screen name="FileVaultPurchase" component={FileVaultPurchaseScreen} />
      {/* This tab mounts VaultLock/VaultNewPin, so the biometric consent prompt
          fires inside it — and that prompt now promises a Settings off-ramp.
          The promise has to be true HERE, not only in the personal shell.
          BackupSetup rides along for the Settings pane's Chat Backup row (W1b);
          BackupSetupScreen's own exits (goBackOnce, replace('MessengerHome'))
          both resolve here — 'MessengerHome' is this stack's FilesScreen root. */}
      <VaultStack.Screen name="MessengerSettings" component={MessengerSettingsScreen} />
      <VaultStack.Screen name="BackupSetup" component={BackupSetupScreen} />
    </VaultStack.Navigator>
  );
}

const Tab = createBottomTabNavigator<DepartmentalTabParamList>();

/**
 * Hide a tab from the BAR while leaving its route registered and navigable.
 *
 * `tabBarButton` is React Navigation's own convention for this and ObsidianTabBar
 * honours it. Defined once so the four module tabs cannot drift apart.
 */
const HIDDEN_TAB = {tabBarButton: () => null} as const;

/** Never rendered — the Messenger tab press is intercepted before navigation. */
function MessengerTabStub() {
  return null;
}

/**
 * item 07 — News as a REAL in-shell tab.
 *
 * WHY IN-SHELL AND NOT AN EXIT LIKE MESSENGER. The Messenger tab can exit
 * because its target, `MessengerHome`, exists in all three shells that mount
 * `Departmental`. `NewsHub` does NOT: it is registered only inside
 * MessengerNavigator, so `messengerDeepLink`'s agency arm would fall through to
 * its `return {name: 'MessengerHome'}` default and drop an agency user on the
 * chat list, and the CPO shell has no such route either. That is the B-414 class
 * the resolver exists to prevent — recreated. The PDF also calls these five
 * "persistent" destinations, and an exit is not persistent.
 *
 * The duplicate-route-name objection does not apply: VaultLock, VaultScreen,
 * FileVaultPurchase, MessengerSettings and BackupSetup are ALREADY registered in
 * both MessengerNavigator and this navigator's Vault tab, with `Departmental`
 * mounted inside the former. Inner-first resolution is the established pattern
 * here, not a new risk.
 */
function NewsTab() {
  return <NewsNavigator />;
}

/**
 * Shown INSTEAD of the workspace tabs once the active organisation is no longer
 * one this person belongs to (removed, suspended, org deleted, Enterprise
 * subscription lapsed). Deliberately a dead end with one way out: the surface
 * behind it would answer against the wrong tenant.
 */
function EjectedNotice({orgName, onDismiss}: {orgName: string; onDismiss: () => void}) {
  return (
    <View style={ejectStyles.wrap}>
      <Icon name="office-building-remove-outline" size={44} color={OB.textMute} />
      <Text style={ejectStyles.title}>You no longer have access</Text>
      <Text style={ejectStyles.body}>
        {`Your access to ${orgName} has ended. Anything you do here would apply to a different organisation, so this workspace is closed.`}
      </Text>
      <TouchableOpacity
        style={ejectStyles.btn}
        onPress={onDismiss}
        accessibilityRole="button"
        accessibilityLabel="Leave this workspace">
        <Text style={ejectStyles.btnText}>Go back</Text>
      </TouchableOpacity>
    </View>
  );
}

const ejectStyles = StyleSheet.create({
  wrap: {flex: 1, backgroundColor: OB.bg, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 12},
  // 44dp minimum touch target, per the design-system rule.
  btn: {marginTop: 8, minHeight: 44, justifyContent: 'center', paddingHorizontal: 24,
    borderRadius: 12, backgroundColor: OB.accent},
  ...scaleTextStyles({
    title: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, textAlign: 'center'},
    body: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
    btnText: {color: '#FFF', fontFamily: BravoFont.semiBold, fontSize: 14},
  }),
});

export default function DepartmentalNavigator() {
  // Phase B / critic MAJOR-3 — reconcile the workspace context against the
  // live affiliation list: removed from the workspace (recheckMembership
  // drops its entry) → the context must not keep pointing a dead, empty
  // surface at its name. Only when the server SHIPS the array (defined) —
  // an old server must not clear a context it can't vouch for.
  const workspacesList = useAuthStore(s => s.user?.workspaces);
  const activeCtx = useActiveWorkspace(s => s.workspace);
  const rootNav = useNavigation<ResolvableNavigation>();
  /**
   * EJECTED — the workspace on screen is no longer one this person belongs to.
   *
   * State, not navigation. Round 2 pushed the Workspace Hub instead, and that
   * was defeated by its own verb: `WorkspaceHub` and `Departmental` are sibling
   * screens on ONE stack, so `navigate` only pops when the hub is already
   * below. Entered from the drawer or a notification it PUSHES, leaving this
   * surface mounted underneath — and one Back gesture put the user straight
   * back into a workspace they had been removed from, now with a null context,
   * which does not mean "no organisation" but "my PRIMARY organisation". The
   * next write would land on the wrong tenant, which is the whole hazard.
   *
   * Refusing to render the tabs cannot be undone by a gesture, needs no route
   * to exist, and works identically in all three host shells. It also tells the
   * user what happened, which a silent teleport never did.
   */
  const [ejected, setEjected] = React.useState<{orgId: string; name: string} | null>(null);
  // The org that came back missing ONCE. A ref, not state: a re-render on a
  // near-miss would be noise, and it must not re-run the effect.
  const missRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!activeCtx || workspacesList === undefined) {return;}
    const match = workspacesList.find(w => w.org_id === activeCtx.org_id);
    if (!match) {
      /**
       * TWO STRIKES, because an empty list is not proof of removal.
       *
       * Every membership in WORKSPACE_AFFILIATIONS_SQL is gated on the org
       * owner's live Enterprise entitlement, and resolveAccountKind's
       * user-not-found arm returns `workspaces: []` outright. So a renewal that
       * lands forty seconds late — or one flaky /auth/me — reads exactly like
       * "you were removed", and would eject every member of that company at
       * once, from a screen they cannot re-enter until they tap through.
       *
       * A real removal is permanent, so it survives a second look; a blip does
       * not. One extra refresh of delay is a much cheaper mistake than telling
       * a whole workspace their access ended.
       */
      if (missRef.current !== activeCtx.org_id) {
        missRef.current = activeCtx.org_id;
        return;
      }
      setEjected({orgId: activeCtx.org_id, name: activeCtx.name || 'that organisation'});
      useActiveWorkspace.getState().setActiveWorkspace(null);
      return;
    }
    missRef.current = null;
    // A VALID context clears a latch left by a different org. Without this, one
    // ejection bricked the module for the session: Dana ejected from Borealis
    // then tapping an ACME tile (or an Acme push) reached this same mounted
    // instance and was told her access to BOREALIS had ended.
    if (ejected && ejected.orgId !== match.org_id) {setEjected(null);}
    // The context is a SNAPSHOT taken at tile-tap; the list is live. A demoted
    // manager kept manager chrome and 403'd on every screen it opened, and a
    // renamed workspace kept its old name in the header until sign-out.
    if (match.role !== activeCtx.role || match.name !== activeCtx.name) {
      useActiveWorkspace.getState().setActiveWorkspace({
        org_id: match.org_id, name: match.name, role: match.role,
      });
    }
  }, [activeCtx, workspacesList, ejected]);

  // Cleared on the way OUT, not on the tap. A later, deliberate entry then
  // starts clean.
  //
  // A notification tap DOES set a context now (vs2 edge A1/A2,
  // `adoptOrgContextFromWake`) — but only to an org already in the user's own
  // `workspaces` array, which is the same list this effect reconciles against.
  // So a wake can satisfy the match branch above and clear a stale latch; it
  // can never create one, because an org that is not a membership is refused
  // before the context is written.
  const isFocused = useIsFocused();
  React.useEffect(() => {
    if (!isFocused && ejected) {setEjected(null);}
  }, [isFocused, ejected]);

  /**
   * B-95, MEASURED: a freshly-KEYED navigator is not a reset.
   *
   * React Navigation stores a nested navigator's state on the parent route, and
   * the replacement rehydrates it — route names match on both sides of an org
   * switch, so the state is always "valid" and `initialRouteName` is ignored.
   * The library's own deferred cleanup skips itself when the replacement has
   * already mounted. `MainNavigator` hit this on the product switch and the
   * remedy is the same here: hold ONE navigator-free frame, let the cleanup run,
   * then mount the new org's tree.
   *
   * Without it the key is decoration: Priya switching from a workspace she
   * manages to one where she is an employee stayed on AdminAttendance (403) and
   * on the previous org's ChannelEditor, with a Save that PATCHes cross-tenant.
   */
  const orgKey = activeCtx?.org_id ?? 'primary';
  const [mountedOrg, setMountedOrg] = React.useState(orgKey);
  React.useEffect(() => {
    if (mountedOrg === orgKey) {return;}
    const t = setTimeout(() => setMountedOrg(orgKey), 30);
    return () => clearTimeout(t);
  }, [mountedOrg, orgKey]);

  if (mountedOrg !== orgKey) {
    // THE HELD FRAME. Rendering nothing for ~30ms is what lets React
    // Navigation's deferred cleanup clear the parent route's stored state; mount
    // the replacement in the same commit and the cleanup skips itself and the
    // new tree rehydrates the old org's screens.
    return <View style={{flex: 1, backgroundColor: OB.bg}} />;
  }

  if (ejected) {
    return (
      <EjectedNotice
        orgName={ejected.name}
        onDismiss={() => {
          /**
           * NAVIGATE ONLY — do not clear the latch here.
           *
           * Clearing it first re-rendered the full Tab.Navigator underneath in
           * the same commit, bound to `primary` (an AGENCY, for the consultant)
           * and already firing reads against it. Since `navigate` pushes when
           * the hub is not already below, one back gesture then landed the user
           * in a live workspace surface pointed at the wrong tenant — the exact
           * hazard the latch replaced a navigation-only fix to prevent.
           *
           * The blur effect below clears it once they have actually left.
           */
          // Best-effort return. Unlike the round-2 version, nothing depends on
          // this working — the tabs are already refusing to render.
          const hub = findNavigatorWithRoute(rootNav, 'WorkspaceHub');
          if (hub) {
            navigateVia(hub, 'WorkspaceHub');
            return;
          }
          const back = rootNav as unknown as {canGoBack?: () => boolean; goBack?: () => void};
          if (back.canGoBack?.()) {back.goBack?.();}
        }}
      />
    );
  }
  return (
    <Tab.Navigator
      /**
       * KEYED ON THE ORG. `initialRouteName` is read once, when a stack's
       * router initialises — changing it later is ignored. So switching from a
       * workspace you manage to one where you are an employee left the Attend
       * tab rooted at AdminAttendance and Incident at IncidentQueue, both
       * 403ing; and every stack kept the previous org's route params, so
       * Channels came back on the OLD company's ChannelEditor with a Save that
       * would PATCH across tenants. Remounting is the only thing that re-reads
       * initialRouteName and drops the params with it.
       */
      key={mountedOrg}
      sceneContainerStyle={{backgroundColor: OB.bg}}
      screenOptions={{headerShown: false}}
      // The four modules are reached FROM Home and return to it — with them
      // hidden from the bar, that return path is the only one. It worked by
      // accident before: 'firstRoute' is the default AND Home happens to be
      // declared first. Stating it means a later "harmonise with MainNavigator"
      // (which sets "history") cannot silently strand a module.
      backBehavior="firstRoute"
      tabBar={props => (
        <ObsidianTabBar
          {...props}
          icons={TAB_ICONS}
          standInTab="Home"
          bg={OB.bg}
          accent={OB.accent}
          mute={OB.textMute}
        />
      )}>
      {/* ⚠️ DECLARATION ORDER IS THE BAR ORDER. ObsidianTabBar maps
          `state.routes` in order, so the PDF's "Home - Channels - Vault -
          Messenger - News" is expressed HERE and nowhere else. */}
      <Tab.Screen name="Home" component={DepartmentalHomeScreen} />
      {/* item 07 — the client review supersedes the vs1 "Home + Messenger only"
          rule with a FIVE-item bar: Home · Channels · Vault · Messenger · News.
          Channels and Vault are therefore no longer hidden. */}
      <Tab.Screen name="Channels" component={ChannelsTab} />
      <Tab.Screen name="Vault" component={VaultTab} />
      {/* Messenger is a way OUT of the workspace, not a screen inside it, so
          the tab press is intercepted and never navigates to this component.
          It still needs one: a Tab.Screen without a component does not mount. */}
      <Tab.Screen
        name="Messenger"
        component={MessengerTabStub}
        listeners={({navigation}) => ({
          tabPress: e => {
            e.preventDefault();
            /**
             * The workspace is the 'Departmental' route INSIDE its host stack,
             * so exiting means landing on that stack's own root.
             *
             * `getParent()?.navigate('MessengerHome')` resolves in the
             * Messenger and Agent shells and is SILENTLY DROPPED in the CPO
             * shell, whose root stack has no `MessengerHome` — the B-414 class
             * (a screen in N shells, a route in one). A CPO tapping Messenger
             * to leave the workspace simply stayed where they were, with no
             * error and nothing to retry.
             *
             * The resolver knows every shell's path to `MessengerHome`, which
             * is exactly the knowledge a bare `getParent()` hop lacks.
             */
            navigateToMessengerScreen(navigation as never, 'MessengerHome', {}, {initial: false});
          },
        })}
      />
      {/**
        * item 07 — News, the fifth destination.
        *
        * `unmountOnBlur`, NOT `freezeOnBlur`. freezeOnBlur suspends RENDERING
        * only: it does not unmount, so no useEffect cleanup runs. IntelFeedScreen
        * keeps a 1s setInterval and an Animated.loop whose teardowns are
        * unmount-only, and a Leaflet WebView it DELIBERATELY keeps resident
        * ("so tab switches don't re-boot Leaflet"). Today those costs are bounded
        * by the navigator type — News lives on a native stack, so popping back
        * unmounts it — and a tab would never unmount, leaving all three running
        * for the whole workspace session against CLAUDE.md's open JS-thread lag
        * investigation. unmountOnBlur restores exactly today's semantics.
        *
        * (bottom-tabs `lazy` defaults to TRUE, so News is not mounted at all
        * until first tapped. That is the larger mitigation — do not set
        * lazy:false for perceived snappiness.)
        *
        * ⚠️ `unmountOnBlur` is React Navigation v6 and is REMOVED in v7. On
        * upgrade, re-home it (v7's equivalent) rather than dropping it.
        */}
      <Tab.Screen name="News" component={NewsTab} options={{unmountOnBlur: true}} />
      {/* REACHABLE, NOT SHOWN.
          Attend and Incident are reached from the Home dashboard's cards, and
          the routes stay registered so every existing
          navigation.navigate('Attend' | 'Incident') keeps working — including
          the deep links push notifications use. Unregistering them to satisfy a
          presentation rule would break live call sites. */}
      <Tab.Screen name="Attend" component={AttendTab} options={HIDDEN_TAB} />
      <Tab.Screen name="Incident" component={IncidentTab} options={HIDDEN_TAB} />
    </Tab.Navigator>
  );
}
