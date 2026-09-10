import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

/**
 * Disappearing messages — client-side expiry sweep.
 *
 * Poll every `intervalMs` (default 1s for snappy on-screen countdown).
 * Any message whose `expires_at` has passed is hard-removed from the
 * in-memory store. The sweeper has three follow-on responsibilities:
 *
 *   1. Server retract — for messages WE sent that still hold a
 *      capability token, fire `POST /envelopes/retract` so the
 *      sealed envelope is pulled off the relay before any offline
 *      recipient could fetch it inside the 30-day dwell.
 *   2. Cache purge — for messages with an attachment, drop the
 *      cached ciphertext blob (`MediaBlobCache.remove`) so the
 *      decrypted-on-demand R2 ciphertext doesn't outlive the
 *      message itself. SQLCipher's page-level encryption protects
 *      the cache but the contract still requires deterministic
 *      eviction on expiry.
 *   3. (Phase 2) Filesystem purge — when we add an on-disk plaintext
 *      cache for thumbnails/previews, delete those here too. Hook is
 *      already wired via the same `purgeBlob` callback.
 *
 * Retract + cache purge are best-effort and run in parallel. Failures
 * never block the sweep cadence — the message is gone from history
 * either way; the cache row is at worst orphaned (LRU evicts it).
 */

const DEFAULT_INTERVAL_MS = 1_000;
// B-160 — F-13's IDLE_RESCAN_MS (skip all sweeps for 30s after a scan that
// saw zero armed messages) is GONE. It existed only because a tick cost a
// full walk of every hydrated message; the armed index below makes an empty
// tick free, so the backoff bought nothing and cost correctness: a burn
// timer armed just after an idle scan was not swept for up to 30s, leaving
// an expired bubble on screen well past its own countdown.

/**
 * Round 8 — module-level grace window. Restored messages carry their
 * ORIGINAL absolute expires_at epoch from the source device. If the
 * TTL has elapsed (or partially elapsed) during the install/restore
 * window, the sweeper would nuke them within seconds of restore,
 * leaving the user with a chat that populates and then evaporates.
 *
 * The grace window suppresses sweeps for a configurable interval after
 * the most recent `markRestoredNow` call. Default 5 minutes — enough
 * for the user to scroll through the restored chat and notice their
 * disappearing messages, while bounded so a long-forgotten
 * disappearing-message doesn't linger.
 */
let graceUntilMs = 0;
const DEFAULT_GRACE_MS = 5 * 60 * 1000;
// Separate timestamp for the UI restore-animation window. We want
// MessageBubble to spring-animate on first mount when the message is
// part of a fresh restore, but only for a brief moment (~8s) so the
// user feels the "messages are flowing in" effect without the
// animation lingering after they navigate away and back.
let restoreAnimUntilMs = 0;
const RESTORE_ANIM_WINDOW_MS = 8_000;

export function markRestoredNow(graceMs: number = DEFAULT_GRACE_MS): void {
  graceUntilMs = Date.now() + graceMs;
  restoreAnimUntilMs = Date.now() + RESTORE_ANIM_WINDOW_MS;
  console.log(`[expirySweeper] grace window until ${new Date(graceUntilMs).toISOString()}`);
}

/**
 * UI helper — true if a restore completed in the last RESTORE_ANIM_WINDOW_MS.
 * MessageBubble checks this on mount to decide whether to play the
 * stagger-in spring animation. Outside the window, bubbles mount
 * instantly (no animation overhead during normal scrolling).
 */
export function isInRestoreAnimWindow(): boolean {
  return Date.now() < restoreAnimUntilMs;
}

/** Server-side retract callback — runtime injects this so the sweeper doesn't depend on transport. */
export type RetractFn = (token: string) => Promise<void>;

/**
 * Local cache purge callback — runtime injects this so the sweeper
 * doesn't depend on the SQLCipher store. Receives the R2 object key
 * (the message's `media_object_key`) and is expected to drop any
 * cached ciphertext / decrypted-blob for that key.
 */
