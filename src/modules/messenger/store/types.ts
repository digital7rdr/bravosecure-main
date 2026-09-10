import type { Message as BaseMessage, Conversation as BaseConversation, MessageStatus } from '@appTypes/index';
import type { Ciphertext, SessionAddress } from '@bravo/messenger-core';
import type { EnvelopeId, UserId } from '../conversationIds';

/**
 * Local-only message shape. Extends the shared API Message with
 * crypto-layer fields that never leave the device. `content` is
 * plaintext — the ciphertext field is kept for debug/replay only
 * and must NOT be passed to any logger.
 */
export interface LocalMessage extends BaseMessage {
  peer: SessionAddress;
  /**
   * Server-issued envelope id this message corresponds to. Set on
   * inbound messages (so we can ACK + send read-receipt by id) and
   * on outbound messages once `envelope.accepted` returns. Persisted
   * so receipts survive app restarts.
   */
  envelope_id?: EnvelopeId;
  /**
   * SYNC-1 — recipient userId → the relay envelope id minted for THAT
   * recipient's copy. Group fan-out submits one envelope per member, so
   * the scalar `envelope_id` can only ever match participants[0]'s
   * receipt and B-116's "every participant has read" aggregate is
   * unreachable. Absent on 1:1 rows (the scalar is sufficient there).
   */
  envelope_ids?: Record<UserId, EnvelopeId>;
  /**
   * B-116 — per-member receipt attribution for OWN messages (WhatsApp
   * "Message info"): userId → {status, ts}. Populated from read-receipt
   * frames (the gateway stamps `from` from the authed socket). For group
   * rows the scalar `status` flips to 'read' only when EVERY other
   * participant has a read receipt here (WhatsApp semantics); 1:1 keeps
   * its single-peer behavior. Additive optional field — old rows and
   * backup mirrors without it decode unchanged.
   */
  receipts?: Record<string, {status: 'delivered' | 'read'; ts: number}>;
  /**
   * B-683 — per-member terminal-destroy attribution for OWN group messages
   * (userId → first-noted epoch ms), the failure-side pair to `receipts`.
   * Populated from `envelope.undeliverable` / receipt-poll `discarded`
   * verdicts. The scalar `status` flips to 'undelivered' only when EVERY
   * current participant has a shipped leg here-and-dead (see
   * recordUndeliverableLeg); a partial failure keeps the bubble honest.
   * Additive optional field — old rows and backup mirrors without it
   * decode unchanged.
   */
  undeliverable_legs?: Record<string, number>;
  /** Last ciphertext we produced/consumed for this message. Not persisted to disk. */
  ciphertext?: Ciphertext;
  /** epoch ms for disappearing messages (wired in M7, schema-ready now). */
  expires_at?: number;
  /** Reply/quote — id of the message being replied to (opaque client id). */
  reply_to_msg_id?: string;
  /** Plaintext preview of the quoted message, chosen by the sender. */
  reply_to_preview?: string;
  /**
   * MM-09 — the sender forwarded this from another conversation. Display
   * metadata only (the "Forwarded" chip); rides the sealed payload's
   * `isForwarded`, persists in schema v19's `is_forwarded` column.
   */
  is_forwarded?: boolean;
  /**
   * Emoji reactions folded onto this message. Keyed by the reactor's
   * userId so multiple reactions from the same user replace, not
   * stack. `{'u-alice': '❤️', 'u-bob': '😂'}`.
   */
  reactions?: Record<string, string>;
  /**
   * @-mentions carried with this message. `label` is the literal text the
   * sender typed after the `@`; the renderer highlights those spans and
   * `userId` drives the "you were mentioned" notification + badge.
   *
   * Matched by label rather than by character offsets deliberately: an edit
   * rewrites the body, and stored offsets would silently point at the wrong
   * span the moment it did.
   */
  mentions?: Array<{userId: string; label: string}>;
  /**
   * Epoch ms of the last accepted edit of this message, or absent if it has
   * never been edited. Drives the "edited" marker and, on the receive side,
   * orders two competing edits — a directive older than this is ignored, so
   * out-of-order delivery cannot resurrect a superseded body.
   */
  edited_at?: number;
  /**
   * "Delete for everyone" tombstone. The row is KEPT (so replies pointing at
   * it and the surrounding ordering stay coherent) with its content, media
   * and reactions stripped; the renderer shows "This message was deleted".
   *
   * One-way: nothing ever clears this, and an edit for a tombstoned row is
   * dropped. Deleting is not reversible and must not be un-done by a
   * late-arriving edit that was in flight when the delete was sent.
   */
  deleted_for_all?: boolean;
  /**
   * Capability token returned by the relay on submit. Lets the sender
   * retract this envelope from the relay queue (e.g. on TTL expiry,
   * "delete for everyone"). Only present on outgoing messages —
   * recipients never see it. Stored locally; loss = wait for dwell.
   */
  retract_token?: string;
  /**
   * B-187 — per-recipient retract tokens for a group fan-out (userId →
   * token), the pair to `envelope_ids`. The scalar above stays first-wins
   * for the retract/delete flows; THIS map is what lets the HTTP receipt
   * poll probe EVERY leg, so ✓✓ can mean "all members have it" instead of
   * "the first leg has it". Absent on 1:1 rows and rows predating the
   * schema-v19 migration (those grandfather to the scalar single-probe).
   */
  retract_tokens?: Record<string, string>;
  /**
   * R2 object key when the message carries an attachment. Populated
   * on both inbound and outbound paths so the expiry sweeper, retract
   * flow, and conversation-clear handler can purge the corresponding
   * cached ciphertext blob. Without this, evicted messages would
   * orphan their cache entries. Never used as an auth token —
   * downloads still require the per-file AES key from the sealed
   * envelope.
   */
  media_object_key?: string;
  /**
   * Optional declared mime type for the attachment. The renderer uses
   * it to pick the right viewer (image / audio / pdf / generic file).
   * Carried inside the sealed payload as part of `attachment.mimeType`;
   * stored on the LocalMessage so the row remains self-describing
   * after a backup restore.
   */
  media_mime?: string;
  /**
   * Round 8 — per-file AES-256 key used to decrypt the encrypted blob
   * fetched from R2, base64. Without this, restored attachments are
   * unrecoverable ciphertext (the R2 object is plaintext-blind to us
   * by design). Previously the key only travelled inside the sealed
   * envelope and was consumed once at receive time, so on reinstall
   * every attachment became a broken-bubble. Mirrored alongside the
   * message ciphertext in the encrypted backup payload.
   *
   * Sender + recipient both populate this when present; the renderer
   * pairs it with `media_iv` to drive AES-CBC + HMAC-SHA256 decrypt.
   * Never sent in cleartext over the wire — only ever inside the
   * E2E-wrapped payload (live envelope) or AES-GCM-wrapped backup row.
   */
  media_key?: string;
  /**
   * Round 8 — per-file 16-byte IV for the AES-CBC attachment cipher,
   * base64. Pair of `media_key`. Same lifecycle — only ever inside
   * E2E-wrapped storage.
   */
  media_iv?: string;
  /**
   * Media-parity metadata (2026-07-03) carried in the sealed attachment
   * and persisted (media_meta_json, schema v13): display hints so the
   * bubble renders an instant preview with the right aspect ratio, a
   * real filename, and a duration label without touching the network.
   * `thumbB64` is a tiny sender-generated JPEG (≤~20 KB).
   */
  media_meta?: {
    name?:       string;
    width?:      number;
    height?:     number;
    durationMs?: number;
    thumbB64?:   string;
    sizeBytes?:  number;
  };
  /**
   * Call-record metadata when `type === 'call'`. Inserted by CallScreen
   * on call end so the conversation timeline shows incoming / outgoing /
   * missed / declined calls inline like WhatsApp does. Never sent over
   * the wire — purely a local UI artifact derived from CallScreen
   * lifecycle events.
   */
  call_meta?: {
    kind:      'voice' | 'video';
    direction: 'incoming' | 'outgoing';
    /**
     * Outcome derived from how the call ended.
     *   answered      — completed normally
     *   missed        — incoming, never picked up
     *   declined      — explicit decline
     *   failed        — connection failure
     *   ended-by-host — group call only: HOST left and the server
     *                   broadcast sfu.room.ended; this participant was
     *                   not the host. Renders as "Group call ended by
     *                   host" so the chat history matches what the
     *                   user just saw on screen instead of a generic
     *                   "Group voice call · 0:23".
     */
    outcome:   'answered' | 'missed' | 'declined' | 'failed' | 'ended-by-host';
    /** Duration in seconds. 0 for missed / declined. */
    duration:  number;
    /**
     * True when the bubble represents a group SFU call (not 1:1).
     * Tapping a group bubble should re-launch a group call via
     * `launchCall(...)`'s shouldRouteCallViaSfu branch rather than the
     * 1:1 CallScreen, and the row label includes a participant count
     * placeholder ("Group voice call · 3:42").
     */
    groupCall?: boolean;
  };
  /**
   * Structured payload for a `type === 'system'` membership/rename line so the
   * renderer can resolve names at RENDER time from the live roster, not bake
   * them at creation. The E2EE admin envelope that drives an auto-add (a newly
   * created CPO joining every org channel) carries NO display name, so the name
   * isn't in `groupMemberNames` when the "X added Y" row is synthesized and the
   * text froze as "Member <code>". By the time the thread is viewed the roster
   * has hydrated (DepartmentChatScreen's focus effect), so re-resolving live
   * shows the real name. `content` stays populated as a fallback for old rows /
   * backup mirrors / renderers that don't read this. Additive optional field.
   */
  event?:
    | {kind: 'member_added'; actorUserId: string; memberUserId: string}
    /** B-255 — the mirror of member_added. Adds left a trace; removals did not. */
    | {kind: 'member_removed'; actorUserId: string; memberUserId: string}
    | {kind: 'channel_renamed'; actorUserId: string | null; newName: string}
    /**
     * B-291 — the group picture was set or removed. `cleared` distinguishes the
     * two, because "changed the group photo" would be a lie for a removal and a
     * member seeing the disc come back deserves to know why.
     */
    | {kind: 'group_photo_changed'; actorUserId: string | null; cleared: boolean};
}

