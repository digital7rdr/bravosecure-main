/**
 * peerIdentityRefresh — covers the four outcomes:
 *
 *   1. keys-service confirms cert + local lags → refreshed (local updated)
 *   2. keys-service confirms cert + local already current → refreshed/no-op
 *   3. keys-service disagrees with cert → stale-cert (no mutation)
 *   4. keys-service throws → unavailable (no mutation, caller defers ack)
 *
 * Uses a fake KeysHttpClient + a tiny in-memory CryptoStore so the
 * suite stays at the Node-mode messenger-crypto bar.
 */

import {refreshPeerIdentityIfRotated} from '../crypto/peerIdentityRefresh';
import {toBase64} from '@bravo/messenger-core';

function idKeyB64(seed: number): string {
  const buf = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {buf[i] = (seed + i) & 0xff;}
  return toBase64(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

/**
 * Decode b64 into a FRESH ArrayBuffer (not a Buffer-pool slice).
 * Node's Buffer.from(...).buffer returns the pool's backing buffer,
 * which is much larger than the decoded bytes and has a non-zero
 * byteOffset. Round-tripping that through toBase64() yields the
 * whole pool, not the original bytes.
 */
function b64ToFreshAb(b64: string): ArrayBuffer {
  const u8 = Buffer.from(b64, 'base64');
  const ab = new ArrayBuffer(u8.byteLength);
  new Uint8Array(ab).set(u8);
  return ab;
}

interface StoredIdentity { addrKey: string; key: ArrayBuffer; }

function makeFakeStore(initial?: StoredIdentity, opts?: {removeThrows?: Error}): {
  store: Parameters<typeof refreshPeerIdentityIfRotated>[4];
  saved: StoredIdentity[];
  removed: string[];
} {
  const saved: StoredIdentity[] = [];
  const removed: string[] = [];
  const local = initial ? new Map([[initial.addrKey, initial.key]]) : new Map<string, ArrayBuffer>();
  const store = {
    async loadIdentityKey(addrKey: string) { return local.get(addrKey); },
    async saveIdentity(addrKey: string, key: ArrayBuffer) {
      local.set(addrKey, key);
      saved.push({addrKey, key});
      return true; // identity changed
    },
    // BS-IDKEY — the refresh now archives the stale session on a confirmed
    // rotation so libsignal rebuilds fresh.
    async removeSession(addrKey: string) {
      if (opts?.removeThrows) {throw opts.removeThrows;}
      removed.push(addrKey);
    },
  } as unknown as Parameters<typeof refreshPeerIdentityIfRotated>[4];
  return {store, saved, removed};
}

function makeFakeKeys(behaviour: {
  bundleIdentity?: string;
  throw?:           Error;
}): Parameters<typeof refreshPeerIdentityIfRotated>[3] {
  return {
    fetchPeerBundleWithPoolSize: async () => {
      if (behaviour.throw) {throw behaviour.throw;}
      return {
        bundle: {
          registrationId: 1,
          address: {userId: 'peer', deviceId: 1},
          identityKey: behaviour.bundleIdentity ?? idKeyB64(0),
          signedPreKey: {keyId: 0, publicKey: '', signature: ''},
        },
        poolSize: null,
      };
    },
  } as unknown as Parameters<typeof refreshPeerIdentityIfRotated>[3];
}

describe('refreshPeerIdentityIfRotated', () => {
  it('refreshed: keys-service confirms cert + local lags → store updated AND stale session archived', async () => {
    const old = idKeyB64(0);
    const fresh = idKeyB64(1);
    const {store, saved, removed} = makeFakeStore({addrKey: 'peer.1', key: b64ToFreshAb(old)});
    const keys = makeFakeKeys({bundleIdentity: fresh});
    const out = await refreshPeerIdentityIfRotated('peer', 1, fresh, keys, store);
    expect(out.result).toBe('refreshed');
    expect(saved).toHaveLength(1);
    expect(saved[0].addrKey).toBe('peer.1');
    // BS-IDKEY — the stale session MUST be archived so libsignal rebuilds
    // under the new identity; otherwise the retry decrypts against a dead
    // ratchet and the message is silently dropped (the reported bug).
    expect(removed).toEqual(['peer.1']);
    expect(out.sessionReset).toBe(true);
  });

  it('refreshed/no-op: local already current → no write, no session reset', async () => {
    const fresh = idKeyB64(1);
    const {store, saved, removed} = makeFakeStore({addrKey: 'peer.1', key: b64ToFreshAb(fresh)});
    const keys = makeFakeKeys({bundleIdentity: fresh});
    const out = await refreshPeerIdentityIfRotated('peer', 1, fresh, keys, store);
    expect(out.result).toBe('refreshed');
    expect(out.reason).toBe('already-current');
    expect(saved).toHaveLength(0); // no write needed
    // No identity change → no session to reset.
    expect(removed).toHaveLength(0);
    expect(out.sessionReset).toBeFalsy();
  });

  it('refreshed: a removeSession failure is non-fatal (identity still updated)', async () => {
    const old = idKeyB64(0);
    const fresh = idKeyB64(1);
    const {store, saved} = makeFakeStore(
      {addrKey: 'peer.1', key: b64ToFreshAb(old)},
      {removeThrows: new Error('db locked')},
    );
    const keys = makeFakeKeys({bundleIdentity: fresh});
    const out = await refreshPeerIdentityIfRotated('peer', 1, fresh, keys, store);
    // Identity update committed; result stays 'refreshed' so trust moves
    // forward. sessionReset is false so the caller does NOT ack-drop the
    // triggering envelope as "expected lost" — it falls through to the
    // ordinary soft-drop path instead.
    expect(out.result).toBe('refreshed');
    expect(saved).toHaveLength(1);
    expect(out.sessionReset).toBeFalsy();
    expect(out.reason).toContain('session-reset-failed');
  });

  it('stale-cert: keys-service disagrees with the cert claim → no mutation', async () => {
    const old = idKeyB64(0);
    const certClaim = idKeyB64(99);    // claim is something
    const bundle    = idKeyB64(5);     // keys-service says something else
    const {store, saved} = makeFakeStore({addrKey: 'peer.1', key: b64ToFreshAb(old)});
    const keys = makeFakeKeys({bundleIdentity: bundle});
    const out = await refreshPeerIdentityIfRotated('peer', 1, certClaim, keys, store);
    expect(out.result).toBe('stale-cert');
    expect(out.reason).toBe('cert-vs-bundle-mismatch');
    expect(saved).toHaveLength(0);
  });

  it('unavailable: keys-service network failure → no mutation, caller defers ack', async () => {
    const fresh = idKeyB64(1);
    const {store, saved} = makeFakeStore();
    const keys = makeFakeKeys({throw: new Error('ECONNRESET')});
    const out = await refreshPeerIdentityIfRotated('peer', 1, fresh, keys, store);
    expect(out.result).toBe('unavailable');
    expect(out.reason).toContain('ECONNRESET');
    expect(saved).toHaveLength(0);
  });

  it('unavailable: no keys client → no mutation', async () => {
    const fresh = idKeyB64(1);
    const {store, saved} = makeFakeStore();
    const out = await refreshPeerIdentityIfRotated('peer', 1, fresh, undefined, store);
    expect(out.result).toBe('unavailable');
    expect(out.reason).toBe('no-keys-client');
    expect(saved).toHaveLength(0);
  });
});
