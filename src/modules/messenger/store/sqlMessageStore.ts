/**
 * SQLCipher-backed message store.
 *
 * Spec compliance: per Bravo Secure architecture v1.0 R1 §2.2 the
 * client-side message store is "SQLCipher-encrypted local SQLite
 * database. Message keys are derived per-session and stored separately
 * from message ciphertext." This module owns the messages table inside
 * the same SQLCipher DB that holds Signal Protocol session state, with
 * page-level encryption from a hardware-bound key (keychain).
 *
 * The Zustand store remains the read path for the UI (fast in-memory
 * lookup); this store is the durable write path. On boot the runtime
 * loads everything here back into Zustand. Every mutation that flows
 * through messengerStore also fans out here via a subscribe-based
 * mirror in productionRuntime.
 *
 * Schema lives in `crypto/db.ts` (messages table + indexes). Bumping
 * the columns here requires bumping SCHEMA_VERSION in db.ts.
 */

import type {DbHandle} from '../crypto/db';
import type {LocalMessage} from './types';
import {runWithRatchetTxn} from '../runtime/receiveTransaction';

/** Row shape — wire format for reading from SQLite. */
interface MessageRow {
  id:               string;
  conversation_id:  string;
  sender_id:        string;
  type:             string;
  content:          string | null;
  media_mime:       string | null;
  media_object_key: string | null;
  media_key:        string | null;
  media_iv:         string | null;
  status:           string;
  is_encrypted:     number;
  created_at:       string;
  peer_user_id:     string;
  peer_device_id:   number;
  envelope_id:      string | null;
  retract_token:    string | null;
  expires_at:       number | null;
  reply_to_msg_id:  string | null;
  reply_to_preview: string | null;
  reactions_json:   string | null;
  call_meta_json:   string | null;
  media_meta_json:  string | null;
  envelope_ids_json: string | null;
  receipts_json:     string | null;
  retract_tokens_json: string | null;
  undeliverable_legs_json: string | null;
  mentions_json:     string | null;
  edited_at:         number | null;
  deleted_for_all:   number | null;
  is_forwarded:      number | null;
}

/**
 * B-636 — how many conversation ids one `IN (…)` may name.
 *
 * SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 999 and `searchContent`
 * binds three more parameters alongside the ids. 400 leaves that headroom
 * untouched while keeping the common tenant (tens of channels) to one
 * statement.
 */
const SEARCH_ID_CHUNK = 400;

/**
 * B-636 — neutralise the wildcards SQL `LIKE` understands, so a query is
 * matched as the literal text the user typed.
 *
 * The backslash is escaped FIRST; escaping it after `%`/`_` would re-escape the
 * backslashes this function had just introduced. Pairs with `ESCAPE '\'` in the
 * statement — a pattern escaped without that clause matches the backslashes
 * themselves.
 */
function escapeLikeTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/[%_]/g, m => `\\${m}`);
}

/** Newest-first, tie-broken by id — the SQL `ORDER BY` expressed in JS, for
 *  merging pages that came from separate statements. `created_at` is an ISO
 *  string, so lexicographic order IS chronological order. */
function newestFirst(a: LocalMessage, b: LocalMessage): number {
  if (a.created_at !== b.created_at) {return a.created_at < b.created_at ? 1 : -1;}
  if (a.id === b.id) {return 0;}
  return a.id < b.id ? 1 : -1;
}

export class SqlMessageStore {
  constructor(private readonly db: DbHandle) {}

  /**
   * Audit fix #18 — per-conversation Promise chain.
   *
   * The runtime's store→SQL subscriber issues `upsert` and `remove`
   * calls based on diffs between consecutive Zustand snapshots. When
   * the user clears a chat, the diff produces a burst of DELETEs; if
   * any subsequent message arrives WHILE those DELETEs are still
   * inflight, the inserts could land before the deletes (op-sqlite
   * dispatches awaits independently) and the cleared messages would
   * resurrect after the DELETE finally runs. Serialising every write
   * for one conversation through a Promise chain keeps DELETEs and
   * UPSERTs in the order the subscriber emitted them. Different
   * conversations still parallelise.
   */
  private readonly chains = new Map<string, Promise<unknown>>();

