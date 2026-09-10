import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, RefreshControl, TouchableOpacity, BackHandler, ActivityIndicator} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import type {MessengerStackParamList} from '@navigation/types';
import {departmentApi, type ManagedChannelDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, ErrorState, loadErrorText, channelStateMeta, useInDepartmentalShell} from './_obsidian';
import {fromManaged, topLevelOf, subtreeOf, serverKnowsHierarchy, buildChannelTree,
  visibleTreeNodes, hasExpandableChildren, serverKnowsLaterals,
  nestParentedBroadcasts} from './organisationTree';
import {ChannelTree} from './ChannelTree';
import {collidingOrgNames, orgDisambiguator, needsOrgDisambiguator, shortOrgRef} from './orgDisambiguation';
import {useIsWorkspaceTenant} from './workspaceTenant';
import {nameForTier, tierFromLevel} from './levelNames';
import {orgApi} from '@services/api';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type IconName = React.ComponentProps<typeof Icon>['name'];

/**
 * PDF checklist line 9 — the tier vocabulary is ADMIN-CHOSEN now.
 *
 * This array used to BE the vocabulary, and was one of four drifted copies
 * (see `levelNames.ts`). It is gone; `nameForTier` resolves a tier against the
 * org's chosen names and falls back to the same built-ins, so an org that has
 * chosen nothing reads exactly as before.
 */

const TYPE_META: Record<ManagedChannelDto['channel_type'], {label: string; icon: IconName}> = {
  board: {label: 'Board', icon: 'bullhorn-variant-outline'},
  department: {label: 'Department', icon: 'pound'},
  incident: {label: 'Incident', icon: 'shield-alert-outline'},
};

