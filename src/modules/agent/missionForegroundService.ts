/**
 * B-89 MG-03 — Android foreground service so the CPO's mission GPS keeps
 * flowing when the phone is pocketed / the app backgrounded.
 *
 * Before this, `useLeadTelemetry`'s watcher + heartbeat timers were
 * suspended the moment Android backgrounded the app (the long-standing
 * LM-C5 "native half" TODO), so the ops/client dot froze whenever the
 * lead stopped looking at the screen — an operational hazard for a
 * close-protection product.
 *
 * Mechanism: notifee's foreground service (its `ForegroundService` is
 * declared by the library manifest; ours adds
 * `foregroundServiceType="location"` via a manifest merge — Android 14+
 * hard-requires the declared type to match). While the persistent
 * "Mission tracking active" notification is displayed, the process stays
 * at foreground priority, so the EXISTING JS watcher + heartbeat keep
 * ticking — no separate native tracker to keep in sync.
 *
 * Concurrency (review M-2): start/stop are ASYNC native round-trips, and
 * the hook can fire stop while a start is still in flight (fast tab
 * switch) or start B right after stopping A. All ops run on ONE serial
 * chain and each op executes only if it is still the LATEST request
 * (generation token) — so a superseded start never births an orphaned
 * service, and an A→B switch skips the intermediate stop (the same
 * notification id hands the service over seamlessly).
 *
 * Registration MUST happen at bundle entry (index.js) per notifee's
 * contract.
 */
import {Platform} from 'react-native';

let registered = false;
let stopRunner: (() => void) | null = null;
let runningMissionId: string | null = null;
let generation = 0;
let opChain: Promise<void> = Promise.resolve();

type Notifee = typeof import('@notifee/react-native');
function notifeeMod(): Notifee | null {
  try {
    return require('@notifee/react-native') as Notifee;
  } catch {
    return null;
  }
}

/** Call ONCE at bundle entry (index.js). Safe no-op elsewhere/iOS. */
export function registerMissionForegroundService(): void {
  if (registered || Platform.OS !== 'android') {return;}
  const mod = notifeeMod();
  if (!mod) {return;}
  registered = true;
  // The runner promise IS the service lifetime: resolving it lets notifee
  // tear the service down after stopForegroundService().
  mod.default.registerForegroundService(() => new Promise<void>(resolve => {
    stopRunner = resolve;
  }));
}

function enqueue(op: () => Promise<void>): Promise<void> {
  opChain = opChain.then(op).catch(() => undefined);
  return opChain;
}

export function startMissionTracking(missionId: string, shortCode?: string | null, attempt = 0): Promise<void> {
  if (Platform.OS !== 'android') {return Promise.resolve();}
  const gen = ++generation;
  return enqueue(async () => {
    if (gen !== generation) {return;}                 // superseded (stopped/newer start)
    if (runningMissionId === missionId) {return;}     // already holding for this mission
    const mod = notifeeMod();
    if (!mod) {return;}
    try {
      const channelId = await mod.default.createChannel({
        id: 'mission-tracking',
        name: 'Mission tracking',
        // LOW — persistent status, never a heads-up interruption.
        importance: mod.AndroidImportance.LOW,
      });
      if (gen !== generation) {return;}               // stop arrived mid-flight — do not display
      await mod.default.displayNotification({
        id: 'mission-tracking',
        title: 'Mission tracking active',
        body: shortCode ? `Sharing live GPS for mission ${shortCode}` : 'Sharing live GPS with ops',
        android: {
          channelId,
          asForegroundService: true,
          foregroundServiceTypes: [mod.AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_LOCATION],
          smallIcon: 'ic_stat_bravo',
          ongoing: true,
          onlyAlertOnce: true,
          pressAction: {id: 'default'},
        },
      });
      runningMissionId = missionId;
    } catch (e) {
      // Review m-1 — a transient failure must not silently revert the
      // mission to freeze-on-background: ONE delayed re-arm, gated on the
      // generation so a stop/end cancels it (and no retry loops).
      console.warn('[missionFgs] start failed:', (e as Error).message);
      if (attempt === 0) {
        setTimeout(() => {
          if (gen === generation) {void startMissionTracking(missionId, shortCode, 1);}
        }, 10_000);
      }
    }
  });
}

export function stopMissionTracking(): Promise<void> {
  if (Platform.OS !== 'android') {return Promise.resolve();}
  const gen = ++generation;
  return enqueue(async () => {
    // A newer start (A→B mission switch) supersedes this stop — the same
    // notification id hands the service over without a teardown gap.
    if (gen !== generation) {return;}
    runningMissionId = null;
    const mod = notifeeMod();
    try {
      stopRunner?.();
      stopRunner = null;
      await mod?.default.stopForegroundService();
      await mod?.default.cancelNotification('mission-tracking');
    } catch { /* already stopped */ }
  });
}
