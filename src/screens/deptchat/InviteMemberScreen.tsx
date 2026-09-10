import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {View, Text, StyleSheet, StatusBar, TextInput, TouchableOpacity, Share} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, useFocusEffect, type RouteProp} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import KeyboardAvoidingScreen from '@components/KeyboardAvoidingScreen';
import {useBottomInset} from '@hooks/useBottomInset';
import {useAuthStore} from '@store/authStore';
import {enterpriseApi, departmentApi, type ManagedChannelDto} from '@services/api';
import {normalizeToE164, callingCodeFromOwnPhone} from '@/modules/messenger/contacts/phoneNormalize';
import type {DiscoveredRow} from '@/modules/messenger/contacts/useDiscoveredContacts';
import {deptEmployeeNoun} from './deptNoun';
import {
  fromManaged, topLevelOf, subtreeOf, ancestorPathOf, hasHierarchy,
  mintDisabled, needsHiddenRung, blockedReasonOf, HIDDEN_RUNG_LABEL, WHOLE_WORKSPACE_LABEL,
  type TreeRow,
} from './organisationTree';
import {collidingOrgNames, orgDisambiguator, needsOrgDisambiguator, shortOrgRef} from './orgDisambiguation';
import type {MessengerStackParamList} from '@navigation/types';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, GhostButton, ErrorState, loadErrorText} from './_obsidian';
import {BravoContactPicker} from './BravoContactPicker';

type Rt = RouteProp<MessengerStackParamList, 'InviteMember'>;

/**
 * Item E (A5-inv) — invite a specific person by phone or email.
 *
 * Unlike a referral code (multi-use, admin approves later), an invite is BOUND
 * to one contact, single-use, and joins instantly on acceptance — the admin's
 * decision happens HERE, at mint time: who, which team, which role.
 *
 * The status list on ApprovalsScreen never says whether the contact already
 * has an account — the mint response is byte-identical matched or unmatched
 * (server rule), and this screen must not try to find out either.
 */
