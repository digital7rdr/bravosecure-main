import React, {useEffect, useCallback} from 'react';
import {StatusBar, LogBox} from 'react-native';
import {GestureHandlerRootView} from 'react-native-gesture-handler';
import {KeyboardProvider} from 'react-native-keyboard-controller';
import {SafeAreaProvider} from 'react-native-safe-area-context';
import * as SplashScreen from 'expo-splash-screen';
import {
  useFonts,
  Manrope_300Light,
  Manrope_400Regular,
  Manrope_500Medium,
  Manrope_600SemiBold,
  Manrope_700Bold,
  Manrope_800ExtraBold,
} from '@expo-google-fonts/manrope';
import RootNavigator from '@navigation/index';
import {useAuthStore} from '@store/authStore';
import BiometricGate from '@components/BiometricGate';
import {BravoAlertHost} from '@components/BravoAlertHost';
import FloatingCallOverlay from '@screens/messenger/FloatingCallOverlay';
import InAppMessageBanner from '@components/InAppMessageBanner';
import {ErrorBoundary} from '@modules/observability';
import {initI18n} from '@/i18n';

LogBox.ignoreLogs(['Non-serializable values were found in the navigation state']);

void SplashScreen.preventAutoHideAsync();

export default function App(): React.JSX.Element | null {
  const {initialize} = useAuthStore();

  const [fontsLoaded, fontError] = useFonts({
    Manrope_300Light,
    Manrope_400Regular,
    Manrope_500Medium,
    Manrope_600SemiBold,
    Manrope_700Bold,
    Manrope_800ExtraBold,
  });

  useEffect(() => {
    // Step 25 — seed i18n from the device locale (a persisted preference overrides it once
    // loaded from /users/me/preferences). Sets the session's RTL direction; a later change
    // in Settings prompts a reload, an RN forceRTL constraint.
    initI18n();
    void initialize();
  }, [initialize]);

  const onLayoutRootView = useCallback(() => {
    if (fontsLoaded || fontError) {
      void SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) {
    return null;
  }

  return (
    <ErrorBoundary>
      <GestureHandlerRootView style={{flex: 1}} onLayout={onLayoutRootView}>
        {/* B-184 / K4 — the WindowInsets keyboard source. Android emits no JS
            keyboard event when the IME resizes in place (alpha→emoji), so the
            composer stayed lifted for the shorter pad and the taller emoji
            keyboard drew over it. KeyboardProvider feeds useKeyboardLayout a
            continuous height that follows in-session resizes. Translucent bars
            (edge-to-edge) so the reported height is the full covered band. */}
        <KeyboardProvider navigationBarTranslucent statusBarTranslucent>
        <SafeAreaProvider>
          {/* W4/B-685 — StripeProvider moved OFF the root: it initialises the
              native Stripe SDK on mount, a boot cost every account paid for a
              provider only four payment screens consume. Those screens now
              export through withPaymentBoundary (PaymentBoundary.tsx), which
              mounts the provider per-screen. */}
          {/* Translucent status bar — each screen's own background shows
              through the top strip edge-to-edge (Command Home is #07090D,
              other dark screens fill their own bg). Avoids a hardcoded
              navy band above the near-black dashboard. */}
          <StatusBar barStyle="light-content" backgroundColor="transparent" translucent />
          <BiometricGate>
            <RootNavigator />
            {/* B-692 S-3 — foreground message banner. Mounted at this level
                (like FloatingCallOverlay) so it overlays every shell. */}
            <InAppMessageBanner />
            {/* Persistent overlay — renders only when there's an active
                call AND the user has minimized it. Mounted at this
                level so it survives any navigation inside RootNavigator. */}
            <FloatingCallOverlay />
          </BiometricGate>
          {/* B-88 — global obsidian dialog host backing @utils/alert.
              OUTSIDE BiometricGate so gate-time errors still surface;
              its transparent Modal stacks above any other open Modal. */}
          <BravoAlertHost />
        </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}
