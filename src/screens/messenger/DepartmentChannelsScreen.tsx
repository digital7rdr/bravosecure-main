import React, {useCallback, useState} from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  StatusBar,
  ActivityIndicator,
  RefreshControl,
  TextInput,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useAuthStore} from '@store/authStore';
import {useEntitlements} from '@store/entitlements';
import {activeWorkspaceOrgParam, scopeChannelsToActiveWorkspace, useActiveWorkspace, contextManagerRole} from '@store/activeWorkspace';
import {openPricing} from '@navigation/openPricing';
import {departmentApi, enterpriseApi, orgApi, type DepartmentChannelDto} from '@services/api';
import {ensureChannelProvisioned} from '@/modules/messenger/orgWorkspace/provisionChannel';
import {drainMembershipIntents} from '@/modules/messenger/orgWorkspace/membershipIntents';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {OB, Card, SectionLabel, ErrorState, loadErrorText, channelStateMeta} from '@screens/deptchat/_obsidian';
import {deptEmployeeNoun} from '@screens/deptchat/deptNoun';
import {fromDirectory, buildChannelTree, visibleTreeNodes, hasExpandableChildren,
  nestParentedBroadcasts, orgSectionsOf, filterTreeRows, expandedIdsForQuery} from '@screens/deptchat/organisationTree';
import {orgSectionLabels, type OrgNameSource} from '@screens/deptchat/orgDisambiguation';
import {ChannelTree} from '@screens/deptchat/ChannelTree';
import {ChannelMessageHits} from '@screens/deptchat/ChannelMessageHits';
import {
  channelMessageHits, groupHitsByOrg, shouldSearchMessages, MESSAGE_SEARCH_LIMIT,
  type ChannelMessageHit, type ChannelRef,
} from '@screens/deptchat/channelMessageSearch';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {nameForTier} from '@screens/deptchat/levelNames';
import {useIsWorkspaceTenant} from '@screens/deptchat/workspaceTenant';
import {moduleVisible, hiddenModulesFor, moduleRowSubtitle, moduleRowTitle, type WorkspaceSettings}
  from '@screens/deptchat/hiddenModules';
import {useOpenDepartmentChannel} from '@screens/deptchat/openDepartmentChannel';
import {useChannelUnread, unreadOfGroup} from '@screens/deptchat/channelUnread';
import {UnreadPill} from '@screens/deptchat/UnreadPill';
import {
  isInDepartmentalShell, openAttendance, openJoinFlowScreen,
  type ResolvableNavigation,
} from '@navigation/departmentalEntry';
import LoadingView from '@components/LoadingView';

type IconName = React.ComponentProps<typeof Icon>['name'];

/** B-636 — THE empty hit list, so clearing the message results is a real no-op
 *  rather than a fresh array that can never satisfy `useState`'s `Object.is`
 *  bail-out. This screen is heavy; an extra full render on every mount is not
 *  free (see the lag register in CLAUDE.md). */
const NO_HITS: readonly ChannelMessageHit[] = [];

// Channel-type → section label + row glyph. The design uses a `#` hash for the
// department list; board/incident groups keep their own glyph so the type still
// reads at a glance (the app surfaces more channel types than the mock).
const GROUPS = [
  {type: 'board', label: 'Board', icon: 'bullhorn-variant-outline'},
  {type: 'department', label: 'Department', icon: 'pound'},
  {type: 'incident', label: 'Incident', icon: 'shield-alert-outline'},
] as const;

// Scope v2 Phase 1 — the four levels (PDF page 1 LOCKED RULES: "Exactly four
// organisational levels… no fifth level is permitted"; frame M8: "Group channels
// clearly across four levels: Enterprise, Main, Sub and Sub-sub").
// Header FORM follows the M8 mockup ("LEVEL n — NAME", levels numbered 1-4 for
// humans while the DB stores 0-3). The NAMES deliberately do not:
//
//   mockup:  LEVEL 1 — BOARD · LEVEL 2 — SENIOR MANAGEMENT ·
//            LEVEL 3 — DEPARTMENT · LEVEL 4 — TEAM / SUB-CHANNELS
//   here:    ENTERPRISE / MAIN / SUB / TEAM — SUB-CHANNELS
//
// Reason: BOARD / SENIOR MANAGEMENT / DEPARTMENT read as that example org's own
// tier names, not a fixed vocabulary — a security firm's level 2 is not
// "Senior Management". A9 names the tiers Enterprise / Main / Sub / Sub-sub, so
// those are used. Only level 4 matches the mockup verbatim.
//
// ⚠️ This is a JUDGEMENT CALL against a founder rule that says match the PDF,
// so it is flagged in the plan doc for a decision rather than settled here. Do
// NOT describe this as "matching the mockup exactly" — an earlier comment did,
// and the wording underneath it disagreed.
/**
 * The stored `level` values this branch groups by.
 *
 * PDF checklist line 9 — THE LABELS ARE NO LONGER STORED HERE. They used to be
 * four hardcoded strings ('LEVEL 1 — ENTERPRISE' …) which were a fourth,
 * upper-cased, off-by-one copy of the same vocabulary that lived in
 * ManageChannelsScreen and ChannelEditorScreen — and this copy keyed on the
 * 0-based `level` while those keyed on it as if it were the display tier, so
 * the three disagreed on screen. Resolved through `nameForTier` at render
 * instead, so an org that renamed its tiers reads them here too.
 */
const LEVELS = [0, 1, 2, 3] as const;

/**
 * The applicant's way IN (M5) and BACK (M11A).
 *
 * Gated on `isOrgAffiliated` — "actually in an org" — NOT on `hasDeptChannels`.
 * The latter is `isOrgAffiliated || tier === 'enterprise'`, so it is TRUE for a
 * tier-only Enterprise individual who has no membership row: exactly the
 * applicant this whole phase exists for. Gating on it hid the CTAs from the one
 * person who needs them.
 *
 * Rendered in BOTH the entitled and not-entitled branches on purpose. Living in
 * one branch made it unreachable: the only screen that navigates here does so
 * only when entitled, and the CTAs rendered only when NOT entitled.
 */
function JoinCta({joinStatus, hasInvite, isOrgAffiliated, canCreateWorkspace, navigation}: {
  joinStatus: 'pending' | 'approved' | 'declined' | null;
  /** Item E — an open invite addressed to this caller exists. */
  hasInvite: boolean;
  isOrgAffiliated: boolean;
  /**
   * The caller holds an ACTIVE Enterprise tier, so they may CREATE a workspace
   * as well as join one. Without this the only offer was "I have an invite
   * code" — so a paying Enterprise customer with no organisation had no route
   * to make one, and instead walked into a workspace shell where Channels,
   * Attendance and Incidents were all empty. That is the "why does a normal
   * client get this, and it does not work" report.
   */
  canCreateWorkspace: boolean;
  // `RouteAwareNavigation`, NOT `{navigate}`. The narrower type was
  // structurally insufficient for what this component does with it: the only
  // use is `openJoinFlowScreen`, which RESOLVES against the tree via
  // `getParent`/`getState` — both optional on its own signature. So passing
  // `{navigate: navigation.navigate}` typechecked cleanly at the baseline while
  // making every candidate miss, turning the CTA into an Alert in the Agent and
  // CPO shells: the exact R6-2/R6-3 dead tap, invisible to the render test
  // because the resolver is mocked there.
  navigation: ResolvableNavigation;
}) {
  // Already in an org with nothing OUTSTANDING — nothing to offer.
  //
  // R7-2: `myJoinRequest` returns the latest request whatever its status, so
  // after approval it answers 'approved' forever. Testing `!joinStatus` here
  // meant everyone who joined by code kept a permanent "View your request
  // status" button — the one persona this branch is meant to render nothing
  // for. Only a PENDING request is outstanding.
  // Affiliation still wins over an invite: an active member's (or owner's)
  // accept can only 409, so nagging them with a Join CTA for up to 90 days is
  // a dead-end — the server-side myInvites exclusion covers same-org invites,
  // and this guard covers cross-org ones (edge-case review, 2026-08-08).
  if (isOrgAffiliated && joinStatus !== 'pending') {return null;}
  // For everyone else an open INVITE outranks the fork: the admin already
  // decided, so the one useful action is accepting it (ApprovalStatus
  // self-hydrates the invite — the code is never threaded through the
  // resolver, whose params drop on most branches). A pending request wins
  // next: it is the outstanding thing to look at. Otherwise an
  // Enterprise-tier caller gets the FORK (create or join) and everyone else
  // keeps the code-only path.
  const target = hasInvite || joinStatus
    ? 'ApprovalStatus'
    : (canCreateWorkspace ? 'EnterpriseSetup' : 'JoinWorkspace');
  const label = hasInvite
    ? "You've been invited — tap to join"
    : joinStatus
      ? (joinStatus === 'pending' ? 'View your pending request' : 'View your request status')
      : (canCreateWorkspace ? 'Set up your workspace' : 'I have an invite code');
  return (
    <TouchableOpacity
      style={styles.gateCta}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={label}
      // Shared resolver, not a bare `if (host)` with no else: this screen is
      // mounted in MessengerNavigator AND in the Departmental shell's Channels
      // stack (reached from the Agent and CPO dashboards), and the no-else
      // version dropped the tap silently in the latter — Issues 18/19 again.
      onPress={() => { openJoinFlowScreen(navigation, target); }}>
      <Icon name={hasInvite ? 'email-check-outline' : joinStatus ? 'clock-outline' : 'ticket-confirmation-outline'} size={16} color={OB.accentSoft} />
      <Text style={styles.gateCtaText}>{label}</Text>
    </TouchableOpacity>
  );
}

