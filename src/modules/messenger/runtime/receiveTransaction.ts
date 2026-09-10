/**
 * Audit P0-N14 — atomic ratchet+plaintext writes.
 *
 * The receive path runs:
 *   1. own.decrypt(peer, ct)          → libsignal advances ratchet,
 *                                        writes new session row via
 *                                        storeSession (one SQL stmt)
 *   2. parse / verify cert / AAD / expiry
 *   3. sqlMessages.upsert(localMsg)   → writes plaintext row (another
 *                                        SQL stmt on the SAME DbHandle)
 *
 * Each step is autocommit. A crash between 1 and 3 advances the ratchet
 * without persisting the plaintext — the next time the relay redelivers
 * the SAME ciphertext (which it WILL, because we ack only after step 3),
 * libsignal throws "bad MAC" because the message key already burned.
 *
 * Fix: wrap the entire receive critical section in a single SQLite
 * transaction on the shared DbHandle. Both libsignal's session UPSERT
 * and our plaintext UPSERT run inside the transaction; either both
 * commit or neither does. On any throw, ROLLBACK undoes the ratchet
 * advance, and the redelivered ciphertext decrypts fine on retry.
 *
 * Implementation notes:
 *  - `BEGIN IMMEDIATE` acquires the RESERVED lock up front so a
 *    concurrent writer doesn't lock-step us into SQLITE_BUSY mid-decrypt
 *    after the ratchet has already advanced in JS-side state.
 *  - ROLLBACK is best-effort; if it fails the WAL will replay it on
 *    next open. We re-throw the original error either way.
 *  - The helper is intentionally generic — it does not import the
 *    runtime or the messenger store — so it can be unit-tested with a
 *    minimal stub DbHandle (see receiveTransaction.test.ts).
 */

/** Minimal subset of the op-sqlite handle we depend on. */
export interface TxnDbHandle {
  execute(sql: string, params?: unknown[]): Promise<unknown>;
}

// Why: op-sqlite (and SQLite in general) does NOT support nested
// transactions on the same connection — issuing `BEGIN IMMEDIATE`
// while another txn is already open throws "cannot start a transaction
// within a transaction". The receive path calls runWithRatchetTxn
// once per envelope; when the relay flushes N pending envelopes on
// reconnect they ALL dispatch in parallel via `void handleServerFrame`,
// and envelopes 2..N each crash on their BEGIN. Field evidence
// (Pixel 6a, v1.0.34) showed every catch-up envelope failing with
// exactly that error, leaving `handled=false` and the plaintext
// never rendered. Serialize with a single Promise-chain mutex so
// each txn runs to COMMIT/ROLLBACK before the next one starts.
let txnChain: Promise<unknown> = Promise.resolve();

// ── B-126 (2026-07-21) — chain watchdog ────────────────────────────────
// Two-device repro: a rapid 4-6 message burst wedged the receiver's chain
// after exactly two receives — every later frame queued behind a body
// that NEVER resolved. Because callers awaited the wedged tail, every
// inbound envelope (WS push, reconnect flush, HTTP drain — all paths)
// silently stalled until a COLD RESTART; the relay held the messages the
// whole time and the only breadcrumbs went to Crashlytics, so logcat was
// empty. The watchdog converts that unbounded stall into a bounded one:
//
//  - WARN_MS: a frame still running gets ONE console.warn naming its
//    label (survives release stripping) — the diagnostic that identifies
//    the wedging await on the next field repro.
//  - FORCE_MS: the CHAIN TAIL stops waiting for the frame and later
//    frames proceed. The stuck body itself cannot be cancelled (JS), but
//    it was never acked, so redelivery reprocesses its envelope — at-
//    least-once delivery is preserved. If the frame had an open BEGIN,
//    the watchdog ROLLBACKs it so the next frame's BEGIN IMMEDIATE does
//    not die on "cannot start a transaction within a transaction"; if
//    the zombie body later resumes, its own COMMIT/ROLLBACK fails
//    harmlessly ("no transaction active") and its error path is the
//    already-tolerated leave-on-relay class.
export const CHAIN_FRAME_WARN_MS = 30_000;
export const CHAIN_FRAME_FORCE_MS = 120_000;

