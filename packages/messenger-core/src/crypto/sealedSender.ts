import {CryptoError} from './errors';

/**
 * Sealed Sender — pragmatic Phase-1 implementation.
 *
 * The construction: BEFORE the sender calls `SessionCipher.encrypt`,
 * wrap the plaintext + sender cert into a JSON envelope. The Signal
 * ciphertext produced by libsignal is then opaque to the relay — the
 * relay sees only `{recipient, ciphertext}` with no sender hint.
 *
 *   plaintext ──► seal(cert, plaintext) ──► wrapped
 *                                            │
 *                                            ▼
 *                                SessionCipher.encrypt(wrapped) ──► ciphertext
 *                                                                    │
 *                                                                    ▼
 *                                                           relay (no sender)
 *                                                                    │
 *                              ciphertext ──► SessionCipher.decrypt
 *                                                                    │
 *                                                                    ▼
 *                                             unseal(wrapped) ──► {cert, body, ...}
 *                                                                    │
 *                                                                    ▼
 *                                               verifySenderCert(cert) ──► identity
 *
 * M6 extension: optional `attachment` carries per-file AES-256-CBC key
 * + IV + R2 object key. The blob itself lives in R2; the key/iv never
 * touch HTTP outside this payload.
 *
 * M7 extension: optional `expiresAtSec` is the epoch-seconds deadline
 * at which both sides must purge the message locally. Both sender and
 * recipient countdown from the same value (no clock drift concerns
 * beyond typical NTP accuracy).
 *
 * Format versions:
 *   v: 1 — initial (M4)
 *   v: 2 — adds optional attachment + expiresAtSec
 *   v: 3 — adds optional `aad` block binding ciphertext to recipient + ts.
 *          Round 5 / Security S1 fix. Without aad, a captured ciphertext
 *          could be replayed to a DIFFERENT recipient (the inner Signal
 *          ratchet authenticates the sender but not the intended
 *          destination), and a stolen-then-released session record could
 *          be replayed against a future point in time (cert iat/exp is
 *          only ~1h-granular). The aad block binds both at seal time.
 *
 * v:1 parsers fail on v:2 messages. That's intentional — any client
 * seeing a v:2 payload needs to know how to handle the new optional
 * fields. We keep the strict check because silently dropping an
 * attachment or expiry timer is worse than rejecting the message.
 *
 * v:3 envelopes are accepted by v:2 parsers because the optional `aad`
 * field is shape-validated when present and ignored when absent — the
 * isSealedPayload guard is positive (validates known fields' shapes,
 * allows extras). v:3 receivers ENFORCE the aad binding when present;
 * legacy senders that omit it still interop (back-compat during rollout).
 */

const SEALED_VERSION = 3;
/**
 * Lowest payload version we will still parse. Audit fix #4 — during a
 * staggered rollout of v2 we still see v1 envelopes in flight. Hard-
 * rejecting them locked out clients mid-upgrade. We accept any version
 * `>= MIN_SEALED_VERSION` and only branch on the version when populating
 * optional fields the older shape didn't carry.
 */
const MIN_SEALED_VERSION = 1;

export interface SealedAttachment {
  /** R2 object key — feed to MediaClient.downloadEncrypted */
  objectKey: string;
  /** base64 AES-256 key */
  keyB64:    string;
  /** base64 16-byte IV */
  ivB64:     string;
  /** logical MIME type (display hint only — not cryptographically binding) */
  mimeType:  string;
  /** original plaintext byte length (before encryption) */
  size:      number;
  /**
   * Renderer hint — image/audio/video/file. Predates the metadata block
   * below (already shipped in-band by sendMedia).
   */
  kind?:       string;
  /**
   * Media-parity metadata (handoff MEDIA_OPEN_WHATSAPP_PARITY §4 Phase 3,
   * owner-approved 2026-07-03). All OPTIONAL and all travel INSIDE the
   * sealed payload — same trust domain as keyB64/ivB64; the relay sees
   * nothing. Display hints only, never cryptographically binding:
   *   name       — original filename for documents
   *   width/height — pixel dimensions so bubbles reserve the correct
   *                aspect ratio before the blob downloads
   *   durationMs — audio/video runtime for the bubble label
   *   thumbB64   — tiny JPEG preview (sender-side ≤~20 KB) rendered
   *                instantly while the full blob decrypts
   */
  name?:       string;
  width?:      number;
  height?:     number;
  durationMs?: number;
  thumbB64?:   string;
}

/**
 * Group-addressing metadata (M9). When present, the recipient treats
 * the message as a group post and routes it into the group thread,
 * deduplicating on `(groupId, clientMsgId)` across the N pairwise
 * copies the sender produces as fan-out.
 */
