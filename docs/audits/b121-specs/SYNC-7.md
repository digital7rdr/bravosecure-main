# SYNC-7 - Inbound reactions are dropped when the target isn't in the in-memory window, and are never persisted at all

## Verdict

**CONFIRMED-WITH-DRIFT** — part (a) is confirmed and is _worse_ than the audit described; part (b) is
confirmed but is literally OM-01's finding, not new work here.

Evidence from the current tree (`src/modules/messenger/runtime/productionRuntime.ts`):

- `:7330-7355` `applyReaction` — three unconditional drops and zero durability:
  `:7339 if (!list) {return;}` (conversation slot not hydrated), `:7350 if (!msg) {return;}` (target
  not in the in-memory window), and `:7354 store.updateMessageReactions(...)` is the **last**
  statement — there is no `sqlMessages.upsert`, unlike every sibling receive branch
  (`:7255 if (sqlMessages) {await sqlMessages.upsert(groupMsg);}`, `:7320 … upsert(oneToOneMsg)`).
- The docstring itself admits the drop: `:7326` _"in that case we silently drop; the reactor can
  react again once both sides are back in sync"_ — a hand-wave, not a mechanism; nothing re-drives it.
- Both receive branches `return` immediately after calling it and therefore never persist:
  `:7261-7276` (1:1) and `:6601-6617` (group-stamped reaction), both inside `doHandleIncoming`
  which _does_ hold `sqlMessages: SqlMessageStore | null` (`:6308`).
- The in-memory window is capped: `messengerStore.ts:329 export const MAX_HYDRATE_PER_CONVO = 200;`
  and `:1147 const capped = (!bypassCap && merged.length > MAX_HYDRATE_PER_CONVO) ? merged.slice(-MAX_HYDRATE_PER_CONVO) : merged;`
  — boot hydration is `sqlMessages.loadRecent(MAX_HYDRATE_PER_CONVO)` (`productionRuntime.ts:1622`).
  So a reaction to the 201st-newest message in a chat hits `:7350` and is destroyed even though the
  target row is on disk.
- Part (b) reproduces exactly as cited: `:3332-3339` enqueues `payload: JSON.stringify({outerSealed})`
  with no `certExpSec`, versus the complete group row at `:2619-2626`
  (`{outerSealed, expiresAtSec, certExpSec, sealedBody, attachment, groupId, kind, clientMsgId}`), and
  `outboxCertFreshness.ts:37 if (certExpSec === undefined) {return false;}` reports it fresh forever.
  **This is verbatim OM-01** (`docs/audits/messenger_audit_2026-07-19.md:91-97` names
  `:3332-3339 (reaction: {outerSealed} only)` as OM-01 evidence). SYNC-7 must **not** edit
  `:3332-3339` — see "Blast radius".

Drift vs the audit: the audit reported one loss mode (reaction-before-target). The current code has
**three**, and the third — reactions are memory-only and evaporate on every cold boot — is the one a
user actually notices. The audit's proposed fix ("small pending-reaction stash") is necessary but on
its own would be pointless: it would replay a reaction into a store patch that is itself discarded on
the next launch.

## Mechanism

Reactions ride an empty-body sealed envelope carrying only `{reaction: {targetMsgId, emoji, remove}}`
(`:3308-3315`). On receive, `doHandleIncoming` routes them to `applyReaction`, which looks the target
up **only** in the Zustand `messages[conversationId]` array.

**M1 — target not yet delivered (reaction-before-target).** Deterministic in groups:

1. Alice sends text `M` to a 5-member group. Fan-out is one HTTP envelope per member
   (`:2602-2640`). Carol's envelope 429s on the relay's per-user throttle, or her session couldn't be
   established and the row was written `deferred: true` (`:2571-2585`). Carol does not have `M`.
2. Bob receives `M`, taps a reaction. `sendReaction` (`:3275`) fans out to **every** member
   (BS-RX1, `:3288`) — including Carol.
3. Carol's `doHandleIncoming` reaches `:6601` (group-stamped reaction) → `applyReaction` →
   `:7339` or `:7350` returns → the envelope is still marked seen and ACKed by the caller, so the
   relay deletes its copy.
4. Alice's 60 s outbox drain later delivers `M` to Carol. Nothing re-drives Bob's reaction. Carol
   never sees it — permanently, on every device, forever.

Same shape whenever a group text is parked in `pending_group_envelopes` (`no_key`, awaiting a
`create`/`rekey`) while the pairwise reaction envelope — which needs no group key — sails straight
through.

**M2 — target on disk but outside the 200-row window.** Cold boot hydrates only
`MAX_HYDRATE_PER_CONVO` rows per conversation. A reaction to anything older resolves to `undefined`
at `:7350` and is destroyed, even though `sqlMessages` holds the row. Equally, an envelope processed
before hydration finishes hits `:7339` (`list` undefined) and dies.

