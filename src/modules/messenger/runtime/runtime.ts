import { Platform } from 'react-native';
import {
  SessionManager,
  InMemoryProtocolStore,
  installIdentity,
  buildOwnPreKeyBundle,
  type CryptoStore,
  type Ciphertext,
  type SessionAddress,
} from '../crypto';
import { useMessengerStore } from '../store/messengerStore';
import type { LocalMessage } from '../store/types';
import type { ConversationId } from '../conversationIds';
import { getOrCreateDbKey } from './keychain';
import { emptyPullReport, type RelayPullReport } from './relayPullReport';
import { ExpirySweeper } from './expirySweeper';
import { computeSafetyNumber } from '../crypto/safetyNumber';

/**
 * Bravo Secure — Messenger Runtime.
 *
 * Owns the crypto-layer singletons for the app: our own SessionManager +
 * CryptoStore, and (in loopback mode) an in-process echo peer that lets
 * us prove UI ↔ crypto without a network. Real-network operation takes
 * over in M5 — at that point `processIncomingFromRelay` replaces the
 * loopback echo as the decrypt source.
 */

export const OWN_ADDRESS: SessionAddress = { userId: 'me', deviceId: 1 };
export const LOOPBACK_PEER: SessionAddress = { userId: 'echo@bravo.local', deviceId: 1 };

export type RuntimeMode = 'loopback-memory' | 'loopback-sqlcipher' | 'production';

/** Optional flags for `sendText`. M6/M7 additions are strictly opt-in. */
export interface SendTextOptions {
  /** Signal address of the recipient (production mode requires this). */
  peer?: SessionAddress;
  /**
   * Explicit group hint from the caller (ChatScreen knows this from its
   * route params). Lets the runtime take the group fan-out path even when
   * the conversation hasn't been hydrated from /conversations/mine yet —
   * without it, a group chat opened via push / deep-link / the live-tracker
   * dock before sync falls through to the 1:1 path and throws
   * "production mode requires explicit peer address".
   */
  isGroup?: boolean;
  /** M6: pre-encrypted attachment metadata produced by MediaClient.uploadEncrypted. */
  attachment?: import('../crypto').SealedAttachment;
  /** M7: time-to-live in seconds from now. Converted to absolute epoch-sec internally. */
  ttlSeconds?: number;
  /** Reply/quote metadata — surfaces a quote strip on the recipient's bubble. */
  replyTo?: {messageId: string; preview: string};
  /** MM-09 — forwarded from another conversation; renders the "Forwarded" chip. */
  isForwarded?: boolean;
  /**
   * @-mentions resolved by the composer. Shipped in-band so the recipient can
   * highlight the spans and detect "I was mentioned" without having to guess
   * from the body text (a display name is not a unique key).
   */
  mentions?: Array<{userId: string; label: string}>;
  /**
   * P2-12 — reuse an ALREADY-APPENDED optimistic bubble instead of minting a
   * new one. `sendMedia` appends its `sending` bubble BEFORE the upload so an
   * upload failure has a durable failed bubble; it then hands that bubble's id
   * here so `sendText` runs crypto/outbox/fan-out against it without appending
   * a duplicate. When set, `sendText` skips its own `appendMessage`.
   */
  existingMsgId?: string;
  /**
   * B-122 — rebuild the pairwise session from the peer's CURRENT
   * authority-signed bundle before sealing (1:1 only). Set by the retry chip
   * for an `undelivered` bubble: the recipient destroyed the original because
   * the cached identity/session was dead, so re-wrapping against it would
   * only get destroyed again. Same recovery B-46's auto-resend performs.
   */
  freshSession?: boolean;
  /**
   * B-361 — caller-supplied id for the optimistic bubble (the append still
   * runs, unlike `existingMsgId`). The notification-action drain retries a
   * queued reply on every reconnect; each attempt used to mint a fresh id, so
   * every failed attempt stacked ANOTHER "tap to retry" bubble of the same
   * text. With a stable id, appendMessage's id dedup makes retries reuse the
   * one bubble and a late success flips that same row to sent.
   */
  stableMsgId?: string;
}

export interface MessengerRuntime {
  mode: RuntimeMode;
  own: SessionManager;
  /** Loopback-only: the in-process echo peer used to exercise encrypt+decrypt end-to-end. */
  echoPeer?: SessionManager;
  /**
   * Encrypt + persist an outgoing plaintext. In loopback mode also fires
   * a delayed auto-reply so the UI can observe the full round-trip.
   * In production this is the only entry point for ChatScreen → crypto.
   *
   * The 3rd arg may be either a bare SessionAddress (legacy shape used
   * by loopback) or a SendTextOptions object (production mode, carries
   * attachment + expiry). Both are supported at runtime.
   */
  sendText(conversationId: string, text: string, peerOrOpts?: SessionAddress | SendTextOptions): Promise<void>;

  /**
   * Encrypted-attachment send. Encrypts `bytes` locally (AES-256-CBC,
   * fresh per-file key), uploads the ciphertext to object storage, then
   * ships a normal sealed message whose `attachment` field carries the
   * per-file key + object key in-band. After the envelope mints, the
   * recipient set is registered as download grants.
   *
   *   kind     — 'image' | 'audio' | 'video' | 'file'; drives the
   *              recipient-side bubble renderer + local row `type`.
   *   caption  — optional text shown under the media (may be empty).
   *
   * Loopback runtimes stub this (no real upload path).
   */
  sendMedia?(
    conversationId: string,
    media: {
      bytes: Uint8Array;
      mimeType: string;
      kind: 'image' | 'audio' | 'video' | 'file';
      /**
       * Media-parity metadata (2026-07-03): optional display hints that
       * travel inside the sealed envelope — filename, pixel dimensions,
       * duration, and a tiny sender-generated JPEG thumbnail (b64).
       */
      meta?: {name?: string; width?: number; height?: number; durationMs?: number; thumbB64?: string};
    },
    opts?: {
      peer?: SessionAddress;
      caption?: string;
      ttlSeconds?: number;
      isGroup?: boolean;
      /**
       * B-450 — replying WITH an attachment. Same shape as `SendTextOptions.replyTo`;
       * `sendMedia` stamps it on the optimistic bubble it appends (sendText skips
       * its own append when handed `existingMsgId`, so nothing else would) and
       * forwards it to `sendText`, which caps and ships it on every send site.
       */
      replyTo?: {messageId: string; preview: string};
    },
  ): Promise<void>;

  /**
   * Fetch + decrypt a previously-received attachment, returning the
   * plaintext bytes. Uses the persistent blob cache so a second view
   * skips the network. Throws if the per-file key/iv are missing or the
   * HMAC fails (tampered / wrong key). Loopback stubs this.
   */
  downloadMedia?(params: {objectKey: string; keyB64: string; ivB64: string}): Promise<Uint8Array>;

