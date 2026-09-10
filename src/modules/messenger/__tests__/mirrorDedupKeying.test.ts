/**
 * B-632 — the mirror dedup is KEYED, not scanned.
 *
 * CLAUDE.md's lag section named the per-send backup work as the one untested
 * lead after eight measured dead ends. `markDirty` was it, and the cost was
 * structural rather than incidental:
 *
 *   • the dedup was a Set of `${owner}:${id}:${version}` composites, so
 *     dropping ONE row's entry meant walking the WHOLE set with startsWith —
 *     and the set is seeded at boot from the entire `mirror_flushed` ledger,
 *     i.e. one entry per message in the user's whole history;
 *   • the re-enqueue then scanned EVERY hydrated conversation's message array
 *     to locate that one id.
 *
 * Both run on the JS thread, on every message mutation, and `recordReadReceipts`
 * fires them once per row it marks — so opening a chat paid the whole thing
 * once per unread message. Measured (V8, so a floor; Hermes is several times
 * worse): 200 rows marked cost 214 ms at 5k history and 1.74 s at 40k. That is
 * exactly the reported "the tap renders but the action registers late".
 *
 * These pins hold the shape that fixed it. Six of them were mutation-proved
 * RED on 2026-08-22 by stashing the fix and re-running. The timing case sits
 * between the two shapes with room on both sides — three orders of magnitude
 * separate them — so it flags an O(history) regression without becoming a CI
 * flake (this repo has a documented moving-flake problem: B-126/B-153).
 *
 * Comment-stripped, CRLF-safe source scans for the parts no unit test can
 * reach: a `\n` anchor matches nothing in these files and passes VACUOUSLY.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

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

import {
  setMirrorKey, setMirrorOwner, mirrorMessage, markDirty, mirrorRemoval,
  disposeMirror, mirrorOutboxSize, seedMirrorDedup, computeMirrorVersion,
  clearMirrorDedupForOwner,
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

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}
const mirrorSrc = () => code('src', 'modules', 'messenger', 'backup', 'messageMirror.ts');
const storeSrc  = () => code('src', 'modules', 'messenger', 'store', 'messengerStore.ts');

/** The body of `markDirty`, comment-stripped, up to the next top-level export. */
function markDirtyBody(): string {
  const s = mirrorSrc();
  const start = s.indexOf('export function markDirty(');
  expect(start).toBeGreaterThan(-1);
  const next = s.indexOf('\nexport ', start + 10);
  return s.slice(start, next === -1 ? undefined : next);
}

