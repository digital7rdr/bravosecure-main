/**
 * B-696 — owner-scoped vault stash (VAULT_DURABILITY_DESIGN_2026-08-29 §3).
 *
 * sqa.md bug register — this suite pins: B-696.
 *
 * The Issue-30/20 sign-out used to call `reset()`, destroying the ONLY copy
 * of the per-file AES keys — a plain sign-out/sign-in permanently orphaned
 * the user's own vault while their chat history survived. Isolation now
 * comes from scoping: sign-out STASHES the flat slice under its owner and
 * CLEARS it; the owner's next sign-in adopts it back. These tests pin both
 * halves — the durability (data survives the round-trip byte-identically)
 * AND the isolation (the next account sees nothing, misattribution is
 * impossible, remove-account leaves no residue).
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

import {useVaultStore, type VaultFile} from '../vault/vaultStore';

const file = (objectKey: string, overrides: Partial<VaultFile> = {}): VaultFile => ({
  objectKey,
  keyB64:    `key-${objectKey}`,
  ivB64:     `iv-${objectKey}`,
  name:      `${objectKey}.bin`,
  size:      128,
  mimeType:  'application/octet-stream',
  createdAt: 1_000,
  ...overrides,
});

const st = () => useVaultStore.getState();

beforeEach(() => {
  st().reset();
});

describe('B-696 — stash-and-adopt round trip', () => {
  it('sign-out stashes and clears; the same owner adopts everything back byte-identically', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('123456');
    st().addFile(file('vault/a/1'));
    st().addFile(file('vault/a/2'));
    const {id: albumId} = st().createVaultAlbum('Contracts');
    expect(albumId).not.toBeNull();
    expect(st().moveToVaultAlbum(['vault/a/1'], albumId!)).toBeNull();
    const stashedFiles = st().files.map(f => ({...f}));

    st().stashAndClearOwner();

    // Isolation half — the flat slice is EMPTY for whoever comes next.
    expect(st().hasPin()).toBe(false);
    expect(st().files).toHaveLength(0);
    expect(st().albumState.albums).toHaveLength(0);
    expect(st().vaultOwner).toBeNull();

    // Durability half — the owner's next sign-in gets it all back.
    st().adoptVaultOwner('owner-a');
    expect(st().vaultOwner).toBe('owner-a');
    expect(st().files).toEqual(stashedFiles);
    expect(st().albumState.albums.map(a => a.name)).toEqual(['Contracts']);
    expect(st().albumState.assignments['vault/a/1']).toBe(albumId);
    expect(await st().verifyPin('123456')).toEqual({ok: true});
  });

  it('two accounts on one device never see each other, in either direction', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('111111');
    st().addFile(file('vault/a/1'));
    st().stashAndClearOwner();

    st().adoptVaultOwner('owner-b');
    expect(st().hasPin()).toBe(false);
    expect(st().files).toHaveLength(0);
    await st().setupPin('222222');
    st().addFile(file('vault/b/1'));
    st().stashAndClearOwner();

    st().adoptVaultOwner('owner-a');
    expect(st().files.map(f => f.objectKey)).toEqual(['vault/a/1']);
    expect(await st().verifyPin('222222')).toMatchObject({ok: false});
    // The wrong-PIN probe above burned an attempt for A; B must not inherit it.
    st().stashAndClearOwner();
    st().adoptVaultOwner('owner-b');
    expect(st().files.map(f => f.objectKey)).toEqual(['vault/b/1']);
    expect(st().failedAttempts).toBe(0);
    expect(await st().verifyPin('222222')).toEqual({ok: true});
  });

  it('adopt() directly from one owner to another stashes the outgoing owner first', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('111111');
    st().addFile(file('vault/a/1'));

    // No sign-out ran (e.g. account switch edge) — adopt must not leak A into B.
    st().adoptVaultOwner('owner-b');
    expect(st().hasPin()).toBe(false);
    expect(st().files).toHaveLength(0);

    st().adoptVaultOwner('owner-a');
    expect(st().files.map(f => f.objectKey)).toEqual(['vault/a/1']);
  });

  it('the stash is a SNAPSHOT — later flat mutations cannot reach it (audit fix #15 class)', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('111111');
    st().addFile(file('vault/a/1'));
    st().stashAndClearOwner();

    st().adoptVaultOwner('owner-b');
    st().addFile(file('vault/b/1'));
    st().stashAndClearOwner();

    st().adoptVaultOwner('owner-a');
    expect(st().files.map(f => f.objectKey)).toEqual(['vault/a/1']);
  });
});

describe('B-696 — legacy claim and attribution safety', () => {
  it('a pre-B-696 blob (data with no vaultOwner) is CLAIMED by the sitting user, not stashed under null', async () => {
    // Simulate the legacy shape: PIN + files exist, vaultOwner was never stamped.
    await st().setupPin('123456');
    st().addFile(file('vault/legacy/1'));
    expect(st().vaultOwner).toBeNull();

    st().adoptVaultOwner('owner-a');

    expect(st().vaultOwner).toBe('owner-a');
    expect(st().files.map(f => f.objectKey)).toEqual(['vault/legacy/1']);
    expect(st().hasPin()).toBe(true);
    expect(Object.keys(st().ownerStashes)).toHaveLength(0);
  });

  it('sign-out with no attributable owner falls back to the caller-supplied key', async () => {
    await st().setupPin('123456');
    st().addFile(file('vault/legacy/1'));

    st().stashAndClearOwner('owner-a');   // authStore passes ownerKeyForWipe

    expect(st().hasPin()).toBe(false);
    st().adoptVaultOwner('owner-a');
    expect(st().files.map(f => f.objectKey)).toEqual(['vault/legacy/1']);
  });

  it('sign-out with NO owner at all DROPS the data — misattribution is worse than loss', async () => {
    await st().setupPin('123456');
    st().addFile(file('vault/legacy/1'));

    st().stashAndClearOwner(null);

    expect(st().hasPin()).toBe(false);
    expect(st().files).toHaveLength(0);
    expect(Object.keys(st().ownerStashes)).toHaveLength(0);
  });

  it('a pristine flat slice stashes as nothing (no empty-stash residue)', () => {
    st().adoptVaultOwner('owner-a');
    st().stashAndClearOwner();
    expect(Object.keys(st().ownerStashes)).toHaveLength(0);
  });
});

describe('B-696 — remove-account (purgeOwner) leaves no residue', () => {
  it('purges the live flat slice AND the stash for that owner, nothing else', async () => {
    st().adoptVaultOwner('owner-b');
    await st().setupPin('222222');
    st().addFile(file('vault/b/1'));
    st().stashAndClearOwner();

    st().adoptVaultOwner('owner-a');
    await st().setupPin('111111');
    st().addFile(file('vault/a/1'));

    st().purgeOwner('owner-a');

    expect(st().hasPin()).toBe(false);
    expect(st().files).toHaveLength(0);
    expect(st().vaultOwner).toBeNull();
    expect(st().ownerStashes['owner-a']).toBeUndefined();
    // The OTHER owner's stash survives — remove-account is per-owner.
    expect(st().ownerStashes['owner-b']).toBeDefined();
  });

  it('purges a stashed (signed-out) owner too', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('111111');
    st().stashAndClearOwner();

    st().purgeOwner('owner-a');
    st().adoptVaultOwner('owner-a');
    expect(st().hasPin()).toBe(false);
  });
});

describe('B-696 — session state never survives the swap', () => {
  it('adopting an owner always lands LOCKED with no presence proof, even though setup unlocked', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('123456');
    expect(st().isUnlocked()).toBe(true);
    expect(st().pinFresh()).toBe(true);

    st().stashAndClearOwner();
    st().adoptVaultOwner('owner-a');

    expect(st().isUnlocked()).toBe(false);
    expect(st().pinFresh()).toBe(false);
    expect(st().unlockedUntil).toBeNull();
    expect(st().lastPinProofAt).toBeNull();
  });

  it('lockout counters DO travel with their owner (a restartless bypass must not exist)', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('123456');
    await st().verifyPin('000000');
    await st().verifyPin('000001');
    expect(st().failedAttempts).toBe(2);

    st().stashAndClearOwner();
    st().adoptVaultOwner('owner-a');
    expect(st().failedAttempts).toBe(2);
  });

  it('re-adopting the SAME owner is a no-op (no self-stash wipe)', async () => {
    st().adoptVaultOwner('owner-a');
    await st().setupPin('123456');
    st().addFile(file('vault/a/1'));

    st().adoptVaultOwner('owner-a');

    expect(st().hasPin()).toBe(true);
    expect(st().files).toHaveLength(1);
  });
});
