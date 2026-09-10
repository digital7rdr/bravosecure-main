/**
 * BUG-R (audit 2026-07-23) — restoreTombstones cache is owner-keyed.
 *
 * The old owner-blind `if (cached) return cached` served user A's
 * tombstone set to user B after an in-process account switch, and a B
 * restore then merged B's ids INTO A's cached set and persisted the
 * union under B's key (cross-account id bleed; B's receive gate
 * consulted A's tombstones). The pre-existing suite masked this by
 * calling `_resetRestoreTombstonesForTests()` between owners — this one
 * deliberately does NOT.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    __store: store,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
    },
  };
});

import {
  loadRestoreTombstones, addRestoreTombstones, isRestoreTombstoned,
  _resetRestoreTombstonesForTests,
} from '../backup/restoreTombstones';

const rawStore = (require('@react-native-async-storage/async-storage') as
  {__store: Map<string, string>}).__store;

describe('BUG-R — cross-account tombstone cache hygiene', () => {
  beforeEach(() => {
    rawStore.clear();
    _resetRestoreTombstonesForTests();
  });

  it('an account switch WITHOUT a reset never serves the previous owner’s set', async () => {
    await addRestoreTombstones('user-A', ['a-msg-1', 'a-msg-2']);
    expect(isRestoreTombstoned('a-msg-1')).toBe(true);

    // User B signs in — NO test-only reset (the production path has none).
    const bSet = await loadRestoreTombstones('user-B');
    expect(bSet.has('a-msg-1')).toBe(false);
    expect(isRestoreTombstoned('a-msg-1')).toBe(false);

    // B's restore adds B's ids — they must NOT merge into A's set or key.
    await addRestoreTombstones('user-B', ['b-msg-1']);
    expect(isRestoreTombstoned('b-msg-1')).toBe(true);
    const aPersisted = JSON.parse(rawStore.get('messenger.restoreTombstones.v1:user-A') ?? '[]') as string[];
    const bPersisted = JSON.parse(rawStore.get('messenger.restoreTombstones.v1:user-B') ?? '[]') as string[];
    expect(aPersisted.sort()).toEqual(['a-msg-1', 'a-msg-2']);
    expect(bPersisted).toEqual(['b-msg-1']);
  });

  it('an early anonymous load does not pin an empty set for the session', async () => {
    const anon = await loadRestoreTombstones('');
    expect(anon.size).toBe(0);
    await addRestoreTombstones('user-A', ['a-1']);
    expect((await loadRestoreTombstones('user-A')).has('a-1')).toBe(true);
    expect(isRestoreTombstoned('a-1')).toBe(true);
  });

  it('switching back re-loads the owner’s persisted set from storage', async () => {
    await addRestoreTombstones('user-A', ['a-1']);
    await loadRestoreTombstones('user-B');
    const aAgain = await loadRestoreTombstones('user-A');
    expect(aAgain.has('a-1')).toBe(true);
  });
});
