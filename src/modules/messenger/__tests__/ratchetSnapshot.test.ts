/**
 * Encrypted ratchet-state snapshot — covers the full round-trip.
 *
 * Validates:
 *   1. serializeSessionSnapshot enumerates every session from listSessions
 *   2. encrypt + decrypt round-trips byte-for-byte
 *   3. wrong master key fails closed (no plaintext leak)
 *   4. tampered ciphertext fails closed
 *   5. version/magic mismatch is rejected (cross-feature substitution defence)
 *   6. applySessionSnapshotToStore replays every entry via storeSession
 *   7. in-memory transport refuses to roll back seq
 *   8. store without listSessions returns null (caller falls back cleanly)
 */

import {
  serializeSessionSnapshot,
  encryptSessionSnapshot,
  decryptSessionSnapshot,
  applySessionSnapshotToStore,
  makeInMemorySnapshotTransport,
  SNAPSHOT_WIRE_VERSION,
} from '../backup/ratchetSnapshot';
import {generateMasterKey} from '../backup/backupCrypto';
import type {CryptoStore} from '@bravo/messenger-core';

function makeStubStore(sessions: Array<{identifier: string; record: string}> = []): {
  store: CryptoStore;
  storeSessionCalls: Array<{identifier: string; record: string}>;
} {
  const m = new Map(sessions.map(s => [s.identifier, s.record] as const));
  const storeSessionCalls: Array<{identifier: string; record: string}> = [];
  const store: CryptoStore = {
    async getIdentityKeyPair() { throw new Error('not-used'); },
    async getLocalRegistrationId() { return 1; },
    async isTrustedIdentity() { return true; },
    async saveIdentity() { return false; },
    async loadIdentityKey() { return undefined; },
    async loadPreKey() { return undefined; },
    async storePreKey() {},
    async removePreKey() {},
    async loadSignedPreKey() { return undefined; },
    async storeSignedPreKey() {},
    async removeSignedPreKey() {},
    async loadSession(id: string) { return m.get(id); },
    async storeSession(id: string, record: string) {
      m.set(id, record);
      storeSessionCalls.push({identifier: id, record});
    },
    async removeSession() {},
    async removeAllSessions() {},
    async listSessions() {
      return Array.from(m.entries()).map(([identifier, record]) => ({identifier, record}));
    },
  };
  return {store, storeSessionCalls};
}

describe('serializeSessionSnapshot', () => {
  it('returns null when the store lacks listSessions', async () => {
    const {store} = makeStubStore();
    // Remove listSessions to simulate a future / restricted store.
    delete (store as {listSessions?: unknown}).listSessions;
    const snap = await serializeSessionSnapshot(store, 1);
    expect(snap).toBeNull();
  });

  it('flattens every session into the snapshot', async () => {
    const {store} = makeStubStore([
      {identifier: 'alice.1', record: 'recA'},
      {identifier: 'bob.1',   record: 'recB'},
    ]);
    const snap = await serializeSessionSnapshot(store, 7);
    expect(snap).not.toBeNull();
    expect(snap!.v).toBe(SNAPSHOT_WIRE_VERSION);
    expect(snap!.seq).toBe(7);
    expect(snap!.sessions).toHaveLength(2);
    expect(snap!.sessions).toEqual(expect.arrayContaining([
      {identifier: 'alice.1', record: 'recA'},
      {identifier: 'bob.1',   record: 'recB'},
    ]));
  });
});

