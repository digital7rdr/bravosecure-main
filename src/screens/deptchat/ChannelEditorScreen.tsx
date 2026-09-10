import React, {useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TextInput, TouchableOpacity} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {ensureChannelProvisioned} from '@/modules/messenger/orgWorkspace/provisionChannel';
import type {MessengerStackParamList} from '@navigation/types';
import {departmentApi, type ChannelTypeDto, type ChannelAccessDto, type ChannelPostModeDto, type ManagedChannelDto} from '@services/api';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton, useInDepartmentalShell} from './_obsidian';
import {deptMemberNoun} from './deptNoun';
import {useIsWorkspaceTenant} from './workspaceTenant';
import {activeWorkspaceOrgParam} from '@store/activeWorkspace';
import {nameForTier, tierFromLevel} from './levelNames';
import {orgApi} from '@services/api';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type Rt = RouteProp<MessengerStackParamList, 'ChannelEditor'>;
type IconName = React.ComponentProps<typeof Icon>['name'];

const TYPES: Array<{key: ChannelTypeDto; label: string; icon: IconName}> = [
  {key: 'board', label: 'Board', icon: 'bullhorn-variant-outline'},
  {key: 'department', label: 'Department', icon: 'pound'},
  {key: 'incident', label: 'Incident', icon: 'shield-alert-outline'},
];
// Why hint is a function: the member noun is audience-dependent (M1A —
// "Employees" for an enterprise individual, "CPOs" for a provider org),
// so it must resolve at render time, not module load.
/**
 * ACCESS LEVELS — the A9 mockup's three options, with ITS wording:
 *   "Standard — All members and managers post"
 *   "Read only — Managers post only"
 *   "Restricted — Managers only"
 *
 * Note what the mockup's own descriptions reveal: the first two differ only in
 * WHO POSTS, and the third differs in WHO SEES. That is exactly the Phase 2
 * split, so each option now sets both fields explicitly rather than one column
 * pretending to mean both. Notably "Standard" means members CAN post — which
 * our pre-Phase-2 build did not do, because every member was seeded read-only.
 *
 * A9's other two communication modes are not user-selectable here on purpose:
 * Announcement-only is what a #broadcast channel is (the server pins it, so it
 * cannot be mis-set), and Admin-only is Restricted — managers only, both to see
 * and to post.
 */
/**
 * UI corrections 2026-08-15 item 04 / D-5 — the option KEY is its own union,
 * not `ChannelAccessDto`.
 *
 * `ChannelAccessDto` has exactly three members, so a fourth option cannot be
 * keyed by it — and reusing an existing key would hit the same non-injective
 * `find` that once silently promoted every member to poster (see the resolver
 * docblock below). One local union, one `find`, no collisions.
 */
type AccessOptionKey = ChannelAccessDto | 'announcement';

const ACCESS: Array<{
  key: AccessOptionKey; label: string; hint: () => string;
  access: ChannelAccessDto; postMode: ChannelPostModeDto;
  /** Offered only on a LATERAL. A level node is structure; an announcement
   *  channel is a chat, and the founder's example puts them at every tier. */
  lateralOnly?: boolean;
}> = [
  {key: 'standard', label: 'Standard', hint: () => 'All members and managers post',
   access: 'standard', postMode: 'open'},
  {key: 'read_only', label: 'Read only', hint: () => 'Managers post only',
   access: 'standard', postMode: 'read_only'},
  {key: 'restricted', label: 'Restricted', hint: () => `Managers only — ${deptMemberNoun(true)} never see it`,
   access: 'restricted', postMode: 'read_only'},
  /**
   * D-5 — THE REPLACEMENT FOR #broadcast, and it needs no new column.
   *
   * A workspace no longer gets a server-minted `#broadcast` (that stopped with
   * vs2 items 5+12) and no caller can set `is_broadcast` — the DTO deliberately
   * has no such field. So after the legacy rows are purged a workspace would
   * have had NO announcement channel and no way to make one, while the PDF's own
   * §04 example lists one at every level. This is that way: a lateral carrying
   * `post_mode: 'announcement'`, named by the admin, which is the PDF's other
   * rule ("Admins must be able to choose the names of each lateral channel").
   *
   * Everything that makes it behave like a broadcast already exists server-side:
   * `memberRoleFor('announcement')` seeds non-managers as viewers, the write
   * gate is `myRole === 'admin'`, and `assertBroadcastPostingAllowed` /
   * `mintRefusalFor` were widened to key on the MODE rather than the flag.
   */
  {key: 'announcement', label: 'Announcements', hint: () => 'Managers post; everyone else reads',
   access: 'standard', postMode: 'announcement', lateralOnly: true},
];

