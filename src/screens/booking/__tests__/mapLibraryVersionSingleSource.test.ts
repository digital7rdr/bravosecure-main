/**
 * B-645 — two Mapbox GL JS versions meant two cold downloads.
 *
 * Every WebView map in this app loads mapbox-gl from api.mapbox.com on open —
 * roughly a megabyte of JS plus the CSS, and it is the dominant share of a map's
 * time-to-ready. `MapPrewarm` (B-90 T-07) exists to put exactly those responses in
 * the WebView's shared HTTP cache, mounted from BookingHomeScreen and
 * AgentDashboardScreen so the real map boots warm.
 *
 * ProLiveMissionScreen and CpoProtectionSessionScreen pinned **v3.5.1** while every
 * other map used **v3.9.0**. A different URL is a different cache entry, so those two
 * screens could never be warmed by the prewarm and re-downloaded the whole library on
 * every open — the founder's "another map takes so much time for loading". Both only
 * ever used `accessToken` / `Map` / `Marker` / `LngLatBounds`, which are identical
 * across those versions, so the fork bought nothing.
 *
 * The invariant: ONE version across every map, or the cache is silently split again.
 * This is a static scan — the HTML lives in template literals inside RN screens.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const R = process.cwd();

/** Every file that embeds map HTML with a mapbox-gl <script>/<link>. */
const MAP_HTML_FILES = [
  ['src', 'modules', 'booking', 'bravoAgentTrackerMapHtml.ts'],
  ['src', 'modules', 'booking', 'bravoLiveRouteMapHtml.ts'],
  ['src', 'modules', 'booking', 'bravoLocationPickerMapHtml.ts'],
  ['src', 'modules', 'news', 'bravoMapHtml.ts'],
  ['src', 'screens', 'cpo', 'CpoProtectionSessionScreen.tsx'],
  ['src', 'screens', 'pro', 'ProLiveMissionScreen.tsx'],
  ['src', 'screens', 'vbg', 'vbgKeyPointsMapHtml.ts'],
].map(p => join(R, ...p));

const VERSION_RE = /mapbox-gl-js\/v(\d+\.\d+\.\d+)\//g;

function versionsIn(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(VERSION_RE)].map(m => m[1]);
}

describe('B-645 — every WebView map loads the SAME mapbox-gl build', () => {
  it('each map file actually references the library (the scan is not vacuous)', () => {
    for (const file of MAP_HTML_FILES) {
      expect(versionsIn(file).length).toBeGreaterThan(0);
    }
  });

  it('there is exactly ONE version across all of them', () => {
    const all = MAP_HTML_FILES.flatMap(versionsIn);
    const distinct = [...new Set(all)];
    // A second version splits the WebView HTTP cache, so MapPrewarm can only ever
    // warm one of them and the other pays a full cold download on every open.
    expect(distinct).toHaveLength(1);
  });

  it('the CSS and the JS are pinned to that same version in every file', () => {
    for (const file of MAP_HTML_FILES) {
      const src = readFileSync(file, 'utf8');
      const css = [...src.matchAll(/mapbox-gl-js\/v(\d+\.\d+\.\d+)\/mapbox-gl\.css/g)].map(m => m[1]);
      const js  = [...src.matchAll(/mapbox-gl-js\/v(\d+\.\d+\.\d+)\/mapbox-gl\.js/g)].map(m => m[1]);
      expect(js.length).toBeGreaterThan(0);
      for (const v of [...css, ...js]) {
        expect(v).toBe(js[0]);
      }
    }
  });
});