export interface SealedGroup {
  /** Stable opaque group identifier (UUID). */
  groupId: string;
  /**
   * `text` is the common case; `admin` carries a membership change or
   * master-key rotation that recipients apply to local group state
   * BEFORE rendering (see groups/groupClient.ts).
   */
  kind:   'text' | 'admin';
  /** Sender-generated msg id so recipients can de-dupe identical copies. */
  clientMsgId: string;
  /**
   * Audit G-08 (2026-07-02): the sender's chained membership transcript hash
   * (GroupState.transcriptHash) at send time. Receivers compare it to their own
   * local transcript for the group; a MISMATCH means the two members applied a
   * DIFFERENT sequence of admin actions (a fork / equivocation, or a benign
   * out-of-order delivery that hasn't settled). Detection-only — surfaced as a
   * diagnostic, never drops the message. Optional for back-compat (legacy
   * senders omit it; absent-vs-anything is not flagged).
   */
  senderTranscriptHash?: string;
  /**
   * MM-09 — group-lane home for the forwarded flag. Rides the carrier (not
   * the top level) so a peer built before the field existed ignores it
   * instead of destroying the message — see the carrier rationale below.
   */
  isForwarded?: boolean;
  /**
   * WIRE-COMPAT CARRIER for @-mentions, edit and delete-for-everyone.
   *
   * These belong at the TOP LEVEL semantically, and they started there. They
   * had to move here because `isSealedPayload` rejects any unknown top-level
   * key outright:
   *
   *     for (const k of Object.keys(o)) {
   *       if (!SEALED_PAYLOAD_KEYS.has(k)) {return false;}
   *     }
   *
   * A client built before a field existed does not have it in that Set, so a
   * message carrying it fails the guard, `unsealPayload` throws, and the
   * envelope is DESTROYED on arrival. Field-tested: a mention-bearing group
   * message sent from a new build never reached any peer on the old one, while
   * the same text without a mention arrived fine.
   *
   * `group` is the only safe carrier available, and it is safe for a precise
   * reason: unlike the top level (and unlike `aad`), the group branch of the
   * guard type-checks its KNOWN fields and never iterates the object's keys —
   * so an unrecognised key here is ignored rather than fatal. That is not an
   * accident we are exploiting; `senderTranscriptHash` above was added the same
   * way and shipped through a mixed fleet without incident.
   *
   * Consequence, stated plainly: a peer on an older build renders the message
   * as PLAIN TEXT (no highlight) and ignores an edit/delete directive, instead
   * of losing the message. Degrading beats destroying.
   *
   * 1:1 has no `group` object and therefore no carrier — 1:1 edit/delete are
   * still sent top-level and are still refused by old clients. That is bounded:
   * they are control envelopes that render no bubble, so a refusal loses the
   * directive, never a user's message.
   */
  mentions?:  SealedMention[];
  edit?:      {targetMsgId: string; body: string; editedAt: number; mentions?: SealedMention[]};
  deleteFor?: {targetMsgId: string; deletedAt: number};
}

/**
 * Round 5 / Security S1 — additional authenticated data binding the
 * sealed envelope to a SPECIFIC recipient + a SPECIFIC moment in time.
 *
 * Threat: without this binding, an attacker who copies the ciphertext
 * off the wire can attempt to replay it to:
 *   • a different recipient (won't decrypt under their session, BUT
 *     a buggy or compromised session record could)
 *   • the same recipient at a future time (re-shipping a message body
 *     that the user wrote but later regretted, or to confuse the
 *     ordering of events for a legal/audit purpose)
 *
 * Mitigation: at seal-time, the sender STAMPS the recipient address +
 * a millisecond timestamp into the JSON before ratcheting. At unseal
 * time, the receiver verifies that:
 *   1. aad.to.userId === self.userId (and deviceId matches),
 *   2. |aad.ts - now| ≤ 15 minutes (clock-tolerance window matched to
 *      the cert expiry window so legitimate offline-then-online flow
 *      still lands).
 *
 * The aad bytes themselves don't have to be authenticated by Signal —
 * they're INSIDE the Signal ratchet, which authenticates the sender's
 * identity. Putting `to` + `ts` inside that authenticated wrapper means
 * a replay against a different recipient or stale session would have
 * to forge a Double Ratchet message (computationally infeasible).
 */
export interface SealedAad {
  /** Recipient userId — receiver MUST verify it equals their own. */
  to:        {userId: string; deviceId: number};
  /**
   * Sender-stamped epoch milliseconds of the message's COMPOSE moment.
   * OM-05 / NA-GATE-3 (2026-07-20): reinterpreted from "when seal() was
   * called" — a drain-time re-seal carries the outbox row's compose time
   * (clamped inside this window by `resolveResealAadTs`) so both devices
   * order the message identically. Live sends still stamp at seal time,
   * which IS the compose moment. The accept bounds below are unchanged
   * and must never be widened to accommodate a carried timestamp.
   */
  ts:        number;
  /**
   * Audit P0-N2 — extended AAD bindings. The original {to, ts} pair
   * authenticated WHO + WHEN but not WHO-FROM or WHICH-CONVERSATION.
   * That left two replay vectors:
   *
   *  1. Cross-conversation replay (1:1 ↔ group): an attacker who copies
   *     the ciphertext of a private 1:1 message can attempt to inject
   *     it into a group thread the recipient is in. The inner Signal
   *     ratchet still authenticates the sender, but the recipient's
   *     rendering pipeline routes by `group.groupId`; mismatching the
   *     conversation lets the message surface in the wrong thread.
   *  2. Group epoch replay: removed members can replay their own pre-
   *     removal ciphertext after the master key rotates. The inner
   *     ratchet still validates (their session existed at the time),
   *     but the group state has advanced and they should be silenced.
   *
   * All four extensions are OPTIONAL on the wire so v3 envelopes from
   * pre-P0-N2 senders still round-trip. Receivers validate when both
   * sides are present; absent-vs-absent is the legacy fail-open path.
   */
  /** Sender identity that produced this envelope (= sealed.cert subject). */
  sender?:         {userId: string; deviceId: number};
  /** 1:1 conversation id OR group id (whichever applies). */
  conversationId?: string;
  /** Group id when the envelope is a group post (kind = 'text' | 'admin'). */
  groupId?:        string;
  /** Group epoch when sealed; receiver rejects stale epochs after rekey. */
  epoch?:          number;
}

