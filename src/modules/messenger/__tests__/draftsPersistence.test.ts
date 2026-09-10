/**
 * MI-06 — drafts persist across restart (WhatsApp standard).
 *
 * Before this landed the draft was route-param + composer-local state only:
 * leaving the chat (or an app restart) silently discarded whatever was typed.
 *
 * Shape of the fix, and what each block below pins:
 *  - store slice `drafts` + `setDraft` action (set / whitespace-clears / dedup)
 *  - the SQLCipher draft sink (module-scoped, same pattern as the group
 *    master-key sink) — a draft is message PLAINTEXT, so the durable copy
 *    lives ONLY in the SQLCipher `drafts` table. AsyncStorage must never see
 *    it: the partialize whitelist does not include `drafts`, asserted here
 *    functionally by scanning everything the persist layer wrote.
 *  - the real-SQLite round-trip of `SqlMessageStore.setDraft/loadDrafts`
 *    against the REAL exported DDL (never a copy — the B-129 drift class).
 *  - the ChatScreen wiring (static scan; the node project cannot mount RN):
 *    restore into the composer, debounced persist + unmount flush.
 */

const mockStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockStore.set(k, v); },
    removeItem: async (k: string) => { mockStore.delete(k); },
  },
}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));

import {readFileSync} from 'fs';
import {join} from 'path';
import {DatabaseSync} from 'node:sqlite';
import {useMessengerStore, registerDraftSink} from '../store/messengerStore';
import {SqlMessageStore} from '../store/sqlMessageStore';
import {DDL} from '../crypto/db';

afterEach(() => {
  registerDraftSink(null);
  useMessengerStore.getState().reset();
});