export default function ManageChannelsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const [channels, setChannels] = useState<ManagedChannelDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // F15 — a failure must not read as "no channels yet".
  const [loadError, setLoadError] = useState<string | null>(null);
  /**
   * vs2 edge A3 — is THIS ORG a workspace, as opposed to "does this USER have
   * any workspace affiliation"? `undefined` = the server did not say (old
   * build), which falls back to the user-level flag below.
   *
   * Kept across a failed refetch on purpose: `load` deliberately KEEPS the rows
   * on error, and a tenant flag that reset to undefined while the rows stayed
   * would repaint the whole screen in the other tenant's shape mid-session.
   */
  const [serverTenant, setServerTenant] = useState<boolean | undefined>(undefined);
  /**
   * G5 — the organisation roots this admin is scoped to, or `null`/`undefined`
   * for unscoped. Kept across a failed refetch for the same reason
   * `serverTenant` is: `load` deliberately KEEPS the rows on error, and a scope
   * that reset while the rows stayed would silently widen the screen back to
   * every organisation mid-session.
   */
  const [scopeRoots, setScopeRoots] = useState<string[] | null | undefined>(undefined);
  /**
   * PDF checklist line 9 — the org's chosen tier vocabulary.
   *
   * Its own fetch rather than a field on listManagedChannels: the names are a
   * per-ORG setting and that endpoint is per-CHANNEL, so widening it would put
   * the same four strings on every row of a hundred-row response. Failing to
   * load leaves it undefined, which resolves to the built-ins.
   */
  const [levelNames, setLevelNames] = useState<string[] | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void orgApi.workspaceSettings()
      .then(r => { if (alive) {setLevelNames(r.data.levelNames);} })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  /** A channel's tier NOUN. `manageLevelOf` is the stored level, so it goes
   *  through `tierFromLevel` — the same approximation this screen always made,
   *  now stated in one place instead of inline at three call sites. */
  const tierNoun = useCallback(
    (c: ManagedChannelDto) => nameForTier(tierFromLevel(manageLevelOf(c)), levelNames),
    [levelNames]);

  const load = useCallback(async () => {
    try {
      const {data} = await departmentApi.listManagedChannels();
      setChannels(data.channels ?? []);
      // Adopted on EVERY success, including when the field is absent. Guarding
      // on `typeof === 'boolean'` also made it survive a 200 that omitted it —
      // and during a rolling auth deploy a refetch can land on an old instance,
      // which would pair the NEW org's rows with the PREVIOUS org's answer.
      // Rows and shape describing different orgs is the exact thing this fixes.
      setServerTenant(data.workspace_tenant);
      // Adopted on EVERY success for the same reason as the tenant above: rows
      // and scope describing different states is what this pairing prevents.
      setScopeRoots(data.manager_scope_root_ids);
      setLoadError(null);
    } catch (e) {
      // KEEP the rows. Blanking them turned one blip on the primary admin flow
      // (stage 2 -> ChannelEditor -> back -> focus refetch) into a full-screen
      // error that also dropped the admin out of the organisation they were
      // inside. OrgChannelTreeScreen already made this call; the two admin and
      // member surfaces should not disagree about what a blip means.
      setLoadError(loadErrorText(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  // A9 — BOTH lists are tree-ordered. Archived is not a flat recycle bin: the
  // archive guard refuses a parent with active children, so a branch must be
  // archived bottom-up and parent+children always land here TOGETHER. An
  // un-ordered archived list was therefore guaranteed to draw a false tree, not
  // an edge case.
  const active = treeOrder(channels.filter(c => !c.archived));

  /**
   * vs2 item 8 — CREATE CHANNELS, organisation-scoped.
   *
   * "Select an organisation (or create a new one) → per-org channel dashboard
   * showing the full hierarchy." Two stages, like the invite picker, and for the
   * same reason: a flat list of every channel in every organisation is the pile
   * this scope exists to replace.
   *
   * `collapseChildless` is DELIBERATELY not passed (defaults false). A freshly
   * created organisation is childless by definition — collapsing it would make
   * it invisible here, and the admin could never drill in to add its first
   * channel. The create flow would dead-end on its very first use.
   */
  /**
   * vs2 edge A3 — THE ORG ON SCREEN, not the person looking at it.
   *
   * `useIsWorkspaceTenant()` is true for anybody with any workspace affiliation
   * at all, and it was the only signal here. So an agency company/manager who
   * had also joined an Enterprise workspace opened their AGENCY's Manage
   * Channels and got the workspace-shaped UI: flat agency channels rendered as
   * "organisation" cards, the New-channel footer gone, and — the damaging part —
   * an editor that DROPS the DEPARTMENT and TYPE fields, so new agency channels
   * were written with `department = null`. In an agency that column is the live
   * branch-scope key for attendance, incidents and invite minting, and a null
   * department also makes the channel mintable by every manager.
   *
   * Do NOT try to narrow the client heuristic instead — the user-level signal is
   * genuinely ambiguous for this persona (it already defeated the Rev-9 tenant
   * predicate). The server knows the org; it now says so.
   *
   * SAFETY PROPERTY, worth knowing before you widen this: the fix can only ever
   * narrow true→false. A server `true` means an `org_workspaces` row for the
   * resolved org, and every route to such an org also lights `owns_workspace`,
   * `org_is_workspace` or `workspaces[]` — so `serverTenant` true with
   * `userTenant` false is not producible by real data. The false direction, the
   * one that saves the agency's branch key, is the reachable one.
   */
  const userTenant = useIsWorkspaceTenant();
  const isWorkspace = serverTenant ?? userTenant;
  /**
   * ONE place that opens the editor, so the tenant fact cannot be attached at
   * six of seven call sites. (This screen is the only door to ChannelEditor.)
   */
  const openEditor = useCallback(
    (params: Omit<NonNullable<MessengerStackParamList['ChannelEditor']>, 'workspaceTenant'>) =>
      // `serverTenant`, NOT the resolved `isWorkspace`. Passing the resolved
      // value is always a boolean, which pins the editor to whatever the
      // fallback happened to be at tap time and kills its own `??` chain — so a
      // tap before the list landed froze the editor on the user-level flag for
      // its whole life. Undefined must stay undefined for the compat path to
      // mean anything.
      navigation.navigate('ChannelEditor', {...params, workspaceTenant: serverTenant}),
    [navigation, serverTenant],
  );
  /**
   * G4 — a broadcast that HAS a parent joins the tree as a lateral under it, so
   * it is managed inside the organisation it belongs to instead of from a
   * global list that cannot say which organisation that is. Parentless legacy
   * rows are untouched and keep the section further down.
   */
  const treeRows = useMemo(
    () => nestParentedBroadcasts(fromManaged(channels.filter(c => !c.archived))), [channels]);
  /**
   * G5 — "Admins should not be able to see other organizations."
   *
   * A NON-EMPTY array narrows stage 1; `null` (unscoped: owner, agency, or no
   * seeded membership) and `undefined` (old server) both leave it exactly as it
   * was.
   *
   * The `length > 0` arm is DEFENCE IN DEPTH and is stated as such: an `[]`
   * would today be caught one level down by the fail-open in `orgs`, so this
   * line changes no behaviour on its own and no test can tell it apart. It is
   * here because the two guards protect against different mistakes — this one
   * against a server that starts sending `[]`, the fail-open against the two
   * sides walking different row sets — and a future refactor is likely to touch
   * only one of them.
   *
   * The narrowing is applied to `orgs` alone, not to `treeRows`: stage 2, the
   * counts and the archived list all still resolve parents through the full
   * row set, so a scoped admin never sees a "(not shown)" rung invented by
   * their own scope.
   */
  const scoped = useMemo(
    () => (Array.isArray(scopeRoots) && scopeRoots.length > 0 ? new Set(scopeRoots) : null),
    [scopeRoots]);
  /**
   * Which organisation ROOT does a channel belong to?
   *
   * Walked over the FULL channel list, ARCHIVED rows included, because the
   * SERVER walks that same set — and the two sides disagreeing about a row set
   * is the whole reason the fail-opens below exist. An archived leaf's parent
   * is usually archived too, so resolving against the live rows only would
   * strand it at itself.
   *
   * The hop bound mirrors the server's four and `organisationTree`'s MAX_DEPTH:
   * cycles cannot occur through the DB (re-parenting is refused) but an
   * unbounded walk over server-shaped data must never spin.
   */
  const rootOf = useMemo(() => {
    const parentOf = new Map(channels.map(c => [c.id, c.parent_id ?? null]));
    return (id: string): string => {
      let cur = id;
      for (let hop = 0; hop <= 4; hop++) {
        const p = parentOf.get(cur) ?? null;
        if (!p || !parentOf.has(p)) {break;}
        cur = p;
      }
      return cur;
    };
  }, [channels]);
  /**
   * EVERY organisation root in the tenant, ARCHIVED ONES INCLUDED.
   *
   * `topLevelOf(treeRows)` sees only LIVE rows, and that made "does this scope
   * exclude anything?" answerable with a wrong yes/no: archive one whole
   * organisation bottom-up — the ordinary way an organisation is retired — and
   * the live root set shrinks to exactly what the scope covers, so the scope
   * reported itself inert and the ARCHIVED list plus the create-organisation
   * card both un-scoped. The admin then saw the retired organisation's name and
   * its whole archived subtree, each with a working editor door.
   *
   * Broadcasts are excluded because a parentless one terminates at itself and
   * would enter this set as a phantom "root" that no scope can ever contain.
   */
  const allRootIds = useMemo(
    () => new Set(channels.filter(c => !c.is_broadcast).map(c => rootOf(c.id))),
    [channels, rootOf]);
  const {orgs, scopeApplied} = useMemo(() => {
    const all = topLevelOf(treeRows);
    if (!scoped) {return {orgs: all, scopeApplied: false};}
    /**
     * `rootOf(id)`, not `scoped.has(id)`.
     *
     * `topLevelOf` deliberately also emits STRANDED rows — ones whose host is
     * missing from this list — flagged `isOrganisation: false`, because "a row
     * whose host is missing must still be reachable". The server's walk always
     * resolves PAST such a row to its true root, so a stranded row's own id can
     * never be in the scope set. Matching on the id alone therefore deleted
     * every stranded row and its whole subtree for a scoped admin — the one
     * shape `topLevelOf` exists to rescue.
     */
    const mine = all.filter(o => scoped.has(o.row.id) || scoped.has(rootOf(o.row.id)));
    /**
     * FAIL OPEN when the scope matches nothing, exactly as the server does.
     *
     * The two sides walk DIFFERENT row sets and the asymmetry is real: the
     * server walks every channel in the org INCLUDING archived ones, this list
     * excludes them. So a scoped admin whose organisation root has been
     * archived resolves to a root id that is not a top-level row here, the
     * filter empties, and they would open the admin dashboard on a blank screen
     * with no way to reach the organisation they are still in.
     *
     * An empty stage 1 is indistinguishable from data loss, and this scope is a
     * tidying affordance rather than an authorization boundary — every mutation
     * is still guarded server-side. Showing too much is recoverable; showing
     * nothing is a dead end.
     */
    /**
     * `scopeApplied` is decided HERE, from `mine`, and returned with `orgs`.
     *
     * It answers one question — did this scope actually EXCLUDE anything? —
     * and it is false in three ways, each of which matters:
     *
     *   - `mine` is empty, so the fail-open above put every organisation back.
     *     The admin is looking at all of them and is unscoped in every way that
     *     counts. (Derived from `mine` DIRECTLY rather than inferred from list
     *     lengths: inferring it is what made the archived case below wrong.)
     *   - there are no organisations at all, which must not hide the one card
     *     that creates the first one — the create flow dead-ending on its very
     *     first use, again.
     *   - the scope COVERS EVERY ROOT. A manager invited before G6 with the
     *     whole-workspace escape hatch is seeded org-wide
     *     (`resolveSeedScopeInTx` returns `{kind:'orgWide'}`), so the server
     *     derives every root for them. They genuinely govern the whole
     *     workspace, and calling that "scoped" took away
     *     Create-new-organisation and the legacy announcements door from
     *     someone who had both yesterday. A scope that excludes nothing is not
     *     a scope — measured against `allRootIds`, which counts ARCHIVED roots
     *     too, because an archived organisation is still one the scoped admin
     *     is not in.
     */
    const coversEveryRoot = [...allRootIds].every(id => scoped.has(id));
    return {
      orgs: mine.length > 0 ? mine : all,
      scopeApplied: mine.length > 0 && !coversEveryRoot,
    };
  }, [treeRows, scoped, rootOf, allRootIds]);
  // vs2 edge A7 — same rule as the hub and the invite picker; the surfaces do
  // not share a data source, so only the DECISION is shared.
  const collidingOrgs = useMemo(
    () => collidingOrgNames(orgs.map(o => o.row.name)), [orgs]);
  /**
   * ADMIN SURFACES NEVER COLLAPSE — gated on the TENANT alone, never on
   * whether a hierarchy already exists.
   *
   * Gating this on `hasHierarchy` closed a loop with no way out. Stage 1 is the
   * only producer of `root: true` and stage 2 the only producer of `parentId`;
   * item 7 removed the parent picker from the workspace form; and the footer
   * button sends neither. So: no hierarchy → no stages → no way to send a
   * parent or a root → no hierarchy, forever. Every workspace that exists today
   * is flat, and a clean P3 workspace starts with nothing at all, so this was
   * every workspace on the platform.
   *
   * The "five one-item organisations" argument that justifies the data gate on
   * the MEMBER directory does not apply here: this screen already passes
   * `collapseChildless: false` precisely so a childless organisation stays
   * visible and can be filled in.
   */
  /**
   * …but it IS gated on the server being able to answer.
   *
   * `topLevelOf` classifies by `parent_hidden`, and a server without the
   * hierarchy migration emits none: every row then routes to a synthetic root
   * that stage 1 drops, so an APK ahead of auth-service showed a workspace
   * admin ONE card — "Create new organisation" — with every existing channel
   * invisible and uneditable, the footer create button hidden, and the ARCHIVED
   * section still rendering underneath. That reads as data loss, and this repo
   * ships client ahead of server routinely enough that it is the likely order.
   *
   * ZERO channels is NOT an old server — it is the clean-P3 workspace this
   * screen must serve, so it keeps the stages. Only a non-empty payload with no
   * tree field anywhere falls back to the flat list.
   */
  const serverKnowsTree = channels.length === 0 || serverKnowsHierarchy(fromManaged(channels));
  const orgFirst = isWorkspace && serverKnowsTree;
  const [orgId, setOrgId] = useState<string | null>(null);
  const openOrg = orgId ? orgs.find(o => o.row.id === orgId) ?? null : null;
  /**
   * "Is this channel inside the organisation this admin was given?"
   *
   * `null` when the admin is unscoped, so every caller reads as "keep it".
   * Built on the shared `rootOf` above rather than on a second copy of the
   * parent walk — two walks over the same question is this repo's most-shipped
   * defect, and this one already exists in three other places.
   */
  const inScope = useMemo(
    () => (scopeApplied && scoped ? (id: string): boolean => scoped.has(rootOf(id)) : null),
    [rootOf, scoped, scopeApplied]);
  /**
   * G4 — ONLY THE UNPLACEABLE ONES ARE LEFT HERE.
   *
   * `placeRow` classifies a broadcast first, so `topLevelOf` skips it and
   * `childrenOf` can never return one — they appeared in NEITHER stage. This
   * screen is the only door to `ChannelEditor` in the app, so on a workspace
   * tenant #broadcast was unrenamable, unarchivable and undeletable while the
   * header pill kept counting it, and the server had just been changed to let a
   * workspace DELETE it. That is why a global section existed at all.
   *
   * `nestParentedBroadcasts` has now given every PARENTED broadcast a door
   * inside its own organisation, which is the founder's actual ask. What is
   * left is the parentless legacy shape (`seedOrgWorkspace` and the 2026-08-05
   * backfill's `level <= 1` arm both produce them) — rows that belong to no
   * organisation and so cannot be shown inside one. They keep a door, under a
   * heading that says what they are.
   *
   * ⚠️ DO NOT "finish the job" by deleting this block. Rev 4 §8's aborted-purge
   * branch: if `20260817000000` aborts for an org, that org keeps live
   * broadcast rows, and with this gone they have NO admin door anywhere. On a
   * purged or clean workspace the array is empty and nothing renders, which is
   * the founder's screenshot fixed — without betting on the purge.
   *
   * The two sets are DISJOINT BY CONSTRUCTION (`parent_id` present in the tree
   * rows vs. absent), so no row can draw twice.
   */
  /**
   * ⚠️ THE EXACT COMPLEMENT OF WHAT THE TREE NESTED — derived, never re-guessed.
   *
   * The first version re-stated the rule ("does the parent exist and is it
   * live?") and claimed the two sets were "disjoint by construction". That was
   * true for about an hour: `parentIsWalked` then added a SECOND reason a
   * broadcast might not be nested, and a row refused by that guard fell into
   * the gap between the two predicates — no stage-1 door, no stage-2 door
   * (`subtreeOf` can never return a `broadcast` placement), no section, and not
   * archived either. Zero doors, which is precisely what this section exists to
   * prevent.
   *
   * So it now asks the tree what it actually did. `nestParentedBroadcasts` is
   * the single source of that answer, and any future reason it declines to nest
   * lands here automatically instead of vanishing.
   */
  const unplacedBroadcasts = useMemo(() => {
    const nested = new Set(treeRows.filter(r => r.announcement).map(r => r.id));
    return channels.filter(c => c.is_broadcast && !c.archived && !nested.has(c.id));
  }, [channels, treeRows]);
  /**
   * …and a SCOPED admin sees only the ones that are THEIRS (G5).
   *
   * ⚠️ NOT a blanket `scopeApplied ? [] : …`, which is what this was first
   * written as and it opened a hole the section exists to close. Two very
   * different rows land in `unplacedBroadcasts`:
   *
   *   - a genuinely PARENTLESS legacy row. It belongs to no organisation, so it
   *     is not in the one a scoped admin was given, and placing or removing it
   *     is the workspace owner's job (the owner is always unscoped).
   *   - a row whose parent is merely ARCHIVED. That one IS inside a real
   *     organisation — possibly the scoped admin's own. Hiding it left a LIVE
   *     channel with no door anywhere: not in either tree stage (its parent is
   *     not in the live rows), not here, and not in ARCHIVED because it is not
   *     archived. Zero doors, for everyone but the owner.
   *
   * So the parent chain decides, through the same `inScope` walk the ARCHIVED
   * list uses — which is why that walk reads the FULL channel list, archived
   * rows included.
   */
  const visibleUnplacedBroadcasts = useMemo(
    () => (inScope
      ? unplacedBroadcasts.filter(c => !!c.parent_id && inScope(c.parent_id))
      : unplacedBroadcasts),
    [inScope, unplacedBroadcasts]);
  // Walked ONCE per organisation, not twice inside the render.
  const orgCounts = useMemo(
    () => new Map(orgs.map(o => [o.row.id, subtreeOf(treeRows, o.row.id).length - 1])),
    [orgs, treeRows]);

  // Android hardware BACK on stage 2 popped the whole screen; the only correct
  // back was a small in-content link. The header chevron had the same problem.
  const inStage2 = orgFirst && !!orgId && !loading && !(loadError && channels.length === 0);
  const [retrying, setRetrying] = useState(false);
  const retry = useCallback(async () => {
    setRetrying(true);
    await load();
    setRetrying(false);
  }, [load]);
  /**
   * items 03/04/06 — the admin tree.
   *
   * ⚠️ `collapseChildless: false` IS LOAD-BEARING, and it is the whole reason
   * buildChannelTree takes the option at all. `organisationRootsOf`'s docblock:
   * "a freshly created organisation is childless by definition, so collapsing it
   * would make it invisible in the admin org list, and the admin could never
   * drill in to add its first child. The create flow would dead-end on its very
   * first use." The member surface passes true; this one must not.
   */
  const adminNodes = useMemo(
    () => (openOrg
      ? buildChannelTree(
        treeRows.filter(r => subtreeOf(treeRows, openOrg.row.id).some(n => n.row.id === r.id)),
        {collapseChildless: false})
      : []),
    [treeRows, openOrg]);
  // Admin default is EXPANDED — the opposite of the member directory, and
  // deliberately. An admin opened this screen to see and change the structure;
  // hiding it behind chevrons would make the common task (find the level, add
  // something under it) a search. The member's problem is overpopulation; the
  // admin's is orientation.
  const [adminCollapsed, setAdminCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggleAdmin = useCallback((id: string) => {
    setAdminCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(id)) {next.delete(id);} else {next.add(id);}
      return next;
    });
  }, []);
  const visibleAdminNodes = useMemo(
    () => visibleTreeNodes(adminNodes, adminCollapsed), [adminNodes, adminCollapsed]);
  /**
   * item 04 / D-6 — hide the lateral affordance until the server PROVES it
   * speaks the protocol.
   *
   * In production `forbidNonWhitelisted` is false, so an old instance silently
   * STRIPS `lateral: true` and creates a structural child instead — frozen and
   * un-re-parentable, i.e. unfixable. PRESENCE of the field, never its value: a
   * truthiness test would deadlock (no laterals exist, so the button never
   * shows, so none can ever be made).
   */
  const lateralsSupported = useMemo(
    () => serverKnowsLaterals(fromManaged(channels)), [channels]);
  const leaveStage2 = useCallback(() => setOrgId(null), []);
  useFocusEffect(useCallback(() => {
    if (!inStage2) {return undefined;}
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { setOrgId(null); return true; });
    return () => sub.remove();
  }, [inStage2]));
  useEffect(() => { if (!orgFirst && orgId) {setOrgId(null);} }, [orgFirst, orgId]);
  const byId = useMemo(() => new Map(channels.map(c => [c.id, c])), [channels]);
  /**
   * ARCHIVED is scoped too.
   *
   * It renders workspace-wide and outside the two-stage switch (deliberately —
   * a channel can be archived out of any organisation and its unarchive door
   * must not vanish), which on a scoped admin left it as the one section on the
   * screen still naming the organisations they are not in. Same rule as stage
   * 1, one level out.
   *
   * Filtered BEFORE the walk, never after: `treeOrder` is what makes the
   * indentation truthful, and handing it a set it did not walk is precisely the
   * false-parentage its own docblock exists to prevent.
   */
  const archived = useMemo(
    () => treeOrder(channels.filter(c => c.archived && (!inScope || inScope(c.id)))),
    [channels, inScope]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title="Manage Channels"
        onBack={inStage2 ? leaveStage2 : () => navigation.goBack()}
        // In stage 2 the pill counted the WHOLE workspace while the label
        // underneath named one organisation — two different numbers claiming to
        // describe the same thing. G5 extends that rule to stage 1: a SCOPED
        // admin's pill must not count organisations the screen refuses to show
        // them, which is the same defect one level out.
        pill={loadError ? undefined
          : `${openOrg ? (orgCounts.get(openOrg.row.id) ?? 0) + 1
            : scopeApplied
              // + the unplaced rows the screen is ALSO showing underneath. The
              // unscoped arm counts them (they are in `active`), so omitting
              // them here reproduced, one section out, the very "two numbers
              // describing the same thing" this pill was fixed for.
              ? orgs.reduce((n, o) => n + (orgCounts.get(o.row.id) ?? 0) + 1, 0)
                + visibleUnplacedBroadcasts.length
              : active.length}`} />

      <ScrollView
        testID="manage-scroll"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 120}}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void load(); }} tintColor={OB.accentSoft} />}>

        {/* A strip when there is content behind it, a takeover only when there
            is not — the same rule the member tree follows. Keeping the rows is
            pointless if the error still renders instead of them. */}
        {loadError && channels.length > 0 && (
          <TouchableOpacity
            style={s.errorStrip}
            accessibilityRole="button"
            accessibilityLabel={`${loadError} Tap to retry.`}
            onPress={() => { void retry(); }}>
            {retrying
              ? <ActivityIndicator size="small" color={OB.accentSoft} />
              : <Icon name="alert-circle-outline" size={14} color={OB.alert} />}
            <Text style={s.errorStripText} numberOfLines={2}>{loadError} Tap to retry.</Text>
          </TouchableOpacity>
        )}

        {loading ? (
          <LoadingView compact label="Loading channels…" />
        ) : loadError && channels.length === 0 ? (
          <View style={{marginTop: 8}}>
            <ErrorState message={loadError} busy={retrying} onRetry={() => { void retry(); }} />
          </View>
        ) : (
          // `!orgId`, NOT `!openOrg`. An orgId that no longer resolves also
          // makes openOrg null, so keying stage 1 on the resolved value made
          // the "organisation is gone" branch below unreachable and restored
          // the silent teleport it exists to replace.
          orgFirst && !orgId ? (
            // STAGE 1 — pick an organisation, or make one.
            <View style={{marginTop: 8}}>
              <SectionLabel>ORGANISATIONS</SectionLabel>
              <View style={{gap: 10}}>
                {orgs.map(({row, isOrganisation}) => (
                  <Card key={row.id} onPress={() => setOrgId(row.id)} style={s.row}
                    // vs2 edge A7 — the LABEL disambiguates too. Fixing only the
                    // visible subtitle would leave a screen-reader user hearing
                    // "Open organisation Acme" twice, which is the same bug with
                    // the one affordance that cannot see the subtitle.
                    accessibilityLabel={[
                      `${isOrganisation ? 'Open organisation' : 'Open'} ${row.name}`,
                      shortOrgRef(row.id) && needsOrgDisambiguator(row.name, collidingOrgs)
                        ? shortOrgRef(row.id) : '',
                    ].filter(Boolean).join(', ')}>
                    <View style={s.rowIcon}>
                      <Icon name={isOrganisation ? 'domain' : 'folder-outline'} size={18} color={OB.accentSoft} />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.rowName} numberOfLines={1}>{row.name}</Text>
                      <Text style={s.rowSub} numberOfLines={1}>
                        {/* vs2 edge A7 — the channel count usually separates two
                            same-named organisations on its own; the id handle is
                            the tiebreak when the counts match too. Only on a
                            collision. */}
                        {orgDisambiguator(
                          row.name, row.id, collidingOrgs,
                          `${orgCounts.get(row.id) ?? 0} channel${orgCounts.get(row.id) === 1 ? '' : 's'} inside`,
                        ) ?? `${orgCounts.get(row.id) ?? 0} channel${orgCounts.get(row.id) === 1 ? '' : 's'} inside`}
                      </Text>
                    </View>
                    <Icon name="chevron-right" size={18} color={OB.textMute} />
                  </Card>
                ))}
                {/* G5 — "it should be organization specific only". An admin
                    scoped to one organisation does not get to mint a second
                    one; that is the workspace owner's act. Hidden rather than
                    disabled, because a disabled primary create reads as a bug.
                    Unscoped admins (owner, agency, old server) are unchanged. */}
                {!scopeApplied && (
                  <Card
                    onPress={() => openEditor({root: true})}
                    style={s.row}
                    accessibilityLabel="Create new organisation">
                    <View style={s.rowIcon}><Icon name="plus" size={18} color={OB.accentSoft} /></View>
                    <Text style={[s.rowName, {flex: 1}]}>Create new organisation</Text>
                  </Card>
                )}
              </View>

              {/* G4 — the residual door. Named for what these rows ARE: legacy
                  announcement channels that hang off no organisation, which is
                  precisely why they could announce to the wrong one. Empty
                  (and therefore invisible) on a clean or purged workspace. */}
              {visibleUnplacedBroadcasts.length > 0 && (
                <View style={{marginTop: 18}}>
                  <SectionLabel>UNPLACED ANNOUNCEMENTS</SectionLabel>
                  <View style={{gap: 10}}>
                    {visibleUnplacedBroadcasts.map(c => (
                      <Card key={c.id} style={s.row}
                        // THE LEVEL IS THE ONLY THING THAT TELLS THEM APART.
                        // `ensureBroadcastForLevel` hard-codes the name
                        // '#broadcast' and the unique index allows one per
                        // LEVEL, so a workspace seeded before this batch has up
                        // to four rows with an identical name — and the server
                        // was just taught to DELETE them, irreversibly. Four
                        // indistinguishable buttons, one of which destroys a
                        // channel, is not a UI.
                        accessibilityLabel={`Edit ${tierNoun(c)} ${c.name}`}
                        onPress={() => openEditor({channel: pick(c)})}>
                        <View style={s.rowIcon}>
                          <Icon name="bullhorn-variant-outline" size={18} color={OB.accentSoft} />
                        </View>
                        <View style={{flex: 1, minWidth: 0}}>
                          <Text style={s.rowName} numberOfLines={1}>{c.name}</Text>
                          <Text style={s.rowSub} numberOfLines={1}>
                            {/* NOT "Org-wide announcements" any more. That copy
                                was the founder's complaint in one line: it
                                describes a reach nobody chose. These rows sit
                                under no organisation, so the honest sentence is
                                that they need placing or removing. */}
                            {tierNoun(c)} · Not inside any organisation
                          </Text>
                        </View>
                        <Icon name="chevron-right" size={18} color={OB.textMute} />
                      </Card>
                    ))}
                  </View>
                </View>
              )}
            </View>
          ) : orgFirst && orgId && !openOrg ? (
            // The organisation vanished under the admin (archived elsewhere, or
            // membership changed) while they were inside it. Bouncing silently
            // to stage 1 reads as a mis-tap; the member screen says so, and so
            // does this one.
            <View style={{marginTop: 8}}>
              <Card><Text style={s.empty}>This organisation is no longer available.</Text></Card>
              <TouchableOpacity onPress={leaveStage2} style={s.backRow}
                accessibilityRole="button" accessibilityLabel="Back to organisations">
                <Icon name="chevron-left" size={18} color={OB.accentSoft} />
                <Text style={s.backText}>All organisations</Text>
              </TouchableOpacity>
            </View>
          ) : orgFirst && openOrg ? (
            // STAGE 2 — one organisation's hierarchy.
            <View style={{marginTop: 8}}>
              <TouchableOpacity onPress={() => setOrgId(null)} style={s.backRow}
                accessibilityRole="button" accessibilityLabel="Back to organisations">
                <Icon name="chevron-left" size={18} color={OB.accentSoft} />
                <Text style={s.backText}>All organisations</Text>
              </TouchableOpacity>
              <SectionLabel numberOfLines={1}>{openOrg.row.name.toUpperCase()}</SectionLabel>
              {/**
                * items 03/04/06 — the SAME renderer the member directory uses,
                * in admin mode. The PDF's §03 admin mockup adds three things per
                * level to the member view: a pencil, "+ Add lateral channel" and
                * "+ Add sub-level".
                */}
              <ChannelTree
                nodes={visibleAdminNodes}
                collapsed={adminCollapsed}
                onToggle={toggleAdmin}
                isExpandable={id => hasExpandableChildren(adminNodes, id)}
                onOpen={node => {
                  const c = byId.get(node.row.id);
                  if (c) { openEditor({channel: pick(c)}); }
                }}
                metaFor={node => {
                  const c = byId.get(node.row.id);
                  return {
                    subtitle: c
                      ? `${c.member_count} member${c.member_count === 1 ? '' : 's'}${c.provisioned ? '' : ' · not active'}`
                      : undefined,
                  };
                }}
                admin={{
                  onEdit: node => {
                    const c = byId.get(node.row.id);
                    if (c) { openEditor({channel: pick(c)}); }
                  },
                  /**
                   * ⚠️ GATED ON THE STORED `level`, NEVER ON THE DISPLAY TIER.
                   *
                   * The server refuses a child of a level-3 node
                   * (max_channel_depth_reached), and a legacy level-1-rooted
                   * workspace reaches level 3 at display tier 3 — so gating on
                   * the tier would render a button whose every tap 400s on
                   * exactly the workspaces that have been around longest.
                   */
                  onAddSubLevel: node => {
                    const c = byId.get(node.row.id);
                    if (!c || manageLevelOf(c) >= 3) { return; }
                    openEditor({parentId: node.row.id, parentName: node.row.name});
                  },
                  /**
                   * B-590 — the SAME stored-level gate, surfaced to the
                   * renderer. The handler guard above can only no-op, and a
                   * button that renders but does nothing at the depth cap is
                   * exactly what the founder reported as "I can't go further".
                   * At the cap the row is HIDDEN — the PDF's rule is four
                   * levels, so there is nothing to offer there.
                   */
                  canAddSubLevel: node => {
                    const c = byId.get(node.row.id);
                    return !!c && !(manageLevelOf(c) >= 3);
                  },
                  /**
                   * The depth cap deliberately does NOT apply here — a lateral
                   * inherits its parent's level, so one at tier 4 is still level
                   * 3 and legal. That is the entire feature: "Each level must be
                   * able to create lateral channels."
                   */
                  onAddLateral: lateralsSupported
                    ? node => openEditor({parentId: node.row.id, parentName: node.row.name, lateral: true})
                    : undefined,
                }}
              />
            </View>
          ) : (
          <>
            <View style={{marginTop: 8}}>
              <SectionLabel>CHANNELS</SectionLabel>
              {active.length === 0 ? (
                <Card><Text style={s.empty}>No channels yet. Create the first one below.</Text></Card>
              ) : (
                <View style={{gap: 10}}>
                  {active.map(({c, depth}) => (
                    <Row key={c.id} c={c} depth={depth} tierNoun={tierNoun(c)}
                      onPress={() => openEditor({channel: pick(c)})} />
                  ))}
                </View>
              )}
            </View>

          </>
        ))}

        {/* ARCHIVED lives OUTSIDE the two-stage switch, on purpose.
            Putting it inside the legacy branch made it unreachable the moment a
            workspace grew a hierarchy — an admin could archive a channel and
            then have no way to find or unarchive it. A capability that
            disappears when the UI improves is a regression, not a redesign, so
            it renders on every path. Shown at organisation level (not inside a
            drill-down) because the archive list is workspace-wide and a channel
            can be archived out of any organisation. */}
        {!loading && !loadError && archived.length > 0 && !orgId && (
          <View style={{marginTop: 22}}>
            <SectionLabel>ARCHIVED</SectionLabel>
            <View style={{gap: 10}}>
              {archived.map(({c, depth}) => (
                <Row key={c.id} c={c} depth={depth} tierNoun={tierNoun(c)}
                  onPress={() => openEditor({channel: pick(c)})} />
              ))}
            </View>
          </View>
        )}
      </ScrollView>

      {/* In-shell the ObsidianTabBar sits directly below and contributes its own
          14dp top pad + hairline, so the footer only needs a hair of clearance —
          14 here stacked two visible hairlines ~29dp apart and read as a dead band. */}
      {/* The bare "New channel" button has NO placement, so on a workspace it
          would mint yet another parentless level-1 Main — the flat shape item 8
          replaces — while the screen right above it is asking which
          organisation you mean. The workspace path has explicit, placed create
          affordances ("Create new organisation", "Create channel in X"), so
          this stays for the AGENCY and legacy-flat paths only. One primary
          action per surface, and it has to be the unambiguous one. */}
      {/* …and NOT while the tenant fact is still in flight. This footer renders
          outside the loading fork, so it was the one editor door reachable
          before the server had answered — a tap there hands the editor whatever
          the user-level fallback happened to be (edge A3). */}
      {!orgFirst && !loading && (
        <View style={[s.footer, {paddingBottom: inDepartmentalShell ? 8 : insets.bottom + 14}]}>
          <PrimaryButton label="New channel" icon="plus" onPress={() => openEditor({})} />
        </View>
      )}
    </View>
  );
}

