/**
 * useMissionAdvance — the ONE way the field app advances a mission's FSM.
 *
 * Extracted verbatim from AssignedMissionDetailScreen, which used to be the only
 * caller of agentApi.missionPickup / missionGoLive / missionComplete anywhere in
 * the app. The driver's live tracker now renders the same contextual action (the
 * founder's "Client Picked Up" checkpoint), and two screens calling the same
 * transition is exactly how the deploy-checks translation, the session-loss
 * branch and the never-optimistic re-read drift apart.
 *
 * Everything here is behaviour that already existed and is load-bearing:
 *   - a best-effort device fix rides along so the server can geofence-WARN ops
 *     (LM-C3) — it never blocks, a denied permission resolves undefined;
 *   - `deploy_checks_incomplete` is translated into a plain sentence rather than
 *     surfacing a raw server code;
 *   - a genuine session loss (B-76, single-device takeover) signs out cleanly
 *     instead of reading as "could not advance";
 *   - truth is ALWAYS re-read from the server, including on the error path, so a
 *     lost-200 reconciles immediately instead of waiting for the next poll.
 */
import {useCallback, useState} from 'react';
import Geolocation from 'react-native-geolocation-service';
import {Alert} from '@utils/alert';
import {agentApi, isAuthLostError} from '@services/api';
import {useAuthStore} from '@store/authStore';
import type {MissionAction} from './missionAction';

/**
 * LM-C3 — best-effort device fix for the geofence warning on transitions.
 * Never blocks the action: a denied permission / timeout resolves undefined.
 */
export function bestEffortFix(): Promise<{lat: number; lng: number} | undefined> {
  return new Promise(resolve => {
    const done = setTimeout(() => resolve(undefined), 3_000);
    try {
      Geolocation.getCurrentPosition(
        pos => { clearTimeout(done); resolve({lat: pos.coords.latitude, lng: pos.coords.longitude}); },
        () => { clearTimeout(done); resolve(undefined); },
        {enableHighAccuracy: false, timeout: 2_500, maximumAge: 30_000},
      );
    } catch { clearTimeout(done); resolve(undefined); }
  });
}

export interface MissionAdvance {
  acting: boolean;
  runAction: (action: MissionAction) => Promise<void>;
}

/**
 * @param reload re-reads mission truth. Called after every outcome, success or
 *   failure — the caller must NOT optimistically move its own status.
 */
export function useMissionAdvance(
  missionId: string | null | undefined,
  reload: () => Promise<unknown> | unknown,
): MissionAdvance {
  const [acting, setActing] = useState(false);

  const runAction = useCallback(async (action: MissionAction) => {
    if (!missionId || acting) {return;}
    const call = action === 'start' ? agentApi.missionPickup
      : action === 'go-live' ? agentApi.missionGoLive
      : action === 'finish' ? agentApi.missionComplete : null;
    if (!call) {return;}
    setActing(true);
    try {
      const fix = await bestEffortFix();
      await call(missionId, fix);
      await reload(); // re-read truth; never optimistically claim "completed"
    } catch (e: unknown) {
      // B-76 — a genuine session loss (single-device takeover: the same account
      // signed in on another phone) surfaces here as a 401 the refresh couldn't
      // recover. Don't dump the raw `token_revoked` string as "could not advance";
      // tell the officer plainly and hand off to the standard sign-out teardown.
      // signOut() is idempotent.
      if (isAuthLostError(e)) {
        Alert.alert('Signed out',
          'Your session ended — your account may have signed in on another device. Please sign in again.');
        void useAuthStore.getState().signOut();
        return;
      }
      // Re-read truth so a lost-200 (server advanced, we saw a network error)
      // reconciles immediately instead of waiting for the next poll.
      await reload();
      const raw = (e as {response?: {data?: {message?: string | string[]}}})?.response?.data?.message;
      const code = Array.isArray(raw) ? raw[0] : raw;
      Alert.alert('Could not advance',
        code === 'deploy_checks_incomplete'
          ? 'Complete your deploy checks (dress, vehicle, equipment, briefing) before starting.'
          : (typeof code === 'string' ? code : (e as Error).message) ?? 'Try again — your mission is unchanged.');
    } finally { setActing(false); }
  }, [missionId, acting, reload]);

  return {acting, runAction};
}
