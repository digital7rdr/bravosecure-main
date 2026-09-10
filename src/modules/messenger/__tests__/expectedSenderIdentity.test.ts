/**
 * Audit P0-8 — `resolveExpectedSenderIdentity` resolves the trusted
 * identity key for an inbound envelope sender before the cert verify.
 *
 * Three branches under test:
 *   1. local trust row present → return base64 of stored key
 *   2. local missing, bundle fetch succeeds → return bundle.identityKey
 *      (authority-attested via P0-I2 inside `KeysHttpClient`)
 *   3. local missing, bundle fetch throws → return undefined so the
 *      caller falls back to a signature-only cert verify (legacy
 *      availability path)
 *
 * Stubs CryptoStore and KeysHttpClient minimally; no network, no
 * libsignal in the loop.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveExpectedSenderIdentity} from '../crypto/expectedSenderIdentity';
import {toBase64, type CryptoStore, type KeysHttpClient, type SessionAddress} from '@bravo/messenger-core';

function makeKey(seed: number): ArrayBuffer {
  const u8 = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {u8[i] = (seed + i) & 0xff;}
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

function makeStore(seedByAddr: Record<string, number>): CryptoStore {
  const map = new Map<string, ArrayBuffer>();
  for (const [addr, seed] of Object.entries(seedByAddr)) {
    map.set(addr, makeKey(seed));
  }
  return {
    async loadIdentityKey(addr: string) { return map.get(addr); },
    // Other methods are not exercised by the helper; provide no-op
    // stubs typed via `as unknown as CryptoStore` so we don't have to
    // implement the full surface.
  } as unknown as CryptoStore;
}

function makeKeysOk(identityKeyB64: string): KeysHttpClient {
  return {
    async fetchPeerBundleWithPoolSize() {
      return {
        bundle: {
          registrationId: 1,
          address: {userId: 'whatever', deviceId: 1},
          identityKey: identityKeyB64,
          signedPreKey: {keyId: 1, publicKey: 'x', signature: 'y'},
        },
        poolSize: 50,
      };
    },
  } as unknown as KeysHttpClient;
}

function makeKeysThrow(err: Error): KeysHttpClient {
  return {
    async fetchPeerBundleWithPoolSize() { throw err; },
  } as unknown as KeysHttpClient;
}

describe('audit P0-8 — resolveExpectedSenderIdentity', () => {
  const peer: SessionAddress = {userId: 'alice', deviceId: 1};
  const addrKey = 'alice.1';

  it('returns the locally-stored identity when present (fast path, no fetch)', async () => {
    const store = makeStore({[addrKey]: 7});
    const expected = toBase64(makeKey(7));
    // Use a keys client that would throw if called — proves the local
    // branch short-circuits and never touches the network.
    const keys = makeKeysThrow(new Error('should not be called'));
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBe(expected);
  });

  it('returns the authority-signed bundle identity on cold contact (local missing)', async () => {
    const store = makeStore({}); // no local row
    const bundleIdentity = toBase64(makeKey(99));
    const keys = makeKeysOk(bundleIdentity);
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBe(bundleIdentity);
  });

  it('M5: nothing re-implements the no-keys fallback around the resolver', () => {
    // Three separate `keys ? resolve(...) : loadIdentityKey(...)` copies lived
    // in productionRuntime — the WS pre-verify, the drain pre-verify, and
    // doHandleIncoming. Each was a second implementation of this resolver's own
    // first step, and each only *happened* to agree with it. `keys` is now
    // honestly optional, so any reappearance of that ternary is a regression.
    // Comments stripped first — the prose describing this rule naturally
    // contains the very ternary it forbids.
    const runtime = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    // Scoped to the fallback that RE-IMPLEMENTS step 1 (a local
    // `loadIdentityKey` lookup in the else branch). One `keys ? resolve(...) :
    // undefined` ternary legitimately remains, in the B-127 relayed-create
    // path: there, "no keys client" means "cannot verify a relayed create at
    // all", which is a different decision from "fall back to the local row",
    // and W10 depends on telling those two apart. Not duplication — left alone.
    expect(runtime).not.toMatch(/\?\s*await resolveExpectedSenderIdentity\([\s\S]{0,240}?loadIdentityKey\(/);
    expect(runtime).not.toMatch(/loadIdentityKey\([\s\S]{0,120}?\)\s*;\s*return local \? toBase64\(local\)/);
  });

  it('M5: with NO keys client, still returns the local trust row', async () => {
    // The drain path used to hand-roll this exact fallback rather than calling
    // the resolver when `keys` was absent — a second implementation of step 1.
    // Pinning both no-keys outcomes here is what let that copy be deleted.
    const store = makeStore({[addrKey]: 7});
    const got = await resolveExpectedSenderIdentity(peer, store, undefined);
    expect(got).toBe(toBase64(makeKey(7)));
  });

  it('M5: with NO keys client and no local row, returns undefined (never throws)', async () => {
    // Previously this only "worked" because a missing client threw a TypeError
    // that the fetch catch swallowed. Now it is an explicit early return, so a
    // caller cannot be surprised by an exception on the loopback/offline path.
    const store = makeStore({});
    await expect(resolveExpectedSenderIdentity(peer, store, undefined)).resolves.toBeUndefined();
  });

  it('returns undefined when local missing AND bundle fetch throws (dual failure)', async () => {
    const store = makeStore({});
    const keys = makeKeysThrow(new Error('keys-service unreachable'));
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBeUndefined();
  });

  it('returns undefined when local missing AND bundle fetch throws a KeysHttpError(495) (P0-I2 attack path)', async () => {
    // Models the case where the keys-service tried to substitute and
    // the authority signature failed: KeysHttpClient throws 495 and
    // the helper returns undefined. Caller then drops the cert
    // continuity check, but the cert SIGNATURE itself still runs in
    // verifySenderCert — so a forged cert from a substituted bundle
    // still fails at the next layer.
    const store = makeStore({});
    const httpErr = new Error('bundle_authority_sig_invalid: tampered');
    (httpErr as Error & {status?: number}).status = 495;
    const keys = makeKeysThrow(httpErr);
    const got = await resolveExpectedSenderIdentity(peer, store, keys);
    expect(got).toBeUndefined();
  });

  it('isolates resolution per address — peer-A lookup does not return peer-B key', async () => {
    const store = makeStore({
      'alice.1': 1,
      'bob.1':   2,
    });
    const keys = makeKeysThrow(new Error('should not be called'));
    const alice = await resolveExpectedSenderIdentity({userId: 'alice', deviceId: 1}, store, keys);
    const bob   = await resolveExpectedSenderIdentity({userId: 'bob',   deviceId: 1}, store, keys);
    expect(alice).toBe(toBase64(makeKey(1)));
    expect(bob).toBe(toBase64(makeKey(2)));
    expect(alice).not.toBe(bob);
  });

  it('treats different deviceIds for the same userId as distinct addresses', async () => {
    const store = makeStore({
      'alice.1': 1,
      'alice.2': 5,
    });
    const keys = makeKeysThrow(new Error('should not be called'));
    const dev1 = await resolveExpectedSenderIdentity({userId: 'alice', deviceId: 1}, store, keys);
    const dev2 = await resolveExpectedSenderIdentity({userId: 'alice', deviceId: 2}, store, keys);
    expect(dev1).toBe(toBase64(makeKey(1)));
    expect(dev2).toBe(toBase64(makeKey(5)));
    expect(dev1).not.toBe(dev2);
  });
});
