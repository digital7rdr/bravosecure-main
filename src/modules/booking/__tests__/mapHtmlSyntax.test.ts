/**
 * Syntax gate for the Mapbox WebView payloads.
 *
 * Both map modules are ONE giant template literal, so TypeScript only ever
 * checks that the enclosing STRING is well formed — the JavaScript inside it is
 * not parsed by tsc, by ESLint, or by any other test. A syntax error there
 * therefore ships completely silently: the build is green, and the map simply
 * never initialises on the device.
 *
 * This parses each inline <script> with Babel — parsing only, never executing,
 * so the absence of mapboxgl/document under Jest is irrelevant — and also
 * guards the template-literal trap CLAUDE.md calls out for these files: a stray
 * "${" in the injected JS gets interpolated by TypeScript instead of reaching
 * the page. (The other trap — an unescaped backtick — already fails the
 * typecheck, since it terminates the literal and the rest of the file stops
 * being a string.)
 */
import {parse} from '@babel/parser';
import {buildAgentTrackerHtml} from '../bravoAgentTrackerMapHtml';
import {buildLiveRouteHtml} from '../bravoLiveRouteMapHtml';

const PAYLOADS: Array<[string, string]> = [
  ['bravoAgentTrackerMapHtml', buildAgentTrackerHtml('pk.test-token')],
  ['bravoLiveRouteMapHtml', buildLiveRouteHtml('pk.test-token')],
];

function scriptBlocks(html: string): string[] {
  return [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

describe.each(PAYLOADS)('%s — the inline map script is valid JavaScript', (name, html) => {
  it('produces at least one inline script block', () => {
    expect(scriptBlocks(html).length).toBeGreaterThan(0);
  });

  it('parses without a syntax error', () => {
    for (const block of scriptBlocks(html)) {
      expect(() => parse(block, {sourceType: 'script'})).not.toThrow();
    }
  });

  it('leaves no un-substituted template interpolation in the payload', () => {
    // Everything in these files is emitted at build time; a surviving "${...}"
    // means the injected JS accidentally used template syntax that TypeScript
    // already consumed, or that a value failed to interpolate.
    expect(html).not.toMatch(/\$\{/);
  });
});

describe('bravoAgentTrackerMapHtml — the error reporter exists before anything uses it', () => {
  const html = buildAgentTrackerHtml('pk.test-token');

  it('declares post() ahead of the map-init try/catch that calls it', () => {
    // The script is one plain top-level block, so `const post` has a temporal
    // dead zone. It used to be declared AFTER the map constructor, which meant
    // the one path that most needed to report — a synchronous WebGL
    // context-creation failure — threw "Cannot access 'post' before
    // initialization" instead, RN heard nothing, and the tracker sat out the
    // full 15 s watchdog rather than failing fast.
    const declared = html.indexOf('const post = (msg) =>');
    const mapInit = html.indexOf('map = new mapboxgl.Map(');
    expect(declared).toBeGreaterThan(-1);
    expect(mapInit).toBeGreaterThan(-1);
    expect(declared).toBeLessThan(mapInit);
  });
});
