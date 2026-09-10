/**
 * P2-BR-1 (background-reliability audit 2026-07-10) — Signal-style
 * "notification reliability" prompt. Aggressive OEM power managers (TECNO/
 * HiOS — the QA device — MIUI, ColorOS, FuntouchOS, EMUI) force-stop a
 * swiped-away app, after which Android delivers ZERO FCM: killed-app messages
 * and call rings silently black out. Shown when the app is NOT exempt from
 * battery optimization; offers the system exemption dialog and, on OEMs with
 * an auto-start kill list, a deep link to that screen. Dismiss snoozes the
 * prompt for ~7 days per owner. Mirrors the N-31 NotificationPermissionBanner
 * pattern and mounts directly beside it.
 */
import React, {useState, useCallback} from 'react';
import {View, Text, TouchableOpacity, Platform, StyleSheet, AppState} from 'react-native';
import {useFocusEffect} from '@react-navigation/native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {useAuthStore} from '@store/authStore';
import {
  isIgnoringBatteryOptimizations,
  requestIgnoreBatteryOptimizations,
  openAutostartSettings,
  hasOemAutostartScreen,
  snoozeReliabilityPrompt,
  isReliabilityPromptSnoozed,
  canUseFullScreenIntent,
  openFullScreenIntentSettings,
  isDndEnabled,
  openDndSettings,
} from '@/modules/messenger/push/batteryOptimization';

export default function NotificationReliabilityCard() {
  // B-63 — the card now covers three independent reliability gaps:
  //   batt: not exempt from battery optimization (killed-app FCM blackout)
  //   fsi:  Android 14+ full-screen-intent denied (no lock-screen call UI;
  //         the 2026-07-10 rings all posted FSI_REQUESTED_BUT_DENIED)
  //   dnd:  CA-07 — Do Not Disturb silences tones/rings with every permission
  //         granted, which reads as "the app is broken"
  const [needBatt, setNeedBatt] = useState(false);
  const [needFsi, setNeedFsi] = useState(false);
  const [needDnd, setNeedDnd] = useState(false);
  const ownerId = useAuthStore(s => s.user?.id ?? null);
  const showAutostart = hasOemAutostartScreen();

  const check = useCallback(async (): Promise<{batt: boolean; fsi: boolean; dnd: boolean}> => {
    if (Platform.OS !== 'android') {return {batt: false, fsi: false, dnd: false};}
    if (await isReliabilityPromptSnoozed(ownerId)) {return {batt: false, fsi: false, dnd: false};}
    const [exempt, fsiOk, dndOn] = await Promise.all([
      isIgnoringBatteryOptimizations(),
      canUseFullScreenIntent(),
      isDndEnabled(),
    ]);
    return {batt: !exempt, fsi: !fsiOk, dnd: dndOn};
  }, [ownerId]);

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;
      const run = () => {
        check()
          .then(v => { if (!cancelled) {setNeedBatt(v.batt); setNeedFsi(v.fsi); setNeedDnd(v.dnd);} })
          .catch(() => { /* best-effort */ });
      };
      run();
      // Re-check when the app returns from the system dialog / OEM settings
      // so a fresh grant hides the card without a re-navigation.
      const sub = AppState.addEventListener('change', st => {
        if (st === 'active') {run();}
      });
      return () => { cancelled = true; sub.remove(); };
    }, [check]),
  );

  const onAllow = useCallback(() => {
    requestIgnoreBatteryOptimizations().catch(() => { /* logged in wrapper */ });
  }, []);

  const onAutostart = useCallback(() => {
    openAutostartSettings().catch(() => { /* logged in wrapper */ });
  }, []);

  const onFsi = useCallback(() => {
    openFullScreenIntentSettings().catch(() => { /* logged in wrapper */ });
  }, []);

  const onDnd = useCallback(() => {
    openDndSettings().catch(() => { /* logged in wrapper */ });
  }, []);

  const onDismiss = useCallback(() => {
    setNeedBatt(false);
    setNeedFsi(false);
    setNeedDnd(false);
    snoozeReliabilityPrompt(ownerId).catch(() => { /* logged in wrapper */ });
  }, [ownerId]);

  if (!needBatt && !needFsi && !needDnd) {return null;}
  // Severity order: a killed-app blackout beats a silent ring beats DND.
  const text = needBatt
    ? 'Calls and messages may not arrive when the app is closed. Allow Bravo to run in the background.'
    : needFsi
      ? 'Incoming calls can’t ring on your lock screen. Allow full-screen notifications for Bravo.'
      : 'Do Not Disturb is on — messages and calls won’t make a sound.';
  return (
    <View style={s.wrap}>
      <Icon
        name={needBatt ? 'battery-alert-variant-outline' : needFsi ? 'phone-lock' : 'minus-circle-outline'}
        size={16}
        color="#5B8DEF"
      />
      <Text style={s.text} numberOfLines={3}>
        {text}
      </Text>
      {needBatt && (
        <TouchableOpacity onPress={onAllow} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>Allow</Text>
        </TouchableOpacity>
      )}
      {needBatt && showAutostart && (
        <TouchableOpacity onPress={onAutostart} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>Auto-start</Text>
        </TouchableOpacity>
      )}
      {needFsi && (
        <TouchableOpacity onPress={onFsi} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>{needBatt ? 'Calls' : 'Allow'}</Text>
        </TouchableOpacity>
      )}
      {needDnd && (
        <TouchableOpacity onPress={onDnd} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
          <Text style={s.action}>{needBatt || needFsi ? 'DND' : 'Review'}</Text>
        </TouchableOpacity>
      )}
      <TouchableOpacity onPress={onDismiss} activeOpacity={0.7} hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}>
        <Icon name="close" size={15} color="#94A3B8" />
      </TouchableOpacity>
    </View>
  );
}

// Obsidian language (bg #07090D family, accent #5B8DEF) — a cobalt-tinted
// sibling of the N-31 red strip so "reliability" reads as guidance, not error.
const s = StyleSheet.create({
  wrap: {
    flexDirection: 'row', alignItems: 'center', gap: 10,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(91,141,239,0.10)',
    borderBottomWidth: 1, borderBottomColor: 'rgba(91,141,239,0.25)',
  },
  text: {flex: 1, color: '#C9D7F2', fontSize: 12.5},
  action: {color: '#5B8DEF', fontSize: 12.5, fontWeight: '700'},
});
