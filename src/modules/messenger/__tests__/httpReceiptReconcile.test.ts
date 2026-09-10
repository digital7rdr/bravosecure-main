/**
 * OM-03 (B-121 G1-RT / NA-GATE-1 design A) — HTTP-submit receipt reconcile.
 *
 * HTTP-submitted envelopes get no `envelope.delivered` push (Sealed
 * Sender: the relay records no submitter), so the sender polls an
 * anonymous, retract-token-gated receipt slot instead. These tests lock
 * the client half:
 *
 *   1. selectReceiptProbes picks only own, single-tick rows that carry
 *      BOTH envelope_id and retract_token, inside the 7-day window,
 *      not already answered 'unknown'.
 *   2. The probe list caps at 100, keeping the newest.
 *   3. 'delivered' advances sent → delivered; 'discarded' flips to
 *      undelivered AND triggers the B-46 auto-resend hook; 'pending'
 *      is a no-op; 'unknown' is a no-op and is never re-probed.
 *   4. A 404 (relay predates the route) latches polling off for the
 *      session — no second request.
 *   5. A stale owner epoch short-circuits before AND after the await.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {
  selectReceiptProbes,
  reconcileHttpReceipts,
  resetReceiptReconcile,
} from '../runtime/httpReceiptReconcile';
import type {ReceiptProbe} from '../runtime/httpReceiptReconcile';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage, MessageStatus} from '../store/types';

function outboundMessage(overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id:              'm-' + Math.random().toString(16).slice(2),
    conversation_id: 'c1',
    sender_id:       'self',
    type:            'text',
    content:         'hi',
    status:          'sent',
    is_encrypted:    true,
    created_at:      new Date().toISOString(),
    peer:            {userId: 'bob', deviceId: 1},
    envelope_id:     'env-1',
    retract_token:   'tok-1',
    ...overrides,
  };
}

const NOW = Date.now();
const noSkip = new Set<string>();

beforeEach(() => {
  useMessengerStore.getState().reset();
  resetReceiptReconcile();
});

describe('selectReceiptProbes (OM-03)', () => {
  it('picks an own sent row carrying envelope_id + retract_token', () => {
    const probes = selectReceiptProbes(
      {c1: [outboundMessage({envelope_id: 'e1', retract_token: 't1'})]},
      NOW,
      noSkip,
    );
    expect(probes).toEqual([{envelopeId: 'e1', retractToken: 't1'}]);
  });

  it('skips peer messages (sender_id !== self)', () => {
    const probes = selectReceiptProbes(
      {c1: [outboundMessage({sender_id: 'bob'})]},
      NOW,
      noSkip,
    );
    expect(probes).toEqual([]);
  });

  it.each<MessageStatus>(['sending', 'failed', 'delivered', 'read', 'undelivered'])(
    'skips %s rows (only single-tick `sent` needs a receipt)',
    status => {
      const probes = selectReceiptProbes(
        {c1: [outboundMessage({status})]},
        NOW,
        noSkip,
      );
      expect(probes).toEqual([]);
    },
  );

  it('skips rows missing envelope_id or retract_token', () => {
    const probes = selectReceiptProbes(
      {
        c1: [
          outboundMessage({envelope_id: undefined}),
          outboundMessage({retract_token: undefined}),
        ],
      },
      NOW,
      noSkip,
    );
    expect(probes).toEqual([]);
  });

  it('skips rows older than the 7-day settled-receipt window', () => {
    const eightDaysAgo = new Date(NOW - 8 * 24 * 3600 * 1000).toISOString();
    const probes = selectReceiptProbes(
      {c1: [outboundMessage({created_at: eightDaysAgo})]},
      NOW,
      noSkip,
    );
    expect(probes).toEqual([]);
  });

  it('skips ids the relay already answered `unknown` for', () => {
    const probes = selectReceiptProbes(
      {c1: [outboundMessage({envelope_id: 'e-dead'})]},
      NOW,
      new Set(['e-dead']),
    );
    expect(probes).toEqual([]);
  });

  it('caps at 100 probes and keeps the newest', () => {
    const rows = Array.from({length: 150}, (_, i) =>
      outboundMessage({id: `m${i}`, envelope_id: `e${i}`, retract_token: `t${i}`}),
    );
    const probes = selectReceiptProbes({c1: rows}, NOW, noSkip);
    expect(probes).toHaveLength(100);
    expect(probes[0].envelopeId).toBe('e50');
    expect(probes[99].envelopeId).toBe('e149');
  });
});

describe('reconcileHttpReceipts (OM-03)', () => {
  const seed = (overrides: Partial<LocalMessage> = {}): void => {
    useMessengerStore.getState().appendMessage('c1', outboundMessage(overrides));
  };
  const ourEpoch = (): boolean => true;

  it("'delivered' advances sent → delivered", async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    await reconcileHttpReceipts({
      fetchReceipts: async () => ({receipts: [{envelopeId: 'e1', outcome: 'delivered'}]}),
      isOurEpoch: ourEpoch,
    });
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('delivered');
  });

  it("'discarded' flips to undelivered AND calls onUndeliverable (B-46 hook)", async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    const onUndeliverable = jest.fn();
    await reconcileHttpReceipts({
      fetchReceipts: async () => ({receipts: [{envelopeId: 'e1', outcome: 'discarded'}]}),
      isOurEpoch: ourEpoch,
      onUndeliverable,
    });
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('undelivered');
    expect(onUndeliverable).toHaveBeenCalledWith('e1');
  });

  it("'pending' is a no-op and the row is re-probed next call", async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    const fetchReceipts = jest.fn(async (items: ReceiptProbe[]) => ({
      receipts: items.map(i => ({envelopeId: i.envelopeId, outcome: 'pending' as const})),
    }));
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    expect(fetchReceipts).toHaveBeenCalledTimes(2);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');
  });

  it("'unknown' is a no-op and the id is NOT re-probed", async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    const fetchReceipts = jest.fn(async (items: ReceiptProbe[]) => ({
      receipts: items.map(i => ({envelopeId: i.envelopeId, outcome: 'unknown' as const})),
    }));
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    expect(fetchReceipts).toHaveBeenCalledTimes(1);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');
  });

  it('a 404 latches the unsupported flag — the second call issues no request', async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    const fetchReceipts = jest.fn(async () => {
      const err = new Error('not found') as Error & {status: number};
      err.status = 404;
      throw err;
    });
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    expect(fetchReceipts).toHaveBeenCalledTimes(1);
  });

  it('a transient failure does NOT latch — the next call retries', async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    const fetchReceipts = jest
      .fn<Promise<{receipts: []}>, [ReceiptProbe[]]>()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), {status: 500}))
      .mockResolvedValueOnce({receipts: []});
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    expect(fetchReceipts).toHaveBeenCalledTimes(2);
  });

  it('a stale epoch short-circuits BEFORE the request', async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    const fetchReceipts = jest.fn(async () => ({receipts: []}));
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => false});
    expect(fetchReceipts).not.toHaveBeenCalled();
  });

  it('a stale epoch after the await writes nothing to the store', async () => {
    seed({envelope_id: 'e1', retract_token: 't1'});
    let epochOk = true;
    await reconcileHttpReceipts({
      fetchReceipts: async () => {
        epochOk = false; // owner switched while the request was in flight
        return {receipts: [{envelopeId: 'e1', outcome: 'delivered'}]};
      },
      isOurEpoch: () => epochOk,
    });
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');
  });

  it('issues no request when there is nothing to probe', async () => {
    const fetchReceipts = jest.fn(async () => ({receipts: []}));
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: ourEpoch});
    expect(fetchReceipts).not.toHaveBeenCalled();
  });
});

describe('B-683/F3 - a terminally destroyed leg stops being probed', () => {
  it('skips the undeliverable leg but keeps probing the live one', () => {
    const probes = selectReceiptProbes(
      {c1: [outboundMessage({
        envelope_id:        'e-bob',
        retract_token:      't-bob',
        envelope_ids:       {bob: 'e-bob', carol: 'e-carol'},
        retract_tokens:     {bob: 't-bob', carol: 't-carol'},
        undeliverable_legs: {carol: 111},
      })]},
      NOW,
      noSkip,
    );
    expect(probes).toEqual([{envelopeId: 'e-bob', retractToken: 't-bob'}]);
  });

  it('every dead leg is skipped - a both-dead row yields no probes', () => {
    // Row-level exit is the status flip ('undelivered' rows fail the 'sent'
    // gate above); this asserts the per-leg skip is exhaustive on the way there.
    const probes = selectReceiptProbes(
      {c1: [outboundMessage({
        envelope_ids:       {bob: 'e-bob', carol: 'e-carol'},
        retract_tokens:     {bob: 't-bob', carol: 't-carol'},
        undeliverable_legs: {bob: 1, carol: 2},
      })]},
      NOW,
      noSkip,
    );
    expect(probes).toEqual([]);
  });
});

/**
 * B-703 MR-16 — the 'unknown' memo must DECAY, not latch for the session.
 *
 * A WS-submitted envelope opens no server receipt slot (the gateway passes no
 * `receipt` to submitEnvelope), so its very first poll answers 'unknown'. A
 * permanent skip then guaranteed it was never asked again — and since the
 * delivered frame's REPLAY emit is fire-and-forget-then-delete, losing that one
 * frame left the bubble at a single tick for the whole session, healed only by
 * a read receipt. That is the founder's "double tick never appears".
 */