export interface LocalConversation extends BaseConversation {
  peer: SessionAddress;
  /**
   * Narrowed from the base `Message`. The store only ever assigns a full
   * `LocalMessage` snapshot here, and the chat-list preview has to be able to
   * read the local-only fields — `deleted_for_all` above all, or a retracted
   * message keeps rendering its text in the most visible surface in the app.
   */
  last_message?: LocalMessage;
  /**
   * Peer's phone in E.164, captured at contact discovery / chat creation.
   * Display-only (Chat Info "number under name"); the server's profile
   * endpoint deliberately never exposes phones, so this is the only source.
   */
  phoneE164?: string;
  /** Non-empty while the Signal session is being established / recovered. */
  session_state: 'fresh' | 'established' | 'error';
  /** Pinned rows float to the top of the chat list. Local-only for v1. */
  is_pinned?: boolean;
  /**
   * Default disappearing-message TTL (seconds) applied to every NEW
   * outgoing message in this conversation. Null = off. Per-message
   * overrides from the composer still win. Group chats use this to
   * enforce a shared burn window.
   */
  default_ttl_sec?: number | null;
  /**
   * Audit fix #33 — true when the user explicitly renamed this
   * conversation through the chat-info screen. The contact-discovery
   * sweep checks this flag before overwriting the conversation name
   * with the address-book label. Without this, a chat the user
   * renamed "Mom 🌸" would silently revert to "Sahana Begum"
   * (her registered Bravo name) the next time contact-sync ran.
   */
  is_custom_name?: boolean;
  /**
   * B-411 — provenance of `name`, so notification/title code can tell a saved
   * contact's label from a registered-directory name ("John · Unsaved") and
   * never render the `Bravo · <hex>` placeholder. STICKY across upserts:
   * upsertConversation keeps the previous flag when an incoming row carries
   * none AND the name is unchanged (a flagless rename clears it — unknown
   * provenance must not inherit a tag). If you write `name` anywhere, stamp
   * this field or knowingly rely on that rule; a spread-and-rename
   * (`{...prev, name: x}`) carries the OLD flag in explicitly, which the
   * store cannot detect. Writer census: docs/handoffs/
   * UNSAVED_CONTACT_NOTIFS_AND_WORKSPACE_HUB_2026-08-09.md §1c.2.
   */
  name_source?: 'custom' | 'contact' | 'profile' | 'placeholder';
}

export type { MessageStatus };
