/**
 * B-656 — render-cost invariants for the Bravo Feed (Intel) screen.
 *
 * ── WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT ────────────────────
 * The founder reported this screen as laggy on 2026-08-24. Three auditors and
 * an adjudication pass concluded the honest answer is:
 *
 *   • The RN-side costs below are REAL but SMALL (~1-3 ms/s of JS). They are
 *     hygiene, not the cure. A prior audit (docs/audits/MAPBOX_AUDIT.md:176)
 *     had already graded the 1 Hz clock "cheap but pointless churn".
 *   • The likely dominant cost is the map WebView compositing continuously
 *     (per-marker infinite CSS animations + backdrop-filter blurs over a live
 *     WebGL globe) — which `dumpsys gfxinfo` CANNOT observe, because Android
 *     WebView composites in a separate renderer process.
 *
 * The first pass shipped only the free-either-way changes and HELD the visual
 * ones, because CLAUDE.md forbids paying design cost on an unmeasured
 * hypothesis. The founder was told that plainly — including that the safe fixes
 * probably would not be felt — and answered "fix both the js and webview side".
 *
 * So the held items shipped too, and the assertions covering them are now
 * REVERSED (see "the per-frame compositor costs are GONE"). They remain
 * UNMEASURED. If a device trace later shows they were not the cost, the honest
 * move is to restore the design, not to keep a change that bought nothing.
 *
 * Full reasoning: docs/audits/INTEL_FEED_LAG_AUDIT_2026-08-24.md
 *
 * ⚠️ SOURCE SCAN. These files are CRLF — normalised to `\n` before scanning, or
 * a `\n`-anchored regex matches nothing and passes VACUOUSLY. Comments are
 * stripped before every absence assertion, because the docblocks in both files
 * quote the very tokens under test.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'news', 'IntelFeedScreen.tsx');
const MAP_HTML = join(process.cwd(), 'src', 'modules', 'news', 'bravoMapHtml.ts');

function rawOf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Line-based comment stripper. A naive `/\/\*[\s\S]*?\*\//g` is unsafe here: a
 * `/*` inside a string or JSX literal pairs with the wrong delimiter and eats
 * real code, which would make every absence assertion below pass vacuously.
 * A block comment is recognised only when its opener is the first non-space on
 * the line (allowing a leading `{` for JSX comments).
 */
function codeOf(path: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of rawOf(path).split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');
    const open = line.indexOf('/*');
    if (open !== -1 && /^\{?$/.test(line.slice(0, open).trim())) {
      const end = line.indexOf('*/', open + 2);
      if (end === -1) { inBlock = true; out.push(line.slice(0, open)); continue; }
      line = line.slice(0, open) + line.slice(end + 2);
    }
    const lc = line.indexOf('//');
    if (lc !== -1 && !/https?:$/.test(line.slice(0, lc))) { line = line.slice(0, lc); }
    out.push(line);
  }
  return out.join('\n');
}

describe('the scan is not vacuous', () => {
  it('reads both real files and the stripper does not swallow them', () => {
    for (const p of [SCREEN, MAP_HTML]) {
      const raw = rawOf(p);
      const code = codeOf(p);
      expect(raw.length).toBeGreaterThan(5_000);
      expect(code.length).toBeGreaterThan(raw.length * 0.4);
    }
    expect(codeOf(SCREEN)).toContain('export default function IntelFeedScreen()');
    expect(codeOf(MAP_HTML)).toContain('export function buildBravoMapHtml(');
  });
});