describe('B-632 — markDirty drops ONE keyed entry, never a scan of the history', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    disposeMirror();
    useMessengerStore.setState({messages: {}, conversations: {}, conversationOrder: [], error: null} as never);
    setMirrorOwner(OWNER);
    setMirrorKey(await makeKey());
  });
  afterEach(() => { disposeMirror(); });

  it('a seeded history is untouched when one unrelated row is marked dirty', () => {
    const versions = new Map<string, string>();
    for (let i = 0; i < 500; i++) {versions.set(`old-${i}`, `v${i}`);}
    seedMirrorDedup(OWNER, versions);

    markDirty(OWNER, 'old-7');

    // Only old-7 lost its dedup entry: re-mirroring it enqueues, and
    // re-mirroring any sibling at its seeded version is still a no-op.
    useMessengerStore.setState({messages: {'conv-1': [msg('old-7')]}} as never);
    const seven = msg('old-7');
    mirrorMessage(OWNER, seven);
    expect(mirrorOutboxSize()).toBe(1);

    // A sibling still deduped at its seeded version — prove it with the real
    // version hash rather than a guess, so this cannot pass vacuously.
    const sibling = msg('old-8');
    const v8 = computeMirrorVersion(sibling);
    seedMirrorDedup(OWNER, new Map([['old-8', v8]]));
    mirrorMessage(OWNER, sibling);
    expect(mirrorOutboxSize()).toBe(1);   // unchanged — the sibling was skipped
  });

  it('holds the LAST version per row, so a revert re-ships instead of sticking on the server', () => {
    useMessengerStore.setState({messages: {'conv-1': []}} as never);
    const a = msg('m1', {status: 'sent'});
    const b = msg('m1', {status: 'delivered'});

    mirrorMessage(OWNER, a);                 // ships A
    expect(mirrorOutboxSize()).toBe(1);
    mirrorMessage(OWNER, b);                 // ships B
    expect(mirrorOutboxSize()).toBe(2);
    mirrorMessage(OWNER, a);                 // reverts to A — must ship again
    // The old composite-key Set had "seen" A and skipped it, leaving the
    // server permanently on B while local truth said A.
    expect(mirrorOutboxSize()).toBe(3);
  });

  it('an unchanged row is still a no-op — I1, idle boots upload nothing', () => {
    useMessengerStore.setState({messages: {'conv-1': []}} as never);
    const m = msg('m1', {status: 'sent'});
    mirrorMessage(OWNER, m);
    expect(mirrorOutboxSize()).toBe(1);
    mirrorMessage(OWNER, m);
    expect(mirrorOutboxSize()).toBe(1);
  });

  it('BUG-5 — a repeated removal still tombstones exactly once', () => {
    const row = msg('m1');
    mirrorRemoval(OWNER, row);
    mirrorRemoval(OWNER, row);
    mirrorRemoval(OWNER, row);
    expect(mirrorOutboxSize()).toBe(1);
  });

  it('a tombstone REPLACES the row\'s live dedup entry, so a live enqueue cannot shadow it', () => {
    useMessengerStore.setState({messages: {'conv-1': []}} as never);
    const row = msg('m1');
    mirrorMessage(OWNER, row);            // live version deduped
    expect(mirrorOutboxSize()).toBe(1);
    mirrorRemoval(OWNER, row);            // tombstone takes the key
    expect(mirrorOutboxSize()).toBe(2);
    mirrorRemoval(OWNER, row);            // still deduped as deleted
    expect(mirrorOutboxSize()).toBe(2);
  });

  it('I4 — clearMirrorDedupForOwner drops one owner\'s keys and not another\'s', () => {
    useMessengerStore.setState({messages: {'conv-1': []}} as never);
    setMirrorOwner(null);                 // allow both owners through the gate
    const m = msg('m1');
    mirrorMessage(OWNER, m);
    mirrorMessage('owner-B', m);
    expect(mirrorOutboxSize()).toBe(2);

    clearMirrorDedupForOwner(OWNER);
    mirrorMessage(OWNER, m);              // re-enqueues — key was dropped
    expect(mirrorOutboxSize()).toBe(3);
    mirrorMessage('owner-B', m);          // still deduped — untouched
    expect(mirrorOutboxSize()).toBe(3);
  });

  it('the conversation hint finds the row, and a WRONG hint still falls back', () => {
    useMessengerStore.setState({
      messages: {'conv-1': [msg('m1')], 'conv-2': [msg('m2', {conversation_id: 'conv-2'})]},
    } as never);
    const versions = new Map<string, string>([
      ['m1', computeMirrorVersion(msg('m1'))],
      ['m2', computeMirrorVersion(msg('m2', {conversation_id: 'conv-2'}))],
    ]);
    seedMirrorDedup(OWNER, versions);

    markDirty(OWNER, 'm2', 'conv-2');            // correct hint
    expect(mirrorOutboxSize()).toBe(1);

    seedMirrorDedup(OWNER, versions);            // re-seed both
    markDirty(OWNER, 'm1', 'conv-NOPE');         // wrong hint — fallback scan
    expect(mirrorOutboxSize()).toBe(2);
  });

  it('marking a whole chat read stays cheap against a 40k-message history', () => {
    // The shape recordReadReceipts produces: one markDirty per row it marks,
    // against a dedup seeded from the FULL ledger and a store holding many
    // hydrated conversations. Pre-fix this measured 1.74 s on V8 alone.
    const versions = new Map<string, string>();
    for (let i = 0; i < 40_000; i++) {versions.set(`hist-${i}`, `v${i}`);}
    seedMirrorDedup(OWNER, versions);

    const messages: Record<string, LocalMessage[]> = {};
    for (let c = 0; c < 60; c++) {
      messages[`conv-${c}`] = Array.from({length: 200}, (_, i) => msg(`c${c}-m${i}`, {conversation_id: `conv-${c}`}));
    }
    useMessengerStore.setState({messages} as never);

    const t0 = Date.now();
    for (let i = 0; i < 400; i++) {markDirty(OWNER, `c0-m${i % 200}`, 'conv-0');}
    const elapsed = Date.now() - t0;

    // Mutation-proved 2026-08-22: reverting the keyed dedup puts this loop at
    // ~1.6 s here, so the bound has to sit well under that to be a real pin.
    // Post-fix the loop is single-digit ms, which still leaves a ~30x margin
    // for a slow CI box — the gap between the two shapes is three orders of
    // magnitude, so there is no bound that is tight for one and flaky for the
    // other.
    expect(elapsed).toBeLessThan(300);
  });
});

