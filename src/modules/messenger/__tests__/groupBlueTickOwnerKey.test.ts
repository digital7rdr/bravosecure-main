/**
 * B-186 — the group blue tick was structurally unreachable.
 *
 * `recordReadReceipts` built its "everyone must have read this" set by
 * filtering `conversations[].participants` against `_ownUserId`. But
 * `_ownUserId` is the vault OWNER KEY — `email ?? phone_e164 ?? user.id`
 * (MainNavigator), pinned per install — while `participants`, `receipts` keys
 * and `envelope_ids` keys are auth UUIDs. For any account carrying an email or
 * a phone (i.e. essentially every account) the filter matched nothing, so the
 * AUTHOR stayed inside their own required set. Nobody ever sends the author a
 * read receipt for their own message, so `allRead` could never become true and
 * NO group or department-channel message could ever go blue.
 *
 * The existing B-116 suite cannot see this: it calls `setOwner('me')` with
 * `participants: ['me', …]`, i.e. it models both ids as the same id space. That
 * is exactly the MESSAGE_LOOP §4 "one rule, two id spaces, the untested one
 * drifts" class. THIS suite models the real split.
 *
 * If one of these fails: do NOT relax it. The blue tick is the assertion.
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

const GROUP = 'group-ops';
// The real shape: an EMAIL owner key over UUID participants.
const OWNER_KEY = 'boss@example.com';
const ME = 'a1111111-1111-4111-8111-111111111111';
const BOB = 'b2222222-2222-4222-8222-222222222222';
const CAROL = 'c3333333-3333-4333-8333-333333333333';

function seed(participants: string[] = [ME, BOB, CAROL]): void {
  const s = useMessengerStore.getState();
  s.setOwner(OWNER_KEY, ME);
  s.upsertConversation({
    id: GROUP,
    type: 'group',
    name: 'Ops',
    participants,
    peer: {userId: BOB, deviceId: 1},
    session_state: 'fresh',
    unread_count: 0,
    is_muted: false,
    created_at: new Date().toISOString(),
  } as unknown as LocalConversation);
}

function ownMsg(id: string, envelopeIds: Record<string, string>): LocalMessage {
  return {
    id,
    sender_id: 'self',
    body: 'hello',
    created_at: new Date().toISOString(),
    status: 'delivered',
    envelope_id: Object.values(envelopeIds)[0],
    envelope_ids: envelopeIds,
    peer: {userId: BOB, deviceId: 1},
  } as unknown as LocalMessage;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('B-186 — group blue tick across the ownerKey/UUID split', () => {
  it('T1: every other member reading flips the message to "read"', () => {
    seed();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownMsg('m1', {[BOB]: 'env-bob', [CAROL]: 'env-carol'}));

    s.recordReadReceipts(GROUP, ['m1'], BOB, Date.now());
    expect(useMessengerStore.getState().messages[GROUP][0].status).toBe('delivered');

    s.recordReadReceipts(GROUP, ['m1'], CAROL, Date.now());
    // The user-facing assertion. Two independent mechanisms now keep the
    // author out of the required set (the real auth id, and the shipped-legs
    // intersection), so this one test survives either mutation alone — T3 and
    // T4 below are the ones that isolate them.
    expect(useMessengerStore.getState().messages[GROUP][0].status).toBe('read');
  });

  it('T2: the author is never part of their own required-readers set', () => {
    seed();
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownMsg('m2', {[BOB]: 'env-bob'}));
    // BOB is the only other member with a shipped leg.
    s.recordReadReceipts(GROUP, ['m2'], BOB, Date.now());
    const m = useMessengerStore.getState().messages[GROUP][0];
    expect(m.status).toBe('read');
    expect(m.receipts?.[ME]).toBeUndefined();
  });

  it('T3: a member added AFTER the message cannot deadlock it', () => {
    // Shipped only to BOB; CAROL joined the channel later, so she has no leg
    // and readReceiptEnvelopeMatch would reject a receipt from her anyway.
    seed([ME, BOB, CAROL]);
    const s = useMessengerStore.getState();
    s.appendMessage(GROUP, ownMsg('m3', {[BOB]: 'env-bob'}));
    s.recordReadReceipts(GROUP, ['m3'], BOB, Date.now());
    expect(useMessengerStore.getState().messages[GROUP][0].status).toBe('read');
  });

  // Isolates the ownerKey fix: with no shipped-legs map to intersect against,
  // the required set is the raw roster, so an email-vs-UUID own-id comparison
  // leaves the author in it and this deadlocks.
  it('T4: rows with no envelope_ids fall back to the full roster', () => {
    seed([ME, BOB]);
    const s = useMessengerStore.getState();
    const legacy = {
      id: 'm4', sender_id: 'self', body: 'x', created_at: new Date().toISOString(),
      status: 'delivered', peer: {userId: BOB, deviceId: 1},
    } as unknown as LocalMessage;
    s.appendMessage(GROUP, legacy);
    s.recordReadReceipts(GROUP, ['m4'], BOB, Date.now());
    expect(useMessengerStore.getState().messages[GROUP][0].status).toBe('read');
  });

  it('T5: a real user switch does not leave the previous account\'s auth id behind', () => {
    seed();
    expect(useMessengerStore.getState()._ownAuthUserId).toBe(ME);
    // Switching owner WITHOUT supplying a new auth id must clear it rather
    // than silently excluding the wrong person from every aggregate.
    useMessengerStore.getState().setOwner('other@example.com');
    expect(useMessengerStore.getState()._ownAuthUserId).toBeNull();
  });

  it('T6: a re-login with the SAME owner key still records the auth id', () => {
    // setOwner early-returns when the owner key is unchanged; the auth id is
    // not persisted, so a cold boot would otherwise never get one.
    useMessengerStore.getState().setOwner(OWNER_KEY);
    expect(useMessengerStore.getState()._ownAuthUserId).toBeNull();
    useMessengerStore.getState().setOwner(OWNER_KEY, ME);
    expect(useMessengerStore.getState()._ownAuthUserId).toBe(ME);
  });
});
