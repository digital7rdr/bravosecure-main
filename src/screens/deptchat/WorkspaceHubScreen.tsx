import React, {useCallback, useMemo, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, Image} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {getInitials} from '@utils/helpers';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {enterpriseApi, departmentApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';
import {unreadOfGroup} from './channelUnread';
import {UnreadPill} from './UnreadPill';
import {useActiveWorkspace} from '@store/activeWorkspace';
import {openDepartmentChannels, type ResolvableNavigation} from '@navigation/departmentalEntry';
import {acceptInviteFlow} from './inviteAccept';
import {Imagery} from '@theme/imagery';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton} from './_obsidian';
import {collidingOrgNames, orgDisambiguator} from './orgDisambiguation';

type InviteRow = {
  code: string | null; org_name: string | null; team_name: string | null;
  invited_role: 'employee' | 'manager'; expires_at: string | null;
  acceptable: boolean;
  blocked_reason?: 'workspace_owner_cannot_join' | 'already_active_in_another_org';
};

/**
 * F-WSHUB — the workspace list page (Discord/Slack style, doc §6).
 *
 * Three existing calls compose the page — no new endpoint:
 *   1. "Your workspace"  — enterpriseApi.myWorkspace() when owns_workspace.
 *   2. "Member of"       — user.org when org_is_workspace and not their own
 *                          (the owner's org row has org.id === user.id).
 *   3. "Invitations"     — enterpriseApi.myInvites(): acceptable rows reuse
 *                          ApprovalStatusScreen's accept flow INCLUDING the
 *                          code:null fork (email invites carry no code);
 *                          blocked rows (B-413 workspace owners) render
 *                          informationally with the reason — never a CTA,
 *                          never a badge/count on any entry point.
 *   4. Empty state       — "Create a workspace" → the existing setup fork.
 *
 * ENTERING a workspace goes through the departmentalEntry resolver — a bare
 * navigate('Departmental') only lands on Home for a COLD mount (its :124-127
 * warning), and this screen is reached from more than one place.
 *
 * Under today's one-org rule the list holds at most one enterable workspace
 * plus invites; Phase B drops multi-entries into a page that already exists.
 */
