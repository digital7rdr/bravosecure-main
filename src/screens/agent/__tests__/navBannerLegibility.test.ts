/**
 * B-406 — the CPO live tracker was unusable for actually driving (founder
 * on-device report + screenshot, 2026-08-09). Two independent defects:
 *
 *   1. THREE+ system cards rendered on top of each other into illegible mush
 *      over the route. `pushSystem` anchored every card to a WAYPOINT lng/lat
 *      and `relayoutBubbles` assigned each the same projected left/top with
 *      the same `translate(-50%, calc(-100% - 32px))`. Waypoint events share
 *      coordinates constantly (same pickup, same corner), so identical anchor
 *      = pixel-perfect overlap. There was also no cap: every event mounted a
 *      card and none ever yielded.
 *   2. The turn-by-turn card was too small to read while driving — distance
 *      16pt vs instruction 14pt, so nothing was glanceable at speed.
 *
 * Neither file can be imported by the node `booking` project (WebView/Mapbox
 * on one side, a template-literal HTML bundle on the other), so both halves
 * are pinned by source scan — same pattern as liveTrackerDockSend.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');
const MAP_HTML = join(process.cwd(), 'src', 'modules', 'booking', 'bravoAgentTrackerMapHtml.ts');

/** CRLF-normalised source (a `\n`-anchored regex matches nothing on CRLF and
 *  the assertion passes VACUOUSLY — CLAUDE.md scan trap). */
function read(p: string): string {
  return readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}
/** Comments stripped — prose describing the OLD behaviour is the single most
 *  common false result in this repo's scans. `[^:]` keeps `https://` intact. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The system-bubble pass inside relayoutBubbles(), CODE only. */
function systemLayoutBlock(): string {
  const src = stripComments(read(MAP_HTML));
  const start = src.indexOf('systemBubbles.forEach(b => {');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n    });', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}
/** A numeric style property from the screen's StyleSheet, e.g. navDist.fontSize. */
function styleNumber(styleName: string, prop: string): number {
  const src = stripComments(read(SCREEN));
  const start = src.indexOf(`  ${styleName}: {`);
  expect(start).toBeGreaterThan(-1);
  const block = src.slice(start, src.indexOf('},', start));
  const m = new RegExp(`${prop}:\\s*([0-9.]+)`).exec(block);
  expect(m).not.toBeNull();
  return Number(m![1]);
}