  /**
   * Audit fix #19 — coalesce upserts within a 50ms window.
   *
   * `upsert` was autocommit per call, so a chat-message burst (10
   * messages in one second) cost 10 BEGIN/COMMIT cycles, each with an
   * fsync. The `upsertCoalesced` path queues writes per conversation
   * into a window-flush list and ships them via `writeRows` under the
   * per-conversation chain — with no transaction of its own (B-130; it
   * used to use `upsertBatch`, which deadlocked against the receive txn).
   * For correctness, the in-window queue dedupes by id — the latest
   * version of each row wins.
   */
  private readonly coalesceQueues = new Map<string, Map<string, LocalMessage>>();
  private readonly coalesceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly COALESCE_WINDOW_MS = 50;

  private chainOp<T>(conversationId: string, work: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(conversationId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => work());
    this.chains.set(conversationId, next);
    // AUDIT #14 (latent, surfaced by the envelope-unique throw): the old
    // `void next.finally(...)` re-raised any rejection on this DISCARDED
    // bookkeeping branch — an unhandled rejection even when the caller
    // correctly awaited/caught `next`. Handle both settle paths here.
    const dropHead = (): void => {
      // Drop only if we're still the head of the chain.
      if (this.chains.get(conversationId) === next) {
        this.chains.delete(conversationId);
      }
    };
    void next.then(dropHead, dropHead);
    return next;
  }

  async upsert(msg: LocalMessage): Promise<void> {
    return this.chainOp(msg.conversation_id, () => this.doUpsert(msg));
  }

  /**
   * Audit fix #19 — coalesce-batch upsert. Drops the message into a
   * 50ms window keyed by conversation; flushes via upsertBatch (one
   * BEGIN/COMMIT) when the timer fires. Returns immediately — caller
   * doesn't await durability for non-critical updates (status flips,
   * reactions).
   */
  upsertCoalesced(msg: LocalMessage): void {
    const cid = msg.conversation_id;
    let q = this.coalesceQueues.get(cid);
    if (!q) {q = new Map(); this.coalesceQueues.set(cid, q);}
    q.set(msg.id, msg); // dedupe — newest wins
    if (this.coalesceTimers.has(cid)) {return;}
    this.coalesceTimers.set(cid, setTimeout(() => {
      const queue = this.coalesceQueues.get(cid);
      this.coalesceTimers.delete(cid);
      this.coalesceQueues.delete(cid);
      if (!queue?.size) {return;}
      const batch = Array.from(queue.values());
      // Why (B-130 — burst-receive stall): this flush holds THIS conversation's
      // chain (lock B). It must NOT call upsertBatch, which awaits the global
      // txn chain (lock A): the receive path holds A (runWithRatchetTxn around
      // doHandleIncoming) and then awaits B (`await sqlMessages.upsert(...)`),
      // so the two orders form a circular wait. Nothing throws — the receive
      // txn's `await work()` never settles, so COMMIT, ROLLBACK and the
      // `finally` that clears the open-txn flag never run, txnChain is dead for
      // the process lifetime, and the envelope is never acked. Symptom: a burst
      // of messages half-delivers, then the app silently stops receiving until
      // restart. Raw writes join whatever txn is open; batch atomicity is not
      // owed here (status flips, reactions, envelope-id/media patches only —
      // new inbound rows go through the receive txn, not this path).
      void this.chainOp(cid, () => this.writeRows(batch)).catch(e => {
        console.warn('[sqlMessageStore] coalesced flush failed', e);
      });
    }, SqlMessageStore.COALESCE_WINDOW_MS));
  }

