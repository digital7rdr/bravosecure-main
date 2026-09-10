import {Platform, PermissionsAndroid} from 'react-native';
import Geolocation from 'react-native-geolocation-service';

/**
 * A GPS fix ONLY if location permission is ALREADY granted — this never shows a
 * permission dialog.
 *
 * Why not `useVbgLocation`/`getGeo`: both call `PermissionsAndroid.request`,
 * which puts a modal in front of the user. On the emergency directory that
 * modal would sit between a person in trouble and the number they came to dial,
 * and it would appear at the worst possible moment. The directory therefore
 * ASKS FOR NOTHING: it reads a fix when one is already permitted, and otherwise
 * leans on the permission-free mobile-network country
 * (see networkCountry.ts) — which is why that lane exists.
 *
 * Resolves null on denial, timeout, or any failure. Never throws.
 */
export async function getSilentFix(): Promise<{lat: number; lng: number} | null> {
  try {
    if (Platform.OS === 'android') {
      // COARSE counts. Android 12+ lets the user grant "Approximate location"
      // only, which leaves ACCESS_FINE_LOCATION denied — and naming a COUNTRY
      // needs nothing better than approximate. Checking FINE alone would throw
      // away a perfectly good fix from everyone who picked that option.
      const [fine, coarse] = await Promise.all([
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION),
        PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION),
      ]);
      if (!fine && !coarse) {return null;}
    }
    return await new Promise(resolve => {
      Geolocation.getCurrentPosition(
        p => resolve({lat: p.coords.latitude, lng: p.coords.longitude}),
        () => resolve(null),
        {
          // A cached fix up to 5 min old is plenty to name a COUNTRY, and it
          // returns instantly instead of waking the GNSS chip.
          enableHighAccuracy: false, timeout: 8000, maximumAge: 300_000,
          /**
           * ⚠️ LOAD-BEARING — `showLocationDialog` DEFAULTS TO TRUE.
           *
           * `LocationOptions.java`: `!map.hasKey(...) || map.getBoolean(...)`.
           * Omit it and a granted-permission device whose Location master
           * toggle is OFF takes `FusedLocationProvider`'s RESOLUTION_REQUIRED
           * branch and calls `startResolutionForResult` — the Google Play
           * "For a better experience, turn on device location" SYSTEM MODAL,
           * over the emergency directory. The permission check above cannot
           * stop it: it fires on the permission-GRANTED path.
           *
           * `forceRequestLocation` then lets us still try when location
           * services are on but the settings aren't "satisfied" (we asked for
           * low accuracy, so a network-only provider is fine) — more silent
           * successes, still zero dialogs.
           */
          showLocationDialog: false,
          forceRequestLocation: true,
        },
      );
    });
  } catch {
    return null;
  }
}
