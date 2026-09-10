/**
 * XO-4 — outbound delivery progress must be monotonic.
 *
 * A late outbox drain (a group sibling row reaching its peer hours
 * later) and a duplicated `envelope.accepted` both re-assert 'sent' on
 * a bubble the recipient already delivered/read. The write-through
 * subscriber then persists the downgrade, so the tick never recovers.
 * The ladder (sending < sent < delivered < read) is enforced once in
 * the store; 'failed'/'undelivered' stay deliberately off-ladder so
 * retry (failed → sending) and failure signals still apply.
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
import {isStatusRegression, useMessengerStore} from '../store/messengerStore';
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

const statusOf = (id: string): MessageStatus | undefined =>
  useMessengerStore.getState().messages.c1?.find(m => m.id === id)?.status;

function seed(status: MessageStatus, overrides: Partial<LocalMessage> = {}): string {
  const msg = outboundMessage({status, ...overrides});
  useMessengerStore.getState().appendMessage('c1', msg);
  return msg.id;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('XO-4 — updateMessageStatus never rewinds the forward ladder', () => {
  it.each<MessageStatus>(['delivered', 'read'])(
    'a late drain re-asserting sent does not rewind %s', current => {
      const id = seed(current);
      useMessengerStore.getState().updateMessageStatus('c1', id, 'sent');
      expect(statusOf(id)).toBe(current);
    });

  it('read → delivered is blocked', () => {
    const id = seed('read');
    useMessengerStore.getState().updateMessageStatus('c1', id, 'delivered');
    expect(statusOf(id)).toBe('read');
  });

  it('sent → sending is blocked', () => {
    const id = seed('sent');
    useMessengerStore.getState().updateMessageStatus('c1', id, 'sending');
    expect(statusOf(id)).toBe('sent');
  });

  it('the forward ladder still advances', () => {
    const id = seed('sending');
    const store = useMessengerStore.getState();
    store.updateMessageStatus('c1', id, 'sent');
    expect(statusOf(id)).toBe('sent');
    store.updateMessageStatus('c1', id, 'delivered');
    expect(statusOf(id)).toBe('delivered');
    store.updateMessageStatus('c1', id, 'read');
    expect(statusOf(id)).toBe('read');
  });

  it.each<MessageStatus>(['failed', 'undelivered'])(
    'retry re-entry %s → sending still applies', current => {
      const id = seed(current);
      useMessengerStore.getState().updateMessageStatus('c1', id, 'sending');
      expect(statusOf(id)).toBe('sending');
    });

  it('failure signals still apply over any ladder state', () => {
    const a = seed('sending', {envelope_id: 'e-fail-a'});
    useMessengerStore.getState().updateMessageStatus('c1', a, 'failed');
    expect(statusOf(a)).toBe('failed');

    const b = seed('sent', {envelope_id: 'e-fail-b'});
    useMessengerStore.getState().updateMessageStatus('c1', b, 'failed');
    expect(statusOf(b)).toBe('failed');

    const c = seed('delivered', {envelope_id: 'e-fail-c'});
    useMessengerStore.getState().updateMessageStatus('c1', c, 'undelivered');
    expect(statusOf(c)).toBe('undelivered');
  });

  it('applyEnvelopeUndeliverable still downgrades a delivered bubble', () => {
    const id = seed('delivered', {envelope_id: 'env-undel'});
    expect(applyEnvelopeUndeliverable('env-undel')).toBe(1);
    expect(statusOf(id)).toBe('undelivered');
  });

  it('undelivered → sent still applies (bounded auto-resend success)', () => {
    const id = seed('undelivered');
    useMessengerStore.getState().updateMessageStatus('c1', id, 'sent');
    expect(statusOf(id)).toBe('sent');
  });

  it('a blocked call leaves the message object referentially identical', () => {
    const id = seed('read');
    const before = useMessengerStore.getState().messages.c1[0];
    useMessengerStore.getState().updateMessageStatus('c1', id, 'sent');
    expect(useMessengerStore.getState().messages.c1[0]).toBe(before);
  });
});

describe('XO-4 — updateMessageStatusBulk respects the ladder', () => {
  it('bulk read still flips sent and delivered rows', () => {
    const a = seed('sent', {envelope_id: 'e-a'});
    const b = seed('delivered', {envelope_id: 'e-b'});
    useMessengerStore.getState().updateMessageStatusBulk('c1', [a, b], 'read');
    expect(statusOf(a)).toBe('read');
    expect(statusOf(b)).toBe('read');
  });

  it('bulk sent leaves a read row alone', () => {
    const a = seed('read', {envelope_id: 'e-a'});
    useMessengerStore.getState().updateMessageStatusBulk('c1', [a], 'sent');
    expect(statusOf(a)).toBe('read');
  });
});

describe('XO-4 — isStatusRegression', () => {
  it.each<[MessageStatus, MessageStatus]>([
    ['delivered', 'sent'],
    ['read', 'sent'],
    ['read', 'delivered'],
    ['sent', 'sending'],
    ['delivered', 'sending'],
    ['read', 'sending'],
  ])('blocks %s → %s', (cur, next) => {
    expect(isStatusRegression(cur, next)).toBe(true);
  });

  it('never blocks a pair involving failed/undelivered', () => {
    const ladder: MessageStatus[] = ['sending', 'sent', 'delivered', 'read'];
    const offLadder: MessageStatus[] = ['failed', 'undelivered'];
    for (const off of offLadder) {
      for (const on of [...ladder, ...offLadder]) {
        expect(isStatusRegression(off, on)).toBe(false);
        expect(isStatusRegression(on, off)).toBe(false);
      }
    }
  });

  it('never blocks a forward move', () => {
    expect(isStatusRegression('sending', 'sent')).toBe(false);
    expect(isStatusRegression('sent', 'delivered')).toBe(false);
    expect(isStatusRegression('delivered', 'read')).toBe(false);
    expect(isStatusRegression('read', 'read')).toBe(false);
  });
});
