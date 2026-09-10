/**
 * messageMirror — queue backpressure, dedup lifecycle, and the enable flip.
 *
 * These are the paths that decide whether a message ever reaches the server at
 * all, and every one of them had a documented data-loss bug behind it:
 *
 *   • MAX_BATCH — one POST per 50 rows, looped by `drainMirrorOutbox`.
 *   • H-7 — on queue overflow the dropped entries' DEDUP KEYS must be cleared.
 *     They were added at enqueue time; leaving them made the overflow-triggered
 *     catch-up sweep (which re-enqueues via `mirrorMessage`) a NO-OP, so the
 *     dropped rows were lost for the rest of the session.
 *   • Audit fix #29 — the queue overflow surfaces a user-visible "backup
 *     behind" banner, and a clean drain clears it again.
 *   • BUG-8 — the overflow catch-up sweep is deferred and null-checked at fire
 *     time (a dispose inside the 1s window used to throw an uncatchable
 *     TypeError inside the timer).
 *   • Round 8 — `markDirty` RE-ENQUEUES the live store row. Before that it only
 *     invalidated the dedup, so status flips, reactions, and retract tokens
 *     never reached the server and restored chats showed every outbound
 *     message stuck at 'sending'.
 *   • B-81 / I4 — `clearMirrorDedupForOwner` drops one owner's keys so a repair
 *     walk re-uploads that owner's full history, and NOT another account's.
 *   • B-81 / I2 — `fireMerkleHookNowIfPending` commits only when a flush
 *     actually scheduled one: an idle boot must not mint a fresh commit.
 */

jest.mock('react-native', () => ({
  __esModule: true,
  AppState: {addEventListener: jest.fn(() => ({remove: () => undefined}))},
}));

// The store's persist middleware fires a debounced AsyncStorage write ~500ms
// after any setState; the real native module rejects under node and the warn
// lands after teardown (the moving-flake class jest.setup.messenger-crypto
// documents). An in-memory map keeps the orphan harmless.
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
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
      putMessages:      (rows: unknown[]) => mockPutMessages(rows),
      putConversations: jest.fn(async () => ({written: 0})),
    },
  };
});
jest.mock('../backup/mirrorLedger', () => ({
  __esModule: true,
  bumpFlushEpoch:         jest.fn(),
  recordFlushedVersions:  jest.fn(async () => undefined),
  setMerkleCommitPending: jest.fn(async () => undefined),
}));

import {
  setMirrorKey, setMirrorOwner, mirrorMessage, markDirty, disposeMirror,
  drainMirrorOutbox, mirrorOutboxSize, isMirrorEnabled, setCatchUpSweep,
  clearMirrorDedupForOwner, setMerkleAfterFlushHook, fireMerkleHookNowIfPending,
} from '../backup/messageMirror';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const {BackupError} = require('../backup/backupClient') as {
  BackupError: new (kind: string, message: string) => Error;
};

const OWNER = 'owner-A';

function msg(id: string, over: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: OWNER,
    content: `hello ${id}`,
    type: 'text',
    status: 'sending',
    created_at: new Date(1_700_000_000_000).toISOString(),
    ...over,
  } as unknown as LocalMessage;
}

async function makeKey(fill = 1): Promise<CryptoKey> {
  return (globalThis.crypto as Crypto).subtle.importKey(
    'raw', new Uint8Array(32).fill(fill), {name: 'AES-GCM'}, false, ['encrypt', 'decrypt'],
  );
}

const tick = (ms = 20): Promise<void> => new Promise(r => setTimeout(r, ms));
async function waitFor(cond: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) {await tick(25);}
}