export type PurgeBlobFn = (objectKey: string) => Promise<void>;

export class ExpirySweeper {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly intervalMs: number;
  private readonly retract:    RetractFn | null;
  private readonly purgeBlob:  PurgeBlobFn | null;
  /**
   * B-160 — per-conversation armed index, keyed by the message-list REFERENCE.
   *
   * The sweep used to walk every hydrated message in every conversation once a
   * second for as long as ONE armed message existed anywhere (~4,000 row visits
   * per second on a 20-chat account). Zustand+immer keep untouched conversation
   * lists reference-stable — the same property the SQLCipher write-through diff
   * relies on (N-30) — so an unchanged list can reuse its cached armed subset
   * and is never re-walked. A list whose reference moved is re-scanned, which is
   * what keeps a newly-armed message visible.
   */
  private armedIndex = new Map<string, {list: LocalMessage[]; armed: LocalMessage[]}>();

  constructor(opts: {intervalMs?: number; retract?: RetractFn; purgeBlob?: PurgeBlobFn} = {}) {
    this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.retract    = opts.retract   ?? null;
    this.purgeBlob  = opts.purgeBlob ?? null;
  }

  start(): void {
    if (this.timer) {return;}
    this.timer = setInterval(() => this.sweep(), this.intervalMs);
  }

  stop(): void {
    if (!this.timer) {return;}
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Run one sweep immediately. Exposed so AppState 'active' can drain. */
  sweep(nowMs: number = Date.now()): number {
    // Round 8 — short-circuit during the post-restore grace window so
    // restored disappearing-messages with already-elapsed expires_at
    // don't evaporate before the user has time to read them.
    if (nowMs < graceUntilMs) {return 0;}
    const state = useMessengerStore.getState();
    let purged = 0;
    const toRetract: LocalMessage[] = [];
    const toPurgeBlob: string[] = [];
    const messages = state.messages;
    // Keys only — reading `messages[id]` yields the array without touching a
    // single row, so an unchanged conversation costs one Map lookup per tick.
    const liveIds = Object.keys(messages);
    for (const conversationId of liveIds) {
      const list = messages[conversationId];
      let entry = this.armedIndex.get(conversationId);
      if (!entry || entry.list !== list) {
        // Reference moved (or first sight): this is the only path that walks rows.
        const armed: LocalMessage[] = [];
        for (const msg of list) {
          if (typeof msg.expires_at === 'number') {armed.push(msg);}
        }
        entry = {list, armed};
        this.armedIndex.set(conversationId, entry);
      }
      if (entry.armed.length === 0) {continue;}
      for (const msg of entry.armed) {
        if ((msg.expires_at as number) <= nowMs) {
          if (msg.retract_token)    {toRetract.push(msg);}
          if (msg.media_object_key) {toPurgeBlob.push(msg.media_object_key);}
          state.removeMessage(conversationId, msg.id);
          purged += 1;
        }
      }
    }
    // Drop index rows for conversations that no longer exist (cleared chat,
    // account switch) so the index cannot outgrow the store.
    if (this.armedIndex.size > liveIds.length) {
      for (const id of this.armedIndex.keys()) {
        if (!(id in messages)) {this.armedIndex.delete(id);}
      }
    }
    // Fire-and-forget retracts; don't block sweep cadence on the network.
    if (this.retract && toRetract.length > 0) {
      for (const msg of toRetract) {
        // Type narrow — we only pushed messages with a token.
        const token = msg.retract_token as string;
        this.retract(token).catch(() => { /* best-effort; recipient may have pulled already */ });
      }
    }
    // Fire-and-forget cache purges. Cache rows only ever hold encrypted
    // bytes so a crash mid-purge can't leak plaintext, but we still want
    // them to disappear when the message they backed is gone.
    if (this.purgeBlob && toPurgeBlob.length > 0) {
      for (const objectKey of toPurgeBlob) {
        this.purgeBlob(objectKey).catch(() => { /* best-effort; LRU will catch it */ });
      }
    }
    return purged;
  }
}