export default function WorkspaceHubScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const user = useAuthStore(st => st.user);

  const [loading, setLoading] = useState(true);
  const [ownName, setOwnName] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteRow[]>([]);
  const [accepting, setAccepting] = useState(false);
  // Phase B / edge review #1 — per-workspace unread, or a cross-workspace
  // dept message is discoverable ONLY via its push notification (dept
  // conversations are hidden from every messenger list by design, and every
  // other dept surface is context-scoped). Built from the UNSCOPED channel
  // list (org_id per channel, new server) + the local messenger store's
  // unread counters; an old server has no org_id → empty map → no dots.
  const [unreadByOrg, setUnreadByOrg] = useState<Record<string, number>>({});

  // Server truth beats the client flag: an owner whose persisted
  // owns_workspace is stale-false would otherwise land on an empty hub whose
  // only CTA is "Create a workspace" → EnterpriseSetup → redirect back here —
  // a dead cycle (edge-case review #3). myWorkspace() is fetched
  // unconditionally; the flag only pre-renders the tile while it loads.
  const [serverOwns, setServerOwns] = useState<boolean | null>(null);
  const ownsWorkspace = serverOwns ?? (user?.owns_workspace === true);
  // Membership, never ownership: org_workspaces keys the org on its owner, so
  // the owner's own /auth/me org row has org.id === user.id.
  const memberOrg = user?.org && user.org_is_workspace === true && user.org.id !== user.id
    ? user.org
    : null;

  const load = useCallback(async () => {
    /**
     * REFRESH THE AFFILIATION LIST FIRST. The tiles come from
     * `user.workspaces`, which only changes on `recheckMembership` — and that
     * runs on app foreground with a 30s floor, or inside acceptInviteFlow.
     *
     * So an admin approving Dana's join request, or adding her via Employees,
     * produced nothing: she opened the hub and saw one tile. And since a tile
     * is the ONLY place a workspace context is ever set, she could not enter
     * the new organisation OR get her authority scoped to it until she
     * backgrounded and foregrounded the app. Awaited, so the tiles below are
     * drawn from the refreshed list rather than one render behind it.
     */
    await useAuthStore.getState().recheckMembership().catch(() => {});
    const [ws, inv, ch] = await Promise.allSettled([
      enterpriseApi.myWorkspace(),
      enterpriseApi.myInvites(),
      // UNSCOPED on purpose: the dots must cover every workspace.
      departmentApi.listChannels(),
    ]);
    if (ws.status === 'fulfilled' && ws.value) {
      setOwnName(ws.value.data.workspace?.name ?? null);
      setServerOwns(!!ws.value.data.workspace);
    }
    // On a failed fetch keep what we had — never blank a Join button mid-tap.
    if (inv.status === 'fulfilled') {
      setInvites(inv.value.data.invites);
    }
    if (ch.status === 'fulfilled') {
      const convs = useMessengerStore.getState().conversations;
      const byOrg: Record<string, number> = {};
      for (const c of ch.value.data.channels ?? []) {
        if (!c.org_id || !c.group_conversation_id) {continue;}
        byOrg[c.org_id] = (byOrg[c.org_id] ?? 0) + unreadOfGroup(convs, c.group_conversation_id);
      }
      setUnreadByOrg(byOrg);
    }
    setLoading(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const accept = useCallback(async (code: string) => {
    if (accepting) {return;}
    setAccepting(true);
    try {
      // Same shape as ApprovalStatusScreen: drop the consumed invite FIRST so
      // Back never shows a Join button for a code that no longer works.
      if (await acceptInviteFlow(code)) {
        setInvites(prev => prev.filter(iv => iv.code !== code));
        // Phase B — acceptInviteFlow already pointed the workspace context at
        // the org just joined (ONE site, shared by all three accept
        // surfaces); this caller only navigates.
        openDepartmentChannels(navigation as ResolvableNavigation, {preferHome: true});
      }
    } finally {
      setAccepting(false);
    }
  }, [accepting, navigation]);

  /**
   * item 01 — THE PERSON, never an organisation.
   *
   * `full_name` is typed non-optional, so a `??` chain past it is unreachable to
   * TS — but it is a server string and can arrive EMPTY, which would render a
   * blank identity block. `.trim() ||` is the fallback that actually fires;
   * `?? ''` only guards a user object that has not loaded yet.
   */
  const displayName = (user?.full_name ?? '').trim() || user?.email || 'Your profile';
  // ONE shared helper — ProfileDrawerModal's copy is inline and unexported, and
  // this repo already carries ~10 hand-rolled initials derivations. Adding an
  // 11th here is the named duplicate-copy class.
  const initials = getInitials(displayName) || 'B';

  const ownDisplayName = ownName
    ?? (user?.org && user.org.id === user.id ? user.org.name : null)
    ?? 'Your workspace';
  // Phase B — the server's workspaces array is the real list (an owner can
  // now ALSO be a member elsewhere). Absent (old server) → the legacy
  // own/member pair below, which is exactly today's single-affiliation view.
  const wsList = user?.workspaces;
  // vs2 edge A7 — computed once per render, not per tile: it is a property of
  // the LIST, and a per-row scan would be quadratic on the one screen that
  // exists to show every workspace a person belongs to.
  const collidingHubNames = useMemo(
    () => collidingOrgNames((wsList ?? []).map(w => w.name || 'Workspace')), [wsList]);
  const enterWorkspace = useCallback((w: {org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'} | null) => {
    // Context BEFORE navigation: the Departmental surface scopes its
    // channel reads and role chrome off it on first render.
    useActiveWorkspace.getState().setActiveWorkspace(w);
    openDepartmentChannels(navigation as ResolvableNavigation, {preferHome: true});
  }, [navigation]);
  // Phase B / edge review G1 — `[]` and `undefined` mean DIFFERENT things:
  // undefined = old server (fall back to the legacy own/member pair); [] =
  // new server says "zero ENTERABLE workspaces", which the legacy flags must
  // not contradict with enterable-looking tiles. The two [] cohorts get an
  // honest informational card instead: a LAPSED owner (ws row exists —
  // serverOwns — but not in the array) and a SUSPENDED member (org set,
  // membership_status suspended).
  const trustArray = wsList !== undefined;
  const lapsedOwner = trustArray && wsList.length === 0 && serverOwns === true;
  const suspendedMember = trustArray && wsList.length === 0
    && !!user?.org && user.org_is_workspace === true && user.membership_status === 'suspended';
  const empty = (trustArray ? wsList.length === 0 : (!ownsWorkspace && !memberOrg))
    && invites.length === 0 && !lapsedOwner && !suspendedMember;

  /**
   * item 01 — the secondary line under the name. Counts AFFILIATIONS, which is
   * the founder's own framing ("may be a part of many organisations"), so the
   * page says plainly that the person is one thing and the organisations are
   * several. Falls back to a neutral label while the list is still loading
   * rather than asserting "0 workspaces" at someone who has three.
   */
  const affiliationLine = loading
    ? 'Your workspaces'
    : wsList === undefined
      ? 'Your workspaces'
      : wsList.length === 0
        // Deliberately NOT "No workspaces yet" — that exact string is already the
        // empty-state card's heading further down, and two identical sentences on
        // one screen read as a rendering bug (and make every test ambiguous).
        ? 'Not in a workspace yet'
        : `${wsList.length} workspace${wsList.length === 1 ? '' : 's'}`;

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Workspaces" onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: insets.bottom + 28}}>

        {/**
          * UI corrections 2026-08-15 item 01 — "It must always be the users
          * name, as same user may be a part of many organisations,
          * associations etc."
          *
          * The screenshot circles the SASFA tile: the only identity on this page
          * was an ORGANISATION's name, so the page read as "you are SASFA".
          * One person can own, manage and belong to several organisations, so the
          * identity here is the PERSON and the organisations are things listed
          * underneath them.
          *
          * Rendered ABOVE the loading fork on purpose: who you are does not
          * depend on a network call, and putting it inside the fork would make
          * the page briefly identity-less on every open — which is the state the
          * founder is complaining about.
          */}
        <View style={s.identity}>
          <View style={s.identityAvatar}>
            {user?.avatar_url
              ? <Image source={{uri: user.avatar_url}} style={s.identityAvatarImg} />
              : <Text style={s.identityInitials}>{initials}</Text>}
          </View>
          <View style={{flex: 1, minWidth: 0}}>
            <Text style={s.identityName} numberOfLines={1}>{displayName}</Text>
            <Text style={s.identitySub} numberOfLines={1}>{affiliationLine}</Text>
          </View>
        </View>

        {loading ? (
          <LoadingView compact label="Loading your workspaces…" />
        ) : (
          <>
            {wsList && wsList.length > 0 ? (
              // Phase B — the Discord model: every affiliation, one tile each,
              // entering sets the workspace context (channel scope + role
              // chrome) before navigating.
              <>
                <SectionLabel>YOUR WORKSPACES</SectionLabel>
                {wsList.map(w => {
                  const isOwner = w.role === 'owner';
                  const roleLabel = isOwner ? 'Owner · Manage and enter'
                    : w.role === 'manager' ? 'Manager · Enter workspace'
                      : 'Member · Enter workspace';
                  /**
                   * vs2 edge A7 — two workspaces can share a name, and this
                   * tile decides which company's data the whole Departmental
                   * surface then reads AND writes. The role line is already
                   * here and often separates them on its own; the id handle is
                   * the tiebreak when it does not. Rendered only on a collision.
                   */
                  const disambiguator = orgDisambiguator(
                    w.name || 'Workspace', w.org_id, collidingHubNames, roleLabel);
                  const unread = unreadByOrg[w.org_id] ?? 0;
                  return (
                    <Card key={w.org_id} style={s.wsCard} onPress={() => enterWorkspace(w)}>
                      <View style={[s.wsIcon, isOwner
                        ? {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: OB.accent + '40'}
                        : {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: OB.signal + '40'}]}>
                        <Icon name={isOwner ? 'office-building-outline' : 'account-group-outline'}
                          size={22} color={isOwner ? OB.accent : OB.signal} />
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.wsName} numberOfLines={1}>{w.name || 'Workspace'}</Text>
                        <Text style={s.wsSub}>{disambiguator ?? roleLabel}</Text>
                      </View>
                      {/* Edge review #1 — without this dot a message in the
                          OTHER workspace is discoverable only via its push. */}
                      <UnreadPill count={unread} />
                      <Icon name="chevron-right" size={20} color={OB.textMute} />
                    </Card>
                  );
                })}
                {/* Critic MAJOR-3a — an agency-affiliated person's org is
                    deliberately NOT a workspace tile, so without this row an
                    agency CPO/manager who owns a personal workspace could
                    enter it once and never point the Departmental surface
                    back at their agency (sticky context, nothing clears it).
                    Entering with a null context = primary-org mode. */}
                {user?.org && !wsList.some(w => w.org_id === user.org?.id) && (
                  <Card style={s.wsCard} onPress={() => enterWorkspace(null)}>
                    <View style={[s.wsIcon, {backgroundColor: 'rgba(255,255,255,0.05)', borderColor: OB.hair2}]}>
                      <Icon name="domain" size={22} color={OB.textMute} />
                    </View>
                    <View style={{flex: 1, minWidth: 0}}>
                      <Text style={s.wsName} numberOfLines={1}>{user.org.name || 'Your organisation'}</Text>
                      <Text style={s.wsSub}>Your organisation · Enter</Text>
                    </View>
                    <Icon name="chevron-right" size={20} color={OB.textMute} />
                  </Card>
                )}
                <View style={{height: 18}} />
              </>
            ) : trustArray ? (
              // New server, zero enterable workspaces — honest states, no
              // enterable-looking tiles (edge review G1).
              <>
                {lapsedOwner && (
                  <>
                    <SectionLabel>YOUR WORKSPACE</SectionLabel>
                    <Card style={s.wsCard}>
                      <View style={[s.wsIcon, {backgroundColor: 'rgba(245,181,68,0.10)', borderColor: OB.amber + '40'}]}>
                        <Icon name="office-building-outline" size={22} color={OB.amber} />
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.wsName} numberOfLines={1}>{ownDisplayName}</Text>
                        <Text style={s.wsSub}>Subscription lapsed — renew Enterprise to enter</Text>
                      </View>
                    </Card>
                    <View style={{height: 18}} />
                  </>
                )}
                {suspendedMember && (
                  <>
                    <SectionLabel>MEMBER OF</SectionLabel>
                    <Card style={s.wsCard}>
                      <View style={[s.wsIcon, {backgroundColor: 'rgba(245,181,68,0.10)', borderColor: OB.amber + '40'}]}>
                        <Icon name="account-group-outline" size={22} color={OB.amber} />
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.wsName} numberOfLines={1}>{user?.org?.name ?? 'Workspace'}</Text>
                        <Text style={s.wsSub}>Membership suspended — contact your admin</Text>
                      </View>
                    </Card>
                    <View style={{height: 18}} />
                  </>
                )}
              </>
            ) : (
              // Old-server fallback — the legacy own/member pair (at most one
              // of each is possible pre-Phase-B). Entering clears any context
              // so the surface runs in primary-org mode, exactly as today.
              <>
                {ownsWorkspace && (
                  <>
                    <SectionLabel>YOUR WORKSPACE</SectionLabel>
                    <Card style={s.wsCard} onPress={() => enterWorkspace(null)}>
                      <View style={[s.wsIcon, {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: OB.accent + '40'}]}>
                        <Icon name="office-building-outline" size={22} color={OB.accent} />
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.wsName} numberOfLines={1}>{ownDisplayName}</Text>
                        <Text style={s.wsSub}>Owner · Manage and enter</Text>
                      </View>
                      <Icon name="chevron-right" size={20} color={OB.textMute} />
                    </Card>
                    <View style={{height: 18}} />
                  </>
                )}

                {memberOrg && (
                  <>
                    <SectionLabel>MEMBER OF</SectionLabel>
                    <Card style={s.wsCard} onPress={() => enterWorkspace(null)}>
                      <View style={[s.wsIcon, {backgroundColor: 'rgba(74,222,128,0.10)', borderColor: OB.signal + '40'}]}>
                        <Icon name="account-group-outline" size={22} color={OB.signal} />
                      </View>
                      <View style={{flex: 1, minWidth: 0}}>
                        <Text style={s.wsName} numberOfLines={1}>{memberOrg.name}</Text>
                        <Text style={s.wsSub}>Member · Enter workspace</Text>
                      </View>
                      <Icon name="chevron-right" size={20} color={OB.textMute} />
                    </Card>
                    <View style={{height: 18}} />
                  </>
                )}
              </>
            )}

            {invites.length > 0 && (
              <>
                <SectionLabel>INVITATIONS</SectionLabel>
                {invites.map((iv, i) => {
                  // `!== false`, not truthy: a not-yet-redeployed server omits
                  // the field, and missing must mean TODAY'S behavior
                  // (offer the join), never all-blocked.
                  const canAccept = iv.acceptable !== false;
                  return (
                  <Card
                    key={iv.code ?? `invite-${i}`}
                    style={[s.inviteCard, canAccept
                      ? {borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12'}
                      : {borderColor: OB.hair2}]}>
                    <View style={s.inviteHead}>
                      <Icon
                        name={canAccept ? 'email-check-outline' : 'information-outline'}
                        size={18}
                        color={canAccept ? OB.accentSoft : OB.textMute}
                      />
                      <Text style={s.inviteOrg} numberOfLines={1}>{iv.org_name ?? 'A workspace'}</Text>
                    </View>
                    {canAccept ? (
                      <>
                        <Text style={s.inviteBody}>
                          {`Invited you${iv.invited_role === 'manager' ? ' as a manager' : ''}${iv.team_name ? ` to ${iv.team_name}` : ''}. Accepting joins instantly — no approval needed.`}
                        </Text>
                        {iv.code ? (
                          <PrimaryButton
                            label={accepting ? 'Joining…' : `Join ${iv.org_name ?? 'workspace'}`}
                            icon="check-circle-outline"
                            disabled={accepting}
                            onPress={() => { void accept(iv.code as string); }}
                          />
                        ) : (
                          <>
                            {/* The code:null fork — email invites carry no code
                                (unverified email, credential travels
                                out-of-band). Point at the code entry. */}
                            <Text style={s.inviteNote}>
                              Ask whoever invited you for the invite code, then enter it to join.
                            </Text>
                            <PrimaryButton
                              label="Enter invite code"
                              icon="ticket-confirmation-outline"
                              onPress={() => navigation.navigate('JoinWorkspace')}
                            />
                          </>
                        )}
                      </>
                    ) : (
                      /* B-413 — informational only. Honest reason, no verb:
                         this accept can only 409 (same copy family as
                         inviteAccept's 409 mapping). */
                      <Text style={s.inviteBody}>
                        {`Invited you${iv.team_name ? ` to ${iv.team_name}` : ''} — but ${
                          iv.blocked_reason === 'already_active_in_another_org'
                            ? 'this account is already serving as an officer with another organisation. Leave that roster first to accept.'
                            : "this account owns its own workspace, so it can't join another one. If you no longer use that workspace, contact support to remove it."
                        }`}
                      </Text>
                    )}
                  </Card>
                  );
                })}
              </>
            )}

            {empty && (
              <>
                <SectionLabel>GET STARTED</SectionLabel>
                <Card style={s.emptyCard} img={Imagery.deptWorkspaces} imgVariant="hero">
                  <View style={[s.wsIcon, {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: OB.accent + '40', alignSelf: 'center'}]}>
                    <Icon name="office-building-outline" size={22} color={OB.accent} />
                  </View>
                  <Text style={s.emptyTitle}>No workspaces yet</Text>
                  <Text style={s.emptyBody}>
                    Create your organisation's secure workspace, or ask an admin to invite you to theirs.
                  </Text>
                  <View style={{alignSelf: 'stretch', marginTop: 6}}>
                    <PrimaryButton
                      label="Create a workspace"
                      icon="plus-circle-outline"
                      onPress={() => navigation.navigate('EnterpriseSetup')}
                    />
                  </View>
                </Card>
              </>
            )}

            {/* Standing door to the code-entry flow. Without it the only paths
                to JoinWorkspace from this page were an email-invite row's
                code:null fork or EnterpriseSetup — someone handed a referral
                code out-of-band had no way in. Always rendered: the server
                decides eligibility, and JoinWorkspaceScreen already carries
                the honest refusal copy (B-413 owner / active-elsewhere). */}
            <View style={{height: 4}} />
            <SectionLabel>JOIN A WORKSPACE</SectionLabel>
            <Card style={s.wsCard} onPress={() => navigation.navigate('JoinWorkspace')}>
              <View style={[s.wsIcon, {backgroundColor: 'rgba(91,141,239,0.14)', borderColor: OB.accent + '40'}]}>
                <Icon name="ticket-confirmation-outline" size={22} color={OB.accent} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.wsName} numberOfLines={1}>Have an invite code?</Text>
                <Text style={s.wsSub}>Enter it to join an existing workspace</Text>
              </View>
              <Icon name="chevron-right" size={20} color={OB.textMute} />
            </Card>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:       {flex: 1, backgroundColor: OB.bg},
  // item 01 — the PERSON heads this page; organisations are listed beneath.
  identity:   {flexDirection: 'row', alignItems: 'center', gap: 14, paddingTop: 4, paddingBottom: 20},
  identityAvatar: {
    width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(91,141,239,0.14)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.35)',
    overflow: 'hidden',
  },
  identityAvatarImg: {width: 52, height: 52, borderRadius: 26},
  wsCard:     {flexDirection: 'row', alignItems: 'center', gap: 14},
  wsIcon:    {
    width: 44, height: 44, borderRadius: 14, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1,
  },
  identityInitials: {color: OB.accentSoft, fontSize: 18, fontWeight: '800'},
  identityName:     {color: OB.text, fontSize: 19, fontWeight: '800', letterSpacing: -0.3},
  identitySub:      {color: OB.textDim, fontSize: 12.5, marginTop: 3},
  wsName:     {color: OB.text, fontSize: 15, fontWeight: '700'},
  wsSub:      {color: OB.textDim, fontSize: 12, marginTop: 3},
  inviteCard: {gap: 10, marginBottom: 12},
  inviteHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
  inviteOrg:  {color: OB.text, fontSize: 14, fontWeight: '700', flex: 1, minWidth: 0},
  inviteBody: {color: OB.textDim, fontSize: 12.5, lineHeight: 18},
  inviteNote: {color: OB.textMute, fontSize: 12, lineHeight: 17},
  emptyCard:  {alignItems: 'center', gap: 10, paddingVertical: 22},
  emptyTitle: {color: OB.text, fontSize: 16, fontWeight: '800'},
  emptyBody:  {color: OB.textDim, fontSize: 12.5, lineHeight: 19, textAlign: 'center'},
}));