  private async doUpsert(msg: LocalMessage): Promise<void> {
    const reactions = msg.reactions ? JSON.stringify(msg.reactions) : null;
    const callMeta  = msg.call_meta ? JSON.stringify(msg.call_meta) : null;
    const mediaMeta = msg.media_meta ? JSON.stringify(msg.media_meta) : null;
    const envIds    = msg.envelope_ids ? JSON.stringify(msg.envelope_ids) : null;
    const receipts  = msg.receipts ? JSON.stringify(msg.receipts) : null;
    const retractTokens = msg.retract_tokens ? JSON.stringify(msg.retract_tokens) : null;
    const undelivLegs = msg.undeliverable_legs ? JSON.stringify(msg.undeliverable_legs) : null;
    const mentions  = msg.mentions?.length ? JSON.stringify(msg.mentions) : null;
    // AUDIT #14 — ON CONFLICT targeted at the PK, never OR REPLACE: with
    // the unique envelope_id index, OR REPLACE would resolve an
    // envelope-id collision by DELETING the original row (reactions,
    // receipts, retract tokens gone) and inserting the redelivered copy
    // under a new id. The targeted form updates in place on a PK match
    // and THROWS on an envelope-id collision — surfacing the app-layer
    // dedup failure instead of silently absorbing it.
    await this.db.execute(
      `INSERT INTO messages (
         id, conversation_id, sender_id, type, content, media_mime, media_object_key,
         media_key, media_iv,
         status, is_encrypted, created_at,
         peer_user_id, peer_device_id, envelope_id, retract_token,
         expires_at, reply_to_msg_id, reply_to_preview, reactions_json, call_meta_json,
         media_meta_json, envelope_ids_json, receipts_json, retract_tokens_json,
         undeliverable_legs_json,
         mentions_json, edited_at, deleted_for_all, is_forwarded
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(conversation_id, id) DO UPDATE SET
         sender_id = excluded.sender_id, type = excluded.type,
         content = excluded.content, media_mime = excluded.media_mime,
         media_object_key = excluded.media_object_key,
         media_key = excluded.media_key, media_iv = excluded.media_iv,
         status = excluded.status, is_encrypted = excluded.is_encrypted,
         created_at = excluded.created_at,
         peer_user_id = excluded.peer_user_id, peer_device_id = excluded.peer_device_id,
         envelope_id = excluded.envelope_id, retract_token = excluded.retract_token,
         expires_at = excluded.expires_at,
         reply_to_msg_id = excluded.reply_to_msg_id, reply_to_preview = excluded.reply_to_preview,
         reactions_json = excluded.reactions_json, call_meta_json = excluded.call_meta_json,
         media_meta_json = excluded.media_meta_json,
         envelope_ids_json = excluded.envelope_ids_json, receipts_json = excluded.receipts_json,
         retract_tokens_json = excluded.retract_tokens_json,
         undeliverable_legs_json = excluded.undeliverable_legs_json,
         mentions_json = excluded.mentions_json, edited_at = excluded.edited_at,
         deleted_for_all = excluded.deleted_for_all, is_forwarded = excluded.is_forwarded`,
      [
        msg.id,
        msg.conversation_id,
        msg.sender_id,
        msg.type,
        msg.content ?? null,
        msg.media_mime ?? null,
        msg.media_object_key ?? null,
        msg.media_key ?? null,
        msg.media_iv ?? null,
        msg.status,
        msg.is_encrypted ? 1 : 0,
        msg.created_at,
        msg.peer.userId,
        msg.peer.deviceId,
        msg.envelope_id ?? null,
        msg.retract_token ?? null,
        msg.expires_at ?? null,
        msg.reply_to_msg_id ?? null,
        msg.reply_to_preview ?? null,
        reactions,
        callMeta,
        mediaMeta,
        envIds,
        receipts,
        retractTokens,
        undelivLegs,
        mentions,
        msg.edited_at ?? null,
        msg.deleted_for_all ? 1 : null,
        msg.is_forwarded ? 1 : null,
      ],
    );
  }

  /**
   * MI-06 — per-conversation composer draft. Empty/whitespace content
   * deletes the row (a cleared composer must not resurrect old text).
   * Not chained through chainOp: drafts never interact with message-row
   * ordering, and a keystroke-debounced write must not queue behind a
   * clear-conversation DELETE burst.
   */
  async setDraft(conversationId: string, content: string): Promise<void> {
    if (content.trim()) {
      await this.db.execute(
        'INSERT OR REPLACE INTO drafts (conversation_id, content, updated_at) VALUES (?,?,?)',
        [conversationId, content, Date.now()],
      );
    } else {
      await this.db.execute('DELETE FROM drafts WHERE conversation_id = ?', [conversationId]);
    }
  }