  // ── Incident-evidence reuse seam (Dept Chat v2 · Step 10; production only) ──
  // Additive, thin exposure of the existing media + sealed-sender primitives for
  // the Departmental incident flow. Loopback stubs (optional). No existing path
  // is affected.
  /** Encrypt + upload `bytes`; returns the object key + per-file key/iv (NOT shipped in a message). */
  uploadEvidence?(bytes: Uint8Array, mimeType: string): Promise<{objectKey: string; keyB64: string; ivB64: string; size: number}>;
  /** Grant a set of users download access to an uploaded object (Redis grant). */
  grantMediaAccess?(objectKey: string, recipientUserIds: string[]): Promise<void>;
  /** Seal a small payload to one recipient device's identity (outer ECIES); returns the base64 blob. */
  sealOuterTo?(recipientUserId: string, recipientDeviceId: number, body: string): Promise<string>;
  /** Open a blob sealed to THIS device with openOuter; returns the inner payload string. */
  openOuterAsSelf?(outerSealedB64: string): Promise<string>;

  /** M5+ — fed from the WebSocket transport once the relay is live. */
  processIncoming(
    conversationId: ConversationId,
    peer: SessionAddress,
    ciphertext: Ciphertext
  ): Promise<void>;

  // ─── Presence + live-signal helpers (production only; loopback stubs) ──
  //
  // Screens call these to keep the transport-layer state in sync with
  // UI intent. On loopback they no-op so the ChatScreen code path is
  // transport-agnostic.

  /** Subscribe to the presence of a batch of users. Idempotent. */
  subscribePresence(userIds: string[]): void;
  /** Stop receiving presence updates for a batch of users. */
  unsubscribePresence(userIds: string[]): void;
  /** Report this app's foreground/background state; refines user's own presence. */
  setActivity(state: 'active' | 'away'): void;
  /**
   * Emit a typing indicator to a specific peer (start / stop).
   * `conversationId` (SYNC-6) scopes the indicator to one thread on the
   * receiving side; omitting it degrades to the legacy fan-out.
   */
  sendTyping(peer: SessionAddress, state: 'start' | 'stop', conversationId?: string): void;

  /**
   * Send a reaction delta to a previously-sent message. `remove: true`
   * unreacts; otherwise adds/replaces the reactor's emoji. The target
   * id is the sender-generated `reply_to_msg_id`-compatible id.
   */
  sendReaction(
    peer:           SessionAddress,
    conversationId: string,
    targetMsgId:    string,
    emoji:          string,
    remove?:        boolean,
  ): Promise<void>;

  /**
   * Edit a message this device already sent. Fans an `edit` control envelope
   * out to every recipient and patches the local row.
   *
   * Recipients apply it only if we are the target's original author
   * (runtime/messageMutationGate.ts). The 15-minute product window is enforced
   * by the CALLER and re-checked here — an action sheet left open past the
   * deadline must not be able to ship one.
   */
  sendMessageEdit(
    peer:           SessionAddress,
    conversationId: string,
    targetMsgId:    string,
    body:           string,
    mentions?:      Array<{userId: string; label: string}>,
  ): Promise<void>;

  /**
   * "Delete for everyone" — retract a message this device sent. Fans a
   * `deleteFor` control envelope out to every recipient, retracts any copy
   * still sitting on the relay, and tombstones the local row.
   *
   * Same authorship rule as `sendMessageEdit`, with a 48-hour window.
   */
  sendDeleteForEveryone(
    peer:           SessionAddress,
    conversationId: string,
    targetMsgId:    string,
  ): Promise<void>;

  /**
   * Audit MSG-05 — drop any durable outbox rows for a clientMsgId. Called by
   * tap-to-retry BEFORE re-sending under a fresh id, so the original envelope
   * isn't ALSO shipped by the next reconnect drain (which would deliver the
   * message twice). Best-effort; loopback no-ops.
   */
  discardOutboxForMessage(clientMsgId: string): Promise<void>;

  /**
   * Audit P2-10 — drop ALL durable outbox rows for a conversation. Called by
   * "Clear chat" so a still-queued (pending/failed) row isn't shipped by a
   * later reconnect drain after the user cleared the thread. Optional; loopback
   * has no outbox and omits it.
   */
  discardOutboxForConversation?(conversationId: string): Promise<void>;

  /**
   * Mark every unread inbound message in a conversation as read and
   * fan a single read-receipt frame out to the peer's connected
   * devices via the WS gateway. Idempotent — already-read messages
   * are skipped. Loopback runtime stubs this as a local-only flip.
   */
  markRead(conversationId: string): void;

  /**
   * Force-pull any envelopes the relay is holding for us. ChatScreen
   * calls this on mount + AppState=active so a queued message that
   * piled up while the WS was dormant lands before the user sees a
   * stale "no messages" view. Loopback no-ops; production runs the
   * same drainRelay path used on WS reconnect.
   *
   * Never throws. B-703 MR-1 — it returns a report instead, because the
   * killed-app wake has to tell "ingested everything" apart from "the pull
   * failed" and "real envelopes are still on the relay". UI callers ignore it.
   */
  pullEnvelopes(): Promise<RelayPullReport>;

  /**
   * B-703 MR-5 — push any queued relay acks NOW and wait for them.
   *
   * Acks are coalesced on a 200 ms timer and every other caller fires the
   * flush and forgets it, which is right for a foreground pull: awaiting a
   * network round-trip on the chat-open path is exactly the jank B-279/B-691
   * fought. The killed-app lane is the opposite case — when its headless task
   * resolves, Android may freeze the process with the ack POST unsent, so the
   * relay never learns the device holds the message: the sender's tick stays
   * single until the recipient opens the app, and the envelope redelivers.
   * That lane awaits this before it returns.
   */
  flushAcks(): Promise<void>;

  /**
   * Force-rebuild the Signal session with `peer`. Closes the local
   * session, refetches the peer's pre-key bundle from auth-service,
   * and initialises a fresh outgoing session. The next outbound
   * message will be a `PreKeyWhisperMessage` that also rebuilds the
   * peer's side (libsignal handles that on decrypt). Used when a
   * user reports "I can't see their messages" or as the manual
   * fallback when auto-recovery on `DecryptError` hasn't kicked in
   * yet (e.g. neither side has tried to send since the rotation).
   */
  resetSessionWith(peer: SessionAddress): Promise<void>;

  /**
   * Compute the Signal-style safety number for a 1:1 conversation by
   * combining the local identity key and the peer's identity key. The
   * returned string is a 60-digit decimal number rendered in 12 groups
   * of 5 digits, matching Signal/WhatsApp's user-comparable format.
   * Throws when the peer's identity key cannot be obtained (offline +
   * never spoken with them before).
   */
  getSafetyNumber(peer: SessionAddress): Promise<string>;

