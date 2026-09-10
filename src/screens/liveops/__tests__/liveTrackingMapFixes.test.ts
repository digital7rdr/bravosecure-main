/**
 * B-214 — founder QA on the B-213 map-expand feature: expanding the map
 * showed a DIFFERENT COUNTRY (Dubai) instead of the actual mission
 * location, and the road-following route degraded to a straight line.
 *
 * Root cause: the fullscreen Modal mounts a BRAND NEW WebView that boots
 * from buildLiveRouteHtml's hardcoded default center (Dubai,
 * [55.2708, 25.2048]) until it gets its first live push. useMapReload's
 * `status` is driven only by explicit onReady()/onError() calls, not by
 * "a new WebView mounted" — since it was already 'ready' from the
 * collapsed box's WebView, `webReady` never flips false→true again for
 * the new instance, so the webReady-gated push effects (setRoute AND
 * setNavRoute — the same effect pair, so BOTH the wrong-city marker AND
 * the straight-line-instead-of-road-route symptom share this one root
 * cause) never re-fire against it.
 *
 * Also: the client's own live position was pushed to the server (for
 * ops' /live view) but never drawn on the client's own map — added a
 * "you are here" marker (window.setSelf/clearSelf), reusing the existing
 * GPS watcher rather than adding a second one.
 *
 * Neither file can be imported by a node Jest project (WebView/Mapbox
 * native deps; the HTML template is plain string-building but its
 * companion screen can't be), so both are pinned by reading source.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'liveops', 'LiveTrackingScreen.tsx');
const HTML_TEMPLATE = join(process.cwd(), 'src', 'modules', 'booking', 'bravoLiveRouteMapHtml.ts');

function source(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('B-214 — map-expand no longer strands the push effects on stale webReady (static source scan)', () => {
  it('toggleMapExpanded calls map.retry() so webReady genuinely cycles for the new WebView', () => {
    const src = stripComments(source(SCREEN));
    const start = src.indexOf('const toggleMapExpanded = (next: boolean) => {');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('};', start);
    const body = src.slice(start, end);
    expect(body).toMatch(/setMapExpanded\(next\)/);
    expect(body).toMatch(/map\.retry\(\)/);
  });

  it('both the expand button and the collapse controls route through toggleMapExpanded, not setMapExpanded directly', () => {
    const src = stripComments(source(SCREEN));
    // No call site should bypass the helper with a literal true/false — that
    // would skip map.retry() and reintroduce the stale-webReady bug.
    expect(src).not.toMatch(/setMapExpanded\(true\)/);
    expect(src).not.toMatch(/setMapExpanded\(false\)/);
    expect(src).toMatch(/onPress=\{\(\) => toggleMapExpanded\(true\)\}/);
    expect(src).toMatch(/onPress=\{\(\) => toggleMapExpanded\(false\)\}/);
    expect(src).toMatch(/onRequestClose=\{\(\) => toggleMapExpanded\(false\)\}/);
  });
});

describe('B-214 — client sees their own live position on the map (static source scan)', () => {
  it('LiveTrackingScreen tracks selfPos from the existing GPS watcher (no second watcher)', () => {
    const src = stripComments(source(SCREEN));
    expect(src).toMatch(/const \[selfPos, setSelfPos\] = useState/);
    expect(src).toMatch(/setSelfPos\(\{lat: pos\.coords\.latitude, lng: pos\.coords\.longitude\}\)/);
    // Exactly one Geolocation.watchPosition call — selfPos must not add a second watcher.
    const watchCalls = (src.match(/Geolocation\.watchPosition\(/g) ?? []).length;
    expect(watchCalls).toBe(1);
  });

  it('pushes selfPos to window.setSelf/clearSelf via the same webReady-gated pattern as the other markers', () => {
    const src = stripComments(source(SCREEN));
    expect(src).toMatch(/window\.setSelf && window\.setSelf\(/);
    expect(src).toMatch(/window\.clearSelf && window\.clearSelf\(\)/);
  });

  it('the map HTML defines setSelf/clearSelf with a marker style distinct from the vehicle dot', () => {
    const src = stripComments(source(HTML_TEMPLATE));
    expect(src).toMatch(/window\.setSelf = function\(lng, lat\)/);
    expect(src).toMatch(/window\.clearSelf = function\(\)/);
    expect(src).toMatch(/\.self-dot \.pin/);
    // Distinct color from the vehicle dot's #1E88FF.
    const selfDotBlock = src.slice(src.indexOf('.self-dot .pin'), src.indexOf('.self-dot .pin') + 200);
    expect(selfDotBlock).not.toMatch(/#1E88FF/);
  });
});