  /** MI-06 — boot hydrate: every persisted draft, keyed by conversation. */
  async loadDrafts(): Promise<Record<string, string>> {
    const res = await this.db.execute('SELECT conversation_id, content FROM drafts');
    const out: Record<string, string> = {};
    for (const r of (res.rows ?? []) as Array<{conversation_id: string; content: string}>) {
      if (r.conversation_id && r.content) {out[r.conversation_id] = r.content;}
    }
    return out;
  }

  async remove(conversationId: string, id: string): Promise<void> {
    return this.chainOp(conversationId, async () => {
      await this.db.execute(
        'DELETE FROM messages WHERE conversation_id = ? AND id = ?',
        [conversationId, id],
      );
    });
  }

  /**
   * B-124 — drop every persisted row for one conversation. Used by the
   * call-contamination boot sweep so a purged ghost thread doesn't keep
   * rehydrating orphan rows forever. Serialised through the same
   * per-conversation chain as upsert/remove.
   */
  async deleteByConversation(conversationId: string): Promise<void> {
    return this.chainOp(conversationId, async () => {
      await this.db.execute(
        'DELETE FROM messages WHERE conversation_id = ?',
        [conversationId],
      );
    });
  }

  /**
   * B-206 — move every persisted row from one conversation id to another.
   *
   * A department channel's group id is re-minted when its owner "reactivates"
   * a keyless channel (resetGroup + a fresh createGroupChat). The message
   * BODIES are stored plaintext and never move, so nothing is lost — but they
   * stay filed under the OLD id while every device now navigates to the NEW id,
   * so the whole history looks like it vanished. This remaps the rows so the
   * history follows the channel to its new id.
   *
   * `UPDATE OR IGNORE` first (the PK is (conversation_id, id), so a row whose id
   * already exists under the new id is left alone), then drop any leftovers that
   * couldn't move because a same-id row already exists under the new id — those
   * are duplicates, safe to delete. Idempotent: a second call finds no old rows.
   */
  async remapConversation(oldId: string, newId: string): Promise<void> {
    if (!oldId || !newId || oldId === newId) {return;}
    return this.chainOp(oldId, async () => {
      await this.db.execute(
        'UPDATE OR IGNORE messages SET conversation_id = ? WHERE conversation_id = ?',
        [newId, oldId],
      );
      await this.db.execute(
        'DELETE FROM messages WHERE conversation_id = ?',
        [oldId],
      );
    });
  }