/** One @-mention: who was mentioned, and the literal text used for them. */
export interface SealedMention {
  userId: string;
  label:  string;
}

/**
 * Bounds on the mention list and on an edited body.
 *
 * Same posture as the `replyTo.preview` cap (B-145) and the attachment
 * `thumbB64` cap: an honest sender never approaches these, and without them
 * a non-conforming peer can push unbounded text straight into the store,
 * SQLCipher, and every subsequent backup mirror. Exported so the send side
 * and the receive side cannot drift apart on the number.
 */
export const MENTIONS_MAX = 64;
export const MENTION_LABEL_MAX_CHARS = 128;
export const EDIT_BODY_MAX_CHARS = 8192;

/**
 * One implementation each for the two directives, because they are validated in
 * TWO places now — at the top level (1:1) and inside `group` (the wire-compat
 * carrier). Two hand-copied validators is how one of them ends up missing a
 * bound.
 */
function isEditDirective(v: unknown): boolean {
  if (!v || typeof v !== 'object') {return false;}
  const e = v as Record<string, unknown>;
  for (const k of Object.keys(e)) {
    if (k !== 'targetMsgId' && k !== 'body' && k !== 'editedAt' && k !== 'mentions') {return false;}
  }
  if (typeof e.targetMsgId !== 'string' || !e.targetMsgId) {return false;}
  if (typeof e.body !== 'string' || e.body.length > EDIT_BODY_MAX_CHARS) {return false;}
  if (typeof e.editedAt !== 'number' || !Number.isFinite(e.editedAt)) {return false;}
  if (e.mentions !== undefined && !isMentionList(e.mentions)) {return false;}
  return true;
}

function isDeleteDirective(v: unknown): boolean {
  if (!v || typeof v !== 'object') {return false;}
  const d = v as Record<string, unknown>;
  for (const k of Object.keys(d)) {
    if (k !== 'targetMsgId' && k !== 'deletedAt') {return false;}
  }
  if (typeof d.targetMsgId !== 'string' || !d.targetMsgId) {return false;}
  if (typeof d.deletedAt !== 'number' || !Number.isFinite(d.deletedAt)) {return false;}
  return true;
}

function isMentionList(v: unknown): boolean {
  if (!Array.isArray(v)) {return false;}
  if (v.length > MENTIONS_MAX) {return false;}
  for (const m of v) {
    if (!m || typeof m !== 'object') {return false;}
    const e = m as Record<string, unknown>;
    if (typeof e.userId !== 'string' || !e.userId) {return false;}
    if (typeof e.label  !== 'string') {return false;}
    if (e.label.length > MENTION_LABEL_MAX_CHARS) {return false;}
    for (const k of Object.keys(e)) {
      if (k !== 'userId' && k !== 'label') {return false;}
    }
  }
  return true;
}

