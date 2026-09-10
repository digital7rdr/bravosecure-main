import {Injectable, Logger} from '@nestjs/common';
import {fetchWithDeadline} from '../common/http/fetchWithDeadline';
import {TtlCache} from './ttlCache';

export interface RegionFix {
  /** Best human label for the area — city/place name, e.g. "Benoni". */
  region:  string;
  /** Broader context — region/country, e.g. "Gauteng, South Africa". */
  context: string;
  /** Two-letter country code when Mapbox supplies it. */
  country: string | null;
  lat:     number;
  lng:     number;
}

/**
 * Reverse-geocode a GPS fix → region name via Mapbox (existing token).
 *
 * Mirrors MapboxDirectionsService: reads the token from the same env
 * fallbacks and degrades gracefully (returns a coarse lat/lng label) when
 * no token is set or the API is unreachable, so VBG never hard-fails on a
 * geocode miss.
 *
 * Results are cached per ~1km grid cell for an hour — a principal moving
 * around a city shouldn't trigger a geocode on every heartbeat.
 */
@Injectable()
export class GeocodeService {
  private readonly log = new Logger(GeocodeService.name);
  private readonly token: string | undefined =
    process.env.MAPBOX_ACCESS_TOKEN
    ?? process.env.NEXT_PUBLIC_MAPBOX_TOKEN
    ?? process.env.EXPO_PUBLIC_MAPBOX_TOKEN;

  private static readonly TTL_MS = 60 * 60 * 1000;
  // Bounded (audit M-7) — 1km grid cells accumulate as principals move.
  private readonly cache = new TtlCache<RegionFix>(GeocodeService.TTL_MS, 500);

  async reverse(lat: number, lng: number): Promise<RegionFix> {
    const fallback: RegionFix = {
      region:  `${lat.toFixed(2)}, ${lng.toFixed(2)}`,
      context: 'Unknown area',
      country: null,
      lat, lng,
    };
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {return fallback;}

    // Cache key snaps to ~1km so nearby fixes share a result.
    const key = `${lat.toFixed(2)},${lng.toFixed(2)}`;
    const hit = this.cache.get(key);
    if (hit) {return hit;}

    if (!this.token) {return fallback;}

    try {
      const url =
        `https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json` +
        `?types=place,region,district,locality&limit=1&access_token=${this.token}`;
      const res = await fetchWithDeadline(url, {method: 'GET', deadlineMs: 5_000}); // Audit Rev2 API-05
      if (!res.ok) {
        this.log.warn(`Mapbox geocode ${res.status}`);
        return fallback;
      }
      const body = await res.json() as {
        features?: Array<{
          text?: string;
          place_name?: string;
          context?: Array<{id: string; short_code?: string; text?: string}>;
        }>;
      };
      const f = body.features?.[0];
      if (!f) {return fallback;}
      const countryCtx = f.context?.find(c => c.id?.startsWith('country'));
      const value: RegionFix = {
        region:  f.text ?? fallback.region,
        context: f.place_name ?? fallback.context,
        country: countryCtx?.short_code?.toUpperCase() ?? null,
        lat, lng,
      };
      this.cache.set(key, value);
      return value;
    } catch (e) {
      this.log.warn(`Mapbox geocode failed: ${(e as Error).message}`);
      return fallback;
    }
  }
}
