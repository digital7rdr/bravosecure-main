/**
 * B-594 — "whatever chat list we delete, it appears for a fraction of a second
 * when the backup thing happens."
 *
 * Deleting a conversation was a Zustand-only eviction: no tombstone, no mirror
 * removal, no server call. The backup therefore kept the conversation in full,
 * and the restore's conversation apply — whose "already live?" guard exists to
 * avoid stomping FRESHER state — read a deliberately-deleted row as "not live,
 * safe to restore" and handed it straight back at the TOP of the list. The Home
 * screen's server prune then removed it again once `listMine` landed, one
 * network round-trip later. Appear → prune → appear, for the whole restore.
 *
 * The risk in the FIX is the mirror image: a tombstone that never lifts would
 * make a re-added mission room, or a peer who messages you after you cleared
 * the thread, permanently invisible. So both directions are pinned here.
 */
jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    jest.fn(async (k: string) => store.get(k) ?? null),
      setItem:    jest.fn(async (k: string, v: string) => { store.set(k, v); }),
      removeItem: jest.fn(async (k: string) => { store.delete(k); }),
      __store: store,
    },
  };
});

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  loadConversationTombstones,
  rememberDeletedConversation,
  clearConversationTombstone,
  isConversationTombstoned,
  suppressResurrection,
  beginArchiveReplay,
  endArchiveReplay,
  isArchiveReplayInProgress,
  clearAllConversationTombstones,
  _resetConversationTombstonesForTests,
} from '../backup/conversationTombstones';

const OWNER = 'owner-1';
const CID   = 'mission-room-abc';
/** A fixed delete instant, so 'composed before/after the delete' is explicit. */
const T0    = 1_700_000_000_000;

beforeEach(async () => {
  _resetConversationTombstonesForTests();
  (AsyncStorage as unknown as {__store: Map<string, string>}).__store.clear();
  jest.clearAllMocks();
});

describe('the record of what the user deleted', () => {
  it('remembers a deleted conversation and reports it', async () => {
    await loadConversationTombstones(OWNER);
    expect(isConversationTombstoned(CID)).toBe(false);
    rememberDeletedConversation(CID, T0);
    expect(isConversationTombstoned(CID)).toBe(true);
  });

  it('is SYNCHRONOUS in memory — the restore can start in the same tick', async () => {
    // Awaiting AsyncStorage before arming the gate is precisely the race this
    // exists to close: the delete and the restore round that would resurrect
    // it can be milliseconds apart.
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    expect(isConversationTombstoned(CID)).toBe(true); // no await in between
  });

  it('persists across a reload', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    await Promise.resolve();
    _resetConversationTombstonesForTests();
    await loadConversationTombstones(OWNER);
    expect(isConversationTombstoned(CID)).toBe(true);
  });

  it('is OWNER-KEYED — an account switch cannot inherit the other user\'s deletions', async () => {
    // BUG-R shape: the owner-blind cache served user A's set to user B.
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    await loadConversationTombstones('owner-2');
    expect(isConversationTombstoned(CID)).toBe(false);
  });

  it('FAILS OPEN when uninitialised — a storage failure must never hide a live chat', () => {
    // No load() at all: the gate must answer "not deleted" (BACKUP_LOOP I8).
    expect(isConversationTombstoned(CID)).toBe(false);
    expect(suppressResurrection(CID)).toBe(false);
  });

  it('a blank id is never tombstoned', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation('', T0);
    expect(isConversationTombstoned('')).toBe(false);
    expect(isConversationTombstoned(null)).toBe(false);
    expect(isConversationTombstoned(undefined)).toBe(false);
  });
});

