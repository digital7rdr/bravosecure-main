import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';
import type {DbHandle} from '../crypto/db';

/**
 * Audit P0-I3 — "Safety numbers surfaced + TOFU flip" unit coverage
 * for the new per-peer verification state on `trusted_identities`:
 *
 *   getPeerVerification(addr)
 *   markPeerVerified(addr, hash, ts?)
 *   clearPeerVerification(addr)
 *
 * Plus the cross-cutting "saveIdentity flips key → verification auto-
 * clears" invariant that closes the audit gap.
 *
 * The stub DB models only the SQL these tests issue (the same approach
 * as identityRotationsLog.test.ts). It does NOT spin up SQLCipher —
 * that's covered by the Detox / on-device suite.
 */

interface StubDb {
  handle: DbHandle;
  identities: Map<string, {
    key:                Uint8Array;
    first_seen:         number;
    verified_at_ms:     number | null;
    verified_safety_number_sha256: string | null;
  }>;
  rotations: Array<{
    address:        string;
    old_key_sha256: string;
    new_key_sha256: string;
    observed_at_ms: number;
  }>;
}

function makeStubDb(): StubDb {
  const identities = new Map<string, {
    key:                Uint8Array;
    first_seen:         number;
    verified_at_ms:     number | null;
    verified_safety_number_sha256: string | null;
  }>();
  const rotations: StubDb['rotations'] = [];
  const handle = {
    async execute(sql: string, params: unknown[] = []): Promise<unknown> {
      const s = sql.replace(/\s+/g, ' ').trim();

      // --- trusted_identities reads
      if (s.startsWith('SELECT identity_key FROM trusted_identities')) {
        const [address] = params as [string];
        const row = identities.get(address);
        if (!row) {return {rows: []};}
        return {rows: [{identity_key: row.key}]};
      }
      if (s.startsWith('SELECT verified_at_ms, verified_safety_number_sha256 FROM trusted_identities')) {
        const [address] = params as [string];
        const row = identities.get(address);
        if (!row) {return {rows: []};}
        return {rows: [{
          verified_at_ms: row.verified_at_ms,
          verified_safety_number_sha256: row.verified_safety_number_sha256,
        }]};
      }

      // --- trusted_identities UPSERT (with verification clear-on-flip)
      if (s.startsWith('INSERT INTO trusted_identities')) {
        const [address, key, firstSeen] = params as [string, Uint8Array, number];
        const existing = identities.get(address);
        if (!existing) {
          identities.set(address, {
            key: new Uint8Array(key), first_seen: firstSeen,
            verified_at_ms: null, verified_safety_number_sha256: null,
          });
        } else {
          const sameKey = bytesEq(existing.key, key);
          identities.set(address, {
            key: new Uint8Array(key),
            first_seen: sameKey ? existing.first_seen : firstSeen,
            verified_at_ms: sameKey ? existing.verified_at_ms : null,
            verified_safety_number_sha256: sameKey
              ? existing.verified_safety_number_sha256
              : null,
          });
        }
        return {rowsAffected: 1};
      }

      // --- verification writes
      if (s.startsWith('UPDATE trusted_identities SET verified_at_ms = ?, verified_safety_number_sha256 = ?')) {
        const [vAt, hash, address] = params as [number, string, string];
        const row = identities.get(address);
        if (!row) {return {rowsAffected: 0};}
        row.verified_at_ms = vAt;
        row.verified_safety_number_sha256 = hash;
        return {rowsAffected: 1};
      }
      if (s.startsWith('UPDATE trusted_identities SET verified_at_ms = NULL')) {
        const [address] = params as [string];
        const row = identities.get(address);
        if (!row) {return {rowsAffected: 0};}
        row.verified_at_ms = null;
        row.verified_safety_number_sha256 = null;
        return {rowsAffected: 1};
      }

      // --- identity_rotations writes (kept so saveIdentity's full
      //     transaction still completes; tests don't assert on them).
      if (s.startsWith('INSERT INTO identity_rotations')) {
        const [address, oldHash, newHash, ts] = params as [string, string, string, number];
        rotations.push({address, old_key_sha256: oldHash, new_key_sha256: newHash, observed_at_ms: ts});
        return {rowsAffected: 1};
      }

      // --- BEGIN IMMEDIATE / COMMIT / ROLLBACK no-ops for the stub.
      if (/^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/i.test(s)) {return {rowsAffected: 0};}

      throw new Error('unmocked SQL: ' + s);
    },
  } as unknown as DbHandle;

  return {handle, identities, rotations};
}