  /**
   * Audit P0-I3 / P0-S6 / P0-1 — safety-number verification surface.
   *
   * `getPeerVerification` returns the persisted ack (timestamp + the
   * SHA-256 of the safety number the user confirmed) or null when the
   * peer is TOFU-trusted but never verified. `markPeerVerified`
   * records the ack; `clearPeerVerification` removes it (user pressed
   * "Unverify"). `listIdentityRotations` returns the forensic-trail
   * rows the saveIdentity transaction stamps on every key flip.
   *
   * All four are 1:1-only — for groups the safety-number concept is
   * undefined since there's no single peer identity to verify. Implementations
   * for loopback / harness runtimes return inert defaults so the ChatInfo
   * screen doesn't crash in non-production paths.
   */
  getPeerVerification(peer: SessionAddress): Promise<{
    verifiedAtMs:       number;
    safetyNumberSha256: string;
  } | null>;
  markPeerVerified(peer: SessionAddress, safetyNumber: string): Promise<boolean>;
  clearPeerVerification(peer: SessionAddress): Promise<void>;
  /**
   * TOFU send-gate — acknowledge a peer's changed identity (the lighter
   * "accept" that clears the send-block without full safety-number
   * verification). Optional: implementations that don't gate sends omit it.
   */
  acknowledgePeerIdentityChange?(userId: string): Promise<void>;
  listIdentityRotations(peer: SessionAddress, limit?: number): Promise<Array<{
    oldKeySha256: string;
    newKeySha256: string;
    observedAtMs: number;
  }>>;

  /**
   * Group-call identity broadcast — encrypt a `groupCallPresence`
   * envelope to every recipient's pairwise Signal session and ship
   * via WS (or HTTP fallback). This is how peers learn that the
   * SFU-assigned opaque `participantTag` belongs to a particular
   * display name without ever revealing that mapping to the SFU.
   *
   * Best-effort: per-recipient failures are logged, not thrown.
   */
  broadcastGroupCallPresence(
    recipients: string[],
    presence: {roomId: string; participantTag: string; displayName: string; callType: 'voice' | 'video'},
  ): Promise<void>;

  /**
   * Create a new group chat:
   *   1. Generate a fresh GroupState (new groupId + master key).
   *   2. Add it to the local store + create the conversation row.
   *   3. Fan out an admin `create` envelope (E2E sealed via each
   *      member's pairwise Signal session) so they receive the
   *      master key, group state, and the conversation row appears
   *      on their device.
   *
   * Returns the new conversationId. Throws on no-other-members or
   * if the broadcast fails for every recipient.
   */
  createGroupChat(args: {
    name:    string;
    members: string[];   // userIds (excluding self)
    // D1-d — when true, a 0-delivered fan-out (members have no Signal keys yet) RETURNS the
    // created group instead of throwing. The local group state is kept either way; this lets
    // dept-channel provisioning register a stable group id (and re-key members later) instead
    // of re-forging a fresh master key on every open. Default false (1:1 group create unchanged).
    allowZeroDelivered?: boolean;
    // Founder QA 2026-08-08 — a dept channel's group may exist with ONLY its
    // admin (fresh workspace: every seeded channel is single-member). Key
    // distribution is unchanged — later members ride the add-intent/rekey
    // path; there is simply no one to distribute to yet. Default false: the
    // 1:1/user-created group flows keep requiring a second member.
    allowSolo?: boolean;
  }): Promise<{conversationId: string; groupId: string}>;

  /**
   * MISSION-GROUP (batch area 5) — bootstrap E2EE state for a group whose
   * id was assigned server-side (the mission Ops Room). Idempotent: a no-op
   * if local group state already exists (never re-keys). The agency device
   * calls this from the dispatch-room-intent drain BEFORE applying queued
   * CPO add-intents, so addGroupMember has a local group to rekey them into.
   */
  ensureAssignedGroup(args: {
    groupId: string;     // externally-assigned conversation id
    name:    string;
    members: string[];   // initial member userIds (excluding self)
  }): Promise<{groupId: string; alreadyExisted: boolean}>;

  /**
   * Round 5 / Security S2 — remove a member from an existing group
   * AND rotate the group master key in the same operation.
   *
   * Without the rotation, the removed member's device still holds the
   * shared master key. They could not MUTATE state any more (admin
   * gate stops that), but they could keep DECRYPTING any subsequent
   * group-encrypted bodies they passively snooped off the relay. The
   * rekey closes that gap by minting a fresh master key and shipping
   * it to the remaining members in the same fan-out, after the remove
   * envelope.
   *
   * Caller MUST be a current admin of the group. Throws on:
   *   - non-admin caller
   *   - removing self (use leaveGroup instead — not yet implemented)
   *   - target not in group
   */
  removeGroupMember?(args: {
    groupId:        string;
    removedUserId:  string;
  }): Promise<{newEpoch: number}>;

  /**
   * Audit P1-G4 — voluntary leave + rekey. The caller removes THEMSELVES from
   * the group (planLeaveAndRekey), broadcasts the `leave` + a fresh `rekey` to
   * the remaining members (forward secrecy — the leaver keeps only the OLD key
   * and can't read post-leave ciphertext), then drops the group locally. Any
   * current member may leave (no admin gate). Best-effort fan-out; the local
   * exit always completes so the user is never stuck in a group they left.
   */
  leaveGroup?(args: {groupId: string}): Promise<{left: boolean}>;

  /**
   * Audit P0-G3 — add a member to a group AND rekey atomically. The
   * planner mirrors `planRemoveAndRekey`:
   *
   *   1. `add`   at epoch E (new member joins the membership set).
   *   2. `rekey` at epoch E+1 with a freshly-generated master key.
   *
   * After this returns, the group is at epoch E+2 with a new master
   * key. The new member can decrypt messages sent FROM THIS POINT
   * FORWARD; anything still on the relay (≤ 30d dwell) or in the
   * sealed archive (≤ 90d) under the OLD key remains inaccessible to
   * them, which is the Signal-spec forward-secrecy contract.
   *
   * Caller MUST be a current admin. Throws on:
   *   - non-admin caller
   *   - target already in group
   *   - target = self (use makeNewGroup to create solo groups)
   *
   * The new member's session must already exist locally (X3DH bring-up
   * is the caller's responsibility; the runtime ensures-session under
   * the hood when the member is reachable via keys-service).
   */
  addGroupMember?(args: {
    groupId:     string;
    newMember:   {userId: string; deviceId: number};
  }): Promise<{newEpoch: number}>;

