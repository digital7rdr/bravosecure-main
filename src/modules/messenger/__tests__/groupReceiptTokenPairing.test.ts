/**
 * B-155 — group messages never advanced past a single tick.
 *
 * Root cause: group fan-out is always submitted over HTTP, and the relay
 * only records a submitter→socket mapping for WS submits (Sealed Sender:
 * HTTP submitters are anonymous), so `envelope.delivered` can NEVER be
 * pushed back to the sender for a group leg. The only recovery path —
 * OM-03's anonymous receipt-poll slot — was gated to `!legIsGroup`, so
 * group bubbles had no way to ever leave single-tick even though the
 * mechanism existed and was already proven for 1:1.
 *
 * The fix asks the relay to park a receipt slot for group legs too
 * (`receipt: true`, unconditionally additive — see relayClient.ts) and
 * keeps `retract_token` paired with `envelope_id` by making both
 * first-wins when a leg is attributed to a recipient (group fan-out):
 * a later leg's token must not clobber the token that pairs with the
 * scalar `envelope_id` an earlier leg already seeded, or the HTTP
 * receipt-poll fallback (`selectReceiptProbes`) would probe a
 * mismatched (envelopeId, retractToken) pair and never resolve.
 *
 * B-187 made the pairing invariant PER-LEG: `retract_tokens` records every
 * leg's token beside `envelope_ids`, and the poll probes every unsettled leg
 * with ITS OWN token. The scalar pair stays first-wins (retract/delete flows
 * still use it), and no probe may ever mix one leg's id with another's token.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));

import {useMessengerStore} from '../store/messengerStore';
import {selectReceiptProbes} from '../runtime/httpReceiptReconcile';
import type {LocalMessage} from '../store/types';

const GROUP = 'group-b155';

function ownGroupMsg(id: string): LocalMessage {
  return {
    id,
    conversation_id: GROUP,
    sender_id: 'self',
    type: 'text',
    content: 'hello team',
    created_at: new Date().toISOString(),
    status: 'sent',
    is_encrypted: true,
    peer: {userId: 'bob', deviceId: 1},
  } as unknown as LocalMessage;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('B-155 — group retract-token pairing stays first-wins', () => {
  it('a second fan-out leg does not clobber the first leg\'s retract_token', () => {
    useMessengerStore.getState().appendMessage(GROUP, ownGroupMsg('m1'));
    const store = useMessengerStore.getState();

    // Bob's leg lands first — seeds both scalars.
    store.updateMessageEnvelopeId(GROUP, 'm1', 'env-bob', 'bob');
    store.updateMessageRetractToken(GROUP, 'm1', 'tok-bob', 'bob');
    // Carol's leg lands second — must NOT overwrite either scalar.
    store.updateMessageEnvelopeId(GROUP, 'm1', 'env-carol', 'carol');
    store.updateMessageRetractToken(GROUP, 'm1', 'tok-carol', 'carol');

    const msg = useMessengerStore.getState().messages[GROUP][0];
    expect(msg.envelope_id).toBe('env-bob');
    expect(msg.retract_token).toBe('tok-bob');
    // Per-recipient maps still record every leg (delivered/read matching +
    // B-187 per-leg probes).
    expect(msg.envelope_ids).toEqual({bob: 'env-bob', carol: 'env-carol'});
    expect(msg.retract_tokens).toEqual({bob: 'tok-bob', carol: 'tok-carol'});
  });

  it('every probe pairs a leg\'s id with THAT leg\'s token (B-187, never mixed)', () => {
    useMessengerStore.getState().appendMessage(GROUP, ownGroupMsg('m1'));
    const store = useMessengerStore.getState();
    store.updateMessageEnvelopeId(GROUP, 'm1', 'env-bob', 'bob');
    store.updateMessageRetractToken(GROUP, 'm1', 'tok-bob', 'bob');
    store.updateMessageEnvelopeId(GROUP, 'm1', 'env-carol', 'carol');
    store.updateMessageRetractToken(GROUP, 'm1', 'tok-carol', 'carol');

    const probes = selectReceiptProbes(useMessengerStore.getState().messages, Date.now(), new Set());
    // B-187: BOTH legs are probed (was: only the scalar pair — the exact
    // reason group ✓✓ could lie), and each pair is internally consistent.
    expect(probes).toHaveLength(2);
    expect(probes).toEqual(expect.arrayContaining([
      {envelopeId: 'env-bob',   retractToken: 'tok-bob'},
      {envelopeId: 'env-carol', retractToken: 'tok-carol'},
    ]));
  });

  it('a 1:1 (no recipientUserId) retract-token update keeps overwriting, unaffected', () => {
    useMessengerStore.getState().appendMessage('c1', {...ownGroupMsg('m1'), conversation_id: 'c1'});
    const store = useMessengerStore.getState();
    store.updateMessageRetractToken('c1', 'm1', 'tok-a');
    store.updateMessageRetractToken('c1', 'm1', 'tok-b');
    expect(useMessengerStore.getState().messages.c1[0].retract_token).toBe('tok-b');
  });
});
