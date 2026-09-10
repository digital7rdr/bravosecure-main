/**
 * Mapbox Directions API — Google-Maps-style turn-by-turn for the live tracker.
 *
 * The CPO's tracker fetches a driving route from the guard's current fix to the
 * active target (the pickup while heading to the principal, the dropoff once
 * LIVE) and renders it like Google Maps: the line behind the guard is
 * "traveled," the line ahead is "remaining," a banner shows the next maneuver
 * ("In 200 m, turn left onto Sheikh Zayed Road"), and the ETA is driven by the
 * live route duration.
 *
 * Uses the existing PUBLIC EXPO_PUBLIC_MAPBOX_TOKEN (valid for the Directions
 * API) — no secret is added. Coordinates are never logged.
 *
 * The geo + selection helpers (haversineM, nearestIndexOnRoute,
 * splitRouteAtProgress, nextManeuver, formatDistance, offRouteDistanceM) are
 * pure and exported so they can be unit-tested without a network or a map.
 */

export interface LngLat {
  lng: number;
  lat: number;
}

export type DirectionsProfile = 'driving' | 'driving-traffic' | 'walking' | 'cycling';

/**
 * One spoken cue for a step. Mapbox returns these already phrased for driving
 * ("In a quarter mile, turn right onto Al Falah Street") along with the
 * distance-before-the-maneuver at which each should be announced.
 */
export interface VoiceCue {
  /** Announce when the remaining distance to the maneuver drops to this. */
  distanceAlongGeometryM: number;
  announcement: string;
}

export interface DirectionStep {
  instruction: string; // "Turn left onto Sheikh Zayed Road"
  bannerPrimary: string; // banner_instructions primary (falls back to instruction)
  bannerSecondary: string | null;
  maneuverType: string; // 'turn' | 'depart' | 'arrive' | 'fork' | ...
  modifier: string | null; // 'left' | 'right' | 'straight' | 'slight left' | ...
  distanceM: number; // length of this step
  location: LngLat; // the maneuver point (start of the step)
  /** Navigation.docx — the road this step travels ALONG (`step.name`); null
   *  when unnamed. Powers the "road driving on currently" display. */
  roadName: string | null;
  /** Ordered far → near. Empty when the API returned none. */
  voice: VoiceCue[];
}

export interface DirectionsRoute {
  coordinates: LngLat[]; // decoded overview geometry
  distanceM: number;
  durationS: number;
  steps: DirectionStep[];
  /**
   * Navigation.docx — legal speed limit per geometry SEGMENT in km/h
   * (`annotations=maxspeed`): entry i covers coordinates[i]→coordinates[i+1].
   * null in a slot = unknown/no-limit there; the whole field is null when the
   * response carried no annotation (older cache, or a region without data —
   * coverage varies, so the UI shows NOTHING rather than a guess).
   */
  maxspeedKph: Array<number | null> | null;
}

const TOKEN = process.env.EXPO_PUBLIC_MAPBOX_TOKEN || '';

export function hasDirectionsToken(): boolean {
  return TOKEN.startsWith('pk.');
}

// ─── Geo math ────────────────────────────────────────────────────────────────
const R_EARTH_M = 6371000;
const toRad = (d: number): number => (d * Math.PI) / 180;

/** Great-circle distance between two points, in metres. */
export function haversineM(a: LngLat, b: LngLat): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Index of the route vertex nearest to `p` (snaps the guard onto the line). */
export function nearestIndexOnRoute(coords: LngLat[], p: LngLat): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = haversineM(coords[i], p);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/**
 * Perpendicular distance from `p` to a segment a→b, in metres (planar approx —
 * accurate to well under a metre at city scale). Used for the off-route gauge so
 * a fix that sits ON a long straight road (sparse vertices) doesn't read as a
 * large deviation just because the nearest *vertex* is far.
 */
