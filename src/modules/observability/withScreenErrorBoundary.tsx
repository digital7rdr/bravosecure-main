import React from 'react';
import {View, Text, TouchableOpacity, StyleSheet} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import {ErrorBoundary} from './ErrorBoundary';

/**
 * Round 4 / Architecture audit fix: per-screen error boundary wrapper.
 *
 * The app-wide ErrorBoundary in App.tsx is the last line of defence —
 * if a render-phase error reaches it, the WHOLE app shows the recovery
 * screen and the navigation stack is gone. That's the right behaviour
 * for boot-time crashes but catastrophic for "the chat I was reading
 * had one bad bubble" or "the call screen's audio-route-listener
 * threw on a degraded RN-WebRTC build".
 *
 * Wrapping a screen's default export with this HOC means:
 *   - render-phase errors INSIDE the screen are caught by the screen's
 *     own boundary, not the root one
 *   - the user sees a screen-local error card with Retry + Back buttons
 *   - the rest of the app (other tabs, navigator state, persisted store)
 *     stays alive
 *   - the error is still reported to Crashlytics by the inner
 *     ErrorBoundary (recordError + breadcrumbs)
 *
 * The fallback uses `useNavigation` directly so we can offer Back
 * without forcing every caller to plumb a callback through.
 */
export function withScreenErrorBoundary<P extends object>(
  Wrapped: React.ComponentType<P>,
  screenLabel: string,
): React.ComponentType<P> {
  const Boundary: React.FC<P> = (props: P) => (
    <ErrorBoundary
      // The fallback closure captures `screenLabel` (a stable
      // module-level string) and renders the top-level ScreenFallback
      // component defined below — no nested-component definition,
      // just a callback that returns JSX.
      // eslint-disable-next-line react/no-unstable-nested-components
      fallback={(err, retry) => (
        <ScreenFallback err={err} retry={retry} screenLabel={screenLabel} />
      )}>
      <Wrapped {...props} />
    </ErrorBoundary>
  );
  Boundary.displayName = `WithScreenErrorBoundary(${screenLabel})`;
  return Boundary;
}

interface ScreenFallbackProps {
  err: Error;
  retry: () => void;
  screenLabel: string;
}

function ScreenFallback({err, retry, screenLabel}: ScreenFallbackProps): React.ReactElement {
  // Read navigation defensively — if the screen crashed before being
  // mounted under a navigator (shouldn't happen in practice, but
  // belt-and-braces) `useNavigation()` returns a stub and `goBack`
  // becomes a no-op rather than crashing the fallback itself.
  const nav = useNavigation();
  const goBack = (): void => {
    try {
      const navAny = nav as unknown as {canGoBack?: () => boolean; goBack?: () => void};
      if (typeof navAny.canGoBack === 'function' && navAny.canGoBack() && typeof navAny.goBack === 'function') {
        navAny.goBack();
      }
    } catch { /* ignore */ }
  };
  return (
    <View style={styles.root}>
      <Text style={styles.title}>{screenLabel} hit an error</Text>
      <Text style={styles.body}>
        We've reported it. You can try again, or go back to the
        previous screen — the rest of the app is still working.
      </Text>
      <View style={styles.buttonRow}>
        <TouchableOpacity style={[styles.button, styles.buttonGhost]} onPress={goBack}>
          <Text style={[styles.buttonText, styles.buttonTextGhost]}>Back</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.button} onPress={retry}>
          <Text style={styles.buttonText}>Retry</Text>
        </TouchableOpacity>
      </View>
      {__DEV__ && (
        <Text style={styles.dev} numberOfLines={20}>
          {err.name}: {err.message}
          {'\n'}
          {err.stack}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#0A0A0A',
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 12,
    textAlign: 'center',
  },
  body: {
    color: '#B8B8B8',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 18,
  },
  buttonRow: {
    flexDirection: 'row',
    gap: 12,
  },
  button: {
    backgroundColor: '#1E5BFF',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 8,
  },
  buttonGhost: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: '#2A2A2A',
  },
  buttonText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
  buttonTextGhost: {
    color: '#B8B8B8',
  },
  dev: {
    color: '#FF6464',
    fontSize: 10,
    fontFamily: 'monospace',
    marginTop: 32,
    width: '100%',
  },
});