  /**
   * Load every persisted message into a `Record<conversationId, msgs[]>`.
   * Called once at runtime boot. Sorted by created_at ascending so the
   * UI can paint history in chronological order without a re-sort.
   *
   * NOTE: prefer `loadRecent(perConversation)` for the boot path —
   * `loadAll` is kept for back-compat with the migration import flow.
   */
  async loadAll(): Promise<Record<string, LocalMessage[]>> {
    // Audit P1-N20 — tie-break on `id` so two messages stamped with
    // the same millisecond (rapid-fire send, clock-skew on receive) get
    // a deterministic, stable order across loads instead of flipping
    // every time SQLite picks a different physical-row scan order.
    const result = await this.db.execute(
      'SELECT * FROM messages ORDER BY conversation_id, created_at ASC, id ASC',
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    const out: Record<string, LocalMessage[]> = {};
    for (const r of rows) {
      const msg = rowToMessage(r);
      if (!out[msg.conversation_id]) {out[msg.conversation_id] = [];}
      out[msg.conversation_id].push(msg);
    }
    return out;
  }

  /**
   * Audit fix #16 — load only the N most-recent messages per conversation.
   *
   * Implementation uses a window-function-style ROW_NUMBER inside a CTE
   * so we don't have to round-trip per conversation. Rows come back
   * already filtered to `<= perConversation` per chat, ordered ascending
   * inside each conversation so the renderer doesn't re-sort.
   */
  async loadRecent(perConversation: number): Promise<Record<string, LocalMessage[]>> {
    if (perConversation <= 0) {return {};}
    // Audit MSG-14 (2026-07-02): hard-purge disappearing messages whose
    // deadline has passed BEFORE hydrating. The in-memory ExpirySweeper only
    // walks the ~200 rows currently in the store, so a timed message that was
    // pushed past the recent window before it expired lingered on disk — it
    // would briefly flash on scroll-back (until the sweeper caught it) and its
    // relay-retract could fire days late. Deleting at boot closes that.
    try {
      await this.db.execute(
        'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?',
        [Date.now()],
      );
    } catch { /* best-effort — hydration proceeds either way */ }
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (
               PARTITION BY conversation_id
               ORDER BY created_at DESC, id DESC
             ) AS rn
             FROM messages
           )
           WHERE rn <= ?
         )
         ORDER BY conversation_id, created_at ASC, id ASC`,
      [perConversation],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    const out: Record<string, LocalMessage[]> = {};
    for (const r of rows) {
      const msg = rowToMessage(r);
      if (!out[msg.conversation_id]) {out[msg.conversation_id] = [];}
      out[msg.conversation_id].push(msg);
    }
    return out;
  }

  /**
   * Audit fix #16 — load a page of OLDER messages for one conversation.
   * `before` is the ISO timestamp of the oldest already-rendered row;
   * we return the next `limit` rows strictly older than it. Tied to a
   * stable cursor on `(created_at, id)` so duplicate timestamps don't
   * skip rows. Returns ascending (oldest-first) so the UI can prepend.
   */
  async loadOlder(
    conversationId: string,
    before: string,
    beforeId: string,
    limit: number,
  ): Promise<LocalMessage[]> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE conversation_id = ?
           AND (
             created_at < ?
             OR (created_at = ? AND id < ?)
           )
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      [conversationId, before, before, beforeId, Date.now(), limit],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage).reverse();
  }

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

  /**
   * B-90 T-04 — WhatsApp-parity "Links" browser. Pages text messages whose
   * decrypted body contains an http(s) URL, newest-first, across ALL
   * conversations. The relay can't index links (bodies are sealed), so this
   * local scan is the only possible source. The LIKE is a cheap prefilter —
   * exact URL extraction happens in the UI with the shared URL regex.
   * Read-only; expired disappearing messages are excluded, mirroring
   * loadOlder.
   */
  async loadLinkMessages(limit: number, offset = 0): Promise<LocalMessage[]> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE type = 'text'
           AND content LIKE '%http%'
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      [Date.now(), limit, offset],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * B-636 (client, 2026-08-23) — "this search option should allow you to also
   * search for conversations or words in conversations that's inside the chats."
   *
   * Substring search over decrypted message BODIES, newest-first, scoped to an
   * explicit conversation-id allow-list. Exactly like `loadLinkMessages` above:
   * the relay only ever holds ciphertext, so a server-side index cannot exist
   * and this local scan is the only possible source.
   *
   * ── THE ALLOW-LIST IS THE SCOPE BOUNDARY, not a filter applied afterwards ──
   *
   * The caller passes the conversation ids of the channels IT is already
   * showing, and those are organisation-scoped upstream (B-624). So a query
   * typed on the Channels tab can never surface another organisation's message,
   * and never a 1:1. An EMPTY array therefore means "nothing is in scope" and
   * returns nothing — it must never be read as "no filter", which is how a
   * scoped query quietly becomes a global one.
   *
   * ── LIKE WILDCARDS IN THE USER'S OWN TEXT ARE ESCAPED ─────────────────────
   *
   * Without that a typed `%` matches every message and `_` matches any single
   * character: a wrong result AND an unbounded scan. `loadLinkMessages` needed
   * no escaping because its pattern is a literal; this one is user input.
   *
   * Excludes the rows the thread itself hides: expired disappearing messages
   * (mirroring `loadOlder`/`loadLinkMessages`) and delete-for-everyone
   * tombstones. `messageMutationApply` already blanks a tombstone's body, so
   * the second exclusion is depth rather than the only defence — but a search
   * that could resurrect deleted text is precisely the class this repo has
   * shipped before (B-594/B-605), so it is asserted rather than assumed.
   */
  async searchContent(
    query: string,
    opts: {conversationIds: readonly string[]; limit: number},
  ): Promise<LocalMessage[]> {
    const term = query.trim();
    if (!term || opts.limit <= 0) {return [];}
    const ids = opts.conversationIds;
    if (ids.length === 0) {return [];}

    const pattern = `%${escapeLikeTerm(term)}%`;
    const now = Date.now();
    const out: LocalMessage[] = [];
    // SQLite caps bound parameters (999 by default), so a tenant with more
    // channels than one statement can name is CHUNKED rather than truncated.
    // Each chunk is complete within its own id set, so merging their
    // newest-first pages and re-cutting to `limit` gives the same answer a
    // single statement would have.
    for (let i = 0; i < ids.length; i += SEARCH_ID_CHUNK) {
      const chunk = ids.slice(i, i + SEARCH_ID_CHUNK);
      const placeholders = chunk.map(() => '?').join(',');
      const result = await this.db.execute(
        `SELECT * FROM messages
           WHERE conversation_id IN (${placeholders})
             AND type = 'text'
             AND content LIKE ? ESCAPE '\\'
             AND (expires_at IS NULL OR expires_at > ?)
             AND (deleted_for_all IS NULL OR deleted_for_all = 0)
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
        [...chunk, pattern, now, opts.limit],
      );
      const rows = (result.rows ?? []) as unknown as MessageRow[];
      for (const r of rows) {out.push(rowToMessage(r));}
    }
    // A SINGLE chunk is already in the statement's own `ORDER BY`. Two or more
    // are N separately-ordered pages concatenated, so the merge is needed for
    // ANY multi-chunk read — gating it on "did we exceed the cap" instead
    // returned chunk order whenever the total happened to fit, which is the
    // common case, not the rare one.
    if (ids.length > SEARCH_ID_CHUNK) {out.sort(newestFirst);}
    return out.length > opts.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * Signal resend protocol — recent still-undelivered outbound 1:1 TEXT
   * messages for a conversation, newest-first, capped. Used to re-transmit
   * after a peer signals it rebuilt its session (i.e. couldn't decrypt what we
   * sent). Scoped to `status='sent'` (accepted by the relay but not yet
   * `delivered`/`read`) and `type='text'` (attachments need a media re-grant,
   * out of scope for the resend).
   */
  async recentUndeliveredSelfText(
    conversationId: string,
    sinceIso: string,
    limit: number,
  ): Promise<LocalMessage[]> {
    const result = await this.db.execute(
      `SELECT * FROM messages
         WHERE conversation_id = ?
           AND sender_id = 'self'
           AND status = 'sent'
           AND type = 'text'
           AND created_at >= ?
         ORDER BY created_at DESC
         LIMIT ?`,
      [conversationId, sinceIso, limit],
    );
    const rows = (result.rows ?? []) as unknown as MessageRow[];
    return rows.map(rowToMessage);
  }

  /**
   * Bulk import — used during the AsyncStorage → SQLCipher migration
   * and from the audit-fix #19 coalesced-upsert path. Calls the raw
   * `doUpsert` directly so the per-conversation chain isn't re-entered
   * (which would deadlock against the chain that's currently holding
   * the lock for this call).
   */
  /**
   * Raw sequential row writes: NO transaction of its own, NO chain
   * acquisition. If a transaction is already open on this connection the
   * statements simply join it.
   *
   * Exists so the coalesced flush can write while holding the
   * per-conversation chain WITHOUT reaching for the global txn chain — see
   * B-130 in `upsertCoalesced`.
   */
  private async writeRows(
    messages: LocalMessage[],
    // AUDIT #12 — cooperative abort: when this batch rides a
    // runWithRatchetTxn frame and the watchdog force-advances past it,
    // every remaining row would otherwise write INTO a later frame's
    // open transaction. Optional: the coalesced-flush path (chainOp, no
    // frame) passes nothing and is unaffected.
    frame?: import('../runtime/receiveTransaction').RatchetTxnFrame,
  ): Promise<number> {
    // AUDIT #14 (critic) — the skip must be COUNTABLE, not just logged:
    // the restore folds this into its completion tally, otherwise
    // "restore succeeded" and "some rows silently absent" read identically.
    let envelopeDupsSkipped = 0;
    for (const m of messages) {
      frame?.assertLive();
      try {
        await this.doUpsert(m);
      } catch (e) {
        // AUDIT #14 — batch contexts (restore ingestion, status flush,
        // coalesced patches) may legitimately carry a row for an envelope
        // that already has one: the server mirror can hold PRE-FIX
        // duplicates, and a restore must not fail permanently on them.
        // Skipping is the correct semantics (that envelope IS persisted);
        // everything else rethrows. The receive txn's direct upsert path
        // deliberately does NOT get this tolerance — there, a collision
        // means the seen-gate failed and the terminal throw is the DESIRED
        // outcome (the dup envelope is destroyed; the original survives).
        const msg = (e as Error).message ?? '';
        if (/UNIQUE constraint failed/i.test(msg) && /envelope/i.test(msg)) {
          envelopeDupsSkipped += 1;
          console.warn('[sqlMessageStore] duplicate-envelope row skipped in batch:', m.id, m.envelope_id?.slice(0, 8));
          continue;
        }
        throw e;
      }
    }
    return envelopeDupsSkipped;
  }

  /** @returns the number of duplicate-envelope rows skipped (AUDIT #14). */
  async upsertBatch(messages: LocalMessage[]): Promise<number> {
    if (messages.length === 0) {return 0;}
    // M-14 — serialize the explicit BEGIN/COMMIT across ALL
    // SqlMessageStore instances that share this op-sqlite connection (the
    // restore path constructs its OWN instance while the live coalesced-
    // flush path uses the runtime's; the per-instance `chains` map does
    // NOT serialize across instances).
    //
    // Audit P0-1 (2026-07-09) — the M-14 fix used a store-local static
    // mutex, which serialized upsertBatch against ITSELF but not against
    // the receive transaction (`runWithRatchetTxn`) on the SAME SQLCipher
    // connection. A receive `BEGIN IMMEDIATE` landing inside an open
    // flush txn threw "cannot start a transaction within a transaction",
    // the catch-all classified it terminal, and the relay ack-`discarded`
    // (destroyed) a committed inbound message. Funnel the flush through
    // the ONE per-connection exclusive-txn runner instead: it chains on
    // the same module-level mutex as every receive txn, opens
    // BEGIN IMMEDIATE, commits/rolls back, and flags isInsideRatchetTxn()
    // so nested writers (sqlCipherStore.saveIdentity) skip their own
    // BEGIN — exactly the awareness the receive txn already has.
    //
    // MERGE (B-130 + B-126): both sides fixed the burst stall and BOTH are kept.
    //
    // B-130 INVARIANT (the cause): upsertBatch takes the GLOBAL txn chain. NEVER
    // call it from inside `chainOp` — the receive path takes the txn chain FIRST
    // and the per-conversation chain SECOND, so a chainOp -> txnChain call is an
    // AB-BA inversion that freezes both chains for the process lifetime. The
    // coalesced flush calls `writeRows()` directly for exactly that reason.
    //
    // B-126 (the backstop): the `statusFlush:N` label lets the receive-chain
    // watchdog NAME this frame if it ever wedges from some other cause. Removing
    // the deadlock and still labelling the frame are complementary — the label
    // costs nothing and this bug family has now recurred five times.
    return runWithRatchetTxn(this.db, (frame) => this.writeRows(messages, frame), `statusFlush:${messages.length}`);
  }

  /**
   * Drop every message in the messages table. Used by the destructive
   * "wipe identity" flow alongside `IndexedDBProtocolStore.wipe()` /
   * `SqlCipherProtocolStore.wipe()`.
   */
  async wipe(): Promise<void> {
    await this.db.execute('DELETE FROM messages');
  }
}

