/**
 * B-116 - per-member read receipts + WhatsApp group aggregation.
 *
 * Pins: a group message flips to 'read' only when EVERY other participant
 * has a read receipt (first receipt no longer blue-ticks); receipts are
 * attributed per user with timestamps; direct rows keep single-peer flip;
 * non-self messages are never receipt-stamped.
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
import type {LocalMessage, LocalConversation} from '../store/types';

const GROUP = 'group-x';

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

function ownMsg(id: string, envelopeId: string): LocalMessage {
  return {
    id,
    sender_id: 'self',
    body: 'hello',
    created_at: new Date().toISOString(),
    status: 'delivered',
    envelope_id: envelopeId,
    peer: {userId: 'bob', deviceId: 1},
  } as unknown as LocalMessage;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('recordReadReceipts (B-116)', () => {
  it('group: first receipt records but does NOT flip; all-others-read flips', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownMsg('m1', 'env1'));

    s.recordReadReceipts(GROUP, ['m1'], 'bob', 1000);
    let m = useMessengerStore.getState().messages[GROUP].find(x => x.id === 'm1')!;
    expect(m.receipts?.bob).toEqual({status: 'read', ts: 1000});
    expect(m.status).toBe('delivered');

    s.recordReadReceipts(GROUP, ['m1'], 'carol', 2000);
    m = useMessengerStore.getState().messages[GROUP].find(x => x.id === 'm1')!;
    expect(m.receipts?.carol).toEqual({status: 'read', ts: 2000});
    expect(m.status).toBe('read');
  });

  it('direct: the single peer receipt flips immediately (legacy behavior)', () => {
    const s = useMessengerStore.getState();
    s.upsertConversation({
      id: 'direct:bob', type: 'direct', name: 'Bob', participants: ['bob'],
      peer: {userId: 'bob', deviceId: 1}, session_state: 'fresh',
      unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
    } as unknown as LocalConversation);
    s.appendMessage('direct:bob', ownMsg('m2', 'env2'));
    s.recordReadReceipts('direct:bob', ['m2'], 'bob', 3000);
    const m = useMessengerStore.getState().messages['direct:bob'].find(x => x.id === 'm2')!;
    expect(m.status).toBe('read');
    expect(m.receipts?.bob?.status).toBe('read');
  });

  it('ops_channel aggregates like a group — the first receipt must NOT flip (M2)', () => {
    // Why: recordReadReceipts re-derived topology as `type === 'group'`, omitting
    // ops_channel, so `required` fell to null and the direct rule ("the single
    // peer's receipt is sufficient") blue-ticked a whole channel on ONE member's
    // read. The send path has always classified ops_channel as a group, so the
    // two disagreed. See MESSAGE_LOOP.md M2 / W12.
    const s = useMessengerStore.getState();
    s.setOwner?.('me');
    s.upsertConversation({
      id: 'ops-1', type: 'ops_channel', name: 'Ops Room',
      participants: ['me', 'bob', 'carol'],
      peer: {userId: 'bob', deviceId: 1}, session_state: 'fresh',
      unread_count: 0, is_muted: false, created_at: new Date().toISOString(),
    } as unknown as LocalConversation);
    s.appendMessage('ops-1', ownMsg('m4', 'env4'));

    s.recordReadReceipts('ops-1', ['m4'], 'bob', 5000);
    let m = useMessengerStore.getState().messages['ops-1'].find(x => x.id === 'm4')!;
    expect(m.receipts?.bob).toEqual({status: 'read', ts: 5000});
    expect(m.status).toBe('delivered');

    s.recordReadReceipts('ops-1', ['m4'], 'carol', 6000);
    m = useMessengerStore.getState().messages['ops-1'].find(x => x.id === 'm4')!;
    expect(m.status).toBe('read');
  });

  it('never stamps receipts onto messages we did not send', () => {
    seedGroup();
    const s = useMessengerStore.getState();
    const theirs = {...ownMsg('m3', 'env3'), sender_id: 'bob'} as LocalMessage;
    s.appendMessage(GROUP, theirs);
    s.recordReadReceipts(GROUP, ['m3'], 'carol', 4000);
    const m = useMessengerStore.getState().messages[GROUP].find(x => x.id === 'm3')!;
    expect(m.receipts).toBeUndefined();
  });
});
