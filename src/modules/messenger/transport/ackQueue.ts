import {RelayHttpClient, RelayHttpError} from '@bravo/messenger-core';

/**
 * SRV-05 — coalesce per-envelope acks into one `/envelopes/ack-batch`
 * request. The connect-time flush can deliver thousands of envelopes in
 * a burst and each one used to cost its own POST, blowing past the
 * relay's per-user ack budget; everything past the cap 429'd, was
 * swallowed, and redelivered on the next connect.
 *
 * Keyed on the RelayHttpClient instance so a logout/user-switch (which
 * builds a fresh client) starts with a clean queue.
 */

export interface AckItem {
  envelopeId: string;
  ackToken: string;
  disposition?: 'delivered' | 'discarded';
}

interface QueueState {
  pending: AckItem[];
  timer: ReturnType<typeof setTimeout> | null;
  inflight: Promise<void> | null;
  batchless: boolean;
  retries: number;
}

const MAX_BATCH = 100;
const FLUSH_MS = 200;
const MAX_RETRIES = 3;

const queues = new WeakMap<RelayHttpClient, QueueState>();

function stateFor(relay: RelayHttpClient): QueueState {
  let s = queues.get(relay);
  if (!s) {
    s = {pending: [], timer: null, inflight: null, batchless: false, retries: 0};
    queues.set(relay, s);
  }
  return s;
}

/**
 * Queue one ack. Fire-and-forget by design — every call site already
 * treated a failed ack as "the relay will redeliver", and the receive-side
 * `seenEnvelopes` gate makes a redelivery cheap.
 *
 * SRV-05 part B — a falsy token is an archive-replay frame
 * (liveReplayArchive), never a relay delivery: with requireAckToken the
 * POST can only 403 or no-op, but it still burns the per-user ack budget
 * the real drain needs. Dropped here, in one place.
 */
export function enqueueAck(relay: RelayHttpClient, item: AckItem): void {
  if (!item.ackToken) {
    return;
  }
  const s = stateFor(relay);
  s.pending.push(item);
  if (s.pending.length >= MAX_BATCH) {
    void flushAckQueue(relay);
    return;
  }
  if (s.timer === null) {
    s.timer = setTimeout(() => {
      s.timer = null;
      void flushAckQueue(relay);
    }, FLUSH_MS);
  }
}

/** Flush now. Safe to call concurrently — overlapping calls share one run. */
export async function flushAckQueue(relay: RelayHttpClient): Promise<void> {
  const s = stateFor(relay);
  if (s.inflight) {
    return s.inflight;
  }
  if (s.pending.length === 0) {
    return;
  }
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }

  const run = async (): Promise<void> => {
    while (s.pending.length > 0) {
      const batch = s.pending.splice(0, MAX_BATCH);
      try {
        if (s.batchless) {
          await ackOneByOne(relay, batch);
        } else {
          await relay.ackBatch(batch);
        }
        s.retries = 0;
      } catch (e) {
        const status = e instanceof RelayHttpError ? e.status : 0;
        if (status === 404 || status === 405) {
          // Relay not upgraded yet — permanent for this session.
          s.batchless = true;
          s.pending.unshift(...batch);
          continue;
        }
        if (status === 429 && s.retries < MAX_RETRIES) {
          // Re-queue and let the throttle window pass. Anything still
          // unacked after the retries simply redelivers.
          s.retries += 1;
          s.pending.unshift(...batch);
          await new Promise(r => setTimeout(r, 10_000));
          continue;
        }
        // Drop this batch: the relay keeps the envelopes and redelivers.
        s.retries = 0;
      }
    }
  };

  s.inflight = run().finally(() => {
    s.inflight = null;
  });
  return s.inflight;
}

/** Teardown hook — drop anything still queued for a dead runtime. */
export function disposeAckQueue(relay: RelayHttpClient): void {
  const s = queues.get(relay);
  if (!s) {
    return;
  }
  if (s.timer !== null) {
    clearTimeout(s.timer);
    s.timer = null;
  }
  s.pending.length = 0;
}

async function ackOneByOne(relay: RelayHttpClient, batch: AckItem[]): Promise<void> {
  for (const item of batch) {
    try {
      await relay.ack(item.envelopeId, item.ackToken, item.disposition);
    } catch {
      /* relay redelivers */
    }
  }
}