function rowToMessage(r: MessageRow): LocalMessage {
  return {
    id:               r.id,
    conversation_id:  r.conversation_id,
    sender_id:        r.sender_id,
    type:             r.type as LocalMessage['type'],
    content:          r.content ?? '',
    media_mime:       r.media_mime ?? undefined,
    media_object_key: r.media_object_key ?? undefined,
    media_key:        r.media_key ?? undefined,
    media_iv:         r.media_iv ?? undefined,
    status:           r.status as LocalMessage['status'],
    is_encrypted:     r.is_encrypted === 1,
    created_at:       r.created_at,
    peer:             {userId: r.peer_user_id, deviceId: r.peer_device_id},
    envelope_id:      r.envelope_id ?? undefined,
    retract_token:    r.retract_token ?? undefined,
    expires_at:       r.expires_at ?? undefined,
    reply_to_msg_id:  r.reply_to_msg_id ?? undefined,
    reply_to_preview: r.reply_to_preview ?? undefined,
    reactions:        r.reactions_json ? safeJson(r.reactions_json) : undefined,
    call_meta:        r.call_meta_json ? safeJsonCallMeta(r.call_meta_json) : undefined,
    media_meta:       r.media_meta_json ? safeJsonMediaMeta(r.media_meta_json) : undefined,
    envelope_ids:     r.envelope_ids_json ? safeJson(r.envelope_ids_json) : undefined,
    receipts:         r.receipts_json ? safeJsonReceipts(r.receipts_json) : undefined,
    retract_tokens:   r.retract_tokens_json ? safeJson(r.retract_tokens_json) : undefined,
    undeliverable_legs: r.undeliverable_legs_json ? safeJsonUndeliverableLegs(r.undeliverable_legs_json) : undefined,
    is_forwarded:     r.is_forwarded ? true : undefined,
    mentions:         r.mentions_json ? safeJsonMentions(r.mentions_json) : undefined,
    edited_at:        r.edited_at ?? undefined,
    deleted_for_all:  r.deleted_for_all === 1 ? true : undefined,
  };
}