let forcedAdvances = 0;
/** Telemetry/test hook — how many frames the watchdog force-advanced past. */
export function chainForcedAdvanceCount(): number {
  return forcedAdvances;
}

// F-0 (B-693) — chain-queue depth gauge. The receive side had ZERO latency
// probes; the [recv.total] line samples this at frame arrival so a burst's
// queue-behind-the-chain wait is distinguishable from a slow decrypt.
// Diagnostics only: nothing may branch on it.
let _chainPending = 0;
/** Frames appended to the chain and not yet settled (running + queued). */
export function chainPendingCount(): number {
  return _chainPending;
}

// The db handle of the most recent BEGIN opened by a chain frame, so the
// watchdog can roll back a wedged frame's orphaned transaction.
let openTxnDb: TxnDbHandle | null = null;
// B-126 — ownership token for the open BEGIN. A frame may COMMIT/ROLLBACK
// or clear the open-txn flags ONLY while it still owns them; the watchdog
// disowns a force-advanced frame so its zombie body can never commit or
// abort a LATER frame's live transaction on the shared connection.
let _txnOwner: symbol | null = null;

/** Test hook — reset module state between cases. */
export function _resetTxnChainForTests(): void {
  txnChain = Promise.resolve();
  forcedAdvances = 0;
  _chainPending = 0;
  openTxnDb = null;
  _txnOwner = null;
  _txnOpen = false;
  _onChainDepth = 0;
  // F5 rev-2 — the owner-keyed queue replaced the per-frame wholesale reset,
  // so the reset hook must clear it (and the active key) itself.
  postCommit = [];
  _effectOwner = null;
  _inlineTxnNonce = null;
}

/**
 * Append `execute` to the serialization chain with the B-126 watchdog.
 * Callers still await the REAL frame result; only the chain tail is
 * released early when a frame exceeds CHAIN_FRAME_FORCE_MS.
 */
function appendChainFrame<T>(label: string, execute: () => Promise<T>): Promise<T> {
  _chainPending += 1;
  const next = txnChain.then(execute, execute);
  const guarded = new Promise<void>(resolve => {
    let settled = false;
    const warnTimer = setTimeout(() => {
      console.warn(`[messenger.txnChain] frame '${label}' still running after ${CHAIN_FRAME_WARN_MS}ms — probable wedge (B-126)`);
    }, CHAIN_FRAME_WARN_MS);
    const forceTimer = setTimeout(() => {
      if (settled) {return;}
      settled = true;
      forcedAdvances += 1;
      console.warn(`[messenger.txnChain] frame '${label}' exceeded ${CHAIN_FRAME_FORCE_MS}ms — force-advancing the chain past it (B-126)`);
      // F5 rev-4 (critic) — discard and DISOWN together, unconditionally.
      // Rev-3 discarded outside the open-txn guard but left the disown
      // inside it, so a frame whose _txnOpen was hard-falsed by a nested
      // inline could resume, pass the ownership check, and COMMIT with its
      // effects already discarded — durable data, effects silently dropped
      // (the M16 inverse). Disowned, it throws txn_frame_disowned instead
      // (classified transient → leave-on-relay → clean redelivery). Latent
      // today — the nesting is upstream-blocked — but the failure direction
      // matters: redelivery beats silent effect loss.
      if (_txnOwner) {
        discardPostCommit(_txnOwner);
        // B-703 MR-7 — the watchdog rolls this frame's open BEGIN back below,
        // so its in-memory writes have to be undone with it.
        runCompensations(_txnOwner);
        _txnOwner = null; // disown — the zombie body may no longer COMMIT/ROLLBACK
      }
      if (_txnOpen && openTxnDb) {
        const db = openTxnDb;
        openTxnDb = null;
        _txnOpen = false;
        // #12 — a wedged INLINE is disowned the same way, and its queued
        // effects are DROPPED here (critic: a never-resuming inline would
        // otherwise leak its entries for the process lifetime — its own
        // catch-side discard only runs if it resumes).
        if (_inlineTxnNonce) {discardPostCommit(_inlineTxnNonce); runCompensations(_inlineTxnNonce);}
        _inlineTxnNonce = null;
        void Promise.resolve()
          .then(() => db.execute('ROLLBACK'))
          .then(() => console.warn(`[messenger.txnChain] rolled back wedged frame '${label}' open BEGIN`))
          .catch(() => { /* no txn open / connection gone — fine */ });
      }
      resolve();
    }, CHAIN_FRAME_FORCE_MS);
    void next.then(() => undefined, () => undefined).then(() => {
      // F-0 (B-693) — the frame settled (committed, rolled back, or threw);
      // decrement HERE, not in the force-advance branch: a force-advanced
      // frame is still occupying the connection, so it still counts.
      _chainPending -= 1;
      clearTimeout(warnTimer);
      clearTimeout(forceTimer);
      if (!settled) {
        settled = true;
        resolve();
      }
    });
  });
  txnChain = guarded;
  return next;
}