function pointToSegmentM(p: LngLat, a: LngLat, b: LngLat): number {
  const mPerDegLat = 111320;
  const mPerDegLng = 111320 * Math.cos(toRad(a.lat));
  const bx = (b.lng - a.lng) * mPerDegLng;
  const by = (b.lat - a.lat) * mPerDegLat;
  const px = (p.lng - a.lng) * mPerDegLng;
  const py = (p.lat - a.lat) * mPerDegLat;
  const len2 = bx * bx + by * by;
  let t = len2 === 0 ? 0 : (px * bx + py * by) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = t * bx;
  const cy = t * by;
  return Math.hypot(px - cx, py - cy);
}

/** Distance from `p` to the nearest route SEGMENT — the deviation / off-route gauge. */
export function offRouteDistanceM(coords: LngLat[], p: LngLat): number {
  if (coords.length === 0) {
    return Infinity;
  }
  if (coords.length === 1) {
    return haversineM(coords[0], p);
  }
  let best = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const d = pointToSegmentM(p, coords[i - 1], coords[i]);
    if (d < best) {
      best = d;
    }
  }
  return best;
}

/**
 * Metres remaining from the guard's snapped position to the end of the route —
 * drives a live, counting-down ETA (durationS scaled by remaining/total) instead
 * of always showing the full original trip duration.
 */
export function remainingRouteM(coords: LngLat[], p: LngLat): number {
  if (coords.length < 2) {
    return 0;
  }
  const idx = nearestIndexOnRoute(coords, p);
  const nextIdx = Math.min(idx + 1, coords.length - 1);
  let rem = haversineM(p, coords[nextIdx]);
  for (let i = nextIdx + 1; i < coords.length; i++) {
    rem += haversineM(coords[i - 1], coords[i]);
  }
  return rem;
}

/**
 * Split the route at the guard's current progress. Everything up to (and
 * including) the nearest vertex is "traveled"; the rest — with the guard's own
 * fix spliced on the front so the ahead-line starts at the dot — is "remaining."
 */
export function splitRouteAtProgress(
  coords: LngLat[],
  p: LngLat,
): {traveled: LngLat[]; remaining: LngLat[]} {
  if (coords.length < 2) {
    return {traveled: [], remaining: coords.slice()};
  }
  const idx = nearestIndexOnRoute(coords, p);
  const traveled = coords.slice(0, idx + 1);
  const tail = coords.slice(idx + 1);
  const remaining =
    tail.length >= 1 ? [p, ...tail] : [p, coords[coords.length - 1]];
  return {traveled, remaining};
}

/**
 * The next maneuver the guard hasn't reached yet, with the live distance to it.
 * Picks the first step whose maneuver vertex is still ahead of the guard,
 * falling back to the final (arrival) step. Returns null when there are no steps.
 */
/**
 * Each step's vertex index on the route, computed once per route object.
 *
 * Why: resolving them inline made nextManeuver O(steps x vertices) — on a
 * 40-step, 1200-vertex leg that is ~48k great-circle calculations, and it now
 * runs on every GPS fix (1 Hz) rather than every server poll. The route object
 * is replaced wholesale on each fetch, so a WeakMap keyed on it is
 * self-invalidating and cannot go stale.
 */
const stepIndexCache = new WeakMap<DirectionsRoute, number[]>();

function stepVertexIndices(route: DirectionsRoute): number[] {
  const cached = stepIndexCache.get(route);
  if (cached) {
    return cached;
  }
  const idx = route.steps.map(s => nearestIndexOnRoute(route.coordinates, s.location));
  stepIndexCache.set(route, idx);
  return idx;
}

