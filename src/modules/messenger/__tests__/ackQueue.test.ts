/**
 * SRV-05 — the client-side ack coalescer.
 *
 * The connect-time flush can deliver hundreds of envelopes in a burst and
 * each used to cost its own POST — everything past the relay's per-user ack
 * budget 429'd, was swallowed, and redelivered on the next connect. These
 * pin: batching, the 200ms window, the tokenless-frame guard (part B), the
 * 404 un-upgraded-relay fallback, 429 re-queue, and teardown.
 */

import {enqueueAck, flushAckQueue, disposeAckQueue} from '../transport/ackQueue';
import {RelayHttpError, type RelayHttpClient} from '@bravo/messenger-core';

interface FakeRelay {
  ackBatch: jest.Mock;
  ack: jest.Mock;
}

function makeRelay(): FakeRelay {
  return {
    ackBatch: jest.fn(async (items: unknown[]) => ({results: (items as Array<{envelopeId: string}>).map(i => ({envelopeId: i.envelopeId, status: 'ok'}))})),
    ack: jest.fn(async () => undefined),
  };
}

const asClient = (r: FakeRelay): RelayHttpClient => r as unknown as RelayHttpClient;
const item = (n: number) => ({envelopeId: `env-${n}`, ackToken: `tok-${n}`, disposition: 'delivered' as const});

describe('SRV-05 — ackQueue', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('coalesces a burst into one batch after the 200ms window', async () => {
    const relay = makeRelay();
    for (let i = 0; i < 5; i++) { enqueueAck(asClient(relay), item(i)); }
    expect(relay.ackBatch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(200);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(relay.ackBatch).toHaveBeenCalledTimes(1);
    expect((relay.ackBatch.mock.calls[0][0] as unknown[]).length).toBe(5);
    expect(relay.ack).not.toHaveBeenCalled();
  });

  it('flushes immediately at the 100-item cap', async () => {
    const relay = makeRelay();
    for (let i = 0; i < 100; i++) { enqueueAck(asClient(relay), item(i)); }
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(relay.ackBatch).toHaveBeenCalledTimes(1);
    expect((relay.ackBatch.mock.calls[0][0] as unknown[]).length).toBe(100);
  });

  it('part B — a tokenless (archive-replay) ack is dropped, never POSTed', async () => {
    const relay = makeRelay();
    enqueueAck(asClient(relay), {envelopeId: 'env-x', ackToken: '', disposition: 'delivered'});
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(relay));
    expect(relay.ackBatch).not.toHaveBeenCalled();
    expect(relay.ack).not.toHaveBeenCalled();
  });

  it('falls back to per-envelope acks for the session on a 404 (un-upgraded relay)', async () => {
    const relay = makeRelay();
    relay.ackBatch.mockRejectedValueOnce(new RelayHttpError(404, 'not found'));
    enqueueAck(asClient(relay), item(1));
    enqueueAck(asClient(relay), item(2));
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(relay));
    expect(relay.ackBatch).toHaveBeenCalledTimes(1);
    expect(relay.ack).toHaveBeenCalledTimes(2);
    expect(relay.ack).toHaveBeenCalledWith('env-1', 'tok-1', 'delivered');

    // batchless is sticky for this client instance.
    enqueueAck(asClient(relay), item(3));
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(relay));
    expect(relay.ackBatch).toHaveBeenCalledTimes(1);
    expect(relay.ack).toHaveBeenCalledTimes(3);
  });

  it('a 429 re-queues the batch and retries after the pause', async () => {
    const relay = makeRelay();
    relay.ackBatch.mockRejectedValueOnce(new RelayHttpError(429, 'throttled'));
    enqueueAck(asClient(relay), item(1));
    jest.advanceTimersByTime(200);
    const flushP = flushAckQueue(asClient(relay));
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(10_000);
    await flushP;
    expect(relay.ackBatch).toHaveBeenCalledTimes(2);
    expect((relay.ackBatch.mock.calls[1][0] as Array<{envelopeId: string}>)[0].envelopeId).toBe('env-1');
  });

  it('a non-throttle failure drops the batch (the relay redelivers)', async () => {
    const relay = makeRelay();
    relay.ackBatch.mockRejectedValueOnce(new RelayHttpError(500, 'boom'));
    enqueueAck(asClient(relay), item(1));
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(relay));
    expect(relay.ackBatch).toHaveBeenCalledTimes(1);
    // Nothing left queued: a fresh enqueue is a fresh batch.
    enqueueAck(asClient(relay), item(2));
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(relay));
    expect((relay.ackBatch.mock.calls[1][0] as unknown[]).length).toBe(1);
  });

  it('disposeAckQueue drops pending items and cancels the timer', async () => {
    const relay = makeRelay();
    enqueueAck(asClient(relay), item(1));
    disposeAckQueue(asClient(relay));
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(relay));
    expect(relay.ackBatch).not.toHaveBeenCalled();
  });

  it('separate relay clients have independent queues (logout hygiene)', async () => {
    const a = makeRelay();
    const b = makeRelay();
    enqueueAck(asClient(a), item(1));
    enqueueAck(asClient(b), item(2));
    jest.advanceTimersByTime(200);
    await flushAckQueue(asClient(a));
    await flushAckQueue(asClient(b));
    expect((a.ackBatch.mock.calls[0][0] as Array<{envelopeId: string}>)[0].envelopeId).toBe('env-1');
    expect((b.ackBatch.mock.calls[0][0] as Array<{envelopeId: string}>)[0].envelopeId).toBe('env-2');
  });
});