// Why: op-sqlite has ONE connection per DB handle, and SQLite refuses
// nested BEGINs ("cannot start a transaction within a transaction").
// Other writers like `SqlCipherProtocolStore.saveIdentity` open their
// own BEGIN IMMEDIATE — when called from INSIDE a `runWithRatchetTxn`
// block (e.g. libsignal decrypt → storeSession → saveIdentity), the
// second BEGIN throws. This module-level flag lets those nested
// writers detect they're already inside a transaction and skip their
// own BEGIN/COMMIT (the outer block will commit/rollback the whole
// chain atomically).
let _txnOpen = false;

// Audit B-75 (2026-07-11) — a `runOnTxnChain` body executes AS a chain frame
// but opens NO BEGIN of its own (that is its whole purpose). The libsignal
// session ops it runs during decrypt-recovery (`closeSession` /
// `initOutgoingSession`) call `saveIdentity` internally. Before this counter
// existed, that inner `saveIdentity` saw `isInsideRatchetTxn() === false` and
// re-appended itself to `txnChain` via `runWithRatchetTxn` — i.e. it queued
// BEHIND the very chain frame that was awaiting it. Circular wait → `txnChain`
// froze for the process lifetime, stalling EVERY subsequent DB write (inbound
// receive txns, the coalesced status-flush, message backup/restore). This
// depth counter lets chain-resident writers detect that they already hold the
// chain exclusively and run their body directly (autocommit — safe, since no
// other chain frame can run concurrently) instead of deadlocking on a re-queue.
let _onChainDepth = 0;

export function isInsideRatchetTxn(): boolean {
  return _txnOpen;
}

/**
 * True while a `runOnTxnChain` body is executing — i.e. the caller already
 * holds the per-connection txn chain exclusively but has NO open BEGIN.
 * Chain-resident writers (`SqlCipherProtocolStore.saveIdentity`, reached via
 * libsignal `closeSession` / `initOutgoingSession` during recovery) consult
 * this to run their body directly rather than re-queue on the chain, which
 * would deadlock (B-75).
 */
export function isOnTxnChain(): boolean {
  return _onChainDepth > 0;
}

/**
 * Run `work` inside a `BEGIN IMMEDIATE` / `COMMIT` transaction on `db`.
 * Any throw inside `work` triggers `ROLLBACK` and re-throws the
 * original error. The transaction is per-connection, so all SQL
 * statements `work` issues on the same handle (directly or via stores
 * that share the handle) are atomic.
 *
 * Concurrent callers are serialized via `txnChain` — see the note
 * above. Each call appends to the chain and only resolves once its
 * own txn has committed (or rolled back).
 *
 * Audit P0-1 (2026-07-09) — this is THE per-connection exclusive-txn
 * runner. EVERY explicit multi-statement BEGIN…COMMIT on the shared
 * SQLCipher connection must run through it (or through runOnTxnChain).
 * The M-14 coalesced status-flush (`SqlMessageStore.upsertBatch`)
 * previously drove its own independent mutex, so a receive
 * `BEGIN IMMEDIATE` could land inside an open flush txn and throw
 * "cannot start a transaction within a transaction" — which the ack
 * classifier then treated as terminal, ack-`discarded`ing (destroying)
 * a committed inbound message. One chain ⇒ one open txn at a time.
 */