export interface SealedPayload {
  /**
   * Format version — bump on any breaking change to the JSON shape.
   * Type is `number` (not the literal SEALED_VERSION) because we accept
   * any version >= MIN_SEALED_VERSION for backward compat during rollout
   * (audit fix #4). Branches in unsealPayload populate optionals only
   * for versions that actually carry them on the wire.
   */
  v: number;
  /** Opaque sender cert (Ed25519-signed JWT from auth-service). */
  cert: string;
  /** Original application plaintext. Empty string when message is attachment-only. */
  body: string;
  /**
   * Round 5 / Security S1 — recipient + timestamp binding. Optional on
   * the wire for back-compat; receivers validate when present and skip
   * (with a warning) when absent. Senders SHOULD always include it
   * starting v3.
   */
  aad?: SealedAad;
  /** Present only for messages that carry a file attachment. */
  attachment?: SealedAttachment;
  /** Epoch seconds. When set, both sides purge the message after this time. */
  expiresAtSec?: number;
  /**
   * Sender-chosen opaque id for this message. Receiver stores it as the
   * local message's `id` so reactions and replies can target the same
   * stable handle from both sides. Without this, sender and receiver
   * each mint independent ids, and any out-of-band reaction targeting
   * sender's id silently fails to match the receiver's row.
   */
  clientMsgId?: string;
  /** Present only for group posts — see SealedGroup. */
  group?: SealedGroup;
  /**
   * Quote/reply metadata — lets the recipient render the "↳ replying to X"
   * strip above the message body. `msgId` is the ORIGINATING sender's
   * client-generated id (opaque to server), `preview` is a plaintext
   * snippet the sender chooses to embed so the recipient doesn't have
   * to search their own history for context.
   */
  replyTo?: {msgId: string; preview: string};
  /**
   * MM-09 — the sender forwarded this message from another conversation.
   * Display metadata only (drives the "Forwarded" chip on the recipient's
   * bubble); never affects routing or crypto. Stamped only when true.
   * Rollout note: clients older than this field's allowlist entry reject
   * the whole payload — same additive-field class as `mentions`.
   */
  isForwarded?: boolean;
  /**
   * Emoji reactions delivered out-of-band — an update that targets a
   * previously-sent message. When populated, clients treat this whole
   * envelope as a reaction update (body is empty), not a new message.
   */
  reaction?: {targetMsgId: string; emoji: string; remove?: boolean};
  /**
   * @-mentions carried alongside `body`. `label` is the exact text the
   * sender typed AFTER the `@`, so the receiver can highlight the span
   * without offsets (which would rot the moment the body is edited) and
   * can tell "I was mentioned" from the userId list alone.
   *
   * Rendering matches by label, longest-first, so "Ali" cannot swallow a
   * mention of "Alice". Labels are NOT trusted as identity — the chip
   * renders the sender's chosen text, exactly like the body does.
   */
  mentions?: SealedMention[];
  /**
   * Edit of a previously-sent message. Like `reaction`, this is a control
   * envelope: `body` is empty and clients patch the target rather than
   * appending a bubble.
   *
   * SECURITY: the receiver applies this ONLY when the authenticated sender
   * is the target's original author (see runtime/messageMutationGate.ts).
   * `editedAt` is the sender's clock and is used solely to order two
   * competing edits — never to authorise one.
   */
  edit?: {targetMsgId: string; body: string; editedAt: number; mentions?: SealedMention[]};
  /**
   * "Delete for everyone" — retract a previously-sent message. Control
   * envelope, same shape rules as `edit`: empty body, patches the target
   * into a tombstone instead of appending.
   *
   * SECURITY: author-only, enforced receiver-side by the same gate as
   * `edit`. A delete is not reversible, so the gate fails CLOSED — an
   * unresolvable author is a drop, not an apply.
   */
  deleteFor?: {targetMsgId: string; deletedAt: number};
  /**
   * Out-of-band control message. Currently only `'rehandshake'`:
   * receiver-issued nudge sent after auto-rebuild on `DecryptError`.
   * The act of decrypting it (a fresh PreKeyWhisperMessage) makes
   * libsignal session-replace on the original sender's side, healing
   * the ratchet without user action. The recipient does NOT render
   * a control envelope — it's discarded after the session swap.
   */
  control?: 'rehandshake';
  /**
   * Group-call participant identity advertisement. Sent over the
   * existing E2E pairwise Signal session at SFU `sfu.join` time so
   * peers can map the SFU-assigned opaque `participantTag` (which the
   * SFU intentionally does not associate with a userId) to a human
   * display name. Without this, group-call tiles can only show the
   * first 8 characters of the random tag.
   *
   * Privacy invariant preserved: the SFU access log still contains only
   * tags. The mapping lives entirely on each client, end-to-end
   * encrypted in transit through the messenger relay.
   *
   * Recipient does NOT render this as a chat bubble — the runtime
   * routes it into a per-room identity registry consulted by
   * `useGroupCall` / `GroupCallScreen`.
   */
  groupCallPresence?: {
    roomId:         string;
    participantTag: string;
    displayName:    string;
    callType:       'voice' | 'video';
  };
}

export interface SealOptions {
  attachment?:   SealedAttachment;
  expiresAtSec?: number;
  clientMsgId?:  string;
  group?:        SealedGroup;
  replyTo?:      {msgId: string; preview: string};
  isForwarded?:  boolean;
  reaction?:     {targetMsgId: string; emoji: string; remove?: boolean};
  mentions?:     SealedMention[];
  edit?:         SealedPayload['edit'];
  deleteFor?:    SealedPayload['deleteFor'];
  control?:      'rehandshake';
  groupCallPresence?: SealedPayload['groupCallPresence'];
  /**
   * Round 5 / Security S1 — recipient address + sender clock to be
   * stamped into `aad` at seal time. When present, recipient verifies.
   * Callers that don't pass `aad` produce a v3 envelope WITHOUT the
   * binding (back-compat with pre-S1 receivers + non-Bravo peers).
   * Production code SHOULD always pass aad. Tests + legacy code paths
   * may omit it.
   */
  aad?: SealedAad;
}

/**
 * Produce the JSON string that should be passed to `SessionCipher.encrypt`.
 * The cert is typically refreshed from auth-service every ~1h; callers
 * cache it and pass it here for each outgoing message.
 */
export function sealPayload(cert: string, body: string, opts: SealOptions = {}): string {
  if (!cert) {throw new CryptoError('missing sender cert');}
  const wrapped: SealedPayload = {v: SEALED_VERSION, cert, body};
  if (opts.attachment)   {wrapped.attachment   = opts.attachment;}
  // Fix #2 — the previous `if (opts.expiresAtSec)` falsy-coerced `0` to
  // mean "absent". `0` is a legitimate expiry (epoch 1970) used in tests
  // and could become a valid sentinel later; gate on type instead so
  // every numeric input round-trips faithfully.
  if (typeof opts.expiresAtSec === 'number') {wrapped.expiresAtSec = opts.expiresAtSec;}
  if (opts.clientMsgId)  {wrapped.clientMsgId  = opts.clientMsgId;}
  if (opts.group)        {wrapped.group        = opts.group;}
  if (opts.replyTo)      {wrapped.replyTo      = opts.replyTo;}
  // MM-09 — stamp only when true: false must not cost bytes on every send.
  if (opts.isForwarded === true) {wrapped.isForwarded = true;}
  if (opts.reaction)     {wrapped.reaction     = opts.reaction;}
  // Only stamp a non-empty list: an empty array would round-trip as a
  // meaningful "this message mentions nobody" and cost bytes on every send.
  if (opts.mentions?.length) {wrapped.mentions = opts.mentions;}
  if (opts.edit)         {wrapped.edit         = opts.edit;}
  if (opts.deleteFor)    {wrapped.deleteFor    = opts.deleteFor;}
  if (opts.control)      {wrapped.control      = opts.control;}
  if (opts.groupCallPresence) {wrapped.groupCallPresence = opts.groupCallPresence;}
  // Round 5 / Security S1 — recipient + timestamp binding. Stamped here
  // so it lives INSIDE the libsignal ciphertext. Sender's local clock
  // is used (NTP-aligned in practice); receiver tolerates ±15min skew.
  if (opts.aad)          {wrapped.aad          = opts.aad;}
  return JSON.stringify(wrapped);
}

