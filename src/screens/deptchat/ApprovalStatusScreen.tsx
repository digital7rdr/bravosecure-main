import React, {useCallback, useRef, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {enterpriseApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {openDepartmentChannels} from '@navigation/departmentalEntry';
import {acceptInviteFlow} from './inviteAccept';
import {OB, ObHeader, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';

type Status = 'pending' | 'approved' | 'declined';

/**
 * M11A — Approval Result / Active Access.
 *
 * "This status frame appears immediately after M5 for quick access feedback."
 * "Pending means no Enterprise content or metadata is visible."
 * "The user receives a notification when the request status changes."
 * "After approval, Enter Department Channels opens the Member Home dashboard."
 *
 * Note what this screen does NOT do: it never fetches channels, attendance,
 * incidents or files to "preview" the workspace. While pending there is nothing
 * to show — and that is enforced server-side anyway, since a pending applicant
 * has no org_members row, so those endpoints would return nothing regardless.
 * This screen simply does not ask.
 */
export default function ApprovalStatusScreen() {
  const insets = useSafeAreaInsets();
  const inDepartmentalShell = useInDepartmentalShell();
  const navigation = useNavigation<any>();

  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<Status | null>(null);
  const [orgName, setOrgName] = useState<string | null>(null);
  const [teamName, setTeamName] = useState<string | null>(null);
  const [invites, setInvites] = useState<Array<{
    code: string | null; org_name: string | null; team_name: string | null;
    invited_role: 'employee' | 'manager'; expires_at: string | null;
    acceptable: boolean;
    blocked_reason?: 'workspace_owner_cannot_join' | 'already_active_in_another_org';
  }>>([]);
  const [accepting, setAccepting] = useState(false);
  // Q11 — one refresh per approval sighting, not one per focus.
  const recheckedApproval = useRef(false);

  const load = useCallback(async () => {
    // Item E: this screen is ALSO the invitee surface — an open invite
    // addressed to the caller's phone/email shows here with a Join button.
    const [req, inv] = await Promise.allSettled([
      enterpriseApi.myJoinRequest(),
      enterpriseApi.myInvites(),
    ]);
    if (req.status === 'fulfilled') {
      const st = req.value.data.request?.status ?? null;
      setStatus(st);
      setOrgName(req.value.data.request?.org_name ?? null);
      setTeamName(req.value.data.request?.team_name ?? null);
      // Q11 — the admin approved while this user waited: their /auth/me is
      // still pre-membership, so every workspace gate would refuse the Enter
      // button's target until an app restart. Refresh once on first sight.
      if (st === 'approved' && !recheckedApproval.current) {
        recheckedApproval.current = true;
        void useAuthStore.getState().recheckMembership();
      }
    } else {
      setStatus(null);
    }
    // On a failed invite fetch keep whatever we had rather than blanking a
    // Join button the user may be about to press.
    if (inv.status === 'fulfilled') {
      // B-413 — blocked rows (workspace owners, whose accept can only 409)
      // render NO card here at all: the Workspace Hub is their one home,
      // where they show as informational rows with the reason.
      // `!== false`, not truthy: a not-yet-redeployed server omits the field,
      // and missing must mean TODAY'S behavior (show), never all-blocked.
      setInvites(inv.value.data.invites.filter(iv => iv.acceptable !== false));
    }
    setLoading(false);
  }, []);

  // Re-check on focus: the PDF promises a notification on change, and a user who
  // taps it lands back here expecting the new state.
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const accept = useCallback(async (code: string) => {
    if (accepting) {return;}
    setAccepting(true);
    try {
      // Q11 — accepting an invite IS membership: enter the workspace directly.
      // Reloading this screen instead left the invitee staring at a status
      // page whose invite card had just vanished (the invite lane creates no
      // request row, so nothing else renders either). The consumed invite is
      // dropped from local state FIRST so Back never shows a Join button for
      // a code that no longer works (the focus reload would fix it a beat
      // later; the beat is enough for a second tap).
      if (await acceptInviteFlow(code)) {
        setInvites(prev => prev.filter(iv => iv.code !== code));
        openDepartmentChannels(navigation, {preferHome: true});
      }
    } finally {
      setAccepting(false);
    }
  }, [accepting, navigation]);

  const meta = ((): {icon: string; tint: string; title: string; body: string} => {
    if (status === 'approved') {
      return {
        icon: 'check-decagram-outline', tint: OB.signal,
        title: 'Access approved',
        body: teamName
          ? `You've been added to ${teamName}${orgName ? ` at ${orgName}` : ''}.`
          : `You now have access${orgName ? ` to ${orgName}` : ''}.`,
      };
    }
    if (status === 'declined') {
      return {
        icon: 'close-circle-outline', tint: OB.alert,
        title: 'Request declined',
        // M11A: "Declined grants no access and the decision remains in the
        // Admin record." No reason is shown — the admin's notes are internal.
        body: 'Your request was not approved. If you think this is a mistake, contact whoever invited you.',
      };
    }
    return {
      icon: 'clock-outline', tint: OB.amber,
      title: 'Waiting for approval',
      body: `Your request has been sent${orgName ? ` to ${orgName}` : ''}. An admin will review it — you'll be notified as soon as they decide.`,
    };
  })();

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Request status" onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{
          paddingHorizontal: 20,
          // Mounted standalone AND inside the departmental tab shell, whose tab
          // bar already consumes the safe area — raw insets double-pad there.
          paddingBottom: (inDepartmentalShell ? 0 : insets.bottom) + 28,
        }}>

        {loading ? (
          <LoadingView compact label="Checking your request…" />
        ) : (
          <>
            {/* Item E — open invites render whenever they survive the load()
                filter: myInvites already excludes orgs the caller is active
                in, an accepted invite stops matching, and B-413 blocked rows
                (acceptable:false — workspace owners) are filtered out at
                fetch, so every row here carries a live CTA. No STATUS gate
                beyond that (an earlier `status !== 'approved'` gate hid a NEW
                org's invite behind a stale approved request — edge-case
                review). */}
            {invites.map((iv, i) => (
              <Card key={iv.code ?? `invite-${i}`}
                style={[s.hero, {borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12', marginBottom: 14}]}>
                <View style={[s.badge, {backgroundColor: OB.accent + '1F', borderColor: OB.accent + '40'}]}>
                  <Icon name="email-check-outline" size={26} color={OB.accentSoft} />
                </View>
                <Text style={s.title}>You've been invited</Text>
                <Text style={s.body}>
                  {`${iv.org_name ?? 'A workspace'} invited you${iv.invited_role === 'manager' ? ' as a manager' : ''}${iv.team_name ? ` to ${iv.team_name}` : ''}. Accepting joins instantly — no approval needed.`}
                </Text>
                <View style={{alignSelf: 'stretch', marginTop: 6}}>
                  {iv.code ? (
                    <PrimaryButton
                      label={accepting ? 'Joining…' : `Join ${iv.org_name ?? 'workspace'}`}
                      icon="check-circle-outline"
                      disabled={accepting}
                      onPress={() => { void accept(iv.code as string); }}
                    />
                  ) : (
                    <>
                      {/* Email invites carry NO code here — the account email
                          is unverified, so the credential travels out-of-band
                          (the admin shares it). Point at the code entry. */}
                      <Text style={s.note}>
                        Ask whoever invited you for the invite code, then enter it to join.
                      </Text>
                      <PrimaryButton
                        label="Enter invite code"
                        icon="ticket-confirmation-outline"
                        onPress={() => navigation.navigate('JoinWorkspace')}
                      />
                    </>
                  )}
                </View>
              </Card>
            ))}
            {renderRequest()}
          </>
        )}
      </ScrollView>
    </View>
  );

  function renderRequest() {
    if (status === null) {
      // With a live invite on screen, the no-request card would only muddy the
      // single action that matters.
      if (invites.length > 0) {return null;}
      return (
        <Card>
          <Text style={s.body}>
            You don't have a pending request. Open an invitation link to apply to a workspace.
          </Text>
        </Card>
      );
    }
    return (
          <>
            <Card style={[s.hero, {borderColor: meta.tint + '4D', backgroundColor: meta.tint + '12'}]}>
              <View style={[s.badge, {backgroundColor: meta.tint + '1F', borderColor: meta.tint + '40'}]}>
                <Icon name={meta.icon as never} size={26} color={meta.tint} />
              </View>
              <Text style={s.title}>{meta.title}</Text>
              <Text style={s.body}>{meta.body}</Text>
            </Card>

            {status === 'pending' && (
              <Text style={s.note}>
                Until an admin approves you, none of the workspace is visible — no channels,
                attendance, incidents or files.
              </Text>
            )}

            {status === 'approved' && (
              <>
                <View style={{height: 18}} />
                {/* M11A — "After approval, Enter Department Channels opens the
                    Member Home dashboard." Routed through the shared entry
                    helper, never a hard-coded route name: this screen is
                    reachable from more than one navigator, and a bare
                    navigate() to a route the mounted tree lacks is silently
                    DROPPED (the documented departmentalEntry failure). */}
                <PrimaryButton
                  label="Enter workspace"
                  icon="arrow-right"
                  // Q4/Q11 — an approved member's landing is the Member Home
                  // dashboard (M11A's own words), not the channel directory.
                  onPress={() => { openDepartmentChannels(navigation, {preferHome: true}); }}
                />
              </>
            )}
      </>
    );
  }
}

const s = StyleSheet.create(scaleTextStyles({
  root:  {flex: 1, backgroundColor: OB.bg},
  hero:  {alignItems: 'center', gap: 10, paddingVertical: 22},
  badge: {
    width: 56, height: 56, borderRadius: 28, alignItems: 'center',
    justifyContent: 'center', borderWidth: 1,
  },
  title: {color: OB.text, fontSize: 17, fontWeight: '800'},
  body:  {color: OB.textDim, fontSize: 13, lineHeight: 19, textAlign: 'center'},
  note:  {color: OB.textMute, fontSize: 12, lineHeight: 18, marginTop: 12, textAlign: 'center'},
}));