/**
 * M16 — side effects that must not happen unless the transaction COMMITS.
 *
 * Zustand notifies its subscribers SYNCHRONOUSLY from inside the immer producer,
 * and `appendMessage` runs inside `BEGIN IMMEDIATE`. So a subscriber that posts
 * a notification (or anything else the user can see) fires while the row is
 * still uncommitted — and if the txn then ROLLS BACK, the row vanishes but the
 * banner and the unread badge do not. The user gets a notification for a message
 * that no longer exists, and tapping it opens nothing.
 *
 * Register the visible part of the effect here instead. It runs after COMMIT,
 * and is DISCARDED on rollback. Outside a transaction it runs immediately, so
 * callers do not need to know which context they are in.
 *
 * AUDIT-2026-08-13 F5 — the queue is keyed by the OWNING txn (the frame's
 * `_txnOwner` symbol, or the inline txn's own token). Two defects in the
 * unkeyed version: (1) cross-frame inheritance/destruction — a later frame's
 * rollback could discard, or its commit fire, entries a DIFFERENT owner had
 * queued (note the keying does not change same-moment attribution: an
 * onAfterCommit while frame X is open is still credited to X — that is the
 * "which txn covers this effect" contract, not a defect); (2) an effect
 * queued during `runRatchetTxnInline` was never drained at all — the inline
 * path had no drain, and the next frame's wholesale reset silently DROPPED a
 * committed effect. Now each commit drains exactly its own entries, each
 * rollback discards exactly its own, and a watchdog disown (B-126) drops the
 * zombie's entries at disown time.
 */
let postCommit: Array<{owner: symbol; fn: () => void}> = [];
/** The active queue key: a frame's `_txnOwner`, or the inline txn's token. */
let _effectOwner: symbol | null = null;
/**
 * #12 — the LIVE inline txn's ownership nonce. The watchdog steals it when
 * it rolls a wedged inline back; every inline-side decision (commit,
 * rollback, state release, assertLive) compares THIS, never the shared
 * handle — `openTxnDb === db` is true again as soon as a later frame
 * BEGINs on the one connection.
 */
let _inlineTxnNonce: symbol | null = null;

export function onAfterCommit(fn: () => void): void {
  if (_txnOpen && _effectOwner) {postCommit.push({owner: _effectOwner, fn});}
  else {fn();}
}

/**
 * B-703 MR-7 / M9 — the mirror image, and the missing half of the pair.
 *
 * `onAfterCommit` defers an effect until the data is durable. This defers a
 * COMPENSATION until we know it is not: the receive path writes the message to
 * Zustand and to SQL inside one transaction, but a ROLLBACK only undoes the SQL
 * half. The in-memory bubble survives, the ack goes out as `'discarded'`, the
 * server emits `envelope.undeliverable`, and the sender's zero-tap auto-resend
 * (B-46 / B-683 §3b) mints a fresh wire id — so the recipient ends up looking at
 * the same message twice. That is MESSAGE_LOOP M9's recorded "asymmetric
 * rollback" residue, and it is the root of the duplicate the founder reports.
 *
 * Owner-keyed exactly like the commit queue, and fired everywhere that queue is
 * discarded: a frame rollback, an inline rollback, and a watchdog disown (whose
 * SQL the watchdog has already rolled back).
 *
 * OUTSIDE a transaction this does NOTHING — there is no rollback to compensate
 * for, and running the compensation eagerly would delete the row the caller
 * just wrote. That asymmetry with `onAfterCommit` is deliberate.
 */
export function onRollback(fn: () => void): void {
  if (_txnOpen && _effectOwner) {compensations.push({owner: _effectOwner, fn});}
}

let compensations: Array<{owner: symbol; fn: () => void}> = [];

/** Run + remove exactly `owner`'s compensations (the data never landed). */
function runCompensations(owner: symbol): void {
  const mine = compensations.filter(e => e.owner === owner);
  compensations = compensations.filter(e => e.owner !== owner);
  for (const {fn} of mine) {
    // One bad compensation must not strand the others, and must never replace
    // the original failure — the caller is already throwing.
    try { fn(); } catch { /* compensation-local */ }
  }
}

/** Drop exactly `owner`'s compensations (the data DID land). */
function dropCompensations(owner: symbol): void {
  compensations = compensations.filter(e => e.owner !== owner);
}

