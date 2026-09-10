/**
 * Regression — B-15: no indicator when a remote video tile decodes 0 frames.
 *
 * On a non-admin-hosted video call (B-10) — and on any decrypt/SFU stall —
 * the remote tile showed a live video plane that never painted (EglRenderer
 * "Frames received: 0"). The user couldn't tell "camera off" from "video
 * broken". The hook now tracks framesDecoded per tag across stats ticks and
 * flags a tag as stalled when an UNPAUSED video consumer hasn't advanced for
 * >3s; GroupCallScreen overlays "Video unavailable" on those tiles.
 *
 * This pins the pure stall decision the poller makes, with no WebRTC stack.
 */

const VIDEO_STALL_MS = 3_000;

type Snap = {frames: number; lastAdvanceMs: number};

// Mirrors the per-tag fold in useGroupCall.ts audio/video stats tick.
// Returns the updated snapshot + whether the tag is now considered stalled.
function step(
  prev: Snap | undefined,
  frames: number,
  nowMs: number,
): {snap: Snap; stalled: boolean} {
  if (!prev) {return {snap: {frames, lastAdvanceMs: nowMs}, stalled: false};}
  if (frames > prev.frames) {return {snap: {frames, lastAdvanceMs: nowMs}, stalled: false};}
  return {snap: prev, stalled: nowMs - prev.lastAdvanceMs > VIDEO_STALL_MS};
}

describe('B-15 — video stall detection', () => {
  it('is not stalled on the first reading (grace window starts)', () => {
    const r = step(undefined, 0, 1_000);
    expect(r.stalled).toBe(false);
  });

  it('is not stalled while frames keep advancing', () => {
    let snap = step(undefined, 10, 1_000).snap;
    const r1 = step(snap, 25, 1_500); snap = r1.snap;
    const r2 = step(snap, 40, 2_000);
    expect(r1.stalled).toBe(false);
    expect(r2.stalled).toBe(false);
  });

  it('is NOT yet stalled when frames stop but <3s have elapsed', () => {
    const snap = step(undefined, 100, 1_000).snap;
    const r = step(snap, 100, 1_000 + 2_500); // 2.5s of no advance
    expect(r.stalled).toBe(false);
  });

  it('IS stalled when frames stop and >3s elapse (the 0-frames bug)', () => {
    const snap = step(undefined, 100, 1_000).snap;
    const r = step(snap, 100, 1_000 + 3_500); // 3.5s of no advance
    expect(r.stalled).toBe(true);
  });

  it('recovers (clears stall) once frames advance again', () => {
    let snap = step(undefined, 100, 1_000).snap;
    const stalledR = step(snap, 100, 5_000);
    expect(stalledR.stalled).toBe(true);
    // A later tick with a higher framesDecoded resets the window.
    const recovered = step(stalledR.snap, 130, 5_500);
    expect(recovered.stalled).toBe(false);
  });

  it('a brand-new producer at 0 frames is not instantly flagged', () => {
    // Tag just started a video consumer; first reading is 0 — grace, not stall.
    const r = step(undefined, 0, 10_000);
    expect(r.stalled).toBe(false);
  });
});