/**
 * Round 5 / Security S1 — clock-skew window for the aad timestamp
 * check. 15 minutes covers offline-then-online laggy delivery (the
 * relay holds messages up to a few minutes; mobile networks can lag a
 * single message by tens of seconds), without giving an attacker a
 * useful replay window. Aligns with the sender-cert iat/exp window so
 * a fresh cert + fresh aad produce the same effective freshness.
 */
export const SEALED_AAD_SKEW_MS = 15 * 60 * 1000;

/**
 * Audit MEDIUM-1 (2026-07-02) — FUTURE-timestamp tolerance, separate from the
 * 15-min skew above. The future bound was 15 min against the RECEIVER's own
 * device clock, so a sender whose clock runs fast (or a receiver whose clock
 * runs slow) had EVERY message hard-dropped and ACKed off the relay — silent
 * permanent loss for a real slice of the user base with mis-set clocks.
 *
 * The Double Ratchet already makes replay impossible (message keys are
 * single-use) and the persistent seen-store catches exact re-injection, so
 * this timestamp bound is only a sanity heuristic — not the replay defence.
 * Widening it to 24h eliminates the false-positive data loss for realistically
 * mis-set clocks (NTP drift, wrong hour/AM-PM) while still rejecting an
 * absurdly far-future stamp. A device off by more than a day is genuinely
 * broken and the drop is acceptable.
 */
export const SEALED_AAD_FUTURE_MS = 24 * 60 * 60 * 1000;

/**
 * Audit MSG-01 (2026-07-02) — maximum age of a sealed envelope's AAD
 * timestamp before it is rejected as a replay. This is the ANTI-REPLAY
 * (staleness) bound and is DELIBERATELY separate from the clock-skew bound
 * above.
 *
 * The clock-skew window (±15 min) was originally used for BOTH the "future"
 * and "stale" checks. That was correct for the future bound (no legitimate
 * message is timestamped in the future beyond clock skew) but WRONG for the
 * stale bound in a store-and-forward system: the relay legitimately holds an
 * envelope for up to its 30-day dwell before the recipient comes online, so
 * an envelope decrypted 20 minutes — or 20 days — after it was sealed is
 * perfectly legitimate. The 15-min stale window silently dropped every
 * offline/overnight backlog message (and every outbox re-send that landed
 * >15 min later), ACKing it off the relay so it was lost forever, while the
 * sender's bubble still showed "sent".
 *
 * Setting the stale bound to the relay dwell means the anti-replay window is
 * exactly as wide as the window in which the relay could itself deliver a
 * captured envelope — i.e. no MORE replay surface than the relay's own dwell
 * already permits. Exact re-injection is still caught by the persistent
 * seen-envelope store; this bound guards against re-injection of an
 * envelope older than the relay could ever have held.
 */
export const SEALED_AAD_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface VerifyAadParams {
  /** The sealed payload coming back from unsealPayload. */
  sealed:           SealedPayload;
  /** The receiver's own address — must match aad.to. */
  selfUserId:       string;
  selfDeviceId:     number;
  /** Defaults to Date.now(); override for deterministic tests. */
  now?:             number;
  /** Legacy alias retained for callers. Not used for the future bound anymore. */
  clockSkewMs?:     number;
  /**
   * Audit MEDIUM-1 — defaults to SEALED_AAD_FUTURE_MS (24h). Bounds the FUTURE
   * timestamp check. Wide enough to tolerate a mis-set device clock without
   * silently dropping the message; replay is prevented by the ratchet, not this.
   */
  futureMs?:        number;
  /**
   * Audit MSG-01 — defaults to SEALED_AAD_MAX_AGE_MS (relay dwell). Bounds
   * the STALE (anti-replay) check. Kept separate from the future bound so a
   * store-and-forward envelope delivered long after it was sealed is not
   * dropped.
   */
  maxAgeMs?:        number;
  /**
   * Audit S10 + P0-N1 — when true (default), missing AAD is treated as
   * a verification failure (`reason: 'missing'`). Set to FALSE only
   * for the legacy rollout-compatibility path (driven by the
   * EXPO_PUBLIC_SEALED_AAD_LEGACY env flag in productionRuntime).
   *
   * History: pre-S10 (commit 2a7fd35) the function returned
   * `{ok: true, aad: undefined}` whenever AAD was absent, which
   * silently disabled the replay-protection feature for any sender
   * that omitted it. S10 added the `requireAad` opt-in; P0-N1
   * (this commit) makes opt-in the default so a future call site
   * that forgets the parameter inherits fail-closed behaviour
   * instead of silently re-opening the replay window.
   */
  requireAad?:      boolean;
  /**
   * Audit P0-N2 — extended AAD verification.
   *
   * Each expected* field is checked ONLY when both the wire AAD carries
   * the corresponding field AND the caller has supplied an expected
   * value. Absent-on-either-side is the legacy path. Senders that have
   * shipped a v3+P0-N2 build always include every field that applies;
   * receivers tighten verification once `requireExtendedAad` is set
   * (deferred — for now extensions are best-effort).
   */
  /** Expected sender — usually the unsealed cert's subject. */
  expectedSender?:         {userId: string; deviceId: number};
  /** Expected conversation id (1:1 thread id OR groupId). */
  expectedConversationId?: string;
  /** Expected group id (for group posts). */
  expectedGroupId?:        string;
  /** Expected group epoch (rejects ciphertext sealed under an older epoch). */
  expectedEpoch?:          number;
}

