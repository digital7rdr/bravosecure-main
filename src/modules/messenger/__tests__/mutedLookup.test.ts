/**
 * Audit 2026-07-06 M-03 / M-05 / F9 — persisted-vault lookups used by the
 * FCM push display path (headless-safe, AsyncStorage only):
 *   - isConversationMuted is scoped to the CURRENT owner's slice (F9 — no
 *     cross-account mute leakage on a shared device).
 *   - resolveDirectConversationId maps a sealed-sender senderUserId to the
 *     LOCAL direct thread (server-UUID row preferred), and returns null for
 *     a sender with no direct thread (likely group) — never mints one.
 *   - conversationExists backs the M-05 tap gate on cold boot.
 */

const mockSeeded = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockSeeded.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockSeeded.set(k, v); },
    removeItem: async (k: string) => { mockSeeded.delete(k); },
  },
}));

import {isConversationMuted, resolveDirectConversationId, conversationExists} from '../push/mutedLookup';

const OWNER_A = 'owner-a-uuid';
const OWNER_B = 'owner-b-uuid';
const PEER    = 'peer-alice-uuid';

type Convo = {is_muted?: boolean; type?: string; peer?: {userId?: string}};

function seedStore(opts: {
  ownUserId?: string | null;
  aConvos?:   Record<string, Convo>;
  bConvos?:   Record<string, Convo>;
}): void {
  mockSeeded.set('messenger-store-v1', JSON.stringify({
    state: {
      _ownUserId: opts.ownUserId === undefined ? OWNER_A : opts.ownUserId,
      vaultByOwner: {
        [OWNER_A]: {conversations: opts.aConvos ?? {}},
        [OWNER_B]: {conversations: opts.bConvos ?? {}},
      },
    },
    version: 0,
  }));
}

beforeEach(() => { mockSeeded.clear(); });

describe('isConversationMuted — owner-scoped (F9)', () => {
  it('does NOT leak a mute from another owner\'s vault slice', async () => {
    seedStore({
      aConvos: {[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}, is_muted: false}},
      bConvos: {[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}, is_muted: true}},
    });
    await expect(isConversationMuted({senderUserId: PEER})).resolves.toBe(false);
  });

  it('honors a mute via the resolved conversationId', async () => {
    // N-11/N-14 — the caller resolves the sealed-sender wake to its direct
    // conversation id FIRST, then passes it here; a muted 1:1 is suppressed
    // via that conversationId.
    seedStore({
      aConvos: {'uuid-1': {type: 'direct', peer: {userId: PEER}, is_muted: true}},
    });
    await expect(isConversationMuted({conversationId: 'uuid-1'})).resolves.toBe(true);
  });

  it('does NOT suppress on senderUserId alone (N-11/N-14 — fixes the mute inversion)', async () => {
    // The old sender-only branch made muting a person's DM silence that
    // person's GROUP messages too (a group wake resolves to no direct convId,
    // yet matched the muted DM). Mute is now keyed strictly off an
    // explicit/resolved conversationId, so a bare senderUserId never silences.
    seedStore({
      aConvos: {'uuid-1': {type: 'direct', peer: {userId: PEER}, is_muted: true}},
    });
    await expect(isConversationMuted({senderUserId: PEER})).resolves.toBe(false);
  });

  it('honors a conversationId-hinted group mute only for the current owner', async () => {
    seedStore({
      aConvos: {'group-1': {type: 'group', is_muted: true}},
      bConvos: {'group-2': {type: 'group', is_muted: true}},
    });
    await expect(isConversationMuted({conversationId: 'group-1'})).resolves.toBe(true);
    await expect(isConversationMuted({conversationId: 'group-2'})).resolves.toBe(false);
  });

  it('fails open when the active owner is unknown or the blob is corrupt', async () => {
    seedStore({
      ownUserId: null,
      aConvos:   {[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}, is_muted: true}},
    });
    await expect(isConversationMuted({senderUserId: PEER})).resolves.toBe(false);
    mockSeeded.set('messenger-store-v1', 'not json {');
    await expect(isConversationMuted({senderUserId: PEER})).resolves.toBe(false);
  });
});

describe('resolveDirectConversationId — M-03 conv-keyed banner id', () => {
  it('prefers the server-UUID direct row over the synthetic direct: slot', async () => {
    seedStore({
      aConvos: {
        [`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}},
        'uuid-123':         {type: 'direct', peer: {userId: PEER}},
      },
    });
    await expect(resolveDirectConversationId(PEER)).resolves.toBe('uuid-123');
  });

  it('falls back to the synthetic slot when no UUID row exists', async () => {
    seedStore({
      aConvos: {[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}}},
    });
    await expect(resolveDirectConversationId(PEER)).resolves.toBe(`direct:${PEER}`);
  });

  it('returns null for a sender with NO direct thread (likely group) — never mints', async () => {
    seedStore({
      aConvos: {'group-1': {type: 'group'}},
    });
    await expect(resolveDirectConversationId(PEER)).resolves.toBeNull();
  });

  it('ignores direct rows that live in another owner\'s slice', async () => {
    seedStore({
      aConvos: {},
      bConvos: {'uuid-b': {type: 'direct', peer: {userId: PEER}}},
    });
    await expect(resolveDirectConversationId(PEER)).resolves.toBeNull();
  });

  it('returns null when the active owner is unknown', async () => {
    seedStore({
      ownUserId: null,
      aConvos:   {[`direct:${PEER}`]: {type: 'direct', peer: {userId: PEER}}},
    });
    await expect(resolveDirectConversationId(PEER)).resolves.toBeNull();
  });
});

describe('conversationExists — M-05 tap gate', () => {
  it('is true only for rows in the current owner\'s slice', async () => {
    seedStore({
      aConvos: {'group-1': {type: 'group'}},
      bConvos: {'group-2': {type: 'group'}},
    });
    await expect(conversationExists('group-1')).resolves.toBe(true);
    await expect(conversationExists('group-2')).resolves.toBe(false);
    await expect(conversationExists('')).resolves.toBe(false);
  });
});