describe('B-703 MR-16 — a stuck tick gets another chance', () => {
  const OWN = 'self';
  const AT = Date.parse('2026-08-30T12:00:00.000Z');

  function seedOwnSingleTick(envelopeId: string): void {
    useMessengerStore.getState().reset();
    useMessengerStore.getState().setOwner('owner-1');
    useMessengerStore.setState({
      messages: {
        c1: [{
          id: 'm1', conversation_id: 'c1', sender_id: OWN, type: 'text',
          content: 'hi', status: 'sent', is_encrypted: true,
          created_at: new Date(AT).toISOString(),
          envelope_id: envelopeId, retract_token: 'rt-1',
          peer: {userId: 'peer-1', deviceId: 1},
        } as unknown as LocalMessage],
      },
    } as never);
  }

  beforeEach(() => { resetReceiptReconcile(); });
  afterEach(() => { jest.restoreAllMocks(); });

  it('re-probes after the cooldown instead of never asking again', async () => {
    seedOwnSingleTick('env-ws-1');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(AT);
    const fetchReceipts = jest.fn(async () => ({
      receipts: [{envelopeId: 'env-ws-1', outcome: 'unknown' as const}],
    }));

    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => true});
    expect(fetchReceipts).toHaveBeenCalledTimes(1);

    // Inside the cooldown: skipped, exactly as before — the memo still exists
    // to stop a 60 s poll burning the probe budget.
    nowSpy.mockReturnValue(AT + 60_000);
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => true});
    expect(fetchReceipts).toHaveBeenCalledTimes(1);

    // Past it: asked again. THIS is the fix — a slot that appears later (a
    // redelivery) can now settle the tick.
    nowSpy.mockReturnValue(AT + 5 * 60_000 + 1);
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => true});
    expect(fetchReceipts).toHaveBeenCalledTimes(2);
  });

  it('...and a later slot actually settles the tick', async () => {
    seedOwnSingleTick('env-ws-2');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(AT);
    let outcome: 'unknown' | 'delivered' = 'unknown';
    const fetchReceipts = jest.fn(async () => ({
      receipts: [{envelopeId: 'env-ws-2', outcome}],
    }));

    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => true});
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');

    outcome = 'delivered';
    nowSpy.mockReturnValue(AT + 5 * 60_000 + 1);
    await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => true});
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('delivered');
  });

  it('LATCHES after a bounded number of tries — no unbounded probe stream', async () => {
    seedOwnSingleTick('env-ws-3');
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(AT);
    const fetchReceipts = jest.fn(async () => ({
      receipts: [{envelopeId: 'env-ws-3', outcome: 'unknown' as const}],
    }));

    for (let i = 0; i < 6; i++) {
      nowSpy.mockReturnValue(AT + i * (5 * 60_000 + 1));
      await reconcileHttpReceipts({fetchReceipts, isOurEpoch: () => true});
    }
    // Three attempts, then it stops asking — the reason the memo exists.
    expect(fetchReceipts).toHaveBeenCalledTimes(3);
  });
});
