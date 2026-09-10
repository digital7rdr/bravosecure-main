/**
 * Smoke test for the `openVault` routing helper.
 *
 * Exercises all three branches of the first-time-vs-returning-user logic:
 *   1. No PIN stored         → VaultNewPin (setup flow)
 *   2. Unlocked (within TTL) → VaultScreen (direct)
 *   3. Locked                → VaultLock   (biometric-first, PIN fallback)
 *
 * Doesn't render components — the helper is a plain function that reads
 * the store and calls `nav.navigate`, so we stub a minimal Nav mock and
 * assert both the return value and the navigation target.
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

// M1A rule 12 — the entitlement seam is mocked entitled-by-default so the
// three routing branches below stay exercised; the TierGate suite flips it.
jest.mock('../vault/entitlementGate', () => ({
  hasCloudVaultEntitlement: jest.fn(() => true),
  promptCloudVaultUpgrade: jest.fn(),
}));

import {openVault} from '../vault/navigation';
import {useVaultStore} from '../vault/vaultStore';
import {hasCloudVaultEntitlement, promptCloudVaultUpgrade} from '../vault/entitlementGate';

const mockEntitled = hasCloudVaultEntitlement as jest.Mock;
const mockPrompt = promptCloudVaultUpgrade as jest.Mock;

function makeNavStub() {
  const navigate = jest.fn();
  // Cast through unknown — we only use .navigate in openVault, so the rest
  // of NativeStackNavigationProp doesn't need to be populated.
  return {nav: {navigate} as unknown as Parameters<typeof openVault>[0], navigate};
}

describe('openVault — first-time vs returning-user routing', () => {
  beforeEach(() => {
    // Round 3 / vault-test-refactor: leave microtask scheduling real
    // so async setupPin/verifyPin resolve naturally inside `await`.
    jest.useFakeTimers({doNotFake: ['queueMicrotask', 'setImmediate']});
    jest.setSystemTime(new Date('2026-04-21T00:00:00Z'));
    useVaultStore.getState().reset();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('routes to VaultNewPin when no PIN has ever been set', () => {
    const {nav, navigate} = makeNavStub();
    const target = openVault(nav);
    expect(target).toBe('VaultNewPin');
    expect(navigate).toHaveBeenCalledWith('VaultNewPin');
  });

  it('routes directly to VaultScreen when the vault is already unlocked', async () => {
    await useVaultStore.getState().setupPin('123456'); // setup opens the unlock window
    const {nav, navigate} = makeNavStub();

    const target = openVault(nav);
    expect(target).toBe('VaultScreen');
    expect(navigate).toHaveBeenCalledWith('VaultScreen');
  });

  it('routes to VaultLock when a PIN exists but the window has closed', async () => {
    await useVaultStore.getState().setupPin('123456');
    useVaultStore.getState().lock();

    const {nav, navigate} = makeNavStub();
    const target = openVault(nav);
    expect(target).toBe('VaultLock');
    expect(navigate).toHaveBeenCalledWith('VaultLock');
  });

  it('routes to VaultLock after the 5-minute window expires', async () => {
    await useVaultStore.getState().setupPin('123456');
    jest.setSystemTime(Date.now() + 6 * 60 * 1000); // 6 minutes later

    const {nav, navigate} = makeNavStub();
    const target = openVault(nav);
    expect(target).toBe('VaultLock');
    expect(navigate).toHaveBeenCalledWith('VaultLock');
  });

  it('after verifying the PIN, a second openVault goes straight to the vault', async () => {
    await useVaultStore.getState().setupPin('123456');
    useVaultStore.getState().lock();

    // First entry after relock → VaultLock
    const a = makeNavStub();
    expect(openVault(a.nav)).toBe('VaultLock');

    // Simulate successful PIN entry on the lock screen.
    // verifyPin is now async + returns a discriminated union
    // ({ok: true} | {ok: false, …}); check ok=true.
    expect((await useVaultStore.getState().verifyPin('123456')).ok).toBe(true);

    // Subsequent entry routes directly, no re-prompt
    const b = makeNavStub();
    expect(openVault(b.nav)).toBe('VaultScreen');
    expect(b.navigate).toHaveBeenCalledWith('VaultScreen');
  });

  it('biometric unlock gives the same direct-entry behaviour as PIN', async () => {
    await useVaultStore.getState().setupPin('123456');
    useVaultStore.getState().lock();
    useVaultStore.getState().unlockWithBiometric();

    const {nav, navigate} = makeNavStub();
    expect(openVault(nav)).toBe('VaultScreen');
    expect(navigate).toHaveBeenCalledWith('VaultScreen');
  });
});

/**
 * M1A rule 12 — Secure Cloud Vault is Pro+ on the matrix. openVault is the
 * single navigation choke point: an unentitled account gets the upgrade
 * ask and NO vault route — not even the PIN-setup screen (setting up a PIN
 * for a vault you can't use is a dead end). The server backstops this at
 * action-token issuance, so this gate is UX, not security.
 */
describe('openVault — tier gate (M1A)', () => {
  beforeEach(() => {
    mockEntitled.mockReturnValue(false);
    mockPrompt.mockClear();
  });
  afterEach(() => {
    mockEntitled.mockReturnValue(true);
  });

  it('unentitled: prompts the upgrade ask and never navigates', async () => {
    const {nav, navigate} = makeNavStub();
    expect(openVault(nav)).toBe('TierGate');
    expect(navigate).not.toHaveBeenCalled();
    expect(mockPrompt).toHaveBeenCalledTimes(1);
  });

  it('unentitled + existing PIN + unlocked: STILL gated (lapse mid-session)', async () => {
    mockEntitled.mockReturnValue(true);
    await useVaultStore.getState().setupPin('123456');
    mockEntitled.mockReturnValue(false);

    const {nav, navigate} = makeNavStub();
    expect(openVault(nav)).toBe('TierGate');
    expect(navigate).not.toHaveBeenCalled();
  });
});