export default function InviteMemberScreen() {
  const insets = useSafeAreaInsets();
  // The FORM's inset arithmetic lives in KeyboardAvoidingScreen (item 3), and
  // the contact sheet now owns its own bottomPad inside BravoContactPicker —
  // so no copy of the keyboard rule lives on this screen at all.
  // The minted success state renders NO footer, so footerGap is inert there and
  // the scroll content owns the bottom inset itself.
  const {contentBottom} = useBottomInset();
  const navigation = useNavigation<NativeStackNavigationProp<MessengerStackParamList>>();
  const {params} = useRoute<Rt>();
  const ownPhone = useAuthStore(st => st.user?.phone_e164 ?? null);

  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [teamId, setTeamId] = useState<string | null>(params?.channelId ?? null);
  const [role, setRole] = useState<'employee' | 'manager'>('employee');
  // vs2 edge A8 — undefined until the list lands (and on an old server).
  const [canGrantManager, setCanGrantManager] = useState<boolean | undefined>(undefined);
  /**
   * G6 — is the org THIS INVITE lands in a workspace? Server-authoritative, the
   * same field and the same reasoning as `ManageChannelsScreen`'s edge A3: the
   * client's own `isWorkspaceTenant` is a USER-level fact and is ambiguous for
   * the dual persona (an agency manager who has also joined a workspace).
   *
   * `undefined` (old server, or the list has not landed) leaves every rule
   * below OFF — the pre-G6 behaviour exactly.
   */
  const [serverTenant, setServerTenant] = useState<boolean | undefined>(undefined);
  /**
   * G5 — the organisation roots this MINTER is scoped to. Same field, same
   * endpoint and same meaning as on Manage Channels: `null` = unscoped (owner,
   * agency, or no seeded membership), `undefined` = old server.
   *
   * This screen needs it for the founder's sentence twice over. "When adding
   * Admins, it should be organization specific only. Admins should not be able
   * to see other organizations" — and THIS is the adding-admins screen, so a
   * picker that still lists every organisation defeats the rule at the exact
   * place it was asked for.
   */
  const [scopeRoots, setScopeRoots] = useState<string[] | null | undefined>(undefined);
  const [dept, setDept] = useState('');
  const [teams, setTeams] = useState<ManagedChannelDto[]>([]);
  const [teamsError, setTeamsError] = useState<string | null>(null);
  // vs2 item 2 — stage 1 of the picker. null = "choose an organisation";
  // non-null = drilled into that organisation, showing its teams.
  const [orgId, setOrgId] = useState<string | null>(null);
  // Whether the channel we arrived from was rejected as a join target.
  const [droppedPreselect, setDroppedPreselect] = useState(false);
  // Mirrors teamId for the stable loadTeams callback (see its comment).
  const teamIdRef = React.useRef<string | null>(params?.channelId ?? null);
  const [minting, setMinting] = useState(false);
  const [minted, setMinted] = useState<{code: string; expires_at: string | null; contact: string} | null>(null);

  const loadTeams = useCallback(async () => {
    try {
      // vs2 item 2 — GROUP FIRST, DISABLE SECOND. This used to pre-filter the
      // un-mintable channels away. It must not: the list is now grouped into a
      // tree, and dropping a restricted ORGANISATION ROOT promotes its country
      // children to top-level organisations (RSA and Kenya as peers of SASFA) —
      // reproducing the exact flat pile this item exists to fix. The exclusions
      // are applied per row as a disabled state instead, by `mintDisabled`.
      const {data} = await departmentApi.listManagedChannels();
      const all = data.channels ?? [];
      setTeams(all);
      // vs2 edge A8 — the per-MINTER fact. undefined = old server → offer the
      // role, exactly as before; the submit-time refusal is still the boundary.
      setCanGrantManager(data.can_grant_manager);
      setServerTenant(data.workspace_tenant);
      setScopeRoots(data.manager_scope_root_ids);
      // …and DROP a Manager selection the list has just refused. The row is
      // enabled until this resolves, so a fast admin can select it first; the
      // radio would then grey while `role` stayed 'manager', and Create still
      // sent it — a 403 at submit, under a greyed control that looks like it
      // should have prevented exactly that. Which is the bug A8 exists to kill.
      if (data.can_grant_manager === false) {setRole('employee');}
      // The channelId param arrives from ANY channel's members screen —
      // including broadcast/restricted/incident ones the server refuses as a
      // join target. An unmintable pre-select is a promise the submit would
      // break, so drop it back to the escape hatch.
      // Read through a ref, and decide OUTSIDE any updater. A setState updater
      // must be pure — React 18 StrictMode double-invokes it, so calling a
      // second setter from inside one is a trap even when the value is
      // idempotent. The ref exists because loadTeams is a stable callback and
      // would otherwise close over a stale teamId.
      const current = teamIdRef.current;
      if (current) {
        const row = all.find(c => c.id === current);
        if (!row || mintDisabled(row as TreeRow)) {
          setDroppedPreselect(true);
          setTeamId(null);
        }
      }
      setTeamsError(null);
    } catch (e) {
      setTeamsError(loadErrorText(e));
    }
  }, []);

  useFocusEffect(useCallback(() => { void loadTeams(); }, [loadTeams]));

  const rows = useMemo(() => fromManaged(teams), [teams]);
  // Legacy workspaces are entirely flat, and a two-stage picker over a pile of
  // one-item "organisations" is strictly worse than the radio list it replaced.
  // The tree only appears where a tree exists.
  // Broadcasts are never a join target and are not nodes of the tree.
  //
  // ARCHIVED rows are pre-filtered, and that is NOT a violation of "group first,
  // disable second". That rule exists because dropping a restricted
  // organisation ROOT promotes its children to top-level organisations — it
  // needs the dropped row to have live children. An archived row cannot:
  // archiveChannel refuses while any active non-broadcast child exists, and
  // createChannel refuses an archived parent, so among live rows an archived
  // channel is always a leaf. Keeping them would grow this list monotonically
  // with dead entries an admin can never pick.
  //
  // `pickable` is the SINGLE input to every tree consumer below — the roots,
  // the subtree and the breadcrumb. Filtering only the flat branch left the
  // tree walking the unfiltered list, so archived rows vanished from a legacy
  // workspace and survived inside an organisation.
  const livePickable = useMemo(() => rows.filter(r => !r.is_broadcast && !r.archived), [rows]);
  /**
   * G5 — and then narrowed to the organisations this minter actually governs.
   *
   * Applied to `pickable` rather than to `tops`, because `pickable` is
   * documented as "the SINGLE input to every tree consumer below — the roots,
   * the subtree and the breadcrumb". Narrowing only the root list would leave
   * the flat (non-tiered) branch, `blockedReasonOf` and `ancestorPathOf`
   * walking the unnarrowed set — the exact half-filter that made archived rows
   * vanish from a legacy workspace and survive inside an organisation.
   *
   * FAIL OPEN, identically to Manage Channels and to the server: an empty
   * result means the two sides disagreed about the row set, and a picker with
   * nothing in it is indistinguishable from a broken screen. Showing too much
   * is recoverable — the server still refuses a mint outside the caller's
   * authority — showing nothing is a dead end.
   */
  const pickable = useMemo(() => {
    if (!Array.isArray(scopeRoots) || scopeRoots.length === 0) {return livePickable;}
    const scope = new Set(scopeRoots);
    /**
     * ⚠️ WALKED OVER `rows`, NOT `livePickable`, and that is the whole point.
     *
     * `rows` is every channel the endpoint returned, ARCHIVED INCLUDED — the
     * same set the SERVER walks to derive the scope, and the same set
     * `ManageChannelsScreen`'s `rootOf` walks. Resolving against the live rows
     * only makes a live row under an ARCHIVED ancestor terminate at ITSELF, so
     * its own id is compared against a scope set that (correctly) names its
     * true root, and the row is dropped. Manage Channels shows that row as
     * theirs; the picker would refuse to. Two surfaces answering "which
     * organisation is this row in" with two different walks is this repo's
     * most-shipped defect.
     *
     * ONE parent map, built once and closed over. `ancestorPathOf` rebuilds its
     * own map on every call, so calling it per row was quadratic on every focus
     * refetch — same shape as `rootOf` on the sibling screen, same bound.
     */
    const parentOf = new Map(rows.map(r => [r.id, r.parent_id ?? null]));
    const rootOf = (id: string): string => {
      let cur = id;
      for (let hop = 0; hop <= 4; hop++) {
        const parent = parentOf.get(cur) ?? null;
        if (!parent || !parentOf.has(parent)) {break;}
        cur = parent;
      }
      return cur;
    };
    const mine = livePickable.filter(r => scope.has(r.id) || scope.has(rootOf(r.id)));
    return mine.length > 0 ? mine : livePickable;
  }, [livePickable, rows, scopeRoots]);
  const tiered = useMemo(() => hasHierarchy(pickable), [pickable]);
  // topLevelOf, not organisationRootsOf: a row stranded by a filtered-out
  // parent must still be reachable, but must NOT be announced as an
  // organisation — that would assert a structure the workspace does not have.
  const tops = useMemo(() => topLevelOf(pickable), [pickable]);
  // vs2 edge A7 — same decision as the hub and Manage Channels; only the rule
  // is shared, because the three surfaces do not share a data source.
  const collidingTops = useMemo(() => collidingOrgNames(tops.map(t => t.row.name)), [tops]);
  // A branch-scoped manager can legitimately end up with every row greyed —
  // organisation roots and #broadcast carry no branch at all. Without this the
  // screen is a silent wall of grey; before the picker greyed anything, the
  // admin at least got an explicit "outside your branch" alert on submit.
  //
  // Scoped to what is ON SCREEN, not to the whole workspace. Computed globally
  // it stayed silent in the case that actually confuses people: one
  // organisation entirely out of branch while another is fine, so the admin
  // drills in, finds every row dead, and gets no explanation because the
  // workspace as a whole had something mintable in it.
  const onScreen = useMemo(
    () => (tiered && orgId ? subtreeOf(pickable, orgId).map(x => x.row) : pickable),
    [tiered, orgId, pickable],
  );
  const blocked = useMemo(() => blockedReasonOf(onScreen), [onScreen]);
  /**
   * Does a team EXIST that a manager could be pointed at? Drives G6 below.
   *
   * ⚠️ THIS IS THE SERVER'S PROBE, RESTATED — deliberately the same predicate
   * over the same set, and it must stay that way:
   *
   *     org_id = $1 AND archived_at IS NULL AND NOT is_broadcast
   *       AND post_mode <> 'announcement'
   *
   * NOT `mintDisabled`, and not `pickable.length > 0`. Both were tried, and
   * they are the same mistake in opposite directions:
   *
   *   - `pickable.length > 0` counts rows that may all be un-nameable, so the
   *     form greys the escape hatch over a list where nothing can be chosen;
   *   - `mintDisabled` is a strict SUBSET of the server's probe (a mintable row
   *     is always live, non-broadcast and non-announcement, never the reverse),
   *     so the form ENABLED the org-wide row and the server then 400'd it. A
   *     workspace whose only root is `restricted` — reachable on anything
   *     predating `restricted_root_not_allowed` — hits that every time.
   *
   * Client ⊊ server means the server refuses what the form invited. Client =
   * server means the two always agree about whether the rule APPLIES; when it
   * applies and nothing is pickable, the `blocked` copy below says so instead
   * of pointing at a door the server has nailed shut.
   */
  const hasMintableTeam = useMemo(
    () => teams.some(t => !t.is_broadcast && !t.archived && t.post_mode !== 'announcement'),
    [teams]);
  // Pre-select from params.channelId: drill straight to the organisation that
  // contains it, so the caller's node is on screen and selected rather than
  // buried behind a stage the user has to guess at.
  //
  // ONE-SHOT, and the ref is load-bearing. Keyed on "teamId is set and orgId is
  // not" this effect fought the Back button: pressing "All organisations" set
  // orgId to null, the effect saw a still-selected team and immediately drilled
  // back in, so stage 1 was unreachable for anyone who had picked a team — they
  // could never switch to a different organisation. It also has to be a ref
  // rather than a state flag, because it must not re-arm on the reload that
  // useFocusEffect fires.
  const preselectDone = React.useRef(false);
  const initialTeam = params?.channelId ?? null;
  useEffect(() => {
    if (preselectDone.current || !tiered || !initialTeam) {return;}
    // Only honour it while it IS still the selection: loadTeams drops an
    // un-mintable pre-select, and drilling to a team we just refused would
    // point the admin at a node they cannot pick.
    if (teamId !== initialTeam) {return;}
    const path = ancestorPathOf(pickable, initialTeam);
    if (path.length > 0) {
      setOrgId(path[0].id);
      preselectDone.current = true;
    }
  }, [tiered, initialTeam, teamId, pickable]);

  /**
   * G6 — the org-wide escape hatch is closed for a manager invite on a
   * workspace. Stated ONCE so the greyed row, its explanation and the submit
   * guard cannot disagree about when the rule is on.
   *
   * ⚠️ `hasMintableTeam` IS PART OF THE RULE, not a nicety. On a clean
   * workspace with no channels yet the picker renders "No organisations yet —
   * invite with no specific team, or create channels first" directly under the
   * greyed row telling you a manager must be given one. The screen instructed
   * the user to do the exact thing it had just disabled, and Create then
   * refused: the first co-admin of a brand-new workspace could not be invited
   * at all. A rule that cannot be satisfied must not fire — and with zero
   * organisations there are no OTHER organisations to leak into, which is the
   * whole point of the rule.
   */
  const orgWideBlocked = role === 'manager' && serverTenant === true && hasMintableTeam;

  /**
   * A `teamId` THE PICKER NO LONGER SHOWS MUST NOT SURVIVE.
   *
   * `loadTeams` drops a pre-select that is missing or `mintDisabled`, and it
   * checks that against `all` — which was the complete list until G5 narrowed
   * `pickable` by organisation. After it, a pre-select in ANOTHER organisation
   * passes that check and then matches no row on screen: `selected` is null so
   * nothing renders selected, no breadcrumb appears, the escape-hatch radio
   * reads blank (because `teamId !== null`), no explanation shows — and Create
   * still sends `team_channel_id`, binding the invite to a team in the
   * organisation this screen was narrowed to hide. It also slipped past the G6
   * guard, whose condition is `!teamId`.
   *
   * Reachable without typing anything: Manage Channels → a channel → Members →
   * "Invite someone new" passes `{channelId}`.
   *
   * So the invariant is restored at the one place that can see the narrowed
   * list, and `droppedPreselect` explains it through copy that already exists.
   * `teams.length` gates it so it cannot fire before the list lands; setting
   * null makes it idempotent.
   */
  useEffect(() => {
    if (!teamId || teams.length === 0) {return;}
    if (pickable.some(r => r.id === teamId)) {return;}
    setDroppedPreselect(true);
    setTeamId(null);
  }, [teamId, teams.length, pickable]);

  useEffect(() => { teamIdRef.current = teamId; }, [teamId]);
  const selected = useMemo(() => pickable.find(r => r.id === teamId) ?? null, [pickable, teamId]);
  const breadcrumb = useMemo(
    () => (selected ? ancestorPathOf(pickable, selected.id).map(r => r.name).join(' → ') : null),
    [pickable, selected],
  );

  /** One selectable node. Shared by the flat list and both tree stages so the
   *  a11y label, the radio and the disabled rule cannot drift between them. */
  const teamRow = useCallback((row: TreeRow, depth: number) => {
    const disabled = mintDisabled(row);
    const on = teamId === row.id;
    return (
      <View key={row.id}>
        {needsHiddenRung(row) && (
          <Text style={[s.rung, {marginLeft: 12 + depth * 16}]}>{HIDDEN_RUNG_LABEL}</Text>
        )}
        <TouchableOpacity
          style={[s.teamRow, on && s.teamOn, disabled && s.teamOff, {marginLeft: depth * 16}]}
          activeOpacity={disabled ? 1 : 0.85}
          onPress={() => {
            if (disabled) {return;}
            setTeamId(row.id);
            // Clear the dropped-pre-select notice: leaving it up alongside the
            // breadcrumb showed two contradictory statements at once — "no
            // specific team is selected" directly above "Joining: SASFA → RSA
            // → Fort Hunter".
            setDroppedPreselect(false);
          }}
          accessibilityRole="button"
          accessibilityState={{disabled, selected: on}}
          accessibilityLabel={`Join team ${row.name}`}>
          <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={18}
            color={disabled ? OB.textMute : on ? OB.accent : OB.textMute} />
          <Text style={[s.teamText, disabled && s.teamTextOff]} numberOfLines={1}>{row.name}</Text>
        </TouchableOpacity>
      </View>
    );
  }, [teamId]);

  // Q13 (founder, 2026-08-08) — the IN-APP picker, not the OS phonebook. Same
  // source as the group add-member page: device contacts matched against
  // registered Bravo users, so the admin picks a person who can actually
  // receive the invite in-app. Someone not on Bravo yet is invited by typing
  // their number — the fields above stay the manual lane.
  // UI corrections 2026-08-15 item 10 — the sheet itself moved to
  // BravoContactPicker so EmployeesScreen can render the SAME one. Everything
  // that made it work (the users client, the discovery hook, the permission
  // states, the filter) went with it; what stays here is only what a PICK means
  // on this screen.
  const [pickerOpen, setPickerOpen] = useState(false);

  const pickRow = useCallback((m: DiscoveredRow) => {
    setPhone(m.phoneE164);
    setEmail('');
    if (!name.trim()) { setName(m.localName ? m.localName : m.displayName); }
    setPickerOpen(false);
  }, [name]);

  const mint = useCallback(async () => {
    if (minting) {return;}
    const rawPhone = phone.trim();
    const rawEmail = email.trim();
    if (!rawPhone && !rawEmail) {
      Alert.alert('Invite', 'Enter a phone number or an email address.');
      return;
    }
    if (rawPhone && rawEmail) {
      Alert.alert('Invite', 'Use a phone number OR an email — one per invite.');
      return;
    }
    /**
     * G6 (founder, 2026-08-19) — "When adding Admins, it should be organization
     * specific only."
     *
     * A teamless invite seeds the joiner across the WHOLE workspace, which with
     * more than one root is a grant over every organisation in it — for an
     * EMPLOYEE that is a reach the admin can live with, for a MANAGER it is
     * precisely the "admins seeing other organizations" the founder is asking us
     * to stop. So the escape hatch stays for employees and closes for managers.
     *
     * Workspace tenant only. An AGENCY has exactly one organisation, so the
     * rule would have no meaning there and would only block a legitimate
     * org-wide manager invite. `=== true` and not truthiness: undefined means
     * the list has not landed or the server is old, and neither is a reason to
     * refuse.
     */
    if (orgWideBlocked && !teamId) {
      Alert.alert('Invite',
        'Choose the organisation or team this manager will run. A manager invited with no team is granted every organisation in the workspace.');
      return;
    }
    // B-154 — normalise BEFORE minting. The server stores E.164 only and
    // refuses (never guesses) a missing country prefix; the inviter's own
    // number supplies the default country.
    let e164: string | null = null;
    if (rawPhone) {
      e164 = normalizeToE164(rawPhone, callingCodeFromOwnPhone(ownPhone));
      if (!e164) {
        Alert.alert('Invite',
          'That phone number could not be understood. Include the country code, e.g. +8801…');
        return;
      }
    }
    setMinting(true);
    try {
      const {data} = await enterpriseApi.createInvite({
        ...(e164 ? {contact_phone: e164} : {}),
        ...(rawEmail ? {contact_email: rawEmail} : {}),
        ...(name.trim() ? {invited_name: name.trim()} : {}),
        ...(teamId ? {team_channel_id: teamId} : {}),
        invited_role: role,
        ...(role === 'manager' && dept.trim() ? {invited_department: dept.trim()} : {}),
      });
      setMinted({code: data.code, expires_at: data.expires_at, contact: e164 ?? rawEmail});
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      const copy: Record<string, string> = {
        invite_cap_reached: 'Your workspace already has 50 open invites. Revoke some before creating more.',
        invite_exists_for_contact: 'This person already has a live invite with different settings. Revoke it from Approvals first.',
        scoped_manager_cannot_grant_admin: 'Your manager role is scoped to one branch, so you cannot invite another manager.',
        // G6 — the SERVER's copy of the rule this form pre-flights. Reached
        // when the pre-flight was off: the channel list failed to load (so the
        // tenant is unknown), or the caller is an older build. The wording
        // matches the alert above so the two doors do not describe the same
        // rule two ways.
        manager_invite_requires_team: 'Choose the organisation or team this manager will run. A manager invited with no team is granted every organisation in the workspace.',
        team_channel_outside_your_branch: 'That team is outside your branch.',
        team_channel_is_managers_only: 'That channel is managers-only and cannot be a join target. Pick another team.',
        // vs2 item 2 — the server now refuses a #broadcast as a join target
        // (it used to accept one, and only this screen's filter stopped it).
        // The picker never offers one, so reaching this means an older client
        // or a stale pre-select; without the mapping it would read as a
        // generic connection failure.
        team_channel_is_broadcast: 'Announcement channels cannot be a join target. Pick another team.',
        team_channel_not_found: 'That team no longer exists. Pick another one.',
        // A deterministic 400 that used to read as a connection error, so the
        // admin retried it forever.
        team_channel_in_other_org: 'That team belongs to another workspace. Pick another one.',
        invite_phone_not_e164: 'That phone number could not be understood. Include the country code.',
      };
      Alert.alert('Could not create invite',
        (msg && copy[msg]) || 'Please check your connection and try again.');
    } finally {
      setMinting(false);
    }
  }, [minting, phone, email, name, teamId, role, dept, ownPhone, orgWideBlocked]);

  const shareCode = useCallback(async () => {
    if (!minted) {return;}
    try {
      // The share sheet is the delivery channel — there is deliberately no
      // SMS/email dispatch server-side (v1 non-goal).
      await Share.share({
        message: `You're invited to join our workspace on Bravo Secure. Open the app, choose "Join workspace" and enter the code ${minted.code}.`,
      });
    } catch { /* user dismissed the sheet */ }
  }, [minted]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Invite member" onBack={() => navigation.goBack()} pill="ADMIN" />

      {/* Client review vs2 item 3 — "the keyboard must never be in the way of
          text". The form was a plain ScrollView, so the ROLE radios, the branch
          field and the CTA all sat below the IME with no way to reach them.
          KeyboardAvoidingScreen is the blessed shell (B-184): the body shrinks
          by the true overlap and the CTA moves to the pinned footer. */}
      <KeyboardAvoidingScreen
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: contentBottom(24)}}
        footerGap={24}
        footer={minted ? undefined : (
          <View style={{paddingHorizontal: 20}}>
            <PrimaryButton
              label={minting ? 'Creating…' : 'Create invite'}
              icon="account-plus-outline"
              disabled={minting || (!phone.trim() && !email.trim())}
              onPress={() => { void mint(); }}
            />
          </View>
        )}>

        {minted ? (
          <>
            <SectionLabel>INVITE CREATED</SectionLabel>
            <Card style={{gap: 10}}>
              <Text style={s.codeLabel}>Share this code with {minted.contact}</Text>
              <Text style={s.code} selectable>{minted.code}</Text>
              <Text style={s.hint}>
                Only this person can use it: a phone invite is locked to their verified
                number, and every invite is single-use. They join instantly — no approval
                step. If they already use Bravo Secure, they've been notified in-app too.
              </Text>
              <PrimaryButton label="Share code" icon="share-variant-outline"
                onPress={() => { void shareCode(); }} />
              <GhostButton label="Invite someone else" icon="account-plus-outline"
                onPress={() => {
                  setMinted(null); setPhone(''); setEmail(''); setName('');
                  setDept(''); setRole('employee'); setTeamId(null);
                }} />
            </Card>
          </>
        ) : (
          <>
            <SectionLabel>WHO</SectionLabel>
            <Card style={{gap: 10}}>
              <View style={s.field}>
                <Icon name="phone-outline" size={18} color={OB.textMute} />
                <TextInput style={s.input} placeholder="Phone number (with country code)"
                  placeholderTextColor={OB.textMute} value={phone}
                  onChangeText={t => { setPhone(t); if (t.trim()) {setEmail('');} }}
                  keyboardType="phone-pad" maxLength={20} />
              </View>
              <Text style={s.or}>or</Text>
              <View style={s.field}>
                <Icon name="email-outline" size={18} color={OB.textMute} />
                <TextInput style={s.input} placeholder="Email address"
                  placeholderTextColor={OB.textMute} value={email}
                  onChangeText={t => { setEmail(t); if (t.trim()) {setPhone('');} }}
                  keyboardType="email-address" autoCapitalize="none" maxLength={160} />
              </View>
              <View style={s.field}>
                <Icon name="account-outline" size={18} color={OB.textMute} />
                <TextInput style={s.input} placeholder="Name (optional)"
                  placeholderTextColor={OB.textMute} value={name}
                  onChangeText={setName} maxLength={120} />
              </View>
              <GhostButton label="Pick from contacts" icon="contacts-outline"
                onPress={() => setPickerOpen(true)} />
            </Card>
            <Text style={s.hint}>
              A phone invite can only be accepted by the account that verified that
              number. An email invite works for whoever you share the code with.
            </Text>

            <View style={{height: 18}} />
            <SectionLabel>
              {tiered && !orgId ? 'ORGANISATION THEY JOIN' : 'TEAM THEY JOIN'}
            </SectionLabel>
            {teamsError ? (
              <ErrorState message={teamsError} onRetry={() => { void loadTeams(); }} />
            ) : (
              <Card style={{gap: 8}}>
                {/* The escape hatch. Its copy names the CROSS-ORGANISATION
                    consequence on purpose: with more than one root, seeding
                    "no specific team" grants the joiner every organisation in
                    the workspace, and "No specific team" hid that.

                    G6 — and for a MANAGER on a workspace that consequence is
                    the thing the founder asked us to remove, so the row greys
                    instead of disappearing: a control that vanishes when you
                    change an unrelated radio reads as a glitch, and the greyed
                    row is where the explanation lives. Same treatment the A8
                    manager radio already uses for the mirror-image rule. */}
                <TouchableOpacity
                  style={[s.teamRow, teamId === null && s.teamOn, orgWideBlocked && s.teamOff]}
                  activeOpacity={orgWideBlocked ? 1 : 0.85}
                  disabled={orgWideBlocked}
                  onPress={() => setTeamId(null)}
                  accessibilityRole="button"
                  // `&& !orgWideBlocked`, matching the radio glyph below. Left
                  // as `teamId === null` it announced "selected, dimmed" for a
                  // row the eye sees unselected and Create refuses — and the
                  // radio group then had no selected member at all.
                  accessibilityState={{selected: teamId === null && !orgWideBlocked, disabled: orgWideBlocked}}
                  accessibilityLabel={orgWideBlocked
                    ? `${WHOLE_WORKSPACE_LABEL}, unavailable: a manager must be given one organisation`
                    : WHOLE_WORKSPACE_LABEL}>
                  <Icon name={teamId === null && !orgWideBlocked ? 'radiobox-marked' : 'radiobox-blank'}
                    size={18} color={teamId === null && !orgWideBlocked ? OB.accent : OB.textMute} />
                  <View style={{flex: 1, minWidth: 0}}>
                    <Text style={[s.teamText, orgWideBlocked && s.teamTextOff]}>{WHOLE_WORKSPACE_LABEL}</Text>
                    {orgWideBlocked && (
                      <Text style={s.roleSub}>A manager must be given one organisation</Text>
                    )}
                  </View>
                </TouchableOpacity>

                {/* The empty state is mode-INDEPENDENT. A workspace with no
                    channels at all has no hierarchy either, so it lands in the
                    flat branch below — where an empty map renders nothing and
                    the admin is left staring at a lone escape hatch with no
                    explanation of why there is nothing to pick. */}
                {pickable.length === 0 ? (
                  <Text style={s.hint}>
                    No organisations yet — invite with no specific team, or create
                    channels first.
                  </Text>
                ) : !tiered
                  // Flat workspace — today's single list, unchanged apart from
                  // un-mintable rows now greying instead of vanishing.
                  ? pickable.map(r => teamRow(r, 0))
                  : !orgId
                    ? (tops.length === 0 ? (
                      <Text style={s.hint}>
                        No organisations yet — invite with no specific team, or create
                        channels first.
                      </Text>
                    ) : tops.map(({row: o, isOrganisation}: {row: TreeRow; isOrganisation: boolean}) => (
                      <TouchableOpacity key={o.id} style={s.orgRow} activeOpacity={0.85}
                        onPress={() => setOrgId(o.id)}
                        accessibilityRole="button"
                        // A stranded row (its parent is archived, or otherwise
                        // not in this list) still has to be reachable, but
                        // calling it an organisation would be a lie about the
                        // workspace's shape.
                        // vs2 edge A7 — the label disambiguates too, or the one
                        // affordance that cannot see the subtitle still hears
                        // two identical rows.
                        accessibilityLabel={[
                          isOrganisation ? `Open organisation ${o.name}` : `Open ${o.name}`,
                          needsOrgDisambiguator(o.name, collidingTops) ? shortOrgRef(o.id) : '',
                        ].filter(Boolean).join(', ')}>
                        <Icon name={isOrganisation ? 'domain' : 'folder-outline'}
                          size={18} color={OB.textMute} />
                        {/* vs2 edge A7 — this row decides which organisation an
                            invitee is seeded into, and names are not unique.
                            This surface has no count or role to fall back on,
                            so the id handle IS the disambiguator. Collisions only. */}
                        <Text style={s.teamText} numberOfLines={1}>
                          {o.name}
                          {orgDisambiguator(o.name, o.id, collidingTops)
                            ? `  ·  ${orgDisambiguator(o.name, o.id, collidingTops)}` : ''}
                        </Text>
                        <Icon name="chevron-right" size={20} color={OB.textMute} />
                      </TouchableOpacity>
                    )))
                    : (
                      <>
                        <TouchableOpacity style={s.crumbBack} activeOpacity={0.85}
                          onPress={() => setOrgId(null)}
                          accessibilityRole="button"
                          accessibilityLabel="Back to organisations">
                          <Icon name="chevron-left" size={18} color={OB.accentSoft} />
                          <Text style={s.crumbBackText}>All organisations</Text>
                        </TouchableOpacity>
                        {subtreeOf(pickable, orgId).map(({row, depth}) => teamRow(row, depth))}
                      </>
                    )}
              </Card>
            )}
            {blocked && (
              /**
               * ⚠️ THE SECOND HALF OF EACH SENTENCE IS G6-CONDITIONAL.
               *
               * Every branch used to end in "…so you can only invite with no
               * specific team" — which, with the escape hatch greyed two inches
               * above it, told the admin to use the one control the screen had
               * just disabled. Both fire together whenever a MANAGER invite
               * lands on a subtree where nothing is nameable, and that is not
               * exotic: a legacy `restricted` root does it every time.
               *
               * Where the teamless path is still open the old copy is right,
               * and is kept verbatim.
               */
              <Text style={s.hint}>
                {blocked === 'branch'
                  ? 'None of these teams are in your branch. '
                    + (orgWideBlocked
                      ? 'Ask an owner to widen your scope, or to create a team in your branch.'
                      : 'You can only invite with no specific team — or ask an owner to widen '
                        + 'your scope or create a team in your branch.')
                  : blocked === 'managersOnly'
                    ? 'These channels are managers-only, so they cannot be a join target. '
                      + (orgWideBlocked
                        ? 'Create a standard team first.'
                        : 'Create a standard team, or invite with no specific team.')
                    : (orgWideBlocked
                      ? 'None of these can be a join target right now, so create a standard '
                        + 'team first.'
                      : 'None of these can be a join target right now, so you can only invite '
                        + 'with no specific team.')}
              </Text>
            )}
            {droppedPreselect && (
              // The pre-select is dropped SILENTLY when the channel the admin
              // navigated in from cannot be a join target. Without this they see
              // the escape hatch quietly selected and mint a grant across every
              // organisation in the workspace, believing they picked one team.
              <Text style={s.hint}>
                That channel can’t be a join target, so no specific team is selected.
              </Text>
            )}
            {breadcrumb && (
              <Text style={s.hint} accessibilityLabel={`Selected team path ${breadcrumb}`}>
                Joining: {breadcrumb}
              </Text>
            )}

            <View style={{height: 18}} />
            <SectionLabel>ROLE</SectionLabel>
            <Card style={{gap: 8}}>
              <TouchableOpacity style={[s.teamRow, role === 'employee' && s.teamOn]}
                activeOpacity={0.85} onPress={() => setRole('employee')}
                accessibilityRole="button" accessibilityLabel="Invite as employee">
                <Icon name={role === 'employee' ? 'radiobox-marked' : 'radiobox-blank'}
                  size={18} color={role === 'employee' ? OB.accent : OB.textMute} />
                {/* A7.3 — rendered noun, never hard-coded (deptNoun.test.ts). */}
                <Text style={s.teamText}>{deptEmployeeNoun()}</Text>
              </TouchableOpacity>
              {/**
                * vs2 edge A8 — a BRANCH-SCOPED manager cannot grant the manager
                * role, and this radio used to offer it anyway, refusing only at
                * submit (`scoped_manager_cannot_grant_admin`). Honest, but after
                * the admin had filled in the whole form.
                *
                * The team rows already grey via `mintable_by_me`; this needed
                * its OWN signal, because that one is per-ROW and the refusal is
                * per-MINTER (plan G10 records exactly that). `can_grant_manager`
                * is that signal, mirroring the server rule at the one endpoint
                * that already knows the caller's branch scope.
                *
                * Absent (old server) → offered, i.e. today's behaviour: the
                * submit-time refusal remains the real boundary either way.
                */}
              <TouchableOpacity
                style={[s.teamRow, role === 'manager' && s.teamOn, canGrantManager === false && s.teamOff]}
                activeOpacity={canGrantManager === false ? 1 : 0.85}
                disabled={canGrantManager === false}
                onPress={() => setRole('manager')}
                accessibilityRole="button"
                accessibilityState={{disabled: canGrantManager === false}}
                accessibilityLabel={canGrantManager === false
                  ? 'Invite as manager, unavailable: your manager role is scoped to one branch'
                  : 'Invite as manager'}>
                <Icon name={role === 'manager' ? 'radiobox-marked' : 'radiobox-blank'}
                  size={18} color={role === 'manager' ? OB.accent : OB.textMute} />
                <View style={{flex: 1, minWidth: 0}}>
                  <Text style={[s.teamText, canGrantManager === false && s.teamTextOff]}>Manager</Text>
                  <Text style={s.roleSub}>
                    {canGrantManager === false
                      ? 'Your manager role is scoped to one branch, so you cannot invite another manager'
                      : 'Can approve joins, run attendance and manage channels'}
                  </Text>
                </View>
              </TouchableOpacity>
              {role === 'manager' && (
                <View style={s.field}>
                  <Icon name="source-branch" size={18} color={OB.textMute} />
                  <TextInput style={s.input}
                    placeholder="Branch scope (optional — blank = whole workspace)"
                    placeholderTextColor={OB.textMute} value={dept}
                    onChangeText={setDept} maxLength={80} />
                </View>
              )}
            </Card>

          </>
        )}
      </KeyboardAvoidingScreen>

      {/* item 10 — the SAME sheet EmployeesScreen renders. Q13's rule is
          unchanged: the in-app picker lists registered Bravo users from the
          address book, and somebody not on Bravo is reached by typing their
          number in the manual fields above. */}
      <BravoContactPicker
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={pickRow}
        ownPhoneE164={ownPhone}
        emptyHint="None of your contacts use Bravo Secure yet — type their number above to invite them anyway."
      />
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:     {flex: 1, backgroundColor: OB.bg},
  field:    {flexDirection: 'row', alignItems: 'center', gap: 12},
  input:    {flex: 1, color: OB.text, fontSize: 15, paddingVertical: 6},
  or:       {color: OB.textMute, fontSize: 11, textAlign: 'center'},
  hint:     {color: OB.textMute, fontSize: 12, marginTop: 8, lineHeight: 17},
  teamRow:  {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 9, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  teamOn:   {borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12'},
  teamText: {color: OB.text, fontSize: 13, flex: 1, minWidth: 0},
  // vs2 item 2 — un-mintable rows are shown greyed rather than removed, so the
  // tree keeps its shape (see the loadTeams comment).
  teamOff:  {opacity: 0.4},
  teamTextOff: {color: OB.textMute},
  orgRow:   {flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 12, borderRadius: 10, borderWidth: 1, borderColor: OB.hair, backgroundColor: 'rgba(255,255,255,0.02)'},
  rung:     {color: OB.textMute, fontSize: 11, marginBottom: 2},
  crumbBack: {flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4},
  crumbBackText: {color: OB.accentSoft, fontSize: 12},
  roleSub:  {color: OB.textMute, fontSize: 11, marginTop: 2},
  codeLabel:{color: OB.textMute, fontSize: 11, letterSpacing: 0.5},
  code:     {color: OB.text, fontSize: 26, fontWeight: '800', letterSpacing: 4, textAlign: 'center', paddingVertical: 6},
}));
