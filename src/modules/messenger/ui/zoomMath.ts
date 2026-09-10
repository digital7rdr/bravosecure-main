/**
 * B-87/MX-03 — pure geometry for the pinch-zoom image viewer. No React /
 * react-native imports so the clamp logic is unit-testable in a node env
 * (same convention as chatListLayout.ts).
 *
 * Coordinate model: the image is contain-fitted inside a viewport box and
 * transformed with `[{translateX}, {translateY}, {scale}]` — translate
 * FIRST so tx/ty are plain screen points regardless of zoom (RN applies
 * each transform in the local space of the previous one; scaling after
 * translating keeps the pan axis unscaled). All clamps below are
 * therefore in screen points.
 */

export const MIN_SCALE = 1;
export const MAX_SCALE = 4;
/** Double-tap zooms to this when at rest. */
export const DOUBLE_TAP_SCALE = 2.5;

export function clampScale(s: number): number {
  if (!isFinite(s) || s <= 0) {return MIN_SCALE;}
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
}

/** Contain-fit rectangle of an image inside a viewport. */
export function containRect(
  viewW: number, viewH: number, imgW: number, imgH: number,
): {width: number; height: number} {
  if (viewW <= 0 || viewH <= 0 || imgW <= 0 || imgH <= 0) {
    return {width: viewW > 0 ? viewW : 0, height: viewH > 0 ? viewH : 0};
  }
  const scale = Math.min(viewW / imgW, viewH / imgH);
  return {width: imgW * scale, height: imgH * scale};
}

/**
 * Clamp a screen-point translation so the scaled content can't be dragged
 * fully off-screen. Per axis: when the scaled content is SMALLER than the
 * viewport it stays centred (translation 0); when larger, the max pull in
 * either direction is half the overflow.
 */
export function clampTranslation(params: {
  scale:    number;
  viewW:    number;
  viewH:    number;
  contentW: number;
  contentH: number;
  tx:       number;
  ty:       number;
}): {tx: number; ty: number} {
  const {scale, viewW, viewH, contentW, contentH, tx, ty} = params;
  const clampAxis = (t: number, view: number, content: number): number => {
    const overflow = content * scale - view;
    if (overflow <= 0) {return 0;}
    const max = overflow / 2;
    return Math.min(max, Math.max(-max, t));
  };
  return {
    tx: clampAxis(isFinite(tx) ? tx : 0, viewW, contentW),
    ty: clampAxis(isFinite(ty) ? ty : 0, viewH, contentH),
  };
}

/**
 * B-287 — should a pan release page to the next/previous image?
 *
 * Founder: "when one image opens, if we swipe right or left we should be able
 * to see the next or previous image."
 *
 * The viewer already owns a PanGestureHandler for dragging a ZOOMED image
 * around. At rest scale that pan does nothing useful, so paging reuses it
 * rather than adding a second horizontal gesture — two competing handlers over
 * one surface is how zoom-vs-page fights start, and this has none.
 *
 * Three guards, each earning its place:
 *   - ZOOMED IMAGES NEVER PAGE. While zoomed the drag is how you reach the
 *     edges of the photo; stealing it would make a zoomed image unreadable.
 *   - The drag must be mostly HORIZONTAL, or dismiss-style vertical flicks and
 *     diagonal fumbles would page.
 *   - It must clear a distance OR a velocity bar, so a fast flick that barely
 *     moves still pages while a slow accidental nudge does not.
 *
 * Returns -1 for previous, +1 for next, 0 to stay. Dragging LEFT (negative
 * translationX) advances, matching every photo carousel the user already knows.
 */
export const SWIPE_MIN_DISTANCE_PX = 56;
export const SWIPE_MIN_VELOCITY = 420;
/** Horizontal travel must beat vertical by this factor to count as a page. */
export const SWIPE_HORIZONTAL_BIAS = 1.4;

export function swipeIntent(params: {
  translationX: number;
  translationY: number;
  /**
   * B-293 — OPTIONAL, and it must stay optional.
   *
   * The first version required this to be a finite number alongside the
   * translations. `onHandlerStateChange`'s native payload does not reliably
   * carry a velocity (it is a state transition, not a motion sample), so
   * `isFinite(undefined)` was false and EVERY swipe was rejected — the feature
   * was completely inert on device while all its unit tests passed, because the
   * tests always supplied a velocity explicitly.
   *
   * Velocity is only ever a BOOST for the flick path. Distance alone must be
   * sufficient to page, so an absent velocity means "unknown", not "no".
   */
  velocityX?:   number;
  /** Current base scale. Anything above rest means the user is zoomed in. */
  scale:        number;
}): -1 | 0 | 1 {
  const {translationX, translationY, scale} = params;
  // Only the fields the decision REQUIRES are validated. Non-finite payloads
  // have shown up on gesture CANCEL, and a bad scale must fail closed (we
  // cannot tell whether the user is zoomed, and stealing a zoomed pan is worse
  // than not paging).
  if (![translationX, translationY, scale].every(n => isFinite(n))) {return 0;}
  // 1.05, not 1: pinch releases settle a hair off exactly 1 and a strict
  // comparison would silently disable paging after the user's first pinch.
  if (scale > 1.05) {return 0;}
  const dx = Math.abs(translationX);
  const dy = Math.abs(translationY);
  if (dx < dy * SWIPE_HORIZONTAL_BIAS) {return 0;}
  // Missing/garbage velocity degrades to 0 — the distance test still decides.
  const vx = typeof params.velocityX === 'number' && isFinite(params.velocityX)
    ? Math.abs(params.velocityX)
    : 0;
  const far  = dx >= SWIPE_MIN_DISTANCE_PX;
  const fast = vx >= SWIPE_MIN_VELOCITY && dx >= SWIPE_MIN_DISTANCE_PX / 3;
  if (!far && !fast) {return 0;}
  return translationX < 0 ? 1 : -1;
}