/** Row glyph by channel type — level grouping replaces the type SECTIONS, so the
 *  type signal has to survive on the row itself rather than being lost. */
const iconForType = (t: DepartmentChannelDto['channel_type']) =>
  GROUPS.find(g => g.type === (t ?? 'department'))?.icon ?? 'pound';

/** Pre-hierarchy rows carry no level; they render as Main, which is what they
 *  already are. Kept in one place so the default cannot drift between call
 *  sites (the repo's duplicate-copy bug class). */
const levelOf = (c: DepartmentChannelDto): number => c.level ?? 1;

export default function DepartmentChannelsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const user = useAuthStore(s => s.user);
  // This screen is mounted two ways: standalone (pushed from MessengerHome, no
  // Departmental tab shell around it — the quick-link row below is the only way
  // in) and as the Channels tab's root INSIDE DepartmentalNavigator's 5-tab shell
  // (Home · Channels · Attend · Incident · Vault already on screen). In the
  // nested case the row's `navigate('Departmental')` bubbled past the tab
  // navigator (which has no 'Departmental' route of its own) up to whichever
  // ancestor stack does, pushing a SECOND Departmental shell on top of the one
  // already visible — confusing, and easy to read as "nothing happened" once the
  // duplicate Home tab looked identical to where the user already was. Detect
  // the nested case and route to the existing Attend tab instead of re-entering.
  // Issue 19 — the shell probe walks the WHOLE ancestor chain now. A
  // single-level getParent() only ever inspected one navigator, so it read
  // false in any shell nesting deeper than the case it was written for, and a
  // false reading re-enters a shell the user is already looking at ("nothing
  // happened"). The entry itself is resolved against the mounted tree too: the
  // old `navigate('Departmental')` carried no params and landed on the shell's
  // default Home tab rather than Attendance.
  const inDepartmentalShell = isInDepartmentalShell(navigation);
  const openAttendanceTab = useCallback(() => {
    openAttendance(navigation);
  }, [navigation]);
  // Entitlement: org tenancy (service-provider company / ACTIVE CPO/manager)
  // OR an active Enterprise tier (M1A rule 16 — the individual runs their own
  // single-tenant workspace). One selector, mirroring DeptChatAccessGuard's
  // three paths — this screen previously kept an inline org-only copy of the
  // rule and locked paying Enterprise users out of their own workspace.
  const entitlements = useEntitlements();
  const entitled = entitlements.hasDeptChannels;
  // "Actually in an org", distinct from `hasDeptChannels` which a paid tier
  // alone satisfies. The join CTAs key off THIS.
  const isOrgAffiliated = entitlements.isOrgAffiliated;
  // May they CREATE an organisation? Only an ACTIVE Enterprise tier can, and
  // the server enforces it (WorkspaceService 403s otherwise) — this only
  // decides which offer to show, never whether it succeeds.
  const canCreateWorkspace = entitlements.effective === 'enterprise' && !isOrgAffiliated;
  // Company/agency account surfaces the manage entry (delegated managers are
  // allowed server-side too; the button is just a soft hint). Prefer the
  // server-resolved is_org_manager flag (mirrors OrgManagerGuard) so a manager
  // who is also a CPO elsewhere isn't hidden; fall back to the heuristic.
  // Phase B / critic MAJOR-2 — with a workspace context set, the ONE shared
  // predicate decides instead: an owner-of-A browsing workspace B must not
  // see Manage/Create entries whose OrgManagerGuard calls operate on org A.
  const activeCtx = useActiveWorkspace(st => st.workspace);
  const ctxManager = contextManagerRole(activeCtx, user?.owns_workspace === true);
  const isManager = ctxManager !== null
    ? ctxManager
    : !!user && (user.is_org_manager ?? (user.role === 'service_provider' || user.account_kind === 'agency'));

  /**
   * Scope v2 Phase 3 — the applicant's way IN and BACK.
   *
   * (a) "I have an invite code" is the only route to M5; without it the whole
   *     join flow was built and unreachable.
   * (b) A pending/decided request routes to M11A from STATE, not from a
   *     notification tap. ApprovalStatus used to be reachable only *through*
   *     JoinWorkspace, so an applicant who backgrounded the app could never
   *     return to their own status. Making it state-driven means recoverability
   *     does not depend on a notification arriving or being tapped.
   */
  const [joinStatus, setJoinStatus] = useState<'pending' | 'approved' | 'declined' | null>(null);
  // Item E — an open invite addressed to the caller. Outranks the fork: the
  // decision has already been made FOR them; the CTA's job is to surface it.
  const [hasInvite, setHasInvite] = useState(false);
  const [channels, setChannels] = useState<DepartmentChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  // F15 — distinguishes "the directory failed" from "the directory is empty".
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [provisioning, setProvisioning] = useState<string | null>(null);
  // vs2 item 17b — the same rule the workspace Home uses, fed by the same
  // endpoint, so the two surfaces cannot disagree about what this org offers.
  const [wsSettings, setWsSettings] = useState<WorkspaceSettings | null>(null);
  // PDF checklist line 9. Rides the settings response this screen already
  // loads; absent (old server / nothing chosen) resolves to the built-ins.
  const levelNames = wsSettings?.levelNames;
  const modules = hiddenModulesFor(wsSettings, activeCtx?.org_id);
  const showAttendance = moduleVisible(modules, 'attendance');
  const showIncidents = moduleVisible(modules, 'incidents');
  // Once per mount: the admin self-heal provisioning sweep (see load()).
  const provisionSweepRan = React.useRef(false);

  // Summary chips. Unread is a local concept (the relay only holds ciphertext),
  // so total unread is summed from the encrypted messenger store per channel.
  const totalUnread = useMessengerStore(s =>
    channels.reduce((sum, c) =>
      sum + unreadOfGroup(s.conversations, c.group_conversation_id), 0),
  );
  const adminCount = channels.filter(c => c.my_role === 'admin').length;

  /**
   * vs2 item 6 — the organisation-first directory.
   *
   * Gated on BOTH the tenant and the data. Agencies keep today's level
   * sections, and so does a legacy FLAT workspace: with no hierarchy, an
   * organisation list is five one-item organisations nobody created, which is
   * strictly worse than the list it replaced. `hasHierarchy` also refuses to
   * claim a tree when the server is too old to say (it keys on the same field
   * `placeRow` classifies by), so an old server degrades to the level sections
   * rather than to an empty screen.
   */
  /**
   * UI corrections 2026-08-15 items 02/03/06 — THE TENANT GATE.
   *
   * `useIsWorkspaceTenant()` is a USER-level fact: true for anybody with any
   * workspace affiliation at all. That is edge A3, and it is why the ADMIN
   * endpoint grew a server-authoritative `workspace_tenant` — the member
   * directory never had one, so an agency manager who had also joined a
   * workspace got workspace-shaped UI on their AGENCY's channels.
   * `listChannels` now answers per row; the user flag is the old-server fallback
   * and can only ever widen false→true, which is the safe direction here because
   * an undefined answer must NOT put an agency on the tree.
   */
  const userTenant = useIsWorkspaceTenant();
  const serverTenant = channels.length > 0 ? channels.some(c => c.workspace_tenant === true) : undefined;
  const tenantKnown = channels.length === 0 || channels.some(c => c.workspace_tenant !== undefined);
  const isWorkspace = tenantKnown ? (serverTenant ?? userTenant) : userTenant;
  /**
   * G4 (founder, 2026-08-19) — "Announcements should be within the organisation
   * itself." A parented broadcast joins the tree as a lateral under the level
   * that owns it, instead of landing in `directoryBuckets.announcements` and
   * being drawn as an unparented row at the ROOT of the screen — which is the
   * global announcements list under a different name. Parentless legacy rows
   * are untouched (they have no organisation to move into).
   *
   * Workspace-only in effect: agencies never reach the tree branch, they take
   * the LEVELS branch below. Rev 4 §2.4's agency objection therefore does not
   * apply here — see `nestParentedBroadcasts`.
   */
  const allTreeRows = React.useMemo(
    () => nestParentedBroadcasts(fromDirectory(channels)), [channels]);
  /**
   * B-625 (client, 2026-08-22) — "Can you add a search bar for channels also,
   * to find channels very quickly."
   *
   * The filter runs HERE, before sectioning and before the tree is built, so
   * every stage downstream (org split, `buildChannelTree`, the collapse seed)
   * sees a consistent row set and nothing has to learn about searching.
   * `filterTreeRows` returns the INPUT ARRAY on a blank query, so the unsearched
   * screen keeps its exact `useMemo` identities and behaves byte-identically.
   */
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;
  const treeRows = React.useMemo(
    () => filterTreeRows(allTreeRows, query), [allTreeRows, query]);
  /**
   * B-636 (client, 2026-08-23) — "this search option should allow you to also
   * search for conversations or words in conversations that's inside the chats."
   *
   * ── DEBOUNCED SEPARATELY FROM THE NAME FILTER, ON PURPOSE ─────────────────
   *
   * Filtering channel NAMES is a scan over a few dozen rows already in memory,
   * so it stays instant on every keystroke — that is what B-625 shipped and it
   * must not get slower. Searching BODIES is a SQLCipher read across every
   * message on the device, and firing one per keystroke is precisely the
   * JS-thread starvation this repo spent two sessions measuring (B-279/B-285).
   * One settle after typing stops.
   */
  const [msgQuery, setMsgQuery] = useState('');
  React.useEffect(() => {
    const t = setTimeout(() => setMsgQuery(query), 200);
    return () => clearTimeout(t);
  }, [query]);
  /**
   * ⚠️ GATED ON THE TENANT ALONE — deliberately NOT `&& hasHierarchy(...)`.
   *
   * Two large populations have no hierarchy on a workspace: every pre-hierarchy
   * workspace ("EVERY EXISTING WORKSPACE IS FLAT" — see hasHierarchy's docblock)
   * and every workspace with one organisation and no sub-levels. Under the old
   * conjunction they fell to the LEVELS branch below — which renders
   * "LEVEL 2 — MAIN", i.e. THE EXACT SCREEN the client review crossed out in
   * item 11. A flat workspace now renders as N neutral root rows, which is both
   * correct and what retires that screen.
   *
   * Agencies keep the LEVELS branch untouched (item 04 is workspace-only).
   */
  const orgFirst = isWorkspace;
  /**
   * B-624 (client, 2026-08-22) — "Different organization channels must never
   * mix… It must ALWAYS be separate here."
   *
   * ONE TREE PER OWNING ORGANISATION, and this is the only stage that knows
   * about orgs. Both scoping belts upstream are fail-open NO-OPS with no
   * workspace context set (`activeWorkspaceOrgParam` sends no orgId,
   * `scopeChannelsToActiveWorkspace` filters nothing) — and the context store is
   * session-only, so a cold boot or any entry that is not the Workspace Hub
   * tile lands here with every org's channels in one list. `orgSectionsOf` is
   * the containment: split first, then build each tree with the untouched
   * helpers, so a foreign root can never render as a sibling of a local one.
   *
   * With a workspace selected the list is already narrowed to one org, so this
   * collapses to exactly one section and the screen is unchanged.
   */
  const orgSections = React.useMemo(() => orgSectionsOf(treeRows), [treeRows]);
  const sectionTrees = React.useMemo(
    () => orgSections.map(s => ({orgId: s.orgId, nodes: buildChannelTree(s.rows)})),
    [orgSections]);
  /** The flat view, for the whole-screen questions: the collapse seed and
   *  "does this id expand?". Ids are unique across sections. */
  const treeNodes = React.useMemo(
    () => (sectionTrees.length === 1 ? sectionTrees[0].nodes : sectionTrees.flatMap(s => s.nodes)),
    [sectionTrees]);
  /**
   * The header name per section. `listChannels` answers `org_id` and NOT
   * `org_name`, so it is resolved from names this client already holds, most
   * specific first; an org that is in none of them (an agency-owned org is
   * structurally absent from `workspaces`) falls back to the short handle the
   * hub already shows rather than to a uuid or a blank.
   */
  const orgNameSources = React.useMemo<OrgNameSource[]>(() => {
    const out: OrgNameSource[] = [];
    if (activeCtx) {out.push({org_id: activeCtx.org_id, name: activeCtx.name});}
    for (const w of user?.workspaces ?? []) {out.push({org_id: w.org_id, name: w.name});}
    if (user?.org) {out.push({org_id: user.org.id, name: user.org.name});}
    if (user?.managed_org) {out.push({org_id: user.managed_org.id, name: user.managed_org.name});}
    return out;
  }, [activeCtx, user]);
  /**
   * B-636 — resolved over EVERY organisation on the screen, not just the ones a
   * search left standing.
   *
   * Two reasons, both real. (1) `orgSectionLabels` disambiguates by looking for
   * COLLISIONS within the list it is given, so deriving it from the filtered set
   * meant typing a query could rename an organisation mid-search — its
   * identically-named twin having just been filtered away. (2) The message hits
   * below need a heading for an organisation whose channels all failed the NAME
   * filter, which is the ordinary case when the match is inside a chat.
   */
  const allOrgSections = React.useMemo(() => orgSectionsOf(allTreeRows), [allTreeRows]);
  const sectionLabels = React.useMemo(
    () => orgSectionLabels(allOrgSections.map(s => s.orgId), orgNameSources),
    [allOrgSections, orgNameSources]);
  /**
   * B-636 — conversation id → the channel that owns it, and the ONLY scope the
   * message search is ever given.
   *
   * Built from the same `channels` array the tree renders, so the searchable set
   * is exactly what is on this screen: a channel the caller cannot see has no
   * entry, and `channelMessageHits` drops any row that arrives without one. A
   * channel with no encrypted group yet (`group_conversation_id === null`) has
   * no conversation to search — it is skipped rather than mapped to a blank id,
   * which would collapse every unprovisioned channel onto one key.
   */
  const channelByConversationId = React.useMemo(() => {
    const out = new Map<string, ChannelRef>();
    for (const c of channels) {
      const cid = c.group_conversation_id;
      if (!cid) {continue;}
      out.set(cid, {channelId: c.id, channelName: c.name, orgId: c.org_id ?? null});
    }
    return out;
  }, [channels]);
  const [hits, setHits] = useState<readonly ChannelMessageHit[]>(NO_HITS);
  const [msgBusy, setMsgBusy] = useState(false);
  React.useEffect(() => {
    if (!shouldSearchMessages(msgQuery) || channelByConversationId.size === 0) {
      // NO_HITS, not a fresh `[]`. `useState` bails out on `Object.is` equality,
      // and a new array literal is never equal to the last one — so clearing
      // with `[]` re-rendered this (heavy) screen every time the effect ran,
      // including the mount pass where nothing is being searched at all.
      setHits(NO_HITS);
      setMsgBusy(false);
      return;
    }
    // `alive` is what makes a slower earlier query unable to overwrite a faster
    // later one: React runs this cleanup BEFORE the next effect, so an in-flight
    // read is disowned the moment the query changes.
    let alive = true;
    setMsgBusy(true);
    void (async () => {
      try {
        const runtime = await getMessengerRuntime();
        const msgs = await runtime.searchMessages?.(msgQuery, {
          conversationIds: [...channelByConversationId.keys()],
          limit: MESSAGE_SEARCH_LIMIT,
        }) ?? [];
        if (!alive) {return;}
        setHits(channelMessageHits(msgs, channelByConversationId, msgQuery, MESSAGE_SEARCH_LIMIT));
      } catch {
        // `getMessengerRuntime` REJECTS on an offline cold boot and again after
        // a wipe — the same rejection `useOpenDepartmentChannel` catches. The
        // channel-NAME half of the search is unaffected, so an empty message
        // section is the honest degraded answer, not an error state for the
        // whole screen.
        if (alive) {setHits(NO_HITS);}
      } finally {
        if (alive) {setMsgBusy(false);}
      }
    })();
    return () => { alive = false; };
  }, [msgQuery, channelByConversationId]);
  /**
   * B-624 again, for the message half — "different organization channels must
   * never mix… It must ALWAYS be separate here." The tree renders one tree per
   * organisation; a flat hit list under it would put that pile straight back on
   * the screen, so the hits are sectioned by the same key, in the same order.
   */
  const messageSections = React.useMemo(
    () => groupHitsByOrg(hits, allOrgSections.map(s => s.orgId)),
    [hits, allOrgSections]);
  /**
   * B-636 — the LEVELS branch (agencies, and legacy FLAT workspaces) renders
   * from `channels` directly, so B-625's search box was drawn there and did
   * NOTHING: `filterTreeRows` only ever reached the `orgFirst` tree above.
   *
   * Filtered by the ids `filterTreeRows` already kept rather than by a second
   * call to `channelMatchesQuery` — the same rule evaluated twice is the
   * duplicate-copy class, and this one would have drifted the moment the tree's
   * ancestor/subtree behaviour changed.
   */
  const searchedChannels = React.useMemo(() => {
    if (!searching) {return channels;}
    const keep = new Set(treeRows.map(r => r.id));
    return channels.filter(c => keep.has(c.id));
  }, [channels, treeRows, searching]);
  /**
   * Session-local collapse state. DEFAULT: every branch closed.
   *
   * That is the founder's sentence, not an interpretation — "Users should only
   * open the branches they need, preventing large organisations from
   * overpopulating the screen." It is also closest to what this screen did
   * before: the organisation list, with everything else one tap in.
   *
   * A row with nothing under it is never added, so a FLAT workspace (the common
   * shape) opens fully visible and the default costs it nothing.
   *
   * Seeded once per mount rather than derived, so a user's expansions survive
   * the focus refetch — recomputing on every `treeNodes` change would slam every
   * branch shut each time they came back from reading a message.
   */
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const didSeedCollapse = React.useRef(false);
  React.useEffect(() => {
    if (didSeedCollapse.current || treeNodes.length === 0) {return;}
    didSeedCollapse.current = true;
    /**
     * ⚠️ COLLAPSED ONLY IF IT HIDES A SUB-LEVEL, not merely "has children".
     *
     * The founder's reason is overpopulation — "users should only open the
     * branches they need" — and a branch is a sub-LEVEL. A level whose only
     * children are its own lateral channels is exactly what the mockups draw
     * open (L1 UAE above #broadcast and #general).
     *
     * G4 made the distinction load-bearing rather than cosmetic. Nesting a
     * parented `#broadcast` gives a previously CHILDLESS root a child, so it
     * stops collapsing into the `chats` bucket and becomes a real L1 level —
     * and under the old seed that level then closed by default. A flat
     * workspace's two one-tap rows became one collapsed card, and the root's
     * own thread moved from the card (which now toggles, per G1) to the small
     * open button. The comment below this one promises the opposite.
     */
    setCollapsed(new Set(
      treeNodes
        .filter(n => n.kind === 'level'
          && treeNodes.some(k => k.parentId === n.row.id && k.kind === 'level'))
        .map(n => n.row.id),
    ));
  }, [treeNodes]);
  // B-624 — visibility is applied PER SECTION, so the collapse state (which is
  // keyed by row id and therefore already org-agnostic) keeps working unchanged.
  /**
   * B-625 — while a search is running, a match hidden inside a collapsed parent
   * is the same as no result at all. So the collapse set is thinned by the ids
   * the filtered rows say must be open. The user's own collapse state is NOT
   * mutated: clearing the query restores exactly what they had.
   */
  const effectiveCollapsed = React.useMemo(() => {
    if (!searching) {return collapsed;}
    const open = expandedIdsForQuery(treeRows);
    const next = new Set<string>();
    for (const id of collapsed) {if (!open.has(id)) {next.add(id);}}
    return next;
  }, [collapsed, searching, treeRows]);
  const visibleSections = React.useMemo(
    () => sectionTrees.map(s => ({orgId: s.orgId, nodes: visibleTreeNodes(s.nodes, effectiveCollapsed)}))
      // A section whose every row was filtered out must not render as an empty
      // org heading with nothing under it.
      .filter(s => s.nodes.length > 0),
    [sectionTrees, effectiveCollapsed]);
  const toggleNode = useCallback((id: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  }, []);
  // The buckets carry TreeRows; the row component needs the full DTO.
  const byId = React.useMemo(
    () => new Map(channels.map(c => [c.id, c])), [channels]);
  // Founder QA 2026-08-08 — the "Admin" chip counted CHANNELS the caller
  // administers (5 for a fresh workspace), which read as "5 admins" next to
  // "1 member". It now counts PEOPLE: the org account + active managers.
  // Best-effort (members can't list the roster) — null falls back to the
  // channels-I-manage count under an honest label.
  const [adminPeople, setAdminPeople] = useState<number | null>(null);

  // Open a channel. If it has no Signal group yet AND the caller is an admin,
  // bootstrap the encrypted group on this device (makeNewGroup via the
  // existing createGroupChat) and register its id with the channel metadata,
  // THEN navigate. Viewers on an unprovisioned channel just see the honest
  // "not yet active" state inside the chat screen.
  // Opening a channel is FOUR decisions (hydration wait, provisioning, owner
  // key recovery, isOwner/postMode in the route) and every one is invisible at
  // the call site. It lives in useOpenDepartmentChannel so the organisation
  // drill-down cannot ship a copy that quietly drops one of them.
  const openChannel = useOpenDepartmentChannel({
    onProvisioning: setProvisioning,
    onGroupLearned: (id, gid) => {
      // B-593 — learning a channel's conversation id is exactly the moment the
      // Messenger list needs to know it is departmental. This used to write
      // React state ONLY, so the id lived for one screen's lifetime and the
      // persisted registry never heard about it.
      if (gid) { useMessengerStore.getState().rememberDeptConversation(gid); }
      setChannels(prev => prev.map(ch =>
        ch.id === id ? {...ch, group_conversation_id: gid} : ch));
    },
  });

  const load = useCallback(async () => {
    // Their own request, in BOTH branches.
    //
    // This used to sit behind `if (!entitled)`, which made it dead: the only
    // screen that navigates here (GroupsScreen) navigates ONLY when
    // `hasDeptChannels` is true, and the not-entitled branch renders only when
    // it is false. Arriving required true, rendering required false — mutually
    // exclusive, so neither CTA was reachable by anyone.
    //
    // It bit the exact persona this phase is written for: `hasDeptChannels` is
    // `isOrgAffiliated || tier === 'enterprise'`, so an Enterprise-tier
    // individual with NO membership row gets `true` from buying the plan, lands
    // in the entitled directory looking at their own empty workspace, and had no
    // way to apply or to check a pending request.
    try {
      const {data} = await enterpriseApi.myJoinRequest();
      setJoinStatus(data.request?.status ?? null);
    } catch { setJoinStatus(null); }
    try {
      const {data} = await enterpriseApi.myInvites();
      // B-413 — only ACCEPTABLE invites arm the CTA: a workspace owner's rows
      // come back acceptable:false (their accept can only 409) and live in
      // the Workspace Hub as informational rows instead.
      // `!== false`, not truthy: a not-yet-redeployed server omits the field,
      // and missing must mean TODAY'S behavior (CTA shows), never all-hidden.
      setHasInvite((data.invites ?? []).some(i => i.acceptable !== false));
    } catch { /* keep the previous answer — a blip must not hide a live invite */ }
    if (!entitled) { setLoading(false); return; }
    try {
      // Phase B — scope the directory to the hub-selected workspace (server
      // param + the shared client belt; both fail open to today's behaviour).
      const {data} = await departmentApi.listChannels(activeWorkspaceOrgParam());
      setChannels(scopeChannelsToActiveWorkspace(data.channels ?? []));
      setLoadError(null);
      // Security: drain any pending membership-change intents so removed
      // members are rekeyed out (and new ones rekeyed in). Best-effort,
      // admin-device only — non-admins / unprovisioned channels are skipped
      // server+client.
      void drainMembershipIntents().catch(() => {});
      // vs2 item 17b — same on-focus load, no cache. Failure leaves it null,
      // which the rule reads as "show everything".
      void orgApi.workspaceSettings()
        .then(res => setWsSettings(res.data))
        .catch(() => { /* everything stays visible */ });
      // Founder QA 2026-08-08 — distinct admin PEOPLE for the stat chip: the
      // org account plus active managers. 403s for plain members → null →
      // the chip falls back to channels-I-manage as "Managed".
      void orgApi.listCpos().then(({data: roster}) => {
        setAdminPeople(1 + roster.filter(r => r.member_role === 'manager' && r.status === 'active').length);
      }).catch(() => { /* member — keep the fallback */ });
      // Founder QA 2026-08-08 — ADMIN SELF-HEAL SWEEP: provision every channel
      // this admin runs that has no group yet (fresh workspaces seed all five
      // that way, and older workspaces are stuck there). Solo groups are
      // allowed now, so this succeeds with just the admin; sequential +
      // best-effort + once per mount so a flaky item can't loop the screen.
      if (!provisionSweepRan.current) {
        provisionSweepRan.current = true;
        // No archived filter needed: listChannels is `archived_at IS NULL`
        // server-side, so archived rows never reach this response.
        const stale = (data.channels ?? []).filter(c => c.my_role === 'admin' && !c.group_conversation_id);
        if (stale.length > 0) {
          void (async () => {
            let healed = 0;
            for (const c of stale) {
              const res = await ensureChannelProvisioned(c.id, c.name, c.group_conversation_id)
                .catch(() => ({status: 'failed'} as const));
              if (res.status === 'ok' || res.status === 'already') {
                healed += 1;
                // B-593 — THE SWEEP IS THE LEAK. It mints a conversation row
                // for every unprovisioned channel this admin runs (`#broadcast`
                // is created server-side on every channel create, with the org
                // account seeded as admin — so the founder's own account sweeps
                // one into existence) and NEVER navigates to the channel, so
                // the writer that records the id on DepartmentChat focus never
                // runs. `provisionOnce` now records it too; this covers the
                // `already` branch, which does not go through that path.
                if (res.groupConversationId) {
                  useMessengerStore.getState().rememberDeptConversation(res.groupConversationId);
                }
                // Publish EACH heal immediately — waiting for the whole sweep
                // left the list stale, so a tap on an already-healed channel
                // re-provisioned it and orphaned a second local group
                // (round-2 critic #2).
                setChannels(prev => prev.map(ch =>
                  ch.id === c.id ? {...ch, group_conversation_id: res.groupConversationId} : ch));
              }
            }
            if (healed > 0) {
              try {
                const {data: fresh} = await departmentApi.listChannels(activeWorkspaceOrgParam());
                setChannels(scopeChannelsToActiveWorkspace(fresh.channels ?? []));
              } catch { /* the next focus refetch shows the healed state */ }
            }
          })();
        }
      }
    } catch (e) {
      // F15 — this is the module's front door. Swallowing the failure told an
      // entitled member "No channels yet" when the real answer was a 403 or no
      // network, and every downstream bug then got diagnosed from that lie.
      setChannels([]);
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
    }
  }, [entitled]);

  // D5-a — pull-to-refresh so a viewer can force a directory + provisioning-state refresh
  // (an admin may have just activated a channel) without waiting for the next focus.
  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await load(); } finally { setRefreshing(false); }
  }, [load]);

  // Refresh on focus so unread counts reflect reads done inside a channel, and so the
  // list unlocks the instant Pro is activated via the paywall. D5-b — useFocusEffect ALSO
  // fires on mount, so a separate useEffect(load) would double-fire load() (and two
  // concurrent drainMembershipIntents passes); the single focus path is the only loader.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // ── Org-membership gate (workspace is an org feature, not individual Pro) ──
  if (!entitled) {
    return (
      <View style={[styles.root, {paddingTop: insets.top}]}>
        <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
        <AmbientBg bg={OB.bg} />
        <ChannelsHeader onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined} />
        {/* SCROLLABLE, not a centred flex:1 block. This gate stacks an 84dp
            icon + title + 3-line body + 3 bullets + 2 CTAs + a hint; at
            fontScale >= 1.3 on a short device that overflows and the bottom
            controls — which since Phase 3 are the ONLY doors to "I have an
            invite code" and to buying Enterprise — become unreachable with no
            way to scroll to them. `flexGrow: 1` + `justifyContent: 'center'`
            keeps the centred look whenever it does fit. A render test cannot
            see this class of failure, so it is a deliberate structural fix
            rather than a measured one. */}
        <ScrollView
          contentContainerStyle={styles.gateWrap}
          showsVerticalScrollIndicator={false}>
          <View style={styles.gateIcon}>
            <Icon name="forum-outline" size={38} color={OB.accentSoft} />
          </View>
          <Text style={styles.gateTitle}>Department Channels</Text>
          {/* A7.3 — this is the screen a would-be member lands on, and it said
              "part of a service-provider organisation workspace — managers
              create channels and add their CPOs and staff" / "Managers post;
              CPOs read". Both carry the Employee/CPO wording A7.3 asks to drop,
              and "service-provider" is wrong for an Enterprise company
              workspace besides.

              WHY THIS COPY IS NOUN-FREE RATHER THAN `deptEmployeeNoun(true)`.
              The helper derives the noun from the SIGNED-IN tenant, and this
              branch renders only when `hasDeptChannels` is false — i.e. for
              someone with no tenancy and no Enterprise tier. Both helpers take
              their non-Enterprise arm for every account that can reach this
              screen, so interpolating one here would have rendered "Employees
              read" (or "CPOs read") to the exact audience A7.3 is about: a swap
              of one banned label for the other. The entitled empty state below
              still uses the helper, because THAT audience has a tenant to
              derive from. */}
          <Text style={styles.gateSub}>
            Department channels are part of an organisation workspace — admins
            create channels and add their team. Once you're added to a
            workspace, your channels appear here.
          </Text>
          <View style={styles.gateBullets}>
            {[
              'Board, department and incident channels',
              'Same AES-256 Signal Protocol encryption as all Bravo chats',
              'Admins post, everyone else reads — unread badges per channel',
            ].map(b => (
              <View key={b} style={styles.gateBulletRow}>
                <Icon name="check-circle" size={15} color={OB.signal} />
                <Text style={styles.gateBulletText}>{b}</Text>
              </View>
            ))}
          </View>
          {/* THE APPLICANT'S WAY IN AND BACK (M5 / M11A).
              This gate is exactly where a would-be member lands, so it is where
              both entries belong. Routed via openJoinFlowScreen — these
              routes live in MessengerNavigator and this screen is mounted in
              more than one shell, where a bare navigate is silently dropped. */}
          <JoinCta joinStatus={joinStatus} hasInvite={hasInvite} isOrgAffiliated={isOrgAffiliated} canCreateWorkspace={canCreateWorkspace} navigation={navigation} />
          {/* M1A — GroupsScreen's locked card used to raise the upgrade dialog
              directly. Now that it routes here instead (so a code-holder has a
              door), this gate owns the purchase path too, or buying Enterprise
              becomes unreachable from the feature that advertises it. */}
          <TouchableOpacity
            style={styles.gateUpgrade}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="View Enterprise plans"
            onPress={openPricing}>
            <Icon name="star-four-points-outline" size={15} color={OB.signal} />
            <Text style={styles.gateUpgradeText}>View Enterprise plans</Text>
          </TouchableOpacity>
          <Text style={styles.gateHint}>Ask your organisation admin for access.</Text>
        </ScrollView>
      </View>
    );
  }

  // ── Entitled: real channel directory ──────────────────────────────────
  return (
    <View style={[styles.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ChannelsHeader
        onBack={navigation.canGoBack() ? () => navigation.goBack() : undefined}
        onManage={isManager ? () => navigation.navigate('ManageChannels') : undefined}
      />

      {/* M1A rule 16 — attendance + incident reporting live in the full
          workspace shell (the same navigator providers mount). Managers run
          shifts/reviews/queues there; employees check in and report. Hidden
          when we're already inside that shell (Attend/Incident tabs below do
          the same job) — see `inDepartmentalShell` above. */}
      {/* vs2 item 17b — the FOURTH advertising surface. This row offers both
          modules at once, so it goes only when BOTH are hidden; with one
          hidden its subtitle would over-promise, so that narrows too. */}
      {!inDepartmentalShell && (showAttendance || showIncidents) && (
        <TouchableOpacity
          style={styles.workspaceRow}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel="Open attendance and incident reporting"
          onPress={openAttendanceTab}>
          <View style={styles.workspaceIcon}>
            <Icon name="calendar-check-outline" size={19} color={OB.accentSoft} />
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={styles.workspaceTitle}>
              {moduleRowTitle(showAttendance, showIncidents)}
            </Text>
            <Text style={styles.workspaceSub}>
              {moduleRowSubtitle(isManager, showAttendance, showIncidents)}
            </Text>
          </View>
          <Icon name="chevron-right" size={20} color={OB.textMute} />
        </TouchableOpacity>
      )}

      {/* ABOVE the loading/empty/list fork, deliberately (R6-1).
          Placed inside the list branch it was invisible to the exact persona
          this phase is for: a tier-only Enterprise individual holds no
          membership rows, so `listChannels` returns nothing and they land in
          the EMPTY branch — permanently. That is R5-1 recurring one level
          down: present in the file, rendered in a branch the persona never
          enters. It renders itself null once they are in an org with nothing
          outstanding, so hoisting costs the other personas nothing. */}
      <JoinCta joinStatus={joinStatus} hasInvite={hasInvite} isOrgAffiliated={isOrgAffiliated} canCreateWorkspace={canCreateWorkspace} navigation={navigation} />

      {loading ? (
        <View style={styles.loader}>
          <LoadingView label="Loading channels…" />
        </View>
      ) : loadError ? (
        <View style={styles.errorWrap}>
          <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        </View>
      ) : channels.length === 0 ? (
        <View style={styles.emptyWrap}>
          <View style={styles.gateIcon}>
            <Icon name="forum-outline" size={34} color={OB.textMute} />
          </View>
          <Text style={styles.emptyText}>No channels yet</Text>
          {isManager ? (
            // M1A rule 16 — an owner/manager (incl. an Enterprise individual)
            // creates channels and enrolls employees right here, not via ops.
            <>
              <Text style={styles.emptySub}>
                Create your first channel, then add your team under {deptEmployeeNoun(true)}.
              </Text>
              <View style={styles.emptyCtas}>
                <TouchableOpacity
                  style={styles.emptyCta}
                  onPress={() => navigation.navigate('ManageChannels')}
                  accessibilityRole="button">
                  <Icon name="plus-circle-outline" size={16} color="#FFF" />
                  <Text style={styles.emptyCtaText}>Create channel</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.emptyCta, styles.emptyCtaGhost]}
                  // A7.3 — 'Employees' here is the ROUTE NAME and must not be
                  // renamed; only the visible label below follows the noun.
                  onPress={() => navigation.navigate('Employees')}
                  accessibilityRole="button">
                  <Icon name="account-multiple-plus-outline" size={16} color={OB.accentSoft} />
                  <Text style={[styles.emptyCtaText, {color: OB.accentSoft}]}>{deptEmployeeNoun(true)}</Text>
                </TouchableOpacity>
              </View>
            </>
          ) : (
            // vs2 edge P3-3 — the old line named the "Ops console", which a
            // member has no access to and which is not where their admin
            // creates channels. Point at the person who can actually act.
            <Text style={styles.emptySub}>Your organisation admin hasn&apos;t created channels yet.</Text>
          )}
        </View>
      ) : (
        <ScrollView
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => { void onRefresh(); }} tintColor={OB.accentSoft} />
          }
          contentContainerStyle={[styles.list, {paddingBottom: (inDepartmentalShell ? 0 : insets.bottom) + 28}]}>

          {/* vs2 item 6 — "Manage Channels must be findable: blue button on the
              channels screen (admin-only); cog stays as secondary." The cog in
              the header is unchanged; this is the discoverable route. */}
          {isManager && isWorkspace && (
            <TouchableOpacity
              style={styles.manageCta}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel="Manage Channels"
              onPress={() => navigation.navigate('ManageChannels')}>
              <Icon name="file-tree" size={16} color="#FFF" />
              <Text style={styles.manageCtaText}>Manage Channels</Text>
            </TouchableOpacity>
          )}

          {/* Summary chips — Channels · Unread · Admin. */}
          <View style={styles.chipRow}>
            <StatChip value={channels.length} label="Channels" tint />
            <StatChip value={totalUnread} label="Unread" tint={totalUnread > 0} accentValue={totalUnread > 0} />
            <StatChip
              value={adminPeople ?? adminCount}
              label={adminPeople !== null ? (adminPeople === 1 ? 'Admin' : 'Admins') : 'Managed'}
              tint={false}
            />
          </View>

          {/* B-625 (client, 2026-08-22) — find a channel fast. Placed exactly
              where they drew it: under the stat row, above the list.
              B-636 (client, 2026-08-23) — it searches the words INSIDE the
              chats too, so the placeholder says so: an affordance nobody can
              see is one nobody uses, and the whole report was "this should
              also…". The accessibilityLabel is UNCHANGED — it is the handle
              every existing test presses. */}
          <View style={styles.searchRow}>
            <Icon name="magnify" size={16} color={OB.textMute} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder="Search channels and messages…"
              placeholderTextColor={OB.textMute}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel="Search channels"
            />
            {searching && (
              <TouchableOpacity
                onPress={() => setQuery('')}
                hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
                accessibilityRole="button"
                accessibilityLabel="Clear channel search">
                <Icon name="close-circle" size={16} color={OB.textMute} />
              </TouchableOpacity>
            )}
          </View>

          {/* An honest empty state — a blank area reads as a broken screen.
              B-636 — and honest about WHICH searches actually ran. The body
              scan is debounced and asynchronous, so declaring "no messages
              match" while it is still in flight is a lie the user sees for
              200ms+ on every query; and below MESSAGE_SEARCH_MIN_CHARS it never
              runs at all, which the copy says rather than implying an empty
              result. */}
          {searching && visibleSections.length === 0 && messageSections.length === 0 && (
            <Text style={styles.searchEmpty}>
              {!shouldSearchMessages(query)
                ? `No channels match “${query.trim()}”. Type one more character to search inside chats.`
                : (msgBusy || msgQuery !== query)
                  ? 'Searching messages…'
                  : `No channels or messages match “${query.trim()}”.`}
            </Text>
          )}

          {/* Scope v2 Phase 1 — level grouping (M8), shown PROGRESSIVELY.
              Until an org actually builds a hierarchy every channel is level 1,
              so level sections would collapse the whole list into one "Main
              channels" block and DESTROY the existing Board/Department/Incident
              separation for every current org — a regression in exchange for a
              feature they aren't using yet. So: keep the type grouping until a
              hierarchy exists, then switch to the PDF's level grouping (the
              type still reads per row, via its glyph).
              Incident/restricted rows only arrive when the server seeded
              membership; normal members never receive them, so this is
              presentation only, never a visibility decision. */}
          {/* vs2 item 6 — ORGANISATION FIRST, on the workspace tenant.
              "Only after selecting a main channel do you see Sub / Sub-sub."
              The level sections below stay for agencies and for legacy FLAT
              workspaces, where an organisation list would be five one-item
              organisations nobody created. */}
          {orgFirst ? (
            /**
             * items 02 + 03 + 06 + 11b — ONE colour-coded, collapsible tree.
             *
             * This replaces FOUR separate sections (ORGANISATIONS, CHANNELS,
             * ANNOUNCEMENTS, OTHER CHANNELS) and the drill-in they fed. The PDF
             * asked for exactly that: "Every hierarchy level must be
             * collapsible/expandable… users should only open the branches they
             * need", which is one screen with dropdowns, not a drill-down.
             *
             * ITEM 02 FALLS OUT OF IT. The global "ANNOUNCEMENTS" heading is
             * gone — a #broadcast is a LATERAL now (isLateralRow), so it draws
             * as a neutral card under the level it was created in, which is
             * precisely what the founder asked for. Nothing is filtered away, so
             * no door is lost even before the legacy rows are purged.
             */
            visibleSections.map(section => (
              <View
                key={`org-${section.orgId ?? 'none'}`}
                testID={`org-section-${section.orgId ?? 'none'}`}
                style={visibleSections.length > 1 ? styles.orgSection : undefined}>
                {/* B-624 — the header names the ORGANISATION this block belongs
                    to, and renders ONLY when there is more than one of them: a
                    single-tenant user must see no new chrome ("the UI is
                    perfect, just rearrangement of the threads"). `numberOfLines`
                    because this label is DATA — an unbounded org name in the
                    uppercase mono style wraps to a dozen lines. */}
                {visibleSections.length > 1 && (
                  <SectionLabel numberOfLines={2}>
                    {sectionLabels.get(section.orgId) ?? ''}
                  </SectionLabel>
                )}
                <ChannelTree
                  nodes={section.nodes}
                  collapsed={collapsed}
                  onToggle={toggleNode}
                  isExpandable={id => hasExpandableChildren(treeNodes, id)}
                  onOpen={node => {
                    const c = byId.get(node.row.id);
                    if (c) { void openChannel(c); }
                  }}
                  metaFor={node => {
                    const c = byId.get(node.row.id);
                    return {
                      groupConversationId: c?.group_conversation_id,
                      busy: provisioning === node.row.id,
                      // The M8 mockup renders "N members" per row. Permission-aware
                      // by construction: it counts a channel the caller is already
                      // a member of. Falls back to the honest provisioning state.
                      subtitle: typeof c?.member_count === 'number'
                        ? `${c.member_count} member${c.member_count === 1 ? '' : 's'}`
                        : (c?.group_conversation_id ? undefined : 'Not yet active'),
                    };
                  }}
                />
              </View>
            ))
          ) : LEVELS.map(level => {
            const group = searchedChannels.filter(c => levelOf(c) === level);
            if (group.length === 0) {return null;}
            // `level + 1` is the display tier — this list keys on the STORED
            // 0-based column. Upper-cased to keep the section-header voice the
            // rest of this screen uses, not because the name is stored that way.
            const label = `LEVEL ${level + 1} — ${nameForTier(level + 1, levelNames).toUpperCase()}`;
            return (
              <View key={`lvl-${level}`} style={styles.groupBlock}>
                <SectionLabel>{label}</SectionLabel>
                <Card style={styles.groupCard}>
                  {group.map((c, i) => (
                    <ChannelRow
                      key={c.id}
                      c={c}
                      icon={iconForType(c.channel_type)}
                      last={i === group.length - 1}
                      busy={provisioning === c.id}
                      onPress={() => { void openChannel(c); }}
                    />
                  ))}
                </Card>
              </View>
            );
          })}

          {/* B-636 — the message half of the search, UNDER the channel results.
              Order is the answer to "which did you mean": a channel whose NAME
              matches is the stronger, cheaper hit and stays on top; the bodies
              follow. Rendered only while searching, so the unsearched screen is
              byte-identical to what shipped. */}
          {searching && (
            <ChannelMessageHits
              sections={messageSections}
              labelFor={orgId => sectionLabels.get(orgId) ?? ''}
              // The same rule the tree uses for its own headings: a heading on a
              // single-organisation screen is noise.
              showOrgLabels={allOrgSections.length > 1}
              onOpen={hit => {
                const c = byId.get(hit.channelId);
                if (c) { void openChannel(c); }
              }}
            />
          )}
        </ScrollView>
      )}
    </View>
  );
}