/**
 * Round 5 / Security S1 — verify the AAD binding, if present.
 *
 *   `{ok: true,  aad}` when verification succeeds.
 *   `{ok: false, reason}` when the binding is wrong.
 *   `{ok: true,  aad: undefined}` when no aad on the wire AND
 *      requireAad is not set (legacy sender — caller decides whether
 *      to accept based on policy).
 *   `{ok: false, reason: 'missing'}` when requireAad is true and
 *      the wire didn't carry an AAD block.
 *
 * The function does NOT throw — callers can choose to fail-open during
 * the rollout window (e.g. log + continue) and fail-closed once all
 * peers have shipped v3 senders.
 */
export type SealedAadReason =
  | 'recipient_mismatch'
  | 'stale'
  | 'future'
  | 'malformed'
  | 'missing'
  | 'sender_mismatch'
  | 'conversation_mismatch'
  | 'group_mismatch'
  | 'epoch_stale';

export function verifySealedAad(p: VerifyAadParams):
  | {ok: true;  aad: SealedAad | undefined}
  | {ok: false; reason: SealedAadReason} {
  const aad = p.sealed.aad;
  if (!aad) {
    // Audit P0-N1 — default is fail-closed. The rollout escape hatch
    // is `requireAad: false` (explicit), driven by the production
    // runtime's SEALED_AAD_LEGACY env flag.
    const requireAad = p.requireAad ?? true;
    if (requireAad) {return {ok: false, reason: 'missing'};}
    return {ok: true, aad: undefined};
  }
  if (typeof aad.ts !== 'number' || !aad.to) {return {ok: false, reason: 'malformed'};}
  if (aad.to.userId !== p.selfUserId) {return {ok: false, reason: 'recipient_mismatch'};}
  // Audit P0-N3 — deviceId=0 wildcard is no longer accepted. The
  // previous comment claimed "treat as wildcard" but Phase-1 every
  // account is deviceId=1; an AAD carrying deviceId=0 was either a
  // buggy sender we want to retire or an attacker stripping the
  // recipient binding to widen replay scope. We now require deviceId
  // to be a positive integer that matches selfDeviceId.
  if (typeof aad.to.deviceId !== 'number' || aad.to.deviceId < 1) {
    return {ok: false, reason: 'malformed'};
  }
  if (aad.to.deviceId !== p.selfDeviceId) {
    return {ok: false, reason: 'recipient_mismatch'};
  }
  const now = p.now ?? Date.now();
  // `clockSkewMs` is retained for API back-compat but no longer bounds the
  // future check (MEDIUM-1) — futureMs does. Referenced here so it isn't a
  // dead param for callers that still pass it.
  void (p.clockSkewMs ?? SEALED_AAD_SKEW_MS);
  // Audit MSG-01 — the STALE bound is the relay dwell (30d), NOT the clock
  // skew. A message the relay legitimately held for the recipient must not
  // be dropped as "stale". The FUTURE bound stays at the tight clock-skew
  // window (no legitimate message is timestamped ahead of now beyond skew).
  const maxAge = p.maxAgeMs ?? SEALED_AAD_MAX_AGE_MS;
  // Audit MEDIUM-1 — the FUTURE bound uses the wide clock-skew tolerance
  // (SEALED_AAD_FUTURE_MS), not the tight 15-min `skew`, so a mis-set sender/
  // receiver clock no longer causes silent permanent message loss. Replay is
  // still fully prevented by the ratchet + seen-store, independent of this ts.
  const futureMs = p.futureMs ?? SEALED_AAD_FUTURE_MS;
  if (aad.ts < now - maxAge) {return {ok: false, reason: 'stale'};}
  if (aad.ts > now + futureMs) {return {ok: false, reason: 'future'};}
  // Audit P0-N2 — extended AAD checks. Each is opt-in via the wire
  // field being present AND the caller supplying an expected value.
  // Absent-on-either-side is the legacy back-compat path until all
  // senders have shipped P0-N2.
  if (aad.sender && p.expectedSender) {
    if (aad.sender.userId !== p.expectedSender.userId ||
        aad.sender.deviceId !== p.expectedSender.deviceId) {
      return {ok: false, reason: 'sender_mismatch'};
    }
  }
  if (aad.conversationId && p.expectedConversationId &&
      aad.conversationId !== p.expectedConversationId) {
    return {ok: false, reason: 'conversation_mismatch'};
  }
  if (aad.groupId && p.expectedGroupId && aad.groupId !== p.expectedGroupId) {
    return {ok: false, reason: 'group_mismatch'};
  }
  if (typeof aad.epoch === 'number' && typeof p.expectedEpoch === 'number' &&
      aad.epoch < p.expectedEpoch) {
    return {ok: false, reason: 'epoch_stale'};
  }
  return {ok: true, aad};
}