function bytesEq(a: Uint8Array, b: ArrayBuffer | Uint8Array): boolean {
  const bb = b instanceof Uint8Array ? b : new Uint8Array(b);
  if (a.length !== bb.length) {return false;}
  for (let i = 0; i < a.length; i++) {if (a[i] !== bb[i]) {return false;}}
  return true;
}

function keyOf(n: number): ArrayBuffer {
  return new TextEncoder().encode('ed25519-key-' + n).buffer as ArrayBuffer;
}

// Canonical 64-char hex hash for a known-good safety-number string.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

describe('SqlCipherProtocolStore — audit P0-I3 peer verification state', () => {
  it('getPeerVerification returns null on a peer with no trust row at all', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    const v = await store.getPeerVerification('peer-a.1');
    expect(v).toBeNull();
  });

  it('getPeerVerification returns null on TOFU-trusted peer never marked verified', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    const v = await store.getPeerVerification('peer-a.1');
    expect(v).toBeNull();
  });

  it('markPeerVerified persists hash + timestamp; getPeerVerification returns them', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    const ok = await store.markPeerVerified('peer-a.1', HASH_A, 1_234_000);
    expect(ok).toBe(true);
    const v = await store.getPeerVerification('peer-a.1');
    expect(v).toEqual({verifiedAtMs: 1_234_000, safetyNumberSha256: HASH_A});
  });

  it('markPeerVerified rejects a malformed hash', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    await expect(store.markPeerVerified('peer-a.1', 'not-hex', 0))
      .rejects.toThrow(/hash must be 64-char lowercase hex/);
  });

  it('markPeerVerified returns false when there is no trust row to UPDATE', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    const ok = await store.markPeerVerified('peer-no-row.1', HASH_A, 0);
    expect(ok).toBe(false);
  });

  it('clearPeerVerification removes the hash + timestamp', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    await store.markPeerVerified('peer-a.1', HASH_A, 1_000);
    expect(await store.getPeerVerification('peer-a.1')).not.toBeNull();
    await store.clearPeerVerification('peer-a.1');
    expect(await store.getPeerVerification('peer-a.1')).toBeNull();
  });

  it('re-asserting the SAME identity key preserves the verification record', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    const key = keyOf(1);
    await store.saveIdentity('peer-a.1', key);
    await store.markPeerVerified('peer-a.1', HASH_A, 5_000);
    // Re-assert (e.g. parallel path that re-ran saveIdentity for the
    // same peer). Hand a fresh copy of the same bytes to exercise the
    // content-equality branch of the UPSERT CASE.
    const sameKeyCopy = new Uint8Array(new Uint8Array(key)).buffer;
    await store.saveIdentity('peer-a.1', sameKeyCopy);
    const v = await store.getPeerVerification('peer-a.1');
    expect(v).toEqual({verifiedAtMs: 5_000, safetyNumberSha256: HASH_A});
  });

  it('TOFU FLIP — saveIdentity with a NEW key auto-clears the verification record', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    await store.markPeerVerified('peer-a.1', HASH_A, 5_000);
    expect(await store.getPeerVerification('peer-a.1')).not.toBeNull();
    // Peer rotates: same address, different identity key.
    await store.saveIdentity('peer-a.1', keyOf(2));
    const v = await store.getPeerVerification('peer-a.1');
    expect(v).toBeNull();
  });

  it('verification record is isolated per address — clearing peer A does not touch peer B', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    await store.saveIdentity('peer-b.1', keyOf(2));
    await store.markPeerVerified('peer-a.1', HASH_A, 1_000);
    await store.markPeerVerified('peer-b.1', HASH_B, 2_000);
    await store.clearPeerVerification('peer-a.1');
    expect(await store.getPeerVerification('peer-a.1')).toBeNull();
    expect(await store.getPeerVerification('peer-b.1'))
      .toEqual({verifiedAtMs: 2_000, safetyNumberSha256: HASH_B});
  });

  it('TOFU FLIP — rotating peer A leaves peer B verification intact', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    await store.saveIdentity('peer-a.1', keyOf(1));
    await store.saveIdentity('peer-b.1', keyOf(2));
    await store.markPeerVerified('peer-a.1', HASH_A, 1_000);
    await store.markPeerVerified('peer-b.1', HASH_B, 2_000);
    // A rotates; B is untouched.
    await store.saveIdentity('peer-a.1', keyOf(10));
    expect(await store.getPeerVerification('peer-a.1')).toBeNull();
    expect(await store.getPeerVerification('peer-b.1'))
      .toEqual({verifiedAtMs: 2_000, safetyNumberSha256: HASH_B});
  });
});
