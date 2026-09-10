import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';
import type {DbHandle} from '../crypto/db';

/**
 * Minimal in-memory DbHandle stub. Models only the SQL that
 * `SqlCipherProtocolStore.saveIdentity` + `listIdentityRotations`
 * issue against the two tables we care about for the P0-S6 forensic
 * trail:
 *
 *   trusted_identities:
 *     - SELECT identity_key FROM trusted_identities WHERE address = ?
 *     - INSERT INTO trusted_identities ... ON CONFLICT(address) DO UPDATE
 *       (simplified to upsert-by-address; we don't model the
 *        first_seen CASE branch because the rotations log doesn't
 *        depend on it)
 *
 *   identity_rotations:
 *     - INSERT INTO identity_rotations (address, old_key_sha256,
 *         new_key_sha256, observed_at_ms) VALUES (?, ?, ?, ?)
 *     - SELECT old_key_sha256, new_key_sha256, observed_at_ms
 *         FROM identity_rotations WHERE address = ?
 *         ORDER BY observed_at_ms DESC LIMIT ?
 *     - SELECT COUNT(*) ... (used by tests, not by the store)
 *
 * Mirrors the pattern in seenEnvelopeStore.test.ts so we avoid
 * spinning up op-sqlite + SQLCipher inside the Node Jest project.
 */
interface RotationRow {
  id: number;
  address: string;
  old_key_sha256: string;
  new_key_sha256: string;
  observed_at_ms: number;
}

interface StubDb {
  handle: DbHandle;
  rotations: RotationRow[];
  identities: Map<string, Uint8Array>;
}

function makeStubDb(): StubDb {
  const identities = new Map<string, Uint8Array>();
  const rotations: RotationRow[] = [];
  let nextRotationId = 1;
  // Stable insertion order is enough for the ORDER BY tests because
  // every test passes monotonically-increasing observed_at_ms values
  // via Date.now stubbing.
  const handle = {
    async execute(sql: string, params: unknown[] = []): Promise<unknown> {
      const s = sql.replace(/\s+/g, ' ').trim();

      // --- trusted_identities --------------------------------------------------
      if (s.startsWith('SELECT identity_key FROM trusted_identities')) {
        const [address] = params as [string];
        const key = identities.get(address);
        if (!key) {return {rows: []};}
        return {rows: [{identity_key: key}]};
      }
      if (s.startsWith('INSERT INTO trusted_identities')) {
        const [address, key] = params as [string, Uint8Array];
        identities.set(address, new Uint8Array(key));
        return {rowsAffected: 1};
      }

      // --- identity_rotations --------------------------------------------------
      if (s.startsWith('INSERT INTO identity_rotations')) {
        const [address, oldHash, newHash, ts] = params as [string, string, string, number];
        rotations.push({
          id: nextRotationId++,
          address,
          old_key_sha256: oldHash,
          new_key_sha256: newHash,
          observed_at_ms: ts,
        });
        return {rowsAffected: 1};
      }
      if (s.startsWith('SELECT old_key_sha256, new_key_sha256, observed_at_ms FROM identity_rotations')) {
        const [address, limit] = params as [string, number];
        const matching = rotations
          .filter(r => r.address === address)
          .slice()
          .sort((a, b) => b.observed_at_ms - a.observed_at_ms)
          .slice(0, limit);
        return {
          rows: matching.map(r => ({
            old_key_sha256: r.old_key_sha256,
            new_key_sha256: r.new_key_sha256,
            observed_at_ms: r.observed_at_ms,
          })),
        };
      }

      // BEGIN/COMMIT/ROLLBACK no-ops — `saveIdentity` wraps the
      // snapshot + UPSERT + rotation-insert in a transaction (P0-S6);
      // the stub doesn't need to model isolation.
      if (/^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/i.test(s)) {return {rowsAffected: 0};}

      throw new Error('unmocked SQL: ' + s);
    },
  } as unknown as DbHandle;

  return {handle, rotations, identities};
}

function keyOf(n: number): ArrayBuffer {
  // Distinct, deterministic bytes per call — content doesn't need to
  // be valid Ed25519 because saveIdentity only hashes the buffer.
  return new TextEncoder().encode('ed25519-key-' + n).buffer as ArrayBuffer;
}

async function sha256HexLocal(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  let hex = '';
  for (const b of new Uint8Array(hash)) {hex += b.toString(16).padStart(2, '0');}
  return hex;
}

const HEX64 = /^[0-9a-f]{64}$/;