**M3 — applied reactions are never persisted.** `updateMessageReactions` (`messengerStore.ts:845-850`)
mutates the Zustand draft and calls `notifyBackupDirty`; it writes no SQL. `messages.reactions_json`
exists (`crypto/db.ts:148`, `sqlMessageStore.ts:127,159,393`) and is populated by `upsert` — but no
reaction path ever calls `upsert`. On the next cold start the store rehydrates from SQLCipher and
every reaction the user ever received is gone. (Side effect: the backup mirror _does_ capture them,
because `markDirty` re-reads the live store — `messageMirror.ts:355-366` — so the mirrored row and
the local row disagree on every boot, and the boot sweep re-uploads the row with the reactions
stripped. Fixing M3 removes that churn.)

**M4 (= OM-01, out of scope here).** A reaction outbox row queued through a >1 h offline stretch is
re-shipped verbatim with a dead sender cert; the recipient's `verifySenderCert` destroys it
pre-decrypt while the relay answered 200.

## Fix

Four files. No wire-format change, no envelope-shape change, no server change, no crypto change.
One additive SQLCipher table (schema 14 → 15).

### 1. `src/modules/messenger/runtime/reactionMerge.ts` (NEW — pure, no native imports)

Same rationale as `outboxCertFreshness.ts`: the merge rule is duplicated inline in three places today
and is the thing the tests need to pin.

```ts
/**
 * SYNC-7 — the reaction map merge rule, in one place.
 *
 * Kept in its own module (no runtime/native imports) so both the receive path
 * and the pending-reaction drain can be unit-tested without standing up the
 * messenger runtime — same rationale as `outboxCertFreshness.ts`.
 *
 * Semantics: one emoji per reactor. A later reaction from the same user
 * replaces the earlier one; `remove` deletes that user's entry. Replaying the
 * same patch is therefore idempotent, which is what lets a stashed reaction be
 * applied twice without corrupting the map.
 */
export function mergeReaction(
  current: Record<string, string> | undefined,
  fromUserId: string,
  emoji: string,
  remove: boolean,
): Record<string, string> {
  const next: Record<string, string> = {...(current ?? {})};
  if (remove) {
    delete next[fromUserId];
  } else {
    next[fromUserId] = emoji;
  }
  return next;
}
```

### 2. `src/modules/messenger/crypto/db.ts` — new table + version bump

**Anchor** (end of the `DDL` array, verbatim current code):

```ts
  `CREATE TABLE IF NOT EXISTS mirror_flushed (
     owner_user_id TEXT NOT NULL,
     message_id    TEXT NOT NULL,
     version       TEXT NOT NULL,
     updated_at    INTEGER NOT NULL,
     PRIMARY KEY (owner_user_id, message_id)
   )`,
];
```

**Replacement** — insert before the closing `];`:

