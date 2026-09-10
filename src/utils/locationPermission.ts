/**
 * B-89 MG-05/MG-06 — shared location-permission + services-off UX.
 *
 * Two gaps this closes:
 *  - Every site requested ACCESS_FINE_LOCATION alone; on Android 12+ the
 *    user can answer "Approximate" and the request still resolves GRANTED —
 *    the app then runs on coarse fixes without knowing (MG-06).
 *  - Location services OFF surfaced as a silent frozen map: the live
 *    watchers suppressed the system dialog and swallowed every error
 *    (MG-05).
 */
import {Linking, PermissionsAndroid, Platform} from 'react-native';
import {Alert} from '@utils/alert';

export type LocationGrant = 'precise' | 'approximate' | 'denied' | 'blocked';

/**
 * Request FINE+COARSE together (the Android 12+ contract) and report what
 * the user actually granted. On iOS the caller keeps using
 * Geolocation.requestAuthorization — this helper is Android-first.
 */
export async function requestPreciseLocation(rationale: {title: string; message: string}): Promise<LocationGrant> {
  if (Platform.OS !== 'android') {return 'precise';}
  const FINE   = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
  const COARSE = PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION;
  if (await PermissionsAndroid.check(FINE)) {return 'precise';}
  const res = await PermissionsAndroid.requestMultiple([FINE, COARSE]);
  if (res[FINE] === PermissionsAndroid.RESULTS.GRANTED) {return 'precise';}
  if (res[COARSE] === PermissionsAndroid.RESULTS.GRANTED) {
    // MG-06 — the user picked "Approximate": fixes can be ~1-3 km off,
    // useless for a live protection map. Tell them once, honestly.
    Alert.alert(
      'Precise location is off',
      `${rationale.message}\n\nAndroid granted only APPROXIMATE location — the live map may be off by kilometres. Enable "Use precise location" for Bravo Secure in Settings.`,
      [
        {text: 'Not now', style: 'cancel'},
        {text: 'Open Settings', onPress: () => { void Linking.openSettings(); }},
      ],
    );
    return 'approximate';
  }
  if (res[FINE] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN
      || res[COARSE] === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) {
    return 'blocked';
  }
  return 'denied';
}

/**
 * Founder requirement (B-89): on a LIVE mission the app must ASK AGAIN
 * for GPS access instead of giving up silently. Flow: request (FINE+COARSE)
 * → on plain denial, one branded re-ask with the mission rationale and an
 * "Allow" that re-requests → on OS-level block (never-ask-again), an Open
 * Settings jump. Callers re-run this on every screen focus while live, so
 * the user is re-asked each time they come back — persistent, not a nag loop.
 */
export async function ensureLiveLocationAccess(rationale: {title: string; message: string}): Promise<LocationGrant> {
  const first = await requestPreciseLocation(rationale);
  if (first !== 'denied' && first !== 'blocked') {return first;}
  if (first === 'blocked') {
    Alert.alert(
      rationale.title,
      `${rationale.message}\n\nLocation is blocked for Bravo Secure. Enable it in Settings to continue.`,
      [
        {text: 'Not now', style: 'cancel'},
        {text: 'Open Settings', onPress: () => { void Linking.openSettings(); }},
      ],
    );
    return 'blocked';
  }
  // Plain denial — ask again with the why, through the system prompt.
  return new Promise<LocationGrant>(resolve => {
    Alert.alert(
      rationale.title,
      `${rationale.message}\n\nWithout location access this can't work during the live mission.`,
      [
        {text: 'Not now', style: 'cancel', onPress: () => resolve('denied')},
        {
          text: 'Allow',
          onPress: () => { void requestPreciseLocation(rationale).then(resolve); },
        },
      ],
      {onDismiss: () => resolve('denied')},
    );
  });
}

/** react-native-geolocation-service error codes. */
export const GEO_ERROR = {
  PERMISSION_DENIED: 1,
  POSITION_UNAVAILABLE: 2,
  TIMEOUT: 3,
  PLAY_SERVICE_NOT_AVAILABLE: 4,
  SETTINGS_NOT_SATISFIED: 5,
  INTERNAL_ERROR: -1,
} as const;

let servicesPromptShown = false;

/**
 * MG-05 — location services (the OS toggle) are off/unsatisfiable: say so
 * ONCE per app session with a jump to the system location settings,
 * instead of the old silent frozen map. Re-armable by callers that know
 * the user just came back (not needed today — one nudge per session).
 */
export function promptEnableLocationServices(context: string): void {
  if (servicesPromptShown) {return;}
  servicesPromptShown = true;
  Alert.alert(
    'Location is turned off',
    `${context}\n\nTurn on device location (GPS) so live tracking can work.`,
    [
      {text: 'Not now', style: 'cancel'},
      {
        text: 'Open Location Settings',
        onPress: () => {
          if (Platform.OS === 'android') {
            Linking.sendIntent('android.settings.LOCATION_SOURCE_SETTINGS')
              .catch(() => { void Linking.openSettings(); });
          } else {
            void Linking.openSettings();
          }
        },
      },
    ],
  );
}

/** True when a geolocation error means "the OS can't produce fixes right now". */
export function isServicesOffError(err: {code?: number} | null | undefined): boolean {
  return err?.code === GEO_ERROR.POSITION_UNAVAILABLE
    || err?.code === GEO_ERROR.SETTINGS_NOT_SATISFIED
    || err?.code === GEO_ERROR.PLAY_SERVICE_NOT_AVAILABLE;
}

/** Test seam. */
export function _resetServicesPromptForTest(): void {
  servicesPromptShown = false;
}
