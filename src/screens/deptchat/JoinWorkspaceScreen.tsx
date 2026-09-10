import React, {useCallback, useEffect, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TextInput} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation, useRoute, type RouteProp} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {useAuthStore} from '@store/authStore';
import {enterpriseApi} from '@services/api';
import {openDepartmentChannels} from '@navigation/departmentalEntry';
import {acceptInviteFlow} from './inviteAccept';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;
type Rt = RouteProp<MessengerStackParamList, 'JoinWorkspace'>;

/**
 * M5 — Join Workspace / Referral Request.
 *
 * "Open directly from an invitation or a Member-shared referral link/code."
 * "Confirm only full name, mobile and email; no OTP is used in this flow."
 * "The applicant cannot change the requested department or team."
 * "Submit Request creates a pending record and notifies the authorised Admin."
 * "Expired or revoked links show a safe message without exposing organisation
 *  data."
 *
 * There is deliberately NO team picker on this screen. The team comes from the
 * link and is resolved server-side; the API method has no field for it either,
 * so a future edit here cannot start sending one.
 */
export default function JoinWorkspaceScreen() {
  const insets = useSafeAreaInsets();
  const {overlap} = useKeyboardLayout();
  // This screen is now mounted BOTH standalone (MessengerNavigator) and inside
  // the departmental tab shell, where the tab bar already consumes the safe
  // area — so `bottomPad`'s resting `insets.bottom` double-pads there. Same
  // shape the other 10 dual-mounted deptchat screens use. The keyboard branch
  // is unchanged and still replaces the inset rather than stacking on it,
  // because the IME already covers the nav bar (CLAUDE.md B-184 rule).
  const inDepartmentalShell = useInDepartmentalShell();
  const restBottom = inDepartmentalShell ? 0 : insets.bottom;
  const bottomPad = (gap = 0) => (overlap > 0 ? overlap : restBottom) + gap;
  const navigation = useNavigation<Nav>();
  const {params} = useRoute<Rt>();
  const user = useAuthStore(st => st.user);

  const [code, setCode] = useState((params?.code ?? '').toUpperCase());
  const [checking, setChecking] = useState(false);
  const [resolved, setResolved] = useState<
    null | {valid: false; reason?: 'workspace_owner_cannot_join' | 'already_active_in_another_org'}
    | {valid: true; org_name: string | null; team_name: string | null;
      invite?: {invited_role: 'employee' | 'manager'}}
  >(null);
  const [fullName, setFullName] = useState(user?.full_name ?? '');
  const [phone, setPhone] = useState(user?.phone ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  type Resolved = null | {valid: false; reason?: 'workspace_owner_cannot_join' | 'already_active_in_another_org'}
    | {valid: true; org_name: string | null;
    team_name: string | null; invite?: {invited_role: 'employee' | 'manager'}};
  // Returns what it resolved as well as setting state: the submit path needs
  // the answer SYNCHRONOUSLY when a tap beats onBlur (see submit()).
  const check = useCallback(async (raw: string): Promise<Resolved> => {
    const c = raw.trim().toUpperCase();
    if (c.length < 4) { setResolved(null); return null; }
    setChecking(true);
    try {
      const {data} = await enterpriseApi.resolveReferralLink(c);
      setResolved(data);
      return data;
    } catch {
      // Treat a failure exactly like an invalid link — never surface anything
      // that would distinguish "no such code" from "server error", since the
      // difference is itself information about the organisation.
      setResolved({valid: false});
      return {valid: false};
    } finally {
      setChecking(false);
    }
  }, []);

  // Auto-resolve when arriving from a deep link.
  useEffect(() => {
    if (params?.code) { void check(params.code); }
  }, [params?.code, check]);

  const submit = async () => {
    if (busy) {return;}
    const c = code.trim().toUpperCase();
    if (!c) { Alert.alert('Join', 'Enter the invitation code you were given.'); return; }
    // The latch closes BEFORE the awaited resolve, or a double-tap during the
    // round-trip runs two submits.
    setBusy(true);
    // A tap can beat onBlur (keyboardShouldPersistTaps="handled"), leaving the
    // code UNRESOLVED — which routed a valid INVITE code through the request
    // verb, where the server's fail-closed backstop refuses it with copy that
    // reads "your invitation is no longer valid" to the holder of a perfectly
    // valid invite. Resolve first, then take the right verb.
    let r: typeof resolved = resolved;
    if (r === null) { r = await check(c); }
    if (r && !r.valid) { setBusy(false); return; }   // the invalid card now renders
    if (r?.valid && r.invite) {
      // Hand off to join(), which takes its OWN latch — release this one first
      // or its `if (busy) return` guard no-ops the handoff.
      setBusy(false);
      return join();
    }
    try {
      await enterpriseApi.submitJoinRequest({
        code: c,
        full_name: fullName.trim() || undefined,
        phone: phone.trim() || undefined,
        email: email.trim() || undefined,
        message: message.trim() || undefined,
      });
      // M11A "appears immediately after M5" — replace so Back cannot return to
      // a form that has already been submitted.
      navigation.replace('ApprovalStatus');
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}})?.response?.data?.message;
      Alert.alert(
        'Could not send request',
        msg === 'already_a_member' ? 'You are already a member of this workspace.'
          : msg === 'referral_link_invalid_or_expired'
            ? 'That invitation is no longer valid. Ask whoever invited you for a new one.'
            : 'Please check your connection and try again.',
      );
    } finally {
      setBusy(false);
    }
  };

  // Item E — a resolved INVITE row joins instantly (auto-approve): no
  // application details, no admin review, a different verb on the button.
  const isInvite = resolved?.valid === true && !!resolved.invite;

  const join = async () => {
    if (busy) {return;}
    setBusy(true);
    try {
      if (await acceptInviteFlow(code)) {
        // Q11 — an accepted invite IS membership: go straight into the
        // workspace (Home dashboard). The old replace('ApprovalStatus') landed
        // the new member on a status page with NO request row — the invite
        // lane never creates one — which read as "it didn't let me in".
        // acceptInviteFlow refreshed the store, so the workspace gates pass.
        //
        // The entry PUSHES over this screen, so the replace-not-navigate rule
        // survives differently: the consumed code and its cached "You've been
        // invited" card are CLEARED first — Back lands on an empty join form,
        // never a form still offering a code that no longer works (edge
        // review MEDIUM-4).
        setCode('');
        setResolved(null);
        openDepartmentChannels(navigation, {preferHome: true});
      }
    } finally {
      setBusy(false);
    }
  };

  const invalid = resolved !== null && resolved.valid === false;
  // B-413 — the server refused an otherwise-valid link because THIS account
  // owns a workspace (the caller's own state). Honest copy — same message
  // acceptInviteFlow maps for the accept-side 409 — instead of the generic
  // invalid card, and never a Join button that can only fail.
  const ownerBlocked = resolved !== null && resolved.valid === false
    && resolved.reason === 'workspace_owner_cannot_join';
  // Same dangling-CTA class, different refusal: active membership elsewhere
  // (one-active-org rule) — the accept could only 409 on the unique index.
  const elsewhereBlocked = resolved !== null && resolved.valid === false
    && resolved.reason === 'already_active_in_another_org';

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Join workspace" onBack={() => navigation.goBack()} pill="INVITE" />

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: bottomPad(24)}}>

        <SectionLabel>INVITATION CODE</SectionLabel>
        <Card>
          <TextInput
            style={s.input}
            placeholder="e.g. K7P2QR9M"
            placeholderTextColor={OB.textMute}
            value={code}
            onChangeText={t => { setCode(t.toUpperCase()); setResolved(null); }}
            onBlur={() => { void check(code); }}
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={32}
          />
        </Card>

        {checking ? (
          <Text style={s.hint}>Checking…</Text>
        ) : invalid ? (
          /* The SAFE message. It names no organisation, no team, and does not
             say whether the code ever existed. The B-413 owner branch is the
             caller's OWN state — still no organisation data. */
          <Card style={s.warn}>
            <Icon name="alert-circle-outline" size={18} color={OB.amber} />
            <Text style={s.warnText}>
              {ownerBlocked
                ? 'This account owns its own workspace, so it cannot join another one. If you no longer use that workspace, contact support to remove it.'
                : elsewhereBlocked
                  ? 'This account is already a member of another workspace, and an account can only belong to one. Leave that workspace first to accept this invite.'
                  : 'This invitation is not valid or has expired. Ask whoever invited you for a new link.'}
            </Text>
          </Card>
        ) : resolved?.valid ? (
          <Card style={s.ok}>
            <Icon name="office-building-outline" size={18} color={OB.accentSoft} />
            <View style={{flex: 1, minWidth: 0}}>
              <Text style={s.okTitle}>{resolved.org_name ?? 'Enterprise workspace'}</Text>
              {/* Shown, not editable — M5: the applicant cannot change the team. */}
              <Text style={s.okSub}>
                {isInvite
                  ? `You've been invited${resolved.invite?.invited_role === 'manager' ? ' as a manager' : ''}${resolved.team_name ? ` to ${resolved.team_name}` : ''} — no approval needed.`
                  : resolved.team_name ? `You'll be added to ${resolved.team_name}` : 'Your team is set by the invitation'}
              </Text>
            </View>
          </Card>
        ) : null}

        {/* An INVITE needs no application: the admin already chose this person,
            their team and their role. Details/message are request-only. */}
        {!isInvite && (
          <>
            <View style={{height: 18}} />
            <SectionLabel>YOUR DETAILS</SectionLabel>
            <Card style={{gap: 10}}>
              <TextInput style={s.input} placeholder="Full name" placeholderTextColor={OB.textMute}
                value={fullName} onChangeText={setFullName} maxLength={120} />
              <TextInput style={s.input} placeholder="Mobile number" placeholderTextColor={OB.textMute}
                value={phone} onChangeText={setPhone} keyboardType="phone-pad" maxLength={32} />
              <TextInput style={s.input} placeholder="Email" placeholderTextColor={OB.textMute}
                value={email} onChangeText={setEmail} keyboardType="email-address"
                autoCapitalize="none" maxLength={160} />
            </Card>
            {/* M5 — "no OTP is used in this flow". */}
            <Text style={s.hint}>
              No verification code needed. An admin reviews your request and decides.
            </Text>

            <View style={{height: 18}} />
            <SectionLabel>MESSAGE (OPTIONAL)</SectionLabel>
            <Card>
              <TextInput style={[s.input, s.multiline]} placeholder="Anything the admin should know"
                placeholderTextColor={OB.textMute} value={message} onChangeText={setMessage}
                multiline maxLength={500} />
            </Card>
          </>
        )}

        <View style={{height: 22}} />
        <PrimaryButton
          label={busy
            ? (isInvite ? 'Joining…' : 'Sending…')
            : isInvite
              ? `Join ${resolved?.valid && resolved.org_name ? resolved.org_name : 'workspace'}`
              : 'Submit request'}
          icon={isInvite ? 'check-circle-outline' : 'send-outline'}
          disabled={busy || invalid || !code.trim()}
          onPress={() => { void (isInvite ? join() : submit()); }}
        />
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:      {flex: 1, backgroundColor: OB.bg},
  input:     {color: OB.text, fontSize: 15, paddingVertical: 6},
  multiline: {minHeight: 72, textAlignVertical: 'top'},
  hint:      {color: OB.textMute, fontSize: 12, marginTop: 8, lineHeight: 17},
  warn:      {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
              borderColor: OB.amber + '4D', backgroundColor: OB.amber + '12'},
  warnText:  {color: OB.textDim, fontSize: 12, flex: 1, lineHeight: 17},
  ok:        {flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 10,
              borderColor: OB.accent + '4D', backgroundColor: OB.accent + '12'},
  okTitle:   {color: OB.text, fontSize: 14, fontWeight: '700'},
  okSub:     {color: OB.textDim, fontSize: 12, marginTop: 2},
}));
