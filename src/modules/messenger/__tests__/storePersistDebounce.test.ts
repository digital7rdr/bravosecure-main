/**
 * Audit fix #13 — the debounced AsyncStorage adapter the messenger store
 * persists through. Never executed by a test before this file, even though it
 * sits in front of EVERY vault write.
 *
 * Two things it must get right:
 *
 *   1. COALESCING. zustand's persist calls setItem on every state mutation, and
 *      partialize stringifies the whole per-owner vault each time. A busy chat
 *      (typing flags, status flips) was paying that per keystroke. A burst
 *      inside the 500 ms window must reach AsyncStorage exactly ONCE, carrying
 *      the LAST value — coalescing to the FIRST would persist stale state.
 *
 *   2. removeItem CANCELS the pending write. This is the correctness half, not
 *      an optimisation: logout/wipe removes the key, and a queued flush landing
 *      afterwards would rewrite the vault the wipe just deleted. Reads and
 *      removes go straight through; only writes are deferred.
 *
 * The adapter is module-private, so it is reached the way the app reaches it —
 * through `useMessengerStore.persist.getOptions().storage`, the JSON wrapper
 * `createJSONStorage` built around it.
 */

const mockGetItem    = jest.fn(async (_k: string) => null as string | null);
const mockSetItem    = jest.fn(async (_k: string, _v: string) => {});
const mockRemoveItem = jest.fn(async (_k: string) => {});

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    (k: string) => mockGetItem(k),
    setItem:    (k: string, v: string) => mockSetItem(k, v),
    removeItem: (k: string) => mockRemoveItem(k),
  },
}));

import {useMessengerStore} from '../store/messengerStore';

const KEY = 'messenger-store-v1';

type JsonStorage = {
  getItem:    (name: string) => Promise<unknown>;
  setItem:    (name: string, value: unknown) => unknown;
  removeItem: (name: string) => Promise<void> | void;
};
const storage = (): JsonStorage =>
  (useMessengerStore as unknown as {persist: {getOptions: () => {storage: JsonStorage}}})
    .persist.getOptions().storage;

const blob = (owner: string) => ({state: {_ownUserId: owner, vaultByOwner: {}}, version: 0});

beforeEach(() => {
  jest.useFakeTimers();
  mockGetItem.mockClear();
  mockSetItem.mockClear();
  mockRemoveItem.mockClear();
});

afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('debounced persist adapter', () => {
  it('coalesces a burst of writes into ONE AsyncStorage.setItem carrying the LAST value', () => {
    const s = storage();
    s.setItem(KEY, blob('owner-1'));
    s.setItem(KEY, blob('owner-2'));
    s.setItem(KEY, blob('owner-3'));

    // Nothing has hit the disk yet — that is the whole point.
    expect(mockSetItem).not.toHaveBeenCalled();

    jest.advanceTimersByTime(499);
    expect(mockSetItem).not.toHaveBeenCalled();

    // Each write RESETS the window, so the flush lands 500 ms after the LAST one.
    jest.advanceTimersByTime(1);
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    expect(mockSetItem.mock.calls[0][0]).toBe(KEY);
    expect(JSON.parse(mockSetItem.mock.calls[0][1]).state._ownUserId).toBe('owner-3');
  });

  it('a later write after the window flushes again (the timer is not one-shot)', () => {
    const s = storage();
    s.setItem(KEY, blob('owner-1'));
    jest.advanceTimersByTime(500);
    expect(mockSetItem).toHaveBeenCalledTimes(1);

    s.setItem(KEY, blob('owner-2'));
    jest.advanceTimersByTime(500);
    expect(mockSetItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mockSetItem.mock.calls[1][1]).state._ownUserId).toBe('owner-2');
  });

  it('reads are NOT debounced — they pass straight through', async () => {
    mockGetItem.mockResolvedValueOnce(JSON.stringify(blob('owner-1')));
    const read = await storage().getItem(KEY);

    expect(mockGetItem).toHaveBeenCalledWith(KEY);
    expect((read as {state: {_ownUserId: string}}).state._ownUserId).toBe('owner-1');
  });

  it('removeItem CANCELS a queued write so a wipe cannot be undone by a late flush', async () => {
    const s = storage();
    s.setItem(KEY, blob('owner-1'));

    await s.removeItem(KEY);

    expect(mockRemoveItem).toHaveBeenCalledWith(KEY);
    // Advancing past the window must NOT resurrect the vault the wipe deleted.
    jest.advanceTimersByTime(2000);
    expect(mockSetItem).not.toHaveBeenCalled();
  });

  it('removeItem of a DIFFERENT key leaves the queued write alone', async () => {
    const s = storage();
    s.setItem(KEY, blob('owner-1'));

    await s.removeItem('some-other-store');

    jest.advanceTimersByTime(500);
    expect(mockSetItem).toHaveBeenCalledTimes(1);
    expect(mockSetItem.mock.calls[0][0]).toBe(KEY);
  });

  it('a rejected disk write is swallowed with a warning — it never becomes an unhandled rejection', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockSetItem.mockRejectedValueOnce(new Error('disk full'));

    storage().setItem(KEY, blob('owner-1'));
    jest.advanceTimersByTime(500);
    // Let the rejected promise settle through its .catch.
    await Promise.resolve();
    await Promise.resolve();

    expect(warn).toHaveBeenCalledWith('[messengerStore] debounced persist failed', expect.any(Error));
    warn.mockRestore();
  });
});
