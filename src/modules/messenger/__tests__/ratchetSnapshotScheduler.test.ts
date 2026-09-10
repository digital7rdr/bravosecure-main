/**
 * Phase-2 ratchet-snapshot CAPTURE scheduler — wires the previously
 * orphaned primitives into a real capture loop. Covers:
 *
 *   1. capture no-ops when not armed
 *   2. capture no-ops when the mirror (backup) is disabled
 *   3. capture no-ops when no master key is in the keychain
 *   4. capture no-ops when there are no sessions yet (no seq burned)
 *   5. a successful capture serializes → encrypts → uploads, and the
 *      uploaded envelope round-trips back through the snapshot decrypt
 *   6. seq is monotonic + persisted; the transport sees strictly
 *      increasing seq across captures
 *   7. the time-debounce coalesces back-to-back captures; force bypasses it
 *   8. readPersistedSnapshotSeq / persistAppliedSnapshotSeq agree with
 *      the capture-side floor (the restore rollback guard)
 *   9. disarm drops the store handle so a later capture no-ops
 */

// ── Mocks ──────────────────────────────────────────────────────────────
// jest hoists jest.mock above imports; factory refs must be `mock`-prefixed.
const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async (k: string) => mockAsyncStore.get(k) ?? null,
    setItem: async (k: string, v: string) => { mockAsyncStore.set(k, v); },
    removeItem: async (k: string) => { mockAsyncStore.delete(k); },
  },
}));

const mockMirror = {enabled: true};
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  isMirrorEnabled: () => mockMirror.enabled,
}));

const mockKeychain = {keyB64: null as string | null};
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  loadMirrorMasterKey: async (_userId: string) => mockKeychain.keyB64,
}));

import {
  armRatchetSnapshotScheduler,
  disarmRatchetSnapshotScheduler,
  requestCapture,
  readPersistedSnapshotSeq,
  persistAppliedSnapshotSeq,
} from '../backup/ratchetSnapshotScheduler';
import {
  setSnapshotTransport,
  makeInMemorySnapshotTransport,
  decryptSessionSnapshot,
  type SnapshotTransport,
  type RatchetSnapshotEnvelope,
} from '../backup/ratchetSnapshot';
import {generateMasterKey, toB64} from '../backup/backupCrypto';
import type {CryptoStore} from '@bravo/messenger-core';

// Shape-compatible with backupClient's BackupError — constructed inline
// because importing backupClient pulls expo/virtual/env into this Jest
// project's module graph (untransformed ESM) and fails the whole suite.
function staleSeqError(currentSeq: number): Error {
  return Object.assign(new Error('stale_seq'), {kind: 'stale_seq', meta: {currentSeq}});
}

const OWNER = 'owner-user-1';

function makeStore(sessions: Array<{identifier: string; record: string}> = []): CryptoStore {
  const m = new Map(sessions.map(s => [s.identifier, s.record] as const));
  return {
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
    async storeSession(id: string, record: string) { m.set(id, record); },
    async removeSession() {},
    async removeAllSessions() {},
    async listSessions() {
      return Array.from(m.entries()).map(([identifier, record]) => ({identifier, record}));
    },
  };
}

/** Spy transport that records every uploaded envelope while preserving the in-memory seq guard. */
function makeSpyTransport(): {transport: SnapshotTransport; uploads: RatchetSnapshotEnvelope[]} {
  const inner = makeInMemorySnapshotTransport();
  const uploads: RatchetSnapshotEnvelope[] = [];
  return {
    uploads,
    transport: {
      async upload(env) { uploads.push(env); return inner.upload(env); },
      async fetchLatest() { return inner.fetchLatest(); },
    },
  };
}

