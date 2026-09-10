/**
 * identityBackup — EXECUTABLE wrap/unwrap contract.
 *
 * This module is the door to every restore: `setupBackup` wraps the Signal
 * identity under a password-derived key, `restoreBackup` proves the password to
 * the server and unwraps it back into a fresh CryptoStore. Until now almost
 * none of it ran under test (16% covered), so the failure modes its own
 * docblock enumerates — wrong password, tampered wrap, out-of-bounds server KDF
 * params, a foreign account's bundle — were unpinned.
 *
 * What this suite drives, end to end, with the REAL backupCrypto (argon2 stub +
 * Node WebCrypto AES-GCM/HKDF/HMAC) and a fake server that behaves like
 * `apps/messenger-service/src/backup`:
 *
 *   • the setup → restore round trip reconstructs the identity byte-for-byte
 *   • a wrong password fails at the SERVER PROOF (P0-1), not at the unwrap
 *   • a tampered wrapped_master_key / wrapped_identity_bundle is reported as a
 *     corrupt bundle ('master_key_unwrap_failed' / 'identity_unwrap_failed'),
 *     NOT as "wrong password" — the distinction the module comments insist on
 *   • M-1: out-of-range server KDF params are rejected before native argon2
 *   • M-3: an envelope bound to a different owner warns but still restores
 *   • Round 8: `captureIdentity` scans OPK ids past 200 (the old cap silently
 *     dropped every OPK above 200 → peers using one could not be decrypted)
 *   • M-18: `reinstallIdentity` brackets the whole write in a transaction and
 *     ROLLBACKs on a mid-loop throw, writing the signed pre-key LAST
 *   • F6: `refreshIdentityBackup` re-uploads under the PINNED wrapped master
 *     key + salt + verifier key, so the server treats it as an idempotent
 *     re-setup instead of a key rotation (which wipes the mirrored history)
 */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined},
}));

jest.mock('../backup/backupClient', () => {
  const actual = jest.requireActual('../backup/backupClient') as {BackupError: unknown};
  return {
    __esModule: true,
    BackupError: actual.BackupError,
    backupClient: {
      putIdentity:       jest.fn(async () => ({ok: true})),
      getIdentityHeader: jest.fn(),
      verify:            jest.fn(),
      getIdentityBundle: jest.fn(),
    },
  };
});

import {
  captureIdentity, reinstallIdentity, setupBackup, restoreBackup,
  refreshIdentityBackup, lockIdentityBackup,
} from '../backup/identityBackup';
import {
  DEFAULT_KDF_PARAMS, aesGcmEncrypt, aesGcmDecrypt, computeVerifyProof,
  deriveMasterKeyAndRaw, deriveVerifierKey, fromB64, generateMasterKey, toB64,
  randomBytes, type KdfParams,
} from '../backup/backupCrypto';
import {backupClient, BackupError} from '../backup/backupClient';
import type {CryptoStore} from '../crypto';

const client = backupClient as unknown as {
  putIdentity:       jest.Mock;
  getIdentityHeader: jest.Mock;
  verify:            jest.Mock;
  getIdentityBundle: jest.Mock;
};

type KP = {pubKey: ArrayBuffer; privKey: ArrayBuffer};

function ab(fill: number, len = 32): ArrayBuffer {
  const u = new Uint8Array(len);
  u.fill(fill);
  return u.buffer;
}
const b64 = (buf: ArrayBuffer): string => Buffer.from(new Uint8Array(buf)).toString('base64');

/** Minimal CryptoStore with the optional hooks identityBackup probes for. */
class MemStore {
  identity: KP;
  regId = 4242;
  preKeys = new Map<number, KP>();
  signed = new Map<number, KP & {signature?: ArrayBuffer}>();
  /** Ordered log of persistence calls — the M-18 ordering assertions read it. */
  calls: string[] = [];

  constructor(seed = 1) {
    this.identity = {pubKey: ab(seed), privKey: ab(seed + 50)};
  }

