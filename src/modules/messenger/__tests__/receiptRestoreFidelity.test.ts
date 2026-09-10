/**
 * Read receipts must survive a backup restore — and a row that already lost
 * them must not be stuck showing a permanently wrong tick.
 *
 * FIELD REPORT (2026-07-25). A group's "Read by" sheet listed seven members,
 * every one showing "—", for a message that had demonstrably been read. Cause:
 * `serializeMessagePayload` carried the SCALAR `envelope_id` but neither
 * `envelope_ids` (SYNC-1, the per-recipient map) nor `receipts` (B-116, the
 * per-member read map). They were excluded on purpose — a new mirrored field
 * changes every row's versionHash and makes the next sweep re-upload all
 * history (the B-94 `root_mismatch` window).
 *
 * That reasoning was right about the cost and wrong about the trade. Without
 * the map, a restored group row can attribute exactly ONE member's receipt (the
 * scalar id is participants[0]'s); the other N-1 reference envelope ids the
 * device no longer holds and are unmatchable FOREVER. And the blue tick demands
 * every participant. So the aggregate could never complete — not slowly, never.
 *
 * The re-upload is one-time and the ledger is built to survive it (BACKUP_LOOP
 * I2 raises the pending-commit flag before putMessages; I4's repair path
 * re-uploads everything by design). Losing receipts is not one-time.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

import {serializeMessageForBackup} from '../backup/backupWireV3';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';

const CONV = 'g-1';
const ME   = 'u-me';
const A    = 'u-alice';
const B    = 'u-bob';

function ownGroupMsg(over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id:              'm1',
    conversation_id: CONV,
    sender_id:       'self',
    type:            'text',
    content:         'hi',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      '2026-07-25T10:00:00.000Z',
    peer:            {userId: A, deviceId: 1},
    envelope_id:     'env-alice',
    ...over,
  } as LocalMessage;
}

function seed(msg: LocalMessage): void {
  useMessengerStore.setState({
    conversations: {
      [CONV]: {
        id: CONV, name: 'G', type: 'group', participants: [ME, A, B],
        unread_count: 0, session_state: 'established', peer: {userId: A, deviceId: 1},
      } as unknown as LocalConversation,
    },
    messages: {[CONV]: [msg]},
    conversationOrder: [CONV],
    _ownAuthUserId: ME,
  } as never);
}

const row = () => useMessengerStore.getState().messages[CONV][0];

beforeEach(() => {
  useMessengerStore.setState({conversations: {}, messages: {}, conversationOrder: []} as never);
});

describe('the backup payload carries the receipt fields', () => {
  it('round-trips envelope_ids and receipts', () => {
    const msg = ownGroupMsg({
      envelope_ids: {[A]: 'env-alice', [B]: 'env-bob'},
      receipts:     {[A]: {status: 'read', ts: 111}},
    });
    const payload = JSON.parse(serializeMessageForBackup(msg).payloadJson) as Record<string, unknown>;
    expect(payload.envelope_ids).toEqual({[A]: 'env-alice', [B]: 'env-bob'});
    expect(payload.receipts).toEqual({[A]: {status: 'read', ts: 111}});
  });

  it('a row with neither field serialises them as absent, not as {}', () => {
    // `{}` would read back as "we have a map and it is empty", which is the
    // opposite of the legacy fallback's trigger condition.
    const payload = JSON.parse(serializeMessageForBackup(ownGroupMsg()).payloadJson) as Record<string, unknown>;
    expect(payload.envelope_ids).toBeUndefined();
    expect(payload.receipts).toBeUndefined();
  });

  it('still carries the scalar envelope_id (unchanged)', () => {
    const payload = JSON.parse(serializeMessageForBackup(ownGroupMsg()).payloadJson) as Record<string, unknown>;
    expect(payload.envelope_id).toBe('env-alice');
  });

  it('B-683 — round-trips undeliverable_legs, absent (not {}) when unset', () => {
    const withLegs = JSON.parse(serializeMessageForBackup(
      ownGroupMsg({undeliverable_legs: {[B]: 222}}),
    ).payloadJson) as Record<string, unknown>;
    expect(withLegs.undeliverable_legs).toEqual({[B]: 222});
    // Hash-safety: pre-v21 rows must serialize byte-identically (the field
    // is omitted, so their versionHash is unchanged — no B-94 re-upload).
    const without = JSON.parse(serializeMessageForBackup(ownGroupMsg()).payloadJson) as Record<string, unknown>;
    expect(without.undeliverable_legs).toBeUndefined();
    expect('undeliverable_legs' in without).toBe(false);
  });
});

describe('a row WITH the map keeps the strict every-member rule', () => {
  it('one member reading does not blue-tick a two-member group', () => {
    seed(ownGroupMsg({envelope_ids: {[A]: 'env-alice', [B]: 'env-bob'}}));
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], A, 111);
    expect(row().status).toBe('delivered');
    expect(row().receipts?.[A]?.status).toBe('read');
  });

  it('...and completes once every shipped member has read', () => {
    seed(ownGroupMsg({envelope_ids: {[A]: 'env-alice', [B]: 'env-bob'}}));
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], A, 111);
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], B, 222);
    expect(row().status).toBe('read');
  });

  it('a member with no shipped leg is not required', () => {
    // Pre-existing rule, re-pinned: requiring a receipt from someone we never
    // shipped to deadlocks the aggregate.
    seed(ownGroupMsg({envelope_ids: {[A]: 'env-alice'}}));
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], A, 111);
    expect(row().status).toBe('read');
  });
});

describe('a row WITHOUT the map stays STRICT — the relaxation that was reverted', () => {
  it('does NOT complete on a single receipt', () => {
    // I tried relaxing this, reasoning that a restored row can only ever
    // attribute one member so demanding all of them is unachievable. That is
    // true of a RESTORED row and false of a FRESH one: envelope_ids is also
    // empty between the optimistic append and `envelope.accepted`, so the
    // relaxation blue-ticked brand-new group messages on their first receipt.
    // groupReadReceipts.test.ts caught it. Pinned here too, from the restore
    // angle, so the same "fix" is not re-attempted from this direction.
    seed(ownGroupMsg({envelope_ids: undefined}));
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], A, 111);
    expect(row().status).toBe('delivered');
  });

  it('still records WHO read it, even though the aggregate cannot complete', () => {
    seed(ownGroupMsg({envelope_ids: undefined}));
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], A, 111);
    expect(row().receipts?.[A]).toEqual({status: 'read', ts: 111});
  });

  it('completes normally once every participant is recorded', () => {
    seed(ownGroupMsg({envelope_ids: undefined}));
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], A, 111);
    useMessengerStore.getState().recordReadReceipts(CONV, ['m1'], B, 222);
    expect(row().status).toBe('read');
  });

  it('a 1:1 is unaffected — the single peer was always sufficient', () => {
    useMessengerStore.setState({
      conversations: {
        'd-1': {
          id: 'd-1', name: 'A', type: 'direct', participants: [ME, A],
          unread_count: 0, session_state: 'established', peer: {userId: A, deviceId: 1},
        } as unknown as LocalConversation,
      },
      messages: {'d-1': [{...ownGroupMsg(), conversation_id: 'd-1'}]},
      conversationOrder: ['d-1'],
      _ownAuthUserId: ME,
    } as never);
    useMessengerStore.getState().recordReadReceipts('d-1', ['m1'], A, 111);
    expect(useMessengerStore.getState().messages['d-1'][0].status).toBe('read');
  });
});