/**
 * Audit 1:1 P1-8 — version-rejection counter. The runtime can read this
 * to surface "N messages dropped because the wire version was outside
 * [MIN_SEALED_VERSION..SEALED_VERSION]". Without it, a rollout that
 * accidentally shipped a v=4 sender into a v3-max fleet silently
 * dropped every envelope from the upgraded device with no telemetry to
 * correlate against. Module-level counter (not an import-time export
 * because the receive path lives in a separate Jest project that
 * doesn't link this).
 */
const versionRejectStats = {count: 0, lastVersion: 0, lastAt: 0};
export function _getVersionRejectStats(): {count: number; lastVersion: number; lastAt: number} {
  return {...versionRejectStats};
}

/**
 * Parse the JSON produced by `SessionCipher.decrypt` into its parts.
 * Rejects unknown versions so unhandled fields can't silently drop.
 */
export function unsealPayload(plaintext: string): SealedPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch (e) {
    throw new CryptoError('sealed payload is not JSON', e);
  }
  if (!isSealedPayload(parsed)) {
    throw new CryptoError('sealed payload shape invalid');
  }
  // Audit fix #4 — accept v >= MIN_SEALED_VERSION rather than equality.
  // Older clients in flight during a staggered rollout still need to
  // talk to us; rejecting them silently dropped legitimate messages.
  if (parsed.v < MIN_SEALED_VERSION || parsed.v > SEALED_VERSION) {
    // Audit 1:1 P1-8 — record before throwing so the runtime's crashLog
    // breadcrumb (see receive path) has a counter to summarise across a
    // backlog drain rather than one error line per envelope.
    versionRejectStats.count      += 1;
    versionRejectStats.lastVersion = parsed.v;
    versionRejectStats.lastAt      = Date.now();
    throw new CryptoError(`unsupported sealed version ${parsed.v}`);
  }
  // v:1 has no `attachment` or `expiresAtSec` on the wire even when our
  // type guard accepts the field; strip anything an older sender might
  // have sneaked in so downstream code doesn't trust v1-shaped payloads
  // with v2 fields. (Per-version branch lives here, not in isSealedPayload,
  // because the guard is shape-only — it doesn't see version semantics.)
  if (parsed.v < 2) {
    delete parsed.attachment;
    delete parsed.expiresAtSec;
  }
  // Round 5 / Security S1 — `aad` only meaningful in v3+. Older versions
  // can't have produced it; strip if present so a hostile peer can't
  // confuse the receiver by stamping a v2 envelope with an aad block.
  if (parsed.v < 3) {
    delete parsed.aad;
  }
  return parsed;
}

/**
 * Audit fix #3 — the original guard accepted any value for the optional
 * `clientMsgId`, `replyTo`, `reaction`, `control`, `groupCallPresence`
 * fields. A malformed sender (or a tampered payload that survived the
 * outer wrap because of a bug we haven't found yet) could push, e.g.,
 * `replyTo: {msgId: 42}` and crash the renderer when it called
 * `.slice(...)` on a number. Validate every optional field's shape so
 * the rest of the runtime can trust the SealedPayload typing.
 */
const SEALED_PAYLOAD_KEYS = new Set([
  'v', 'cert', 'body', 'attachment', 'expiresAtSec', 'clientMsgId',
  'group', 'replyTo', 'isForwarded', 'reaction', 'mentions', 'edit', 'deleteFor',
  'control', 'groupCallPresence', 'aad',
]);
const SEALED_AAD_KEYS = new Set([
  'ts', 'to', 'sender', 'conversationId', 'groupId', 'epoch',
]);

