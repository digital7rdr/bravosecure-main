/**
 * CN-09 — user-facing call-quality signal.
 *
 * The sender-side tuning (600k/32k caps, maintain-framerate) and the 1 Hz
 * stats sampling already existed; what was missing is anything that TELLS THE
 * USER the network is the problem — a degrading call just sounded broken.
 * This module is the pure half: a sample classifier and a debounce gate the
 * call screens drive from their existing stats ticks. Lives outside the
 * screens for the usual reason (messenger-crypto Jest project runs under
 * Node; screens don't).
 */

export interface CallQualitySample {
  rttMs:         number | null;
  jitterMs:      number | null;
  packetLossPct: number | null;
}

/**
 * One sample is "poor" when any metric crosses its threshold. Thresholds are
 * deliberately conservative — the banner must mean "this is audibly bad",
 * not "the network is imperfect":
 *  - RTT > 500 ms: conversational audio is already stepping on itself
 *    (ITU-T G.114 puts one-way > 400 ms as unacceptable for conversation).
 *  - jitter > 80 ms: beyond a typical 60-80 ms adaptive jitter buffer, i.e.
 *    audible warble/drops rather than buffered-away variance.
 *  - loss ≥ 8%: Opus with in-band FEC degrades sharply past ~5-10%.
 * A null metric is IGNORED (no data is not evidence of a bad link — stats
 * rows can be transiently absent mid-renegotiation).
 */
export function isPoorSample(s: CallQualitySample): boolean {
  if (s.rttMs !== null && s.rttMs > 500) {return true;}
  if (s.jitterMs !== null && s.jitterMs > 80) {return true;}
  if (s.packetLossPct !== null && s.packetLossPct >= 8) {return true;}
  return false;
}

/**
 * Debounce gate: the banner shows only after `showAfter` CONSECUTIVE poor
 * samples (~3 s at the screens' 1 Hz feed) and hides only after `hideAfter`
 * consecutive good ones. Asymmetric on purpose — quick enough to explain a
 * bad stretch while it is still happening, slow to clear so a single clean
 * sample can't flap the banner off and straight back on.
 */
export function createQualityGate(opts?: {showAfter?: number; hideAfter?: number}): {
  next: (sample: CallQualitySample) => boolean;
  visible: () => boolean;
  reset: () => void;
} {
  const showAfter = opts?.showAfter ?? 3;
  const hideAfter = opts?.hideAfter ?? 6;
  let poorStreak = 0;
  let goodStreak = 0;
  let visible = false;
  return {
    next(sample: CallQualitySample): boolean {
      if (isPoorSample(sample)) {
        poorStreak += 1;
        goodStreak = 0;
      } else {
        goodStreak += 1;
        poorStreak = 0;
      }
      if (!visible && poorStreak >= showAfter) {
        visible = true;
      } else if (visible && goodStreak >= hideAfter) {
        visible = false;
      }
      return visible;
    },
    visible: () => visible,
    reset(): void {
      poorStreak = 0;
      goodStreak = 0;
      visible = false;
    },
  };
}
