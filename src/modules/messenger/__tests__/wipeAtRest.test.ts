/**
 * F11 — wipeUserAtRest must destroy EVERY per-user keychain compartment,
 * not just the legacy DB key / group-wrap / mirror trio: the P0-S5-residual
 * per-compartment SQLCipher keys (id/rt/msg) and the P1-N12 Merkle-seq
 * HMAC key are at-rest material too. Also locks in the best-effort
 * contract: one failing branch never skips the remaining steps.
 */
jest.mock('react-native', () => ({Platform: {OS: 'android'}}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));
jest.mock('@op-engineering/op-sqlite', () => ({
  open: jest.fn(() => ({delete: jest.fn(), close: jest.fn()})),
}));
jest.mock('../runtime/keychain', () => ({
  ALL_COMPARTMENTS: ['id', 'rt', 'msg'],
  getOrCreateDbKey: jest.fn(() => Promise.resolve('a'.repeat(64))),
  destroyDbKey: jest.fn(() => Promise.resolve()),
  destroyGroupWrapKey: jest.fn(() => Promise.resolve()),
  destroyCompartmentDbKey: jest.fn(() => Promise.resolve()),
  destroyMerkleSeqHmacKey: jest.fn(() => Promise.resolve()),
  clearMirrorMasterKey: jest.fn(() => Promise.resolve()),
}));

import {wipeUserAtRest} from '../runtime/wipeAtRest';
import {
  destroyDbKey,
  destroyGroupWrapKey,
  destroyCompartmentDbKey,
  destroyMerkleSeqHmacKey,
  clearMirrorMasterKey,
} from '../runtime/keychain';

const mockDestroyCompartment = destroyCompartmentDbKey as jest.Mock;
const mockDestroyMerkle = destroyMerkleSeqHmacKey as jest.Mock;

const OWNER = 'user@example.com';

describe('wipeUserAtRest — F11 residual keychain material', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDestroyCompartment.mockResolvedValue(undefined);
    mockDestroyMerkle.mockResolvedValue(undefined);
  });

  it('destroys all three per-compartment keys AND the Merkle-seq HMAC key', async () => {
    const report = await wipeUserAtRest(OWNER);

    expect(mockDestroyCompartment).toHaveBeenCalledTimes(3);
    expect(mockDestroyCompartment).toHaveBeenCalledWith(OWNER, 'id');
    expect(mockDestroyCompartment).toHaveBeenCalledWith(OWNER, 'rt');
    expect(mockDestroyCompartment).toHaveBeenCalledWith(OWNER, 'msg');
    expect(mockDestroyMerkle).toHaveBeenCalledWith(OWNER);

    expect(report.compartmentKeysDestroyed).toBe(true);
    expect(report.merkleSeqKeyDestroyed).toBe(true);
    // The pre-existing steps still run.
    expect(destroyDbKey).toHaveBeenCalledWith(OWNER);
    expect(destroyGroupWrapKey).toHaveBeenCalledWith(OWNER);
    expect(clearMirrorMasterKey).toHaveBeenCalledWith(OWNER);
    expect(report.errors).toEqual([]);
  });

  it('is best-effort: one failing compartment never skips the rest', async () => {
    mockDestroyCompartment.mockImplementation((_owner: string, c: string) =>
      c === 'rt' ? Promise.reject(new Error('keystore busy')) : Promise.resolve(),
    );

    const report = await wipeUserAtRest(OWNER);

    // All three attempted despite the middle one failing.
    expect(mockDestroyCompartment).toHaveBeenCalledTimes(3);
    expect(report.compartmentKeysDestroyed).toBe(false);
    expect(report.errors.some(e => e.includes('compartment key destroy (rt)'))).toBe(true);
    // The steps AFTER the failure still ran.
    expect(mockDestroyMerkle).toHaveBeenCalledWith(OWNER);
    expect(report.merkleSeqKeyDestroyed).toBe(true);
    expect(report.asyncStorageStripped).toBe(true);
  });

  it('a failing Merkle-key destroy is reported but non-fatal', async () => {
    mockDestroyMerkle.mockRejectedValueOnce(new Error('no entry'));

    const report = await wipeUserAtRest(OWNER);

    expect(report.merkleSeqKeyDestroyed).toBe(false);
    expect(report.errors.some(e => e.includes('merkle seq key destroy'))).toBe(true);
    expect(report.compartmentKeysDestroyed).toBe(true);
    expect(report.asyncStorageStripped).toBe(true);
  });

  it('empty ownerKey short-circuits without touching the keychain', async () => {
    const report = await wipeUserAtRest('');
    expect(report.errors).toHaveLength(1);
    expect(mockDestroyCompartment).not.toHaveBeenCalled();
    expect(mockDestroyMerkle).not.toHaveBeenCalled();
  });
});
