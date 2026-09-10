/**
 * sqa.md bug register — this suite pins: B-168, B-169, B-171.
 *
 * BUG-2a/2b flush owner gate + no requeue-after-dispose = B-168 · BUG-3 no tombstone fabrication = B-169 · BUG-5 tombstone dedup = B-171.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * Audit 2026-07-23 — messageMirror session hygiene + tombstone honesty.
 *
 *   • BUG-2 — cross-user contamination: the flush enforces the owner
 *     gate at FLUSH time, and an in-flight flush that fails AFTER a
 *     dispose (signOut) may not requeue the previous user's rows into
 *     the cleared queue. Previously user A's plaintext could be wrapped
 *     under user B's master key and POSTed into B's server mirror.
 *   • BUG-3 — markDirty for a row missing from the in-memory store is
 *     NOT a removal (the store caps at ~200 rows/convo; SQL-sourced
 *     status flips routinely nudge evicted-but-live rows). The old
 *     fallback shipped a real `__deleted__` tombstone, and any restore
 *     in the window dropped the live message.
 *   • BUG-5 — mirrorRemoval's dedup: the live-version strip used to
 *     delete the tombstone key it then checked, so repeated removals
 *     flooded the queue with duplicate tombstones.
 *   • BUG-6 — key rotation mid-flight: a flush that lands after
 *     setMirrorKey changed the key must not record its rows into the
 *     (just-purged) ledger — those bytes are undecryptable under the
 *     new key and the ledger entry would pin them out of every sweep.
 *   • BUG-7 (I2) — the pending-commit flag is raised BEFORE the upload,
 *     closing the kill window where server bytes changed, the ledger
 *     suppressed re-upload, and no flag survived to fire the boot heal.
 */

jest.mock('react-native', () => {
  const listeners: Array<(s: string) => void> = [];
  return {
    __esModule: true,
    AppState: {
      addEventListener: jest.fn((_evt: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return {remove: () => { const i = listeners.indexOf(cb); if (i >= 0) {listeners.splice(i, 1);} }};
      }),
      __emit: (s: string) => { for (const cb of [...listeners]) {cb(s);} },
    },
  };
});

const mockPutMessages = jest.fn(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, message: string) { super(message); this.name = 'BackupError'; this.kind = kind; }
  }
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      putMessages: (rows: unknown[]) => mockPutMessages(rows),
      putConversations: jest.fn(async () => ({written: 0})),
    },
  };
});
jest.mock('../backup/mirrorLedger', () => ({
  __esModule: true,
  bumpFlushEpoch: jest.fn(),
  recordFlushedVersions: jest.fn(async () => undefined),
  setMerkleCommitPending: jest.fn(async () => undefined),
}));

import {
  setMirrorKey, setMirrorOwner, mirrorMessage, mirrorRemoval, markDirty,
  disposeMirror, resetMirrorForWipe, drainMirrorOutbox, mirrorOutboxSize,
} from '../backup/messageMirror';
import {recordFlushedVersions, setMerkleCommitPending} from '../backup/mirrorLedger';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const OWNER = 'owner-A';

function msg(id: string): LocalMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: OWNER,
    content: `hello ${id}`,
    type: 'text',
    status: 'sent',
    created_at: new Date(1_700_000_000_000).toISOString(),
  } as unknown as LocalMessage;
}

