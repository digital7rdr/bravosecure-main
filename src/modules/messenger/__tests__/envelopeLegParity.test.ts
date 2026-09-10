/**
 * SYNC-1 / B-143 / B-683 leg parity — `envelope.delivered` vs
 * `envelope.undeliverable`.
 *
 * A group fan-out stamps one envelope id per recipient into
 * `envelope_ids` (`updateMessageEnvelopeId`), seeding the scalar
 * `envelope_id` from the FIRST leg only. B-143 made the undeliverable
 * handler match every leg (parity with `applyEnvelopeDelivered`), with
 * an interim ANY-leg-destroyed ⇒ whole-bubble flip.
 *
 * B-683 closes B-143's recorded open question with the ALL-legs rule:
 * a leg-matched verdict records THAT member's failure
 * (`recordUndeliverableLeg`), and the scalar flips to 'undelivered'
 * only when every CURRENT participant has a shipped leg, that leg is
 * dead, and none holds a delivered/read receipt — the failure-side
 * mirror of the delivered side's B-187 all-legs aggregate. One member's
 * dead session must never red a message the other members hold
 * (founder screenshot, 2026-08-27). Scalar-only rows (1:1/legacy) keep
 * the immediate flip; a verdict matching only a map-bearing row's STALE
 * scalar is ignored. Audit:
 * docs/audits/FEED_TICKER_FALSE_RETRY_AUDIT_2026-08-27.md §2.
 *
 * SEEDING NOTE (vacuous-pass trap): the B-683 predicate reads
 * `conversations[id].participants`, so every group case MUST seed a
 * real conversation row — a bare appendMessage would exercise the
 * empty-roster guard and pass for the wrong reason.
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

import {applyEnvelopeUndeliverable} from '../runtime/decryptFailureSignal';
import {applyEnvelopeDelivered} from '../runtime/envelopeDelivered';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage, MessageStatus} from '../store/types';

function groupOutbound(status: MessageStatus): LocalMessage {
  return {
    id:              'm-' + Math.random().toString(16).slice(2),
    conversation_id: 'g1',
    sender_id:       'self',
    type:            'text',
    content:         'hi group',
    status,
    is_encrypted:    true,
    created_at:      new Date().toISOString(),
    peer:            {userId: 'bob', deviceId: 1},
  };
}

const statusOf = (id: string): MessageStatus | undefined =>
  useMessengerStore.getState().messages.g1?.find(m => m.id === id)?.status;

const legsOf = (id: string): Record<string, number> | undefined =>
  useMessengerStore.getState().messages.g1?.find(m => m.id === id)?.undeliverable_legs;

function seedGroupConv(participants: string[]): void {
  useMessengerStore.getState().upsertConversation({
    id: 'g1', type: 'group', participants,
    unread_count: 0, is_muted: false,
    created_at: new Date().toISOString(),
    peer: {userId: participants[0] ?? 'bob', deviceId: 1},
  } as never);
}

/** Append + stamp two fan-out legs: bob first (seeds the scalar), carol second. */
function seedTwoLegs(status: MessageStatus, participants: string[] = ['bob', 'carol']): string {
  seedGroupConv(participants);
  const msg = groupOutbound(status);
  const store = useMessengerStore.getState();
  store.appendMessage('g1', msg);
  store.updateMessageEnvelopeId('g1', msg.id, 'env-bob', 'bob');
  store.updateMessageEnvelopeId('g1', msg.id, 'env-carol', 'carol');
  return msg.id;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('SYNC-1 controls — the delivered side is unchanged', () => {
  it('delivered via the first leg advances sent → delivered (2-leg row needs both)', () => {
    const id = seedTwoLegs('sent');
    // One leg delivered does NOT complete the B-187 aggregate…
    applyEnvelopeDelivered('env-bob');
    expect(statusOf(id)).toBe('sent');
    // …both do.
    applyEnvelopeDelivered('env-carol');
    expect(statusOf(id)).toBe('delivered');
  });
});

describe('B-683 — partial failure keeps the bubble honest', () => {
  it('one dead leg (first/scalar-seeding) records the leg and does NOT flip', () => {
    const id = seedTwoLegs('sent');
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(0);
    expect(statusOf(id)).toBe('sent');
    expect(legsOf(id)).toEqual({bob: expect.any(Number)});
  });

  it('one dead leg (second/map-only) records the leg and does NOT flip', () => {
    const id = seedTwoLegs('sent');
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(0);
    expect(statusOf(id)).toBe('sent');
    expect(legsOf(id)).toEqual({carol: expect.any(Number)});
  });

  it('a delivered bubble is NOT downgraded by one leg destroy', () => {
    const id = seedTwoLegs('delivered');
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(0);
    expect(statusOf(id)).toBe('delivered');
  });

  it('delivered receipts still flow after a partial failure (the sticky-red killer)', () => {
    const id = seedTwoLegs('sent');
    applyEnvelopeUndeliverable('env-carol');
    expect(statusOf(id)).toBe('sent');
    // bob's delivered receipt lands and is recorded — pre-B-683 the flip
    // had already left 'sent' and envelopeDelivered dropped this receipt.
    applyEnvelopeDelivered('env-bob');
    const msg = useMessengerStore.getState().messages.g1?.find(m => m.id === id);
    expect(msg?.receipts?.bob?.status).toBe('delivered');
  });

  it('the outcome does not depend on fan-out ORDER (property kept, new expected state)', () => {
    const first = seedTwoLegs('sent');
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(0);
    const firstResult = statusOf(first);

    useMessengerStore.getState().reset();
    const second = seedTwoLegs('sent');
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(0);
    expect(statusOf(second)).toBe(firstResult);
    expect(firstResult).toBe('sent');
  });
});

describe('B-683 — total failure still reds the bubble (the B-143 protection survives)', () => {
  it('ALL legs dead flips sent → undelivered on the completing verdict', () => {
    const id = seedTwoLegs('sent');
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(0);
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(1);
    expect(statusOf(id)).toBe('undelivered');
  });

  it('2-member group (one recipient): the single destroy is total — flips', () => {
    seedGroupConv(['bob']);
    const msg = groupOutbound('sent');
    const store = useMessengerStore.getState();
    store.appendMessage('g1', msg);
    store.updateMessageEnvelopeId('g1', msg.id, 'env-bob', 'bob');
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(1);
    expect(statusOf(msg.id)).toBe('undelivered');
  });

  it('a delivered/read receipt on any required member blocks the flip', () => {
    const id = seedTwoLegs('sent');
    applyEnvelopeDelivered('env-bob'); // records bob's receipt (no scalar flip yet)
    applyEnvelopeUndeliverable('env-carol');
    // carol dead + bob delivered: not a total failure.
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(0);
    expect(statusOf(id)).toBe('sent');
  });
});

describe('B-683 — completeness + staleness guards', () => {
  it('an unshipped participant (deferred leg) blocks the flip', () => {
    // dave is in the roster but has no envelope id — his outbox row is
    // still owed a drain; the message may yet reach him.
    const id = seedTwoLegs('sent', ['bob', 'carol', 'dave']);
    applyEnvelopeUndeliverable('env-bob');
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(0);
    expect(statusOf(id)).toBe('sent');
  });

  it('an empty roster never flips via legs (audience-less message)', () => {
    const id = seedTwoLegs('sent', []);
    applyEnvelopeUndeliverable('env-bob');
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(0);
    expect(statusOf(id)).toBe('sent');
  });

  it('a member removed after send neither blocks nor triggers', () => {
    // carol left the group; bob (the only current member) is dead ⇒ total.
    const id = seedTwoLegs('sent', ['bob', 'carol']);
    seedGroupConv(['bob']);
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(1);
    expect(statusOf(id)).toBe('undelivered');
  });

  it('verdicts are value-level idempotent (60s poll re-fire)', () => {
    const id = seedTwoLegs('sent');
    // Explicit distinct timestamps — first-noted wins, the re-fire is a no-op.
    useMessengerStore.getState().recordUndeliverableLeg('g1', id, 'carol', 111);
    useMessengerStore.getState().recordUndeliverableLeg('g1', id, 'carol', 222);
    expect(legsOf(id)?.carol).toBe(111);
    expect(statusOf(id)).toBe('sent');
  });

  it('a verdict matching only a STALE scalar on a map-bearing row is ignored', () => {
    seedGroupConv(['bob']);
    const msg = groupOutbound('sent');
    // Round-1 scalar survives a partial artifact state; the map holds the
    // round-2 leg. The dead attempt's verdict must not red the retry.
    msg.envelope_id = 'env-old';
    msg.envelope_ids = {bob: 'env-b2'};
    useMessengerStore.getState().appendMessage('g1', msg);
    expect(applyEnvelopeUndeliverable('env-old')).toBe(0);
    expect(statusOf(msg.id)).toBe('sent');
    expect(legsOf(msg.id)).toBeUndefined();
  });

  it('a read bubble still wins over a late destroy on any leg', () => {
    const id = seedTwoLegs('read');
    applyEnvelopeUndeliverable('env-bob');
    expect(applyEnvelopeUndeliverable('env-carol')).toBe(0);
    expect(statusOf(id)).toBe('read');
  });

  it('an unknown envelope id still matches nothing', () => {
    const id = seedTwoLegs('sent');
    expect(applyEnvelopeUndeliverable('env-nobody')).toBe(0);
    expect(statusOf(id)).toBe('sent');
  });
});

describe('B-683 — scalar-only rows keep 1:1 semantics byte-identical', () => {
  it('a mapless row flips immediately on its scalar match', () => {
    seedGroupConv(['bob']);
    const msg = groupOutbound('sent');
    msg.envelope_id = 'env-solo';
    useMessengerStore.getState().appendMessage('g1', msg);
    expect(applyEnvelopeUndeliverable('env-solo')).toBe(1);
    expect(statusOf(msg.id)).toBe('undelivered');
  });
});

describe('B-683/F2 — resetWireArtifactsForResend clears every round-1 artifact', () => {
  it('scalar id/token, both maps, and the failure records are all gone', () => {
    const id = seedTwoLegs('sent');
    const store = useMessengerStore.getState();
    store.updateMessageRetractToken('g1', id, 'tok-bob', 'bob');
    store.updateMessageRetractToken('g1', id, 'tok-carol', 'carol');
    applyEnvelopeUndeliverable('env-bob');
    applyEnvelopeUndeliverable('env-carol');
    expect(statusOf(id)).toBe('undelivered');

    store.resetWireArtifactsForResend('g1', id);
    const msg = useMessengerStore.getState().messages.g1?.find(m => m.id === id);
    expect(msg?.envelope_id).toBeUndefined();
    expect(msg?.retract_token).toBeUndefined();
    expect(msg?.envelope_ids).toBeUndefined();
    expect(msg?.retract_tokens).toBeUndefined();
    expect(msg?.undeliverable_legs).toBeUndefined();
    // …and a late round-1 verdict now matches nothing at all.
    expect(applyEnvelopeUndeliverable('env-bob')).toBe(0);
  });
});
