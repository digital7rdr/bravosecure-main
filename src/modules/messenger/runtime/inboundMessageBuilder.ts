import type {LocalMessage} from '../store/types';
import {orderingTsMs} from './orderingClock';

/**
 * ONE builder for every inbound message row.
 *
 * `doHandleIncoming` hand-rolled the same ~20-key `LocalMessage` literal FOUR
 * times — drained-from-stash, legacy plaintext group, live sealed group, and
 * 1:1 — and they had already drifted. A field added to one was silently absent
 * from the others, which is why (for example) group media rendered on the live
 * path long before it rendered on the drained path.
 *
 * The genuine per-lane differences are now explicit PARAMETERS rather than
 * hidden duplication, so the divergences are visible and a new field added here
 * reaches all four lanes at once.
 *
 * Deliberately NOT normalised in the extraction commit (each needs its own
 * change + test):
 *   - the legacy plaintext lane stamps `created_at` with RECEIVE time, while the
 *     other three use the sender's authenticated seal timestamp (`aad.ts`).
 *     Passing `createdAt` explicitly preserves that exactly.
 *
 * Tier A: no imports beyond the row type, so it is unit-testable without
 * standing up the runtime.
 */

/** The payload shape every lane already has, whatever it calls the variable. */
export interface InboundEnvelopeLike {
  clientMsgId?:  string;
  attachment?:   {
    mimeType?:   string;
    kind?:       string;
    objectKey?:  string;
    keyB64?:     string;
    ivB64?:      string;
    name?:       string;
    width?:      number;
    height?:     number;
    durationMs?: number;
    thumbB64?:   string;
    size?:       number;
  } | null;
  expiresAtSec?: number;
  replyTo?:      {msgId?: string; preview?: string};
  mentions?:     Array<{userId: string; label: string}>;
  /** MM-09 — 1:1 lane's forwarded flag (top-level; group rides the carrier). */
  isForwarded?:  boolean;
  /**
   * WIRE-COMPAT carrier. Mentions travel INSIDE `group` so a peer built before
   * the field existed ignores them instead of rejecting the whole envelope
   * (isSealedPayload refuses unknown TOP-LEVEL keys — that destroyed real
   * messages against a mixed fleet). Read the carrier first, top level second.
   */
  group?:        {mentions?: Array<{userId: string; label: string}>; isForwarded?: boolean} | null;
}

export function attachmentMessageType(
  attachment?: {mimeType?: string; kind?: string} | null,
): 'text' | 'image' | 'audio' | 'video' | 'file' {
  if (!attachment) {return 'text';}
  const k = attachment.kind;
  if (k === 'image' || k === 'audio' || k === 'video') {return k;}
  const mime = (attachment.mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) {return 'image';}
  if (mime.startsWith('audio/')) {return 'audio';}
  if (mime.startsWith('video/')) {return 'video';}
  return 'file';
}

/**
 * Media-parity (2026-07-03) — map the sealed attachment's optional display
 * metadata onto the row (persisted as media_meta_json, schema v13) so bubbles
 * render instant previews with the right aspect ratio, real filenames and
 * durations. Returns undefined when the sender shipped none, so pre-metadata
 * envelopes cost nothing.
 */
export function attachmentMediaMeta(att?: {
  name?:       string;
  width?:      number;
  height?:     number;
  durationMs?: number;
  thumbB64?:   string;
  size?:       number;
} | null): LocalMessage['media_meta'] {
  if (!att) {return undefined;}
  const {name, width, height, durationMs, thumbB64, size} = att;
  if (name === undefined && width === undefined && height === undefined &&
      durationMs === undefined && thumbB64 === undefined && !size) {
    return undefined;
  }
  return {
    ...(name       !== undefined ? {name} : {}),
    ...(width      !== undefined ? {width} : {}),
    ...(height     !== undefined ? {height} : {}),
    ...(durationMs !== undefined ? {durationMs} : {}),
    ...(thumbB64   !== undefined ? {thumbB64} : {}),
    ...(size       !== undefined ? {sizeBytes: size} : {}),
  } as LocalMessage['media_meta'];
}

/**
 * Send time from the sender's AUTHENTICATED aad.ts (valid up to the 30-day
 * relay dwell), so a message drained after reconnect sorts by when it was SENT,
 * not when it was decoded — `appendMessage`'s binary splice puts it back in
 * order. Falls back to now only when the timestamp is absent.
 */