export function nextManeuver(
  route: DirectionsRoute,
  p: LngLat,
): {step: DirectionStep; distanceM: number; index: number} | null {
  const {steps, coordinates} = route;
  if (steps.length === 0) {
    return null;
  }
  const guardIdx = nearestIndexOnRoute(coordinates, p);
  const stepIdxs = stepVertexIndices(route);
  for (let i = 0; i < steps.length; i++) {
    const stepIdx = stepIdxs[i];
    // A step is "ahead" once its maneuver vertex is at OR beyond the guard —
    // ">=" keeps the turn shown while the guard is standing on it ("turn now"),
    // which is exactly when the instruction matters most. The arrival step is
    // always eligible so we never strand on a passed turn.
    if (stepIdx >= guardIdx || steps[i].maneuverType === 'arrive') {
      return {step: steps[i], distanceM: haversineM(p, steps[i].location), index: i};
    }
  }
  const last = steps[steps.length - 1];
  return {step: last, distanceM: haversineM(p, last.location), index: steps.length - 1};
}

/**
 * Legal speed limit (km/h) at the driver's current position, or null when the
 * route carries no annotation or the limit here is unknown. Segment i covers
 * coordinates[i]→[i+1]; the nearest-vertex index is within one segment of the
 * truth, which is inside the annotation's own granularity.
 */
export function speedLimitAtKph(route: DirectionsRoute, p: LngLat): number | null {
  const arr = route.maxspeedKph;
  if (!arr || arr.length === 0) {return null;}
  const idx = Math.min(nearestIndexOnRoute(route.coordinates, p), arr.length - 1);
  return arr[idx] ?? null;
}

/**
 * The road the driver is ON right now — the big road-name display
 * (Navigation.docx). Each step travels ALONG its own `roadName` and BEGINS
 * with the maneuver that turns onto it, so while the UPCOMING maneuver is
 * step k's, the vehicle is still on step k-1's road.
 */
export function currentRoadName(route: DirectionsRoute, nextManeuverIndex: number): string | null {
  const {steps} = route;
  if (steps.length === 0) {return null;}
  const i = Math.max(0, Math.min(nextManeuverIndex - 1, steps.length - 1));
  return steps[i].roadName ?? steps[Math.min(nextManeuverIndex, steps.length - 1)].roadName ?? null;
}