describe('B-406 part 1 — system cards can never stack into illegible mush', () => {
  it('the system-bubble pass de-collides in screen space (not a bare top assignment)', () => {
    const block = systemLayoutBlock();
    // The exact old line — every card pinned to its raw projected point.
    expect(block).not.toMatch(/b\.el\.style\.top\s*=\s*p\.y\s*\+\s*'px';/);
    // The fix: hunt upward while the measured box hits an already-claimed one.
    expect(block).toMatch(/overlaps\(/);
    expect(block).toMatch(/claimed/);
    expect(block).toMatch(/b\.el\.style\.top\s*=\s*\(p\.y\s*-\s*dy\)/);
  });

  it('marker bubbles claim their boxes FIRST so system cards route around them', () => {
    // Without this the cards still land on the CPO/Principal bubbles, which is
    // half of what the founder's screenshot showed.
    const src = stripComments(read(MAP_HTML));
    const relayout = src.slice(src.indexOf('function relayoutBubbles()'));
    const markerClaim = relayout.indexOf('claimed.push(rectAt(b.el, p.x, p.y - BUB_LIFT');
    const systemPass = relayout.indexOf('systemBubbles.forEach(b => {');
    expect(markerClaim).toBeGreaterThan(-1);
    expect(systemPass).toBeGreaterThan(markerClaim);
  });

  it('un-hides BEFORE measuring — measuring a display:none node returns 0x0', () => {
    // Adversarial review 2026-08-09 (Critical, found independently by two
    // reviewers): the first cut measured, THEN un-hid. A node hidden by the
    // previous pass measures 0x0, so the walk stepped 8px instead of a card,
    // a zero-area rect overlapped nothing, the top guard passed, and the card
    // was redrawn ON its raw anchor — the pile-up back, strobing once per
    // frame because the next pass hid it again. relayoutBubbles is bound to
    // move/zoom/rotate/pitch, so "per frame" is literal during follow-camera.
    const block = systemLayoutBlock();
    const unhide = block.indexOf("b.el.style.display = ''");
    const measure = block.indexOf('rectAt(');
    expect(unhide).toBeGreaterThan(-1);
    expect(measure).toBeGreaterThan(-1);
    expect(unhide).toBeLessThan(measure);
    // And an unmeasurable card must never be treated as one that fits.
    expect(block).toMatch(/box\.h <= 0/);
  });

  it('a card that cannot find a free slot is hidden, never drawn over the maneuver banner', () => {
    const block = systemLayoutBlock();
    expect(block).toMatch(/sysTopGuard/);
    expect(block).toMatch(/display\s*=\s*'none'/);
    // The upward walk must terminate — an unbounded while on a layout path
    // freezes the WebView.
    expect(block).toMatch(/guard\+\+\s*<\s*\d+/);
  });

  it('the top guard is MEASURED from RN, not a constant baked into the map', () => {
    // Adversarial review 2026-08-09 (Major): a literal 156 was calibrated to
    // the OLD 64pt banner. With the driver-grade card (~115-140 measured) plus
    // insets.top (24 Android / 59 iPhone), cards were admitted into the band
    // the banner covers, then rendered invisibly BEHIND it while still using
    // up one of the two slots. Same contract as --recenter-bottom for the dock.
    const mapSrc = stripComments(read(MAP_HTML));
    expect(mapSrc).toMatch(/let sysTopGuard = \d+/);          // fallback only
    expect(mapSrc).toMatch(/window\.setSysTopGuard = function/);
    const screenSrc = stripComments(read(SCREEN));
    // Fed from the measured banner height + the real top inset.
    // Shape changed 2026-08-23: the screen now routes every map command
    // through `mapCmd` so the WebView and native renderers share call sites.
    // The contract is unchanged — the guard is still the MEASURED value.
    expect(screenSrc).toMatch(/mapCmd\.setSysTopGuard\(guard\)/);
    expect(screenSrc).toMatch(/insets\.top \+ 50 \+ \(navHeight \|\| \d+\)/);
  });

  it('concurrent system cards are CAPPED, and a queued one is promoted when a slot frees', () => {
    const src = stripComments(read(MAP_HTML));
    expect(src).toMatch(/const MAX_SYS_VISIBLE = \d+/);
    const push = src.slice(src.indexOf('window.pushSystem'), src.indexOf('window.setStyle'));
    // Newest first + drop the node beyond the cap.
    expect(push).toMatch(/systemBubbles\.unshift\(b\)/);
    expect(push).toMatch(/idx >= MAX_SYS_VISIBLE/);
    // …and the TTL path re-mounts a queued entry rather than losing it.
    expect(push).toMatch(/i2 < MAX_SYS_VISIBLE && !e2\.el/);
  });

  it('the collision maths agrees with the CSS transform it models', () => {
    // BUB_LIFT/BEHIND_LIFT reproduce `.bub`'s translate in JS. If the CSS lift
    // is retuned and these are not, every box is computed at the wrong Y and
    // the de-collision silently stops working — with no visible test failure.
    const src = read(MAP_HTML);
    const cssLift = /\.bub\s*\{[^}]*translate\(-50%,\s*calc\(-100% - (\d+)px\)\)/.exec(src);
    const cssBehind = /\.bub\.behind\s*\{[^}]*calc\(-100% - \d+px - (\d+)px\)/.exec(src);
    const jsLift = /const BUB_LIFT\s*=\s*(\d+)/.exec(src);
    const jsBehind = /const BEHIND_LIFT\s*=\s*(\d+)/.exec(src);
    expect(cssLift).not.toBeNull();
    expect(cssBehind).not.toBeNull();
    expect(jsLift![1]).toBe(cssLift![1]);
    expect(jsBehind![1]).toBe(cssBehind![1]);
  });
});

describe('B-406 part 2 — the maneuver card is legible at driving speed', () => {
  it('distance is the dominant glanceable element and outranks the instruction', () => {
    const dist = styleNumber('navDist', 'fontSize');
    const primary = styleNumber('navPrimary', 'fontSize');
    const secondary = styleNumber('navSecondary', 'fontSize');
    // Was 16 — unreadable at arm's length in motion.
    expect(dist).toBeGreaterThanOrEqual(28);
    // Was 14, i.e. all but equal to the distance: no hierarchy at all.
    expect(primary).toBeGreaterThanOrEqual(18);
    expect(dist).toBeGreaterThan(primary);
    expect(primary).toBeGreaterThan(secondary);
  });

  it('the maneuver arrow is a large plate, not a 44pt chip', () => {
    expect(styleNumber('navIcon', 'width')).toBeGreaterThanOrEqual(56);
    expect(styleNumber('navIcon', 'height')).toBeGreaterThanOrEqual(56);
  });

  it('the card grows with the text instead of clipping it (minHeight, never height)', () => {
    const src = stripComments(read(SCREEN));
    const start = src.indexOf('  navBanner: {');
    expect(start).toBeGreaterThan(-1);
    // Slice to the STYLE's own close, not the first `},` in it: the card now
    // carries `shadowOffset: {width: 0, height: 8}`, whose brace used to end
    // the slice early and whose `height` key then read as a fixed card height.
    const block = src.slice(start, src.indexOf('\n  },', start));
    expect(block).toMatch(/minHeight:\s*\d+/);
    // Nested value objects own width/height keys that are not the card's
    // height. Drop them, then the absence assertion means what it says.
    const topLevel = block.replace(/\{[^{}]*\}/g, '');
    // A fixed `height` would clip the instruction at fontScale 1.3.
    expect(topLevel).not.toMatch(/[^n]height:\s*\d+/);
  });

  it('the right-edge controls anchor to the DOCK, never to the banner height', () => {
    const src = stripComments(read(SCREEN));
    // The original `navOffset = navShown ? 76 : 0` pushed them down as the
    // card grew; adversarial review then showed that clamping that offset is
    // ALSO wrong (it computes below the old constant and drags the column
    // under the zIndex-14 banner). Both controls are bottom-anchored now, so
    // no top-anchored navOffset may come back.
    expect(src).not.toMatch(/navOffset/);
    expect(src).toMatch(/s\.styleToggle, \{bottom: \(dockHeight \|\| 0\)/);
    expect(src).toMatch(/s\.slideHandle, \{bottom: \(dockHeight \|\| 0\) \+ 12\}/);
    // Still measured — the banner reports its height for the top-guard inject.
    expect(src).toMatch(/onLayout=\{e => setNavHeight\(e\.nativeEvent\.layout\.height\)\}/);
  });

  it('a screen with no vertical budget drops chrome instead of burying the dock', () => {
    // G6 / DESIGN_REVIEW_LOOP §2: 320x568 and 360x640 at fontScale 1.3 could
    // not fit banner + toggle + handle + dock. Rather than overlap the live
    // mission stepper and ETA, each control is gated on the measured band.
    const src = stripComments(read(SCREEN));
    expect(src).toMatch(/const band\s+= bandBottom - bandTop/);
    expect(src).toMatch(/band >= SLIDE_HANDLE_H \+ 12 \+ STYLE_TOGGLE_H/);
    expect(src).toMatch(/band >= SLIDE_HANDLE_H &&/);
  });

  it('a long street name wraps rather than truncating the turn', () => {
    const src = stripComments(read(SCREEN));
    const banner = src.slice(src.indexOf('{navShown && ('), src.indexOf('Style toggle'));
    expect(banner).toMatch(/s\.navPrimary\} numberOfLines=\{2\}/);
  });

  it('the turn is announced ONCE per maneuver, not on every telemetry tick', () => {
    // Adversarial review 2026-08-09: the first cut used a live region whose
    // label embedded the distance. That label changes on essentially every 4s
    // poll (10m rounding; ~55m covered per poll at 50km/h), so TalkBack
    // re-read the entire card continuously — and the prop is Android-only, so
    // VoiceOver got nothing at all. The pin asserted the live region, which
    // would have CEMENTED the spam; it now pins the corrected behaviour.
    const src = stripComments(read(SCREEN));
    const banner = src.slice(src.indexOf('{navShown && ('), src.indexOf('Style toggle'));
    expect(banner).not.toMatch(/accessibilityLiveRegion/);
    expect(banner).toMatch(/accessible\b/);
    expect(banner).toMatch(/accessibilityLabel=/);
    // Announcement is keyed on the instruction, never the distance.
    expect(src).toMatch(/AccessibilityInfo\.announceForAccessibility/);
    expect(src).toMatch(/const key = `\$\{navBanner\.primary\}\|\$\{navBanner\.secondary \?\? ''\}`/);
    expect(src).toMatch(/if \(key === spokenRef\.current\) \{return;\}/);
  });
});