function pick(c: ManagedChannelDto) {
  return {
    id: c.id, name: c.name, department: c.department,
    channel_type: c.channel_type, access: c.access, archived: c.archived,
    // Phase 2 — post_mode MUST round-trip. Dropping it made the editor unable
    // to tell "Standard" (members post) from "Read only" (managers post), since
    // both store access='standard'; every Save then re-sent the first matching
    // option and silently promoted every member to poster.
    post_mode: c.post_mode, is_broadcast: c.is_broadcast,
    // item 04 — WITHOUT THIS THE EDITOR CANNOT TELL A LATERAL FROM A LEVEL NODE
    // on the edit path, so it can offer neither the lateral-only "Announcements"
    // access option nor the "Lateral channel in X" placement line. Same class as
    // post_mode above: a field dropped here becomes a capability the editor
    // silently loses, and the loss is invisible because the form still renders.
    is_lateral: c.is_lateral,
    // vs2 edge A4 — the SERVER's answer to "may this person delete it", carried
    // to the editor so its Members door can offer Delete. The client must not
    // re-derive it: the old `isOwner` guess was never passed on this path at
    // all, which is why the PDF's Delete ask had no door here.
    deletable: c.deletable,
  };
}

/** Scope v2 Phase 1 — frame A9 ("Show the full authorised hierarchy: Enterprise,
 *  Main, Sub and Sub-sub Channel"). Pre-hierarchy rows carry no level and read
 *  as Main; kept in one helper so the default cannot drift between call sites. */