describe('replay is suppressed; a LIVE arrival brings the chat back', () => {
  it('SUPPRESSES a resurrection while the archive replay is running', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    beginArchiveReplay();
    expect(suppressResurrection(CID)).toBe(true);
    // …and the tombstone SURVIVES, so every later envelope in the same replay
    // is suppressed too. Clearing it on the first hit would resurrect the
    // conversation on envelope #2.
    expect(isConversationTombstoned(CID)).toBe(true);
    endArchiveReplay();
  });

  it('LIFTS the tombstone for a genuinely live arrival', () => {
    // Deleting a thread must not deafen you to that person forever — every
    // messenger brings the thread back when they write again.
    void loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    expect(suppressResurrection(CID)).toBe(false);
    expect(isConversationTombstoned(CID)).toBe(false);
  });

  it('the replay bracket is a COUNTER, so a nested replay cannot un-bracket the outer', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    beginArchiveReplay();
    beginArchiveReplay();
    endArchiveReplay();
    expect(isArchiveReplayInProgress()).toBe(true);
    expect(suppressResurrection(CID)).toBe(true);
    endArchiveReplay();
    expect(isArchiveReplayInProgress()).toBe(false);
  });

  it('never goes negative, so a stray end() cannot make live traffic read as replay', () => {
    endArchiveReplay();
    endArchiveReplay();
    expect(isArchiveReplayInProgress()).toBe(false);
  });

  it('an untombstoned conversation is never suppressed, replay or not', async () => {
    await loadConversationTombstones(OWNER);
    beginArchiveReplay();
    expect(suppressResurrection('never-deleted')).toBe(false);
    endArchiveReplay();
  });

  /**
   * The replay bracket is a global TIME WINDOW, and the transport stays live
   * during a background restore — so a genuine WS envelope landing inside one
   * of the replay's awaits would be read as replayed and DROPPED. The compose
   * time is the precise answer the bracket cannot give: anything composed
   * AFTER the delete is new traffic by definition.
   */
  it('a message composed AFTER the delete lifts it, even mid-replay', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    beginArchiveReplay();
    expect(suppressResurrection(CID, T0 + 60_000)).toBe(false);
    expect(isConversationTombstoned(CID)).toBe(false);
    endArchiveReplay();
  });

  it('…and one composed BEFORE the delete is still suppressed mid-replay', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    beginArchiveReplay();
    expect(suppressResurrection(CID, T0 - 60_000)).toBe(true);
    expect(isConversationTombstoned(CID)).toBe(true);
    endArchiveReplay();
  });

  it('an unparseable compose time falls back to the bracket, never to a drop', () => {
    // `Date.parse` of a malformed timestamp is NaN; treating that as "older
    // than the delete" would silently suppress a live message.
    void loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    expect(suppressResurrection(CID, Number.NaN)).toBe(false); // no replay → lift
  });

  it('re-deleting refreshes the recorded time', async () => {
    // Otherwise a chat deleted, revived and deleted again keeps its ORIGINAL
    // deletion time, and every message since then reads as "after the delete".
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    rememberDeletedConversation(CID, T0 + 100_000);
    beginArchiveReplay();
    expect(suppressResurrection(CID, T0 + 50_000)).toBe(true);
    endArchiveReplay();
  });

  it('a LEGACY bare-id record loads and fails open', async () => {
    // The first draft stored a plain array of ids. Those carry no deletion
    // time, so they read as "deleted at time 0" — every arrival is newer and
    // lifts them. Fail-open is the only honest reading of an unknown time.
    (AsyncStorage as unknown as {__store: Map<string, string>})
      .__store.set(`messenger.deletedConversations.v1:${OWNER}`, JSON.stringify([CID]));
    await loadConversationTombstones(OWNER);
    expect(isConversationTombstoned(CID)).toBe(true);
    beginArchiveReplay();
    expect(suppressResurrection(CID, T0)).toBe(false); // any real time > 0
    endArchiveReplay();
  });
});

/**
 * ⚠️ THE PIN THAT CAUGHT A P0 IN THIS FIX'S OWN FIRST DRAFT.
 *
 * Every gate in this module FAILS OPEN — uninitialised means "not deleted", so
 * that a storage failure can never hide a live conversation (BACKUP_LOOP I8).
 * The cost of that correct choice is that a feature which is never LOADED looks
 * exactly like a feature with nothing to suppress: `cached` stays null,
 * `rememberDeletedConversation` early-returns, and every behavioural test above
 * still passes because they load the set themselves.
 *
 * The first draft shipped exactly that — the loader was called only from this
 * file. `productionRuntime.ts` cannot be imported by the node project, so the
 * wiring is pinned by a source scan, the same way the rest of that file's
 * boot contract is.
 */
describe('the boot wiring — a fail-open gate must actually be ARMED', () => {
  const readFileSync = require('node:fs').readFileSync as typeof import('node:fs').readFileSync;
  const join = require('node:path').join as typeof import('node:path').join;

  const runtimeSrc = (): string => {
    const raw = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const out: string[] = [];
    let inBlock = false;
    for (const line of raw.split('\n')) {
      const t = line.trim();
      if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
      if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
      if (t.startsWith('//') || t.startsWith('*')) {continue;}
      out.push(line);
    }
    return out.join('\n');
  };

  it('the runtime LOADS the set at boot', () => {
    expect(runtimeSrc()).toMatch(/await loadConversationTombstones\(/);
  });

  it('…keyed on the OWNER, so an account switch cannot inherit deletions', () => {
    // Same shape as the blocked-peer cache beside it (audit P1-10).
    expect(runtimeSrc()).toMatch(/loadConversationTombstones\(config\.ownerKey \?\? config\.ownUserId\)/);
  });

  it('…and the archive replay BRACKETS itself so a live arrival is distinguishable', () => {
    const src = runtimeSrc();
    expect(src).toMatch(/beginArchiveReplay\(\)/);
    // In a `finally`, or a throwing replay leaves the bracket set and every
    // later LIVE message reads as a replay — silently suppressed.
    expect(src).toMatch(/finally \{[\s\S]{0,120}endArchiveReplay\(\)/);
  });
});

describe('lifting and wiping', () => {
  it('clearConversationTombstone lifts one id', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    clearConversationTombstone(CID);
    expect(isConversationTombstoned(CID)).toBe(false);
  });

  it('clearAll wipes the owner\'s set', async () => {
    await loadConversationTombstones(OWNER);
    rememberDeletedConversation(CID, T0);
    await clearAllConversationTombstones(OWNER);
    expect(isConversationTombstoned(CID)).toBe(false);
  });
});