```ts
  // SYNC-7 — reactions whose target message hasn't been stored locally yet.
  // A reaction is a pairwise envelope with no group key dependency, so it
  // routinely overtakes the group text it points at (throttled fan-out,
  // deferred outbox row, no_key stash). The receive path ACKs it, so if we
  // drop it the relay copy is gone too — permanent, silent loss. Rows carry
  // no key material and no message body; the emoji is the same class of data
  // already held in `messages.reactions_json`.
  `CREATE TABLE IF NOT EXISTS pending_reactions (
     conversation_id  TEXT NOT NULL,
     target_msg_id    TEXT NOT NULL,
     from_user_id     TEXT NOT NULL,
     emoji            TEXT NOT NULL,
     removed          INTEGER NOT NULL DEFAULT 0,
     received_at_ms   INTEGER NOT NULL,
     PRIMARY KEY (conversation_id, target_msg_id, from_user_id)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_pending_reactions_target
     ON pending_reactions (conversation_id, target_msg_id)`,
];
```

**Anchor:** `const SCHEMA_VERSION = 14;` → `const SCHEMA_VERSION = 15;`

**Anchor** (end of `runMigrations`, verbatim):

```ts
  if (fromVersion < 14) {
    // B-94 — mirror_flushed is created idempotently by the DDL block
```

**Insertion** — a new branch after the `fromVersion < 14` block closes, matching the established
"table created by the idempotent DDL, nothing to copy" pattern used for v8/v9/v10/v11/v14:

```ts
if (fromVersion < 15) {
  // SYNC-7 — pending_reactions is created idempotently by the DDL block
  // above (CREATE TABLE IF NOT EXISTS). Nothing to copy; upgrading installs
  // start empty and only fill as the receive path starts stashing.
}
```

Back-compat: purely additive. A **downgrade** (older APK opening a v15 DB) takes neither branch in
`openCryptoDb` (`current > 0 && current < SCHEMA_VERSION` is false, `current < SCHEMA_VERSION` is
false), so the old build simply ignores the table. No data loss either direction.

### 3. `src/modules/messenger/store/pendingReactionStore.ts` (NEW)

Modelled directly on `pendingGroupEnvelopeStore.ts` (bounds, prune, eviction SQL shape).

```ts
/**
 * SYNC-7 — durable stash for reactions that arrived before their target
 * message existed locally.
 *
 * Why durable: the receive path marks the envelope seen and ACKs it inside the
 * same transaction, so the relay drops its copy. An in-memory stash would lose
 * the reaction on the next process death — the exact failure this exists to
 * kill. Same reasoning as `pendingGroupEnvelopeStore`.
 *
 * Key is (conversation_id, target_msg_id, from_user_id) so INSERT OR REPLACE
 * gives last-writer-wins per reactor — identical to the in-memory
 * `reactions[fromUserId] = emoji` semantics, and idempotent on replay.
 *
 * Bounds:
 *   MAX_PER_CONVERSATION = 256 — a peer can mint unlimited fake targetMsgIds,
 *                                so the table needs a cap even though the PK
 *                                bounds one row per (chat, target, reactor).
 *   MAX_GLOBAL           = 2048
 *   RETENTION_MS         = 30 days — matches the relay dwell, for the same
 *                                reason pendingGroupEnvelopeStore uses it
 *                                (GROUP-STASH-7DAY-PERMALOSS): stashing ACKs,
 *                                so an early prune IS the loss.
 */

import type {DbHandle} from '../crypto/db';

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const PENDING_REACTION_MAX_PER_CONVERSATION = 256;
export const PENDING_REACTION_MAX_GLOBAL = 2048;

export interface PendingReactionRow {
  conversationId: string;
  targetMsgId: string;
  fromUserId: string;
  emoji: string;
  removed: boolean;
  receivedAtMs: number;
}

export class PendingReactionStore {
  constructor(private readonly db: DbHandle) {}

  async stash(row: PendingReactionRow): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO pending_reactions
         (conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`,
      [
        row.conversationId,
        row.targetMsgId,
        row.fromUserId,
        row.emoji,
        row.removed ? 1 : 0,
        row.receivedAtMs,
      ],
    );
    await this.db.execute(
      `DELETE FROM pending_reactions
         WHERE rowid IN (
           SELECT rowid FROM pending_reactions
             WHERE conversation_id = ?
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_reactions WHERE conversation_id = ?) - ?)
         )`,
      [row.conversationId, row.conversationId, PENDING_REACTION_MAX_PER_CONVERSATION],
    );
    await this.db.execute(
      `DELETE FROM pending_reactions
         WHERE rowid IN (
           SELECT rowid FROM pending_reactions
             ORDER BY received_at_ms ASC
             LIMIT MAX(0, (SELECT COUNT(*) FROM pending_reactions) - ?)
         )`,
      [PENDING_REACTION_MAX_GLOBAL],
    );
  }

  async listForTarget(conversationId: string, targetMsgId: string): Promise<PendingReactionRow[]> {
    const res = await this.db.execute(
      `SELECT conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms
         FROM pending_reactions
         WHERE conversation_id = ? AND target_msg_id = ?
         ORDER BY received_at_ms ASC`,
      [conversationId, targetMsgId],
    );
    return mapRows(res.rows ?? []);
  }

  /** Boot sweep — every stashed row, oldest first. Bounded by MAX_GLOBAL. */
  async listAll(): Promise<PendingReactionRow[]> {
    const res = await this.db.execute(
      `SELECT conversation_id, target_msg_id, from_user_id, emoji, removed, received_at_ms
         FROM pending_reactions
         ORDER BY received_at_ms ASC`,
    );
    return mapRows(res.rows ?? []);
  }

  async deleteForTarget(conversationId: string, targetMsgId: string): Promise<void> {
    await this.db.execute(
      'DELETE FROM pending_reactions WHERE conversation_id = ? AND target_msg_id = ?',
      [conversationId, targetMsgId],
    );
  }

  async prune(nowMs: number = Date.now()): Promise<number> {
    const res = await this.db.execute('DELETE FROM pending_reactions WHERE received_at_ms < ?', [
      nowMs - RETENTION_MS,
    ]);
    return (res as {rowsAffected?: number}).rowsAffected ?? 0;
  }

  /** Test helper — current row count. */
  async _size(): Promise<number> {
    const res = await this.db.execute('SELECT COUNT(*) AS n FROM pending_reactions');
    const row = res.rows?.[0] as {n: number} | undefined;
    return row?.n ?? 0;
  }
}