export const manageLevelOf = (c: ManagedChannelDto): number => c.level ?? 1;

/**
 * Depth-first order: every channel immediately followed by its own children.
 *
 * REQUIRED for the indentation to be truthful. The server returns
 * `ORDER BY (archived), level ASC, created_at DESC` — all level-1s, then all
 * level-2s — so indenting that stream draws every sub-channel under whichever
 * main happens to be last:
 *     Main A / Main B / Main C /     Sub-of-A  ← reads as a child of Main C
 * Indentation is THE signal for "child of the row above", so a level-ordered
 * stream makes it actively misleading — worse than the flat list it replaced.
 */
export interface TreeRow {c: ManagedChannelDto; depth: number}

export function treeOrder(list: ManagedChannelDto[]): TreeRow[] {
  const byParent = new Map<string | null, ManagedChannelDto[]>();
  for (const c of list) {
    const k = c.parent_id ?? null;
    const bucket = byParent.get(k);
    if (bucket) {bucket.push(c);} else {byParent.set(k, [c]);}
  }
  const out: TreeRow[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const c of byParent.get(parent) ?? []) {
      if (seen.has(c.id)) {continue;}   // cycles are impossible per the DB, but never loop forever on data
      seen.add(c.id);
      out.push({c, depth});
      walk(c.id, depth + 1);
    }
  };
  walk(null, 0);
  // Orphans: a child whose parent is filtered out of THIS list (archived, or
  // hidden from this viewer) would otherwise vanish from the screen entirely.
  // Show it — but at depth 0, NOT at its own level. Indenting an orphan draws
  // it as a child of whatever row happens to precede it, which is exactly the
  // false-parentage this function exists to prevent.
  for (const c of list) {
    if (!seen.has(c.id)) {seen.add(c.id); out.push({c, depth: 0});}
  }
  return out;
}

