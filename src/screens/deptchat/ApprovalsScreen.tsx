import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TouchableOpacity, RefreshControl} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useFocusEffect} from '@react-navigation/native';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import LoadingView from '@components/LoadingView';
import {enterpriseApi, type JoinRequestDto} from '@services/api';
import {deptEmployeeNoun} from './deptNoun';
import {WHOLE_WORKSPACE_LABEL} from './organisationTree';
import {OB, ObHeader, SectionLabel, Card, ErrorState, loadErrorText, useInDepartmentalShell} from './_obsidian';

/**
 * A11 — Approvals / Notifications.
 *
 * "A Member referral link or code creates a Request to Join notification for
 * Admin. Show applicant name, mobile, email, referrer, Enterprise and exact team
 * requested. Admin decision actions are exactly Approve or Decline."
 *
 * The two actions are two separate endpoints, not a status field, so the client
 * cannot invent a third outcome.
 *
 * "If two Admins act, the first decision wins and the second receives a conflict
 * state" — the server claims the row with a conditional UPDATE and returns 409.
 * This screen surfaces that as a plain explanation rather than a generic error,
 * because it is a NORMAL race between two admins, not a fault.
 */
export default function ApprovalsScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<any>();
  const inDepartmentalShell = useInDepartmentalShell();

  const [requests, setRequests] = useState<JoinRequestDto[]>([]);
  // F15 — the join-request inbox IS the whole join→approve loop. A swallowed
  // failure here reads as "nobody has asked to join", which is the single most
  // misleading thing this module can say to an admin.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  // Item E — open direct invites (bound, single-use). Separate error lane so a
  // failed invite fetch cannot masquerade as "no invites" (the F15 rule).
  const [invites, setInvites] = useState<Array<{
    code: string; contact: string; contact_kind: 'phone' | 'email';
    invited_name: string | null; invited_role: string; team_name: string | null;
    status: 'pending' | 'accepted' | 'expired' | 'revoked';
    expires_at: string | null; created_at: string;
  }>>([]);
  const [invitesError, setInvitesError] = useState<string | null>(null);

  // Q14 (founder, 2026-08-08) — the multi-use REFERRAL-LINK lane is retired
  // from the UI: it never consumed on use (any number of people could apply
  // with one code, and the code never disappeared), which is exactly what the
  // founder reported as a bug. Direct invites below are bound to one person,
  // single-use, atomically claimed. Legacy links in the wild still resolve
  // server-side until their 7-day expiry, and their requests still land in
  // JOIN REQUESTS — nothing already shared breaks.
  const load = useCallback(async () => {
    try {
      const {data} = await enterpriseApi.listJoinRequests();
      setRequests(data.requests ?? []);
      setLoadError(null);
    } catch (e) {
      setRequests([]);
      setLoadError(loadErrorText(e));
    }
    // Item E — the open direct invites, revocable from here.
    try {
      const {data} = await enterpriseApi.listInvites();
      setInvites((data.invites ?? []).filter(i => i.status === 'pending'));
      setInvitesError(null);
    } catch (e) {
      setInvitesError(loadErrorText(e));
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  const [revoking, setRevoking] = useState<string | null>(null);
  const revokeInvite = useCallback(async (inviteCode: string) => {
    if (revoking) {return;}
    setRevoking(inviteCode);
    try {
      await enterpriseApi.revokeInvite(inviteCode);
      setInvites(prev => prev.filter(i => i.code !== inviteCode));
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      if (msg === 'invite_already_accepted') {
        // Not an error to paper over: the person is a MEMBER now, and a revoke
        // cannot undo that — removal goes through the roster.
        Alert.alert('Already accepted',
          'This person already joined, so the invite cannot be revoked. Manage them from the roster instead.');
        void load();
      } else {
        Alert.alert('Could not revoke', 'Please check your connection and try again.');
      }
    } finally {
      setRevoking(null);
    }
  }, [load, revoking]);

  const decide = useCallback(async (req: JoinRequestDto, approve: boolean) => {
    if (busy) {return;}
    setBusy(req.id);
    try {
      if (approve) {
        await enterpriseApi.approveJoinRequest(req.id);
      } else {
        await enterpriseApi.declineJoinRequest(req.id);
      }
      setRequests(prev => prev.filter(r => r.id !== req.id));
    } catch (e: unknown) {
      const status = (e as {response?: {status?: number}})?.response?.status;
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      // 409 is NOT one condition any more: the grant refusals (suspended,
      // roster history, owns-a-workspace, active elsewhere) are Conflicts too,
      // and calling them "already decided" told the admin a still-pending
      // request was settled — it survives the refresh and every retry repeats
      // the lie (critic, 2026-08-08). Branch on the MESSAGE.
      if (status === 409 && (msg === 'join_request_already_decided' || !msg)) {
        // A11's conflict state. Another admin got there first — that is the
        // system working, so say what happened rather than "Something failed".
        Alert.alert('Already decided',
          'Another admin has already approved or declined this request. Refreshing the list.');
        void load();
      } else if (status === 409) {
        const copy: Record<string, string> = {
          member_suspended_use_roster_status:
            'This applicant is a suspended member. Lift the suspension from the roster instead.',
          member_exists_use_roster_status:
            'This applicant already has a roster history here. Reinstate them from the roster instead.',
          already_active_in_another_org:
            'This applicant is already an active member of another organisation.',
          workspace_owner_cannot_join:
            'This applicant owns their own workspace, so they cannot join yours.',
          cannot_join_own_workspace:
            'This request is from the workspace account itself and cannot be approved.',
          // vs2 item 2 (P2-d) — the request named a team that is archived,
          // deleted or now managers-only, and nothing above it is joinable
          // either. Approving would have made them a member who can see no
          // channels at all, so the approval is refused instead and the request
          // stays pending. Without this mapping it reads as the generic
          // "cannot be approved right now", which names nothing the admin can
          // act on.
          team_channel_unavailable_reinvite:
            'The team on this request is no longer available, so there is nothing to add '
            + 'them to. Restore or replace that channel, then approve.',
        };
        Alert.alert('Could not approve',
          msg ? copy[msg] ?? 'This request cannot be approved right now.' : 'This request cannot be approved right now.');
      } else {
        Alert.alert('Could not save', msg ?? 'Please check your connection and try again.');
      }
    } finally {
      setBusy(null);
    }
  }, [busy, load]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader
        title="Approvals"
        onBack={() => navigation.goBack()}
        pill={requests.length ? `${requests.length} PENDING` : 'ADMIN'}
      />

      <ScrollView
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={refreshing} tintColor={OB.accentSoft}
            onRefresh={() => { setRefreshing(true); void load(); }} />
        }
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: (inDepartmentalShell ? 0 : insets.bottom) + 28,
        }}>

        {/* Item E — bound single-use invites: the admin picks the person, team
            and role up front, and acceptance joins instantly. Q14 retired the
            multi-use referral-code block that used to sit above this — one
            code per person, consumed on use, is now the only lane. */}
        <SectionLabel>INVITES</SectionLabel>
        <Card style={{gap: 10}}>
          <TouchableOpacity style={[s.btn, s.approve]} activeOpacity={0.85}
            accessibilityRole="button" accessibilityLabel="Invite by phone or email"
            onPress={() => navigation.navigate('InviteMember')}>
            <Icon name="account-plus-outline" size={16} color={OB.signal} />
            <Text style={[s.btnText, {color: OB.signal}]}>Invite by phone or email</Text>
          </TouchableOpacity>
          {invitesError ? (
            <Text style={s.inviteErr}>{invitesError}</Text>
          ) : invites.map(iv => (
            <View key={iv.code} style={s.inviteRow}>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.name} numberOfLines={1}>
                  {iv.invited_name ?? iv.contact}
                </Text>
                <Text style={s.sub} numberOfLines={1}>
                  {iv.invited_name ? `${iv.contact} · ` : ''}
                  {iv.invited_role === 'manager' ? 'Manager' : deptEmployeeNoun()}
                  {iv.team_name ? ` · ${iv.team_name}` : ''}
                </Text>
              </View>
              <TouchableOpacity style={s.revokeBtn} activeOpacity={0.85}
                disabled={revoking === iv.code}
                accessibilityRole="button" accessibilityLabel={`Revoke invite for ${iv.invited_name ?? iv.contact}`}
                onPress={() => { void revokeInvite(iv.code); }}>
                <Icon name="link-off" size={14} color={OB.alert} />
                <Text style={[s.btnText, {color: OB.alert, fontSize: 12}]}>Revoke</Text>
              </TouchableOpacity>
            </View>
          ))}
        </Card>

        <View style={{height: 18}} />
        <SectionLabel>JOIN REQUESTS</SectionLabel>

        {loading ? (
          <LoadingView compact label="Loading requests…" />
        ) : loadError ? (
          <ErrorState message={loadError} onRetry={() => { setLoading(true); void load(); }} />
        ) : requests.length === 0 ? (
          <Card>
            <Text style={s.empty}>
              No one is waiting to join. Invite people directly by phone or email —
              they join instantly with their personal code.
            </Text>
          </Card>
        ) : requests.map(r => (
          <Card key={r.id} style={s.card}>
            <View style={s.row}>
              <View style={s.avatar}>
                <Icon name="account-clock-outline" size={20} color={OB.accent} />
              </View>
              <View style={{flex: 1, minWidth: 0}}>
                <Text style={s.name} numberOfLines={1}>
                  {r.applicant_name ?? r.applicant_email ?? 'Applicant'}
                </Text>
                {/* A11 lists exactly these fields for the admin to judge on. */}
                <Text style={s.sub} numberOfLines={1}>
                  {[r.applicant_phone, r.applicant_email].filter(Boolean).join(' · ') || '—'}
                </Text>
                <Text style={s.meta} numberOfLines={1}>
                  {/* vs2 item 2 (plan edge N8) — ONE constant, shared with the
                      invite form's escape hatch. This used to read "No specific
                      team" while the admin had picked "Whole workspace (all
                      organisations)", describing the same grant two different
                      ways one screen apart — and understating it, since with
                      more than one root it really is every organisation. */}
                  {r.team_name ? `Team: ${r.team_name}` : WHOLE_WORKSPACE_LABEL}
                  {r.referrer_name ? ` · Referred by ${r.referrer_name}` : ''}
                </Text>
              </View>
            </View>

            {r.message ? <Text style={s.message} numberOfLines={3}>{r.message}</Text> : null}

            <View style={s.actions}>
              <TouchableOpacity
                style={[s.btn, s.decline]}
                activeOpacity={0.85}
                disabled={busy === r.id}
                accessibilityRole="button"
                accessibilityLabel={`Decline ${r.applicant_name ?? 'applicant'}`}
                onPress={() => { void decide(r, false); }}>
                <Icon name="close" size={16} color={OB.alert} />
                <Text style={[s.btnText, {color: OB.alert}]}>Decline</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.btn, s.approve]}
                activeOpacity={0.85}
                disabled={busy === r.id}
                accessibilityRole="button"
                accessibilityLabel={`Approve ${r.applicant_name ?? 'applicant'}`}
                onPress={() => { void decide(r, true); }}>
                <Icon name="check" size={16} color={OB.signal} />
                <Text style={[s.btnText, {color: OB.signal}]}>Approve</Text>
              </TouchableOpacity>
            </View>
          </Card>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:    {flex: 1, backgroundColor: OB.bg},
  card:    {marginBottom: 10, gap: 10},
  row:     {flexDirection: 'row', alignItems: 'center', gap: 12},
  avatar:  {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    backgroundColor: OB.accent + '1A', borderWidth: 1, borderColor: OB.accent + '33',
  },
  name:    {color: OB.text, fontSize: 15, fontWeight: '700'},
  sub:     {color: OB.textDim, fontSize: 12, marginTop: 2},
  meta:    {color: OB.textMute, fontSize: 11, marginTop: 2},
  message: {color: OB.textDim, fontSize: 12, fontStyle: 'italic'},
  empty:   {color: OB.textMute, fontSize: 13, lineHeight: 19},
  inviteRow: {flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: OB.hair},
  inviteErr: {color: OB.amber, fontSize: 12, lineHeight: 17},
  revokeBtn: {flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 6, paddingHorizontal: 10, borderRadius: 10, borderWidth: 1, borderColor: OB.alert + '4D', backgroundColor: OB.alert + '14'},
  actions: {flexDirection: 'row', gap: 10, marginTop: 2},
  btn:     {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    paddingVertical: 10, borderRadius: 12, borderWidth: 1,
  },
  approve: {borderColor: OB.signal + '4D', backgroundColor: OB.signal + '14'},
  decline: {borderColor: OB.alert + '4D', backgroundColor: OB.alert + '14'},
  btnText: {fontSize: 13, fontWeight: '700'},
}));
