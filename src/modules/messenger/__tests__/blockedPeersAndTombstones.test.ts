import {
  loadBlockedPeers, setBlockedPeers, addBlockedPeer, removeBlockedPeer,
  isPeerBlocked, _resetBlockedPeersForTests,
} from '../runtime/blockedPeers';
import {
  loadRestoreTombstones, addRestoreTombstones, isRestoreTombstoned,
  _resetRestoreTombstonesForTests,
} from '../backup/restoreTombstones';

// In-memory AsyncStorage stand-in.
jest.mock('@react-native-async-storage/async-storage', () => {
  const mem = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: jest.fn(async (k: string) => (mem.has(k) ? mem.get(k)! : null)),
      setItem: jest.fn(async (k: string, v: string) => { mem.set(k, v); }),
      removeItem: jest.fn(async (k: string) => { mem.delete(k); }),
      __mem: mem,
    },
  };
});


const store = require('@react-native-async-storage/async-storage').default;

beforeEach(() => {
  (store.__mem as Map<string, string>).clear();
  _resetBlockedPeersForTests();
  _resetRestoreTombstonesForTests();
});

describe('blockedPeers (M-07 / P1-10 owner-scoped)', () => {
  it('fails open before load — never drops when uninitialised', () => {
    expect(isPeerBlocked('u1')).toBe(false);
  });

  it('add → isPeerBlocked true; remove → false; persists across a reload (per owner)', async () => {
    await loadBlockedPeers('owner-A');
    await addBlockedPeer('u1');
    expect(isPeerBlocked('u1')).toBe(true);

    _resetBlockedPeersForTests();
    await loadBlockedPeers('owner-A');
    expect(isPeerBlocked('u1')).toBe(true); // survived persistence under owner-A's key

    await removeBlockedPeer('u1');
    expect(isPeerBlocked('u1')).toBe(false);
  });

  it('setBlockedPeers REPLACES the set (an unblock elsewhere removes ids)', async () => {
    await loadBlockedPeers('owner-A');
    await setBlockedPeers(['a', 'b', 'c']);
    expect(isPeerBlocked('a')).toBe(true);
    await setBlockedPeers(['a']); // b, c unblocked on another device
    expect(isPeerBlocked('a')).toBe(true);
    expect(isPeerBlocked('b')).toBe(false);
    expect(isPeerBlocked('c')).toBe(false);
  });

  it('P1-10 — reset on owner switch: account B never inherits account A blocks', async () => {
    await loadBlockedPeers('owner-A');
    await addBlockedPeer('victimX');
    expect(isPeerBlocked('victimX')).toBe(true);

    // Owner switch — the runtime build calls loadBlockedPeers with the NEW owner;
    // the in-memory set must reset so B doesn't inherit A's (wrong-user) blocks.
    await loadBlockedPeers('owner-B');
    expect(isPeerBlocked('victimX')).toBe(false);

    // Switching back to A restores A's blocks from A's own persisted key.
    await loadBlockedPeers('owner-A');
    expect(isPeerBlocked('victimX')).toBe(true);
  });

  it('P1-10 — each owner persists under a DISTINCT storage key', async () => {
    await loadBlockedPeers('owner-A');
    await setBlockedPeers(['a1']);
    _resetBlockedPeersForTests();
    await loadBlockedPeers('owner-B');
    await setBlockedPeers(['b1']);

    const mem = store.__mem as Map<string, string>;
    expect(JSON.parse(mem.get('messenger.blockedPeers.v1.owner-A')!)).toEqual(['a1']);
    expect(JSON.parse(mem.get('messenger.blockedPeers.v1.owner-B')!)).toEqual(['b1']);
    // No un-scoped global key is written.
    expect(mem.has('messenger.blockedPeers.v1')).toBe(false);
  });

  it('ignores empty/undefined ids', () => {
    expect(isPeerBlocked('')).toBe(false);
    expect(isPeerBlocked(undefined)).toBe(false);
    expect(isPeerBlocked(null)).toBe(false);
  });
});

describe('restoreTombstones (M-08)', () => {
  it('fails open before load / when empty', () => {
    expect(isRestoreTombstoned('m1')).toBe(false);
  });

  it('captured deleted ids block resurrection and persist per owner', async () => {
    await loadRestoreTombstones('owner-1');
    await addRestoreTombstones('owner-1', ['m1', 'm2']);
    expect(isRestoreTombstoned('m1')).toBe(true);
    expect(isRestoreTombstoned('m2')).toBe(true);
    expect(isRestoreTombstoned('m3')).toBe(false);

    _resetRestoreTombstonesForTests();
    await loadRestoreTombstones('owner-1');
    expect(isRestoreTombstoned('m1')).toBe(true); // survived persistence
  });

  it('a fresh (never-restored) owner has an empty gate — live delivery unaffected', async () => {
    await loadRestoreTombstones('owner-2');
    expect(isRestoreTombstoned('anything')).toBe(false);
  });
});