// Per-channel row. Unread is read from the encrypted messenger store (the relay
// holds only ciphertext). An un-provisioned channel (no Signal group) reads as
// INACTIVE — otherwise the shared channelStateMeta drives the badge (PDF p.4).
function ChannelRow({c, icon, last, busy, onPress}: {
  c: DepartmentChannelDto;
  icon: IconName;
  last: boolean;
  busy: boolean;
  onPress: () => void;
}) {
  const unread = useChannelUnread(c.group_conversation_id);
  const hot = unread > 0;
  const state = c.group_conversation_id
    ? channelStateMeta({channel_type: c.channel_type, access: c.access, post_mode: c.post_mode, is_broadcast: c.is_broadcast, my_role: c.my_role})
    : {label: 'Inactive', color: OB.textMute};
  const tone = badgeTone(state.color);

  return (
    <TouchableOpacity
      style={[styles.row, !last && styles.rowDivider]}
      activeOpacity={0.8}
      disabled={busy}
      onPress={onPress}>
      <View style={[styles.rowIcon, hot && styles.rowIconHot]}>
        <Icon name={icon} size={20} color={hot ? OB.accentSoft : OB.accent} />
      </View>
      <View style={{flex: 1, minWidth: 0}}>
        <View style={styles.rowNameLine}>
          <Text style={[styles.rowName, hot && styles.rowNameHot]} numberOfLines={1}>{c.name}</Text>
          <View style={[styles.badge, {borderColor: tone.bd, backgroundColor: tone.bg}]}>
            <Text style={[styles.badgeText, {color: tone.fg}]} numberOfLines={1}>{state.label}</Text>
          </View>
        </View>
        {/* M8 mockup renders "N members" on every row, next to the channel
            name. Permission-aware by construction: the count comes from a
            channel the caller is already a member of. */}
        <Text style={styles.rowPreview} numberOfLines={1}>
          {typeof c.member_count === 'number'
            ? `${c.member_count} member${c.member_count === 1 ? '' : 's'}`
            : (c.department ?? (c.group_conversation_id ? 'Tap to open' : 'Not yet active'))}
        </Text>
      </View>
      {busy ? (
        <ActivityIndicator color={OB.accentSoft} size="small" />
      ) : hot ? (
        <UnreadPill count={unread} />
      ) : (
        <Icon name="chevron-right" size={18} color={OB.textMute} />
      )}
    </TouchableOpacity>
  );
}