  /**
   * B-289 — change a group's name.
   *
   * The `rename` admin action has existed in the protocol since the group
   * client was written (signed payload, `applyAdminAction` case, and a
   * `channel_renamed` system-line renderer) but NOTHING ever built one, so the
   * name a group was created with was permanent. This is the missing emitter,
   * not new protocol.
   *
   * Unlike add/remove there is NO rekey: membership is unchanged, so the master
   * key still binds exactly the same set of devices, and bumping the epoch for
   * a display string would force a needless key redistribution. The action is
   * signed and epoch-bound like every other admin action, so a replayed or
   * out-of-epoch rename is dropped by the receiver's existing guard.
   *
   * Caller MUST be a current admin. Throws on:
   *   - non-admin caller
   *   - unknown group
   *   - empty name, or one longer than GROUP_NAME_MAX
   */
  renameGroup?(args: {
    groupId: string;
    name:    string;
  }): Promise<{newEpoch: number}>;

  /**
   * B-291 — set or clear a group's picture.
   *
   * `imageUri` is a local file/content uri from the picker; pass `null` to
   * remove the current picture. The bytes are AES-256-CBC encrypted with a
   * fresh per-file key and uploaded through the SAME `MediaClient` path every
   * chat attachment takes — no new crypto and no new storage. Only the
   * reference (objectKey + key + iv) travels in group state, so the key reaches
   * members the way the master key does: inside a signed admin action over
   * pairwise Signal sessions.
   *
   * Deliberately NOT the plaintext `avatarUrl` pattern used for USER profiles:
   * a group's name is never sent to the server in plaintext, and a plaintext
   * group picture would tell the relay what a group looks like.
   *
   * No rekey — membership is unchanged. Caller MUST be a current admin.
   */
  setGroupPhoto?(args: {
    groupId:  string;
    imageUri: string | null;
    mimeType?: string;
  }): Promise<{newEpoch: number}>;

  /**
   * Self-heal — ask the owner/admins of a group to re-share its current
   * master key. Called when this device belongs to a group (has the
   * conversation) but holds NO master key for it — e.g. after a
   * logout/reinstall wiped the local key, or it was offline during the
   * original create/add fan-out. With no argument it sweeps every keyless
   * group conversation; with a `groupId` it targets just that one. The
   * owner responds by re-DELIVERING the existing key over a fresh pairwise
   * session (no epoch bump), which drains any stashed undecryptable
   * messages and unblocks group calls. Rate-limited per group internally.
   * Optional: absent on the loopback runtime.
   *
   * B-340 — `fallbackPeer` is the target to ask when this device holds NO
   * conversation row for the group (a B-337 purge deletes it), so the
   * participant lookup would otherwise come back empty and the request
   * silently no-op. A group-call joiner passes the ring's host here.
   */
  requestGroupKeyResync?(groupId?: string, fallbackPeer?: {userId: string; deviceId: number}): Promise<void>;

  /**
   * BS-CALL-ADHOC — ensure a group master key exists for an ad-hoc /
   * escalated multi-party call (e.g. "Add call" from a 1:1, where the
   * conversation is `direct:*` and has no group master key). FrameCryptor
   * needs a group master key to derive per-participant SFrame keys; a 1:1
   * conversation has none, so the call would refuse to start.
   *
   * Behaviour:
   *   - If `conversationId` ALREADY has a group master key (a real group
   *     chat), this is a no-op and returns that same id.
   *   - Otherwise the host mints a fresh group (own master key) for the
   *     call participants and distributes it via the SAME proven sealed
   *     fan-out `createGroupChat` uses (pairwise Signal sessions, admin
   *     `create` envelope). The recipients receive it through the normal
   *     incoming-envelope handler and store the GroupState locally. The
   *     returned `keyConversationId` is the id BOTH sides key the
   *     FrameCryptor off (the new groupId).
   *
   * The host MUST call this and await it BEFORE FrameCryptor init.
   * Recipients learn the keyConversationId from the ring metadata.
   * Fail-closed: throws if the key can't be established — the caller must
   * refuse the call rather than proceed unencrypted.
   *
   * ⚠️ E2E key agreement across devices is UNVERIFIED in CI (needs a real
   * multi-device call). Reuses createGroupChat's tested distribution.
   */
  ensureCallGroupKey?(args: {
    conversationId:   string;
    recipientUserIds: string[];
  }): Promise<{keyConversationId: string}>;

  /**
   * Round 6 / perf — page in older messages from SQLCipher. ChatScreen
   * boots with the latest MAX_HYDRATE_PER_CONVO rows already in the
   * Zustand store (productionRuntime calls sqlMessages.loadRecent at
   * boot). When the user scrolls toward the top, ChatScreen invokes
   * this to load the next batch of OLDER rows and prepend them.
   *
   * Behaviour:
   *  - Cursor is the oldest row currently in the store, taken from
   *    `(created_at, id)` so duplicate timestamps don't skip rows.
   *    Caller passes nothing — runtime walks the store itself.
   *  - Returns `{loaded: number, exhausted: boolean}` so the caller
   *    can flip a "no more older" flag and stop firing onEndReached.
   *  - No-ops in loopback (no SQL store) and reports exhausted=true
   *    so the UI doesn't spin.
   *  - Production: pulls up to `limit` rows and prepends via
   *    store.prependOlderMessages. Idempotent — prepend dedupes by id.
   *
   * Optional on the interface so loopback can omit; ChatScreen
   * checks `runtime.loadOlderMessages` before invoking.
   */
  loadOlderMessages?(
    conversationId: string,
    limit?: number,
  ): Promise<{loaded: number; exhausted: boolean}>;

  /**
   * B-206 — move a conversation's local history from an orphaned OLD id to a
   * NEW one after an owner "reactivate" re-minted a department channel's group
   * id. Folds the in-memory rows and remaps the durable SQLCipher rows so the
   * history follows the channel instead of vanishing. Idempotent. Optional:
   * loopback has no SQL store (the in-memory fold still runs).
   */
  remapConversation?(oldId: string, newId: string): Promise<void>;

  /**
   * B-90 T-04 — page text messages containing an http(s) URL across all
   * conversations, newest-first, for the Links browser. Reads the local
   * SQLCipher rows only (the relay never sees plaintext, so a server-side
   * links index cannot exist). Optional: loopback has no SQL store.
   */
  loadLinkMessages?(limit?: number, offset?: number): Promise<LocalMessage[]>;

  /**
   * B-636 — substring search over LOCAL decrypted message bodies, newest-first,
   * restricted to an explicit conversation-id allow-list. Backs the Channels
   * tab's "search the words inside the chats".
   *
   * Reads SQLCipher only — the relay holds ciphertext, so no server-side index
   * is possible, and nothing about the query ever leaves the device.
   *
   * `conversationIds` is the SCOPE, not a hint: an empty array returns nothing.
   * The caller passes the conversations it is already showing, which is what
   * keeps one organisation's search off another's messages.
   *
   * Optional on the interface because loopback mode has no SQL store.
   */
  searchMessages?(
    query: string,
    opts: {conversationIds: readonly string[]; limit?: number},
  ): Promise<LocalMessage[]>;