export function sentAtFromAad(
  aad: {ts?: number} | undefined,
  /**
   * OM-02 — reference clock (the relay's accept time) used to clamp a sender
   * whose clock is in the FUTURE. Optional so existing callers are unchanged.
   *
   * The inline 1:1 and group lanes clamped via `orderingCreatedAt(aad.ts, ref)`
   * while this helper did not, so extracting those lanes verbatim would have
   * silently dropped the clamp and let a future-dated envelope pin itself to
   * the top of the thread forever. Folding the clamp in here keeps ONE
   * created_at rule (MSG-09 asserts every lane routes through this function)
   * instead of two that disagree.
   *
   * Only the future is bounded: a store-and-forwarded or outbox-queued envelope
   * is legitimately much OLDER than the reference (MSG-01 / L18) and keeps its
   * real send time.
   */
  refTsMs?: number,
): string {
  const ts = aad?.ts;
  if (refTsMs !== undefined) {
    return new Date(orderingTsMs(typeof ts === 'number' ? ts : undefined, refTsMs)).toISOString();
  }
  return new Date(typeof ts === 'number' ? ts : Date.now()).toISOString();
}

/**
 * B-145 — the quoted-reply preview is bounded at BOTH ends of the wire.
 *
 * The send side has always sliced to this length, but the receive side
 * copied `env.replyTo.preview` verbatim and `isValidSealedPayload` only
 * type-checks it as a string — so a non-conforming or hostile peer could
 * push an arbitrarily large quote strip into the store, SQLCipher and
 * every subsequent backup mirror. A cap costs nothing against an honest
 * sender (who never exceeds it) and bounds the damage from one that is
 * not. Exported so the three send-side copies of this number cannot
 * drift away from what the receiver enforces.
 */
export const REPLY_PREVIEW_MAX_CHARS = 200;

export interface BuildInboundArgs {
  env:            InboundEnvelopeLike;
  conversationId: string;
  peer:           LocalMessage['peer'];
  /** Body text — differs per lane (inner envelope vs plaintext unwrap). */
  content:        string;
  /** ISO string; see the note about the legacy lane's receive-time stamp. */
  createdAt:      string;
  envelopeId?:    string;
  makeId:         () => string;
}

/**
 * ONE place that knows where mentions live on the wire.
 *
 * Carrier (`group.mentions`) wins over the legacy top-level field. Both are
 * accepted so a peer mid-rollout still emitting the old shape keeps working;
 * only the EMIT side is one-way. Absent stays absent — an empty array and
 * undefined must not both be reachable, or the renderer's presence check
 * becomes conditionally dead.
 */
export function mentionsFrom(env: InboundEnvelopeLike): LocalMessage['mentions'] {
  const carried = env.group?.mentions;
  if (carried?.length) {return carried;}
  return env.mentions?.length ? env.mentions : undefined;
}

export function buildInboundMessage(args: BuildInboundArgs): LocalMessage {
  const {env, conversationId, peer, content, createdAt, envelopeId, makeId} = args;
  return {
    id:               env.clientMsgId ?? makeId(),
    conversation_id:  conversationId,
    sender_id:        peer.userId,
    type:             attachmentMessageType(env.attachment),
    content,
    media_mime:       env.attachment?.mimeType,
    media_object_key: env.attachment?.objectKey,
    // Round 8 — carry the per-file AES key + IV on the received row so
    // attachments survive a backup-restore.
    media_key:        env.attachment?.keyB64,
    media_iv:         env.attachment?.ivB64,
    media_meta:       attachmentMediaMeta(env.attachment),
    status:           'delivered',
    is_encrypted:     true,
    created_at:       createdAt,
    peer,
    envelope_id:      envelopeId,
    expires_at:       env.expiresAtSec ? env.expiresAtSec * 1000 : undefined,
    reply_to_msg_id:  env.replyTo?.msgId,
    reply_to_preview: env.replyTo?.preview?.slice(0, REPLY_PREVIEW_MAX_CHARS),
    // MM-09 — carrier first, top level second (mentions' ONE rule). Only an
    // exact true renders the chip, so absent stays absent.
    is_forwarded:     (env.group?.isForwarded === true || env.isForwarded === true) ? true : undefined,
    // Bounded at the wire boundary (isSealedPayload caps the list length and
    // each label), so nothing further is needed here. Absent stays absent — an
    // empty array and undefined must not both be reachable, or the renderer's
    // presence check becomes conditionally dead.
    mentions:         mentionsFrom(env),
  } as LocalMessage;
}
