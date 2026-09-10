/**
 * GF-6 — partition the due outbox into per-recipient lanes and run a bounded
 * number of them at once.
 *
 * The drain used to be one flat serial loop over every due row. Each relay POST
 * is capped at TRANSPORT_TIMEOUT_MS (20s, SN-01), so a single black-holing peer
 * stalled every queued message to every OTHER peer for 20s — and the drain's
 * in-flight coalescing meant the 60s retry tick and every reconnect drain were
 * no-ops for the whole stall.
 *
 * Lanes are keyed `${peerUserId}.${peerDeviceId}` — byte-identical to the
 * SessionManager per-address ratchet mutex key — so parallel lanes can never
 * touch the same Double Ratchet chain, and per-peer send order is preserved
 * (rows arrive from `dueRows()` in created_at order and a lane runs serially).
 *
 * Kept out of productionRuntime.ts so the scheduling can be unit-tested without
 * standing up the messenger runtime.
 */

/**
 * How many recipients we ship to at once.
 *
 * Sized against the relay's own submit throttle (RELAY-1: 300/60s per user):
 * four lanes drain a large fan-out ~4x faster while staying far inside the
 * window on a normal-latency link, and the drain's stop-on-429 backoff
 * (classifyOutboxFailure → 'server-transient' → lane stop + booked re-drain)
 * self-limits if we ever do overrun it.
 *
 * If the B-75 "backup got slow" symptom (txnChain pressure) appears on device,
 * drop to 3 — never bypass the chain.
 */
export const OUTBOX_DRAIN_LANE_LIMIT = 4;

/** Signal from a lane worker: keep going, or abandon the whole drain pass. */
export type LaneStep = 'continue' | 'stop';

export interface PeerAddressedRow {
  peerUserId: string;
  peerDeviceId: number;
}

export function outboxLaneKey(row: PeerAddressedRow): string {
  return `${row.peerUserId}.${row.peerDeviceId}`;
}

/**
 * Group rows into per-recipient lanes. Lane order follows first appearance, so
 * with a `created_at ASC` input the oldest-waiting recipients start first; row
 * order inside a lane is unchanged.
 */
export function groupRowsByPeer<T extends PeerAddressedRow>(rows: readonly T[]): T[][] {
  const lanes = new Map<string, T[]>();
  for (const row of rows) {
    const key = outboxLaneKey(row);
    const existing = lanes.get(key);
    if (existing) {
      existing.push(row);
    } else {
      lanes.set(key, [row]);
    }
  }
  return Array.from(lanes.values());
}

/**
 * Run `worker` over every row, at most `limit` lanes concurrently, one row at a
 * time within a lane. A worker that returns 'stop' halts the pass: no further
 * rows are started in ANY lane (used for the epoch bail, the OM-07 drain
 * budget, and the server-transient backoff).
 *
 * `worker` is expected never to throw — the caller owns per-row error handling.
 * A throw is still contained so one bad row cannot reject the whole drain.
 */
export async function runOutboxLanes<T>(
  lanes: readonly T[][],
  limit: number,
  worker: (row: T) => Promise<LaneStep>,
): Promise<void> {
  if (lanes.length === 0) {
    return;
  }
  let cursor = 0;
  let stopped = false;
  const pump = async (): Promise<void> => {
    while (!stopped) {
      const lane = lanes[cursor++];
      if (!lane) {
        return;
      }
      for (const row of lane) {
        if (stopped) {
          return;
        }
        let step: LaneStep;
        try {
          step = await worker(row);
        } catch {
          step = 'continue';
        }
        if (step === 'stop') {
          stopped = true;
          return;
        }
      }
    }
  };
  const width = Math.min(Math.max(1, limit), lanes.length);
  await Promise.all(Array.from({length: width}, () => pump()));
}