function mapRows(rows: unknown[]): PendingReactionRow[] {
  return (
    rows as Array<{
      conversation_id: string;
      target_msg_id: string;
      from_user_id: string;
      emoji: string;
      removed: number;
      received_at_ms: number;
    }>
  ).map(r => ({
    conversationId: r.conversation_id,
    targetMsgId: r.target_msg_id,
    fromUserId: r.from_user_id,
    emoji: r.emoji,
    removed: r.removed === 1,
    receivedAtMs: r.received_at_ms,
  }));
}

export const PENDING_REACTIONS_RETENTION_MS = RETENTION_MS;
```

### 4. `src/modules/messenger/store/sqlMessageStore.ts` — resolve a target outside the window

**Anchor** (verbatim, the method immediately before `loadLinkMessages`'s docstring — insert after
`loadOlder`'s closing brace):

```ts
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }
```

**Insertion** (new method, directly after that closing brace):

```ts
  /**
   * SYNC-7 — resolve a reaction's target straight from SQLCipher.
   *
   * Why: the in-memory window is capped at MAX_HYDRATE_PER_CONVO, so a reaction
   * to an older message finds nothing in the store even though the row is on
   * disk. Mirrors the lookup applyReaction does in memory (id OR reply_to_msg_id).
   */
  async findReactionTarget(
    conversationId: string,
    targetMsgId: string,
  ): Promise<LocalMessage | null> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE conversation_id = ?
           AND (id = ? OR reply_to_msg_id = ?)
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      [conversationId, targetMsgId, targetMsgId],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.length ? rowToMessage(rows[0]) : null;
  }
```

### 5. `src/modules/messenger/runtime/productionRuntime.ts`

**5a — imports.** Add alongside the existing store imports (the `PendingGroupEnvelopeStore` import
block at `:40`):

```ts
  PendingReactionStore,
```

and, next to the `isStoredCertStale` import:

```ts
import {mergeReaction} from './reactionMerge';
```

**5b — module-level handle.** `applyReaction` and the drain are module-level functions; `sqlMessages`
is already threaded to them via `doHandleIncoming`, but the stash store is not. Threading a 15th
parameter through `handleIncoming` / `HandleIncomingDeps` / `doHandleIncoming` /
`replayGroupSealedDecode` / `drainPendingGroup` and their seven call sites is ~14 edits of pure
plumbing; the file already keeps cross-cutting receive-path state at module scope
(`let drainOutboxInflight = false;` at `:7392`, the group-key signal emitter). Follow that.

**Anchor** (verbatim, `:7392`):

```ts
let drainOutboxInflight = false;
```

**Replacement:**

```ts
/**
 * SYNC-7 — the pending-reaction stash handle, at module scope because
 * `applyReaction` and the drain are module-level functions on the receive path
 * (same placement rationale as `drainOutboxInflight` below). Assigned when the
 * SQLCipher stores are built and nulled by `disposeLiveRuntime`, so a
 * logout→login rebuild can never leave the previous user's handle live.
 */
let pendingReactionsStore: PendingReactionStore | null = null;

let drainOutboxInflight = false;
```

**5c — construction + boot sweep.**

**Anchor** (verbatim, in the `ownStore instanceof SqlCipherProtocolStore` block):

```ts
pendingGroupEnvelopes
  .prune()
  .catch(e =>
    console.warn('[messenger.pendingGroupEnvelopes] boot prune failed:', asErrorMessage(e)),
  );
```

**Insertion** (immediately after the `pendingAdminActions.prune()` call that follows it):

```ts
pendingReactionsStore = new PendingReactionStore(ownStore.getDb());
liveDisposers.push(() => {
  pendingReactionsStore = null;
});
const reactionStashLive = pendingReactionsStore;
const messagesForReactions = sqlMessages;
void (async () => {
  try {
    await reactionStashLive.prune();
    await sweepPendingReactions(reactionStashLive, messagesForReactions);
  } catch (e) {
    console.warn('[messenger.pendingReactions] boot sweep failed:', asErrorMessage(e));
  }
})();
```

**5d — `applyReaction` rewrite.**

**Anchor** (verbatim `:7323-7355`):

```ts
/**
 * Fold a reaction patch into an existing local message. The message
 * might not exist yet (out-of-order delivery of reaction-before-target
 * during catch-up) — in that case we silently drop; the reactor can
 * react again once both sides are back in sync, and the second reaction
 * will land after the target has been stored.
 */
