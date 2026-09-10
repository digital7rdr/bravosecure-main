import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';
import {Alert} from '@utils/alert';
import {devForceCrash, log, recordError} from './crashlytics';

/**
 * Test Crash button — dev/staging only.
 *
 * Two ways to verify Crashlytics is wired:
 *   1. "Force native crash" — calls crashlytics().crash(). The app dies
 *      on the spot. Restart it and the report shows up in the Firebase
 *      console within a few minutes. This is the path Google's "Step 3"
 *      verification asks for.
 *   2. "Send non-fatal error" — synthesises an Error and ships it via
 *      recordError. The app keeps running. Useful when you don't want
 *      to nuke a debug session to verify the pipeline.
 *
 * Hidden behind __DEV__ + EXPO_PUBLIC_API_BASE_URL match for staging,
 * so it never ships in a production build no matter where it's mounted.
 */
export function TestCrashButton(): React.JSX.Element | null {
  const isStaging = process.env.EXPO_PUBLIC_API_BASE_URL?.includes('94-136-184-52') ?? false;
  if (!__DEV__ && !isStaging) {return null;}

  const onNonFatal = (): void => {
    log('[bravo.observability] dev-test non-fatal at ' + new Date().toISOString());
    recordError(new Error('Bravo dev test — non-fatal'), {kind: 'dev-test'});
    Alert.alert(
      'Sent',
      'Non-fatal error sent to Crashlytics. Check the Firebase console in a few minutes.',
    );
  };

  const onFatal = (): void => {
    Alert.alert(
      'Force a crash?',
      'The app will die immediately. Restart it to deliver the report. Continue?',
      [
        {text: 'Cancel', style: 'cancel'},
        {
          text: 'Crash now',
          style: 'destructive',
          onPress: () => {
            log('[bravo.observability] dev-test fatal crash at ' + new Date().toISOString());
            devForceCrash();
          },
        },
      ],
    );
  };

  return (
    <View style={styles.root}>
      <Text style={styles.label}>Crashlytics dev tools</Text>
      <TouchableOpacity style={styles.btnSoft} onPress={onNonFatal}>
        <Text style={styles.btnText}>Send non-fatal error</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.btnDanger} onPress={onFatal}>
        <Text style={styles.btnText}>Force native crash</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    padding: 16,
    backgroundColor: '#1A1A1A',
    borderRadius: 12,
    margin: 16,
    gap: 8,
  },
  label: {
    color: '#B8B8B8',
    fontSize: 12,
    marginBottom: 4,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  btnSoft: {
    backgroundColor: '#2A2A2A',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnDanger: {
    backgroundColor: '#7A1A1A',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  btnText: {
    color: '#FFFFFF',
    fontWeight: '600',
  },
});
