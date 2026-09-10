import {Platform, PermissionsAndroid} from 'react-native';
import Geolocation from 'react-native-geolocation-service';

/**
 * Best-effort single-shot location. Resolves null if denied/unavailable.
 * Location is captured ONLY during an explicit check-in / incident action —
 * there is no background or continuous tracking (PDF p.16 / CLAUDE.md). A denied
 * fix never crashes the flow; the server turns "no coords" into Pending Review.
 */
export async function getGeo(): Promise<{lat: number; lng: number; accuracy_m?: number} | null> {
  try {
    if (Platform.OS === 'android') {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      );
      if (granted !== PermissionsAndroid.RESULTS.GRANTED) {return null;}
    }
    return await new Promise(resolve => {
      Geolocation.getCurrentPosition(
        p => resolve({lat: p.coords.latitude, lng: p.coords.longitude, accuracy_m: p.coords.accuracy}),
        () => resolve(null),
        {enableHighAccuracy: true, timeout: 8000, maximumAge: 10000},
      );
    });
  } catch {
    return null;
  }
}

/**
 * Reverse-geocode a GPS fix → a human-readable address via Mapbox (the same
 * EXPO_PUBLIC_MAPBOX_TOKEN the news/VBG maps already use). Returns null when no
 * token is baked in, the API is unreachable, or there's no match — callers then
 * fall back to a coarse "lat, lng" label, so a geocode miss never blocks a
 * report. No coordinates or address are logged.
 */
export async function reverseGeocode(lat: number, lng: number): Promise<string | null> {
  const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
  if (!token || !Number.isFinite(lat) || !Number.isFinite(lng)) {return null;}
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?types=address,poi,neighborhood,locality,place&limit=1&access_token=${token}`;
    const res = await fetch(url, {method: 'GET'});
    if (!res.ok) {return null;}
    const body = (await res.json()) as {features?: Array<{text?: string; place_name?: string}>};
    const f = body.features?.[0];
    return f?.place_name ?? f?.text ?? null;
  } catch {
    return null;
  }
}

/**
 * Reverse-geocode a fix → ISO-3166 alpha-2 country code via Mapbox (same token as
 * reverseGeocode). Returns null when no token is baked in, the API is unreachable, or
 * no country is present — callers then fall back to a bounding-box heuristic. Used by the
 * provider Region setting to default-assign + guard region changes. No coordinates logged.
 */
export async function reverseGeocodeCountry(lat: number, lng: number): Promise<string | null> {
  const token = process.env.EXPO_PUBLIC_MAPBOX_TOKEN;
  if (!token || !Number.isFinite(lat) || !Number.isFinite(lng)) {return null;}
  try {
    const url =
      `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
      `?types=country&limit=1&access_token=${token}`;
    const res = await fetch(url, {method: 'GET'});
    if (!res.ok) {return null;}
    const body = (await res.json()) as {
      features?: Array<{properties?: {short_code?: string}; context?: Array<{id?: string; short_code?: string}>}>;
    };
    const f = body.features?.[0];
    // A `country`-type feature carries its ISO code on properties.short_code; if the match
    // came back as a finer feature, scan its context for the country entry.
    const code = f?.properties?.short_code
      ?? f?.context?.find(c => c.id?.startsWith('country'))?.short_code;
    return code ? code.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Camera permission for the face PRESENCE step only (no other surface asks). */
export async function requestCamera(): Promise<boolean> {
  if (Platform.OS !== 'android') {return true;} // iOS prompts on first use
  try {
    const granted = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.CAMERA);
    return granted === PermissionsAndroid.RESULTS.GRANTED;
  } catch {
    return false;
  }
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) {return '—';}
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {return '—';}
  return d.toLocaleString(undefined, {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'});
}

export function fmtWindow(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) {return '—';}
  const day = s.toLocaleDateString(undefined, {weekday: 'short', day: '2-digit', month: 'short'});
  const t = (d: Date) => d.toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'});
  return `${day} · ${t(s)} – ${t(e)}`;
}
