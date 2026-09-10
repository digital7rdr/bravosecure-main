/**
 * Unit tests for the per-owner vault in messengerStore.
 *
 * Verifies the user-facing scenario:
 *   1. Login as piyaldeb87, send msg to Alice → conversation lands.
 *   2. Logout, login as piyaldeb78 → fresh slate, no leak.
 *   3. Logout, login as piyaldeb87 again → Alice + last_message restored.
 *
 * The store-level vault swap is the load-bearing piece: the SQLCipher
 * messages and the on-disk DB filename are scoped on the same ownerKey
 * (see `runtime.ts:resolveOwnStore`), so this test plus the existing
 * SQLCipher round-trip tests jointly cover the full flow.
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

import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation, LocalMessage} from '../store/types';

const OWNER_87 = 'piyaldeb87@gmail.com';
const OWNER_78 = 'piyaldeb78@gmail.com';
const ALICE_ID = 'direct:alice-uuid';

function makeAliceConvo(): LocalConversation {
  return {
    id:                ALICE_ID,
    type:              'direct',
    name:              'Alice (Dev)',
    participants:      ['alice-uuid'],
    unread_count:      0,
    is_muted:          false,
    created_at:        new Date('2026-04-29T16:00:00Z').toISOString(),
    peer:              {userId: 'alice-uuid', deviceId: 1},
    session_state:     'established',
  };
}

function makeHelloMsg(): LocalMessage {
  return {
    id:              'msg-1',
    conversation_id: ALICE_ID,
    sender_id:       'self',
    type:            'text',
    content:         'Hello',
    status:          'sent',
    is_encrypted:    true,
    created_at:      new Date('2026-04-29T16:00:00Z').toISOString(),
    peer:            {userId: 'alice-uuid', deviceId: 1},
  };
}

describe('messengerStore — per-owner vault', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('preserves conversation history across user-switch round-trip', () => {
    const s = useMessengerStore.getState();

    // ── Step 1: login as piyaldeb87, set up Alice + send Hello ─────
    s.setOwner(OWNER_87);
    s.upsertConversation(makeAliceConvo());
    s.appendMessage(ALICE_ID, makeHelloMsg());

    {
      const live = useMessengerStore.getState();
      expect(live._ownUserId).toBe(OWNER_87);
      expect(live.conversations[ALICE_ID]).toBeDefined();
      expect(live.conversations[ALICE_ID].last_message?.content).toBe('Hello');
      expect(live.messages[ALICE_ID]?.[0]?.content).toBe('Hello');
    }

    // ── Step 2: logout, login as piyaldeb78 → fresh slate ──────────
    useMessengerStore.getState().setOwner(OWNER_78);

    {
      const live = useMessengerStore.getState();
      expect(live._ownUserId).toBe(OWNER_78);
      // No leak from the previous owner.
      expect(live.conversations).toEqual({});
      expect(live.messages).toEqual({});
      // But the previous owner's data is safely vaulted.
      expect(live.vaultByOwner[OWNER_87]).toBeDefined();
      expect(live.vaultByOwner[OWNER_87].conversations[ALICE_ID]).toBeDefined();
      expect(
        live.vaultByOwner[OWNER_87].conversations[ALICE_ID].last_message?.content,
      ).toBe('Hello');
    }

    // ── Step 3: logout, login as piyaldeb87 again ──────────────────
    useMessengerStore.getState().setOwner(OWNER_87);

    {
      const live = useMessengerStore.getState();
      expect(live._ownUserId).toBe(OWNER_87);
      // Conversation list restored from vault — including last_message.
      expect(live.conversations[ALICE_ID]).toBeDefined();
      expect(live.conversations[ALICE_ID].last_message?.content).toBe('Hello');
      // Messages live in SQLCipher (DB filename scoped on the same
      // ownerKey), not in the vault — runtime hydrates them at boot.
      // The vault only carries the conversation list metadata.
      expect(live.messages).toEqual({});
    }
  });

  it('treats same-owner re-call as a no-op (idempotent)', () => {
    const s = useMessengerStore.getState();
    s.setOwner(OWNER_87);
    s.upsertConversation(makeAliceConvo());
    s.appendMessage(ALICE_ID, makeHelloMsg());

    // Re-call setOwner with the same owner — must NOT wipe the live
    // messages map (which would lose the SQLCipher-pending writes).
    s.setOwner(OWNER_87);

    const live = useMessengerStore.getState();
    expect(live.conversations[ALICE_ID]).toBeDefined();
    expect(live.messages[ALICE_ID]).toHaveLength(1);
  });

  it('keeps independent vaults for two distinct owners', () => {
    const s = useMessengerStore.getState();

    s.setOwner(OWNER_87);
    s.upsertConversation(makeAliceConvo());
    s.appendMessage(ALICE_ID, makeHelloMsg());

    s.setOwner(OWNER_78);
    s.upsertConversation({...makeAliceConvo(), id: 'direct:bob-uuid', name: 'Bob'});
    s.appendMessage('direct:bob-uuid', {...makeHelloMsg(), conversation_id: 'direct:bob-uuid', content: 'Hi Bob'});

    // Switch back to 87 — Alice present, Bob absent.
    s.setOwner(OWNER_87);
    let live = useMessengerStore.getState();
    expect(Object.keys(live.conversations)).toEqual([ALICE_ID]);

    // Switch to 78 — Bob present, Alice absent.
    s.setOwner(OWNER_78);
    live = useMessengerStore.getState();
    expect(Object.keys(live.conversations)).toEqual(['direct:bob-uuid']);
  });
});
