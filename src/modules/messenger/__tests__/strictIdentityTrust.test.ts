/**
 * Audit P0-1 / P0-S6 — receive-path strict identity trust.
 *
 * Locks the behaviour of `SqlCipherProtocolStore.isTrustedIdentity`
 * under both flag states:
 *
 *   OFF (default) — Receiving always returns true; matches the legacy
 *     TOFU-on-receive behaviour that keeps peer-reinstall recovery
 *     unblocked. Sending still uses strict equality.
 *
 *   ON  — Receiving returns true for cold contact (no stored row) so
 *     the first message can land, but a flip against an existing row
 *     returns false and the inbound is rejected. Sending behaviour is
 *     unchanged.
 *
 * The flag is read at call time so we can flip
 * `(process.env as Record<string, string | undefined>)[FLAG_KEY]` between assertions
 * without rebuilding the store or resetting jest modules.
 */

import {SqlCipherProtocolStore} from '../crypto/sqlCipherStore';
import type {DbHandle} from '../crypto/db';

// Inline the enum values rather than importing from @bravo/messenger-core.
// The package barrel transitively pulls @react-native-async-storage/async-storage
// (via transport/client.ts) which is not in transformIgnorePatterns; resolving
// the barrel under jest blows up parsing expo/virtual/env.js. Values match
// the package's `IdentityDirection` enum at
// packages/messenger-core/src/crypto/types.ts:101-104.
const IdentityDirection = {Sending: 1 as const, Receiving: 2 as const};

// Build the env-var key at runtime so babel-preset-expo's EXPO_PUBLIC_*
// static-inline pass can't pattern-match the literal string and rewrite
// the access into `import {…} from "expo/virtual/env.js"` (which jest's
// messenger-crypto babel chain can't parse). Concatenating from
// fragments defeats the static matcher.
const FLAG_KEY = ['EXPO', 'PUBLIC', 'STRICT', 'IDENTITY', 'TRUST'].join('_');

const ORIG_FLAG = (process.env as Record<string, string | undefined>)[FLAG_KEY];

interface StubDb {
  handle:     DbHandle;
  identities: Map<string, Uint8Array>;
}

function makeStubDb(): StubDb {
  const identities = new Map<string, Uint8Array>();
  const handle = {
    async execute(sql: string, params: unknown[] = []): Promise<unknown> {
      const s = sql.replace(/\s+/g, ' ').trim();
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
      if (/^(BEGIN IMMEDIATE|COMMIT|ROLLBACK)$/i.test(s)) {return {rowsAffected: 0};}
      // saveIdentity also writes verification columns + rotation rows;
      // accept those statements as no-ops so the saveIdentity txn
      // completes for the test's purposes.
      if (s.startsWith('INSERT INTO identity_rotations')) {return {rowsAffected: 1};}
      throw new Error('unmocked SQL: ' + s);
    },
  } as unknown as DbHandle;
  return {handle, identities};
}

function makeKey(seed: number): ArrayBuffer {
  const u8 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {u8[i] = (seed + i) & 0xff;}
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function setFlag(value: string | undefined): void {
  if (value === undefined) {
    delete (process.env as Record<string, string | undefined>)[FLAG_KEY];
  } else {
    (process.env as Record<string, string | undefined>)[FLAG_KEY] = value;
  }
}

afterEach(() => { setFlag(ORIG_FLAG); });

describe('audit P0-1 / P0-S6 — isTrustedIdentity under EXPO_PUBLIC_STRICT_IDENTITY_TRUST', () => {
  describe('flag OFF (default)', () => {
    beforeEach(() => { setFlag('false'); });

    it('Receiving returns true even when the stored key differs (legacy TOFU)', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving);
      expect(ok).toBe(true);
    });

    it('Receiving returns true on cold contact (no stored row)', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      const ok = await store.isTrustedIdentity('cold-peer.1', makeKey(1), IdentityDirection.Receiving);
      expect(ok).toBe(true);
    });

    it('Sending returns true when the incoming key matches the stored one', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(1), IdentityDirection.Sending);
      expect(ok).toBe(true);
    });

    it('Sending returns false when the incoming key differs from the stored one', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(2), IdentityDirection.Sending);
      expect(ok).toBe(false);
    });
  });

  describe('flag ON', () => {
    beforeEach(() => { setFlag('true'); });

    it('Receiving returns FALSE when the stored key differs (hard gate enforced)', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving);
      expect(ok).toBe(false);
    });

    it('Receiving returns TRUE on cold contact (no stored row — first-message can still land)', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      const ok = await store.isTrustedIdentity('cold-peer.1', makeKey(1), IdentityDirection.Receiving);
      expect(ok).toBe(true);
    });

    it('Receiving returns TRUE when the incoming key matches the stored one', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(1), IdentityDirection.Receiving);
      expect(ok).toBe(true);
    });

    it('Sending behaviour is unchanged by the flag (strict equality)', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      expect(await store.isTrustedIdentity('peer-a.1', makeKey(1), IdentityDirection.Sending)).toBe(true);
      expect(await store.isTrustedIdentity('peer-a.1', makeKey(2), IdentityDirection.Sending)).toBe(false);
    });
  });

  describe('flag value parsing', () => {
    it('treats unset env var as OFF', async () => {
      setFlag(undefined);
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving);
      expect(ok).toBe(true);
    });

    it('only the literal string "true" enables the flag (defends against "1" / "yes" / "TRUE")', async () => {
      setFlag('1');
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      const ok = await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving);
      expect(ok).toBe(true);
    });

    it('flag flips take effect on the NEXT call without rebuilding the store', async () => {
      const stub = makeStubDb();
      const store = new SqlCipherProtocolStore(stub.handle);
      await store.saveIdentity('peer-a.1', makeKey(1));
      // Start OFF — TOFU true.
      setFlag('false');
      expect(await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving)).toBe(true);
      // Flip ON — same store, same row, now false.
      setFlag('true');
      expect(await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving)).toBe(false);
      // Flip OFF again — back to TOFU.
      setFlag('false');
      expect(await store.isTrustedIdentity('peer-a.1', makeKey(99), IdentityDirection.Receiving)).toBe(true);
    });
  });
});