  async getIdentityKeyPair(): Promise<KP> { return this.identity; }
  async getLocalRegistrationId(): Promise<number> { return this.regId; }
  async loadPreKey(id: number): Promise<KP | undefined> { return this.preKeys.get(id); }
  async storePreKey(id: number, kp: KP): Promise<void> {
    this.calls.push(`preKey:${id}`);
    this.preKeys.set(id, kp);
  }
  async loadSignedPreKey(id: number): Promise<(KP & {signature?: ArrayBuffer}) | undefined> {
    return this.signed.get(id);
  }
  async storeSignedPreKey(id: number, kp: KP, signature?: ArrayBuffer): Promise<void> {
    this.calls.push(`signedPreKey:${id}`);
    this.signed.set(id, {...kp, signature});
  }
  saveOwnIdentity = jest.fn(async (regId: number, pub: ArrayBuffer, priv: ArrayBuffer): Promise<void> => {
    this.calls.push('ownIdentity');
    this.regId = regId;
    this.identity = {pubKey: pub, privKey: priv};
  });
}

/** A populated source device: identity + signed pre-key + `n` OPKs from id 1. */
function seededStore(n: number, seed = 1): MemStore {
  const s = new MemStore(seed);
  s.signed.set(1, {pubKey: ab(11), privKey: ab(12), signature: ab(13, 64)});
  for (let id = 1; id <= n; id++) {
    s.preKeys.set(id, {pubKey: ab((id % 200) + 20), privKey: ab((id % 200) + 21)});
  }
  return s;
}

// ─── fake server ──────────────────────────────────────────────────────
//
// Mirrors the P0-1 contract: it stores the row `putIdentity` uploads, hands out
// a fresh nonce per header fetch, recomputes the HMAC proof itself, and only
// releases the bundle for a token minted by a matching proof.

interface Row {
  wrappedMasterKey: string;
  salt: string;
  kdfParams: Record<string, unknown>;
  wrappedIdentityBundle: string;
  verifierKey: string;
}

function wireFakeServer(userId = 'owner-uuid-1'): {row: () => Row} {
  let row: Row | null = null;
  let nonce = 'nonce-0';
  let issued: string | null = null;

  client.putIdentity.mockImplementation(async (p: Row) => { row = {...p}; return {ok: true}; });
  client.getIdentityHeader.mockImplementation(async () => {
    if (!row) {throw new BackupError('no_backup', 'no_backup');}
    nonce = `nonce-${Math.random().toString(36).slice(2)}`;
    return {
      userId,
      verifierMissing:   false,
      verifyNonce:       nonce,
      verifyNonceTtlSec: 60,
      salt:              row.salt,
      kdfParams:         row.kdfParams,
      failedAttempts:    0,
      lockedUntil:       null,
    };
  });
  client.verify.mockImplementation(async (p: {nonce: string; proofB64: string}) => {
    // Server-side recompute — exactly what backup.service.ts does.
    const expected = await computeVerifyProof(fromB64(row!.verifierKey), userId, p.nonce);
    if (toB64(expected) !== p.proofB64) {
      throw new BackupError('unauthorized', 'wrong_password');
    }
    issued = 'verify-token-1';
    return {verifyToken: issued, verifyTokenTtlSec: 30};
  });
  client.getIdentityBundle.mockImplementation(async (token: string) => {
    if (token !== issued) {throw new BackupError('verify_required', 'verify_required');}
    return {
      wrappedMasterKey:      row!.wrappedMasterKey,
      salt:                  row!.salt,
      kdfParams:             row!.kdfParams,
      wrappedIdentityBundle: row!.wrappedIdentityBundle,
    };
  });

  return {row: () => row as Row};
}

/** Flip one bit deep inside a base64 blob (past the 12-byte GCM IV). */
function tamper(blobB64: string): string {
  const bytes = fromB64(blobB64);
  bytes[bytes.length - 1] ^= 0xff;
  return toB64(bytes);
}

const PASSWORD = 'correct horse battery staple';

