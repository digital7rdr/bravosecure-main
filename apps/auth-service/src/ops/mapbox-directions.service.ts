import {Injectable, Logger} from '@nestjs/common';
import {fetchWithDeadline} from '../common/http/fetchWithDeadline';

/**
 * Thin wrapper around the Mapbox Directions API. Used at dispatch time to
 * precompute total route distance + duration + the encoded polyline so the
 * mobile lead app and the ops live map have a stable route reference, and
 * so the auto-checkpoint logic (50% / 80%) has a denominator.
 *
 * Falls back to a haversine straight-line estimate if the API is
 * unreachable or no token is configured — dispatch never fails because of
 * a Mapbox outage.
 */
@Injectable()
export class MapboxDirectionsService {
  private readonly log = new Logger(MapboxDirectionsService.name);
  private readonly token: string | undefined =
    process.env.MAPBOX_ACCESS_TOKEN
    ?? process.env.NEXT_PUBLIC_MAPBOX_TOKEN
    ?? process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

  async getRoute(
    pickup:  {lat: number; lng: number},
    dropoff: {lat: number; lng: number},
  ): Promise<{distance_m: number; duration_s: number; polyline: string | null}> {
    const all = await this.getRouteAlternatives(pickup, dropoff);
    return all[0] ?? this.straightLineFallback(pickup, dropoff);
  }

  /**
   * Returns the primary route plus up to 2 alternatives from Mapbox, used
   * by the ops-console RE-ROUTE picker so the admin can pick the road the
   * crew should follow. Each entry has a stable `key` (`primary | alt-1 |
   * alt-2`) for keying React lists.
   *
   * When Mapbox's `alternatives=true` returns fewer than 3 distinct routes
   * (common on dense city pairs — Mapbox filters alternatives that
   * overlap >50% with the primary), we synthesize the rest by forcing
   * the route through a via-point offset perpendicular to the corridor.
   * Two via-points are tried (one on each side of the straight line at
   * a tunable offset) and any route that's geometrically distinct from
   * what we already have is kept.
   */
  async getRouteAlternatives(
    pickup:  {lat: number; lng: number},
    dropoff: {lat: number; lng: number},
  ): Promise<Array<{key: string; distance_m: number; duration_s: number; polyline: string | null}>> {
    if (!this.token) {
      return [{key: 'primary', ...this.straightLineFallback(pickup, dropoff)}];
    }

    type Route = {distance_m: number; duration_s: number; polyline: string};
    const collected: Route[] = [];

    // 1) Primary + Mapbox-suggested alternatives.
    const primary = await this.fetchDirections([pickup, dropoff], true);
    for (const r of primary) {
      if (!this.isDuplicateRoute(r, collected)) collected.push(r);
      if (collected.length >= 3) break;
    }

    // 2) Synthesize via-point detours when Mapbox didn't give us enough.
    //    Offset the corridor midpoint perpendicular to the line by ~25%
    //    of the great-circle distance, capped to a sane urban range.
    if (collected.length < 3) {
      const distKm = haversineMeters(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng) / 1000;
      const offsetKm = Math.max(1.5, Math.min(6, distKm * 0.25));
      const mid     = midpoint(pickup, dropoff);
      const bearing = bearingDeg(pickup, dropoff);
      const candidates = [
        offsetByKm(mid, bearing + 90, offsetKm),
        offsetByKm(mid, bearing - 90, offsetKm),
      ];
      for (const via of candidates) {
        if (collected.length >= 3) break;
        const detour = await this.fetchDirections([pickup, via, dropoff], false);
        const r = detour[0];
        if (r && !this.isDuplicateRoute(r, collected)) collected.push(r);
      }
    }

    if (collected.length === 0) {
      return [{key: 'primary', ...this.straightLineFallback(pickup, dropoff)}];
    }

    return collected.slice(0, 3).map((r, i) => ({
      key:        i === 0 ? 'primary' : `alt-${i}`,
      distance_m: r.distance_m,
      duration_s: r.duration_s,
      polyline:   r.polyline,
    }));
  }