export default function ChannelEditorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const inDepartmentalShell = useInDepartmentalShell();
  const {params} = useRoute<Rt>();
  const editing = params?.channel;

  /**
   * PDF checklist line 9 — the org's chosen tier vocabulary, for the
   * "becomes …" placement hint below.
   *
   * Fetched here rather than threaded through the route: this screen is
   * reached from one place but with several param shapes, and a param that
   * some call sites forget is how the hint would silently revert to the
   * built-ins on half of them. Failing to load leaves it undefined, which
   * `nameForTier` reads as "use the built-ins" — the pre-existing behaviour.
   */
  const [levelNames, setLevelNames] = useState<string[] | undefined>(undefined);
  React.useEffect(() => {
    let alive = true;
    void orgApi.workspaceSettings()
      .then(r => { if (alive) {setLevelNames(r.data.levelNames);} })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  const [name, setName] = useState(editing?.name ?? '');
  const [department, setDepartment] = useState(editing?.department ?? '');
  const [type, setType] = useState<ChannelTypeDto>(editing?.channel_type ?? 'department');
  // Phase 2 — the selected option is resolved from the (access, post_mode)
  // PAIR, never from `access` alone.
  //
  // The ACCESS table is non-injective: Standard and Read only both store
  // access='standard' and differ only in post_mode. Keying off `access` made
  // `find` always return the first match (Standard → post_mode 'open'), so
  // opening ANY existing channel and pressing Save — even just a rename —
  // re-sent post_mode:'open' and the server re-seeded every non-manager to
  // 'admin'. Silent mass privilege escalation from an innocuous edit, and a
  // "Read only" channel became unrepresentable on read.
  const [access, setAccess] = useState<AccessOptionKey>(() => {
    const a = editing?.access ?? 'standard';
    const pm = editing?.post_mode;
    if (a === 'restricted') {return 'restricted';}
    if (!editing) {return 'standard';}
    /**
     * ⚠️ THE ANNOUNCEMENT ARM MUST COME BEFORE THE FALLBACK.
     *
     * Without it an existing announcement lateral (access 'standard',
     * post_mode 'announcement') falls through to `pm === 'open' ? … : 'read_only'`
     * and resolves to READ ONLY — so every Save, including a bare rename,
     * re-sends `post_mode: 'read_only'` and silently demotes the channel.
     *
     * That is the THIRD time this resolver has shipped a silent demotion: the
     * docblock above records the first (keying off `access` alone re-seeded every
     * member to 'admin'). The shape of the bug is always the same — a new
     * (access, post_mode) pair added to the table without an arm here.
     */
    if (pm === 'announcement') {return 'announcement';}
    // An existing channel with no post_mode is pre-Phase-2 → it behaved as
    // "managers post only", which is Read only.
    return pm === 'open' ? 'standard' : 'read_only';
  });
  const [busy, setBusy] = useState(false);
  /**
   * vs2 edge A3 — THE ORG BEING ADMINISTERED, handed down by ManageChannels
   * (its only door) from the server's per-org answer.
   *
   * `useIsWorkspaceTenant()` is a USER-level fact: true for anybody with any
   * workspace affiliation. For an agency company/manager who had also joined an
   * Enterprise workspace it was true on their AGENCY's channels too, and this
   * screen uses the flag to DROP the DEPARTMENT and TYPE fields — so their new
   * agency channels were created with `department = null`, the live branch-scope
   * key for attendance, incidents and invite minting.
   *
   * Fallback kept deliberately: an older caller (or a server that does not send
   * the fact) lands on exactly today's behaviour rather than on a blank form.
   */
  const userTenant = useIsWorkspaceTenant();
  /**
   * The FRESHEST answer wins: this screen's own fetch, then the route param
   * snapshot, then the user-level flag.
   *
   * The param is taken at navigate time and this screen can outlive the org it
   * was opened for — it is registered on the outer messenger stack too, which
   * the departmental shell's org-switch remount does not reach. The create-mode
   * effect below already calls `listManagedChannels`; reading the tenant it
   * returns costs nothing and re-answers the question against the org the
   * request was actually scoped to.
   */
  const [fetchedTenant, setFetchedTenant] = useState<boolean | undefined>(undefined);
  const isWorkspace = fetchedTenant ?? params?.workspaceTenant ?? userTenant;
  /**
   * WHICH org this form was opened against — the same value the interceptor
   * will stamp as `X-Org-Context`.
   *
   * A push tap can now adopt a different workspace mid-session (vs2 edge
   * A1/A2), and this screen survives that: it lives on a stack the org-switch
   * remount does not touch, and a notification tap moves to another tab rather
   * than unmounting it. Save would then POST the agency form's `department`
   * into whichever workspace the context had moved to — creating a channel in
   * the wrong organisation, with a non-null department that item 7's mint
   * relaxation then refuses to every scoped manager there.
   *
   * The precedent is `ModuleVisibilitySheet`: the one screen that can see which
   * organisation it is drawing compares it against the one the write will land
   * on, and refuses rather than guessing.
   */
  const openedUnderOrg = useRef<string | null>(activeWorkspaceOrgParam()?.orgId ?? null);

  // Scope v2 Phase 1 — the parent picker. Without a producer for `parent_id`
  // every channel is level 1 and the whole four-level hierarchy is dead code,
  // so this is the piece that makes A9/M8 real rather than latent.
  //
  // CREATE ONLY. Re-parenting is refused by the DB trigger (moving a node would
  // leave its descendants at stale levels), so the picker is hidden when
  // editing rather than shown-and-rejected.
  // vs2 items 7+8 — the tree screen passes the parent it was tapped from, so
  // the form states the placement instead of re-asking it. `root: true` is how
  // "+ Create new organisation" says "no parent, and mean it" — distinct from
  // simply omitting parent_id, which on a legacy flat workspace would produce
  // yet another level-1 Main.
  const [parentId, setParentId] = useState<string | null>(params?.parentId ?? null);
  const parentName = params?.parentName ?? null;
  const asRoot = params?.root === true;
  const [parents, setParents] = useState<ManagedChannelDto[]>([]);

  /**
   * vs2 item 8 — RESTRICTED IS NOT OFFERED ON A ROOT.
   *
   * A root nobody can see leaves every member below it holding channels whose
   * parent is hidden and whose ancestors are hidden too: their directory shows
   * zero organisations. The server refuses it (`restricted_root_not_allowed`)
   * in createChannel AND configureChannel — this only keeps the form honest,
   * because a client-only rule is reachable by editing the root afterwards.
   */
  const isRootForm = isWorkspace && !editing && !parentId;
  /**
   * item 04 — is THIS form a lateral? True while creating one (the tree passes
   * the flag) and while editing one (`pick()` carries `is_lateral` through).
   * Without the edit half the editor cannot tell a lateral from a level node and
   * would drop the Announcements option on every re-open — which, combined with
   * the resolver above, is precisely how a demotion ships.
   */
  const asLateral = params?.lateral === true || editing?.is_lateral === true;
  const visibleAccess = ACCESS.filter(a => {
    if (a.lateralOnly && !asLateral) {return false;}
    // A root nobody can see leaves every member below it with no visible
    // organisation at all; the server refuses it in createChannel AND
    // configureChannel, so the form only keeps itself honest.
    if (isRootForm && a.key === 'restricted') {return false;}
    return true;
  });

  React.useEffect(() => {
    if (editing) {return;}
    let alive = true;
    departmentApi.listManagedChannels()
      .then(({data}) => {
        if (!alive) {return;}
        // edge A3 — the tenant of the org this very request resolved to.
        if (typeof data.workspace_tenant === 'boolean') {setFetchedTenant(data.workspace_tenant);}
        // Only unarchived channels ABOVE the floor can take a child — the DB
        // CHECK rejects level 4, so offering a level-3 parent would just be a
        // guaranteed 400.
        // Exclude #broadcast: it must stay a leaf (the server rejects it as a
        // parent, and a broadcast with children would break the archive rule
        // that lets a node ignore its broadcast when counting children).
        // Offering it would just be a guaranteed 400 — but the SERVER check is
        // the boundary; this only keeps the picker honest.
        // `?? []` like the other two readers of this endpoint — a 200 with no
        // array threw here, and the `.catch` below swallowed it silently.
        setParents((data.channels ?? []).filter(c => !c.archived && !c.is_broadcast && (c.level ?? 1) < 3));
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [editing]);

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) { Alert.alert('Channel', 'Give the channel a name.'); return; }
    if (busy) { return; }
    // edge A3 — the organisation moved under this form (a notification tap can
    // now adopt one). REFUSE rather than write: the body below was composed for
    // a different tenant, and a 200 into the wrong organisation is the one
    // outcome nobody can see happening.
    const orgNow = activeWorkspaceOrgParam()?.orgId ?? null;
    if (orgNow !== openedUnderOrg.current) {
      console.warn('[deptchan] editor org drifted since open — save refused');
      Alert.alert(
        'Channel',
        'You switched organisation while this form was open, so it was not saved. '
        + 'Go back and open it again from the organisation you want it in.',
      );
      return;
    }
    setBusy(true);
    try {
      // The picked option carries BOTH fields — see the ACCESS table. `access`
      // holds the option KEY (which is unique), not the stored access value.
      // Keyed on the option KEY, which is unique — never on `access`, which is
      // not (Standard, Read only and Announcements all store 'standard').
      const picked = ACCESS.find(a => a.key === access);
      // NEVER send post_mode for a #broadcast: the server pins it to
      // 'announcement', and sending 'open' would re-seed its members as posters
      // while the row still read as a broadcast — members posting in the one
      // channel page 10 rule 1 says they cannot.
      const body = {
        name: trimmed,
        // vs2 item 7 — the WORKSPACE form has no DEPARTMENT field, so it sends
        // nothing rather than an empty string. New workspace channels carry
        // NULL, which the server treats as "belongs to every manager". The
        // agency form still sends what its admin typed.
        ...(isWorkspace ? {} : {department: department.trim() || null}),
        channel_type: type,
        /**
         * The stored ACCESS value, which is not the same thing as the option key.
         *
         * 'announcement' is a KEY only — the channel it describes stores
         * access 'standard' and post_mode 'announcement'. The fallback spells
         * that out rather than letting the key leak onto the wire, where it
         * would fail the server's `@IsIn(CHANNEL_ACCESS)` and read as a
         * validation bug rather than a mapping one.
         */
        access: picked?.access ?? (access === 'announcement' ? 'standard' : access),
        ...(editing?.is_broadcast ? {} : {post_mode: picked?.postMode ?? 'read_only'}),
      };
      if (editing) {
        // `parent_id` is deliberately NOT sent here — configureChannel cannot
        // re-parent (the trigger refuses it), and ChannelInput has no such field.
        await departmentApi.configureChannel(editing.id, body);
      } else {
        const {data: created} = await departmentApi.createChannel(
          parentId ? {...body, parent_id: parentId, ...(asLateral ? {lateral: true} : {})}
            : asRoot ? {...body, root: true}
              : body);
        /**
         * ⚠️ VERIFY THE ECHO — do not assume the request was honoured.
         *
         * In production `forbidNonWhitelisted` is FALSE, so an old server (or an
         * old instance behind a rolling deploy, which a read-side capability
         * probe cannot see) silently STRIPS `lateral` and creates a structural
         * child. That row consumes a hierarchy tier, and `is_lateral` is frozen
         * while re-parenting is blocked — so it can never be corrected, only
         * deleted. Saying so immediately is the difference between a five-second
         * fix and a permanently wrong tree.
         */
        if (asLateral && created.is_lateral !== true) {
          Alert.alert(
            'Channel created, but not as a lateral',
            `"${trimmed}" was created as a sub-level instead — this server does not support `
            + 'lateral channels yet. Delete it and try again once the server is updated.',
          );
        }
        // Eagerly provision the E2EE group so the channel is active the moment it's
        // opened, not on a later admin tap (audit D1-a). Fire-and-forget: a channel
        // with no other members yet returns 'needs_members' and provisions when a CPO
        // is added; a failure is non-fatal (the open-flow fallback re-tries).
        void ensureChannelProvisioned(created.id, created.name, null).catch(() => {});
      }
      navigation.goBack();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      // This screen used to render the server's raw code — an admin literally
      // saw `restricted_root_would_orphan_children` in an alert body. Every
      // refusal this form can provoke gets a sentence naming the remedy.
      const copy: Record<string, string> = {
        restricted_root_not_allowed:
          'A top-level organisation cannot be Restricted — members would see no organisation at '
          + 'all. Use Standard or Read only here, and restrict a channel inside it instead.',
        restricted_root_would_orphan_children:
          'This organisation has channels inside it, so it cannot be made Restricted — everyone '
          + 'in them would lose sight of the organisation above. Move or archive them first.',
        restricted_root_cannot_take_children:
          'This organisation is Restricted, so nothing can be added inside it. Make it Standard '
          + 'or Read only first.',
        max_channel_depth_reached: 'You have reached the deepest level — add this alongside instead.',
        parent_channel_in_other_org: 'That parent belongs to another workspace.',
        // Reachable whenever the form thinks it is on a workspace and the
        // request resolves to an agency — the dual persona's most likely
        // refusal, and it was rendering as a raw code.
        root_channel_not_supported_for_agency:
          'Top-level organisations exist only in an Enterprise workspace. Create this channel '
          + 'inside your agency instead, and give it a department.',
        broadcast_channel_cannot_have_children: 'Announcement channels cannot contain other channels.',
        channel_reparenting_not_supported: 'A channel cannot be moved once created.',
      };
      Alert.alert('Channel', (msg && copy[msg]) || msg || 'Could not save. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const archive = () => {
    if (!editing) { return; }
    Alert.alert('Archive channel', `Hide "${editing.name}" from the hub? Members stop seeing it.`, [
      {text: 'Cancel', style: 'cancel'},
      {text: 'Archive', style: 'destructive', onPress: () => { void doArchive(); }},
    ]);
  };
  const doArchive = async () => {
    if (!editing) { return; }
    setBusy(true);
    try {
      await departmentApi.archiveChannel(editing.id);
      navigation.goBack();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Archive', msg ?? 'Could not archive.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * UI corrections 2026-08-15 item 05 — "There must be an option to Delete
   * Channels, not only archive them."
   *
   * Delete already existed on the server and `deletable` already round-tripped
   * to this screen — but the only DOOR was inside ChannelMembers, so on the
   * Edit Channel screen the PDF's ask had no affordance at all. That door stays;
   * this adds the one the founder pointed at.
   *
   * TWO-STEP, and the second step names the channel. Delete is irreversible and
   * takes the E2EE thread with it, so a single destructive tap next to
   * "Archive channel" is a mis-tap away from data loss.
   */
  const confirmDelete = () => {
    if (!editing) { return; }
    Alert.alert(
      'Delete channel',
      `Permanently delete "${editing.name}"? Its message history goes with it and this cannot be undone. `
      + 'Archive instead if you only want to hide it.',
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete', style: 'destructive', onPress: () => { void doDelete(); }},
      ],
    );
  };
  const doDelete = async () => {
    if (!editing || busy) { return; }
    setBusy(true);
    try {
      await departmentApi.deleteChannel(editing.id);
      navigation.goBack();
    } catch (e: unknown) {
      const code = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      // Every refusal this verb can produce gets a sentence naming the remedy —
      // the same rule `save()` follows. An admin seeing a raw
      // `channel_has_sub_channels` is the defect that copy map exists to fix.
      const copy: Record<string, string> = {
        channel_has_sub_channels:
          'This channel still has channels inside it — including any that are archived — so it '
          + 'cannot be deleted. Delete or archive those first, working from the innermost outwards.',
        broadcast_channel_cannot_be_deleted:
          'Announcement channels cannot be deleted on this kind of organisation. Archive it instead.',
        only_creator_can_delete:
          'Only the person who created this channel, or the workspace owner, can delete it.',
      };
      Alert.alert('Delete', (code && copy[code]) || code || 'Could not delete. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const doUnarchive = async () => {
    if (!editing || busy) { return; }
    setBusy(true);
    try {
      await departmentApi.unarchiveChannel(editing.id);
      navigation.goBack();
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert('Unarchive', msg ?? 'Could not unarchive.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title={editing ? 'Edit Channel' : 'New Channel'} onBack={() => navigation.goBack()} />

      {/* flexGrow lets the spacer below push the action block down to the
          bottom edge on the short "New Channel" form instead of leaving a
          screen-height void above the tab bar; it collapses back to its
          minHeight the moment the content actually overflows (editing, or
          fontScale 1.3+), so nothing is ever clipped. */}
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          paddingHorizontal: 20,
          // The ObsidianTabBar below already reserves the safe area when this
          // screen is inside the Departmental shell — adding it again is the
          // B-156 double-count.
          paddingBottom: (inDepartmentalShell ? 0 : insets.bottom) + 12,
        }}
        keyboardShouldPersistTaps="handled">

        <SectionLabel>NAME</SectionLabel>
        <Card>
          <TextInput style={s.input}
            placeholder={isWorkspace ? 'Name of channel' : 'e.g. Operations'}
            placeholderTextColor={OB.textMute} value={name} onChangeText={setName} maxLength={80} />
        </Card>

        {/* vs2 item 7 — the WORKSPACE form is NAME → where it sits → ACCESS.
            DEPARTMENT and TYPE leave the form entirely: a workspace's structure
            IS the tree, so a free-text branch string duplicated it, and TYPE's
            three options were a vocabulary members never see.

            The AGENCY form keeps both. Agency orgs type real branch values into
            DEPARTMENT and those values are the scope key for attendance and
            incidents — removing the field there would quietly strand every
            scoped manager. */}
        {!isWorkspace && (
          <>
            <View style={{height: 18}} />
            <SectionLabel>DEPARTMENT (OPTIONAL)</SectionLabel>
            <Card>
              <TextInput style={s.input} placeholder="e.g. Intel" placeholderTextColor={OB.textMute} value={department} onChangeText={setDepartment} maxLength={80} />
            </Card>
          </>
        )}

        {/* WORKSPACE: where the channel sits is decided by WHERE YOU TAPPED in
            the tree, so it is shown as a fact, not re-asked as a question. */}
        {isWorkspace && !editing && (
          <>
            <View style={{height: 18}} />
            <SectionLabel>PLACEMENT</SectionLabel>
            <Card>
              <View style={s.accRow}>
                <Icon name={parentName ? 'file-tree' : 'domain'} size={18} color={OB.textMute} />
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={s.accLabel} numberOfLines={1}>
                    {!parentName
                      ? 'Top level'
                      : asLateral
                        ? `Lateral channel in ${parentName}`
                        : `Sub-level under ${parentName}`}
                  </Text>
                  <Text style={s.accHint}>
                    {!parentName
                      ? 'A new organisation — nothing sits above it'
                      : asLateral
                        // The distinction the founder drew in §04, said plainly.
                        ? 'Sits at the same level — it does not add a new tier'
                        : 'Adds a new level under it'}
                  </Text>
                </View>
              </View>
            </Card>
          </>
        )}

        {/* A9 — place the channel in the hierarchy. Hidden when editing (moves
            are refused) and when there is nothing to nest under. AGENCY only
            now: the workspace tenant gets the read-only row above. */}
        {!isWorkspace && !editing && parents.length > 0 && (
          <>
            <View style={{height: 18}} />
            <SectionLabel>PARENT CHANNEL (OPTIONAL)</SectionLabel>
            <View style={{gap: 10}}>
              <Card onPress={() => setParentId(null)} style={[s.accRow, parentId === null && s.accOn]}>
                <View style={{flex: 1}}>
                  <Text style={[s.accLabel, parentId === null && {color: OB.text}]}>Top level</Text>
                  <Text style={s.accHint}>A main channel, not nested under another</Text>
                </View>
                <Icon name={parentId === null ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={parentId === null ? OB.accent : OB.textMute} />
              </Card>
              {parents.map(p => (
                <Card key={p.id} onPress={() => setParentId(p.id)} style={[s.accRow, parentId === p.id && s.accOn]}>
                  <View style={{flex: 1}}>
                    <Text style={[s.accLabel, parentId === p.id && {color: OB.text}]} numberOfLines={1}>{p.name}</Text>
                    <Text style={s.accHint}>
                      Nest under this — becomes {nameForTier(tierFromLevel(p.level) + 1, levelNames)}
                    </Text>
                  </View>
                  <Icon name={parentId === p.id ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={parentId === p.id ? OB.accent : OB.textMute} />
                </Card>
              ))}
            </View>
          </>
        )}

        {/* vs2 item 7 — TYPE leaves the WORKSPACE form. `channel_type` defaults
            to 'department'; the one type that mattered (incident) is reachable
            through Restricted, which is the same managers-only outcome. */}
        {!isWorkspace && (
          <>
            <View style={{height: 18}} />
            <SectionLabel>TYPE</SectionLabel>
            <View style={s.segRow}>
              {TYPES.map(t => (
                <TouchableOpacity key={t.key} style={[s.seg, type === t.key && s.segOn]} activeOpacity={0.85} onPress={() => setType(t.key)}>
                  <Icon name={t.icon} size={16} color={type === t.key ? OB.accentSoft : OB.textMute} />
                  <Text style={[s.segText, type === t.key && {color: OB.text}]}>{t.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </>
        )}

        {/* A #broadcast is server-owned: its post_mode is pinned to
            'announcement' and it cannot be archived or deleted. Say so, rather
            than offering controls the server will refuse. */}
        {editing?.is_broadcast && (
          <>
            <View style={{height: 18}} />
            <Card>
              <Text style={s.accHint}>
                This is the mandatory #broadcast channel for its level. Everyone can read it,
                only managers can post, and it cannot be archived or deleted.
              </Text>
            </Card>
          </>
        )}

        <View style={{height: 18}} />
        <SectionLabel>ACCESS</SectionLabel>
        <View style={{gap: 10}}>
          {visibleAccess.map(a => (
            <Card key={a.key} onPress={() => setAccess(a.key)} style={[s.accRow, access === a.key && s.accOn]}>
              <View style={{flex: 1}}>
                <Text style={[s.accLabel, access === a.key && {color: OB.text}]}>{a.label}</Text>
                <Text style={s.accHint}>{a.hint()}</Text>
              </View>
              <Icon name={access === a.key ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={access === a.key ? OB.accent : OB.textMute} />
            </Card>
          ))}
        </View>

        {type === 'incident' && access !== 'restricted' && (
          <Text style={s.note}>Incident channels are managers-only regardless of access.</Text>
        )}

        <View style={{flexGrow: 1, minHeight: 26}} />
        <PrimaryButton label={editing ? 'Save changes' : 'Create channel'} icon="check" onPress={() => { void save(); }} busy={busy} />

        {editing && (
          <>
            <View style={{height: 12}} />
            <GhostButton
              label="Members"
              icon="account-multiple-outline"
              // vs2 edge A4 — carry the server's delete verdict. This door
              // passed NOTHING, so Delete never rendered on the admin path and
              // the PDF's ask had no reachable door at all.
              onPress={() => navigation.navigate('ChannelMembers', {
                channelId: editing.id, channelName: editing.name, canDelete: editing.deletable,
              })}
            />
            {/* A9 — a #broadcast is non-deletable, and archive is this app's
                REAL removal verb (delete is creator-only and rarely reached).
                The server refuses it; don't offer a button that always errors. */}
            {editing.is_broadcast ? null : editing.archived ? (
              <TouchableOpacity style={s.archiveBtn} activeOpacity={0.8} onPress={() => { void doUnarchive(); }}>
                <Icon name="archive-arrow-up-outline" size={16} color={OB.accentSoft} />
                <Text style={[s.archiveText, {color: OB.accentSoft}]}>Unarchive channel</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity style={s.archiveBtn} activeOpacity={0.8} onPress={archive}>
                <Icon name="archive-outline" size={16} color={OB.alert} />
                <Text style={s.archiveText}>Archive channel</Text>
              </TouchableOpacity>
            )}

            {/* item 05 — DELETE, alongside Archive and never instead of it.
                The PDF is explicit: "Delete must not be replaced by Archive."

                Gated on the SERVER's verdict (`deletable`), computed from the
                same predicate deleteChannel enforces, so the button and the
                server cannot disagree. A #broadcast is excluded by that verdict
                already, which is why there is no extra is_broadcast test here. */}
            {editing.deletable ? (
              <TouchableOpacity
                style={s.deleteBtn}
                activeOpacity={0.8}
                onPress={confirmDelete}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${editing.name} permanently`}>
                <Icon name="trash-can-outline" size={16} color={OB.alert} />
                <Text style={s.deleteText}>Delete channel</Text>
              </TouchableOpacity>
            ) : (
              /* NOT HIDDEN — explained. A missing button reads as "this app has
                 no delete", which is the complaint item 05 is answering. Saying
                 WHY turns a dead end into an instruction. The reasons are
                 disjoint on the server (has children / not the creator or owner
                 / a protected broadcast) and `deletable` collapses them to one
                 bit, so the copy names the common cases without asserting one. */
              <Text style={s.deleteHint}>
                This channel can&apos;t be deleted — it still has channels inside it (archived ones
                count), or it wasn&apos;t created by you. Archive it instead.
              </Text>
            )}
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: OB.bg},
  input: {color: OB.text, fontFamily: BravoFont.regular, fontSize: 15, padding: 0},
  segRow: {flexDirection: 'row', gap: 8},
  seg: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    height: 46, borderRadius: 12, borderWidth: 1, borderColor: OB.hair2, backgroundColor: 'rgba(255,255,255,0.03)',
  },
  segOn: {borderColor: OB.accent + '80', backgroundColor: 'rgba(91,141,239,0.12)'},
  segText: {color: OB.textMute, fontFamily: BravoFont.semiBold, fontSize: 12},
  accRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
  accOn: {borderColor: OB.accent + '66'},
  accLabel: {color: OB.textDim, fontFamily: BravoFont.bold, fontSize: 14},
  accHint: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
  note: {color: OB.amber, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 12},
  archiveBtn: {flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 48, marginTop: 12},
  archiveText: {color: OB.alert, fontFamily: BravoFont.semiBold, fontSize: 13},
  // item 05 — Delete sits BELOW Archive and reads heavier: a hairline top rule
  // separates the reversible action from the irreversible one, so they are not
  // two identical-looking rows a mis-tap apart.
  deleteBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    height: 48, marginTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: OB.hair2,
  },
  deleteText: {color: OB.alert, fontFamily: BravoFont.bold, fontSize: 13},
  deleteHint: {
    color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, lineHeight: 16,
    textAlign: 'center', marginTop: 12, paddingHorizontal: 8,
  },
}));
