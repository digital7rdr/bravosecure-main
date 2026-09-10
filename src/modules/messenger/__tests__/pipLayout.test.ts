/**
 * Parity plan §6 (G5) — PiP corner snap. Uses CallScreen's real production
 * geometry: PIP 108x148, resting at bottom:140/right:16, margin 16,
 * topInset 120 (header chrome), bottomInset 140 (control row), on a
 * 392x830 window (Pixel-class dp viewport).
 */
import {snapPipOffset} from '../webrtc/pipLayout';

const G = {
  winW: 392, winH: 830, pipW: 108, pipH: 148,
  restingLeft: 392 - 108 - 16, // 268
  restingTop: 830 - 148 - 140, // 542
  margin: 16, topInset: 120, bottomInset: 140,
};

describe('snapPipOffset', () => {
  it('no drag → stays at the resting corner (bottom-right)', () => {
    expect(snapPipOffset({...G, dx: 0, dy: 0})).toEqual({x: 0, y: 0});
  });

  it('small nudge springs back to the nearest (resting) corner', () => {
    expect(snapPipOffset({...G, dx: -30, dy: -40})).toEqual({x: 0, y: 0});
  });

  it('drag far left snaps to bottom-left', () => {
    const r = snapPipOffset({...G, dx: -260, dy: 0});
    expect(r).toEqual({x: G.margin - G.restingLeft, y: 0}); // left rail
  });

  it('drag to upper-left snaps to top-left, clear of the header inset', () => {
    const r = snapPipOffset({...G, dx: -260, dy: -400});
    expect(r).toEqual({x: G.margin - G.restingLeft, y: G.topInset - G.restingTop});
    // Absolute origin lands exactly at (margin, topInset).
    expect(G.restingLeft + r.x).toBe(16);
    expect(G.restingTop + r.y).toBe(120);
  });

  it('drag to upper-right snaps to top-right', () => {
    const r = snapPipOffset({...G, dx: 40, dy: -400});
    expect(r).toEqual({x: 0, y: G.topInset - G.restingTop});
  });

  it('fling past the screen edge still lands ON a corner (never off-screen)', () => {
    const r = snapPipOffset({...G, dx: -10_000, dy: 10_000});
    expect(G.restingLeft + r.x).toBe(G.margin);
    expect(G.restingTop + r.y).toBe(G.winH - G.pipH - G.bottomInset);
  });

  it('degenerate viewport (rails inverted) still returns a visible position', () => {
    const r = snapPipOffset({...G, winW: 100, winH: 200, dx: 0, dy: 0});
    expect(G.restingLeft + r.x).toBeGreaterThanOrEqual(0);
    expect(G.restingTop + r.y).toBeGreaterThanOrEqual(0);
  });
});