describe('messageMirror — batching and overflow backpressure', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    disposeMirror();
    mockPutMessages.mockImplementation(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
    useMessengerStore.setState({messages: {}, conversations: {}, conversationOrder: [], error: null} as never);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
  });
  afterEach(() => { disposeMirror(); setMerkleAfterFlushHook(null); });

  it('ships in batches of at most 50 rows, looping until the outbox is empty', async () => {
    for (let i = 0; i < 120; i++) {mirrorMessage(OWNER, msg(`m${i}`));}
    expect(mirrorOutboxSize()).toBe(120);

    await drainMirrorOutbox();

    expect(mockPutMessages).toHaveBeenCalledTimes(3);
    expect(mockPutMessages.mock.calls.map(c => (c[0] as unknown[]).length)).toEqual([50, 50, 20]);
    expect(mirrorOutboxSize()).toBe(0);
    // 120 distinct message ids reached the server exactly once each.
    const shipped = mockPutMessages.mock.calls
      .flatMap(c => (c[0] as Array<{message_id: string}>).map(r => r.message_id));
    expect(new Set(shipped).size).toBe(120);
  });

  it('H-7 — an overflow caps the queue, raises the banner, and CLEARS the dropped dedup keys', async () => {
    const sweep = jest.fn(async () => undefined);
    setCatchUpSweep(sweep);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockPutMessages.mockImplementation(async () => { throw new BackupError('network', 'offline'); });

    const all = Array.from({length: 551}, (_, i) => msg(`m${i}`));
    for (const m of all) {mirrorMessage(OWNER, m);}
    await drainMirrorOutbox();

    // Bounded memory: never more than MAX_QUEUE_SIZE rows held.
    expect(mirrorOutboxSize()).toBe(500);
    expect(useMessengerStore.getState().error).toMatch(/^Backup is behind/);

    // H-7: every dropped entry can be re-enqueued. Pre-fix its dedup key
    // survived the drop, so the sweep below re-mirrored NOTHING and the rows
    // were lost for the rest of the session.
    for (const m of all) {mirrorMessage(OWNER, m);}
    expect(mirrorOutboxSize()).toBe(551);

    // BUG-8 — the sweep is deferred ~1s and null-checked at fire time.
    await waitFor(() => sweep.mock.calls.length > 0);
    expect(sweep).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clears the "backup behind" banner once the outbox drains clean', async () => {
    useMessengerStore.getState().setError('Backup is behind — some messages may be missing on restore');
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();

    expect(mirrorOutboxSize()).toBe(0);
    expect(useMessengerStore.getState().error).toBeNull();
  });

  it('leaves an UNRELATED error banner alone when the outbox drains', async () => {
    useMessengerStore.getState().setError('Network unavailable');
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();

    expect(useMessengerStore.getState().error).toBe('Network unavailable');
  });
});

describe('messageMirror — dedup lifecycle', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    disposeMirror();
    mockPutMessages.mockImplementation(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
    useMessengerStore.setState({messages: {}, conversations: {}, conversationOrder: [], error: null} as never);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
  });
  afterEach(() => { disposeMirror(); });

  it('Round 8 — markDirty re-enqueues the LIVE store row so a status flip reaches the server', async () => {
    const sent = msg('m1', {status: 'sending'});
    mirrorMessage(OWNER, sent);
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(1);

    // The receipt lands: the store now holds the same id at status 'delivered'.
    useMessengerStore.setState({
      messages: {'conv-1': [{...sent, status: 'delivered'}]},
    } as never);
    markDirty(OWNER, 'm1');

    // Pre-Round-8 this only invalidated the dedup and nothing re-enqueued, so
    // every restored outbound message was stuck at 'sending' forever.
    expect(mirrorOutboxSize()).toBe(1);
    await drainMirrorOutbox();
    expect(mockPutMessages).toHaveBeenCalledTimes(2);
  });

  it('markDirty INVALIDATES the cached version, so the same bytes can ship again', async () => {
    const m = msg('m1');
    mirrorMessage(OWNER, m);
    await drainMirrorOutbox();

    // The version-hash gate suppresses an unchanged re-mirror…
    mirrorMessage(OWNER, m);
    expect(mirrorOutboxSize()).toBe(0);

    // …and markDirty is the only thing that lifts it. The row is absent from
    // the in-memory store here (an SQL-evicted row taking a status flip), so
    // markDirty itself enqueues nothing — BUG-3, it must never fabricate a
    // tombstone — but the dedup key is gone, so the next real mirror ships.
    useMessengerStore.setState({messages: {}} as never);
    markDirty(OWNER, 'm1');
    expect(mirrorOutboxSize()).toBe(0);

    mirrorMessage(OWNER, m);
    expect(mirrorOutboxSize()).toBe(1);
  });

  it('markDirty is inert for a locked mirror or a mismatched owner', async () => {
    useMessengerStore.setState({messages: {'conv-1': [msg('m1')]}} as never);

    markDirty('owner-B', 'm1');
    expect(mirrorOutboxSize()).toBe(0);

    setMirrorKey(null);
    markDirty(OWNER, 'm1');
    expect(mirrorOutboxSize()).toBe(0);
  });

  it('B-81 — clearMirrorDedupForOwner re-arms ONE owner\'s history, not another account\'s', async () => {
    setMirrorOwner(null);
    const mine = msg('m1');
    const theirs = msg('m2');
    mirrorMessage(OWNER, mine);
    mirrorMessage('owner-B', theirs);
    await drainMirrorOutbox();
    expect(mirrorOutboxSize()).toBe(0);

    // Re-mirroring the same bytes is a no-op for both owners…
    mirrorMessage(OWNER, mine);
    mirrorMessage('owner-B', theirs);
    expect(mirrorOutboxSize()).toBe(0);

    // …until the repair flow purges THIS owner's dedup.
    clearMirrorDedupForOwner(OWNER);
    mirrorMessage(OWNER, mine);
    mirrorMessage('owner-B', theirs);
    expect(mirrorOutboxSize()).toBe(1);
  });

  it('an identical re-mirror is a no-op; ANY semantic change goes through', async () => {
    const m = msg('m1');
    mirrorMessage(OWNER, m);
    mirrorMessage(OWNER, {...m});
    expect(mirrorOutboxSize()).toBe(1);

    mirrorMessage(OWNER, {...m, content: 'edited'});
    expect(mirrorOutboxSize()).toBe(2);
  });
});

