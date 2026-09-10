/**
 * B-115 - session directory-name resolver.
 *
 * Pins: batched+debounced fetch writes into store.directoryNames; queried
 * ids are never re-fetched (attempted cache); 'self'/empty ids ignored;
 * setDirectoryNames trims and drops empty names; fetch failure leaves ids
 * retryable.
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
jest.mock('@services/api', () => ({
  tokenStore: {get: () => 'tok'},
  refreshAccessTokenShared: jest.fn(async () => {}),
}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'http://test.local', MSG_BASE_URL: 'http://test.local'}));

const mockGetProfiles = jest.fn();
jest.mock('@bravo/messenger-core', () => ({
  UsersHttpClient: class {
    getProfilesByIds = (...a: unknown[]) => mockGetProfiles(...a);
  },
}));

import {useMessengerStore} from '../store/messengerStore';
import {ensureDirectoryNames, _resetDirectoryNamesForTests} from '../contacts/directoryNames';

const flushMicrotasks = async () => { await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  jest.useFakeTimers();
  useMessengerStore.getState().reset();
  _resetDirectoryNamesForTests();
  mockGetProfiles.mockReset();
});
afterEach(() => { jest.useRealTimers(); });

describe('setDirectoryNames', () => {
  it('merges trimmed names and ignores empties', () => {
    useMessengerStore.getState().setDirectoryNames({u1: '  Alice  ', u2: '', u3: 'Bob'});
    const names = useMessengerStore.getState().directoryNames;
    expect(names.u1).toBe('Alice');
    expect(names.u2).toBeUndefined();
    expect(names.u3).toBe('Bob');
  });
});

describe('ensureDirectoryNames', () => {
  it('batches, debounces, and writes resolved names to the store', async () => {
    mockGetProfiles.mockResolvedValue([
      {userId: 'u1', displayName: 'Alice', avatarUrl: null},
      {userId: 'u2', displayName: 'Bob', avatarUrl: null},
    ]);
    ensureDirectoryNames(['u1']);
    ensureDirectoryNames(['u2', 'self', '']);
    jest.advanceTimersByTime(350);
    await flushMicrotasks();

    expect(mockGetProfiles).toHaveBeenCalledTimes(1);
    const queried = mockGetProfiles.mock.calls[0][0] as string[];
    expect([...queried].sort()).toEqual(['u1', 'u2']);
    const names = useMessengerStore.getState().directoryNames;
    expect(names.u1).toBe('Alice');
    expect(names.u2).toBe('Bob');
  });

  it('never re-fetches attempted ids (even unresolved ones)', async () => {
    mockGetProfiles.mockResolvedValue([{userId: 'u1', displayName: 'Alice', avatarUrl: null}]);
    ensureDirectoryNames(['u1', 'u-unknown']);
    jest.advanceTimersByTime(350);
    await flushMicrotasks();
    ensureDirectoryNames(['u1', 'u-unknown']);
    jest.advanceTimersByTime(350);
    await flushMicrotasks();
    expect(mockGetProfiles).toHaveBeenCalledTimes(1);
  });

  it('leaves ids retryable after a failed fetch', async () => {
    mockGetProfiles.mockRejectedValueOnce(new Error('offline'));
    ensureDirectoryNames(['u1']);
    jest.advanceTimersByTime(350);
    await flushMicrotasks();
    mockGetProfiles.mockResolvedValue([{userId: 'u1', displayName: 'Alice', avatarUrl: null}]);
    ensureDirectoryNames(['u1']);
    jest.advanceTimersByTime(350);
    await flushMicrotasks();
    expect(mockGetProfiles).toHaveBeenCalledTimes(2);
    expect(useMessengerStore.getState().directoryNames.u1).toBe('Alice');
  });
});