describe('B-656 — the 1 Hz clock does not re-render the screen', () => {
  it('the interval lives in its own component, not the screen body', () => {
    const code = codeOf(SCREEN);
    expect(code).toMatch(/const UtcClock = React\.memo\(/);
    expect(code).toMatch(/<UtcClock \/>/);
    // The regression: clock state at the screen root. `time`/`setTime` there
    // re-rendered all 800 lines once per second, forever.
    expect(code).not.toMatch(/\bsetTime\b/);
    expect(code).not.toMatch(/\[time, setTime\]/);
  });

  it('the screen body declares no setInterval of its own', () => {
    // Any interval added back at the screen root re-opens this exact bug.
    const code = codeOf(SCREEN);
    const bodyStart = code.indexOf('export default function IntelFeedScreen()');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(code.slice(bodyStart)).not.toMatch(/setInterval\(/);
  });
});

describe('B-656 — the scanline overlay is built once', () => {
  it('is a module-level constant element, not inline JSX', () => {
    const code = codeOf(SCREEN);
    expect(code).toMatch(/^const SCANLINE_OVERLAY = \(/m);
    expect(code).toMatch(/\{SCANLINE_OVERLAY\}/);
    // Exactly ONE construction site — the constant. A second `Array.from`
    // means it went back into the render body.
    expect(code.match(/Array\.from\(\{length: 220\}\)/g) ?? []).toHaveLength(1);
  });

  it('is NOT deleted — the tint is deliberate design', () => {
    // CLAUDE.md's lag section: deleting visual effects "costs the design and
    // buys nothing" without a measurement. Hoisting is the free win; removal
    // is not, and no device number justifying it exists.
    const code = codeOf(SCREEN);
    expect(code).toMatch(/scanlineOverlay:/);
    expect(code).toMatch(/scanline:/);
  });

  it('the constant is declared BELOW styles (temporal dead zone)', () => {
    // It dereferences `styles.*` at module-evaluation time, so declaring it
    // above `const styles = ...` is a ReferenceError at import — a crash, not
    // a lint nit. This ordering is load-bearing.
    const code = codeOf(SCREEN);
    expect(code.indexOf('const styles = StyleSheet.create'))
      .toBeLessThan(code.indexOf('const SCANLINE_OVERLAY'));
  });
});

describe('B-656 — the marker payload handed to the WebView is bounded', () => {
  it('caps at the render boundary, and sorts so CRITICAL survives the cut', () => {
    const code = codeOf(SCREEN);
    expect(code).toMatch(/const MAX_MAP_MARKERS = \d+/);
    expect(code).toMatch(/\.slice\(0, MAX_MAP_MARKERS\)/);
    // Severity-ranked before slicing — an unsorted cap could drop a CRITICAL
    // marker and keep a LOW one.
    expect(code).toMatch(/CRITICAL: 0/);
  });

  it('does NOT cap `clusters` itself', () => {
    /**
     * `clusters` also feeds the LOCATED stat and `regionHits` (the drawer's
     * per-region headline list). Slicing it would make a bubble read "2" while
     * its drawer listed 5 — the count-mismatch class fixed on 2026-07-31.
     * Only the WebView payload is trimmed.
     */
    const code = codeOf(SCREEN);
    expect(code).toMatch(/const clusters = useMemo\(\(\) => clusterMarkers\(mapMarkers\), \[mapMarkers\]\)/);
  });
});

describe('B-656 — a hidden map stops animating', () => {
  it('the page exposes an idle switch and pauses the radar rings', () => {
    const html = codeOf(MAP_HTML);
    expect(html).toMatch(/window\.setMapActive = function/);
    expect(html).toMatch(/body\.idle \.threat \.ring2 \{ animation-play-state: paused; \}/);
  });

  it('the screen drives it from the active tab AND re-applies it on boot', () => {
    const code = codeOf(SCREEN);
    expect(code).toMatch(/const mapActive = activeTab === 'map'/);
    expect(code).toMatch(/window\.setMapActive && window\.setMapActive\(\$\{mapActive\}\)/);
    // On first boot `mapReady` is false, so the effect is skipped — the ready
    // handler must re-apply it or a page finishing load while the user is on
    // another tab comes up ANIMATING behind a transparent surface.
    expect(code).toMatch(/window\.setMapActive\(\$\{activeTab === 'map'\}\)/);
  });

  it('the per-frame compositor costs are GONE (founder-approved, 2026-08-24)', () => {
    /**
     * ⚠️ THIS ASSERTION IS THE REVERSE OF WHAT IT SAID EARLIER THE SAME DAY.
     *
     * The first pass held these back: they are VISIBLE changes, and CLAUDE.md's
     * lag section forbids paying design cost on an unmeasured hypothesis. The
     * founder was told exactly that — that the safe fixes probably would not be
     * felt, and that only these would — and instructed "fix both the js and
     * webview side". That is the decision, so they shipped.
     *
     * What went, and why each was a PER-FRAME cost over a live WebGL canvas:
     *   • `mix-blend-mode: screen` on a VIEWPORT-SIZED .crosshair — forced the
     *     compositor to keep the GL canvas readable and blend it every frame.
     *   • `backdrop-filter` on .threat .badge — one backdrop readback PER
     *     MARKER per frame, sampling a region that contained the animating ring.
     *   • `backdrop-filter` on .hud-corner and the three .zoom-btn.
     *
     * STILL UNMEASURED. If a device trace ever shows these were not the cost,
     * the honest move is to restore the design, not to keep a change that
     * bought nothing.
     */
    const html = codeOf(MAP_HTML);
    expect(html).not.toMatch(/backdrop-filter/);
    expect(html).not.toMatch(/mix-blend-mode/);
  });

  it('the radar pulse is opt-in, so a resting map has no frame source', () => {
    // Every marker used to animate infinitely, so the compositor could never
    // idle. Now only CRITICAL/HIGH carry `.pulse` — which also makes the
    // animation carry meaning rather than being uniform decoration.
    const html = codeOf(MAP_HTML);
    expect(html).toMatch(/\.threat \.ring2\.pulse \{ animation: radar/);
    // The bare .ring2 rule must NOT animate, or the opt-in is decorative.
    expect(html).toMatch(/\.threat \.ring2 \{[^}]*\}/);
    const bare = html.match(/\.threat \.ring2 \{[^}]*\}/)?.[0] ?? '';
    expect(bare).not.toMatch(/animation:/);
  });

  it('markers are RECONCILED, not torn down and rebuilt on every push', () => {
    // `clearMarkers()` + full innerHTML rebuild ran at least twice per feed
    // load and restarted every pulse from zero.
    const html = codeOf(MAP_HTML);
    expect(html).toMatch(/markerByKey/);
    expect(html).not.toMatch(/clearMarkers/);
  });

  it('only PRE-LOAD map errors cross the bridge', () => {
    // Mapbox GL fires `error` for recoverable tile 404s; posting each one was
    // unbounded bridge traffic during exactly the pan that was struggling.
    const html = codeOf(MAP_HTML);
    expect(html).toMatch(/if \(loaded\) \{ return; \}/);
  });
});

describe('B-656 — a fatal map error reaches the watchdog', () => {
  it('handleMapMessage escalates a PRE-LOAD error via onError', () => {
    /**
     * `useMapReload` exports `onError` documented for exactly this, and nothing
     * called it — so `gl-unsupported` was parsed and dropped, leaving a blank
     * map for the full 15 s watchdog timeout.
     */
    const code = codeOf(SCREEN);
    expect(code).toMatch(/mapHealth\.onError\(\)/);
  });

  it('but only BEFORE ready — tile 404s must not reload a working map', () => {
    // Mapbox GL fires `error` for recoverable tile failures too. Escalating
    // those would reboot a healthy map whenever one tile failed.
    const code = codeOf(SCREEN);
    expect(code).toMatch(/msg\.type === 'error' && !mapReady\.current/);
  });
});

describe('B-656 — the JS side: nothing rebuilds per render that need not', () => {
  it('the wire list is virtualised with a memoised row', () => {
    // Was a plain ScrollView + .map() mounting ~60 rows synchronously on the
    // BRAVO FEED tap — the "stuck for a couple of seconds" tab switch.
    const code = codeOf(SCREEN);
    expect(code).toMatch(/<FlatList/);
    expect(code).toMatch(/const WireRow = React\.memo\(/);
    expect(code).toMatch(/data=\{filteredWire\}/);
    expect(code).not.toMatch(/filteredWire\.map\(/);
  });

  it('every wire FlatList prop is a stable reference', () => {
    // FlatList is a PureComponent; one fresh prop re-renders the whole window.
    const code = codeOf(SCREEN);
    expect(code).toMatch(/^const wireKeyExtractor = /m);
    expect(code).toMatch(/keyExtractor=\{wireKeyExtractor\}/);
    expect(code).toMatch(/const renderWireRow = useCallback\(/);
    expect(code).toMatch(/const wireContentStyle = useMemo\(/);
    expect(code).not.toMatch(/contentContainerStyle=\{\{/);
  });

  it('the ticker rows are memoised — they are Animated.View children', () => {
    /**
     * RN's AnimatedProps memo retains arrays BY REFERENCE, so a fresh children
     * array per render built a new AnimatedProps node and tore down / re-attached
     * the live marquee's native animation. A bare IIFE in the render body did
     * exactly that.
     */
    const code = codeOf(SCREEN);
    expect(code).toMatch(/const tickerRows = useMemo\(/);
    expect(code).toMatch(/\{tickerRows\.map\(/);
  });

  it('the map stat row is one pass, memoised', () => {
    const code = codeOf(SCREEN);
    expect(code).toMatch(/const mapStats = useMemo\(/);
    expect(code).toMatch(/\{mapStats\.map\(/);
    // The regression: two full items.filter() scans inline in the render body.
    expect(code).not.toMatch(/items\.filter\(i => i\.priority === 'CRITICAL'\)/);
  });

  it('the feed clears mapExtras with a STABLE empty array', () => {
    /**
     * A fresh `[]` literal invalidated the whole downstream memo chain
     * (mapItems -> mapMarkers -> clusters -> threatsJs -> injectJavaScript), so
     * every feed load pushed a full marker payload whether or not anything had
     * changed. `useState` bails on Object.is, so a stable ref makes a redundant
     * clear free.
     */
    const feed = codeOf(join(process.cwd(), 'src', 'modules', 'news', 'useIntelFeed.ts'));
    expect(feed).toMatch(/const EMPTY_EXTRAS: IntelItem\[\] = \[\]/);
    expect(feed).not.toMatch(/setMapExtras\(\[\]\)/);
  });

  it('geotag precompiles its matchers instead of building RegExps per call', () => {
    // 98 `new RegExp` per un-geotagged item, inside a synchronous map over the
    // whole feed. One alternation per row replaces up to 5 with 0.
    const geo = codeOf(join(process.cwd(), 'src', 'modules', 'news', 'geotag.ts'));
    expect(geo).toMatch(/const GEO_MATCHERS/);
    expect(geo).toMatch(/for \(const \{re, row\} of GEO_MATCHERS\)/);
    expect(geo).not.toMatch(/if \(wordRe\(name\)\.test\(upper\)\)/);
  });
});
