/**
 * The driver's OWN position, at navigation cadence.
 *
 * Why this exists: the live-tracker screen used to render the driver's own dot
 * from `mission.current_lat/current_lng`, which is a full round trip — the lead
 * console pushes telemetry on a ~10 s throttle, and the tracker polls the
 * mission every 4 s to read it back. The driver's own marker could therefore be
 * up to ~14 s stale, which at 100 km/h is nearly 400 m. Turn-by-turn guidance,
 * a track-up camera and off-route detection are all meaningless at that
 * latency: the map is describing where the vehicle WAS.
 *
 * Your own position does not need a server. This is a single ref-counted
 * `watchPosition` at driving cadence, shared by every subscriber, so the
 * tracker can render and navigate from first-hand fixes while the existing
 * telemetry push to ops carries on untouched.
 *
 * Scope: the DRIVER's own device only. A remote observer (ops 'monitor' mode)
 * must keep reading the server's copy — they are not in the vehicle.
 *
 * Coordinates are never logged (§9 — treat lat/lng like key material).
 */
import Geolocation from 'react-native-geolocation-service';
import {NativeModules, Platform} from 'react-native';
import {ensureLiveLocationAccess} from '@utils/locationPermission';

/**
 * react-native-geolocation-service keeps ONE native location stream and a
 * module-level `updatesEnabled` flag: `startObserving(options)` is called only
 * for the FIRST watcher, and every later watchPosition silently inherits that
 * first watcher's cadence. During an active mission the agent dashboard
 * already runs a watcher at 15-30 s / 20 m, so simply asking for 1 Hz here
 * would be ignored and the driver would navigate on 30-second fixes.
 *
 * The native module re-issues requestLocationUpdates on every startObserving
 * call, so calling it directly re-tunes the shared stream. Every other
 * mission-time consumer throttles its own sends, so a faster shared stream is
 * safe for them.
 */
function fusedLocation(): {startObserving?: (o: object) => void} | undefined {
  // Read lazily, never at module scope: importing this file must not depend on
  // a native module being linked.
  return (NativeModules as {RNFusedLocation?: {startObserving?: (o: object) => void}})
    .RNFusedLocation;
}

export interface OwnFix {
  lat: number;
  lng: number;
  /** Course over ground in degrees, or null when the OS has none. */
  headingDeg: number | null;
  speedMps: number | null;
  accuracyM: number | null;
  /** Epoch ms of the fix, as reported by the location provider. */
  at: number;
  /**
   * Epoch ms measured on OUR clock when the fix arrived. Freshness checks must
   * use this: `at` comes from the provider and can be skewed against Date.now()
   * (mock providers and some OEMs report elapsed-realtime-derived values), so
   * comparing it to Date.now() is not a reliable staleness signal.
   */
  receivedAt: number;
}

/** A replayed fix older than this is not worth seeding a new subscriber with. */
const REPLAY_MAX_AGE_MS = 30_000;

type Listener = (fix: OwnFix) => void;

// Driving cadence. distanceFilter 0 means "report on every fix" — at speed the
// OS coalesces anyway, and a 5-10 m filter makes the track-up camera lurch
// between updates instead of turning smoothly.
const WATCH_OPTS = {
  enableHighAccuracy: true,
  distanceFilter: 0,
  interval: 1000,
  fastestInterval: 1000,
  showLocationDialog: true,
} as const;

/**
 * What the shared stream is handed back to when navigation stops. Matches the
 * fastest remaining mission consumer (the lead-telemetry push, 5 s) so nobody
 * is starved, without leaving the GPS pinned at 1 Hz for the rest of the
 * mission.
 */
const AMBIENT_OPTS = {
  enableHighAccuracy: true,
  distanceFilter: 10,
  interval: 5000,
  fastestInterval: 5000,
} as const;

function retuneStream(opts: object): void {
  try {
    fusedLocation()?.startObserving?.(opts);
  } catch {
    // Older/!android build without the method — we keep whatever cadence the
    // first watcher set, which is a degradation, not a failure.
  }
}

const listeners = new Set<Listener>();
let watchId: number | null = null;
let last: OwnFix | null = null;
let starting = false;

/** iOS reports course/speed as -1 when unavailable; normalise to null. */
function clean(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}

function publish(fix: OwnFix): void {
  last = fix;
  for (const cb of listeners) {
    cb(fix);
  }
}

async function start(): Promise<void> {
  // Both guards matter: `starting` covers a second subscriber arriving while
  // the permission prompt is still up, and `watchId` covers one arriving after
  // the watch is already live — without it that call would open a SECOND 1 Hz
  // watch and overwrite watchId, leaking the first one for the session.
  if (watchId !== null || starting) {
    return;
  }
  starting = true;
  try {
    if (Platform.OS === 'android') {
      const grant = await ensureLiveLocationAccess({
        title: 'Use your location for navigation',
        message: 'Bravo Secure needs your location to give you turn-by-turn directions during this mission.',
      });
      if (grant === 'denied' || grant === 'blocked') {
        return;
      }
    } else if (Platform.OS === 'ios') {
      const auth = await Geolocation.requestAuthorization('whenInUse');
      if (auth !== 'granted') {
        return;
      }
    }
    // Everyone may have unsubscribed while the permission sheet was up.
    if (listeners.size === 0) {
      return;
    }
    watchId = Geolocation.watchPosition(
      pos => {
        publish({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          headingDeg: clean(pos.coords.heading),
          speedMps: clean(pos.coords.speed),
          accuracyM: clean(pos.coords.accuracy),
          at: pos.timestamp || Date.now(),
          receivedAt: Date.now(),
        });
      },
      () => {
        // A watch error must not tear the stream down: the screen already
        // renders truthful staleness, and the OS recovers on its own. Never
        // log the error with coordinates attached.
      },
      WATCH_OPTS,
    );
    // Our options are only honoured if we happened to be the first watcher in
    // the process. Re-issue them so navigation cadence is deterministic.
    retuneStream(WATCH_OPTS);
  } catch {
    // Permission module unavailable — the screen falls back to server fixes.
  } finally {
    starting = false;
  }
}

function stop(): void {
  if (watchId !== null) {
    // Hand the shared stream back to ambient cadence BEFORE releasing our
    // listener: at this instant a provider is certainly alive, so the
    // downgrade lands. If we turn out to be the last watcher, the clearWatch
    // below stops the provider outright a moment later, so this can never
    // leave the GPS running for nobody.
    retuneStream(AMBIENT_OPTS);
    Geolocation.clearWatch(watchId);
    watchId = null;
  }
}

/**
 * Subscribe to own-device fixes. The underlying watch starts on the first
 * subscriber and stops on the last, so a screen that unmounts cannot leave a
 * 1 Hz GPS watch running.
 */
export function subscribeOwnPosition(cb: Listener): () => void {
  listeners.add(cb);
  // Seed with the last fix so a remount renders immediately — but only if it
  // is still plausibly current. Replaying an hours-old fix would drive the
  // route, ETA and voice from wherever the vehicle used to be.
  if (last && Date.now() - last.receivedAt < REPLAY_MAX_AGE_MS) {
    cb(last);
  }
  void start();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) {
      stop();
    }
  };
}

export function getLastOwnFix(): OwnFix | null {
  return last;
}

/** Test seam — drops the watch and every listener. */
export function __resetOwnPositionForTest(): void {
  stop();
  listeners.clear();
  last = null;
  starting = false;
}