// channelStateMeta returns OB palette colors (some are rgba() strings, so hex-alpha
// concat is unsafe). Map each state colour to a valid {fg,bg,border} badge tone —
// accent / good / warn are tinted, everything else (read-only, inactive) is neutral.
function badgeTone(color: string): {fg: string; bg: string; bd: string} {
  switch (color) {
    case OB.accentSoft: return {fg: OB.accentSoft, bg: 'rgba(91,141,239,0.14)', bd: 'rgba(91,141,239,0.4)'};
    case OB.signal:     return {fg: OB.signal, bg: 'rgba(74,222,128,0.13)', bd: 'rgba(74,222,128,0.36)'};
    case OB.amber:      return {fg: OB.amber, bg: 'rgba(226,200,147,0.13)', bd: 'rgba(226,200,147,0.36)'};
    default:            return {fg: OB.textDim, bg: 'rgba(255,255,255,0.05)', bd: OB.hair2};
  }
}

function StatChip({value, label, tint, accentValue}: {
  value: number; label: string; tint: boolean; accentValue?: boolean;
}) {
  return (
    <View style={[styles.chip, tint ? styles.chipTint : styles.chipPlain]}>
      <Text style={[styles.chipValue, accentValue && {color: OB.accentSoft}]}>{value}</Text>
      <Text style={styles.chipLabel}>{label}</Text>
    </View>
  );
}