async function makeKey(fill = 1): Promise<CryptoKey> {
  return (globalThis.crypto as Crypto).subtle.importKey(
    'raw', new Uint8Array(32).fill(fill), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
}

describe('messageMirror — session hygiene (audit 2026-07-23)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    disposeMirror();
    mockPutMessages.mockImplementation(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
    useMessengerStore.setState({conversations: {}, conversationOrder: [], groups: {}, messages: {}});
  });
  afterEach(() => { disposeMirror(); });

  it('BUG-2a — the flush drops rows whose owner no longer matches the gate', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    mirrorMessage(OWNER, msg('m1'));
    // Account switch while the row still sits in the debounced queue.
    setMirrorOwner('owner-B');
    await drainMirrorOutbox();
    expect(mockPutMessages).not.toHaveBeenCalled();
  });

  it('BUG-2b — an in-flight flush failing after dispose does NOT requeue into the cleared queue', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    // Deterministic in-flight control: `started` resolves the moment the
    // upload is entered (no timing guess), `rejectUpload` fails it later.
    let rejectUpload!: (e: Error) => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>(r => { uploadStarted = r; });
    const {BackupError} = require('../backup/backupClient') as {BackupError: new (k: string, m: string) => Error};
    mockPutMessages.mockImplementationOnce(() => {
      uploadStarted();
      return new Promise((_res, rej) => { rejectUpload = rej; });
    });

    mirrorMessage(OWNER, msg('m2'));
    const drain = drainMirrorOutbox();   // enters flush; upload hangs
    await started;
    disposeMirror();                     // signOut while in flight
    rejectUpload(new BackupError('unauthorized', 'token revoked'));
    await drain;
    // Old behaviour: the catch requeued A's row → outbox size 1 → user B's
    // later unlock shipped it under B's key. Must stay empty.
    expect(mirrorOutboxSize()).toBe(0);
  });

  it('BUG-3 — markDirty for a store-missing id never manufactures a tombstone', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    // The store has NO such message (SQL-evicted row taking a status flip).
    markDirty(OWNER, 'evicted-but-live-id');
    expect(mirrorOutboxSize()).toBe(0);
    await drainMirrorOutbox();
    expect(mockPutMessages).not.toHaveBeenCalled();
  });

  it('BUG-5 — repeated mirrorRemoval for the same id enqueues exactly one tombstone', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    const dead = {id: 'gone-1', conversation_id: 'conv-1', created_at: new Date().toISOString()};
    mirrorRemoval(OWNER, dead);
    mirrorRemoval(OWNER, dead);
    mirrorRemoval(OWNER, dead);
    expect(mirrorOutboxSize()).toBe(1);
  });

  it('BUG-6 — a flush landing after a key rotation records NOTHING into the fresh ledger', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey(1));
    let resolveUpload!: () => void;
    let uploadStarted!: () => void;
    const started = new Promise<void>(r => { uploadStarted = r; });
    mockPutMessages.mockImplementationOnce(() => {
      uploadStarted();
      return new Promise(res => { resolveUpload = () => res({written: 1}); });
    });

    mirrorMessage(OWNER, msg('m3'));
    const drain = drainMirrorOutbox();   // upload hangs mid-flight
    await started;
    setMirrorKey(await makeKey(2));      // rotation (fresh setup) — ledger was purged
    resolveUpload();
    await drain;
    expect(recordFlushedVersions).not.toHaveBeenCalled();
  });

  it('BUG-6b — resetMirrorForWipe drops queues + key but keeps the mirror wirable', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    mirrorMessage(OWNER, msg('m4'));
    expect(mirrorOutboxSize()).toBe(1);
    resetMirrorForWipe();
    expect(mirrorOutboxSize()).toBe(0);
    await drainMirrorOutbox();
    expect(mockPutMessages).not.toHaveBeenCalled();
    // Re-setup path: a new key resumes mirroring without a reboot.
    setMirrorKey(await makeKey(3));
    mirrorMessage(OWNER, msg('m5'));
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
  });

  it('BUG-7 — the pending-commit flag is raised BEFORE the upload (kill-safe order)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    mirrorMessage(OWNER, msg('m6'));
    await drainMirrorOutbox();
    expect(setMerkleCommitPending).toHaveBeenCalledTimes(1);
    expect(mockPutMessages).toHaveBeenCalledTimes(1);
    expect((setMerkleCommitPending as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan(mockPutMessages.mock.invocationCallOrder[0]);
  });

  it('BUG-7b — a FAILED upload still leaves the pending flag raised (boot heal fires)', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    const {BackupError} = require('../backup/backupClient') as {BackupError: new (k: string, m: string) => Error};
    mockPutMessages.mockImplementationOnce(async () => { throw new BackupError('server', 'http_500'); });
    mirrorMessage(OWNER, msg('m7'));
    await drainMirrorOutbox();
    expect(setMerkleCommitPending).toHaveBeenCalled();
  });

  it('BUG-L — quota_exceeded is terminal: batch dropped with dedup cleared, no retry spin', async () => {
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
    const {BackupError} = require('../backup/backupClient') as {BackupError: new (k: string, m: string) => Error};
    mockPutMessages.mockImplementationOnce(async () => { throw new BackupError('quota_exceeded', 'backup_quota_exceeded'); });
    mirrorMessage(OWNER, msg('m8'));
    await drainMirrorOutbox();
    // Not requeued (no infinite 5-8s re-encrypt/re-POST loop)…
    expect(mirrorOutboxSize()).toBe(0);
    // …and the dedup was cleared, so a later sweep can re-attempt the row.
    mirrorMessage(OWNER, msg('m8'));
    expect(mirrorOutboxSize()).toBe(1);
  });
});
