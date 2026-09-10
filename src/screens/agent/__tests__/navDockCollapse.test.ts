/**
 * Founder 2026-08-23 — "the navigation must be big like Waze or Google Maps."
 *
 * The map was already a full-screen WebView; what shrank it was the overlay
 * chrome. Measured from the style constants on a 393x873dp screen, the bottom
 * dock cost ~234dp (composer 50 + stepper ~70 + protection detail ~60 +
 * attribution ~22 + insets), leaving a ~429dp visible band — and only ~365dp
 * once the checkpoint pill is drawn inside it. That is ~42% of the screen
 * against the ~72-78% Waze and Google Maps give the map while navigating.
 *
 * The fix collapses the dock WHILE NAVIGATING ONLY: the read-only rails
 * (MissionStepper + mini-status) go behind a grab handle, and the composer's
 * slot carries the ETA + remaining distance instead. With no route the full
 * dock is still the right default.
 *
 * Source scan: this screen mounts a WebView + Mapbox and cannot be imported by
 * the node `booking` project (same reason as dockControls.test.ts).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentLiveTrackerScreen.tsx');

/** CRLF-normalised, comments stripped. This file documents its own history in
 *  prose, which is the classic false-positive in an absence assertion — and
 *  the file is CRLF, so a \n-anchored regex would match nothing and pass
 *  VACUOUSLY. Both traps are called out in CLAUDE.md. */
