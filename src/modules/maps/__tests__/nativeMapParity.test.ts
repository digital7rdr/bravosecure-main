/**
 * The native Mapbox surface (BravoMap) vs the WebView map it will replace.
 *
 * During the migration the app has TWO map implementations, and the failure
 * mode of every incremental migration is silent drift: a screen moves to the
 * native surface and quietly loses a behaviour, or the two renderers disagree
 * about something the user can see. These pins make the disagreements loud.
 *
 * Source scan, not an import: BravoMap.tsx pulls in @rnmapbox/maps, whose
 * native module cannot load in the node `booking` project — the same reason
 * dockControls.test.ts and driverNavCamera.test.ts scan their screens.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const NATIVE = join(process.cwd(), 'src', 'modules', 'maps', 'BravoMap.tsx');
const BOOT = join(process.cwd(), 'src', 'modules', 'maps', 'nativeMapbox.ts');
const WEB = join(process.cwd(), 'src', 'modules', 'booking', 'bravoAgentTrackerMapHtml.ts');

/** CRLF-normalised, comments stripped — these files describe the migration in
 *  prose, which is the classic false positive in an absence assertion. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every mapbox:// style URL in a file, in order. */
function styleUrls(src: string): string[] {
  return (src.match(/mapbox:\/\/styles\/[A-Za-z0-9/\-.]+/g) ?? []).slice();
}

