import React, {useCallback, useState} from 'react';
import {View, Text, StyleSheet, ScrollView, StatusBar, TextInput} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import type {MessengerStackParamList} from '@navigation/types';
import {Alert} from '@utils/alert';
import {scaleTextStyles} from '@utils/scaling';
import {AmbientBg} from '@/modules/messenger/ui/AmbientBg';
import {useKeyboardLayout} from '@hooks/useKeyboardLayout';
import {enterpriseApi} from '@services/api';
import {useAuthStore} from '@store/authStore';
import {OB, ObHeader, SectionLabel, Card, PrimaryButton, useInDepartmentalShell} from './_obsidian';

type Nav = NativeStackNavigationProp<MessengerStackParamList>;

const MAX_NAME = 80;

/**
 * A5 — Create Org Workspace.
 *
 * ── WHAT CREATING A WORKSPACE DOES *NOT* DO ──────────────────────────────────
 *
 * It does not make the owner a service provider. The only pre-existing way to
 * own an org was the agency funnel (`POST /agents` type='company'), which flips
 * `users.role` to service_provider and routes the account into the provider home
 * and the job marketplace. An Enterprise company running internal department
 * channels is not a security-services agency, so `POST /org/workspace` mints an
 * owner without that role grant (owner-decided 2026-08-04).
 *
 * The consequence the server carries for us: the owner stays
 * `account_kind: 'individual'`, and it is `owns_workspace` — not the account
 * kind — that makes them org-affiliated. Nothing on this screen needs to know
 * that, but a future edit that "helpfully" also created an agent would silently
 * move the user into the wrong product.
 */
export default function CreateWorkspaceScreen() {
  const insets = useSafeAreaInsets();
  const {overlap} = useKeyboardLayout();
  const inShell = useInDepartmentalShell();
  // The bottom-most element owns the keyboard inset (CLAUDE.md B-184). Inside
  // the departmental shell the tab bar already consumes the safe area, so the
  // resting inset is 0 there — same shape as the other dual-mounted screens.
  const restBottom = inShell ? 0 : insets.bottom;
  const bottomPad = (gap = 0) => (overlap > 0 ? overlap : restBottom) + gap;
  const navigation = useNavigation<Nav>();
  const recheckMembership = useAuthStore(st => st.recheckMembership);

  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && !busy;

  const submit = useCallback(async () => {
    if (!canSubmit) {return;}
    setBusy(true);
    try {
      await enterpriseApi.createWorkspace(trimmed);
      // The gate that decides whether this user can ENTER the workspace is
      // server-authoritative (`owns_workspace` on /auth/me), so the session has
      // to be re-read before navigating — otherwise the owner lands on their own
      // brand-new workspace and is told they have no access.
      await recheckMembership();

      // …and VERIFY it landed. `recheckMembership` swallows its own errors by
      // design (a transient /auth/me 401 must not log a client out), so it
      // resolves happily on failure and the flag stays stale. Navigating on a
      // stale flag is the exact "no access to the workspace I just created"
      // dead end this whole path exists to avoid — so if the refresh did not
      // take, say so instead of showing it.
      if (useAuthStore.getState().user?.owns_workspace !== true) {
        Alert.alert(
          'Workspace created',
          'We could not refresh your session just now. Sign out and back in, or '
          + 'reopen the app, to enter your workspace.',
        );
        setBusy(false);
        return;
      }
      navigation.replace('Departmental');
    } catch (e) {
      const msg = (e as {message?: string})?.message ?? '';
      Alert.alert(
        'Could not create workspace',
        /already_exists/.test(msg)
          ? 'You already have a workspace. Pull down on Home to refresh.'
          : 'Something went wrong. Please check your connection and try again.',
      );
      setBusy(false);
    }
  }, [canSubmit, trimmed, recheckMembership, navigation]);

  return (
    <View style={[s.root, {paddingTop: inShell ? 0 : insets.top}]}>
      <StatusBar barStyle="light-content" backgroundColor={OB.bg} />
      <AmbientBg bg={OB.bg} />
      <ObHeader title="Create workspace" onBack={() => navigation.goBack()} />

      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{paddingHorizontal: 20, paddingBottom: bottomPad(28)}}>
        <Text style={s.lede}>What is your organisation called?</Text>
        <Text style={s.sub}>
          Your team will see this name. You can add departments, teams and
          channels once the workspace exists.
        </Text>

        <SectionLabel>Organisation name</SectionLabel>
        <Card style={s.field}>
          <Icon name="office-building-outline" size={20} color={OB.textMute} />
          <TextInput
            value={name}
            onChangeText={setName}
            placeholder="Acme Security Ltd"
            placeholderTextColor={OB.textMute}
            maxLength={MAX_NAME}
            autoCapitalize="words"
            returnKeyType="done"
            onSubmitEditing={submit}
            editable={!busy}
            accessibilityLabel="Organisation name"
            style={s.input}
          />
        </Card>
        <Text style={s.counter}>{trimmed.length}/{MAX_NAME}</Text>

        <PrimaryButton
          label={busy ? 'Creating…' : 'Create workspace'}
          onPress={submit}
          disabled={!canSubmit}
        />

        <Text style={s.foot}>
          You become the Admin. Only you can approve who joins, and you can add
          more Admins afterwards.
        </Text>
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  root:    {flex: 1, backgroundColor: OB.bg},
  lede:    {color: OB.text, fontSize: 20, fontWeight: '700', marginTop: 6},
  sub:     {color: OB.textMute, fontSize: 13, marginTop: 8, lineHeight: 20},
  field:   {marginTop: 10, flexDirection: 'row', alignItems: 'center', gap: 12},
  input:   {flex: 1, color: OB.text, fontSize: 15, paddingVertical: 4},
  counter: {color: OB.textMute, fontSize: 12, alignSelf: 'flex-end', marginTop: 6, marginBottom: 16},
  foot:    {color: OB.textMute, fontSize: 12, marginTop: 18, textAlign: 'center', lineHeight: 18},
}));