  /**
   * Audit S7 — produce a signed auth block for an outgoing `call.offer`.
   * Returns the existing cached sender cert + an XEd25519 signature over
   * the canonical bytes of `(callId, from=self, to, kind, ts)`. The
   * callee verifies via `verifyCallOfferAuth` and rejects any frame
   * whose AAD doesn't bind to this call.
   *
   * Optional on the interface because loopback mode has no auth-service.
   */
  signCallOfferAuth?(args: {
    callId: string;
    to:     SessionAddress;
    kind:   'voice' | 'video';
  }): Promise<import('@bravo/messenger-core').CallOfferAuth>;

  /**
   * Audit P1-N7 — revoke our currently-cached sender cert AND invalidate
   * the local cache. Call this AFTER an own-identity rotation completes
   * (the new keypair is published to keys-service, the old identity has
   * been recorded as superseded). The cert minted under the old identity
   * is added to auth-service's revocation list so receivers polling the
   * list drop traffic still attributed to the prior identity, instead
   * of relying purely on the IdentityKeyMismatchError fallback.
   *
   * Safe under missing backend (`backendMissing: true`) — local cache
   * is invalidated regardless. NEVER throws.
   *
   * Optional on the interface because loopback mode has no auth-service.
   */
  revokeOwnSenderCert?(): Promise<{revoked: boolean; backendMissing: boolean}>;
}

let runtimePromise: Promise<MessengerRuntime> | null = null;
let productionConfig: import('./productionRuntime').ProductionConfig | null = null;
/**
 * B-272 — "production runtime requires configureMessengerRuntime(cfg) first",
 * on screen, in a chat.
 *
 * MainNavigator resolves the SQLCipher ownerKey pin from AsyncStorage BEFORE it
 * calls configureMessengerRuntime(), so from process start until that one read
 * resolves `productionConfig` is null and every getMessengerRuntime() throws.
 * Nothing used to reach that window; a notification tap now does — the deep
 * link mounts ChatScreen in the same frame MainNavigator mounts, so the chat's
 * own pullEnvelopes() raced the read and lost. It threw, ChatScreen swallowed
 * it into a console.log (stripped from release builds), and the drain for the
 * message the user had just tapped never happened.
 *
 * The gate is that pending read. Callers that arrive early WAIT for it instead
 * of being told the app is misconfigured. `configEpoch` exists because the
 * gate's own body calls _resetMessengerRuntime() before it configures: a build
 * parked on the gate would wake up orphaned (its singleton nulled) and start a
 * SECOND buildProductionRuntime — two SQLCipher opens, two installIdentity
 * calls. Bumping the epoch lets the parked caller detect that and hand off to
 * whoever owns the singleton now.
 */
let configGate: Promise<unknown> | null = null;
let configEpoch = 0;

/**
 * Publish the in-flight configuration work. Call SYNCHRONOUSLY, before the
 * first await — a gate installed after the race has started cannot close it.
 * The promise must always settle (reject is fine); a hung gate hangs every
 * caller behind it.
 */
export function setMessengerConfigGate(pending: Promise<unknown> | null): void {
  configGate = pending;
}
/**
 * Cached reference to the live CryptoStore. Backup setup / restore
 * needs direct access to it so they can read the identity bundle
 * (capture) or seed a fresh store (reinstall). Set inside
 * buildRuntime() once the store is resolved.
 */
let cachedOwnStore: CryptoStore | null = null;
export function getOwnCryptoStore(): CryptoStore | null {
  return cachedOwnStore;
}

/**
 * AUDIT-2026-08-13 #11 — every rebuild (user switch, restore flow) used to
 * LEAK the previous native SQLCipher handle: the reset fns dropped the
 * reference and nothing anywhere called `db.close()`. Capture the outgoing
 * handle, then close it on the txn chain AFTER the next successful
 * production build — by then `disposeLiveRuntime()` has flipped the owner
 * epoch (so no old-runtime frame can queue BEHIND the close and die on a
 * closed handle → terminal classification → envelope destroyed), and every
 * already-queued old frame runs BEFORE it (chain order).
 *
 * Rev-2 (critic F1) — `liveOwnStore` is the capture seam, NEVER
 * `cachedOwnStore`: cachedOwnStore means "most recently resolved, live or
 * HALF-BUILT" (it is assigned before the multi-second build await), so a
 * reset landing mid-build captured the in-flight build's handle and the
 * next success closed it under the runtime that build was about to hand
 * its caller — every receive frame then dies on the closed handle,
 * terminal-classified, envelope destroyed. liveOwnStore is assigned only
 * when a build COMPLETES, so only a completed build's handle is ever
 * capturable. Known bounded residual: an orphaned late-completing build
 * (reset while in flight, then completes) keeps its handle open —
 * untracked, but never closed-while-live.
 */
let pendingPrevDbClose: (() => unknown) | null = null;
let liveOwnStore: CryptoStore | null = null;
// Rev-4 (critic) — a build GENERATION guards the seam assignment: without
// it, an ORPHANED late-completing build (reset while in flight, completes
// after a newer build succeeded) overwrote liveOwnStore, so the next cycle
// closed the orphan's handle and the LIVE one leaked — and the seam pointed
// at the wrong object from then on. Resets and build starts both bump the
// generation; a build only claims the seam if nothing bumped it since.
let buildGen = 0;

function captureStoreForClose(store: CryptoStore | null): void {
  const db = (store as {getDb?: () => {close?: () => unknown}} | null)?.getDb?.();
  const close = db?.close?.bind(db);
  if (!close) {return;}
  // Multiple captures before a successful build (failed-build retries,
  // interleaved resets) COMPOSE — an overwrite would leak the earlier one.
  const prior = pendingPrevDbClose;
  pendingPrevDbClose = () => {
    try { prior?.(); } catch { /* already closed — fine */ }
    return close();
  };
}

function schedulePendingDbClose(): void {
  const close = pendingPrevDbClose;
  if (!close) {return;}
  pendingPrevDbClose = null;
  void (async () => {
    const {runOnTxnChain} = await import('./receiveTransaction');
    await runOnTxnChain(async () => { close(); }, 'db-close-prev');
  })().catch(e => {
    console.warn('[messenger.runtime] prev DB close failed:', (e as Error)?.message ?? e);
  });
}

/**
 * Call once at app boot, after the user has a valid JWT. Sets the
 * config that the production runtime needs. If never called,
 * getMessengerRuntime() falls back to loopback-memory.
 */
export function configureMessengerRuntime(
  cfg: import('./productionRuntime').ProductionConfig,
): void {
  productionConfig = cfg;
  // The gate has done its job. Leaving it set would make later callers await a
  // settled promise for no reason, and would keep the epoch check live.
  configGate = null;
}

