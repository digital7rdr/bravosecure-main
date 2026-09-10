/**
 * Unit tests for the admin-only per-group member name override.
 *
 * Covers:
 *   - setting an alias stores it on the group
 *   - overriding an existing alias replaces cleanly
 *   - empty / whitespace-only alias clears the override
 *   - explicit null clears the override
 *   - clearing the last alias removes the group bucket (no empty objects)
 *   - overrides are independent across groups
 */

// AsyncStorage is a React Native native module — stub it with an
// in-memory Map so the `persist` middleware can init in Node without
// pulling in the RN bridge.
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

describe('groupMemberNames — admin rename overrides', () => {
  beforeEach(() => {
    useMessengerStore.getState().reset();
  });

  it('stores an alias under the correct group and user', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'Lead CPO');

    expect(useMessengerStore.getState().groupMemberNames).toEqual({
      'group:1': {'user:alice': 'Lead CPO'},
    });
  });

  it('trims whitespace around stored aliases', () => {
    useMessengerStore.getState().setGroupMemberName('group:1', 'user:alice', '   Lead CPO  ');
    expect(useMessengerStore.getState().groupMemberNames['group:1']?.['user:alice']).toBe('Lead CPO');
  });

  it('replaces an existing alias cleanly', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'Lead CPO');
    setGroupMemberName('group:1', 'user:alice', 'Alpha One');

    expect(useMessengerStore.getState().groupMemberNames['group:1']?.['user:alice']).toBe('Alpha One');
  });

  it('clears the override when passed an empty string', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'Lead CPO');
    setGroupMemberName('group:1', 'user:alice', '');

    expect(useMessengerStore.getState().groupMemberNames).toEqual({});
  });

  it('clears the override when passed whitespace only', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'Lead CPO');
    setGroupMemberName('group:1', 'user:alice', '   ');

    expect(useMessengerStore.getState().groupMemberNames).toEqual({});
  });

  it('clears the override when passed null', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'Lead CPO');
    setGroupMemberName('group:1', 'user:alice', null);

    expect(useMessengerStore.getState().groupMemberNames).toEqual({});
  });

  it('removes the group bucket entirely when its last override is cleared', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'A');
    setGroupMemberName('group:1', 'user:bob',   'B');
    setGroupMemberName('group:1', 'user:alice', null);

    // Only bob's override left — group bucket still exists.
    expect(useMessengerStore.getState().groupMemberNames).toEqual({
      'group:1': {'user:bob': 'B'},
    });

    setGroupMemberName('group:1', 'user:bob', null);
    // Both cleared — the group bucket must be removed, not left as {}.
    expect(useMessengerStore.getState().groupMemberNames).toEqual({});
  });

  it('keeps overrides isolated across groups', () => {
    const {setGroupMemberName} = useMessengerStore.getState();
    setGroupMemberName('group:1', 'user:alice', 'Ops Lead');
    setGroupMemberName('group:2', 'user:alice', 'Analyst');

    expect(useMessengerStore.getState().groupMemberNames).toEqual({
      'group:1': {'user:alice': 'Ops Lead'},
      'group:2': {'user:alice': 'Analyst'},
    });

    // Clearing one group doesn't touch the other.
    setGroupMemberName('group:1', 'user:alice', null);
    expect(useMessengerStore.getState().groupMemberNames).toEqual({
      'group:2': {'user:alice': 'Analyst'},
    });
  });
});