/**
 * `depth` is REQUIRED and comes from the treeOrder WALK — never derived here
 * from `c.level`.
 *
 * Deriving it locally is what made the indentation lie: the ordering invariant
 * lived at the call site, two functions away, with nothing tying the two
 * together. `active` was tree-ordered and `archived` was not, yet both rendered
 * through this one component — so the archived list drew every sub-channel
 * under whichever row happened to precede it. Taking depth as a prop means a
 * caller that skips treeOrder has no depth to pass and cannot render an
 * indented list at all: the invariant is enforced by the type, not a comment.
 *
 * 16dp per step. Today every root is level 1, so the deepest walk depth is 2
 * (32dp). Once an Enterprise root (level 0) exists — the migration Part 9 Q2
 * recommends — the chain is 0→1→2→3 and depth reaches 3, i.e. 48dp. Still safe
 * at 320dp width with fontScale 1.3, but do not re-derive the cap from "level
 * ≤ 3" and assume 32dp.
 */
function Row({c, depth, onPress, tierNoun}: {c: ManagedChannelDto; depth: number; onPress: () => void; tierNoun: string}) {
  const tm = TYPE_META[c.channel_type];
  const st = channelStateMeta({channel_type: c.channel_type, access: c.access, post_mode: c.post_mode, is_broadcast: c.is_broadcast, archived: c.archived});
  return (
    <Card onPress={onPress} style={[s.row, depth > 0 && {marginLeft: depth * 16}]}>
      <View style={s.rowIcon}><Icon name={tm.icon} size={18} color={OB.accentSoft} /></View>
      <View style={{flex: 1, minWidth: 96}}>
        <Text style={s.rowName} numberOfLines={1}>{c.name}</Text>
        <Text style={s.rowSub} numberOfLines={1}>
          {tierNoun} · {tm.label}
          {c.department ? ` · ${c.department}` : ''} · {c.member_count} member{c.member_count === 1 ? '' : 's'}
          {c.provisioned ? '' : ' · not active'}
        </Text>
      </View>
      <View style={[s.badge, {borderColor: st.color + '4D', backgroundColor: st.color + '14'}]}>
        <Text style={[s.badgeText, {color: st.color}]} numberOfLines={1}>{st.label}</Text>
      </View>
      <Icon name="chevron-right" size={18} color={OB.textMute} />
    </Card>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  empty: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 12, textAlign: 'center'},
  row: {flexDirection: 'row', alignItems: 'center', gap: 12},
  rowIcon: {
    width: 38, height: 38, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.12)', borderWidth: 1, borderColor: OB.hair2,
  },
  rowName: {color: OB.text, fontFamily: BravoFont.bold, fontSize: 14},
  errorStrip: {
    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 44,
    marginTop: 8, paddingHorizontal: 12, paddingVertical: 8,
    borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: OB.alert + '4D',
  },
  backRow: {minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 8},
  backText: {color: OB.accentSoft, fontFamily: BravoFont.regular, fontSize: 12},
    errorStripText: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, flex: 1, minWidth: 0},
  addRow: {minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, paddingLeft: 12},
  addText: {color: OB.accentSoft, fontFamily: BravoFont.regular, fontSize: 12},
  rowSub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  // flexShrink AND a name floor. The badge is a plain View, and Yoga defaults
  // flexShrink to 0 — so at depth 3 on a 320dp screen at fontScale 1.3 it kept
  // its full ~82dp and the name column (the only flex:1 child) was squeezed to
  // ~26dp: icon, badge, chevron and a one-glyph name. The docblock above the
  // indent reasoned about the 48dp indent and not about the rigid element on
  // the other end.
  badge: {paddingHorizontal: 8, paddingVertical: 3, borderRadius: 7, borderWidth: 1, flexShrink: 1},
  badgeText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '700', letterSpacing: 0.8},
  footer: {
    position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingTop: 12,
    backgroundColor: 'rgba(7,9,13,0.92)', borderTopWidth: 1, borderTopColor: OB.hair,
  },
}));
