/**
 * B-89 MG-04 — single source of truth for the Mapbox public token.
 *
 * The token is baked at BUNDLE time from EXPO_PUBLIC_MAPBOX_TOKEN. A build
 * where that env never reached `expo export:embed` (the eas `production`
 * profile had no env block; the apk scripts didn't pass it) used to render
 * `mapboxgl.accessToken=""` → 401 → the B-77 watchdog remounted the SAME
 * tokenless HTML forever — an infinite RETRY loop indistinguishable from
 * being offline. Map surfaces must check `MAPBOX_TOKEN_MISSING` and render
 * the misconfigured-build state INSTEAD of mounting a doomed WebView.
 */
export const MAPBOX_TOKEN: string = process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? '';

/** Mapbox public tokens are always `pk.`-prefixed; anything else is a bad bake. */
export const MAPBOX_TOKEN_MISSING: boolean = !MAPBOX_TOKEN.startsWith('pk.');

if (MAPBOX_TOKEN_MISSING) {
  // One loud boot breadcrumb (never the value): tells a log reader instantly
  // that every GL surface will be down because of the BUILD, not the network.
  console.error('[maps] EXPO_PUBLIC_MAPBOX_TOKEN missing/invalid at bundle time — map surfaces disabled (B-89 MG-04)');
}