/**
 * item 07 — `onBack` is OPTIONAL now.
 *
 * This screen is the root of the workspace shell's Channels tab, which item 07
 * made VISIBLE. A tab root has nothing to pop, so an unconditional chevron
 * dispatches a GO_BACK that bubbles to the tab router and reads as "the app
 * moved on its own". It is still a real back on the pushed path (from
 * MessengerHome), so the affordance is gated rather than removed.
 *
 * Note this screen renders its own header instead of ObHeader, so it does NOT
 * inherit ObHeader's BB-7 double-tap guard — another reason not to leave a
 * dead-but-live chevron here.
 */
function ChannelsHeader({onBack, onManage}: {onBack?: () => void; onManage?: () => void}) {
  return (
    <View style={styles.header}>
      {onBack ? (
        <TouchableOpacity
          style={styles.hBtn}
          onPress={onBack}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="chevron-left" size={20} color={OB.text} />
        </TouchableOpacity>
      ) : <View style={styles.hSpacer} />}
      <View style={styles.hMeta}>
        <Text style={styles.hTitle}>Channels</Text>
        <Text style={styles.hSub}>Team threads · unread counts</Text>
      </View>
      {onManage ? (
        <TouchableOpacity
          style={[styles.hBtn, styles.hBtnAccent]}
          onPress={onManage}
          hitSlop={{top: 10, bottom: 10, left: 10, right: 10}}
          activeOpacity={0.7}>
          <Icon name="cog-outline" size={19} color={OB.accentSoft} />
        </TouchableOpacity>
      ) : (
        <View style={styles.hSpacer} />
      )}
    </View>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  loader: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  errorWrap: {paddingHorizontal: 20, paddingTop: 12},

  // Header
  header: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 16, paddingTop: 6, paddingBottom: 14,
    borderBottomWidth: 1, borderBottomColor: OB.hair,
  },
  hBtn: {
    width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)', borderWidth: 1, borderColor: OB.hair2,
  },
  hBtnAccent: {backgroundColor: 'rgba(91,141,239,0.10)', borderColor: 'rgba(91,141,239,0.28)'},
  hSpacer: {width: 40},
  hMeta: {flex: 1},
  hTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 20, letterSpacing: -0.4},
  hSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12, marginTop: 2},

  // List
  list: {paddingHorizontal: 20, paddingTop: 20},

  chipRow: {flexDirection: 'row', gap: 8, marginBottom: 14},
  searchRow: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: 12, minHeight: 42, paddingVertical: 6, borderRadius: 12, marginBottom: 18,
    backgroundColor: 'rgba(255,255,255,0.04)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)',
  },
  searchInput: {flex: 1, minWidth: 0, color: OB.text, fontFamily: BravoFont.sans, fontSize: 13, padding: 0},
  searchEmpty: {color: OB.textMute, fontFamily: BravoFont.sans, fontSize: 12, paddingVertical: 18, textAlign: 'center'},
  chip: {flex: 1, borderRadius: 16, paddingVertical: 12, paddingHorizontal: 16, borderWidth: 1},
  chipTint: {backgroundColor: 'rgba(91,141,239,0.07)', borderColor: 'rgba(91,141,239,0.24)'},
  chipPlain: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: OB.hair2},
  chipValue: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22, letterSpacing: -0.5},
  chipLabel: {
    color: OB.textMute, fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '600',
    letterSpacing: 1, textTransform: 'uppercase', marginTop: 2,
  },

  groupBlock: {marginBottom: 24},
  groupCard: {padding: 0},
  // B-624 — applied only when a second organisation exists, so the
  // single-tenant screen keeps its exact spacing.
  orgSection: {marginBottom: 20},

  row: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 15, paddingHorizontal: 16},
  rowDivider: {borderBottomWidth: 1, borderBottomColor: OB.hair},
  rowIcon: {
    width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.08)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.2)',
  },
  rowIconHot: {backgroundColor: 'rgba(91,141,239,0.16)', borderColor: 'rgba(91,141,239,0.4)'},
  rowNameLine: {flexDirection: 'row', alignItems: 'center', gap: 8},
  rowName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16.5, letterSpacing: -0.3, flexShrink: 1},
  rowNameHot: {fontFamily: BravoFont.extraBold},
  rowPreview: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5, marginTop: 3},

  badge: {flexShrink: 0, maxWidth: '42%', paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, borderWidth: 1},
  badgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 1, textTransform: 'uppercase'},


  // Empty
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 32},
  emptyText: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 16, marginTop: 4},
  emptySub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12.5, textAlign: 'center', lineHeight: 18},
  emptyCtas: {flexDirection: 'row', gap: 10, marginTop: 16},
  workspaceRow: {flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginBottom: 4, padding: 14, borderRadius: 16, borderWidth: 1, borderColor: OB.hair2, backgroundColor: 'rgba(255,255,255,0.03)'},
  workspaceIcon: {width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.3)'},
  workspaceTitle: {color: OB.text, fontFamily: BravoFont.semiBold, fontSize: 13.5},
  workspaceSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  emptyCta: {flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: OB.accent, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 11},
  emptyCtaGhost: {backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)'},
  // vs2 item 6 — the discoverable Manage Channels route. Cobalt accent, 8pt
  // grid, one primary action on the surface (the cog stays secondary).
  manageCta: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    backgroundColor: OB.accent, borderRadius: 12, paddingVertical: 12,
    paddingHorizontal: 16, marginBottom: 16,
  },
  manageCtaText: {color: '#FFF', fontFamily: BravoFont.semiBold, fontSize: 13},
  emptyCtaText: {color: '#FFF', fontFamily: BravoFont.semiBold, fontSize: 13},

  // Gate
  // flexGrow (not flex) — a ScrollView contentContainer must be able to grow
  // PAST the viewport, which `flex: 1` forbids; that is what clipped the CTAs.
  gateWrap: {flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28, paddingVertical: 24, gap: 14},
  gateIcon: {
    width: 84, height: 84, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.10)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.25)',
  },
  gateTitle: {color: OB.text, fontFamily: BravoFont.extraBold, fontSize: 22},
  gateSub: {color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 13, textAlign: 'center', lineHeight: 19},
  gateBullets: {alignSelf: 'stretch', gap: 10, marginTop: 4},
  gateBulletRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  gateBulletText: {flex: 1, color: OB.textDim, fontFamily: BravoFont.regular, fontSize: 12.5},
  gateCta: {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:8, paddingVertical:12, paddingHorizontal:18, borderRadius:12, borderWidth:1, borderColor:OB.accent + '4D', backgroundColor:OB.accent + '14', marginTop:18},
  gateCtaText: {color:OB.accentSoft, fontSize:13, fontWeight:'700'},
  gateUpgrade: {flexDirection:'row', alignItems:'center', justifyContent:'center', gap:7, paddingVertical:10, paddingHorizontal:16, marginTop:10, marginBottom:4},
  gateUpgradeText: {color:OB.signal, fontSize:12.5, fontWeight:'700'},
  gateHint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11},
}));
