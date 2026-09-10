/**
 * B-409 — the LIVE MAP screen's in-map controls sat under the status bar
 * (founder on-device, 2026-08-09: "shifted down a bit so it can be used").
 *
 * VBGMapScreen renders VbgKeyPointsMap with `StyleSheet.absoluteFillObject`,
 * i.e. FULL-BLEED behind its own header, and the map's DARK|LIGHT segment and
 * HEATMAP chip were pinned at a hardcoded `top:10px` / `top:42px` inside the
 * WebView — which cannot see that overlay. On a device with a 24-59dp status
 * bar plus a ~44dp header the segment landed behind the status icons and the
 * chip behind the title: both visible, neither reliably tappable.
 *
 * Fix mirrors the tracker map's `--recenter-bottom` contract: the host
 * MEASURES its header and pushes the offset in as `--chrome-top`. Embedded
 * card hosts pass nothing and keep the 10px fallback.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const HTML   = join(process.cwd(), 'src', 'screens', 'vbg', 'vbgKeyPointsMapHtml.ts');
const MAPCMP = join(process.cwd(), 'src', 'screens', 'vbg', 'VbgKeyPointsMap.tsx');
const SCREEN = join(process.cwd(), 'src', 'screens', 'vbg', 'VBGMapScreen.tsx');

/** CRLF-normalised, comments stripped (`[^:]` keeps `https://` intact). */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('B-409 — LIVE MAP in-map controls clear the host header', () => {
  it('both controls read the offset from --chrome-top, not a hardcoded top', () => {
    const src = code(HTML);
    expect(src).toMatch(/\.styleseg\s*\{[^}]*top:\s*var\(--chrome-top,\s*\d+px\)/);
    expect(src).toMatch(/\.heatchip\s*\{[^}]*top:\s*calc\(var\(--chrome-top,\s*\d+px\)\s*\+\s*\d+px\)/);
    // The old absolutes must not come back on either control.
    expect(src).not.toMatch(/\.styleseg\s*\{[^}]*top:\s*10px/);
    expect(src).not.toMatch(/\.heatchip\s*\{[^}]*top:\s*42px/);
  });

  it('the component injects the inset instead of rebuilding the html', () => {
    // Rebuilding would change `source` and remount the WebView, tearing down
    // the live map on every layout pass (same rule as the tracker map).
    const src = code(MAPCMP);
    expect(src).toMatch(/topInset\?: number/);
    expect(src).toMatch(/setProperty\('--chrome-top'/);
    expect(src).toMatch(/injectJavaScript\(/);
    expect(src).not.toMatch(/buildVbgKeyPointsMapHtml\([^)]*topInset/);
  });

  it('the inset is re-pushed on ready, so a WebView remount restores it', () => {
    const src = code(MAPCMP);
    expect(src).toMatch(/msg\.type === 'ready'[\s\S]{0,80}pushInset\(\)/);
  });

  it('the full-bleed host passes its MEASURED header height', () => {
    const src = code(SCREEN);
    // absoluteFill behind a header is exactly the condition that needs it.
    expect(src).toMatch(/style=\{StyleSheet\.absoluteFillObject\}/);
    expect(src).toMatch(/topInset=\{headerH \+ \d+\}/);
    expect(src).toMatch(/onLayout=\{e => setHeaderH\(e\.nativeEvent\.layout\.height\)\}/);
    // A constant would be wrong: insets.top varies 0-59 by device and the
    // header's content grows with fontScale.
    expect(src).toMatch(/useState\(insets\.top \+ \d+\)/);
  });
});
