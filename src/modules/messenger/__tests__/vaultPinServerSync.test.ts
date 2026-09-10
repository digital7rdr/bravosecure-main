/**
 * B-696 Phase B client glue + review F1 (VAULT_DURABILITY_DESIGN §4.2).
 *
 * sqa.md bug register — this suite pins: B-696 (PIN-follows-the-person half):
 * the sync-debt bookkeeping is ARMED, not decorative — an offline set records
 * `pinSyncPending`, a server refusal records `pinServerDiverged`, the unlock
 * reconcile retries the debt and mints a missing verifier, the divergence
 * prompt edge fires exactly once, the debt survives the owner stash
 * round-trip, and the proven-PIN holder is single-take, TTL-bound and never
 * persisted. The F1 finding was exactly "the documented self-heal was never
 * implemented" — this suite is what notices it regressing.
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

jest.mock('react-native-quick-crypto', () => {
  const nodeCrypto = jest.requireActual('node:crypto');
  return {
    __esModule: true,
    createHash: nodeCrypto.createHash,
    install:    () => {},
    createHmac: nodeCrypto.createHmac,
  };
});

const mockAuthApi = {
  getVaultPinStatus: jest.fn(),
  setVaultPin:       jest.fn(),
  verifyVaultPin:    jest.fn(),
};
jest.mock('@/services/api', () => ({
  __esModule: true,
  authApi: mockAuthApi,
}));

import {useVaultStore} from '../vault/vaultStore';
import {
  syncPinToServer,
  reconcileServerPin,
  notePinProven,
  takeProvenPin,
  clearProvenPin,
} from '../vault/vaultPinSession';

const st = () => useVaultStore.getState();

const httpErr = (message: string) => Object.assign(new Error(message), {response: {data: {message}}});
const netErr  = () => new Error('Network Error');   // no .response ⇒ offline

beforeEach(() => {
  jest.clearAllMocks();
  clearProvenPin();
  st().reset();
  mockAuthApi.getVaultPinStatus.mockResolvedValue({exists: true});
  mockAuthApi.setVaultPin.mockResolvedValue({ok: true});
  mockAuthApi.verifyVaultPin.mockResolvedValue({ok: true});
});

describe('syncPinToServer — the set/change lane records its own debt', () => {
  it('ok clears both flags', async () => {
    st().setPinSyncState({pending: true, diverged: true});
    expect(await syncPinToServer('123456')).toBe('ok');
    expect(st().pinSyncPending).toBe(false);
    expect(st().pinServerDiverged).toBe(false);
  });

  it('offline records pinSyncPending — the F1 retry debt', async () => {
    mockAuthApi.setVaultPin.mockRejectedValueOnce(netErr());
    expect(await syncPinToServer('123456')).toBe('offline');
    expect(st().pinSyncPending).toBe(true);
    expect(st().pinServerDiverged).toBe(false);
  });

  it('a server refusal records pinServerDiverged (never retried blind — S2)', async () => {
    mockAuthApi.setVaultPin.mockRejectedValueOnce(httpErr('current_pin_required'));
    expect(await syncPinToServer('123456')).toBe('refused');
    expect(st().pinServerDiverged).toBe(true);
    expect(st().pinSyncPending).toBe(false);
  });

  it('the change lane forwards currentPin; first-set sends none', async () => {
    await syncPinToServer('654321', '123456');
    expect(mockAuthApi.setVaultPin).toHaveBeenCalledWith({pin: '654321', currentPin: '123456'});
    await syncPinToServer('654321');
    expect(mockAuthApi.setVaultPin).toHaveBeenLastCalledWith({pin: '654321'});
  });
});

describe('reconcileServerPin — the unlock-time settle', () => {
  it('mints a missing verifier (legacy self-heal) and reports minted', async () => {
    mockAuthApi.getVaultPinStatus.mockResolvedValueOnce({exists: false});
    expect(await reconcileServerPin('123456')).toBe('minted');
    expect(mockAuthApi.setVaultPin).toHaveBeenCalledWith({pin: '123456'});
  });

  it('with NO recorded debt it never spends a server verify (lockout-budget rule)', async () => {
    expect(await reconcileServerPin('123456')).toBe('in-sync');
    expect(mockAuthApi.verifyVaultPin).not.toHaveBeenCalled();
  });

  it('pays a pending debt when the server matches', async () => {
    st().setPinSyncState({pending: true});
    expect(await reconcileServerPin('123456')).toBe('in-sync');
    expect(mockAuthApi.verifyVaultPin).toHaveBeenCalledWith({pin: '123456'});
    expect(st().pinSyncPending).toBe(false);
  });

  it('confirms divergence ONCE — diverged-new, then diverged-known forever after', async () => {
    st().setPinSyncState({pending: true});
    mockAuthApi.verifyVaultPin.mockRejectedValue(httpErr('pin_invalid'));
    expect(await reconcileServerPin('123456')).toBe('diverged-new');
    expect(st().pinServerDiverged).toBe(true);
    expect(await reconcileServerPin('123456')).toBe('diverged-known');
  });

  it('offline keeps the debt for the next unlock', async () => {
    st().setPinSyncState({pending: true});
    mockAuthApi.getVaultPinStatus.mockRejectedValueOnce(netErr());
    expect(await reconcileServerPin('123456')).toBe('offline');
    expect(st().pinSyncPending).toBe(true);
  });
});

describe('the debt survives what it must survive', () => {
  it('rides the owner stash round trip', () => {
    st().adoptVaultOwner('owner-a');
    st().setPinSyncState({pending: true, diverged: true});
    // A pristine slice stashes as nothing — give it a pin-less file? No:
    // the flags only matter alongside a PIN, so set one marker file.
    useVaultStore.setState({pinHash: '$argon2id$x'});
    st().stashAndClearOwner();
    expect(st().pinSyncPending).toBe(false);   // flat cleared for the next user
    st().adoptVaultOwner('owner-a');
    expect(st().pinSyncPending).toBe(true);
    expect(st().pinServerDiverged).toBe(true);
  });

  it('is in the persisted partial (a restart cannot forget the debt)', () => {
    const partialize = (useVaultStore as unknown as {
      persist: {getOptions: () => {partialize: (s: unknown) => Record<string, unknown>}};
    }).persist.getOptions().partialize;
    const out = partialize(useVaultStore.getState());
    expect(Object.keys(out)).toEqual(expect.arrayContaining(['pinSyncPending', 'pinServerDiverged']));
  });
});

describe('the proven-PIN holder', () => {
  it('is single-take', () => {
    notePinProven('123456');
    expect(takeProvenPin()).toBe('123456');
    expect(takeProvenPin()).toBeNull();
  });

  it('expires with the presence window', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(1_000_000);
      notePinProven('123456');
      jest.setSystemTime(1_000_000 + 61_000);
      expect(takeProvenPin()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('never reaches the persisted record', () => {
    notePinProven('987654');
    const partialize = (useVaultStore as unknown as {
      persist: {getOptions: () => {partialize: (s: unknown) => unknown}};
    }).persist.getOptions().partialize;
    expect(JSON.stringify(partialize(useVaultStore.getState()))).not.toContain('987654');
  });
});