describe('SqlCipherProtocolStore — audit P0-S6 identity_rotations forensic trail', () => {
  it('first-seen saveIdentity returns false and does NOT write to identity_rotations', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);

    const changed = await store.saveIdentity('peer-a.1', keyOf(1));

    expect(changed).toBe(false);
    expect(stub.rotations.length).toBe(0);
  });

  it('re-asserting the same key returns false and does NOT write to identity_rotations', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    const key = keyOf(1);

    await store.saveIdentity('peer-a.1', key);
    // Hand a fresh copy of the same bytes so the constant-time compare
    // exercises content equality, not reference equality.
    const sameKeyCopy = new Uint8Array(new Uint8Array(key)).buffer;
    const changed = await store.saveIdentity('peer-a.1', sameKeyCopy);

    expect(changed).toBe(false);
    expect(stub.rotations.length).toBe(0);
  });

  it('flipping to a new key returns true and writes ONE row to identity_rotations with the correct address', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);

    await store.saveIdentity('peer-a.1', keyOf(1));
    const changed = await store.saveIdentity('peer-a.1', keyOf(2));

    expect(changed).toBe(true);
    expect(stub.rotations.length).toBe(1);
    expect(stub.rotations[0].address).toBe('peer-a.1');
  });

  it('recorded old_key_sha256 and new_key_sha256 are valid lowercase hex SHA-256 of the actual keys', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);

    const oldKey = keyOf(10);
    const newKey = keyOf(11);
    await store.saveIdentity('peer-a.1', oldKey);
    await store.saveIdentity('peer-a.1', newKey);

    expect(stub.rotations.length).toBe(1);
    const row = stub.rotations[0];
    expect(row.old_key_sha256).toMatch(HEX64);
    expect(row.new_key_sha256).toMatch(HEX64);
    expect(row.old_key_sha256).toBe(await sha256HexLocal(oldKey));
    expect(row.new_key_sha256).toBe(await sha256HexLocal(newKey));
  });

  it('multiple rotations on the same peer accumulate rows and listIdentityRotations returns them newest-first', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    const nowSpy = jest.spyOn(Date, 'now');

    // Each saveIdentity reads Date.now twice (snapshot + insert paths
    // would in theory, but the source only reads it once per call).
    // We advance it monotonically per rotation so observed_at ordering
    // is deterministic.
    nowSpy.mockReturnValueOnce(1_000); // first-seen — no rotation row
    await store.saveIdentity('peer-a.1', keyOf(1));
    nowSpy.mockReturnValueOnce(2_000);
    await store.saveIdentity('peer-a.1', keyOf(2));
    nowSpy.mockReturnValueOnce(3_000);
    await store.saveIdentity('peer-a.1', keyOf(3));
    nowSpy.mockReturnValueOnce(4_000);
    await store.saveIdentity('peer-a.1', keyOf(4));

    expect(stub.rotations.length).toBe(3);

    const listed = await store.listIdentityRotations('peer-a.1');
    expect(listed.length).toBe(3);
    expect(listed.map(r => r.observedAtMs)).toEqual([4_000, 3_000, 2_000]);

    nowSpy.mockRestore();
  });

  it('rotations on peer A do NOT show up under listIdentityRotations(peer-b)', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);

    await store.saveIdentity('peer-a.1', keyOf(1));
    await store.saveIdentity('peer-a.1', keyOf(2));
    await store.saveIdentity('peer-a.1', keyOf(3));
    await store.saveIdentity('peer-b.1', keyOf(10));
    await store.saveIdentity('peer-b.1', keyOf(11));

    const aRotations = await store.listIdentityRotations('peer-a.1');
    const bRotations = await store.listIdentityRotations('peer-b.1');

    expect(aRotations.length).toBe(2);
    expect(bRotations.length).toBe(1);
    // Sanity: every row returned for peer-b must have been written
    // against peer-b in the stub — guards against any address bleed.
    for (const row of bRotations) {
      const matchingStubRow = stub.rotations.find(
        r => r.observed_at_ms === row.observedAtMs &&
             r.old_key_sha256 === row.oldKeySha256 &&
             r.new_key_sha256 === row.newKeySha256,
      );
      expect(matchingStubRow?.address).toBe('peer-b.1');
    }
  });

  it('listIdentityRotations respects the limit parameter (5 rotations, limit=3 returns 3 newest)', async () => {
    const stub = makeStubDb();
    const store = new SqlCipherProtocolStore(stub.handle);
    const nowSpy = jest.spyOn(Date, 'now');

    // 6 saveIdentity calls — first-seen + 5 flips = 5 rotation rows.
    nowSpy.mockReturnValueOnce(100);
    await store.saveIdentity('peer-a.1', keyOf(0));
    for (let i = 1; i <= 5; i++) {
      nowSpy.mockReturnValueOnce(100 + i * 100); // 200, 300, 400, 500, 600
      await store.saveIdentity('peer-a.1', keyOf(i));
    }
    expect(stub.rotations.length).toBe(5);

    const listed = await store.listIdentityRotations('peer-a.1', 3);
    expect(listed.length).toBe(3);
    expect(listed.map(r => r.observedAtMs)).toEqual([600, 500, 400]);

    nowSpy.mockRestore();
  });
});
