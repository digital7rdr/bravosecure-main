import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Text, StyleSheet, TouchableOpacity, ActivityIndicator, View} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import {scaleTextStyles} from '@utils/scaling';
import {vbgApi} from '@/services/api';
import type {VbgFix} from './useVbgLocation';
import {VBG, VbgCard, SectionLabel} from './vbgUi';

/**
 * Scheduled biometric check-in prompt (audit H-2). Monitoring enrollment
 * promises "hourly face scans; 3 missed → escalation", but nothing ever asked
 * for a scan — this card polls /vbg/monitoring/status while a VBG screen is
 * open and, when the interval window has lapsed, prompts a device biometric
 * verify that posts /vbg/biometric/checkin pass|fail. The server-side
 * watchdog (audit H-1) covers the phone-dark case; this covers the
 * app-in-hand case and keeps the enrolled principal's counter clean.
 */
export function VbgScanPrompt({fix}: {fix: VbgFix | null}) {
  const [due, setDue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failNote, setFailNote] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);

  const check = useCallback(async () => {
    try {
      const {data} = await vbgApi.monitoringStatus();
      if (!alive.current) {return;}
      if (!data.enrolled || !data.interval_min || !data.last_heartbeat_at) {
        setDue(false);
        return;
      }
      const lastMs = Date.parse(data.last_heartbeat_at);
      setDue(!Number.isNaN(lastMs) && Date.now() - lastMs >= data.interval_min * 60_000);
    } catch {
      /* status unreachable — keep the current card state, next poll retries */
    }
  }, []);

  useEffect(() => {
    void check();
    const id = setInterval(() => { void check(); }, 60_000);
    return () => clearInterval(id);
  }, [check]);

  const verify = useCallback(async () => {
    if (busy) {return;}
    setBusy(true);
    setFailNote(null);
    try {
      /**
       * The SECOND copy of BiometricGate's device predicate — kept in step with
       * it deliberately (B-438).
       *
       * `isEnrolledAsync()` returns false during an Android biometric LOCKOUT
       * (five failed attempts) as well as for a device with nothing enrolled,
       * so the old check turned "this person just failed five times" into an
       * automatic PASS on a security check-in. The enrolled LEVEL is the honest
       * question, and `disableDeviceFallback:false` means a PIN-only device
       * still gets a real prompt.
       */
      const level = await LocalAuthentication.getEnrolledLevelAsync();
      // Nothing enrolled at all → the tap itself is the check-in (same trust
      // level BiometricGate grants an unconfigured device).
      const passed = level === LocalAuthentication.SecurityLevel.NONE
        ? true
        : (await LocalAuthentication.authenticateAsync({
            promptMessage: 'Security check-in — confirm it’s you',
            fallbackLabel: 'Use device PIN',
            cancelLabel: 'Cancel',
            disableDeviceFallback: false,
          })).success;
      const res = await vbgApi.biometricCheckin({result: passed ? 'pass' : 'fail', ...(fix ?? {})});
      if (!alive.current) {return;}
      if (passed) {
        setDue(false);
      } else {
        setFailNote(`Verification failed (${res.data.missed_count} missed). Try again — 3 fails alert the Bravo Control System.`);
      }
    } catch {
      if (alive.current) {setFailNote('Check-in could not be sent. Check your connection and try again.');}
    } finally {
      if (alive.current) {setBusy(false);}
    }
  }, [busy, fix]);

  if (!due) {return null;}

  return (
    <VbgCard rail={VBG.indigo} pad={14}>
      <SectionLabel color="#C4B5FD" style={{marginBottom: 8}}>Scheduled Check-in</SectionLabel>
      <Text style={styles.desc}>
        Your biometric check-in window has lapsed. Verify now to confirm you’re safe — missed check-ins escalate to the Bravo Control System.
      </Text>
      {failNote ? <Text style={styles.fail}>{failNote}</Text> : null}
      <TouchableOpacity activeOpacity={0.85} style={styles.btn} onPress={() => { void verify(); }} disabled={busy}>
        {busy ? <ActivityIndicator color="#fff" size="small" /> : <Text style={styles.btnText}>VERIFY NOW</Text>}
      </TouchableOpacity>
      <View />
    </VbgCard>
  );
}

const styles = StyleSheet.create(scaleTextStyles({
  desc: {fontSize: 12, lineHeight: 17, color: VBG.textDim},
  fail: {fontSize: 11, lineHeight: 15, color: '#FF8B8B', marginTop: 8},
  btn: {
    marginTop: 12, height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center',
    backgroundColor: VBG.indigo, borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  btnText: {fontSize: 11, fontWeight: '700', letterSpacing: 1.4, color: '#fff'},
}));