function applyReaction(
  conversationId: string,
  fromUserId:    string,
  targetMsgId:   string,
  emoji:         string,
  remove:        boolean,
): void {
  const store = useMessengerStore.getState();
  const list  = store.messages[conversationId];
  if (!list) {return;}
```

…through…

```ts
  const msg = list.find(m => m.id === targetMsgId || m.reply_to_msg_id === targetMsgId);
  if (!msg) {return;}
  const next: Record<string, string> = {...(msg.reactions ?? {})};
  if (remove) {delete next[fromUserId];}
  else        {next[fromUserId] = emoji;}
  store.updateMessageReactions(conversationId, msg.id, next);
}
```

**Replacement:**

```ts
/**
 * SYNC-7 — fold a reaction patch onto its target message, durably.
 *
 * Three resolution tiers, because the target can legitimately be absent from
 * the in-memory window:
 *   1. In the hydrated window  → patch the store AND SQLCipher (the store
 *      rehydrates from SQL at boot, so a store-only patch evaporated).
 *   2. On disk but past MAX_HYDRATE_PER_CONVO → patch SQLCipher only; the
 *      scroll-back path reads it from there.
 *   3. Not stored at all      → stash. A reaction is a pairwise envelope with
 *      no group-key dependency, so it routinely overtakes the group text it
 *      points at; the caller has already ACKed it, so dropping it here is
 *      permanent loss. `drainPendingReactionsFor` replays it when the target
 *      lands.
 */
async function applyReaction(
  conversationId: string,
  fromUserId: string,
  targetMsgId: string,
  emoji: string,
  remove: boolean,
  sqlMessages: SqlMessageStore | null,
  receivedAtMs: number = Date.now(),
): Promise<void> {
  const store = useMessengerStore.getState();
  // Find target by the sender-chosen opaque id we store when encoding.
  // We key reply_to_msg_id off the same id, so the lookup pattern is
  // the "clientMsgId" of the target.
  const msg = store.messages[conversationId]?.find(
    m => m.id === targetMsgId || m.reply_to_msg_id === targetMsgId,
  );
  if (msg) {
    const next = mergeReaction(msg.reactions, fromUserId, emoji, remove);
    store.updateMessageReactions(conversationId, msg.id, next);
    if (sqlMessages) {
      sqlMessages.upsertCoalesced({...msg, reactions: next});
    }
    return;
  }
  if (sqlMessages) {
    const onDisk = await sqlMessages.findReactionTarget(conversationId, targetMsgId);
    if (onDisk) {
      const next = mergeReaction(onDisk.reactions, fromUserId, emoji, remove);
      await sqlMessages.upsert({...onDisk, reactions: next});
      return;
    }
  }
  if (!pendingReactionsStore) {
    return;
  }
  try {
    await pendingReactionsStore.stash({
      conversationId,
      targetMsgId,
      fromUserId,
      emoji,
      removed: remove,
      receivedAtMs,
    });
    console.log('[recv.reaction.stashed] target=' + targetMsgId.slice(0, 8));
  } catch (e) {
    console.warn('[messenger.pendingReactions] stash failed:', asErrorMessage(e));
  }
}

/**
 * SYNC-7 — replay every stashed reaction that was waiting for `messageId`.
 * Called immediately after an inbound message row is persisted, inside the
 * same receive transaction, so the reaction commits atomically with its target.
 */
async function drainPendingReactionsFor(
  conversationId: string,
  messageId: string,
  sqlMessages: SqlMessageStore | null,
): Promise<void> {
  if (!pendingReactionsStore || !sqlMessages) {
    return;
  }
  let rows;
  try {
    rows = await pendingReactionsStore.listForTarget(conversationId, messageId);
  } catch (e) {
    console.warn('[messenger.pendingReactions] list failed:', asErrorMessage(e));
    return;
  }
  if (rows.length === 0) {
    return;
  }
  const store = useMessengerStore.getState();
  const live = store.messages[conversationId]?.find(m => m.id === messageId);
  const target = live ?? (await sqlMessages.findReactionTarget(conversationId, messageId));
  if (!target) {
    return;
  }
  let next = target.reactions;
  for (const r of rows) {
    // The M-07 gate ran at stash time; re-check so a peer blocked in the
    // meantime can't reach the user through a replayed reaction.
    if (isPeerBlocked(r.fromUserId)) {
      continue;
    }
    next = mergeReaction(next, r.fromUserId, r.emoji, r.removed);
  }
  const merged = next ?? {};
  if (live) {
    store.updateMessageReactions(conversationId, messageId, merged);
  }
  await sqlMessages.upsert({...target, reactions: merged});
  await pendingReactionsStore.deleteForTarget(conversationId, messageId);
  console.log('[recv.reaction.drained] msgId=' + messageId.slice(0, 8) + ' n=' + rows.length);
}

/**
 * SYNC-7 — boot sweep. Covers targets that landed through a path with no
 * drain hook (backup restore, a build that predates the drain call sites).
 * Bounded by PENDING_REACTION_MAX_GLOBAL; runs once, fire-and-forget.
 */
