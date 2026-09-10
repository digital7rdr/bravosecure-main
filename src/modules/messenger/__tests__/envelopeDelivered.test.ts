/**
 * Audit P0-T6 — sender-facing `envelope.delivered` handler.
 *
 * The relay emits `envelope.delivered { envelopeId }` to the original
 * submitter device the moment the recipient acks. The local handler
 * advances the matching bubble from single-tick `sent` to double-tick
 * `delivered`. These tests lock in the contract that the rest of the
 * runtime depends on:
 *
 *   1. sent → delivered when envelopeId matches a local bubble.
 *   2. read → read (no regression — a slow delivered after read must
 *      NOT clobber the more-advanced status).
 *   3. delivered → delivered (idempotent — duplicate frames are
 *      no-ops, defending against any future relay misbehaviour).
 *   4. sending / failed → unchanged (we never saw `sent`, so we have
 *      no business painting `delivered`).
 *   5. unknown envelopeId → no-op, doesn't throw, returns 0.
 *   6. only the bubble whose envelope_id matches is touched —
 *      adjacent bubbles in the same conversation are untouched.
 *   7. cross-conversation lookup works (the handler scans every
 *      conversation, since a sender doesn't know which one the
 *      delivered targets until the envelope_id match).
 */

// Mock AsyncStorage before the store loads — the persist middleware in
// `messengerStore.ts` calls into it on every set.
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

import {applyEnvelopeDelivered} from '../runtime/envelopeDelivered';
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
    ...overrides,
  };
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('audit P0-T6 — envelope.delivered handler', () => {
  it('advances a sent bubble to delivered when envelope_id matches', () => {
    const msg = outboundMessage({envelope_id: 'env-42', status: 'sent'});
    useMessengerStore.getState().appendMessage('c1', msg);

    const flipped = applyEnvelopeDelivered('env-42');

    expect(flipped).toBe(1);
    const after = useMessengerStore.getState().messages.c1[0];
    expect(after.status).toBe('delivered');
  });

  it('does NOT regress a bubble already in `read` status', () => {
    const msg = outboundMessage({envelope_id: 'env-1', status: 'read'});
    useMessengerStore.getState().appendMessage('c1', msg);

    const flipped = applyEnvelopeDelivered('env-1');

    expect(flipped).toBe(0);
    const after = useMessengerStore.getState().messages.c1[0];
    expect(after.status).toBe('read');
  });

  it('is idempotent for a bubble already in `delivered`', () => {
    const msg = outboundMessage({envelope_id: 'env-1', status: 'delivered'});
    useMessengerStore.getState().appendMessage('c1', msg);

    const flipped = applyEnvelopeDelivered('env-1');

    expect(flipped).toBe(0);
    const after = useMessengerStore.getState().messages.c1[0];
    expect(after.status).toBe('delivered');
  });

  it.each<MessageStatus>(['sending', 'failed'])(
    'leaves %s untouched (we never observed `sent`)',
    (status) => {
      const msg = outboundMessage({envelope_id: 'env-1', status});
      useMessengerStore.getState().appendMessage('c1', msg);

      const flipped = applyEnvelopeDelivered('env-1');

      expect(flipped).toBe(0);
      const after = useMessengerStore.getState().messages.c1[0];
      expect(after.status).toBe(status);
    },
  );

  it('is a no-op for an unknown envelopeId (returns 0)', () => {
    const msg = outboundMessage({envelope_id: 'env-1', status: 'sent'});
    useMessengerStore.getState().appendMessage('c1', msg);

    const flipped = applyEnvelopeDelivered('env-does-not-exist');

    expect(flipped).toBe(0);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');
  });

  it('touches only the matched bubble — adjacent bubbles untouched', () => {
    const a = outboundMessage({id: 'mA', envelope_id: 'env-A', status: 'sent'});
    const b = outboundMessage({id: 'mB', envelope_id: 'env-B', status: 'sent'});
    const c = outboundMessage({id: 'mC', envelope_id: 'env-C', status: 'sent'});
    const store = useMessengerStore.getState();
    store.appendMessage('c1', a);
    store.appendMessage('c1', b);
    store.appendMessage('c1', c);

    const flipped = applyEnvelopeDelivered('env-B');
    expect(flipped).toBe(1);

    const list = useMessengerStore.getState().messages.c1;
    const byId = Object.fromEntries(list.map(m => [m.id, m.status]));
    expect(byId).toEqual({mA: 'sent', mB: 'delivered', mC: 'sent'});
  });

  it('finds the bubble even if it lives in a different conversation', () => {
    const inC1 = outboundMessage({id: 'm1', conversation_id: 'c1', envelope_id: 'env-X', status: 'sent'});
    const inC2 = outboundMessage({id: 'm2', conversation_id: 'c2', envelope_id: 'env-Y', status: 'sent'});
    const store = useMessengerStore.getState();
    store.appendMessage('c1', inC1);
    store.appendMessage('c2', inC2);

    const flipped = applyEnvelopeDelivered('env-Y');
    expect(flipped).toBe(1);

    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');
    expect(useMessengerStore.getState().messages.c2[0].status).toBe('delivered');
  });

  it('ignores an empty envelopeId', () => {
    const msg = outboundMessage({envelope_id: 'env-1', status: 'sent'});
    useMessengerStore.getState().appendMessage('c1', msg);

    const flipped = applyEnvelopeDelivered('');
    expect(flipped).toBe(0);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('sent');
  });
});