  /**
   * Single Mapbox Directions call. Returns 0+ routes — empty on any
   * non-2xx response or transport failure (the caller decides whether
   * to fall back to a straight-line stub).
   */
  private async fetchDirections(
    waypoints: Array<{lat: number; lng: number}>,
    alternatives: boolean,
  ): Promise<Array<{distance_m: number; duration_s: number; polyline: string}>> {
    if (!this.token) return [];
    const coords = waypoints.map(w => `${w.lng},${w.lat}`).join(';');
    const url =
      `https://api.mapbox.com/directions/v5/mapbox/driving/${coords}` +
      `?geometries=polyline6&overview=full&alternatives=${alternatives ? 'true' : 'false'}` +
      `&access_token=${this.token}`;
    try {
      const res = await fetchWithDeadline(url, {method: 'GET', deadlineMs: 5_000}); // Audit Rev2 API-05
      if (!res.ok) {
        this.log.warn(`Mapbox Directions ${res.status}: ${await res.text()}`);
        return [];
      }
      const body = await res.json() as {
        routes?: Array<{distance: number; duration: number; geometry: string}>;
      };
      return (body.routes ?? []).map(r => ({
        distance_m: Math.round(r.distance),
        duration_s: Math.round(r.duration),
        polyline:   r.geometry,
      }));
    } catch (e) {
      this.log.warn(`Mapbox call failed: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * Cheap dedupe — two routes count as duplicates when their distance
   * and duration are within ~5% (close enough that Mapbox almost
   * certainly produced near-identical geometry). This avoids decoding
   * polylines on every comparison; the via-point synthesis is the only
   * place this matters and via routes will deviate by at least a few
   * percent in either dimension.
   */
  private isDuplicateRoute(
    candidate: {distance_m: number; duration_s: number; polyline: string},
    pool: Array<{distance_m: number; duration_s: number; polyline: string}>,
  ): boolean {
    for (const r of pool) {
      if (candidate.polyline === r.polyline) return true;
      const distDelta = Math.abs(candidate.distance_m - r.distance_m) / Math.max(r.distance_m, 1);
      const durDelta  = Math.abs(candidate.duration_s - r.duration_s) / Math.max(r.duration_s, 1);
      if (distDelta < 0.05 && durDelta < 0.05) return true;
    }
    return false;
  }

  private straightLineFallback(
    pickup:  {lat: number; lng: number},
    dropoff: {lat: number; lng: number},
  ): {distance_m: number; duration_s: number; polyline: null} {
    const dist = haversineMeters(pickup.lat, pickup.lng, dropoff.lat, dropoff.lng);
    return {distance_m: Math.round(dist), duration_s: Math.round(dist / 13.9), polyline: null};
  }
}

export function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ─── Geometry helpers for synthetic via-point alternatives ───────────

function midpoint(
  a: {lat: number; lng: number},
  b: {lat: number; lng: number},
): {lat: number; lng: number} {
  // Spherical midpoint — fine for the city-scale offsets we care about.
  // (Linear-average mid is fine here too; we're not navigating poles.)
  return {lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2};
}

// Exported for MG-02 — MissionLeadService derives a bearing from the
// previous → current fix when the device reports no GPS course.
export function bearingDeg(
  a: {lat: number; lng: number},
  b: {lat: number; lng: number},
): number {
  const φ1 = (a.lat * Math.PI) / 180;
  const φ2 = (b.lat * Math.PI) / 180;
  const Δλ = ((b.lng - a.lng) * Math.PI) / 180;
  const y  = Math.sin(Δλ) * Math.cos(φ2);
  const x  = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function offsetByKm(
  origin: {lat: number; lng: number},
  bearing: number,
  km: number,
): {lat: number; lng: number} {
  const R = 6371; // km
  const δ = km / R;
  const θ = (bearing * Math.PI) / 180;
  const φ1 = (origin.lat * Math.PI) / 180;
  const λ1 = (origin.lng * Math.PI) / 180;
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
  );
  return {lat: (φ2 * 180) / Math.PI, lng: (((λ2 * 180) / Math.PI) + 540) % 360 - 180};
}