async function sweepPendingReactions(
  stash: PendingReactionStore,
  sqlMessages: SqlMessageStore | null,
): Promise<void> {
  if (!sqlMessages) {
    return;
  }
  const rows = await stash.listAll();
  const targets = new Set(rows.map(r => `${r.conversationId} ${r.targetMsgId}`));
  for (const key of targets) {
    const [conversationId, targetMsgId] = key.split(' ');
    await drainPendingReactionsFor(conversationId, targetMsgId, sqlMessages);
  }
}
```

**5e — await the two call sites** (both currently fire `applyReaction(...)` synchronously and then
`return;`).

Anchor A (`:6608`, group-stamped reaction inside `doHandleIncoming`):

```ts
applyReaction(
  unwrapped.group.groupId,
  peer.userId,
  unwrapped.reaction.targetMsgId,
  unwrapped.reaction.emoji,
  unwrapped.reaction.remove ?? false,
);
return;
```

→

```ts
await applyReaction(
  unwrapped.group.groupId,
  peer.userId,
  unwrapped.reaction.targetMsgId,
  unwrapped.reaction.emoji,
  unwrapped.reaction.remove ?? false,
  sqlMessages,
  typeof unwrapped.aad?.ts === 'number' ? unwrapped.aad.ts : Date.now(),
);
return;
```

Anchor B (`:7288`, 1:1 reaction) — identical edit with `conversationId` as the first argument.

**5f — drain hooks.** Four one-line insertions, each immediately after an inbound message row is
persisted (all four anchors are verbatim current code):

| Anchor                                                                     | Site                                            |
| -------------------------------------------------------------------------- | ----------------------------------------------- |
| `    await sqlMessages.upsert(groupMsg);\n  });\n  void config;` (`:6217`) | `replayGroupSealedDecode` — no_key stash replay |
| `      if (sqlMessages) {await sqlMessages.upsert(legacyMsg);}` (`:6845`)  | legacy plaintext group                          |
| `    if (sqlMessages) {await sqlMessages.upsert(groupMsg);}` (`:7255`)     | group text                                      |
| `  if (sqlMessages) {await sqlMessages.upsert(oneToOneMsg);}` (`:7320`)    | 1:1 text                                        |

Insert after each:

```ts
  await drainPendingReactionsFor(conversationId, <msg>.id, sqlMessages);