function isSealedPayload(x: unknown): x is SealedPayload {
  if (!x || typeof x !== 'object') {return false;}
  const o = x as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    if (!SEALED_PAYLOAD_KEYS.has(k)) {return false;}
  }
  if (typeof o.v !== 'number')    {return false;}
  if (typeof o.cert !== 'string') {return false;}
  if (typeof o.body !== 'string') {return false;}
  if (o.attachment !== null && o.attachment !== undefined) {
    if (typeof o.attachment !== 'object') {return false;}
    const a = o.attachment as Record<string, unknown>;
    if (typeof a.objectKey !== 'string') {return false;}
    if (typeof a.keyB64    !== 'string') {return false;}
    if (typeof a.ivB64     !== 'string') {return false;}
    if (typeof a.mimeType  !== 'string') {return false;}
    if (typeof a.size      !== 'number') {return false;}
    // Fix #3 posture for the optional metadata block (media parity,
    // 2026-07-03): wrong-typed hints must fail validation up front, not
    // crash the renderer. Bounds keep a hostile sender from smuggling a
    // multi-megabyte "thumbnail" past the envelope (64 KB b64 ≈ 48 KB
    // JPEG — far above the honest ~20 KB, well below abuse size).
    if (a.kind       !== undefined && typeof a.kind       !== 'string') {return false;}
    if (a.name       !== undefined && (typeof a.name !== 'string' || a.name.length > 256)) {return false;}
    if (a.width      !== undefined && typeof a.width      !== 'number') {return false;}
    if (a.height     !== undefined && typeof a.height     !== 'number') {return false;}
    if (a.durationMs !== undefined && typeof a.durationMs !== 'number') {return false;}
    if (a.thumbB64   !== undefined && (typeof a.thumbB64 !== 'string' || a.thumbB64.length > 64 * 1024)) {return false;}
  }
  if (o.expiresAtSec !== null && o.expiresAtSec !== undefined && typeof o.expiresAtSec !== 'number') {return false;}
  if (o.clientMsgId !== null && o.clientMsgId !== undefined && typeof o.clientMsgId !== 'string') {return false;}
  if (o.group !== null && o.group !== undefined) {
    if (typeof o.group !== 'object') {return false;}
    const g = o.group as Record<string, unknown>;
    if (typeof g.groupId    !== 'string') {return false;}
    if (typeof g.kind       !== 'string') {return false;}
    if (g.kind !== 'text' && g.kind !== 'admin') {return false;}
    if (typeof g.clientMsgId !== 'string') {return false;}
    // The wire-compat carrier (see SealedGroup). Type-checked when present, so
    // a malformed peer still cannot reach the renderer with a bad shape.
    //
    // DELIBERATELY no `for (const k of Object.keys(g))` rejection here. That
    // omission is what lets a client that predates a field ignore it instead of
    // destroying the message, and it is the entire reason these fields live in
    // `group` rather than at the top level. Adding key iteration to this branch
    // would re-introduce the bug for the NEXT field someone adds.
    if (g.mentions !== undefined && !isMentionList(g.mentions)) {return false;}
    if (g.edit !== undefined && !isEditDirective(g.edit)) {return false;}
    if (g.deleteFor !== undefined && !isDeleteDirective(g.deleteFor)) {return false;}
    if (g.isForwarded !== undefined && typeof g.isForwarded !== 'boolean') {return false;}
  }
  if (o.replyTo !== null && o.replyTo !== undefined) {
    if (typeof o.replyTo !== 'object') {return false;}
    const r = o.replyTo as Record<string, unknown>;
    if (typeof r.msgId   !== 'string') {return false;}
    if (typeof r.preview !== 'string') {return false;}
  }
  if (o.isForwarded !== null && o.isForwarded !== undefined && typeof o.isForwarded !== 'boolean') {return false;}
  if (o.reaction !== null && o.reaction !== undefined) {
    if (typeof o.reaction !== 'object') {return false;}
    const r = o.reaction as Record<string, unknown>;
    if (typeof r.targetMsgId !== 'string') {return false;}
    if (typeof r.emoji       !== 'string') {return false;}
    if (r.remove !== undefined && typeof r.remove !== 'boolean') {return false;}
  }
  if (o.mentions !== null && o.mentions !== undefined) {
    if (!isMentionList(o.mentions)) {return false;}
  }
  if (o.edit !== null && o.edit !== undefined) {
    if (!isEditDirective(o.edit)) {return false;}
  }
  if (o.deleteFor !== null && o.deleteFor !== undefined) {
    if (!isDeleteDirective(o.deleteFor)) {return false;}
  }
  if (o.control !== null && o.control !== undefined) {
    if (o.control !== 'rehandshake') {return false;}
  }
  if (o.groupCallPresence !== null && o.groupCallPresence !== undefined) {
    if (typeof o.groupCallPresence !== 'object') {return false;}
    const p = o.groupCallPresence as Record<string, unknown>;
    if (typeof p.roomId         !== 'string') {return false;}
    if (typeof p.participantTag !== 'string') {return false;}
    if (typeof p.displayName    !== 'string') {return false;}
    if (p.callType !== 'voice' && p.callType !== 'video') {return false;}
  }
  // Round 5 / Security S1 — validate aad shape. Wrong shape ≠ tamper
  // (the inner Signal ratchet is what authenticates), but a malformed
  // aad would crash verifySealedAad, so reject the whole envelope.
  // Audit P0-N2 — extended optional fields validated when present.
  if (o.aad !== null && o.aad !== undefined) {
    if (typeof o.aad !== 'object') {return false;}
    const a = o.aad as Record<string, unknown>;
    // Audit P1-N9 — reject unknown AAD fields so downstream walkers can't
    // be tricked into honouring attacker-injected keys.
    for (const k of Object.keys(a)) {
      if (!SEALED_AAD_KEYS.has(k)) {return false;}
    }
    if (typeof a.ts !== 'number') {return false;}
    if (!a.to || typeof a.to !== 'object') {return false;}
    const to = a.to as Record<string, unknown>;
    if (typeof to.userId !== 'string') {return false;}
    if (typeof to.deviceId !== 'number') {return false;}
    if (a.sender !== undefined) {
      if (!a.sender || typeof a.sender !== 'object') {return false;}
      const s = a.sender as Record<string, unknown>;
      if (typeof s.userId !== 'string') {return false;}
      if (typeof s.deviceId !== 'number') {return false;}
    }
    if (a.conversationId !== undefined && typeof a.conversationId !== 'string') {return false;}
    if (a.groupId !== undefined && typeof a.groupId !== 'string') {return false;}
    if (a.epoch !== undefined && typeof a.epoch !== 'number') {return false;}
  }
  return true;
}