/** Test-only — the same leak measure `_postCommitQueueDepthForTest` provides. */
export function _compensationQueueDepthForTest(): number {
  return compensations.length;
}

/** Run + remove exactly `owner`'s entries (data committed). */
function drainPostCommit(owner: symbol): void {
  const mine = postCommit.filter(e => e.owner === owner);
  postCommit = postCommit.filter(e => e.owner !== owner);
  for (const {fn} of mine) {
    // One bad effect must not stop the others, and must never surface as a
    // transaction failure — the data is already committed by this point.
    try { fn(); } catch { /* effect-local */ }
  }
}

/** Discard exactly `owner`'s entries (rollback / zombie disown). */
function discardPostCommit(owner: symbol): void {
  postCommit = postCommit.filter(e => e.owner !== owner);
}

/**
 * Test-only (edge rev-2, MF-2): discarded and orphaned entries are
 * observationally identical from the outside — neither ever runs — so a
 * no-op'd discard ran the whole suite green while every rollback leaked.
 * Depth makes the leak measurable: it must be 0 after any frame rollback,
 * inline rollback, or watchdog disown.
 */
export function _postCommitQueueDepthForTest(): number {
  return postCommit.length;
}

/**
 * AUDIT #12 — the cooperative abort signal for a force-advanced frame.
 *
 * The watchdog disowns a wedged frame, but the frame's `work` closure is
 * still RUNNING (parked on some await, usually the ratchet decrypt). Its
 * terminal COMMIT/ROLLBACK are ownership-guarded — its INTERMEDIATE
 * statements are not: when it resumes, every `execute` via its captured
 * store references lands raw on the shared connection, INSIDE whatever
 * transaction a later frame has open (committed by the later frame's
 * COMMIT, attributed to nothing) or as a stray autocommit. Per-statement
 * attribution is impossible in Hermes (no AsyncLocalStorage), so the
 * frame hands its work a token: `assertLive()` throws the
 * already-transient `txn_frame_disowned` (leave-on-relay) the moment the
 * frame is no longer the owner. Work bodies call it after each long
 * await, BEFORE their write clusters.
 *
 * SCOPE (critic): the clean-redelivery promise holds for CHECKPOINTED
 * statements. Writes buried inside libsignal (`storeSession` during
 * `own.decrypt`) cannot be checkpointed — in the wedge case the ratchet
 * advance can be committed by a LATER frame while the plaintext never
 * lands, and the redelivered envelope then takes the bad-MAC recovery
 * path, not a clean re-decrypt. Pre-existing (the P0-N14 pairing breaks
 * only under a force-advance); recorded in the audit register.
 */
export interface RatchetTxnFrame {
  assertLive: () => void;
}

