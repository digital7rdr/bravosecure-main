/**
 * CPO · Account Activation (BUILD_RUNBOOK Step 17 / §35A §B) — first-login flow for a
 * managed guard whose agency created the account with a temp password
 * (`must_set_password=true`). Steps, in this order:
 *   1. Welcome — "you belong to {agency}" + the on-duty/SOS explainer.
 *   2. Permissions — location (required to go on duty) + notifications primers; a brief
 *      biometric note (enrolment is device-level — the guard just uses it next sign-in).
 *   3. Set password — swap the agency temp password for the guard's own.
 *
 * ⚠️ Password change is LAST and deliberately so: POST /auth/me/password revokes EVERY
 * live session (incl. this one) and returns no new tokens, so the guard is signed out on
 * success and signs back in with their new password — at which point `must_set_password`
 * is false and the root routes them straight into the CPO shell. We do NOT weaken that
 * server-side revocation (it's the credential-rotation security contract).
 *
 * Obsidian + platinum-cobalt theme, matching the CPO shell + OrgComplianceScreen.
 */
import React, {useCallback, useRef, useState} from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, TextInput, ScrollView,
  StatusBar, ActivityIndicator, Platform, PermissionsAndroid,
} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import {authApi} from '@services/api';
import {useKeyboardLayout, useRevealOnKeyboard} from '@hooks/useKeyboardLayout';
import {scaleTextStyles} from '@utils/scaling';

const D = {
  bg: '#07090D', text: '#F2F4F8', textDim: 'rgba(229,233,242,0.62)',
  textMute: 'rgba(180,188,204,0.45)', hair2: 'rgba(255,255,255,0.09)',
  accent: '#5B8DEF', accentSoft: '#A9C5FF', signal: '#4ADE80', alert: '#FF5D5D',
  fSans: 'Manrope_500Medium', fSemi: 'Manrope_600SemiBold', fBold: 'Manrope_700Bold',
};

