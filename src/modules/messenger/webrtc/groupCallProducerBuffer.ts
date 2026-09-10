/**
 * B-06 — buffer `sfu.new-producer` events that arrive BEFORE the recv
 * transport is ready, draining them once the consume pipeline is live.
 *
 * The bug: useGroupCall's boot registered the per-room SFU frame handler at
 * step 7 (after sfu.join at step 3 and recvTransport creation at step 6). A
 * peer that started producing in the window between our join-ack and our
 * recvTransport being wired had its `sfu.new-producer` frame dropped — the
 * handler wasn't subscribed yet, OR the handler was subscribed but
 * `consumeProducer` bailed because `recvTxRef.current` was still null
 * (attemptConsume returns false with no recvTx). Recovery then waited on the
 * 4 s reconcile backstop, so the peer's tile took up to ~4 s to appear.
 *
 * The fix registers the handler as soon as the roomId is known (right after
 * step 1, before sfu.join) and routes early new-producer events through this
 * buffer: while the recv pipeline isn't ready, events are queued; once it is,
 * the queue is drained and every subsequent event consumes immediately. The
 * 4 s reconcile stays as a pure backstop for genuinely-missed frames.
 *
 * Why a standalone module (vs inline in the boot IIFE): the decision —
 * "queue vs consume, drain exactly once, no duplicate consume" — is the
 * load-bearing logic, and useGroupCall.ts imports mediasoup-client /
 * react-native-webrtc at module top (unloadable under the node-based
 * messenger-crypto Jest project). A pure helper here is unit-testable there.
 *
 * This module holds NO key material and never touches media; it only decides
 * when to defer vs forward an already-announced producer descriptor.
 */

export interface BufferedProducer {
  producerId:     string;
  participantTag: string;
  kind:           'audio' | 'video';
}

export interface EarlyProducerBuffer {
  /**
   * Route one new-producer event. If the recv pipeline isn't ready yet
   * (`isReady()` false), the descriptor is queued and `consume` is NOT
   * called. Otherwise it's forwarded to `consume` immediately. Deduping of
   * a producer that arrives both here and via step-9 existingProducers is
   * the responsibility of `consume` itself (consumedProducerIds +
   * inFlightConsumes guard inside consumeProducer).
   */
  accept(p: BufferedProducer): void;
  /**
   * Forward every queued descriptor to `consume` and empty the queue. Safe
   * to call more than once: subsequent calls see an empty queue and do
   * nothing, so a producer is never forwarded twice from the buffer.
   */
  drain(): void;
  /** Current queue depth — for logging/inspection only. */
  size(): number;
}

export function createEarlyProducerBuffer(
  isReady: () => boolean,
  consume: (p: BufferedProducer) => void,
): EarlyProducerBuffer {
  const queue: BufferedProducer[] = [];
  return {
    accept(p: BufferedProducer): void {
      if (isReady()) {
        consume(p);
        return;
      }
      queue.push(p);
    },
    drain(): void {
      if (queue.length === 0) {return;}
      // Splice out the whole batch before forwarding so a re-entrant
      // accept() during consume() (or a second drain()) can't replay an
      // already-drained descriptor.
      const batch = queue.splice(0, queue.length);
      for (const p of batch) {
        consume(p);
      }
    },
    size(): number {
      return queue.length;
    },
  };
}