export async function runWithRatchetTxn<T>(
  db: TxnDbHandle,
  work: (frame: RatchetTxnFrame) => Promise<T>,
  /** B-126 — shows up in the watchdog warns; name the caller, not the SQL. */
  label = 'txn',
): Promise<T> {
  const run = async (): Promise<T> => {
    const me = Symbol(label);
    await db.execute('BEGIN IMMEDIATE');
    _txnOpen = true;
    // MERGE: theirs tracks the txn owner for the B-126 chain watchdog; mine
    // keys the M16 post-commit queue. Different jobs, both required.
    _txnOwner = me;
    _effectOwner = me;
    openTxnDb = db;
    const frame: RatchetTxnFrame = {
      assertLive: () => {
        if (_txnOwner !== me) {
          throw new Error(`txn_frame_disowned: statement checkpoint after force-advance in '${label}' (B-126/#12)`);
        }
      },
    };
    // F5 — no wholesale reset: entries are OWNER-KEYED, so this frame can
    // neither inherit nor destroy another owner's queued effects.
    try {
      const result = await work(frame);
      // B-126 — a force-advanced (disowned) frame must NEVER touch the
      // connection again: a COMMIT here could commit a LATER frame's
      // half-done transaction. The throw is classified transient
      // (leave-on-relay), so the un-acked envelope is redelivered and
      // reprocessed cleanly.
      if (_txnOwner !== me) {
        throw new Error('txn_frame_disowned: watchdog force-advanced past this frame (B-126)');
      }
      // F5 rev-2 (critic catch) — SPLICE our entries out BEFORE issuing
      // COMMIT: the watchdog can disown this frame while the COMMIT is in
      // flight (the ownership guard above already passed), and its
      // discard-at-disown would delete the entries mid-air — a COMMITTED
      // txn's effects silently dropped (the M16 inverse: message stored,
      // banner never posted). A local copy is untouchable by the discard.
      const mine = postCommit.filter(e => e.owner === me);
      postCommit = postCommit.filter(e => e.owner !== me);
      // B-703 MR-7 — same splice-before-COMMIT reasoning as the line above:
      // dropped BEFORE the COMMIT is issued, so a watchdog disown landing
      // mid-air cannot compensate away a transaction that did commit.
      dropCompensations(me);
      await db.execute('COMMIT');
      // Committed — now the visible effects are honest.
      _txnOpen = false;
      for (const {fn} of mine) {
        try { fn(); } catch { /* effect-local */ }
      }
      return result;
    } catch (err) {
      // Only roll back OUR OWN open txn. After a force-advance the
      // watchdog already rolled it back, and a ROLLBACK here would abort
      // a LATER frame's live transaction on the shared connection.
      if (_txnOwner === me) {
        try {
          await db.execute('ROLLBACK');
        } catch {
          // Best-effort; WAL recovery on next open will tidy up.
        }
      }
      // Rolled back — DISCARD our own effects (only ours: F5). This is the
      // whole point. A disowned frame's entries were already dropped by the
      // watchdog at disown time.
      discardPostCommit(me);
      // B-703 MR-7 — the SQL half is gone; undo the in-memory half with it, or
      // the bubble survives the rollback, the ack goes out 'discarded', and the
      // sender's zero-tap auto-resend puts the same message on screen twice.
      runCompensations(me);
      throw err;
    } finally {
      if (_txnOwner === me) {
        _txnOwner = null;
        _txnOpen = false;
        if (openTxnDb === db) {openTxnDb = null;}
      }
      if (_effectOwner === me) {_effectOwner = null;}
    }
  };
  // Chain on a swallowed-error tail so one caller's throw doesn't
  // poison subsequent callers — they see their OWN result/error.
  return appendChainFrame(label, run);
}

/**
 * Audit B-75 (2026-07-11) — open a `BEGIN IMMEDIATE`/`COMMIT` transaction on
 * `db` WITHOUT appending to `txnChain`. Only safe to call when the caller
 * ALREADY holds the chain exclusively (i.e. `isOnTxnChain()` — a runOnTxnChain
 * recovery frame is executing), so no other chain frame can open a competing
 * BEGIN. Used by `SqlCipherProtocolStore.saveIdentity` in the recovery context:
 * re-queuing on `runWithRatchetTxn` there would DEADLOCK (it would wait behind
 * the very frame awaiting it), and running raw would drop the P0-S6 atomicity of
 * the trusted_identities UPSERT + identity_rotations INSERT.
 *
 * Race-safety: `_txnOpen` is set SYNCHRONOUSLY as the first statement (before the
 * BEGIN await), and callers gate on `isInsideRatchetTxn()` before deciding to
 * open their own BEGIN. Because that check-and-set is contiguous and synchronous
 * on the single-threaded event loop, two writers can never both pass the check as
 * false — whoever runs first flips `_txnOpen` before yielding, so the other joins
 * the open txn (runs raw) instead of issuing a second, colliding BEGIN.
 */