describe('ratchetSnapshotScheduler', () => {
  let raw: Uint8Array;

  beforeEach(async () => {
    mockAsyncStore.clear();
    mockMirror.enabled = true;
    disarmRatchetSnapshotScheduler();
    const mk = await generateMasterKey();
    raw = mk.raw;
    mockKeychain.keyB64 = toB64(raw);
    setSnapshotTransport(null);
  });

  afterEach(() => { setSnapshotTransport(null); disarmRatchetSnapshotScheduler(); });

  it('no-ops when not armed', async () => {
    setSnapshotTransport(makeInMemorySnapshotTransport());
    expect((await requestCapture()).reason).toBe('not_armed');
  });

  it('no-ops when the mirror is disabled (no active backup)', async () => {
    mockMirror.enabled = false;
    setSnapshotTransport(makeInMemorySnapshotTransport());
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));
    expect((await requestCapture()).reason).toBe('mirror_disabled');
  });

  it('no-ops when no master key is in the keychain', async () => {
    mockKeychain.keyB64 = null;
    setSnapshotTransport(makeInMemorySnapshotTransport());
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));
    expect((await requestCapture()).reason).toBe('no_master_key');
  });

  it('no-ops (no seq burned) when there are no sessions yet', async () => {
    setSnapshotTransport(makeInMemorySnapshotTransport());
    armRatchetSnapshotScheduler(OWNER, makeStore([]));
    const res = await requestCapture();
    expect(res.reason).toBe('no_sessions');
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(0);
  });

  it('captures, uploads, and the envelope round-trips back to the same sessions', async () => {
    const {transport, uploads} = makeSpyTransport();
    setSnapshotTransport(transport);
    const sessions = [
      {identifier: 'peer-a.1', record: 'ratchet-A'},
      {identifier: 'peer-b.1', record: 'ratchet-B'},
    ];
    armRatchetSnapshotScheduler(OWNER, makeStore(sessions));

    const res = await requestCapture();
    expect(res.reason).toBe('ok');
    expect(res.uploaded).toBe(2);
    expect(res.seq).toBe(1);
    expect(uploads).toHaveLength(1);

    // Decrypt the uploaded blob with the same master key → original sessions.
    const decoded = await decryptSessionSnapshot(raw, uploads[0]);
    expect(decoded.seq).toBe(1);
    expect(decoded.sessions).toEqual(expect.arrayContaining(sessions));

    // Floor persisted for the restore-side rollback guard.
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(1);
  });

  it('increments seq monotonically across forced captures', async () => {
    const {transport, uploads} = makeSpyTransport();
    setSnapshotTransport(transport);
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r1'}]));

    const r1 = await requestCapture({force: true});
    const r2 = await requestCapture({force: true});
    const r3 = await requestCapture({force: true});
    expect([r1.seq, r2.seq, r3.seq]).toEqual([1, 2, 3]);
    expect(uploads.map(u => u.seq)).toEqual([1, 2, 3]);
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(3);
  });

  it('time-debounces back-to-back captures; force bypasses the debounce', async () => {
    const {transport, uploads} = makeSpyTransport();
    setSnapshotTransport(transport);
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));

    expect((await requestCapture()).reason).toBe('ok');         // first capture lands
    expect((await requestCapture()).reason).toBe('debounced');  // within interval → skipped
    expect(uploads).toHaveLength(1);
    expect((await requestCapture({force: true})).reason).toBe('ok'); // force overrides
    expect(uploads).toHaveLength(2);
  });

  it('persistAppliedSnapshotSeq never lowers the floor', async () => {
    await persistAppliedSnapshotSeq(OWNER, 5);
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(5);
    await persistAppliedSnapshotSeq(OWNER, 3);   // older — ignored
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(5);
    await persistAppliedSnapshotSeq(OWNER, 9);   // newer — advances
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(9);
  });

  it('disarm drops the store handle so a later capture no-ops', async () => {
    setSnapshotTransport(makeInMemorySnapshotTransport());
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));
    disarmRatchetSnapshotScheduler();
    expect((await requestCapture({force: true})).reason).toBe('not_armed');
  });

  // ── B-67 — stale_seq self-heal on the UPLOAD path ────────────────────
  // The 2026-07-10 Pixel-7a log: server held seq S ≥ the local counter,
  // every 4 s heartbeat re-uploaded the same rejected seq forever, and
  // snapshots froze at S (restore-staleness risk). The B-50 adopt-and-
  // retry existed only on the merkle-commit path.

  it('stale_seq 409 → adopts server currentSeq+1, retries once, persists the adopted floor', async () => {
    const uploads: RatchetSnapshotEnvelope[] = [];
    let rejected = false;
    setSnapshotTransport({
      async upload(env) {
        uploads.push(env);
        if (!rejected) {
          rejected = true;
          throw staleSeqError(41);
        }
        return {ok: true};
      },
      async fetchLatest() { return null; },
    });
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));

    const res = await requestCapture();
    expect(res.reason).toBe('ok');
    expect(res.seq).toBe(42);
    expect(uploads.map(u => u.seq)).toEqual([1, 42]);
    expect(await readPersistedSnapshotSeq(OWNER)).toBe(42);

    // Next capture continues from the adopted floor.
    const res2 = await requestCapture({force: true});
    expect(res2.seq).toBe(43);
  });

  it('a failed capture holds the debounce (no 4 s retry hammer)', async () => {
    let attempts = 0;
    setSnapshotTransport({
      async upload() { attempts += 1; throw new Error('network down'); },
      async fetchLatest() { return null; },
    });
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));

    expect((await requestCapture()).reason).toBe('failed');
    // Heartbeat fires again 4 s later — must be debounced, not re-attempted.
    expect((await requestCapture()).reason).toBe('debounced');
    expect((await requestCapture()).reason).toBe('debounced');
    expect(attempts).toBe(1);
  });

  it('stale_seq adopt-retry that ALSO fails reports failed and holds the debounce', async () => {
    let attempts = 0;
    setSnapshotTransport({
      async upload() {
        attempts += 1;
        throw staleSeqError(7);
      },
      async fetchLatest() { return null; },
    });
    armRatchetSnapshotScheduler(OWNER, makeStore([{identifier: 'a.1', record: 'r'}]));

    expect((await requestCapture()).reason).toBe('failed');
    expect(attempts).toBe(2);   // original + single adopt-retry — never more
    expect((await requestCapture()).reason).toBe('debounced');
    expect(attempts).toBe(2);
  });
});
