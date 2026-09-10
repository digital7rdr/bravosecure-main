/**
 * iOS BLACK MAP (founder 2026-08-11) — the map surfaces must never hand a
 * WebView inline HTML without a baseUrl.
 *
 * WKWebView's `loadHTMLString:baseURL:nil` gives the document a NULL origin,
 * and Mapbox GL v3 starts its workers from `blob:` URLs, which WKWebView
 * refuses on a null origin. GL never initialises and the map is a black
 * rectangle — with NO error, because the main frame loaded fine. Android is
 * permissive, so this is invisible until someone opens an iPhone.
 *
 * This is a STATIC SOURCE SCAN because the screens mount React Native and
 * cannot be imported by the node project. Per CLAUDE.md, comments are stripped
 * before the absence assertions — prose mentioning the banned shape is the
 * classic false result here — and the files are CRLF, so line-based scanning is
 * used rather than a `\n`-anchored regex.
 */
import * as fs from 'fs';
import * as path from 'path';
import {mapHtmlSource, MAP_HTML_BASE_URL} from '../mapWebViewSource';

const SRC = path.join(__dirname, '..', '..', '..');

/** Every screen that hands inline map HTML to a WebView. */
const MAP_SURFACES = [
  'screens/pro/ProLiveMissionScreen.tsx',
  'screens/cpo/CpoProtectionSessionScreen.tsx',
  'screens/liveops/LiveTrackingScreen.tsx',
  'screens/agent/AgentLiveTrackerScreen.tsx',
  'screens/booking/LocationPickerScreen.tsx',
  'screens/vbg/VbgKeyPointsMap.tsx',
  'modules/booking/MapPrewarm.tsx',
];

/** Drop // and /* *​/ comments so prose can never satisfy or break a scan. */
function stripComments(s: string): string {
  return s
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('mapHtmlSource', () => {
  it('gives the document a real, secure origin', () => {
    expect(MAP_HTML_BASE_URL).toMatch(/^https:\/\//);
    expect(mapHtmlSource('<html></html>')).toEqual({
      html: '<html></html>', baseUrl: MAP_HTML_BASE_URL,
    });
  });

  it('preserves the html verbatim', () => {
    const html = '<!doctype html><body>x</body>';
    expect(mapHtmlSource(html).html).toBe(html);
  });
});

describe('no map surface may use a bare inline-html source', () => {
  it.each(MAP_SURFACES)('%s routes its html through mapHtmlSource', file => {
    const full = path.join(SRC, file);
    const code = stripComments(fs.readFileSync(full, 'utf8'));

    // The exact shapes that produce a null origin on iOS.
    expect(code).not.toMatch(/source=\{\{\s*html/);
    expect(code).not.toMatch(/useMemo\(\s*\(\)\s*=>\s*\(\{\s*html\s*\}\)/);

    expect(code).toMatch(/mapHtmlSource\s*\(/);
  });
});