export async function runRatchetTxnInline<T>(
  db: TxnDbHandle,
  work: (frame: RatchetTxnFrame) => Promise<T>,
): Promise<T> {
  // F5 — the inline txn owns its own effect-queue key. Pre-fix, effects
  // queued here were NEVER drained (this path had no drain) and the next
  // frame's wholesale reset silently dropped a COMMITTED effect.
  // No prev-owner save/restore: inline-inside-a-frame is upstream-blocked
  // (sqlCipherStore runs body() raw when isInsideRatchetTxn()), and a
  // restore was provably dead code — onAfterCommit's guard reads _txnOpen,
  // which this finally hard-falses (critic rev-2).
  const me = Symbol('inline-txn');
  _effectOwner = me;
  try {
    await db.execute('BEGIN IMMEDIATE');
    // Set ONLY after BEGIN succeeds: the guarded finally below releases
    // state on nonce ownership, so flags claimed before a failed BEGIN
    // would leak (and in the frame-nested lane, an early `_txnOpen = true`
    // plus an unconditional finally used to clobber the FRAME's flag).
    _txnOpen = true;
    // AUDIT #12 sibling (edge, found in the item-6 round) — register the
    // handle so the WATCHDOG can roll a wedged inline back: this path set
    // `_txnOpen` but never `openTxnDb`, so the force-advance guard
    // `if (_txnOpen && openTxnDb)` could never fire for it — the BEGIN
    // stayed open and every later frame died on "cannot start a
    // transaction within a transaction", permanently.
    //
    // OWNERSHIP IS THE NONCE, NEVER THE HANDLE: every frame shares the ONE
    // db object, so `openTxnDb === db` is true again the moment a LATER
    // frame opens its BEGIN — a handle compare would let this resumed
    // inline COMMIT the later frame's half-done transaction (the exact
    // B-126 disaster the disown doctrine exists for).
    openTxnDb = db;
    _inlineTxnNonce = me;
    // #12 — the inline's own cooperative token: after a watchdog rollback
    // the body must stop writing — its statements would land as strays or
    // inside a later frame's txn.
    const frame: RatchetTxnFrame = {
      assertLive: () => {
        if (_inlineTxnNonce !== me) {
          throw new Error('txn_frame_disowned: watchdog rolled back this inline txn (B-126/#12)');
        }
      },
    };
    const result = await work(frame);
    // …and if the watchdog DID intervene while we were wedged, our txn is
    // already rolled back — a COMMIT here would either throw the
    // UNCLASSIFIED "cannot commit - no transaction is active" (terminal →
    // the caller's envelope is ack-destroyed) or, worse, COMMIT a later
    // frame's live transaction. Throw the transient marker instead.
    if (_inlineTxnNonce !== me) {
      throw new Error('txn_frame_disowned: watchdog rolled back this inline txn (B-126/#12)');
    }
    await db.execute('COMMIT');
    _txnOpen = false;
    drainPostCommit(me);
    return result;
  } catch (err) {
    // AUDIT #12 — only roll back OUR OWN still-open txn (nonce compare,
    // not handle compare — see above). After a watchdog intervention the
    // chain has advanced: a LATER frame may hold a live BEGIN on this
    // shared connection, and an unguarded ROLLBACK here would abort THAT
    // frame's transaction.
    if (_inlineTxnNonce === me) {
      try {
        await db.execute('ROLLBACK');
      } catch {
        // Best-effort; WAL recovery on next open will tidy up.
      }
    }
    discardPostCommit(me);
    runCompensations(me); // B-703 MR-7 — inline rollback, same rule
    throw err;
  } finally {
    // Guarded on the nonce: an unconditional `_txnOpen = false` here would
    // clobber a LATER frame's open-txn flag when this inline resumes late.
    if (_inlineTxnNonce === me) {
      _inlineTxnNonce = null;
      _txnOpen = false;
      if (openTxnDb === db && _txnOwner === null) {openTxnDb = null;}
    }
    if (_effectOwner === me) {_effectOwner = null;}
  }
}

/**
 * Run `work` on the SAME serialization chain as runWithRatchetTxn but
 * WITHOUT wrapping in BEGIN IMMEDIATE / COMMIT. Use for follow-on
 * libsignal session writes (closeSession + initOutgoingSession) that
 * must NOT overlap with a concurrent envelope's open transaction — if
 * they do, op-sqlite reports "cannot start a transaction within a
 * transaction" because the open BEGIN holds the connection.
 *
 * Why this exists: runDecryptRecovery runs AFTER runWithRatchetTxn
 * commits, but other envelopes can be inside their own BEGIN IMMEDIATE
 * concurrently. Field evidence (Pixel 6a, v1.0.37): "[messenger]
 * recovery failed err=cannot start a transaction within a transaction"
 * fired repeatedly for the SAME peer because the recovery's session
 * writes raced a still-open receive txn. Queue the recovery on the
 * same chain so it waits its turn.
 */
