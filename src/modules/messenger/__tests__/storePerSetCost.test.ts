/**
 * B-633 / B-634 — two per-mutation costs found while measuring the lag that
 * B-632 closed. Both are FIXED (this header said "UNFIXED" long after the fix
 * commit flipped the assertions below — corrected 2026-08-26, NAV audit):
 * B-633 by the `PersistStorage` adapter that stringifies inside the 500 ms
 * flush (now shared via @store/debouncedJsonStorage), B-634 by moving the
 * dirty nudges out of their immer recipes behind `flushBackupDirty`.
 * History of the original defects, kept for the mechanism:
 *
 * B-633 — zustand's persist runs `partialize` + `JSON.stringify` on EVERY
 *         `set()`. The 500 ms debounced storage adapter only defers the
 *         AsyncStorage bridge call; the deep rebuild and the serialize happen
 *         synchronously on the mutator's stack. Confirmed in zustand 5.0.12:
 *
 *             const savedSetState = api.setState;
 *             api.setState = (state, replace) => {
 *               savedSetState(state, replace);
 *               return setItem();          // ← partialize + stringify, every set
 *             };
 *
 *         Measured cost of one partialize+stringify (V8, so a floor — Hermes is
 *         several times slower): 0.17 ms at 20 conversations, 0.56 ms at 60,
 *         1.70 ms at 120 (+2 vaulted owners), 4.82 ms at 250 (+3). It scales
 *         with CONVERSATION count, not message count, so unlike B-632 it is
 *         paid by every account whether or not backup is switched on.
 *
 * B-634 — `notifyBackupDirty` is called from INSIDE the immer recipe at all ten
 *         store sites, so `markDirty`'s `getState()` returns the PRE-commit
 *         snapshot. The store already knows this trap: `notifyBackupRemoved`
 *         carries a comment saying it "MUST be called AFTER the immer commit —
 *         calling it inside the recipe made markDirty read the pre-commit
 *         state". That lesson was never applied to the dirty nudge.
 *
 *         Consequence is write amplification, not data loss: markDirty mirrors
 *         the row as it was BEFORE the mutation, then the post-commit mirror
 *         subscriber mirrors it again with the real new version. Two encrypts
 *         and two server rows per mutation, and the first one re-uploads
 *         unchanged plaintext under a fresh AES-GCM IV — the exact server-byte
 *         churn BACKUP_LOOP I1 exists to prevent.
 *
 * (The MSG-10 / P0-S3 strips stayed in `partialize` — that security boundary
 * deliberately did not move into the adapter.)
 */
jest.mock('react-native', () => ({
  __esModule: true,
  AppState: {addEventListener: jest.fn(() => ({remove: () => undefined}))},
}));

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

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  setMirrorKey, setMirrorOwner, mirrorMessage, disposeMirror, mirrorOutboxSize,
} from '../backup/messageMirror';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

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

/** Comment-stripped, CRLF-safe (a `\n` anchor matches nothing here). */
function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

describe('B-634 — the dirty nudge fires AFTER the immer commit', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    disposeMirror();
    useMessengerStore.setState({
      messages: {'conv-1': [msg('m1', {status: 'sent'})]},
      conversations: {}, conversationOrder: [], error: null,
      _ownUserId: OWNER,
    } as never);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
  });
  afterEach(() => { disposeMirror(); });

  it('mirrors the COMMITTED row, so the live version needs no second ship', () => {
    useMessengerStore.getState().updateMessageStatus('conv-1', 'm1', 'delivered');

    // The nudge fired and enqueued exactly one row…
    expect(mirrorOutboxSize()).toBe(1);
    const after = useMessengerStore.getState().messages['conv-1'][0];
    expect(after.status).toBe('delivered');

    // …and it was the row as it looks AFTER the commit. Proof without
    // decrypting the queue: re-mirroring the row that is actually in the store
    // is now DEDUPED, which can only mean the dedup already holds the live
    // version. Before the fix this enqueued a second row, because markDirty had
    // read the pre-commit snapshot and stamped the dedup with the stale
    // ('sent') version.
    mirrorMessage(OWNER, after);
    expect(mirrorOutboxSize()).toBe(1);
  });

  it('a receipt-only change still forces its way through the version gate', () => {
    // versionHash is blind to `receipts` (they ride the backup wire but are not
    // in the hash), so this is the case that keeps markDirty's forced
    // invalidation load-bearing — the B-634 queue guard must not swallow it.
    // Without it, restored chats lose their delivered/read ticks (the B-116
    // class). Own-authored row: recordDeliveredReceipt only tracks rows the
    // user SENT (`sender_id === 'self'`), which is also why the id collected
    // for the nudge has to be gathered inside the recipe rather than fired
    // unconditionally after it.
    useMessengerStore.setState({
      messages: {'conv-1': [msg('m2', {sender_id: 'self', status: 'sent'})]},
      _ownUserId: OWNER,
    } as never);
    useMessengerStore.getState().recordDeliveredReceipt('conv-1', 'm2', 'peer-1', Date.now());
    expect(mirrorOutboxSize()).toBe(1);
  });
});