describe('encrypt + decrypt round trip', () => {
  it('round-trips a snapshot byte-for-byte', async () => {
    const {raw} = await generateMasterKey();
    const {store} = makeStubStore([
      {identifier: 'peer.1', record: 'r1'},
      {identifier: 'peer.2', record: 'r2'},
    ]);
    const snap = await serializeSessionSnapshot(store, 1);
    const env  = await encryptSessionSnapshot(raw, snap!);
    const out  = await decryptSessionSnapshot(raw, env);
    expect(out.sessions).toEqual(snap!.sessions);
    expect(out.seq).toBe(snap!.seq);
    expect(env.seq).toBe(snap!.seq); // server-visible seq header matches
  });

  it('rejects a snapshot under the wrong master key', async () => {
    const {raw: rawA} = await generateMasterKey();
    const {raw: rawB} = await generateMasterKey();
    const {store} = makeStubStore([{identifier: 'a.1', record: 'r'}]);
    const snap = await serializeSessionSnapshot(store, 1);
    const env  = await encryptSessionSnapshot(rawA, snap!);
    await expect(decryptSessionSnapshot(rawB, env)).rejects.toThrow(/decrypt failed/);
  });

  it('rejects ciphertext mutated by one byte', async () => {
    const {raw} = await generateMasterKey();
    const {store} = makeStubStore([{identifier: 'a.1', record: 'r'}]);
    const snap = await serializeSessionSnapshot(store, 1);
    const env  = await encryptSessionSnapshot(raw, snap!);
    // Flip one byte in the MIDDLE of the decoded ciphertext so the GCM
    // tag fails to verify. Mutating the last base64 char (the previous
    // approach) only toggled padding bits a random ~1-in-2 of the time —
    // when the flip decoded to identical bytes the tag stayed valid and
    // the assertion flaked. Decode → XOR a guaranteed data byte → encode
    // makes the corruption deterministic regardless of the random key.
    const bytes = Buffer.from(env.blob, 'base64');
    const mid = Math.floor(bytes.length / 2);
    bytes[mid] = bytes[mid] ^ 0xff;
    const flipped = bytes.toString('base64');
    await expect(decryptSessionSnapshot(raw, {...env, blob: flipped}))
      .rejects.toThrow(/decrypt failed/);
  });

  it('rejects a substituted envelope with wrong magic/version', async () => {
    // Hand-craft a valid-AES-GCM ciphertext under our key but with
    // wrong JSON shape inside — decrypt succeeds, JSON parses, magic
    // check trips.
    const {raw, key} = await generateMasterKey();
    const fakePayload = new TextEncoder().encode(JSON.stringify({v: 1, magic: 'something-else', sessions: []}));
    const {aesGcmEncrypt, toB64} = require('../backup/backupCrypto');
    const blob = await aesGcmEncrypt(key, fakePayload);
    await expect(decryptSessionSnapshot(raw, {blob: toB64(blob), seq: 0}))
      .rejects.toThrow(/magic.*mismatch/);
  });
});