export function getMessengerRuntime(
  mode: RuntimeMode = pickDefaultMode(),
): Promise<MessengerRuntime> {
  if (!runtimePromise) {
    // Audit P1-2 — do NOT cache a REJECTED build. An offline cold boot (or a
    // transient auth-service 5xx during buildProductionRuntime) used to reject
    // the promise, which stayed cached for the whole process lifetime: the
    // messenger showed zero history and every send was impossible until a
    // force-kill, even after connectivity returned. Clearing the singleton on
    // rejection lets the next getMessengerRuntime() retry a fresh build.
    const built = buildRuntime(mode);
    runtimePromise = built;
    built.catch(() => {
      if (runtimePromise === built) {runtimePromise = null;}
    });
  }
  return runtimePromise;
}

/**
 * Audit P0-S1 — expose the persistence key (email/phone) used to scope
 * the active user's SQLCipher DB filename + keychain entries. The
 * logout/wipe path needs this captured BEFORE _resetMessengerRuntime
 * nulls the config, otherwise wipeUserAtRest has no idea which on-disk
 * artifacts to destroy.
 */
export function getActiveOwnerKey(): string | null {
  if (!productionConfig) {return null;}
  return productionConfig.ownerKey ?? productionConfig.ownUserId ?? null;
}

/** Test-only — drop the cached singleton. */
export function _resetMessengerRuntime(): void {
  captureStoreForClose(liveOwnStore); // #11 — a COMPLETED build's handle only
  liveOwnStore = null;
  buildGen += 1; // #11 rev-4 — orphan any in-flight build (it may not claim the seam)
  runtimePromise = null;
  productionConfig = null;
  cachedOwnStore = null;
  // B-272 — tells a build parked on the config gate that the singleton it was
  // stored in is gone, so it hands off instead of racing a second build.
  configEpoch += 1;
}

/**
 * BS-RESTORE — drop the cached runtime singleton + own-store but KEEP the
 * production config. The backup-restore flow needs to rebuild the runtime
 * against the restored SQLCipher identity, but it runs AFTER MainNavigator
 * already called configureMessengerRuntime() with the right config and the
 * user.id hasn't changed (so MainNavigator's effect won't re-run to set it
 * again). Using the full `_resetMessengerRuntime()` here nulled the config,
 * so the immediate `getMessengerRuntime('production')` rebuild threw
 * "production runtime requires configureMessengerRuntime(cfg) first" and
 * MessengerHome painted the red error bar until a manual close+reopen
 * re-ran MainNavigator. Keeping the config lets the rebuild succeed in place.
 */
export function _resetMessengerRuntimeKeepConfig(): void {
  captureStoreForClose(liveOwnStore); // #11 — a COMPLETED build's handle only
  liveOwnStore = null;
  buildGen += 1; // #11 rev-4 — orphan any in-flight build (it may not claim the seam)
  runtimePromise = null;
  cachedOwnStore = null;
  // productionConfig intentionally preserved.
}

function pickDefaultMode(): RuntimeMode {
  if (productionConfig) {return 'production';}
  return __DEV__ ? 'loopback-memory' : 'production';
}