export async function runOnTxnChain<T>(work: () => Promise<T>, label = 'chain'): Promise<T> {
  // Serializes work on the same chain as runWithRatchetTxn so concurrent
  // callers don't race the connection — but does NOT open a BEGIN.
  // Used for libsignal closeSession / initOutgoingSession during
  // recovery; those operations call saveIdentity internally, which
  // detects it is chain-resident (isOnTxnChain) and runs its body
  // directly (autocommit) — our serialization guarantees no other chain
  // frame runs concurrently, so no BEGIN can collide.
  //
  // B-75: mark chain residency for the duration of `work` so a nested
  // saveIdentity does NOT re-queue on the chain it already occupies
  // (which would deadlock — it would wait behind this frame).
  const run = async (): Promise<T> => {
    _onChainDepth += 1;
    try {
      return await work();
    } finally {
      _onChainDepth -= 1;
    }
  };
  return appendChainFrame(label, run);
}

/**
 * Audit P0-1(b) — transient LOCAL SQL failure classifier for the
 * receive ack sites.
 *
 * The relay's `discarded` disposition is a DELETE instruction: the
 * relay drops the envelope and tells the sender "undelivered". That is
 * only honest for terminal, message-specific failures (cert/AAD
 * reject, bad MAC, tamper-final). A transient LOCAL storage failure —
 * nested-transaction collision, SQLITE_BUSY/locked from a concurrent
 * handle, disk I/O pressure — says nothing about the message itself:
 * the relay still holds a perfectly deliverable copy, and the receive
 * txn rolled back (no ratchet advance), so a later redelivery decrypts
 * clean. Classifying these as leave-on-relay (skip the ack; the relay
 * redelivers within its 30-day dwell) instead of ack-`discarded`
 * prevents a local hiccup from permanently destroying a committed
 * inbound message.
 *
 * Deliberately matched on the message string: op-sqlite surfaces
 * native SQLite errors as plain `Error`s with the sqlite3 result text,
 * so there is no error class or code to switch on.
 */
/**
 * M6 — is this sender-cert failure TRANSIENT (a clock problem) rather than a
 * verdict about the sender?
 *
 * `verifySenderCert` allows ±120s of skew and then throws exactly two
 * clock-window errors. Those say nothing about whether the sender is genuine —
 * only that this device's clock disagrees — so acking `discarded` for them
 * DELETED the envelope off the relay and destroyed the message permanently.
 *
 * Everything else that function throws (malformed, wrong issuer, bad signature,
 * revoked, identity mismatch) is a real rejection and MUST stay terminal:
 * widening this to "any cert error" would keep genuinely forged envelopes alive
 * on the relay for its full 30-day dwell, being retried.
 *
 * Lives here, beside isTransientSqlError, because it is a pure classifier —
 * this module has no imports, so it can be unit-tested without standing up the
 * runtime. (It started out in senderCertAdmit.ts, which transitively pulls in
 * react-native via crashlytics and therefore cannot load in the node test
 * project at all.)
 *
 * Mirrors the two `throw new CryptoError(...)` sites in
 * packages/messenger-core/src/crypto/senderCert.ts — pinned by a test that
 * asserts the exact wording, so a reword there cannot silently revert this.
 */
export function isTransientCertError(err: unknown): boolean {
  const msg = (err as Error)?.message;
  return msg === 'sender cert expired' || msg === 'sender cert not yet valid';
}

// AUDIT #11 rev-4 (critic) — `db_closed` is the guardDbLifecycle throw for a
// write racing a rebuild's handle close (crypto/db.ts). A closed LOCAL
// handle says nothing about the message: without this alternate the frame
// classified terminal → ack `discarded` → the relay deleted the envelope —
// the SIGSEGV the guard removed would have been traded for silent
// permanent loss. Leave-on-relay; the rebuilt runtime redelivers cleanly.
const TRANSIENT_SQL_ERROR_RE =
  /cannot start a transaction within a transaction|database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED|disk i\/o error|SQLITE_IOERR|database or disk is full|SQLITE_FULL|txn_frame_disowned|db_closed/i;

export function isTransientSqlError(err: unknown): boolean {
  if (err === null || err === undefined) {return false;}
  const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return TRANSIENT_SQL_ERROR_RE.test(msg);
}