```

(for `:6217` the call goes **inside** the `runWithRatchetTxn` callback, right after the `upsert`, so
it commits with the target; `<msg>` is `groupMsg` / `legacyMsg` / `groupMsg` / `oneToOneMsg`.)

**5g — send-side local echo dedupe (optional, same-file, 6 lines).**
`:3386-3397` duplicates the merge inline and is also store-only. Replace the body with
`mergeReaction` + `sqlMessages.upsertCoalesced` so the sender's own reaction survives a restart too.
Keeping this in scope is the difference between "reactions persist" and "only inbound reactions
persist"; do it.

**No wire change.** The reaction envelope shape (`{reaction: {targetMsgId, emoji, remove}}`,
`:3308-3315`) is untouched; `aad`/`SealedPayload`/outer wrap are untouched; no server route or DTO
changes. An old client sending to a new client is fixed by the new client's stash. A new client
sending to an old client behaves exactly as today. Server deploy ordering is irrelevant.

**Explicitly NOT in this fix:** `:3332-3339` (the reaction outbox `payload: JSON.stringify({outerSealed})`).
That is OM-01's edit — see below.

## Blast radius

**Files/functions changed**

- `productionRuntime.ts`: `applyReaction` (rewritten, now async), new `drainPendingReactionsFor` /
  `sweepPendingReactions` / module `pendingReactionsStore`, 2 call sites awaited, 4 drain
  insertions, 1 construction block, 1 `liveDisposers` entry, optional `sendReaction` local echo.
- `sqlMessageStore.ts`: `+findReactionTarget` (additive read-only; no existing behaviour touched).
- `crypto/db.ts`: `SCHEMA_VERSION` 14→15, one `CREATE TABLE IF NOT EXISTS` + index, one no-op
  migration branch.
- New: `store/pendingReactionStore.ts`, `runtime/reactionMerge.ts`.
- `runtime/runtime.ts:608-618` (loopback `sendReaction`) is **not** touched — no SQLCipher there.

**Overlapping findings**

- **OM-01 / XO-1 / SYNC-7(b)** — both want to edit `:3332-3339`. **OM-01 owns that hunk.** Land
  OM-01 first or last, never concurrently; SYNC-7's diff must not touch `sendReaction`'s enqueue
  block (5g touches only the local-echo block ~50 lines below it — still the same function, so
  coordinate).
- **SYNC-1 / SYNC-3** (group receipt/envelope-id matching) also edit `doHandleIncoming` and the
  `:7255` / `:7320` upsert neighbourhood. Textual conflict likely, semantic conflict none.
- **GF-3** edits `pendingGroupEnvelopeStore` retention and `replayGroupSealedDecode` — the `:6217`
  anchor collides.
- **OM-02** (ordering clamp) touches `created_at` on the same receive rows; independent of reactions
  but same functions.
- **Anything bumping `SCHEMA_VERSION`** (e.g. the deferred `is_mocked` migration) must serialise —
  two findings both claiming v15 is a merge hazard.

**Regression surface**

- `sqlMessages.upsert` runs through the per-conversation `chainOp` promise chain
  (`sqlMessageStore.ts:97`). `drainPendingReactionsFor` awaits `upsert` from **inside**
  `runWithRatchetTxn`, exactly as the existing `:7255` / `:7320` upserts already do — no new
  lock-ordering class. But B-75 was a `txnChain` self-deadlock, so this is the thing to review
  hardest: the tier-1 path deliberately uses `upsertCoalesced` (fire-and-forget, no chain await)
  precisely to avoid lengthening the txn on the hot path.
- Backup mirror: `updateMessageReactions` already calls `notifyBackupDirty`. The tier-2 (off-window)
  branch intentionally does **not** call it — the row isn't in the store, so `markDirty`'s store
  lookup would miss and emit a bogus tombstone (`messageMirror.ts:370-374`). Net effect on
  BACKUP_LOOP I1/I2: strictly _less_ churn than today (today's store-only reactions guarantee a
  version-hash mismatch against `mirror_flushed` on every boot).
- `MAX_HYDRATE_PER_CONVO` behaviour is unchanged; nothing is appended to the visible window.
- Log-audit gate: every new log line emits ids truncated to 8 chars and a count. **No emoji, no
  body, no key bytes** — `packages/messenger-core/__tests__/logAudit.test.ts` must stay green.
- Security: no check weakened. The M-07 blocked-peer gate still runs _before_ `applyReaction` at both
  call sites and is re-applied at drain time (strictly stronger). `verifySenderCert` /
  `verifySealedAad` / the B-42 epoch guard are untouched — a stashed reaction was already fully
  verified before it reached `applyReaction`.

## Tests

Jest project **`messenger-crypto`** (`src/modules/messenger/__tests__/**/*.test.ts`), which is what
`npm run test:crypto` runs.

**NEW `src/modules/messenger/__tests__/reactionMerge.test.ts`** (pure):

- add: `mergeReaction(undefined, 'u1', '👍', false)` → `{u1: '👍'}`.
- replace: `mergeReaction({u1: '👍'}, 'u1', '❤️', false)` → `{u1: '❤️'}` (one emoji per reactor).
- remove: `mergeReaction({u1: '👍', u2: '🎉'}, 'u1', '👍', true)` → `{u2: '🎉'}`.
- idempotent replay: applying the same patch twice equals applying it once.
- purity: the input object is not mutated.

**NEW `src/modules/messenger/__tests__/pendingReactionStore.test.ts`** — copy the in-memory
`makeMockDb()` harness shape from `pendingGroupEnvelopeStore.test.ts` (it emulates exactly the SQL
the store emits; teach it the new statements):

- `stash` then `listForTarget` returns the row with `removed` round-tripped as a boolean.
- same `(conversationId, targetMsgId, fromUserId)` stashed twice → **one** row, newest emoji wins.
- different `fromUserId` on the same target → two rows.
- `PENDING_REACTION_MAX_PER_CONVERSATION + 1` stashes in one conversation → size caps at 256 and the
  **oldest** `received_at_ms` was evicted.
- global cap evicts across conversations.
- `prune(now)` deletes rows older than `PENDING_REACTIONS_RETENTION_MS` and keeps a row at
  `now - RETENTION_MS + 1`.
- `deleteForTarget` removes only that target's rows.

**NEW `src/modules/messenger/__tests__/pendingReactionApply.test.ts`** — the behavioural core. Drive
`applyReaction` / `drainPendingReactionsFor` against the real `useMessengerStore` plus a fake
`SqlMessageStore` (a `{upsert, upsertCoalesced, findReactionTarget}` stub — follow the dependency
style already used by `appendMessageDedup.test.ts` / `blockedPeersAndTombstones.test.ts`). Export
the two functions from `productionRuntime.ts` for the test, or extract them into
`runtime/pendingReactionApply.ts` if the export surface is objectionable (preferred if review pushes
back — it also makes the module importable without pulling the whole runtime).

- **M1 regression (the finding):** target absent everywhere → `applyReaction` writes a stash row and
  the store is unchanged; then append the target + `drainPendingReactionsFor` → the store message
  now carries `{peerA: '👍'}`, `sqlMessages.upsert` was called with that map, and the stash is empty.
- **M2 regression:** target absent from the store but returned by `findReactionTarget` →
  `sqlMessages.upsert` called with the merged map, store untouched, **no** stash row written.
- **M3 regression:** target present in the store → both `updateMessageReactions` **and**
  `upsertCoalesced` fire (assert the persisted row's `reactions`). This is the assertion that fails
  on today's code.
- Blocked peer at drain time (`isPeerBlocked` mocked true) → that reactor's emoji is not merged, the
  rest are, and the stash row is still deleted.
- `remove: true` stashed before the target arrives → drains to a map without that reactor.
- Null-store safety: `sqlMessages = null` and `pendingReactionsStore = null` → no throw.

**Existing suites to re-run (regression gate, CLAUDE.md §Change safety 2 + 4):**

- `npm run test:crypto` (whole `messenger-crypto` project) — mandatory: this touches the receive
  path and SQLCipher schema.
- Specifically watch `receiveTransaction.test.ts`, `appendMessageDedup.test.ts`,
  `blockedPeersAndTombstones.test.ts`, `bootGroupStashDrain.test.ts`, `groupInboundBody.test.ts`,
  `sqlMessageStoreResend.test.ts`, `firstMessageDrop.test.ts`.
- **BACKUP_LOOP §4** (schema + message write path): `backupMerkle.test.ts`,
  `messageMirrorMerkleFlush.test.ts`, `mirrorLedgerBootSweep.test.ts`, `backupRepairCommit.test.ts`,
  then the full crypto project.
- `packages/messenger-core/__tests__/logAudit.test.ts` (new log lines).
- `npm run typecheck` — must stay ≤ the `.tsc-baseline.json` count (47).
- Device probe (cannot be done in this environment — say so if skipped): two devices, react to a
  message, **force-stop and relaunch both** → the reaction chip must still be there. That is the M3
  proof and no unit test substitutes for it.

## Risk

1. **The module-level `pendingReactionsStore` singleton is the reviewer's first target.** It is a
   deliberate trade against ~14 signature edits, and it follows the file's existing
   `drainOutboxInflight` precedent, but it _is_ cross-runtime state. Verify: the `liveDisposers`
   entry actually nulls it on logout→login, and no path calls `applyReaction` between
   `disposeLiveRuntime` and the next assignment (worst case it degrades to today's silent drop, not
   to writing into the previous user's DB — but confirm that, don't assume it). If the reviewer
   objects, the alternative is honest plumbing through `doHandleIncoming`.
2. **`await` inside the ratchet transaction.** `drainPendingReactionsFor` awaits
   `sqlMessages.upsert` (per-conversation `chainOp`) from inside `runWithRatchetTxn`. B-75 was
   exactly a self-deadlock of this shape. The existing `:7255`/`:7320` upserts already do it, so the
   pattern is sanctioned — but the drain adds a **second** awaited chained op in the same txn.
   Re-read `chainOp` before merging.
3. **Scope creep vs the audit text.** The audit asked for a stash. This spec also adds persistence
   (M3) and an off-window SQL lookup (M2). That is more code than "small pending-reactions stash".
   The defence: a stash alone is provably useless — it replays into state that is discarded on the
   next boot. If the reviewer wants the smallest possible increment, **M3 alone** (two lines:
   `upsertCoalesced` in `applyReaction`, `upsertCoalesced` in the local echo) is the highest
   value-per-line change in the whole finding and can ship first; the stash is the follow-up.
4. **Part (b) belongs to OM-01.** If both land, `sendReaction` gets two independent edits. Confirm
   the reaction outbox row is _not_ touched by this diff.
5. **Schema bump collides.** v15 is a shared resource across this audit batch; whoever lands second
   must renumber and re-check both migration branches.
6. **Emoji at rest in a new table.** Same class as `messages.reactions_json`, same SQLCipher file,
   no new exposure. Wipe looks safe: no code outside `pendingGroupEnvelopeStore.ts` / `crypto/db.ts`
   names `pending_group_envelopes`, and `runtime/keychain.ts:24` lists it as part of the compartment
   whose key is destroyed on wipe — i.e. the wipe is file/key-scoped, not a per-table enumeration,
   so a new table is covered automatically. **Confirm against `wipeAtRest.test.ts` anyway** — if a
   per-table list turns up, `pending_reactions` must join it or a wiped account leaves reaction
   fragments behind.
7. **Unresolvable stash rows linger 30 days.** If a target genuinely never arrives (sender's outbox
   went terminal-failed), the row sits until prune. Bounded by the caps, invisible to the user,
   acceptable — but a reviewer may prefer 7 days. Do **not** shorten below the relay dwell without
   re-reading the `GROUP-STASH-7DAY-PRUNE-PERMALOSS` note in `pendingGroupEnvelopeStore.ts:31-40`.