describe('B-632 — the keyed shape is pinned in source', () => {
  it('markDirty no longer walks the dedup with a prefix match', () => {
    const body = markDirtyBody();
    expect(body).not.toMatch(/for\s*\(\s*const\s+\w+\s+of\s+seenIds/);
    expect(body).not.toMatch(/startsWith/);
    // …it deletes exactly one keyed entry instead.
    expect(body).toMatch(/const key = versionKey\(ownerUserId,\s*messageId\)/);
    expect(body).toMatch(/seenIds\.delete\(key\)/);
  });

  it('the dedup is a Map keyed by (owner, message) — the ledger\'s own primary key', () => {
    const s = mirrorSrc();
    expect(s).toMatch(/const\s+seenIds\s*=\s*new\s+Map<string,\s*string>\(\)/);
    expect(s).toMatch(/const\s+versionKey\s*=[\s\S]{0,120}?\$\{ownerUserId\}:\$\{messageId\}/);
  });

  it('markDirty takes the conversation hint, and EVERY store nudge carries one', () => {
    expect(mirrorSrc()).toMatch(
      /export function markDirty\(ownerUserId: string, messageId: string, conversationId\?: string\)/,
    );
    const store = storeSrc();
    // B-634 moved the nudges out of their immer recipes and behind one helper,
    // so `notifyBackupDirty` must appear EXACTLY twice in the whole store: its
    // own declaration, and the loop inside flushBackupDirty. Any third
    // occurrence is a call re-added at a mutation site — which is both the
    // pre-commit-read bug and a nudge that could lose its conversation.
    const occurrences = store.split(/\r?\n/).filter(l => /notifyBackupDirty\(/.test(l));
    expect(occurrences).toHaveLength(2);
    expect(store).toMatch(/function flushBackupDirty\(messageIds: readonly string\[\], conversationId: string\)/);
    // …and every action that collects dirty ids flushes them WITH the id.
    const flushes = store.split(/\r?\n/).filter(l => /flushBackupDirty\(dirty, conversationId\)/.test(l));
    expect(flushes.length).toBeGreaterThanOrEqual(10);
  });

  it('clearDedupForItems drops one key per item rather than re-walking the dedup', () => {
    const s = mirrorSrc();
    const start = s.indexOf('function clearDedupForItems(');
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf('\n}', start));
    expect(body).not.toMatch(/of\s+seenIds/);
    expect(body).toMatch(/seenIds\.delete\(versionKey\(ownerUserId,\s*msg\.id\)\)/);
  });
});
