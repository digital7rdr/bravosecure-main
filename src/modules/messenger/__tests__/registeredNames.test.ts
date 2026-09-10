/**
 * B-79 — registered-name resolution. `isPlaceholderName` gates which direct
 * conversations get their `Bravo · <hex>` label upgraded to the peer's
 * registered Bravo display name; a saved (address-book) or custom name must be
 * left alone. This pins the predicate + the precedence rule the sweep relies on.
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

import {isPlaceholderName} from '../contacts/useRegisteredNames';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation} from '../store/types';

function direct(id: string, over: Partial<LocalConversation> = {}): LocalConversation {
  return {
    id: `direct:${id}`, type: 'direct', name: `Bravo · ${id.slice(0, 8)}`,
    created_at: '2026-07-01T00:00:00.000Z', unread_count: 0,
    peer: {userId: id, deviceId: 1}, session_state: 'established', ...over,
  } as unknown as LocalConversation;
}

describe('isPlaceholderName (B-79)', () => {
  it('matches the auto Bravo · <hex> placeholder', () => {
    expect(isPlaceholderName('Bravo · 3165d0e1')).toBe(true);
    expect(isPlaceholderName('Bravo · abcd1234')).toBe(true);
  });
  it('matches the bare id-prefix placeholder against the peer id', () => {
    expect(isPlaceholderName('c700ccde', 'c700ccde-1234-5678-9abc-def012345678')).toBe(true); // slice(0,8)
    expect(isPlaceholderName('c700ccde-1234-5678-9abc-def012345678', 'c700ccde-1234-5678-9abc-def012345678')).toBe(true); // full id
  });
  it('does NOT match a bare-hex-looking string when it is NOT the peer id (a real name)', () => {
    expect(isPlaceholderName('c700ccde', 'somebody-else-9999')).toBe(false);
    expect(isPlaceholderName('deadbeef')).toBe(false); // no peer id to compare → not a placeholder
  });
  it('does NOT match real registered names, saved names, or group/mission names', () => {
    expect(isPlaceholderName('Jack Bravo', 'jack-1111')).toBe(false);
    expect(isPlaceholderName('Bravo System', 'bsys-2222')).toBe(false); // registered name, no middot
    expect(isPlaceholderName('Mom', 'mom-3333')).toBe(false);
    expect(isPlaceholderName('MISSION MSN-1 · OPS ROOM')).toBe(false);
    expect(isPlaceholderName(undefined)).toBe(false);
    expect(isPlaceholderName('')).toBe(false);
  });
});

describe('registered-name precedence (B-79) via the store', () => {
  beforeEach(() => {
    useMessengerStore.setState({conversations: {}, conversationOrder: [], messages: {}} as never);
  });

  it('upgrades a placeholder to the registered name, but never a custom or saved one', () => {
    const store = useMessengerStore.getState();
    store.upsertConversation(direct('3165d0e1aaaa', {name: 'Bravo · 3165d0e1'}));          // placeholder
    store.upsertConversation(direct('c0ffee00bbbb', {name: 'Mom'}));                        // saved (already resolved)
    store.upsertConversation(direct('deadbeefcccc', {name: 'Nickname', is_custom_name: true})); // custom

    // Simulate what the sweep does for each conversation.
    const resolved: Record<string, string> = {
      'direct:3165d0e1aaaa': 'Sirajul Islam',
      'direct:c0ffee00bbbb': 'Registered Name',
      'direct:deadbeefcccc': 'Registered Name',
    };
    for (const [cid, reg] of Object.entries(resolved)) {
      const c = useMessengerStore.getState().conversations[cid];
      if (c && !c.is_custom_name && isPlaceholderName(c.name)) {
        useMessengerStore.getState().upsertConversation({...c, name: reg});
      }
    }

    const now = useMessengerStore.getState().conversations;
    expect(now['direct:3165d0e1aaaa'].name).toBe('Sirajul Islam'); // placeholder → registered
    expect(now['direct:c0ffee00bbbb'].name).toBe('Mom');           // saved name kept
    expect(now['direct:deadbeefcccc'].name).toBe('Nickname');      // custom name kept
  });
});
