/**
 * B-187 — group ✓✓ is ALL-LEGS (FIXED; this file previously pinned the
 * first-leg-wins bug DOCUMENTS-style, flipped in the fix commit).
 *
 * Founder: "double tick is shown immediately after sending the message."
 *
 * The fix has three legs of its own:
 *
 *   1. `applyEnvelopeDelivered` — a group leg records THAT member's receipt
 *      (`recordDeliveredReceipt`); the scalar status flips 'sent' →
 *      'delivered' only when every member of the required set
 *      (participants(non-self) ∩ shipped envelope_ids keys — the exact
 *      B-116/B-186 read rule) has delivered|read. Scalar-only rows
 *      (1:1 / legacy / restored pre-v17) keep the original any-ack rule.
 *   2. `LocalMessage.retract_tokens` (schema v19) — per-recipient retract
 *      tokens, the pair to `envelope_ids`, mirrored through backup so a
 *      restore keeps probing every leg.
 *   3. `selectReceiptProbes` — probes EVERY unsettled leg, not just the
 *      first. Rows predating v19 (map of ids but no map of tokens)
 *      grandfather to the scalar single probe.
 *
 * B-155 regression guard: requiring all legs while probing only the first
 * would strand group bubbles at ✓ forever — the per-leg probe cases below
 * are what keep that class dead.
 *
 * Do NOT delete these cases to make a run green (CLAUDE.md bug-regression
 * contract).
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

import {useMessengerStore} from '../store/messengerStore';
import {applyEnvelopeDelivered} from '../runtime/envelopeDelivered';
import {selectReceiptProbes} from '../runtime/httpReceiptReconcile';
import type {LocalMessage} from '../store/types';

const CONVO = 'group-abc';
const NOW = 1_753_248_000_000;

/** Our own outbound group message, fanned out to three members. */
function threeLegMessage(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id: 'm1',
    conversation_id: CONVO,
    sender_id: 'self',
    body: 'hello team',
    created_at: new Date(NOW).toISOString(),
    status: 'sent',
    // First-wins scalars — seeded by whichever leg the send loop settled first.
    envelope_id: 'env-alice',
    retract_token: 'tok-alice',
    envelope_ids: {alice: 'env-alice', bob: 'env-bob', carol: 'env-carol'},
    retract_tokens: {alice: 'tok-alice', bob: 'tok-bob', carol: 'tok-carol'},
    ...over,
  } as unknown as LocalMessage;
}

function seed(msg: LocalMessage): void {
  useMessengerStore.setState({
    messages: {[CONVO]: [msg]},
    // The required set derives from the conversation roster — without it the
    // store falls back to the direct rule and one ack would flip the bubble.
    conversations: {
      [CONVO]: {
        id: CONVO,
        type: 'group',
        name: 'Team',
        participants: ['alice', 'bob', 'carol'],
      },
    },
  } as never);
}

beforeEach(() => { seed(threeLegMessage()); });

describe('B-187 — group double-tick is all-legs (B-187 fixed)', () => {
  it('ONE of three legs delivering must NOT paint the whole bubble ✓✓', () => {
    // Only Bob's device acked. Alice and Carol have not received anything.
    const flipped = applyEnvelopeDelivered('env-bob');

    expect(flipped).toBe(0);
    const msg = useMessengerStore.getState().messages[CONVO][0];
    expect(msg.status).toBe('sent');
    // The ack is not lost — it is recorded as Bob's per-member receipt.
    expect(msg.receipts?.bob).toEqual({status: 'delivered', ts: expect.any(Number)});
  });

  it('any leg id is accepted, not just the scalar envelope_id (B-155 guard)', () => {
    // Carol's id is NOT the scalar — her ack must still be attributed, or
    // group rows regress to "stuck at one tick" (B-155).
    applyEnvelopeDelivered('env-carol');
    const msg = useMessengerStore.getState().messages[CONVO][0];
    expect(msg.receipts?.carol?.status).toBe('delivered');
  });

  it('all three legs delivering flips the bubble ✓✓ — and only then', () => {
    expect(applyEnvelopeDelivered('env-alice')).toBe(0);
    expect(applyEnvelopeDelivered('env-bob')).toBe(0);
    expect(useMessengerStore.getState().messages[CONVO][0].status).toBe('sent');

    expect(applyEnvelopeDelivered('env-carol')).toBe(1);
    expect(useMessengerStore.getState().messages[CONVO][0].status).toBe('delivered');
  });

  it('a member already at read is never demoted by a late delivered', () => {
    useMessengerStore.getState().recordReadReceipts(CONVO, ['m1'], 'bob', NOW + 1);
    applyEnvelopeDelivered('env-bob');
    const msg = useMessengerStore.getState().messages[CONVO][0];
    expect(msg.receipts?.bob?.status).toBe('read');
  });

  it('read counts as settled for the delivered aggregate', () => {
    useMessengerStore.getState().recordReadReceipts(CONVO, ['m1'], 'alice', NOW + 1);
    applyEnvelopeDelivered('env-bob');
    expect(applyEnvelopeDelivered('env-carol')).toBe(1);
    expect(useMessengerStore.getState().messages[CONVO][0].status).toBe('delivered');
  });

  it('the receipt poll probes EVERY leg with its own token', () => {
    const probes = selectReceiptProbes(
      useMessengerStore.getState().messages, NOW + 1000, new Set(),
    );

    expect(probes).toHaveLength(3);
    expect(probes).toEqual(expect.arrayContaining([
      {envelopeId: 'env-alice', retractToken: 'tok-alice'},
      {envelopeId: 'env-bob',   retractToken: 'tok-bob'},
      {envelopeId: 'env-carol', retractToken: 'tok-carol'},
    ]));
  });

  it('a settled leg leaves the probe set; unsettled legs stay', () => {
    applyEnvelopeDelivered('env-bob');
    const ids = selectReceiptProbes(
      useMessengerStore.getState().messages, NOW + 1000, new Set(),
    ).map(p => p.envelopeId);

    expect(ids).toHaveLength(2);
    expect(ids).toEqual(expect.arrayContaining(['env-alice', 'env-carol']));
    expect(ids).not.toContain('env-bob');
  });

  it('a bubble at `delivered` is not re-probed (no infinite poll)', () => {
    applyEnvelopeDelivered('env-alice');
    applyEnvelopeDelivered('env-bob');
    applyEnvelopeDelivered('env-carol');
    const probes = selectReceiptProbes(
      useMessengerStore.getState().messages, NOW + 1000, new Set(),
    );
    // selectReceiptProbes only takes status === 'sent' — a completed
    // aggregate leaves the probe set entirely.
    expect(probes).toHaveLength(0);
  });

  it('a pre-v19 row (ids map, NO tokens map) grandfathers to the scalar single probe', () => {
    seed(threeLegMessage({retract_tokens: undefined}));
    const probes = selectReceiptProbes(
      useMessengerStore.getState().messages, NOW + 1000, new Set(),
    );
    // Its per-leg tokens are simply gone; the scalar pair is all it has.
    expect(probes).toEqual([{envelopeId: 'env-alice', retractToken: 'tok-alice'}]);
  });
});
