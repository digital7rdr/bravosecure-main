/**
 * Call-UI parity plan §6 (G5) — WhatsApp-smoothness for the self-view PiP:
 * on drag release the tile springs to the NEAREST CORNER instead of parking
 * wherever the finger stopped (the old behavior only clamped into the
 * viewport). Pure math, kept free of react-native imports so the node-env
 * test project can assert against the real production values.
 *
 * Coordinate model: the PiP renders at a fixed resting origin
 * (restingLeft/restingTop, i.e. bottom-right anchor) and the Animated.ValueXY
 * offset (dx, dy) translates it. This function maps a release offset to the
 * offset of the nearest snap corner.
 */
export interface PipSnapInput {
  winW: number;
  winH: number;
  pipW: number;
  pipH: number;
  /** Absolute origin of the PiP's CSS resting position (offset 0,0). */
  restingLeft: number;
  restingTop: number;
  /** Offset at release time. */
  dx: number;
  dy: number;
  /** Horizontal gap from the screen edges. */
  margin: number;
  /** Keep-out zones: header chrome at the top, control row at the bottom. */
  topInset: number;
  bottomInset: number;
}

export function snapPipOffset(i: PipSnapInput): {x: number; y: number} {
  const left   = i.margin;
  const right  = i.winW - i.pipW - i.margin;
  const top    = i.topInset;
  const bottom = i.winH - i.pipH - i.bottomInset;

  // Degenerate viewports (split-screen, fold postures) can invert the
  // corner rails; collapse to whichever bound keeps the tile visible.
  const xRail = right >= left ? [left, right] : [Math.max(0, right)];
  const yRail = bottom >= top ? [top, bottom] : [Math.max(0, bottom)];

  const curLeft = i.restingLeft + i.dx;
  const curTop  = i.restingTop + i.dy;

  const nearest = (cur: number, rail: number[]): number =>
    rail.reduce((best, v) => (Math.abs(v - cur) < Math.abs(best - cur) ? v : best), rail[0]);

  return {
    x: nearest(curLeft, xRail) - i.restingLeft,
    y: nearest(curTop, yRail) - i.restingTop,
  };
}