async function requestAndroidPerm(perm: string): Promise<boolean> {
  try {
    const res = await PermissionsAndroid.request(perm as never);
    return res === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export default function CpoActivationScreen() {
  const insets = useSafeAreaInsets();
  // B-84 / KB-09 — no keyboard handling existed: the IME covered the
  // password fields + pinned footer. kb padding shrinks the scroll area
  // and lifts the footer; reveal keeps the focused field visible.
  const {bottomPad} = useKeyboardLayout();
  const scrollRef = useRef<ScrollView>(null);
  const revealField = useRevealOnKeyboard(scrollRef);
  const user = useAuthStore(s => s.user);
  const signOut = useAuthStore(s => s.signOut);
  const orgName = user?.org?.name ?? 'your agency';

  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [locOn, setLocOn] = useState(false);
  const [notifOn, setNotifOn] = useState(false);

  const [tempPw, setTempPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const askLocation = useCallback(async () => {
    if (Platform.OS === 'android') {
      setLocOn(await requestAndroidPerm(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION));
    } else {
      setLocOn(true); // iOS primer is best-effort here; full prompt at first duty toggle
    }
  }, []);

  const askNotifications = useCallback(async () => {
    if (Platform.OS === 'android' && (Platform.Version as number) >= 33) {
      setNotifOn(await requestAndroidPerm(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS));
    } else {
      setNotifOn(true);
    }
  }, []);

  const submitPassword = useCallback(async () => {
    if (newPw.length < 8) { Alert.alert('Password too short', 'Use at least 8 characters.'); return; }
    if (newPw !== confirmPw) { Alert.alert('Passwords don\'t match', 'Re-enter your new password.'); return; }
    if (newPw === tempPw) { Alert.alert('Choose a different password', 'Your new password must differ from the temporary one.'); return; }
    setSubmitting(true);
    try {
      await authApi.changePassword({currentPassword: tempPw, newPassword: newPw});
      // Success revokes this session server-side — sign out locally, then prompt the
      // guard to sign in with their new password (they'll land in the CPO shell).
      Alert.alert(
        'Password set',
        `Welcome to ${orgName}. Sign in with your new password to enter Bravo.`,
        [{text: 'Sign in', onPress: () => { void signOut(); }}],
      );
    } catch (e: unknown) {
      const msg = (e as {response?: {data?: {message?: string}}}).response?.data?.message
        ?? (e as Error).message ?? 'Could not set your password';
      const friendly = /current_password_invalid/.test(String(msg))
        ? 'The temporary password is incorrect. Check what your agency gave you.'
        : msg;
      Alert.alert('Could not set password', friendly);
    } finally {
      setSubmitting(false);
    }
  }, [tempPw, newPw, confirmPw, orgName, signOut]);

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={D.bg} />
      <View style={s.header}>
        <View style={s.accentBar} />
        {/* BB-4 (2026-08-15 back audit) — this gate renders OUTSIDE any
            navigator, so the steps are the only navigation there is. Without
            a step-back, a guard who denied a permission on step 2 (or wants
            to re-read step 1) could never return — forward-only, no exit. */}
        {step > 0 && (
          <TouchableOpacity
            disabled={submitting}
            onPress={() => setStep(p => Math.max(0, p - 1) as 0 | 1 | 2)}
            hitSlop={{top: 12, bottom: 12, left: 12, right: 12}}>
            <Icon name="arrow-left" size={20} color={D.accentSoft} />
          </TouchableOpacity>
        )}
        <Text style={s.headerTitle}>ACTIVATE YOUR ACCOUNT</Text>
        <Text style={s.stepTag}>{step + 1}/3</Text>
      </View>

      <ScrollView ref={scrollRef} contentContainerStyle={s.body} showsVerticalScrollIndicator={false}>
        {step === 0 && (
          <>
            <View style={s.idCard}>
              <View style={s.idIcon}><Icon name="shield-account" size={28} color={D.accentSoft} /></View>
              <Text style={s.idLabel}>YOU BELONG TO</Text>
              <Text style={s.idOrg}>{orgName}</Text>
              <Text style={s.idName}>{user?.full_name ?? user?.email ?? 'Close Protection Officer'}</Text>
            </View>
            <Text style={s.h2}>Welcome to the team</Text>
            <Text style={s.p}>
              You'll work the missions your agency assigns to you. Here's the core of how
              the guard app keeps you and your principal safe:
            </Text>
            <ExplainRow icon="radar" title="Go on duty" body="Flip yourself On Duty so your agency can dispatch you. Your live location is shared only while on duty." />
            <ExplainRow icon="alarm-light" title="SOS, always" body="A panic button is one tap away on every mission screen — it alerts your crew and ops instantly." />
            <ExplainRow icon="account-group" title="Lead-only controls" body="If you're the team lead, you advance the mission (Arrived → Live → Finish). Otherwise you ride along." />
          </>
        )}

        {step === 1 && (
          <>
            <Text style={s.h2}>Permissions</Text>
            <Text style={s.p}>Bravo needs these so you can go on duty and never miss a dispatch.</Text>
            <PermCard icon="map-marker-radius" title="Location" required granted={locOn}
              body="Shared only while you're On Duty — for dispatch, live tracking, and SOS response."
              onAllow={() => { void askLocation(); }} />
            <PermCard icon="bell-ring" title="Notifications" granted={notifOn}
              body="Mission assignments, SOS alerts, and comms — fetched securely, never shown in the clear."
              onAllow={() => { void askNotifications(); }} />
            <View style={s.bioNote}>
              <Icon name="fingerprint" size={18} color={D.textDim} />
              <Text style={s.bioNoteText}>
                Tip: once your password is set you can sign in with your fingerprint / Face ID
                from your device — no need to type it each time.
              </Text>
            </View>
          </>
        )}

        {step === 2 && (
          <>
            <Text style={s.h2}>Set your password</Text>
            <Text style={s.p}>
              Replace the temporary password your agency gave you with your own. You'll sign
              in again with the new one.
            </Text>
            <Text style={s.fieldLabel}>Temporary password (from {orgName})</Text>
            <TextInput value={tempPw} onChangeText={setTempPw} secureTextEntry placeholder="Temporary password"
              placeholderTextColor={D.textMute} style={s.input} autoCapitalize="none" onFocus={revealField} />
            <Text style={s.fieldLabel}>New password</Text>
            <TextInput value={newPw} onChangeText={setNewPw} secureTextEntry placeholder="At least 8 characters"
              placeholderTextColor={D.textMute} style={s.input} autoCapitalize="none" onFocus={revealField} />
            <Text style={s.fieldLabel}>Confirm new password</Text>
            <TextInput value={confirmPw} onChangeText={setConfirmPw} secureTextEntry placeholder="Re-enter new password"
              placeholderTextColor={D.textMute} style={s.input} autoCapitalize="none" onFocus={revealField} />
          </>
        )}
        <View style={{height: 24}} />
      </ScrollView>

      {/* B-184 — the sticky footer is the bottom-most node: it owns the
          keyboard inset and the scroll body above shrinks by the same. */}
      <View style={[s.footer, {paddingBottom: bottomPad(14)}]}>
        {step < 2 ? (
          <TouchableOpacity activeOpacity={0.85} style={s.primaryBtn} onPress={() => setStep(p => (p + 1) as 0 | 1 | 2)}>
            <Text style={s.primaryText}>Continue</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity activeOpacity={0.85} disabled={submitting} style={[s.primaryBtn, submitting && {opacity: 0.6}]} onPress={() => void submitPassword()}>
            {submitting ? <ActivityIndicator color="#fff" /> : <Text style={s.primaryText}>Set password & continue</Text>}
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
}

function ExplainRow({icon, title, body}: {icon: string; title: string; body: string}) {
  return (
    <View style={s.exRow}>
      <View style={s.exIcon}><Icon name={icon as never} size={18} color={D.accentSoft} /></View>
      <View style={{flex: 1}}>
        <Text style={s.exTitle}>{title}</Text>
        <Text style={s.exBody}>{body}</Text>
      </View>
    </View>
  );
}

function PermCard({icon, title, body, required, granted, onAllow}:
  {icon: string; title: string; body: string; required?: boolean; granted: boolean; onAllow: () => void}) {
  return (
    <View style={[s.permCard, granted && s.permCardOn]}>
      <View style={s.exIcon}><Icon name={icon as never} size={18} color={granted ? D.signal : D.accentSoft} /></View>
      <View style={{flex: 1}}>
        <View style={s.permTitleRow}>
          <Text style={s.exTitle}>{title}</Text>
          {required && <Text style={s.reqTag}>REQUIRED</Text>}
        </View>
        <Text style={s.exBody}>{body}</Text>
      </View>
      {granted ? (
        <Icon name="check-circle" size={22} color={D.signal} />
      ) : (
        <TouchableOpacity style={s.allowBtn} onPress={onAllow} activeOpacity={0.8}>
          <Text style={s.allowText}>Allow</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: D.bg},
  header: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 22, paddingVertical: 16},
  accentBar: {width: 3, height: 17, borderRadius: 2, backgroundColor: D.accent},
  headerTitle: {flex: 1, fontFamily: D.fBold, fontSize: 13, letterSpacing: 2, color: D.text},
  stepTag: {fontFamily: D.fSemi, fontSize: 12, color: D.textMute, letterSpacing: 1},
  body: {paddingHorizontal: 22, paddingTop: 4, gap: 12},
  idCard: {
    borderRadius: 20, padding: 22, alignItems: 'center', gap: 5, marginBottom: 6,
    backgroundColor: 'rgba(91,141,239,0.07)', borderWidth: 1, borderColor: 'rgba(91,141,239,0.28)',
  },
  idIcon: {
    width: 56, height: 56, borderRadius: 18, marginBottom: 6,
    backgroundColor: 'rgba(91,141,239,0.14)', alignItems: 'center', justifyContent: 'center',
  },
  idLabel: {fontFamily: D.fSemi, fontSize: 10, letterSpacing: 1.6, color: D.textMute},
  idOrg: {fontFamily: D.fBold, fontSize: 22, color: D.text, letterSpacing: -0.3, textAlign: 'center'},
  idName: {fontFamily: D.fSans, fontSize: 13, color: D.textDim, marginTop: 2},
  h2: {fontFamily: D.fBold, fontSize: 19, color: D.text, letterSpacing: -0.2, marginTop: 6},
  p: {fontFamily: D.fSans, fontSize: 14, lineHeight: 21, color: D.textDim},
  exRow: {flexDirection: 'row', gap: 12, alignItems: 'flex-start', marginTop: 6},
  exIcon: {
    width: 38, height: 38, borderRadius: 12,
    backgroundColor: 'rgba(91,141,239,0.10)', alignItems: 'center', justifyContent: 'center',
  },
  exTitle: {fontFamily: D.fBold, fontSize: 14.5, color: D.text},
  exBody: {fontFamily: D.fSans, fontSize: 12.5, lineHeight: 18, color: D.textMute, marginTop: 2},
  permCard: {
    flexDirection: 'row', gap: 12, alignItems: 'center', padding: 14, borderRadius: 16, marginTop: 8,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2,
  },
  permCardOn: {borderColor: 'rgba(74,222,128,0.30)', backgroundColor: 'rgba(74,222,128,0.05)'},
  permTitleRow: {flexDirection: 'row', alignItems: 'center', gap: 7},
  reqTag: {fontFamily: D.fBold, fontSize: 8, letterSpacing: 0.8, color: D.alert,
    paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4,
    backgroundColor: 'rgba(255,93,93,0.14)', borderWidth: 1, borderColor: 'rgba(255,93,93,0.34)'},
  allowBtn: {paddingHorizontal: 14, paddingVertical: 8, borderRadius: 11, backgroundColor: D.accent},
  allowText: {fontFamily: D.fBold, fontSize: 12.5, color: '#fff'},
  bioNote: {flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 12, padding: 13, borderRadius: 13,
    backgroundColor: 'rgba(255,255,255,0.025)', borderWidth: 1, borderColor: D.hair2},
  bioNoteText: {flex: 1, fontFamily: D.fSans, fontSize: 12, lineHeight: 18, color: D.textDim},
  fieldLabel: {fontFamily: D.fSemi, fontSize: 11.5, color: D.textDim, marginTop: 10, marginBottom: 5},
  input: {borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, backgroundColor: 'rgba(255,255,255,0.03)',
    borderWidth: 1, borderColor: D.hair2, color: D.text, fontFamily: D.fSans, fontSize: 15},
  footer: {paddingHorizontal: 22, paddingTop: 12, borderTopWidth: 1, borderTopColor: D.hair2, backgroundColor: D.bg},
  primaryBtn: {height: 52, borderRadius: 15, alignItems: 'center', justifyContent: 'center',
    backgroundColor: D.accent, borderWidth: 1, borderColor: 'rgba(255,255,255,0.2)'},
  primaryText: {fontFamily: D.fBold, fontSize: 15, color: '#fff', letterSpacing: 0.3},
}));
