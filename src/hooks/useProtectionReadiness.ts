/**
 * Mission-start readiness — the device half (founder 2026-08-11).
 *
 * Asks the OS what it will actually give us, reports the answers to the backend
 * (which alone decides whether the mission may start), and re-checks whenever
 * the app comes back to the foreground — so returning from Settings updates the
 * screen with no restart.
 *
 * We never trust a previous grant: the check runs against the live OS state
 * every time, because permissions can be revoked between sessions or mid-mission
 * (edge case 6) and a reinstall resets them entirely (edge cases 9 and 10).
 */
import {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, Linking, PermissionsAndroid, Platform, type AppStateStatus} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {protectionApi, cpoProtectionApi} from '@services/api';
import {
  applyLocationError, isReady, missingRequirements, NOT_READY,
  type ReadinessFlags, type ReadinessRequirement,
} from '@utils/protectionReadiness';

export interface UseProtectionReadiness {
  flags: ReadinessFlags;
  missing: ReadinessRequirement[];
  ready: boolean;
  /** True until the first check completes — do not show a blocking gate yet. */
  checking: boolean;
  /** Server's view: 'READY' | 'WAITING_FOR_READINESS' | null before first report. */
  serverState: string | null;
  /** Which side(s) the server says are blocking. */
  blockedBy: string[];
  recheck: () => void;
  openSettings: () => void;
}

async function readConnectivity(): Promise<boolean> {
  try {
    const NetInfo = (require('@react-native-community/netinfo') as typeof import('@react-native-community/netinfo')).default;
    const s = await NetInfo.fetch();
    // isInternetReachable is null while unknown — treat only an explicit false
    // as offline so a slow probe does not block a working device.
    return Boolean(s.isConnected) && s.isInternetReachable !== false;
  } catch {
    return false;
  }
}

async function readLocationPermission(): Promise<{granted: boolean; precise: boolean}> {
  if (Platform.OS === 'android') {
    const fine = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    if (fine) {return {granted: true, precise: true};}
    const coarse = await PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION);
    if (coarse) {return {granted: true, precise: false};} // Android 12+ "approximate"
    const asked = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    const ok = asked === PermissionsAndroid.RESULTS.GRANTED;
    return {granted: ok, precise: ok};
  }
  const auth = await Geolocation.requestAuthorization('whenInUse');
  // iOS reduced accuracy still reports 'granted'; the fix's accuracy tells us
  // whether the user actually gave us precise location.
  return {granted: auth === 'granted', precise: auth === 'granted'};
}

/** Resolves the position OR the error code — never throws, never hangs. */
function getFix(): Promise<{ok: true; accuracy: number} | {ok: false; code?: number}> {
  return new Promise(resolve => {
    Geolocation.getCurrentPosition(
      pos => resolve({ok: true, accuracy: pos.coords.accuracy ?? 0}),
      err => resolve({ok: false, code: (err as {code?: number}).code}),
      {enableHighAccuracy: true, timeout: 15_000, maximumAge: 10_000},
    );
  });
}

// iOS reduced accuracy lands around a few kilometres; a precise fix is far
// tighter. Only used to demote precision, never to claim it.
const COARSE_ACCURACY_M = 500;

export function useProtectionReadiness(
  sessionId: string | null, role: 'customer' | 'cpo',
): UseProtectionReadiness {
  const [flags, setFlags] = useState<ReadinessFlags>(NOT_READY);
  const [checking, setChecking] = useState(true);
  const [serverState, setServerState] = useState<string | null>(null);
  const [blockedBy, setBlockedBy] = useState<string[]>([]);
  const running = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const check = useCallback(async () => {
    if (running.current) {return;}
    running.current = true;
    setChecking(true);
    try {
      const [{granted, precise}, connectivity] = await Promise.all([
        readLocationPermission(), readConnectivity(),
      ]);
      let next: ReadinessFlags = {
        location_permission: granted,
        // Assumed on until an error proves the OS switch is off.
        location_services: true,
        precise_location: granted && precise,
        connectivity,
        location_available: false,
      };
      if (granted) {
        const fix = await getFix();
        if (fix.ok) {
          next.location_available = true;
          if (Platform.OS === 'ios' && fix.accuracy > COARSE_ACCURACY_M) {
            next.precise_location = false; // reduced-accuracy mode
          }
        } else {
          next = applyLocationError(next, fix.code);
        }
      } else {
        next.location_available = false;
      }
      if (!mounted.current) {return;}
      setFlags(next);

      if (sessionId) {
        const body = {...next, platform: Platform.OS};
        const {data} = role === 'cpo'
          ? await cpoProtectionApi.reportReadiness(sessionId, body)
          : await protectionApi.reportReadiness(sessionId, body);
        if (!mounted.current) {return;}
        const r = (data as {readiness?: {state?: string; blocked_by?: string[]}})?.readiness;
        setServerState(r?.state ?? null);
        setBlockedBy(r?.blocked_by ?? []);
      }
    } catch {
      // A failed report must not claim readiness — the local flags still show
      // the user what to fix, and the server simply has no fresh row.
    } finally {
      running.current = false;
      if (mounted.current) {setChecking(false);}
    }
  }, [sessionId, role]);

  useEffect(() => { void check(); }, [check]);

  // Returning from Settings (or any foreground return) re-checks automatically —
  // the user must never have to restart the app.
  useEffect(() => {
    let prev = AppState.currentState;
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (prev.match(/inactive|background/) && s === 'active') {void check();}
      prev = s;
    });
    return () => sub.remove();
  }, [check]);

  const openSettings = useCallback(() => {
    void Linking.openSettings().catch(() => undefined);
  }, []);

  return {
    flags,
    missing: missingRequirements(flags),
    ready: isReady(flags),
    checking,
    serverState,
    blockedBy,
    recheck: () => { void check(); },
    openSettings,
  };
}
