/**
 * Native Mapbox SDK bootstrap — the ONE place the native map is configured.
 *
 * The WebView maps set `mapboxgl.accessToken` inside their own generated HTML.
 * The native SDK instead needs the token handed to the module once, before any
 * MapView mounts, so this module is imported for effect from the map component
 * rather than exporting a function nobody remembers to call.
 *
 * Token split (they are NOT interchangeable):
 *   EXPO_PUBLIC_MAPBOX_TOKEN  public `pk.` — runtime tile requests. Used here.
 *   MAPBOX_DOWNLOADS_TOKEN    secret `sk.` — BUILD time only, fetches the
 *                             Android artifacts. Lives in the environment and
 *                             is read by app.config.js. It must never reach the
 *                             bundle, so it is deliberately absent from this file.
 *
 * Telemetry is disabled: this app tracks close-protection officers on live
 * missions, and their position stream is not Mapbox's to collect.
 */
import Mapbox from '@rnmapbox/maps';

import {MAPBOX_TOKEN, MAPBOX_TOKEN_MISSING} from './mapToken';

/**
 * Which renderer the mission map uses. Both ship in the same binary.
 *
 * The native SDK is now the DEFAULT (founder call, 2026-08-24): every build
 * gets the native mission map unless EXPO_PUBLIC_NATIVE_MAP=0 is baked in —
 * the WebView path stays in the binary purely as the emergency escape hatch.
 */
export const NATIVE_MAP_ENABLED: boolean =
  (process.env.EXPO_PUBLIC_NATIVE_MAP ?? '') !== '0';

let configured = false;

/**
 * Idempotent. Safe to call from every map mount — the SDK keeps the token as
 * module state, and re-setting it on each mount would be a needless native
 * round trip.
 *
 * Returns false when the build has no token baked in, which is the same
 * condition `MAPBOX_TOKEN_MISSING` already gates the WebView maps on. Callers
 * render their existing "map unavailable" surface rather than a blank canvas.
 */
export function ensureNativeMapboxConfigured(): boolean {
  if (MAPBOX_TOKEN_MISSING || !MAPBOX_TOKEN) {
    return false;
  }
  if (configured) {
    return true;
  }
  // setAccessToken is async (Promise<string | null>); setTelemetryEnabled is not.
  // Why swallow: a rejected token set just leaves the map unable to fetch
  // tiles, which the surface already handles — and throwing out of a
  // render-phase call would take the whole screen down instead.
  Mapbox.setAccessToken(MAPBOX_TOKEN).catch(() => {});
  // Why: opt out before the first MapView, not after — the SDK starts its
  // telemetry queue on init.
  Mapbox.setTelemetryEnabled(false);
  configured = true;
  return true;
}

/** Test seam — lets a suite assert the guard without a native module loaded. */
export function __resetNativeMapboxForTests(): void {
  configured = false;
}