describe('applySessionSnapshotToStore', () => {
  it('replays every entry via storeSession and returns the count + seq', async () => {
    const {store, storeSessionCalls} = makeStubStore();
    const snap = {
      v:            1 as const,
      magic:        'bravo-ratchet-snapshot-v1' as const,
      seq:          42,
      capturedAtMs: 0,
      sessions: [
        {identifier: 'x.1', record: 'rx'},
        {identifier: 'y.1', record: 'ry'},
        {identifier: 'z.1', record: 'rz'},
      ],
    };
    const result = await applySessionSnapshotToStore(store, snap);
    expect(result).toEqual({applied: 3, seq: 42});
    expect(storeSessionCalls).toHaveLength(3);
    expect(storeSessionCalls.map(c => c.identifier).sort()).toEqual(['x.1', 'y.1', 'z.1']);
  });

  it('skips entries with malformed identifier/record', async () => {
    const {store, storeSessionCalls} = makeStubStore();
    const snap = {
      v:            1 as const,
      magic:        'bravo-ratchet-snapshot-v1' as const,
      seq:          0,
      capturedAtMs: 0,
      sessions: [
        {identifier: 'good.1', record: 'r'},
        {identifier: 0 as unknown as string, record: 'r'},   // bad
        {identifier: 'also-good.1', record: null as unknown as string}, // bad
      ],
    };
    const result = await applySessionSnapshotToStore(store, snap);
    expect(result.applied).toBe(1);
    expect(storeSessionCalls).toHaveLength(1);
    expect(storeSessionCalls[0].identifier).toBe('good.1');
  });

  // L21 snapshot-apply-clobbers-fresh-session-on-restore
  it('never overwrites a session that already exists (newer than the stale snapshot)', async () => {
    // A peer established a FRESH session during the restore window — the store
    // already holds 'live-peer.1'. The snapshot (captured pre-reinstall) also
    // carries an OLD record for that peer plus a brand-new peer.
    const {store, storeSessionCalls} = makeStubStore([
      {identifier: 'live-peer.1', record: 'FRESH-ratchet'},
    ]);
    const snap = {
      v:            1 as const,
      magic:        'bravo-ratchet-snapshot-v1' as const,
      seq:          7,
      capturedAtMs: 0,
      sessions: [
        {identifier: 'live-peer.1', record: 'STALE-ratchet'}, // must NOT clobber the fresh one
        {identifier: 'cold-peer.1', record: 'restored-ratchet'},
      ],
    };
    const result = await applySessionSnapshotToStore(store, snap);
    // Only the cold peer (no existing session) is applied.
    expect(result.applied).toBe(1);
    expect(storeSessionCalls.map(c => c.identifier)).toEqual(['cold-peer.1']);
    // The live session survives untouched; the cold one is restored.
    expect(await store.loadSession('live-peer.1')).toBe('FRESH-ratchet');
    expect(await store.loadSession('cold-peer.1')).toBe('restored-ratchet');
  });
});

describe('in-memory snapshot transport', () => {
  it('returns null before first upload', async () => {
    const t = makeInMemorySnapshotTransport();
    expect(await t.fetchLatest()).toBeNull();
  });

  it('round-trips an upload + fetch', async () => {
    const t = makeInMemorySnapshotTransport();
    await t.upload({blob: 'AA==', seq: 1});
    expect(await t.fetchLatest()).toEqual({blob: 'AA==', seq: 1});
  });

  it('refuses to roll back to an older seq', async () => {
    const t = makeInMemorySnapshotTransport();
    await t.upload({blob: 'NEW',  seq: 5});
    await t.upload({blob: 'OLD',  seq: 3});
    expect((await t.fetchLatest())!.seq).toBe(5);
    expect((await t.fetchLatest())!.blob).toBe('NEW');
  });

  it('accepts a strictly-increasing seq', async () => {
    const t = makeInMemorySnapshotTransport();
    await t.upload({blob: 'V1', seq: 1});
    await t.upload({blob: 'V2', seq: 2});
    expect((await t.fetchLatest())!.seq).toBe(2);
    expect((await t.fetchLatest())!.blob).toBe('V2');
  });
});

describe('end-to-end: serialize → encrypt → upload → fetch → decrypt → apply', () => {
  it('a fresh client recovers ratchet state from a peer\'s snapshot', async () => {
    // Sender: capture + upload
    const {raw} = await generateMasterKey();
    const {store: senderStore} = makeStubStore([
      {identifier: 'peer-a.1', record: 'ratchet-A'},
      {identifier: 'peer-b.1', record: 'ratchet-B'},
    ]);
    const snap = await serializeSessionSnapshot(senderStore, 1);
    const env  = await encryptSessionSnapshot(raw, snap!);
    const transport = makeInMemorySnapshotTransport();
    await transport.upload(env);

    // Receiver (post-reinstall): fetch + decrypt + apply
    const fetched = await transport.fetchLatest();
    expect(fetched).not.toBeNull();
    const decoded = await decryptSessionSnapshot(raw, fetched!);
    const {store: recvStore} = makeStubStore();
    const result = await applySessionSnapshotToStore(recvStore, decoded);

    expect(result.applied).toBe(2);
    expect(await recvStore.loadSession('peer-a.1')).toBe('ratchet-A');
    expect(await recvStore.loadSession('peer-b.1')).toBe('ratchet-B');
  });
});
