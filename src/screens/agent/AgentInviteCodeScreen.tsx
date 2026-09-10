/**
 * Issue 34 — Agent onboarding via a provider invitation code.
 *
 * The officer never self-registers onto a roster: the ONLY way in is a code the
 * provider minted, and redeeming it is what creates their agent record and the
 * roster link (server-side, in one transaction). This screen is just the entry
 * point for that code.
 */
import React, {useState} from 'react';
import {View, Text, TextInput, StyleSheet, TouchableOpacity, StatusBar, ActivityIndicator} from 'react-native';
import {Alert} from '@utils/alert';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {AgentStackParamList} from '@navigation/types';
import {Colors} from '@theme/colors';
import {BravoFont} from '@theme/bravo';
import {NavHeader, CTAButton} from './_shared';
import {orgInviteApi} from '@services/api';
import {extractMsg} from './agentFlowHelpers';
import {useAuthStore} from '@store/authStore';
import {scaleTextStyles} from '@utils/scaling';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';

type Nav = NativeStackNavigationProp<AgentStackParamList>;

const CODE_MAX = 32;

export default function AgentInviteCodeScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<Nav>();
  const completeAuth = useAuthStore(st => st.completeAuth);
  // B-184 — the bottom-most element owns the keyboard inset.
  const {bottomPad} = useKeyboardLayout();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const trimmed = code.trim();
    if (!trimmed || busy) {return;}
    setBusy(true);
    try {
      await orgInviteApi.redeem(trimmed);
      // The server created the agent row + roster link; re-pull /auth/me so the
      // shell routes into the agent experience rather than the client one.
      await completeAuth().catch(() => undefined);
      navigation.reset({index: 0, routes: [{name: 'AgentVerificationStatus'}]});
    } catch (e: unknown) {
      // The server returns one message for unknown / expired / revoked / already
      // used, deliberately — an officer cannot probe which codes exist.
      Alert.alert('Could not join', extractMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={[s.root, {paddingTop: insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={Colors.background} />
      <NavHeader title="Join your provider" onBack={() => navigation.goBack()} />

      <View style={s.body}>
        <Text style={s.lead}>Enter your invitation code</Text>
        <Text style={s.sub}>
          Your security company gives you this code. It links you to their roster —
          it is single use, and it is the only way to join.
        </Text>

        <TextInput
          style={s.input}
          value={code}
          onChangeText={t => setCode(t.toUpperCase().replace(/[^A-Z0-9-]/g, ''))}
          placeholder="e.g. BRAVO-7Q2K"
          placeholderTextColor={Colors.textMuted}
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={CODE_MAX}
          accessibilityLabel="Provider invitation code"
          editable={!busy}
        />

        <Text style={s.note}>
          No code? Ask your provider to issue one. Identity and compliance checks
          still apply before you can be deployed.
        </Text>

        {busy && <ActivityIndicator style={{marginTop: 18}} color={Colors.primary} />}
      </View>

      <View style={{paddingBottom: bottomPad(0)}}>
        <CTAButton
          label={busy ? 'Joining…' : 'Join provider'}
          onPress={() => { void submit(); }}
          variant={!code.trim() || busy ? 'disabled' : 'primary'}
        />
      </View>

      <TouchableOpacity
        style={s.helpBtn}
        activeOpacity={0.7}
        onPress={() => Alert.alert(
          'About invitation codes',
          'Bravo officers work under a registered security company. That company creates your place on its roster and gives you a single-use code. You cannot join a roster without one.',
        )}>
        <Text style={s.helpText}>How does this work?</Text>
      </TouchableOpacity>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root: {flex: 1, backgroundColor: Colors.background},
  body: {flex: 1, paddingHorizontal: 18, paddingTop: 18},
  lead: {fontFamily: BravoFont.bold, fontSize: 18, color: Colors.textPrimary},
  sub: {fontSize: 12, color: Colors.textSecondary, marginTop: 6, lineHeight: 17},
  input: {
    marginTop: 22, height: 54, borderRadius: 12,
    borderWidth: 1, borderColor: Colors.surfaceBorder,
    backgroundColor: Colors.surfaceElevated,
    paddingHorizontal: 14,
    fontFamily: BravoFont.bold, fontSize: 17, letterSpacing: 2,
    color: Colors.textPrimary,
  },
  note: {fontSize: 11, color: Colors.textMuted, marginTop: 14, lineHeight: 16},
  helpBtn: {alignItems: 'center', paddingVertical: 12},
  helpText: {fontSize: 12, color: Colors.textSecondary, textDecorationLine: 'underline'},
}));