describe('MI-06 — the drafts store slice', () => {
  it('setDraft records the draft; whitespace-only clears it', () => {
    const st = useMessengerStore.getState();
    st.setDraft('c1', 'hello there');
    expect(useMessengerStore.getState().drafts.c1).toBe('hello there');
    st.setDraft('c1', '   ');
    expect(useMessengerStore.getState().drafts.c1).toBeUndefined();
  });

  it('writes through the SQLCipher sink — set and clear both reach disk', async () => {
    const set = jest.fn(async () => {});
    registerDraftSink({set});
    useMessengerStore.getState().setDraft('c1', 'partial thought');
    useMessengerStore.getState().setDraft('c1', '');
    await Promise.resolve(); // the sink call is queued as a microtask
    expect(set).toHaveBeenNthCalledWith(1, 'c1', 'partial thought');
    expect(set).toHaveBeenNthCalledWith(2, 'c1', '');
  });

  it('an unchanged draft is a no-op — no store commit, no sink write', async () => {
    const set = jest.fn(async () => {});
    registerDraftSink({set});
    useMessengerStore.getState().setDraft('c1', 'same');
    useMessengerStore.getState().setDraft('c1', 'same');
    useMessengerStore.getState().setDraft('c2', ''); // clear of a non-existent draft
    await Promise.resolve();
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('SECURITY: draft plaintext NEVER reaches AsyncStorage', async () => {
    jest.useFakeTimers();
    try {
      const marker = 'TOP-SECRET-DRAFT-BODY-93117';
      useMessengerStore.getState().setDraft('c1', marker);
      // The persist layer debounces writes ~500 ms; run everything out.
      jest.advanceTimersByTime(2_000);
      await Promise.resolve();
      for (const [k, v] of mockStore) {
        expect({key: k, containsDraft: v.includes(marker)})
          .toEqual({key: k, containsDraft: false});
      }
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('MI-06 — SQLCipher drafts table round-trip (real engine, real DDL)', () => {
  function makeEngine(): SqlMessageStore & {raw: DatabaseSync} {
    const raw = new DatabaseSync(':memory:');
    for (const stmt of DDL) {
      try {
        raw.exec(stmt);
      } catch (e) {
        if (!/duplicate column name|already exists/i.test((e as Error).message)) {throw e;}
      }
    }
    const db = {
      async execute(sql: string, params: unknown[] = []) {
        const stmt = raw.prepare(sql.trim());
        const bound = params.map(p => (p === undefined ? null : p)) as never[];
        if (/^\s*(SELECT|PRAGMA)/i.test(sql)) {return {rows: stmt.all(...bound) as unknown[]};}
        stmt.run(...bound);
        return {rows: []};
      },
    };
    const store = new SqlMessageStore(db as never) as SqlMessageStore & {raw: DatabaseSync};
    store.raw = raw;
    return store;
  }

  it('a saved draft survives a "restart" (fresh store over the same db)', async () => {
    const store = makeEngine();
    await store.setDraft('conv-a', 'unsent message');
    await store.setDraft('conv-b', 'another one');
    expect(await store.loadDrafts()).toEqual({
      'conv-a': 'unsent message',
      'conv-b': 'another one',
    });
  });

  it('re-saving overwrites; empty/whitespace deletes the row', async () => {
    const store = makeEngine();
    await store.setDraft('conv-a', 'v1');
    await store.setDraft('conv-a', 'v2');
    expect(await store.loadDrafts()).toEqual({'conv-a': 'v2'});
    await store.setDraft('conv-a', '   ');
    expect(await store.loadDrafts()).toEqual({});
    const n = store.raw.prepare('SELECT COUNT(*) AS n FROM drafts').get() as {n: number};
    expect(n.n).toBe(0);
  });
});

describe('MI-06 — ChatScreen wiring (static scan; CRLF-safe by indexOf)', () => {
  const chat = readFileSync(
    join(__dirname, '..', '..', '..', 'screens', 'messenger', 'ChatScreen.tsx'), 'utf8',
  );

  it('the composer is seeded from the persisted draft (route-param wins)', () => {
    expect(chat).toContain('initialDraft={savedDraft}');
    const seed = chat.indexOf('const [savedDraft]');
    expect(seed).toBeGreaterThan(-1);
    const init = chat.slice(seed, seed + 300);
    expect(init).toContain('draft ??');
    expect(init).toContain('.drafts[conversationId]');
  });

  it('the screen persists via the store action; the composer gets the prop', () => {
    expect(chat).toContain('onPersistDraft={onPersistDraft}');
    const cb = chat.indexOf('const onPersistDraft = useCallback');
    expect(cb).toBeGreaterThan(-1);
    expect(chat.slice(cb, cb + 300)).toContain('.setDraft(conversationId, t)');
  });

  it('the composer flushes the draft on unmount (backing out never loses the tail)', () => {
    // The unmount flush must read textRef (the synchronous truth), not `text`.
    // NAV-22 (2026-08-26) defers the flush one macrotask off the pop commit —
    // the value is CAPTURED from textRef synchronously in the cleanup (so no
    // later mutation can change what gets flushed), then persisted a tick
    // later. Both halves are load-bearing: capture-now, flush-deferred.
    expect(chat).toContain('const tail = textRef.current;');
    expect(chat).toContain('setTimeout(() => persistDraftRef.current?.(tail), 0);');
  });
});

// ─── AUDIT-2026-08-13 F6 — boot hydration merges, never clobbers ──────────
describe('AUDIT F6 — drafts boot hydration merges under live typing', () => {
  it('the hydration setState is a MERGE with live keys winning (static pin — productionRuntime is unimportable)', () => {
    const src = readFileSync(
      join(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');
    // The exact merge shape: disk fills only untouched gaps, live keys win.
    expect(src).toContain('return {drafts: {...fill, ...s.drafts}};');
    // The clobber shape must stay dead.
    expect(src).not.toContain('useMessengerStore.setState({drafts})');
  });

  it('a key TOUCHED during the boot window beats the disk copy', () => {
    const src = readFileSync(
      join(__dirname, '..', 'runtime', 'productionRuntime.ts'), 'utf8');
    // Rev-3 close of the CLEAR-resurrection residual: setDraft('') deletes
    // the store key, so a plain live-wins merge refills it from disk — and
    // ChatScreen re-entry then RE-PERSISTED the ghost, making it permanent.
    // The sink is the funnel every SINK-REACHING setDraft passes through,
    // so it feeds the touched set; anchor INSIDE the sink arrow — the
    // window ends at the sink's own closing brace, so relocating the add
    // to an adjacent never-called helper cannot stay green (critic rev-3).
    const sink = src.indexOf('registerDraftSink({set: (cid, content) => {');
    expect(sink).toBeGreaterThan(-1);
    const sinkEnd = src.indexOf('}});', sink);
    expect(sinkEnd).toBeGreaterThan(sink);
    const sinkBody = src.slice(sink, sinkEnd);
    expect(sinkBody).toContain('touchedDuringBoot.add(cid);');
    expect(sinkBody).toContain('draftsStore.setDraft(cid, content)');
    // And the hydrate loop must consult it — fill ONLY untouched keys.
    expect(src).toContain('if (!touchedDuringBoot.has(cid)) {fill[cid] = content;}');
    // Honest scope (critic rev-3): a STANDALONE clear — one not preceded by
    // a set this session — early-returns in setDraft before the sink
    // (store key already absent), so it is NOT recorded. That lane's ghost
    // is transient: the composer never displayed the disk draft and the
    // unmount flush heals the store. What this pin guarantees: any key the
    // sink SAW (typed, or cleared after a type) beats the disk copy.
  });

  // (A previous "executed merge semantics" test here was removed: it
  // re-implemented the spread inside the test with zero coupling to
  // production and survived a spread-order mutation — tautological. The
  // static pins above are the real gate. The clear-during-boot resurrection
  // that was documented here as a KNOWN RESIDUAL is now FIXED (rev-3): the
  // touched-keys set fed by the draft sink lets the merge tell "cleared"
  // from "never touched". Pinned by the test above.)
});