describe('native map parity — two implementations must not drift', () => {
  it('the four map styles resolve to the SAME urls on both surfaces', () => {
    // A screen that switches renderer must not also switch how the map LOOKS.
    const web = styleUrls(code(WEB));
    const native = styleUrls(code(NATIVE));
    expect(native.length).toBe(4);
    expect(new Set(native)).toEqual(new Set(web));
  });

  it('the style key set matches too, so setStyle(id) means the same thing', () => {
    const native = code(NATIVE);
    for (const key of ['dark', 'light', 'sat', "'3d'"]) {
      expect(native).toContain(key);
    }
    // An unknown id falls back to dark on BOTH surfaces rather than blanking.
    expect(native).toMatch(/STYLE_URL\[id\] \? id : 'dark'/);
  });

  it('null island is rejected before it can move a marker (MG-12)', () => {
    const native = code(NATIVE);
    // The WebView map has validLL for exactly this; the native one must not
    // regress it, or a bad payload teleports a CPO into the Atlantic.
    expect(native).toContain('function validLngLat(');
    expect(native).toMatch(/!\(lng === 0 && lat === 0\)/);
    expect(native).toMatch(/Number\.isFinite\(lng\)/);
    // ...and it must actually be CALLED on both position setters.
    expect(native).toMatch(/setCpo:[\s\S]{0,240}?validLngLat\(p\.lng, p\.lat\)/);
    expect(native).toMatch(/setPrincipal:[\s\S]{0,200}?validLngLat\(p\.lng, p\.lat\)/);
  });

  it('the chevron rule survives the port: direction only when known', () => {
    const native = code(NATIVE);
    // Same contract the WebView puck holds — an arrowhead pointing an
    // arbitrary way is worse than an honest dot.
    expect(native).toMatch(/puckRotation !== null \? styles\.chevron : styles\.dot/);
    // ...and the chevron is counter-rotated by the map's ACTUAL heading, the
    // WebView paintNavPuck rule — otherwise course-up applies rotation twice.
    expect(native).toMatch(/courseBearing - mapHeadingRef\.current/);
    // Course over ground comes from the shared, unit-tested module (seed →
    // move-gate → shortest-arc blend), fed on EVERY accepted fix — the
    // 1.0.252 build only seeded, so the camera never rotated.
    expect(native).toMatch(/courseRef\.current = advanceCourse\(courseRef\.current, \[p\.lng, p\.lat\], p\.heading_deg\)/);
  });

  it('the chase camera is a real driving camera, frozen the moment the user pans', () => {
    const native = code(NATIVE);
    // Zoom, pitch, rotation AND the lower-third padding are all driven while
    // following — centre alone is a map that trails the car north-up from
    // orbit, which is what 1.0.252 shipped.
    expect(native).toMatch(/zoomLevel=\{following \? \(courseUp \? NAV_ZOOM : NORTH_ZOOM\) : undefined\}/);
    expect(native).toMatch(/pitch=\{following \? \(courseUp \? NAV_PITCH : 0\) : undefined\}/);
    expect(native).toMatch(/heading=\{following \? \(courseUp \? courseBearing \?\? 0 : 0\) : undefined\}/);
    expect(native).toMatch(/paddingTop: Math\.round\(mapHeightPx \* NAV_OFFSET_FRAC\)/);
    // easeTo: consecutive fixes glide; the flyTo default swoops per fix.
    expect(native).toMatch(/animationMode="easeTo"/);
    // NAV_PITCH matches the WebView constant so the two renderers read alike.
    expect(native).toMatch(/const NAV_PITCH = 55/);
    expect(code(WEB)).toMatch(/NAV_PITCH = 55/);
    // Choosing an orientation re-arms follow on BOTH surfaces.
    expect(native).toMatch(/setNavCamera:[\s\S]{0,220}?setFollowing\(true\)/);
  });

  it('the former parity gaps are now REAL, not stubs', () => {
    const native = code(NATIVE);
    // These four were deliberately absent while the port was incomplete. Now
    // that they exist, the risk inverts: a no-op that type-checks is how a
    // feature disappears in a migration, so each must reach actual state.
    expect(native).toMatch(/pushBubble: p => setMarkerBubbles\(/);
    expect(native).toMatch(/pushSystem: p => setSystemBubbles\(/);
    expect(native).toMatch(/setAwaiting: on => setAwaitingState\(/);
    expect(native).toMatch(/setSysTopGuardState\(v\)/);
    // ...and each must be RENDERED, not just stored.
    expect(native).toContain('visibleSystem(systemBubbles)');
    expect(native).toContain('visibleForAnchor(markerBubbles, anchor)');
    expect(native).toContain('{awaiting && (');
    expect(native).toContain('{!following && (');
  });

  it('the guard actually positions the awaiting pill', () => {
    const native = code(NATIVE);
    // setSysTopGuard exists so RN can tell the map how much of its top the
    // maneuver banner covers. Storing it without consuming it is the silent
    // failure this pins.
    expect(native).toMatch(/top: sysTopGuard \+ \d+/);
  });

  it('one timer sweeps every bubble, not one timer per bubble', () => {
    const native = code(NATIVE);
    // The WebView map arms a setTimeout per push, which leaks a pending
    // callback for every bubble the user navigates away from.
    expect(native).toContain('nextExpiry(markerBubbles, systemBubbles)');
    expect(native).toContain('clearTimeout(t)');
    expect((native.match(/setTimeout\(/g) ?? []).length).toBe(1);
  });

  it('a user drag stops the camera following, and only the pill resumes it', () => {
    const native = code(NATIVE);
    expect(native).toMatch(/isGestureActive[\s\S]{0,80}?setFollowing\(false\)/);
    expect(native).toMatch(/onRecenter = useCallback\(\(\) => setFollowing\(true\)/);
    // A new fix must not yank the map back while the user is reading it.
    expect(native).toMatch(/following \? cpoAt \?\? undefined : undefined/);
  });
});

describe('native Mapbox bootstrap', () => {
  it('refuses to configure without a public token, like the WebView maps', () => {
    const boot = code(BOOT);
    expect(boot).toMatch(/if \(MAPBOX_TOKEN_MISSING \|\| !MAPBOX_TOKEN\) \{\s*return false;/);
  });

  it('disables telemetry BEFORE the first MapView can mount', () => {
    const boot = code(BOOT);
    const token = boot.indexOf('setAccessToken');
    const telemetry = boot.indexOf('setTelemetryEnabled(false)');
    const done = boot.indexOf('configured = true');
    expect(token).toBeGreaterThan(-1);
    expect(telemetry).toBeGreaterThan(token);
    // Ordering is the point: the SDK starts its telemetry queue on init, so
    // opting out after `configured` would be a tick too late. This app streams
    // close-protection officers' live positions.
    expect(done).toBeGreaterThan(telemetry);
  });

  it('is idempotent — a token re-set on every map mount is a native round trip', () => {
    const boot = code(BOOT);
    expect(boot).toMatch(/if \(configured\) \{\s*return true;/);
  });

  it('never reads the SECRET download token at runtime', () => {
    const boot = code(BOOT);
    const native = code(NATIVE);
    // MAPBOX_DOWNLOADS_TOKEN is build-time only (app.config.js). Reading it
    // here would bake an sk. credential into the JS bundle.
    expect(boot).not.toContain('process.env.MAPBOX_DOWNLOADS_TOKEN');
    expect(native).not.toContain('MAPBOX_DOWNLOADS_TOKEN');
  });
});
