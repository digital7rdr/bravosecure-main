/**
 * B-408 — the live-tracker message dock control cluster.
 *
 * Surfaced by the 3-agent review of B-406 and deliberately deferred out of
 * that diff (pre-existing, dock-wide, and the reviewer's own fix collapsed the
 * composer at 320dp). Three defects, all in the row a CPO uses while driving:
 *
 *   1. SOS lived INSIDE the `draft.trim().length > 0 ? send : (emoji + SOS)`
 *      ternary, so the panic control unmounted the moment the CPO typed a
 *      character.
 *   2. Every one of the five controls was below the 44/48 touch floor and
 *      none carried an accessibilityLabel (DESIGN_REVIEW_LOOP §3.4).
 *   3. SOS was `ptt` — an inherited push-to-talk button painted with the
 *      SUCCESS token (rgba of C.ok #00C853) under a red glyph. A panic
 *      control that reads green is a semantic bug and a G8 deviation.
 *
 * Source scan: this screen mounts a WebView + Mapbox and cannot be imported
 * by the node `booking` project (same reason as liveTrackerDockSend.test.ts).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');

/** CRLF-normalised, comments stripped — this file documents the OLD behaviour
 *  in prose, which is the classic false-positive in an absence assertion. */
function code(): string {
  return readFileSync(SCREEN, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The emoji<->send ternary ONLY, from its condition to its closing `)}`. */
function ternary(): string {
  const src = code();
  const start = src.indexOf('{draft.trim().length > 0 ? (');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n          )}', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}
function styleNum(name: string, prop: string): number {
  const src = code();
  const i = src.indexOf(`  ${name}: {`);
  expect(i).toBeGreaterThan(-1);
  const block = src.slice(i, src.indexOf('},', i));
  const m = new RegExp(`(?:^|[^a-zA-Z])${prop}:\\s*([0-9.]+)`).exec(block);
  expect(m).not.toBeNull();
  return Number(m![1]);
}
function hitSlop(name: string): Record<string, number> {
  const m = new RegExp(`const ${name} = \\{([^}]*)\\}`).exec(code());
  expect(m).not.toBeNull();
  const out: Record<string, number> = {};
  for (const part of m![1].split(',')) {
    const [k, v] = part.split(':').map(s => s.trim());
    if (k) { out[k] = Number(v); }
  }
  return out;
}

describe('B-408 — SOS is a persistent panic control', () => {
  it('SOS is NOT inside the emoji/send ternary', () => {
    // The whole defect in one assertion: typing must not unmount SOS.
    expect(ternary()).not.toMatch(/Raise SOS/);
    expect(ternary()).not.toMatch(/s\.sos/);
    // …and it still exists, outside it.
    expect(code()).toMatch(/accessibilityLabel="Raise SOS"/);
    expect(code()).toMatch(/style=\{\[s\.sos,/);
  });

  it('the ternary swaps exactly one control, so the row never grows', () => {
    // Keeping it to one swapped slot is what stops the composer collapsing at
    // 320dp — the reviewer's "make SOS permanent" fix put emoji+SOS+send in
    // the row together and squeezed the field to ~75dp.
    const t = ternary();
    expect(t).toMatch(/s\.send/);
    expect(t).toMatch(/s\.icBtn/);
    expect((t.match(/<TouchableOpacity/g) ?? []).length).toBe(2);
  });

  it('SOS stays disabled-and-visible on a terminal mission (Audit H5 preserved)', () => {
    const src = code();
    expect(src).toMatch(/disabled=\{sosInFlight \|\| isMissionTerminal\}/);
    expect(src).toMatch(/accessibilityState=\{\{disabled: sosInFlight \|\| isMissionTerminal\}\}/);
    // Still hidden for the off-scene manager — raiseSos is crew-gated.
    expect(src).toMatch(/mode !== 'monitor' && \(/);
  });
});

describe('B-408 — SOS reads as danger, not success', () => {
  it('the legacy push-to-talk style is gone', () => {
    expect(code()).not.toMatch(/^\s{2}ptt: \{/m);
    expect(code()).not.toMatch(/s\.ptt/);
  });

  it('SOS uses the danger token and never the success green', () => {
    const src = code();
    const i = src.indexOf('  sos: {');
    const block = src.slice(i, src.indexOf('},', i));
    expect(block).toMatch(/rgba\(255,59,59/);       // C.err #FF3B3B
    expect(block).not.toMatch(/rgba\(0,200,83/);    // C.ok  #00C853
  });
});

describe('B-408 — every dock control is reachable and labelled', () => {
  const LABELS = [
    // Deck page 19 ("agent call all") — this control always rang the whole
    // assigned mission group; it now says so, in the founder's words.
    'Call all — ops and crew',
    'Video call ops and crew',
    'Open mission chat',
    'Send message',
    'Raise SOS',
  ];
  it.each(LABELS)('"%s" has an accessibility label', label => {
    expect(code()).toContain(`accessibilityLabel="${label}"`);
  });

  it('all five controls declare a button role', () => {
    // 5 dock controls; the screen has other buttons, so assert at least 5 and
    // that each labelled control sits next to a role.
    const src = code();
    for (const label of LABELS) {
      const i = src.indexOf(`accessibilityLabel="${label}"`);
      const around = src.slice(Math.max(0, i - 300), i + 100);
      expect(around).toMatch(/accessibilityRole="button"/);
    }
  });

  it('the two primary actions meet the 44pt visual floor', () => {
    expect(styleNum('send', 'width')).toBeGreaterThanOrEqual(44);
    expect(styleNum('send', 'height')).toBeGreaterThanOrEqual(44);
    expect(styleNum('sos', 'width')).toBeGreaterThanOrEqual(44);
    expect(styleNum('sos', 'height')).toBeGreaterThanOrEqual(44);
  });

  it('every control clears 48dp TALL once hitSlop is applied', () => {
    const dockInner = styleNum('msgDock', 'height') - 2; // 1px border each side
    for (const [slopName, styleName] of [
      ['HIT_CALL', 'callBtn'], ['HIT_ICON', 'icBtn'], ['HIT_PRIMARY', 'send'], ['HIT_PRIMARY', 'sos'],
    ] as const) {
      const hs = hitSlop(slopName);
      const h = styleNum(styleName, 'height');
      expect(h + hs.top + hs.bottom).toBeGreaterThanOrEqual(48);
      // …and the control still fits the fixed-height pill.
      expect(h).toBeLessThanOrEqual(dockInner);
    }
  });

  it('hitSlop never exceeds half the adjacent gap (no stolen taps)', () => {
    // Overlapping hit areas are awarded to the later sibling, which would turn
    // a tap near the seam of "call" into "video". Cap each slop at gap/2.
    const dockGap = styleNum('msgDock', 'gap');
    const callGap = styleNum('callBtns', 'gap');
    const call = hitSlop('HIT_CALL');
    expect(Math.max(call.left, call.right)).toBeLessThanOrEqual(callGap / 2);
    for (const n of ['HIT_ICON', 'HIT_PRIMARY']) {
      const hs = hitSlop(n);
      expect(Math.max(hs.left, hs.right)).toBeLessThanOrEqual(dockGap / 2);
    }
  });
});
