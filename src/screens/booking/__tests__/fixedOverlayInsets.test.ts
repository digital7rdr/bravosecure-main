/**
 * Static source-scan regression for the three overlap defects in Testing Issues
 * V2 that share ONE root cause: a fixed overlay positioned by a hard-coded
 * number instead of the thing it must clear.
 *
 *   Issue 27 (p.32) — LocationPicker's coverage banner sat at `bottom: 96`
 *     while the CTA bar is 10 + 48 + max(insets.bottom,12) + 12 tall. On
 *     3-button navigation that is ~118dp, so the bar covered the message that
 *     says whether the pin is even in coverage. It "worked" on gesture nav
 *     (~94dp), which is why it reproduced on some devices only.
 *   Issue 32 (p.37) — an empty <View style={back} /> spacer kept the button's
 *     background + border, painting a blank rounded square that reads as a
 *     failed icon asset. Same bug in the shared agent NavHeader.
 *   Issue 42 (p.47) — the in-map "Follow" pill is CSS-positioned at
 *     `bottom: 150px` inside the Mapbox WebView, covering journey rail steps 5
 *     and 6. The WebView cannot see the RN overlay, so the screen must measure
 *     and tell it.
 *
 * All four files mount RN / WebView, so the rules are pinned by reading source.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

/**
 * CRLF-normalised, comments stripped line-wise.
 *
 * Line-wise, NOT `/\/\*[\s\S]*?\*\//g`: a MIME wildcard or a CSS token can
 * contain a literal `/` followed by `*`, which that regex reads as a comment
 * OPEN and then deletes everything to the next close — silently swallowing real
 * code and passing the assertion vacuously.
 */
function code(file: string): string {
  const src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (inBlock) {
      if (trimmed.includes('*/')) {inBlock = false;}
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) {inBlock = true;}
      continue;
    }
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('Issue 27 — the coverage banner clears the Confirm Location bar', () => {
  const FILE = join(ROOT, 'src', 'screens', 'booking', 'LocationPickerScreen.tsx');

  it('the banner style no longer hard-codes a bottom offset', () => {
    const src = code(FILE);
    const start = src.indexOf('banner: {');
    expect(start).toBeGreaterThan(-1);
    const style = src.slice(start, src.indexOf('}', start));
    expect(style).not.toMatch(/bottom:\s*\d/);
  });

  it('the banner is positioned from the MEASURED CTA height', () => {
    const src = code(FILE);
    expect(src).toMatch(/setCtaHeight\(e\.nativeEvent\.layout\.height\)/);
    expect(src).toMatch(/ctaHeight > 0 \? ctaHeight : CTA_FALLBACK_H/);
  });

  it('the pre-measure fallback is DERIVED from the CTA bar, not a magic number', () => {
    const src = code(FILE);
    // UPDATED for B-245. This asserted the literal
    // `Math.max(insets.bottom, 12)`, which was the RIGHT intent (track the
    // real inset, never a magic number) expressed as the WRONG formula: this
    // screen sits inside the bottom-tab navigator, and ObsidianTabBar already
    // pads itself by insets.bottom. Adding it again reserved the system nav
    // bar TWICE — ~48dp of dead black gap under CONFIRM LOCATION on 3-button
    // navigation, which is what the founder screenshotted.
    //
    // bottomPad() carries the same intent correctly: it INCLUDES the inset
    // when nothing below the screen owns it, and drops it when a tab bar does.
    // The term is still derived, still not a magic number.
    expect(src).toMatch(/CTA_FALLBACK_H =[^;]*bottomPad\(12\)/);
  });

  it('the CTA bar itself still defers to the rule for its bottom padding', () => {
    // Same reversal as above — the inset must come from useBottomInset, never
    // be re-added by hand here.
    const src = code(FILE);
    expect(src).toMatch(/paddingBottom:\s*bottomPad\(12\)/);
    expect(src).not.toMatch(/paddingBottom:\s*Math\.max\(insets\.bottom/);
  });
});

describe('Issue 32 — a suppressed back button leaves no blank box', () => {
  const SITES = [
    ['agent NavHeader', join(ROOT, 'src', 'screens', 'agent', '_shared.tsx'), 'nav'],
    ['OpsRoomReviewScreen', join(ROOT, 'src', 'screens', 'ops', 'OpsRoomReviewScreen.tsx'), 's'],
  ] as const;

  it.each(SITES)('%s uses a chrome-less spacer, not the button style', (_label, file, ns) => {
    const src = code(file);
    expect(src).not.toContain(`<View style={${ns}.back} />`);
    expect(src).toContain(`<View style={${ns}.backSpacer} />`);
  });

  it.each(SITES)('%s spacer has no background or border', (_label, file) => {
    const src = code(file);
    const start = src.indexOf('backSpacer:');
    expect(start).toBeGreaterThan(-1);
    const decl = src.slice(start, src.indexOf('}', start));
    expect(decl).not.toMatch(/backgroundColor|borderWidth|borderColor/);
    // It must still reserve width so the title stays put.
    expect(decl).toMatch(/width:\s*\d+/);
  });
});

describe('Issue 42 — the in-map Follow pill clears the RN bottom dock', () => {
  const HTML = join(ROOT, 'src', 'modules', 'booking', 'bravoAgentTrackerMapHtml.ts');
  const SCREEN = join(ROOT, 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');

  it('the pill reads its offset from a CSS custom property', () => {
    const src = code(HTML);
    expect(src).not.toMatch(/\.recenter\s*\{[^}]*bottom:\s*150px/);
    expect(src).toMatch(/bottom:\s*var\(--recenter-bottom,\s*\d+px\)/);
  });

  it('the screen measures its bottom dock and pushes the offset in', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/setDockHeight\(e\.nativeEvent\.layout\.height\)/);
    expect(src).toMatch(/setProperty\('--recenter-bottom'/);
  });

  it('the offset is injected, NOT baked into the html source', () => {
    // Rebuilding the html changes `source` and remounts the WebView, tearing
    // down the live map on every layout pass.
    const src = code(SCREEN);
    const start = src.indexOf("setProperty('--recenter-bottom'");
    const around = src.slice(Math.max(0, start - 400), start);
    expect(around).toContain('inject(');
  });

  it('the injection re-fires after a map reload, so a remount restores it', () => {
    const src = code(SCREEN);
    const start = src.indexOf("setProperty('--recenter-bottom'");
    const after = src.slice(start, start + 400);
    // The guarantee is MEMBERSHIP, not an exact list: `map.status` must be a
    // dependency or a WebView remount leaves the pill at its fallback offset.
    // (B-406 added `winH` here to clamp the offset; an exact-array assertion
    // failed on that purely additive change while the guarantee still held.)
    const deps = /\}, \[([^\]]*)\]\);/.exec(after);
    expect(deps).not.toBeNull();
    const names = deps![1].split(',').map(s => s.trim());
    expect(names).toEqual(expect.arrayContaining(['dockHeight', 'map.status', 'inject']));
  });
});
