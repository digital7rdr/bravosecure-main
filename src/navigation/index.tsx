import React, {useCallback, useEffect, useState} from 'react';
import {NavigationContainer} from '@react-navigation/native';
import {navigationRef} from './navigationRef';
export {navigationRef} from './navigationRef';
import {createNativeStackNavigator} from '@react-navigation/native-stack';
import {View, StyleSheet} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useAuthStore} from '@store/authStore';
import AuthNavigator from './AuthNavigator';
import MainNavigator from './MainNavigator';
import LoadingView, {type LoadingStep} from '@components/LoadingView';
import {useColdStartIntro, COLD_START_INTRO_MS} from '@components/useColdStartIntro';
import PermissionsScreen from '@screens/auth/PermissionsScreen';
import AccessEndedScreen from '@screens/cpo/AccessEndedScreen';
import type {RootStackParamList} from './types';

const Stack = createNativeStackNavigator<RootStackParamList>();
const PERMS_KEY = 'bravo_perms_shown';

// Staged checklists for the two full-screen loaders. Each surface gets text
// specific to what it's actually doing — never a generic "Loading…".
const VERIFY_STEPS: LoadingStep[] = [
  {label: 'Validating credentials',     sub: 'Matching your encrypted key'},
  {label: 'Establishing secure channel', sub: 'TLS 1.3 · end-to-end handshake'},
  {label: 'Restoring secure state',      sub: 'Decrypting your session vault'},
  {label: 'Finalizing access',           sub: 'Bringing up your command surface'},
];

// The cold-start security-check intro (client request 2026-08-31 - see
// useColdStartIntro). These name work a cold boot GENUINELY does, and they read
// correctly whether or not there is a session to restore, unlike VERIFY_STEPS'
// "Validating credentials" - the intro also plays on a cold open to the sign-in
// screen. The 1.5 s budget is a display floor, not a measurement of them.
const COLD_START_STEPS: LoadingStep[] = [
  {label: 'Unlocking secure store',      sub: 'SQLCipher - device keychain'},
  {label: 'Loading identity keys',       sub: 'Signal protocol key material'},
  {label: 'Establishing secure channel', sub: 'TLS 1.3 - sealed sender'},
  {label: 'Restoring secure state',      sub: 'Decrypting your session vault'},
];
// Four steps inside COLD_START_INTRO_MS. At LoadingView's 850 ms default only
// the first two would ever light up.
const COLD_START_STEP_MS = Math.floor(COLD_START_INTRO_MS / 4.1);

// Mirrors the real signOut() teardown order in authStore.
const SIGNOUT_STEPS: LoadingStep[] = [
  {label: 'Ending secure sessions', sub: 'Closing calls & live channels'},
  {label: 'Revoking device tokens', sub: 'Push & VoIP wake keys'},
  {label: 'Wiping local vault',     sub: 'SQLCipher store & cached keys'},
  {label: 'Clearing session',       sub: 'Returning you to sign in'},
];

export default function RootNavigator() {
  // NAV-23 (2026-08-26 audit) — field selectors, not the bare hook: this
  // component owns the whole NavigationContainer subtree, and a bare
  // useAuthStore() re-rendered it on EVERY auth-store write (token refreshes,
  // profile edits…), not just the five fields it reads.
  const isAuthenticated = useAuthStore(s => s.isAuthenticated);
  const isLoading = useAuthStore(s => s.isLoading);
  const isSigningOut = useAuthStore(s => s.isSigningOut);
  const accessEnded = useAuthStore(s => s.accessEnded);
  const user = useAuthStore(s => s.user);
  const [permsShown, setPermsShown] = useState<boolean | null>(null);
  // Cold open only - a background resume must NOT replay this (client's own
  // scoping, after the founder flagged the rapid-use annoyance).
  const {showing: coldIntro, isColdBoot} = useColdStartIntro();

  // When the user becomes authenticated, check if we've already shown permissions.
  useEffect(() => {
    if (!isAuthenticated || !user?.role) {
      setPermsShown(null);
      return;
    }
    AsyncStorage.getItem(PERMS_KEY)
      .then(v => setPermsShown(v === '1'))
      .catch(() => setPermsShown(false));
  }, [isAuthenticated, user?.role]);

  const onPermsDone = useCallback(async () => {
    await AsyncStorage.setItem(PERMS_KEY, '1').catch(() => {});
    setPermsShown(true);
  }, []);

  const showAuth  = !isAuthenticated || !user?.role;
  const showPerms = !showAuth && permsShown === false;
  const showMain  = !showAuth && permsShown === true;

  return (
    <NavigationContainer ref={navigationRef}>
      <Stack.Navigator screenOptions={{headerShown: false, animation: 'fade'}}>
        {accessEnded ? (
          // §35A §F — highest priority: a revoked CPO sees the access-ended screen
          // (not the login form) even after signOut() has cleared their auth state.
          <Stack.Screen name="AccessEnded" component={AccessEndedScreen} />
        ) : showAuth ? (
          <Stack.Screen name="Auth" component={AuthNavigator} />
        ) : showPerms ? (
          <Stack.Screen name="PermGate">
            {() => <PermissionsScreen onDone={() => { void onPermsDone(); }} />}
          </Stack.Screen>
        ) : showMain ? (
          <Stack.Screen name="Main" component={MainNavigator} />
        ) : (
          // permsShown === null → still loading AsyncStorage; show nothing (overlay covers it)
          <Stack.Screen name="Auth" component={AuthNavigator} />
        )}
      </Stack.Navigator>

      {(isLoading || (isAuthenticated && permsShown === null) || coldIntro) && !isSigningOut && (
        <View
          /*
           * The intro CAPTURES touches; the plain loading overlay keeps its
           * original pass-through. The overlay is opaque, so during the intro a
           * tap would land blind on whatever sits underneath - the exact
           * rapid-use shape the B-664..B-679 audit was about, and the founder's
           * stated worry about this feature.
           */
          pointerEvents={coldIntro ? 'auto' : 'none'}
          style={StyleSheet.absoluteFill}>
          <LoadingView
            fullscreen
            /* Chosen from `isColdBoot`, which is stable for the whole process:
               a checklist swapped mid-boot restarts its own step animation. */
            label={isColdBoot ? 'Securing your device…' : 'Verifying session…'}
            steps={isColdBoot ? COLD_START_STEPS : VERIFY_STEPS}
            stepMs={isColdBoot ? COLD_START_STEP_MS : undefined}
          />
        </View>
      )}

      {/* Sign-out teardown: the wrapping View captures touches (no
          pointerEvents="none") so the user can't interact with the dashboard
          while the runtime, push tokens, and at-rest store are being wiped. */}
      {isSigningOut && (
        <View style={StyleSheet.absoluteFill}>
          <LoadingView fullscreen label="Signing out…" steps={SIGNOUT_STEPS} />
        </View>
      )}
    </NavigationContainer>
  );
}