function safeJson(s: string): Record<string, string> | undefined {
  try { return JSON.parse(s) as Record<string, string>; }
  catch { return undefined; }
}

function safeJsonCallMeta(s: string): LocalMessage['call_meta'] {
  try { return JSON.parse(s) as LocalMessage['call_meta']; }
  catch { return undefined; }
}

function safeJsonMediaMeta(s: string): LocalMessage['media_meta'] {
  try { return JSON.parse(s) as LocalMessage['media_meta']; }
  catch { return undefined; }
}

function safeJsonReceipts(s: string): LocalMessage['receipts'] {
  try { return JSON.parse(s) as LocalMessage['receipts']; }
  catch { return undefined; }
}

function safeJsonUndeliverableLegs(s: string): LocalMessage['undeliverable_legs'] {
  try { return JSON.parse(s) as LocalMessage['undeliverable_legs']; }
  catch { return undefined; }
}

/**
 * Mentions come back as an ARRAY, unlike every other JSON column here, so the
 * shared `safeJson` (typed `Record<string, string>`) would hand the renderer a
 * value whose `.map` exists but whose entries are unchecked. Validate the shape
 * on the way out of disk: a hand-edited or partially-written row must degrade
 * to "no mentions", never to a crash inside the bubble renderer.
 */
function safeJsonMentions(s: string): LocalMessage['mentions'] {
  try {
    const parsed = JSON.parse(s) as unknown;
    if (!Array.isArray(parsed)) {return undefined;}
    const out = parsed.filter(
      (m): m is {userId: string; label: string} =>
        !!m && typeof m === 'object' &&
        typeof (m as {userId?: unknown}).userId === 'string' &&
        typeof (m as {label?: unknown}).label === 'string',
    );
    return out.length ? out : undefined;
  } catch { return undefined; }
}
