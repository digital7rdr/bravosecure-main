/**
 * SYNC-1 — group read ticks can finally complete.
 *
 * The author's group fan-out mints ONE relay envelope id per recipient, but
 * only the first was kept — so every other member's read receipt was
 * unmatchable and the B-116 "all participants read" aggregate was
 * structurally unreachable for any group of ≥3. These pin the full chain:
 * per-recipient map recording, strict per-member receipt matching, the
 * scalar-seeding rule, and the delivered-tick map match.
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
import {readReceiptEnvelopeMatch} from '../runtime/messagingLogic';
import {applyEnvelopeDelivered} from '../runtime/envelopeDelivered';
import type {LocalMessage, LocalConversation} from '../store/types';

const GROUP = 'group-sync1';

function seedGroup(): void {
  const s = useMessengerStore.getState();
  s.setOwner?.('me');
  s.upsertConversation({
    id: GROUP,
    type: 'group',
    name: 'Team',
    participants: ['me', 'bob', 'carol'],
    peer: {userId: 'bob', deviceId: 1},
    session_state: 'fresh',
    unread_count: 0,
    is_muted: false,
    created_at: new Date().toISOString(),
  } as unknown as LocalConversation);
}

function ownGroupMsg(id: string, over: Partial<LocalMessage> = {}): LocalMessage {
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
    ...over,
  } as unknown as LocalMessage;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('SYNC-1 — updateMessageEnvelopeId per-recipient semantics', () => {
  it('records every leg in the map and seeds (never overwrites) the scalar', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownGroupMsg('m1'));
    s.updateMessageEnvelopeId(GROUP, 'm1', 'env-bob', 'bob');
    s.updateMessageEnvelopeId(GROUP, 'm1', 'env-carol', 'carol');
    const msg = useMessengerStore.getState().messages[GROUP][0];
    expect(msg.envelope_ids).toEqual({bob: 'env-bob', carol: 'env-carol'});
    // The scalar was seeded by the FIRST leg and the second must not clobber
    // it — the drain-overwrite amplifier the audit found.
    expect(msg.envelope_id).toBe('env-bob');
  });

  it('a recipient-less call (1:1 / undeliverable re-send) still overwrites the scalar', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownGroupMsg('m2', {envelope_id: 'env-old'}));
    s.updateMessageEnvelopeId(GROUP, 'm2', 'env-new');
    expect(useMessengerStore.getState().messages[GROUP][0].envelope_id).toBe('env-new');
  });
});

describe('SYNC-1 — the B-116 aggregate is now reachable', () => {
  it('bob then carol reading flips the bubble to read (the finding)', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownGroupMsg('m3', {status: 'delivered'}));
    s.updateMessageEnvelopeId(GROUP, 'm3', 'env-bob', 'bob');
    s.updateMessageEnvelopeId(GROUP, 'm3', 'env-carol', 'carol');

    // Author's receipt handler, distilled: match by the receipter's own id.
    const msg = () => useMessengerStore.getState().messages[GROUP][0];
    expect(readReceiptEnvelopeMatch({
      envelopeId: msg().envelope_id, envelopeIds: msg().envelope_ids,
      receipterUid: 'bob', ids: new Set(['env-bob']),
    })).toBe(true);
    s.recordReadReceipts(GROUP, ['m3'], 'bob', Date.now());
    expect(msg().status).toBe('delivered'); // 1 of 2 — not yet

    // Pre-fix this receipt was silently discarded (scalar = env-bob).
    expect(readReceiptEnvelopeMatch({
      envelopeId: msg().envelope_id, envelopeIds: msg().envelope_ids,
      receipterUid: 'carol', ids: new Set(['env-carol']),
    })).toBe(true);
    s.recordReadReceipts(GROUP, ['m3'], 'carol', Date.now());
    expect(msg().status).toBe('read');
    expect(msg().receipts?.bob?.status).toBe('read');
    expect(msg().receipts?.carol?.status).toBe('read');
  });

  it('documents the pre-fix behaviour: a scalar-only row cannot match the second reader', () => {
    expect(readReceiptEnvelopeMatch({
      envelopeId: 'env-bob',
      receipterUid: 'carol', ids: new Set(['env-carol']),
    })).toBe(false);
  });
});

describe('SYNC-1 — delivered tick matches any fan-out leg', () => {
  it('applyEnvelopeDelivered attributes a map entry; the bubble flips only when ALL legs settle (B-187)', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownGroupMsg('m4', {
      envelope_ids: {bob: 'env-bob', carol: 'env-carol'},
    }));
    // Carol's leg is matched (the SYNC-1 point: NOT just the scalar) but one
    // of two legs must no longer paint ✓✓ — it records her member receipt.
    expect(applyEnvelopeDelivered('env-carol')).toBe(0);
    const afterOne = useMessengerStore.getState().messages[GROUP][0];
    expect(afterOne.status).toBe('sent');
    expect(afterOne.receipts?.carol?.status).toBe('delivered');
    // Bob's leg completes the aggregate — NOW the bubble flips.
    expect(applyEnvelopeDelivered('env-bob')).toBe(1);
    expect(useMessengerStore.getState().messages[GROUP][0].status).toBe('delivered');
  });

  it('still no-ops for unknown ids and non-sent rows', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownGroupMsg('m5', {
      status: 'read',
      envelope_ids: {bob: 'env-bob'},
    }));
    expect(applyEnvelopeDelivered('env-bob')).toBe(0);
    expect(applyEnvelopeDelivered('env-unknown')).toBe(0);
    expect(useMessengerStore.getState().messages[GROUP][0].status).toBe('read');
  });
});