async function buildRuntime(mode: RuntimeMode): Promise<MessengerRuntime> {
  if (mode === 'production') {
    // B-272 — wait for an in-flight configure before declaring it absent.
    if (!productionConfig && configGate) {
      const gate = configGate;
      const epoch = configEpoch;
      await gate.catch(() => undefined);
      if (configEpoch !== epoch) {
        // The gate tore the singleton down on its way to configuring. Whoever
        // asks now owns the build; joining it is the only way to keep exactly
        // one buildProductionRuntime() per process.
        return getMessengerRuntime(mode);
      }
    }
    if (!productionConfig) {
      throw new Error('production runtime requires configureMessengerRuntime(cfg) first');
    }
    const myGen = ++buildGen; // #11 rev-4 — claim a generation for this build
    const ownStore = await resolveOwnStore(mode);
    cachedOwnStore = ownStore;
    const {buildProductionRuntime} = await import('./productionRuntime');
    let runtime: MessengerRuntime;
    try {
      runtime = await buildProductionRuntime({ownStore, config: productionConfig});
    } catch (e) {
      // #11 rev-2 (critic F2) — a failed build's OWN handle (this closure's
      // ownStore, precisely — never the shared cachedOwnStore) is dead the
      // moment the build rejects; without this the P1-2 offline-cold-boot
      // retry loop leaked one native SQLCipher connection per attempt.
      // The close itself still waits for the next SUCCESSFUL build:
      // scheduling on failure is unsafe when the failure predates the
      // dispose epoch-flip inside buildProductionRuntime (e.g. a bad-key
      // openCryptoDb throw) — the OLD runtime would still be queueing
      // frames that could land behind the close.
      captureStoreForClose(ownStore);
      throw e;
    }
    // #11 — only AFTER a successful build: disposeLiveRuntime (inside the
    // build) has flipped the owner epoch, so the chain-serialized close of
    // the PREVIOUS handle cannot land under a still-queueing old frame.
    // (Deliberately NOT scheduled on the loopback branch: dispose never
    // runs there, so the epoch precondition doesn't hold.)
    // Rev-4 (critic) — an ORPHANED build (a reset or newer build bumped the
    // generation while this one was in flight) may claim NOTHING: assigning
    // the seam here overwrote the real live store, closed the orphan's
    // handle next cycle, and leaked the live one forever. The orphan's own
    // handle stays untracked-and-open — the bounded, never-closed-while-live
    // residual, by design.
    if (myGen === buildGen) {
      liveOwnStore = ownStore;
      schedulePendingDbClose();
    }
    return runtime;
  }

  const ownStore: CryptoStore = await resolveOwnStore(mode);
  cachedOwnStore = ownStore;
  // Loopback only needs a handful of one-time prekeys; 50 ran ~8s of pure-JS
  // X25519 keygen on-device and made the Chat screen feel frozen on first open.
  await installIdentity(ownStore, { preKeyCount: 5 });
  const own = new SessionManager(ownStore);

  const echoPeer = await initLoopbackPeer(own, ownStore);
  primeLoopbackConversation();

  // Disappearing-message sweep — without this, ttlSeconds-marked bubbles
  // would sit on the screen indefinitely even after their deadline.
  new ExpirySweeper().start();

  useMessengerStore.getState().setReady(true);

  return {
    mode,
    own,
    echoPeer,
    sendText: (conversationId, text, peerOrOpts) => {
      const isAddress = peerOrOpts && 'userId' in peerOrOpts;
      const opts = isAddress ? undefined : (peerOrOpts as SendTextOptions | undefined);
      const peer = isAddress
        ? (peerOrOpts as SessionAddress)
        : opts?.peer ?? LOOPBACK_PEER;
      return sendText(
        own, echoPeer, conversationId, peer, text,
        opts?.ttlSeconds,
        opts?.replyTo,
      );
    },
    processIncoming: (conversationId, peer, ct) =>
      processIncoming(own, conversationId, peer, ct),

    // Loopback stubs — presence + typing require a live transport,
    // which loopback mode doesn't have. UI still calls these unconditionally.
    subscribePresence:   () => { /* no-op */ },
    unsubscribePresence: () => { /* no-op */ },
    setActivity:         () => { /* no-op */ },
    sendTyping:          () => { /* no-op */ },
    // Loopback reactions: patch the local message directly so the UI
    // still shows the emoji-chip even without a round-trip.
    sendReaction: async (_peer, conversationId, targetMsgId, emoji, remove = false) => {
      const store = useMessengerStore.getState();
      const list  = store.messages[conversationId];
      if (!list) {return;}
      const msg = list.find(m => m.id === targetMsgId);
      if (!msg) {return;}
      const next: Record<string, string> = {...(msg.reactions ?? {})};
      if (remove) {delete next.self;}
      else        {next.self = emoji;}
      store.updateMessageReactions(conversationId, msg.id, next);
    },
    // Loopback edit/delete: patch the local row directly, so the dev harness
    // exercises the same store actions the production receive lane drives.
    sendMessageEdit: async (_peer, conversationId, targetMsgId, body, mentions) => {
      const store = useMessengerStore.getState();
      if (!store.messages[conversationId]?.some(m => m.id === targetMsgId)) {return;}
      store.applyMessageEdit(conversationId, targetMsgId, body, Date.now(), mentions);
    },
    sendDeleteForEveryone: async (_peer, conversationId, targetMsgId) => {
      const store = useMessengerStore.getState();
      if (!store.messages[conversationId]?.some(m => m.id === targetMsgId)) {return;}
      store.applyDeleteForEveryone(conversationId, targetMsgId);
    },
    // Loopback has no durable outbox — nothing to discard (MSG-05).
    discardOutboxForMessage: async () => { /* no-op */ },
    // Loopback markRead: nothing to fan out, but bump the local
    // unread count to zero so the UI behaves consistently.
    markRead: (_conversationId) => { /* no-op */ },
    // Loopback has no relay — there's nothing to pull, and nothing left behind.
    pullEnvelopes: async () => emptyPullReport(),
    // ...and no relay means no acks to flush.
    flushAcks: async () => { /* no-op */ },
    // Loopback has no peer registry to refetch from — close the
    // local session and let the next encrypt re-init via the cached
    // echo peer bundle.
    resetSessionWith: async (peer) => {
      try { await own.closeSession(peer); } catch { /* best effort */ }
    },
    // Loopback safety number: hash own + echo identity so the dev UI
    // can render a stable comparable code without crashing. Real
    // verification is meaningless against a self-talk peer.
    getSafetyNumber: async (peer) => {
      const ownPair = await ownStore.getIdentityKeyPair();
      const peerKey = await ownStore.loadIdentityKey(`${peer.userId}.${peer.deviceId}`);
      if (!peerKey) {throw new Error('peer identity unavailable');}
      return computeSafetyNumber(ownPair.pubKey, peerKey);
    },
    // Loopback verification surface — the trust-row methods live on
    // SqlCipherProtocolStore only. The dev UI gets stable "never
    // verified / no rotations" answers so the ChatInfo screen renders
    // without throwing in loopback mode.
    getPeerVerification:   async () => null,
    markPeerVerified:      async () => false,
    clearPeerVerification: async () => { /* no-op */ },
    listIdentityRotations: async () => [],
    // Loopback has no peer fan-out — group calls aren't supported
    // without the SFU which is also network-only. No-op so the screen
    // doesn't crash when invoked under loopback dev mode.
    broadcastGroupCallPresence: async () => { /* no-op */ },
    // Loopback createGroupChat: just stash the conversation locally
    // so the dev UI works. No fan-out, no master key, no admin envelope.
    createGroupChat: async ({name, members}) => {
      const groupId = `lb-grp:${Date.now().toString(36)}`;
      const ownId = OWN_ADDRESS.userId;
      useMessengerStore.getState().upsertConversation({
        id:            groupId,
        type:          'group',
        name,
        participants:  [ownId, ...members],
        unread_count:  0,
        is_muted:      false,
        created_at:    new Date().toISOString(),
        peer:          {userId: members[0] ?? ownId, deviceId: 1},
        session_state: 'fresh',
      });
      return {conversationId: groupId, groupId};
    },
    // Loopback ensureAssignedGroup: stash the conversation locally only
    // (no fan-out / master key). Idempotent on the conversation row.
    ensureAssignedGroup: async ({groupId, name, members}) => {
      const ownId = OWN_ADDRESS.userId;
      const existed = Boolean(useMessengerStore.getState().conversations[groupId]);
      if (!existed) {
        useMessengerStore.getState().upsertConversation({
          id:            groupId,
          type:          'group',
          name,
          participants:  [ownId, ...members],
          unread_count:  0,
          is_muted:      false,
          created_at:    new Date().toISOString(),
          peer:          {userId: members[0] ?? ownId, deviceId: 1},
          session_state: 'fresh',
        });
      }
      return {groupId, alreadyExisted: existed};
    },
  };
}

async function resolveOwnStore(mode: RuntimeMode): Promise<CryptoStore> {
  if (mode === 'loopback-memory') {
    return new InMemoryProtocolStore();
  }
  // SQLCipher paths — load op-sqlite lazily so loopback-memory builds
  // don't drag the native module in on environments where it isn't linked.
  const [{ openCryptoDb }, { SqlCipherProtocolStore }] = await Promise.all([
    import('../crypto/db'),
    import('../crypto/sqlCipherStore'),
  ]);
  // Scope keychain key + DB filename to a STABLE owner key (email/phone),
  // not the auth-service UUID. The UUID rotates on every dev re-register
  // and would otherwise orphan the user's entire SQLCipher DB on each
  // reset. Falls back to ownUserId when ownerKey isn't supplied.
  // Different humans still get different encryption keys AND different
  // files — two independent isolation layers (Signal / WhatsApp model).
  const cfg = productionConfig!;
  const persistenceKey = cfg.ownerKey ?? cfg.ownUserId;
  // Sanitise: emails contain `@` which is fine on most filesystems but
  // we keep the slug short and stable. Phone numbers have `+` likewise.
  const slug = sanitiseForFilename(persistenceKey).slice(0, 24);
  const encryptionKey = await getOrCreateDbKey(persistenceKey);
  const dbName = `messenger-${slug}-${Platform.OS}.db`;
  const db = await openCryptoDb({ encryptionKey, name: dbName });
  return new SqlCipherProtocolStore(db);
}

function sanitiseForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function initLoopbackPeer(
  own: SessionManager,
  ownStore: CryptoStore,
): Promise<SessionManager> {
  const peerStore = new InMemoryProtocolStore();
  // Loopback only encrypts one side at a time — 2 one-time prekeys is enough
  // for the mutual X3DH below, and keeps the cold-start under a second.
  await installIdentity(peerStore, { preKeyCount: 2 });
  const peer = new SessionManager(peerStore);

  // Mutual X3DH — each side needs the other's bundle to establish a
  // session. In production the server is the bundle registry; here we
  // just hand bundles across directly.
  const peerBundle = await buildOwnPreKeyBundle(peerStore, LOOPBACK_PEER, 1, 1);
  await own.initOutgoingSession(peerBundle);

  const ownBundle = await buildOwnPreKeyBundle(ownStore, OWN_ADDRESS, 1, 1);
  await peer.initOutgoingSession(ownBundle);

  return peer;
}

function primeLoopbackConversation(): void {
  const { upsertConversation } = useMessengerStore.getState();
  upsertConversation({
    id: 'loopback',
    type: 'direct',
    name: 'Echo (loopback)',
    participants: [OWN_ADDRESS.userId, LOOPBACK_PEER.userId],
    unread_count: 0,
    is_muted: false,
    created_at: new Date().toISOString(),
    peer: LOOPBACK_PEER,
    session_state: 'established',
  });
}

async function sendText(
  own: SessionManager,
  echoPeer: SessionManager | undefined,
  conversationId: string,
  peer: SessionAddress,
  text: string,
  ttlSeconds?: number,
  replyTo?: {messageId: string; preview: string},
): Promise<void> {
  const store = useMessengerStore.getState();
  const msgId = makeId();
  const sentAt = new Date().toISOString();
  const expiresAtMs = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;

  // Show the bubble immediately as 'sending'. Must NOT hold a live reference
  // to this object afterwards — Zustand/Immer deep-freezes stored state, so
  // any later property assignment on it throws. We mutate by calling store
  // actions (updateMessageStatus, or re-insert with ciphertext set).
  const pending: LocalMessage = {
    id: msgId,
    conversation_id: conversationId,
    sender_id: 'self',
    type: 'text',
    content: text,
    status: 'sending',
    is_encrypted: true,
    created_at: sentAt,
    peer,
    expires_at: expiresAtMs,
    reply_to_msg_id:  replyTo?.messageId,
    reply_to_preview: replyTo?.preview,
  };
  store.appendMessage(conversationId, pending);

  try {
    const ct = await own.encrypt(peer, text);
    store.updateMessageCiphertext(conversationId, msgId, ct);
    store.updateMessageStatus(conversationId, msgId, 'sent');

    if (echoPeer) {
      // Loopback proof: peer decrypts — validates the ratchet round-trip.
      // Fire the auto-reply on a small delay so the UI observes two bubbles.
      await echoPeer.decrypt(OWN_ADDRESS, ct);
      // Peer has the plaintext — flip our message to 'delivered' (double-tick,
      // WhatsApp-style). Real network mode updates this from the relay's
      // envelope.delivered event.
      store.updateMessageStatus(conversationId, msgId, 'delivered');

      // For groups: simulate every participant echoing back, staggered so
      // the UI shows each member replying in turn. This is loopback-only
      // UX eye-candy — the crypto round-trip through `echoPeer` above is
      // what actually validates the ratchet.
      const conv = store.conversations[conversationId];
      if (conv?.type === 'group') {
        const others = conv.participants.filter(p => p !== 'self' && p !== OWN_ADDRESS.userId);
        others.forEach((memberId, i) => {
          setTimeout(() => {
            groupMemberEcho(conversationId, peer, memberId, text, expiresAtMs);
          }, 900 + i * 650);
        });
      } else {
        setTimeout(() => {
          echoAutoReply(own, echoPeer, conversationId, peer, text, expiresAtMs).catch(e => {
            useMessengerStore.getState().setError(asErrorMessage(e));
          });
        }, 1500);
      }
    }
  } catch (e) {
    store.updateMessageStatus(conversationId, msgId, 'failed');
    store.setError(asErrorMessage(e));
    throw e;
  }
}

/**
 * Loopback-only: fake an incoming reply from one group member. Skips the
 * crypto round-trip (echoAutoReply already proved that path); this just
 * appends a plaintext bubble with the given sender_id so each dev
 * contact appears to reply in its own voice.
 */
function groupMemberEcho(
  conversationId: string,
  peer: SessionAddress,
  memberId: string,
  originalText: string,
  expiresAtMs?: number,
): void {
  const reply = `Echo: ${originalText}`;
  const msg: LocalMessage = {
    id: makeId(),
    conversation_id: conversationId,
    sender_id: memberId,
    type: 'text',
    content: reply,
    status: 'delivered',
    is_encrypted: true,
    created_at: new Date().toISOString(),
    peer,
    expires_at: expiresAtMs,
  };
  useMessengerStore.getState().appendMessage(conversationId, msg);
}

async function echoAutoReply(
  own: SessionManager,
  echoPeer: SessionManager,
  conversationId: string,
  peer: SessionAddress,
  originalText: string,
  expiresAtMs?: number,
): Promise<void> {
  const reply = `Echo: ${originalText}`;
  const ct = await echoPeer.encrypt(OWN_ADDRESS, reply);
  const plaintext = await own.decrypt(peer, ct);
  const msg: LocalMessage = {
    id: makeId(),
    conversation_id: conversationId,
    sender_id: peer.userId,
    type: 'text',
    content: plaintext,
    status: 'delivered',
    is_encrypted: true,
    created_at: new Date().toISOString(),
    peer,
    ciphertext: ct,
    expires_at: expiresAtMs,
  };
  useMessengerStore.getState().appendMessage(conversationId, msg);
}

async function processIncoming(
  own: SessionManager,
  conversationId: ConversationId,
  peer: SessionAddress,
  ct: Ciphertext,
): Promise<void> {
  const plaintext = await own.decrypt(peer, ct);
  useMessengerStore.getState().appendMessage(conversationId, {
    id: makeId(),
    conversation_id: conversationId,
    sender_id: peer.userId,
    type: 'text',
    content: plaintext,
    status: 'delivered',
    is_encrypted: true,
    created_at: new Date().toISOString(),
    peer,
    ciphertext: ct,
  });
}

function makeId(): string {
  const rand = new Uint8Array(8);
  crypto.getRandomValues(rand);
  return Array.from(rand, b => b.toString(16).padStart(2, '0')).join('');
}

function asErrorMessage(e: unknown): string {
  if (e instanceof Error) {return e.message;}
  return String(e);
}