/** "200 m" / "1.2 km" — the Google-Maps distance-to-next-turn label. */
export function formatDistance(m: number): string {
  if (!Number.isFinite(m) || m <= 0) {
    return '0 m';
  }
  if (m < 1000) {
    // Round to the nearest 10 m so the label doesn't jitter every fix.
    return `${Math.round(m / 10) * 10} m`;
  }
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

// ─── Parsing + fetch ───────────────────────────────────────────────────────────

interface RawManeuver {
  type?: string;
  modifier?: string;
  instruction?: string;
  location?: [number, number];
}
interface RawBanner {
  primary?: {text?: string};
  secondary?: {text?: string} | null;
}
interface RawVoice {
  distanceAlongGeometry?: number;
  announcement?: string;
}
interface RawStep {
  maneuver?: RawManeuver;
  distance?: number;
  name?: string;
  bannerInstructions?: RawBanner[];
  voiceInstructions?: RawVoice[];
}
interface RawMaxspeed {
  speed?: number;
  unit?: string; // 'km/h' | 'mph'
  unknown?: boolean;
  none?: boolean; // legally unlimited (rare) — we show nothing
}
interface RawRoute {
  distance?: number;
  duration?: number;
  geometry?: {coordinates?: [number, number][]};
  legs?: Array<{steps?: RawStep[]; annotation?: {maxspeed?: RawMaxspeed[]}}>;
}

/** One annotation entry → km/h, or null for unknown/none/junk. */
function maxspeedEntryKph(e: RawMaxspeed | undefined): number | null {
  if (!e || e.unknown === true || e.none === true) {return null;}
  const v = e.speed;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {return null;}
  return e.unit === 'mph' ? Math.round(v * 1.60934) : Math.round(v);
}

/** Map one raw Directions `routes[i]` object into our DirectionsRoute shape. */
export function parseDirectionsRoute(route: RawRoute): DirectionsRoute | null {
  const coords = route?.geometry?.coordinates;
  if (!coords || coords.length < 2) {
    return null;
  }
  const coordinates: LngLat[] = coords.map(([lng, lat]) => ({lng, lat}));
  const rawSteps = route.legs?.[0]?.steps ?? [];
  const steps: DirectionStep[] = rawSteps
    .filter((s): s is RawStep & {maneuver: RawManeuver & {location: [number, number]}} =>
      Array.isArray(s?.maneuver?.location),
    )
    .map(s => {
      const banner = s.bannerInstructions?.[0];
      const instruction = s.maneuver.instruction ?? '';
      const voice: VoiceCue[] = (s.voiceInstructions ?? [])
        .filter((v): v is RawVoice & {announcement: string} => !!v?.announcement)
        .map(v => ({
          distanceAlongGeometryM: v.distanceAlongGeometry ?? 0,
          announcement: v.announcement,
        }))
        // Far → near, so the first cue whose distance is still ahead is the
        // one to speak next.
        .sort((a, b) => b.distanceAlongGeometryM - a.distanceAlongGeometryM);
      return {
        instruction,
        bannerPrimary: banner?.primary?.text ?? instruction,
        bannerSecondary: banner?.secondary?.text ?? null,
        maneuverType: s.maneuver.type ?? 'continue',
        modifier: s.maneuver.modifier ?? null,
        distanceM: s.distance ?? 0,
        location: {lng: s.maneuver.location[0], lat: s.maneuver.location[1]},
        roadName: s.name?.trim() ? s.name.trim() : null,
        voice,
      };
    });
  // Maxspeed rides per-leg; our requests are two-point (single leg) but concat
  // defensively so a future multi-stop request stays aligned with coordinates.
  const rawMax = (route.legs ?? []).flatMap(l => l.annotation?.maxspeed ?? []);
  const maxspeedKph = rawMax.length > 0 ? rawMax.map(maxspeedEntryKph) : null;
  return {
    coordinates,
    distanceM: route.distance ?? 0,
    durationS: route.duration ?? 0,
    steps,
    maxspeedKph,
  };
}

/**
 * Fetch a turn-by-turn route from `from` to `to`. Returns null when the token is
 * missing, the request fails, or no route is found — the caller then keeps its
 * last route and shows "navigation unavailable" rather than blanking the map.
 */
export async function fetchDirections(
  from: LngLat,
  to: LngLat,
  opts: {profile?: DirectionsProfile; signal?: AbortSignal} = {},
): Promise<DirectionsRoute | null> {
  if (!hasDirectionsToken()) {
    return null;
  }
  // Why: driving-traffic makes ETAs congestion-aware (audit M-5); callers can
  // still pass plain 'driving' for cost-sensitive, non-ETA uses.
  const profile = opts.profile ?? 'driving-traffic';
  const pair = `${from.lng.toFixed(6)},${from.lat.toFixed(6)};${to.lng.toFixed(6)},${to.lat.toFixed(6)}`;
  // Why: voice_instructions gives us Mapbox's own driving phrasing and the
  // distance-before-the-turn at which each line should be spoken, so the app
  // never has to invent announcement timing. language=en keeps the UAE
  // interface in English (place names come back transliterated rather than as
  // the Arabic-script strings the founder flagged on the route timeline).
  // annotations=maxspeed — the legal-limit chip (Navigation.docx). Same
  // response, no extra request; regions without data return `unknown` slots
  // and the chip simply doesn't render there.
  const url =
    `https://api.mapbox.com/directions/v5/mapbox/${profile}/${pair}` +
    '?steps=true&overview=full&geometries=geojson&banner_instructions=true' +
    '&voice_instructions=true&voice_units=metric&language=en' +
    '&annotations=maxspeed' +
    `&access_token=${encodeURIComponent(TOKEN)}`;
  try {
    const res = await fetch(url, {signal: opts.signal});
    if (!res.ok) {
      return null;
    }
    const json = (await res.json()) as {routes?: RawRoute[]};
    const route = json?.routes?.[0];
    return route ? parseDirectionsRoute(route) : null;
  } catch {
    // Network error / aborted — caller keeps the last good route.
    return null;
  }
}