describe('B-633 — the persist debounce covers the SERIALIZE, not just the write', () => {
  it('the store supplies a PersistStorage, so no stringify happens per set()', () => {
    const store = code('src', 'modules', 'messenger', 'store', 'messengerStore.ts');

    // createJSONStorage is what made the debounce half-useless: its own setItem
    // runs `JSON.stringify(newValue)` and only THEN calls the adapter, so the
    // serialize could never be deferred. The store must not go back to it.
    expect(store).not.toMatch(/createJSONStorage/);
    // NAV-14 (2026-08-26) — the adapter moved verbatim to the shared
    // @store/debouncedJsonStorage (so activityStore could stop re-growing the
    // per-set() stringify); the store must keep consuming it.
    expect(store).toMatch(/storage:\s*makeDebouncedJsonStorage\(PERSIST_DEBOUNCE_MS, 'messengerStore'\)/);
    expect(store).toMatch(/from '@store\/debouncedJsonStorage'/);

    // The adapter takes the partialized OBJECT and stringifies inside its own
    // debounced flush — once per quiet window instead of once per mutation.
    const adapter = code('src', 'store', 'debouncedJsonStorage.ts');
    const start = adapter.indexOf('function makeDebouncedJsonStorage');
    expect(start).toBeGreaterThan(-1);
    const body = adapter.slice(start);
    expect(body).toMatch(/const flush = \(\) => \{[\s\S]*?JSON\.stringify\(v\)/);
    // …and setItem itself must do nothing but stash + re-arm the timer.
    const setItem = body.slice(body.indexOf('setItem:'), body.indexOf('removeItem:'));
    expect(setItem).not.toMatch(/JSON\.stringify/);
  });

  it('getItem stays tick-for-tick identical to createJSONStorage — reads must not shift', () => {
    // Caught in review, the hard way: writing this as `getItem: async (name)`
    // adds microtask ticks before persist resolves hydration, which delays
    // onRehydrateStorage and flipped DepartmentChannelsScreen's initial
    // collapse seed — departmentDirectoryRender G4 went red ONLY under a full
    // app-project run, green in isolation. B-633 is a WRITE-path change; the
    // read path must parse synchronously when the read is synchronous and
    // otherwise `promise.then(parse)`, exactly as createJSONStorage did.
    const adapter = code('src', 'store', 'debouncedJsonStorage.ts');
    const start = adapter.indexOf('function makeDebouncedJsonStorage');
    expect(start).toBeGreaterThan(-1);
    const body = adapter.slice(start);
    const getItem = body.slice(body.indexOf('getItem:'), body.indexOf('setItem:'));
    expect(getItem).not.toMatch(/getItem:\s*async/);
    expect(getItem).toMatch(/instanceof Promise/);
  });

  it('the security strips stay in partialize — that boundary did NOT move', () => {
    // MSG-10 (no plaintext body at rest) and P0-S3 (no masterKeyB64 at rest)
    // are enforced BEFORE anything reaches the adapter, so a deferred
    // stringify can never widen what lands in unencrypted AsyncStorage.
    // storeSinksAndPersist.test.ts owns the behavioural half of this.
    const store = code('src', 'modules', 'messenger', 'store', 'messengerStore.ts');
    const start = store.indexOf('partialize: (s)');
    expect(start).toBeGreaterThan(-1);
    const body = store.slice(start, store.indexOf('onRehydrateStorage', start));
    expect(body).toMatch(/stripGroups/);
    expect(body).toMatch(/stripLastMessage/);
    expect(body).toMatch(/masterKeyB64:\s*''/);
  });
});