describe('messageMirror — the enable flip and the pending-commit fast-forward', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    disposeMirror();
    mockPutMessages.mockImplementation(async (rows: unknown[]) => ({written: (rows as unknown[]).length}));
    setMirrorOwner(OWNER);
  });
  afterEach(() => { disposeMirror(); setMerkleAfterFlushHook(null); });

  it('fires the catch-up sweep exactly once on the disabled → enabled flip', async () => {
    const sweep = jest.fn(async () => undefined);
    setCatchUpSweep(sweep);
    expect(isMirrorEnabled()).toBe(false);

    setMirrorKey(await makeKey(1));
    expect(isMirrorEnabled()).toBe(true);
    await waitFor(() => sweep.mock.calls.length > 0);
    expect(sweep).toHaveBeenCalledTimes(1);

    // A key ROTATION is enabled → enabled; the boot-window gap recovery must
    // not re-run (and re-upload) on every rotation.
    setMirrorKey(await makeKey(2));
    await tick(30);
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('a failing catch-up sweep is logged, never thrown into the caller', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    setCatchUpSweep(async () => { throw new Error('sql_locked'); });

    expect(() => setMirrorKey(null)).not.toThrow();
    await expect((async () => setMirrorKey(await makeKey(3)))()).resolves.toBeUndefined();
    await waitFor(() => warn.mock.calls.length > 0);
    expect(warn.mock.calls.flat().join(' ')).toContain('catch-up sweep failed');
    warn.mockRestore();
  });

  it('B-81 — an idle boot does NOT mint a commit; a boot that uploaded does', async () => {
    const hook = jest.fn(async () => undefined);
    setMerkleAfterFlushHook(hook);
    setMirrorKey(await makeKey());

    // Idle: nothing was mirrored, so no commit is owed. Minting one here is
    // exactly the "walk-and-sign without an upload" the invariant forbids.
    await fireMerkleHookNowIfPending();
    expect(hook).not.toHaveBeenCalled();

    // A real flush schedules the debounced commit; the sweep fast-forwards it,
    // shrinking the kill-window from (5s debounce + walk) to just the walk.
    mirrorMessage(OWNER, msg('m1'));
    await drainMirrorOutbox();
    await fireMerkleHookNowIfPending();
    expect(hook).toHaveBeenCalledTimes(1);

    // The debounce was consumed — a second fast-forward is silent again.
    await fireMerkleHookNowIfPending();
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