function code(): string {
  return readFileSync(SCREEN, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('the collapsed nav dock — the map keeps its share of the screen', () => {
  it('collapses ONLY while navigating, and never over an unsent draft', () => {
    const src = code();
    const m = src.match(/const navCompact = ([^;]+);/);
    expect(m).not.toBeNull();
    const expr = m![1];

    // Navigating is the trigger — a dock with no route must not collapse.
    expect(expr).toContain('navShown');
    // The user's own override, and the IME case B-407 already owned.
    expect(expr).toContain('!dockExpanded');
    expect(expr).toContain('!focused');
    // Collapsing swaps the composer out for the ETA readout, so a typed but
    // unsent draft would vanish with no way to see it was still pending.
    expect(expr).toMatch(/draft\.trim\(\)\.length === 0/);
  });

  it('hides the read-only rails when compact — that is where the pixels come from', () => {
    const src = code();
    // The stepper + mini-status block is gated on BOTH focus and compact.
    const gate = src.indexOf('{!focused && !navCompact && (');
    expect(gate).toBeGreaterThan(-1);

    // ...and the block it opens is the one that actually holds the rails.
    const block = src.slice(gate, gate + 2600);
    expect(block).toContain('<MissionStepper');
    expect(block).toContain('s.miniStatus');
  });

  it('keeps exactly ONE SOS call site — the B-408 shape must not come back', () => {
    const src = code();
    // Building a separate nav bar would have duplicated the button row. SOS
    // living in two branches is precisely how B-408 lost the panic control.
    const sos = src.match(/accessibilityLabel="Raise SOS"/g) ?? [];
    expect(sos).toHaveLength(1);
    // The compact swap is the composer's slot only, not the button cluster.
    const swap = src.match(/\{navCompact \? \(/g) ?? [];
    expect(swap).toHaveLength(1);
  });

  it('the ETA readout carries both numbers a driver steers by', () => {
    const src = code();
    const i = src.indexOf('{navCompact ? (');
    expect(i).toBeGreaterThan(-1);
    const branch = src.slice(i, src.indexOf(') : (', i));
    expect(branch).toContain('etaText');
    expect(branch).toContain('remainingLabel');
    // It is the door back to the full dock, so it must be reachable.
    expect(branch).toContain('setDockExpanded(true)');
    expect(branch).toContain('accessibilityRole="button"');
  });

  it('the grab handle is a real 48dp target, labelled, and toggles both ways', () => {
    const src = code();
    const i = src.indexOf('style={s.grab}');
    expect(i).toBeGreaterThan(-1);
    const handle = src.slice(i, i + 700);

    // Rendered for BOTH states — the control that opens it also closes it.
    expect(handle).toContain('setDockExpanded(v => !v)');
    expect(handle).toContain('HIT_GRAB');
    expect(handle).toContain('accessibilityState={{expanded: dockExpanded}}');
    expect(handle).toMatch(/accessibilityLabel=\{dockExpanded \?/);

    // DESIGN_REVIEW_LOOP §3.4 — the visual bar is far under the floor, so the
    // hitSlop is load-bearing. 24pt tall + 12 top + 12 bottom = 48.
    const hit = src.match(/const HIT_GRAB = \{top: (\d+), bottom: (\d+)/);
    expect(hit).not.toBeNull();
    const pad = Number(hit![1]) + Number(hit![2]);
    const grabPad = src.match(/ {2}grab: \{[^}]*paddingVertical: (\d+)/);
    expect(grabPad).not.toBeNull();
    const barH = 4;
    expect(Number(grabPad![1]) * 2 + barH + pad).toBeGreaterThanOrEqual(48);
  });

  it('the maneuver banner is a SOLID slab, not a translucent card', () => {
    const src = code();
    const i = src.indexOf('  navBanner: {');
    expect(i).toBeGreaterThan(-1);
    const block = src.slice(i, src.indexOf('\n  },', i));

    // Founder's Mapbox Navigation SDK reference: solid cobalt, white type.
    // An rgba() fill here is the old translucent navy card coming back.
    expect(block).toMatch(/backgroundColor: '#1E88FF'/);
    expect(block).not.toMatch(/backgroundColor: 'rgba/);
    // Lift off a busy map tile — legibility, not decoration.
    expect(block).toMatch(/elevation: \d+/);
  });

  it('white-on-cobalt stays WCAG-legal: the secondary line must remain bold', () => {
    const src = code();
    // White on #1E88FF is 3.49:1 — it clears the 3:1 LARGE-text bar and fails
    // the 4.5:1 body bar. navDist/navPrimary are large outright; navSecondary
    // only qualifies because 14.5pt at 700 counts as large. Dropping either
    // the weight or the size silently makes this row non-compliant.
    const sec = src.match(/ {2}navSecondary: \{([^}]*)\}/);
    expect(sec).not.toBeNull();
    const size = Number(/fontSize: ([0-9.]+)/.exec(sec![1])![1]);
    const weight = Number(/fontWeight: '(\d+)'/.exec(sec![1])![1]);
    expect(weight).toBeGreaterThanOrEqual(700);
    expect(size).toBeGreaterThanOrEqual(14);

    for (const name of ['navDist', 'navPrimary']) {
      const m = src.match(new RegExp(` {2}${name}: \\{([^}]*)\\}`));
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(/color: '#FFFFFF'/);
    }
  });

  it('the "navigation unavailable" fallback does NOT wear the active blue', () => {
    const src = code();
    // A cobalt slab announcing that guidance is dead is the screen
    // contradicting itself, so the fallback overrides the fill.
    expect(src).toContain('style={[s.navBanner, s.navBannerIdle,');
    const idle = src.match(/ {2}navBannerIdle: \{([^}]*)\}/);
    expect(idle).not.toBeNull();
    expect(idle![1]).toMatch(/backgroundColor: 'rgba\(10,31,63/);
  });

  it('the ETA labels cannot be pushed off at 320dp / fontScale 1.3', () => {
    const src = code();
    // navEta row and its long label both need the shrink contract; the time
    // must be the one that survives, so it is flexShrink: 0.
    expect(src).toMatch(/ {2}navEta: \{[^}]*minWidth: 0/);
    expect(src).toMatch(/ {2}navEtaV: \{[\s\S]{0,220}?flexShrink: 0/);
    expect(src).toMatch(/ {2}navEtaL: \{[\s\S]{0,220}?flexShrink: 1/);
  });
});
