/**
 * Delivery-failure signalling (handoff §3.6 (a)+(c)) — receiver-side
 * truth carrier for destroyed envelopes:
 *
 *   1. noteDestroyedEnvelope/takeDestroyedEnvelope hand the "this will
 *      never render" verdict from the deep receive path to the ack
 *      site (take is consume-once so a later envelope with the same id
 *      can't inherit a stale verdict).
 *   2. insertDecryptFailurePlaceholder leaves exactly ONE persistent
 *      gap marker per envelopeId, no matter how many times WS + drain
 *      redeliver the same failure.
 *   3. applyEnvelopeUndeliverable flips the sender bubble sent →
 *      undelivered, overrides a raced-ahead delivered, never regresses
 *      read, and is idempotent.
 *   4. A late `envelope.delivered` cannot repaint an undelivered
 *      bubble (applyEnvelopeDelivered only advances from `sent`).
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
  noteDestroyedEnvelope,
  takeDestroyedEnvelope,
  insertDecryptFailurePlaceholder,
  applyEnvelopeUndeliverable,
  placeholderMessageId,
  _resetDestroyedEnvelopes,
} from '../runtime/decryptFailureSignal';
import {applyEnvelopeDelivered} from '../runtime/envelopeDelivered';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage, MessageStatus} from '../store/types';

const PEER = {userId: 'u-peer', deviceId: 1};

function outbound(status: MessageStatus, envelopeId = 'env-1'): LocalMessage {
  return {
    id:              'm-' + Math.random().toString(16).slice(2),
    conversation_id: 'c1',
    sender_id:       'self',
    type:            'text',
    content:         'hi',
    status,
    is_encrypted:    true,
    created_at:      new Date().toISOString(),
    peer:            PEER,
    envelope_id:     envelopeId,
  };
}

beforeEach(() => {
  useMessengerStore.getState().reset();
  _resetDestroyedEnvelopes();
});

describe('noteDestroyedEnvelope / takeDestroyedEnvelope', () => {
  it('take returns the note exactly once (consume semantics)', () => {
    noteDestroyedEnvelope({envelopeId: 'e1', reason: 'aad:future', peer: PEER});
    expect(takeDestroyedEnvelope('e1')?.reason).toBe('aad:future');
    expect(takeDestroyedEnvelope('e1')).toBeUndefined();
  });

  it('unknown / missing ids return undefined', () => {
    expect(takeDestroyedEnvelope('nope')).toBeUndefined();
    expect(takeDestroyedEnvelope(undefined)).toBeUndefined();
  });

  it('is bounded — old notes evict, never grows unbounded', () => {
    for (let i = 0; i < 250; i++) {
      noteDestroyedEnvelope({envelopeId: `e-${i}`, reason: 'x'});
    }
    expect(takeDestroyedEnvelope('e-0')).toBeUndefined();   // evicted
    expect(takeDestroyedEnvelope('e-249')).toBeTruthy();    // newest kept
  });
});

describe('insertDecryptFailurePlaceholder', () => {
  it('appends exactly one persistent system row per envelopeId', () => {
    const first = insertDecryptFailurePlaceholder({
      conversationId: 'c1', peer: PEER, envelopeId: 'env-9', reason: 'group-tamper',
    });
    expect(first).toBeTruthy();
    expect(first!.id).toBe(placeholderMessageId('env-9'));
    expect(first!.type).toBe('system');

    // WS redelivery / drain retry of the same envelope — deduped.
    const second = insertDecryptFailurePlaceholder({
      conversationId: 'c1', peer: PEER, envelopeId: 'env-9', reason: 'group-tamper',
    });
    expect(second).toBeNull();

    const rows = useMessengerStore.getState().messages.c1.filter(
      m => m.id === placeholderMessageId('env-9'),
    );
    expect(rows).toHaveLength(1);
  });

  it('placeholder content never contains ciphertext or reason internals', () => {
    const msg = insertDecryptFailurePlaceholder({
      conversationId: 'c1', peer: PEER, envelopeId: 'env-z', reason: 'aad:binding sender=SECRET',
    });
    expect(msg!.content).not.toContain('SECRET');
    expect(msg!.content).toMatch(/couldn't be decrypted/i);
  });

  it('no-ops without an envelopeId or conversationId', () => {
    expect(insertDecryptFailurePlaceholder({
      conversationId: '', peer: PEER, envelopeId: 'e', reason: 'x',
    })).toBeNull();
    expect(insertDecryptFailurePlaceholder({
      conversationId: 'c1', peer: PEER, envelopeId: '', reason: 'x',
    })).toBeNull();
  });
});

describe('applyEnvelopeUndeliverable (sender tick)', () => {
  it('flips sent → undelivered on envelope match', () => {
    useMessengerStore.getState().appendMessage('c1', outbound('sent', 'env-42'));
    expect(applyEnvelopeUndeliverable('env-42')).toBe(1);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('undelivered');
  });

  it('overrides a raced-ahead delivered (the ✓✓ lie loses)', () => {
    useMessengerStore.getState().appendMessage('c1', outbound('delivered', 'env-42'));
    expect(applyEnvelopeUndeliverable('env-42')).toBe(1);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('undelivered');
  });

  it('never regresses read; idempotent on repeat frames', () => {
    useMessengerStore.getState().appendMessage('c1', outbound('read', 'env-r'));
    expect(applyEnvelopeUndeliverable('env-r')).toBe(0);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('read');

    useMessengerStore.getState().appendMessage('c2', {...outbound('sent', 'env-s'), conversation_id: 'c2'});
    applyEnvelopeUndeliverable('env-s');
    expect(applyEnvelopeUndeliverable('env-s')).toBe(0); // already undelivered
  });

  it('a LATE envelope.delivered cannot repaint an undelivered bubble', () => {
    useMessengerStore.getState().appendMessage('c1', outbound('sent', 'env-late'));
    applyEnvelopeUndeliverable('env-late');
    // Relay replays delivered (e.g. queued receipt) after the undeliverable.
    expect(applyEnvelopeDelivered('env-late')).toBe(0);
    expect(useMessengerStore.getState().messages.c1[0].status).toBe('undelivered');
  });

  it('unknown envelopeId is a safe no-op', () => {
    expect(applyEnvelopeUndeliverable('missing')).toBe(0);
    expect(applyEnvelopeUndeliverable('')).toBe(0);
  });
});
