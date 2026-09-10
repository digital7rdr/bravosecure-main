/**
 * Expo config — app.json plus the pieces that must read the environment.
 *
 * Why this file exists: `app.json` is static JSON and cannot read env vars, and
 * the Mapbox native SDK needs a SECRET download token (an `sk.` token with the
 * DOWNLOADS:READ scope) at BUILD time to fetch the Android artifacts. That
 * token must never be committed, so it is supplied through the environment:
 *
 *   Windows (PowerShell):  $env:MAPBOX_DOWNLOADS_TOKEN = "sk.…"
 *   macOS / Linux:         export MAPBOX_DOWNLOADS_TOKEN="sk.…"
 *   EAS:                   eas secret:create --name MAPBOX_DOWNLOADS_TOKEN
 *
 * This is NOT the same token as EXPO_PUBLIC_MAPBOX_TOKEN (see
 * src/modules/maps/mapToken.ts) — that one is the public `pk.` token baked into
 * the bundle for tile requests, and it stays exactly as it is.
 *
 * The plugin is registered ONLY when the token is present. Without it the
 * Android build would fail at dependency resolution, so an absent token leaves
 * the app configured exactly as it is today (WebView maps, no native SDK)
 * rather than breaking a build that works.
 */
const {expo} = require('./app.json');

const downloadToken = process.env.MAPBOX_DOWNLOADS_TOKEN;

const mapboxPlugin = downloadToken
  ? [['@rnmapbox/maps', {RNMapboxMapsDownloadToken: downloadToken}]]
  : [];

module.exports = () => ({
  ...expo,
  plugins: [...(expo.plugins ?? []), ...mapboxPlugin],
});