beforeEach(() => {
  jest.clearAllMocks();
  lockIdentityBackup();
  client.putIdentity.mockImplementation(async () => ({ok: true}));
});
afterEach(() => { lockIdentityBackup(); });

describe('captureIdentity', () => {
  it('Round 8 — scans OPK ids PAST 200 (the old 1..200 cap silently dropped them)', async () => {
    const store = seededStore(205);
    const id = await captureIdentity(store as unknown as CryptoStore);

    expect(id.preKeys).toHaveLength(205);
    const ids = id.preKeys.map(p => p.id);
    // The exact rows the pre-Round-8 cap lost: peers that consumed one of
    // these OPKs could not be decrypted after a restore.
    expect(ids).toContain(201);
    expect(ids).toContain(205);
    expect(id.registrationId).toBe(4242);
    expect(id.identityKey.pub).toBe(b64(ab(1)));
    expect(id.identityKey.priv).toBe(b64(ab(51)));
    expect(id.signedPreKey).toEqual({
      id: 1, pub: b64(ab(11)), priv: b64(ab(12)), signature: b64(ab(13, 64)),
    });
  });

  it('stops scanning after a long contiguous gap so the cost stays bounded', async () => {
    const store = seededStore(2);
    // Far past the 200-id gap tolerance — the scan must not walk to 10 000.
    store.preKeys.set(9_000, {pubKey: ab(90), privKey: ab(91)});
    const spy = jest.spyOn(store, 'loadPreKey');

    const id = await captureIdentity(store as unknown as CryptoStore);

    expect(id.preKeys.map(p => p.id)).toEqual([1, 2]);
    expect(spy.mock.calls.length).toBeLessThan(1_000);
  });

  it('prefers enumeratePreKeys when the store exposes it (no id scan at all)', async () => {
    const store = seededStore(3) as MemStore & {
      enumeratePreKeys?: () => Promise<Array<{id: number; pub: ArrayBuffer; priv: ArrayBuffer}>>;
    };
    store.enumeratePreKeys = async () => [{id: 77, pub: ab(7), priv: ab(8)}];
    const spy = jest.spyOn(store, 'loadPreKey');

    const id = await captureIdentity(store as unknown as CryptoStore);

    expect(id.preKeys).toEqual([{id: 77, pub: b64(ab(7)), priv: b64(ab(8))}]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('skips an OPK whose PRIVATE half is missing rather than backing up half a key', async () => {
    const store = seededStore(2);
    store.preKeys.set(2, {pubKey: ab(30)} as unknown as KP);

    const id = await captureIdentity(store as unknown as CryptoStore);

    expect(id.preKeys.map(p => p.id)).toEqual([1]);
  });

  it('refuses to back up an identity with no signed pre-key / signature / private half', async () => {
    const noSpk = seededStore(1);
    noSpk.signed.clear();
    await expect(captureIdentity(noSpk as unknown as CryptoStore))
      .rejects.toThrow('signed_pre_key_missing');

    const noSig = seededStore(1);
    noSig.signed.set(1, {pubKey: ab(11), privKey: ab(12)});
    await expect(captureIdentity(noSig as unknown as CryptoStore))
      .rejects.toThrow('signed_pre_key_signature_missing');

    const noPriv = seededStore(1);
    noPriv.signed.set(1, {pubKey: ab(11), signature: ab(13, 64)} as unknown as KP);
    await expect(captureIdentity(noPriv as unknown as CryptoStore))
      .rejects.toThrow('signed_pre_key_priv_missing');
  });
});

describe('reinstallIdentity', () => {
  it('round-trips a captured identity into a fresh store byte-for-byte', async () => {
    const source = seededStore(4);
    const captured = await captureIdentity(source as unknown as CryptoStore);

    const fresh = new MemStore(99);
    await reinstallIdentity(fresh as unknown as CryptoStore, captured);

    expect(fresh.regId).toBe(4242);
    expect(b64(fresh.identity.pubKey)).toBe(captured.identityKey.pub);
    expect(b64(fresh.identity.privKey)).toBe(captured.identityKey.priv);
    expect(fresh.preKeys.size).toBe(4);
    const spk = fresh.signed.get(1)!;
    expect(b64(spk.pubKey)).toBe(captured.signedPreKey.pub);
    expect(b64(spk.signature!)).toBe(captured.signedPreKey.signature);
    // A second capture off the restored store reproduces the first exactly.
    expect(await captureIdentity(fresh as unknown as CryptoStore)).toEqual(captured);
  });

  it('M-18 — writes the signed pre-key LAST so it stays the completion sentinel', async () => {
    const captured = await captureIdentity(seededStore(3) as unknown as CryptoStore);
    const fresh = new MemStore(99);

    await reinstallIdentity(fresh as unknown as CryptoStore, captured);

    expect(fresh.calls[0]).toBe('ownIdentity');
    expect(fresh.calls[fresh.calls.length - 1]).toBe('signedPreKey:1');
  });

  it('M-18 — brackets the write in a transaction and ROLLBACKs a mid-loop throw', async () => {
    const captured = await captureIdentity(seededStore(3) as unknown as CryptoStore);
    const sql: string[] = [];
    const fresh = new MemStore(99) as MemStore & {getDb?: () => unknown};
    fresh.getDb = () => ({execute: async (s: string) => { sql.push(s); }});

    await reinstallIdentity(fresh as unknown as CryptoStore, captured);
    expect(sql).toEqual(['BEGIN', 'COMMIT']);

    // Now fail on the second OPK: no COMMIT, an explicit ROLLBACK, rethrow.
    sql.length = 0;
    const broken = new MemStore(99) as MemStore & {getDb?: () => unknown};
    broken.getDb = () => ({execute: async (s: string) => { sql.push(s); }});
    let n = 0;
    broken.storePreKey = async () => {
      n += 1;
      if (n === 2) {throw new Error('disk_full');}
    };

    await expect(reinstallIdentity(broken as unknown as CryptoStore, captured))
      .rejects.toThrow('disk_full');
    expect(sql).toEqual(['BEGIN', 'ROLLBACK']);
    // The completion sentinel was never written — the boot path still sees
    // this device as un-installed rather than half-installed.
    expect(broken.signed.size).toBe(0);
  });

  it('accepts a store that persists its own identity SYNCHRONOUSLY', async () => {
    const captured = await captureIdentity(seededStore(2) as unknown as CryptoStore);
    const fresh = new MemStore(99) as Partial<MemStore> & {
      setOwnIdentity?: (r: number, p: ArrayBuffer, k: ArrayBuffer) => void;
    };
    delete fresh.saveOwnIdentity;
    const seen: number[] = [];
    fresh.setOwnIdentity = (regId) => { seen.push(regId); };

    await reinstallIdentity(fresh as unknown as CryptoStore, captured);

    expect(seen).toEqual([4242]);
    expect((fresh as MemStore).preKeys.size).toBe(2);
  });

  it('a failing ROLLBACK never masks the error that caused it', async () => {
    const captured = await captureIdentity(seededStore(2) as unknown as CryptoStore);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const broken = new MemStore(99) as MemStore & {getDb?: () => unknown};
    broken.getDb = () => ({
      execute: async (s: string) => { if (s === 'ROLLBACK') {throw new Error('db_closed');} },
    });
    broken.storePreKey = async () => { throw new Error('disk_full'); };

    // The caller must still see the ORIGINAL cause, not the cleanup failure —
    // otherwise the boot path diagnoses the wrong problem.
    await expect(reinstallIdentity(broken as unknown as CryptoStore, captured))
      .rejects.toThrow('disk_full');
    expect(warn.mock.calls.flat().join(' ')).toContain('rollback failed');
    warn.mockRestore();
  });

  it('refuses a store that cannot persist an own identity', async () => {
    const captured = await captureIdentity(seededStore(1) as unknown as CryptoStore);
    const fresh = new MemStore(99) as Partial<MemStore>;
    delete fresh.saveOwnIdentity;

    await expect(reinstallIdentity(fresh as unknown as CryptoStore, captured))
      .rejects.toThrow('store_cannot_persist_own_identity');
  });
});

describe('setupBackup → restoreBackup round trip', () => {
  it('recovers the identity on a NEW device using only the password', async () => {
    const server = wireFakeServer('owner-uuid-1');
    const source = seededStore(6);

    const {masterKey, rawB64} = await setupBackup(
      source as unknown as CryptoStore, PASSWORD, 'owner-uuid-1',
    );
    expect(masterKey).toBeTruthy();
    // rawB64 is what the caller persists to the OS keychain so a cold start
    // can resume the mirror without re-prompting.
    expect(fromB64(rawB64)).toHaveLength(32);
    // The server only ever sees WRAPPED bytes + a one-way verifier key.
    const row = server.row();
    expect(row.wrappedIdentityBundle).not.toContain(b64(ab(51)));
    expect(row.verifierKey).not.toBe(rawB64);

    const fresh = new MemStore(99);
    const out = await restoreBackup(fresh as unknown as CryptoStore, PASSWORD);

    expect(out.identity).toEqual(await captureIdentity(source as unknown as CryptoStore));
    expect(out.rawB64).toBe(rawB64);
    expect(await captureIdentity(fresh as unknown as CryptoStore)).toEqual(out.identity);
  });

  it('a WRONG password is rejected by the server proof, before any bundle is served', async () => {
    wireFakeServer();
    await setupBackup(seededStore(2) as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');

    await expect(restoreBackup(new MemStore(99) as unknown as CryptoStore, 'not the password'))
      .rejects.toMatchObject({kind: 'unauthorized', message: 'wrong_password'});
    // P0-1: the wrapped bundle is never released on a failed proof.
    expect(client.getIdentityBundle).not.toHaveBeenCalled();
  });

  it('a tampered wrapped_master_key reports a CORRUPT BUNDLE, not "wrong password"', async () => {
    const server = wireFakeServer();
    await setupBackup(seededStore(2) as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    const row = server.row();
    row.wrappedMasterKey = tamper(row.wrappedMasterKey);

    await expect(restoreBackup(new MemStore(99) as unknown as CryptoStore, PASSWORD))
      .rejects.toMatchObject({kind: 'server', message: 'master_key_unwrap_failed'});
  });

  it('a tampered wrapped_identity_bundle surfaces as identity_unwrap_failed', async () => {
    const server = wireFakeServer();
    await setupBackup(seededStore(2) as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    const row = server.row();
    row.wrappedIdentityBundle = tamper(row.wrappedIdentityBundle);

    await expect(restoreBackup(new MemStore(99) as unknown as CryptoStore, PASSWORD))
      .rejects.toMatchObject({kind: 'server', message: 'identity_unwrap_failed'});
  });

  it('M-1 — out-of-range server KDF params are rejected BEFORE native argon2 runs', async () => {
    const server = wireFakeServer();
    await setupBackup(seededStore(1) as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    // 8 GiB: the value the module docblock names as an OOM/DoS/tamper vector.
    server.row().kdfParams = {...DEFAULT_KDF_PARAMS, memoryKib: 8 * 1024 * 1024};

    const err = await restoreBackup(new MemStore(99) as unknown as CryptoStore, PASSWORD)
      .catch((e: BackupError) => e);
    expect((err as BackupError).kind).toBe('server');
    expect((err as Error).message).toMatch(/^kdf_params_invalid:kdf_memory_out_of_range/);
    // Distinct from a wrong password — the user is told the backup is corrupt.
    expect((err as Error).message).not.toContain('wrong_password');
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('a legacy row with no verifier key fails with verifier_missing (no proof can succeed)', async () => {
    client.getIdentityHeader.mockResolvedValue({
      userId: 'u', verifierMissing: true, verifyNonce: 'n', verifyNonceTtlSec: 60,
      salt: toB64(randomBytes(16)), kdfParams: DEFAULT_KDF_PARAMS,
      failedAttempts: 0, lockedUntil: null,
    });

    await expect(restoreBackup(new MemStore(99) as unknown as CryptoStore, PASSWORD))
      .rejects.toMatchObject({kind: 'verifier_missing'});
    expect(client.verify).not.toHaveBeenCalled();
  });

  it('restores under LEGACY kdf params the server still ships with the bundle', async () => {
    const legacy: KdfParams = {
      algo: 'argon2id', memoryKib: 64 * 1024, iterations: 3,
      parallelism: 1, saltBytes: 16, derivedKeyBytes: 32,
    };
    const server = await plantBundle({password: 'legacypass', params: legacy, userId: 'owner-uuid-1'});

    const fresh = new MemStore(99);
    const out = await restoreBackup(fresh as unknown as CryptoStore, 'legacypass');

    expect(out.identity.registrationId).toBe(4242);
    expect(server.row().kdfParams).toEqual(legacy);
  });

  it('rejects an envelope whose magic/version is not ours', async () => {
    await plantBundle({password: PASSWORD, envelopePatch: {magic: 'evil-v1'}});

    await expect(restoreBackup(new MemStore(99) as unknown as CryptoStore, PASSWORD))
      .rejects.toMatchObject({kind: 'server', message: 'unknown_envelope:evil-v1'});
  });

  it('M-3 — an envelope bound to a DIFFERENT owner warns but still restores', async () => {
    // The master-key unwrap already gated access and legacy bundles carry no
    // owner field, so this is deliberately a warning, not a hard fail.
    await plantBundle({password: PASSWORD, userId: 'owner-uuid-1', envelopePatch: {owner: 'someone-else-entirely'}});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const fresh = new MemStore(99);
    await expect(restoreBackup(fresh as unknown as CryptoStore, PASSWORD)).resolves.toBeTruthy();

    expect(fresh.signed.size).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('owner mismatch');
    warn.mockRestore();
  });
});

describe('refreshIdentityBackup (F6 same-key re-upload)', () => {
  it('re-uploads the CURRENT OPKs under the PINNED wrap context, never a fresh wrap', async () => {
    const server = wireFakeServer();
    const store = seededStore(2);
    await setupBackup(store as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    const setupRow = {...server.row()};
    client.putIdentity.mockClear();

    // maybeReplenishOwnOpks adds fresh private halves after setup.
    store.preKeys.set(3, {pubKey: ab(40), privKey: ab(41)});
    await refreshIdentityBackup(store as unknown as CryptoStore);

    expect(client.putIdentity).toHaveBeenCalledTimes(1);
    const sent = client.putIdentity.mock.calls[0][0] as Row;
    // A CHANGED wrappedMasterKey would read as a key ROTATION server-side and
    // wipe every mirrored message (the F6 same-key guard).
    expect(sent.wrappedMasterKey).toBe(setupRow.wrappedMasterKey);
    expect(sent.salt).toBe(setupRow.salt);
    expect(sent.verifierKey).toBe(setupRow.verifierKey);
    expect(sent.kdfParams).toEqual(setupRow.kdfParams);
    // …but the identity blob is new, and carries the third OPK.
    expect(sent.wrappedIdentityBundle).not.toBe(setupRow.wrappedIdentityBundle);

    const fresh = new MemStore(99);
    const out = await restoreBackup(fresh as unknown as CryptoStore, PASSWORD);
    expect(out.identity.preKeys.map(p => p.id)).toEqual([1, 2, 3]);
  });

  it('after a RESTORE it reuses the server\'s existing wrappedMasterKey (no re-wrap)', async () => {
    const server = wireFakeServer();
    await setupBackup(seededStore(2) as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    const stored = server.row().wrappedMasterKey;

    const fresh = new MemStore(99);
    await restoreBackup(fresh as unknown as CryptoStore, PASSWORD);
    client.putIdentity.mockClear();

    await refreshIdentityBackup(fresh as unknown as CryptoStore);
    expect((client.putIdentity.mock.calls[0][0] as Row).wrappedMasterKey).toBe(stored);
  });

  it('is a silent no-op when the mirror is locked, or for a stale store handle', async () => {
    wireFakeServer();
    const store = seededStore(2);

    // Locked (never set up / logged out).
    await refreshIdentityBackup(store as unknown as CryptoStore);
    expect(client.putIdentity).not.toHaveBeenCalled();

    await setupBackup(store as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    client.putIdentity.mockClear();

    // A handle from a previous session must never re-upload over the live one.
    await refreshIdentityBackup(seededStore(2) as unknown as CryptoStore);
    expect(client.putIdentity).not.toHaveBeenCalled();

    // lockIdentityBackup (disposeMirror on logout) drops the live context.
    lockIdentityBackup();
    await refreshIdentityBackup(store as unknown as CryptoStore);
    expect(client.putIdentity).not.toHaveBeenCalled();
  });
});

// ─── helpers that plant a server row without going through setupBackup ──

/**
 * Build + install a server row directly, so a test can control the envelope
 * bytes (magic, owner) or the KDF profile that `setupBackup` would not produce.
 */
async function plantBundle(opts: {
  password: string;
  params?: KdfParams;
  userId?: string;
  envelopePatch?: Record<string, unknown>;
}): Promise<{row: () => Row}> {
  const userId = opts.userId ?? 'owner-uuid-1';
  const params = opts.params ?? DEFAULT_KDF_PARAMS;
  const server = wireFakeServer(userId);

  const salt = randomBytes(params.saltBytes);
  const {key: derivedKey, raw: derivedRaw} = await deriveMasterKeyAndRaw(opts.password, salt, params);
  const verifierKey = await deriveVerifierKey(derivedRaw);
  derivedRaw.fill(0);

  const {key: masterKey, raw: masterRaw} = await generateMasterKey();
  const wrappedMaster = await aesGcmEncrypt(derivedKey, masterRaw);
  masterRaw.fill(0);

  const identity = await captureIdentity(seededStore(2) as unknown as CryptoStore);
  const envelope = {v: 1, magic: 'bravo-identity-v1', identity, ...(opts.envelopePatch ?? {})};
  const wrappedIdentity = await aesGcmEncrypt(
    masterKey, new TextEncoder().encode(JSON.stringify(envelope)),
  );

  await backupClient.putIdentity({
    wrappedMasterKey:      toB64(wrappedMaster),
    salt:                  toB64(salt),
    kdfParams:             params as unknown as Record<string, unknown>,
    wrappedIdentityBundle: toB64(wrappedIdentity),
    verifierKey:           toB64(verifierKey),
  });
  return server;
}

describe('the fake server itself is faithful (guards against a vacuous suite)', () => {
  it('the proof it accepts is the one backupCrypto computes, and the wrap really is AES-GCM', async () => {
    const server = wireFakeServer('owner-uuid-1');
    await setupBackup(seededStore(1) as unknown as CryptoStore, PASSWORD, 'owner-uuid-1');
    const row = server.row();

    // Independently re-derive and unwrap — if any of the round-trip tests
    // above passed because the "encryption" was a no-op, this would too, so
    // assert the ciphertext is genuinely opaque and keyed.
    const {key: derived, raw} = await deriveMasterKeyAndRaw(
      PASSWORD, fromB64(row.salt), row.kdfParams as unknown as KdfParams,
    );
    const masterRaw = await aesGcmDecrypt(derived, fromB64(row.wrappedMasterKey));
    expect(masterRaw).toHaveLength(32);
    raw.fill(0);

    const {key: wrongDerived} = await deriveMasterKeyAndRaw(
      'wrong', fromB64(row.salt), row.kdfParams as unknown as KdfParams,
    );
    await expect(aesGcmDecrypt(wrongDerived, fromB64(row.wrappedMasterKey))).rejects.toBeTruthy();
  });
});
