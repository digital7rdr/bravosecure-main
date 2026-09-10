/**
 * Audit P0-B4 + P0-B5 — backup wire format v3: per-row metadata + group
 * state encryption.
 *
 * v1 (pre-Round-5)   : ciphertext directly under master key (single
 *                      AES-GCM). Outer columns plaintext.
 * v2 (Round-5 / S7)  : per-row subkey wrapped under master key; the
 *                      payload itself uses the subkey. Outer columns
 *                      still plaintext (the leak that motivated v3).
 * v3 (audit P0-B4/B5): identical envelope wrapping as v2, but the OUTER
 *                      columns (sender_id, recipient_id, conversation_id,
 *                      msg_type) are replaced with a single opaque
 *                      sentinel value. The real values are kept ONLY
 *                      inside the encrypted payload. msg_created_at
 *                      stays in plaintext (server uses it as the page
 *                      cursor — the alternative is rescanning all rows
 *                      per restore).
 *
 *                      group_state JSONB on the conversations endpoint
 *                      gets the same treatment: the plaintext object
 *                      (which used to expose groupId / member list /
 *                      MASTER KEY in raw base64) is now AES-GCM-
 *                      encrypted under the same master key the per-row
 *                      subkeys wrap under. Legacy plaintext blobs still
 *                      round-trip via the v1-aware reader.
 *
 * Restore-side compatibility:
 *   • v3 rows  → ignore outer columns; trust the decrypted payload.
 *   • v1 / v2  → fall back to outer columns when the payload omits
 *                them (matches the existing restoreMessages path).
 */
import type {LocalMessage} from '../store/types';
import type {GroupState} from '@bravo/messenger-core';

/** Wire-format version emitted for NEW mirror writes. */
export const MESSAGE_BACKUP_VERSION = 3 as const;

/**
 * Sentinel value substituted for sender_id / recipient_id /
 * conversation_id / msg_type on v3 rows. The DB schema marks these
 * columns NOT NULL (sender_id + msg_type) so we need a non-empty
 * placeholder; we use the same string for all four so a forensic
 * dump immediately reveals the row is v3-blinded.
 *
 * Long enough + obviously non-UUID + obviously non-enum so no real
 * value can collide.
 */
export const BACKUP_METADATA_SENTINEL = '__v3_blinded__';

export interface BackupRowV3 {
  message_id:      string;
  msg_created_at:  string;
  /** Always {@link BACKUP_METADATA_SENTINEL} on v3. */
  sender_id:       string;
  recipient_id:    string;
  conversation_id: string;
  msg_type:        string;
  ciphertext_type: 3;
  /** Stringified JSON of {@link serializeMessagePayload} output. */
  payloadJson:     string;
}

/**
 * Build the SERIALIZED payload (pre-encryption) plus the outer column
 * shape. The caller is responsible for the AES-GCM wrap of `payloadJson`
 * under a per-row subkey (same flow as v2 — only the outer columns
 * change). See messageMirror.ts for the wrap step.
 */
export function serializeMessageForBackup(msg: LocalMessage): BackupRowV3 {
  const payload = serializeMessagePayload(msg);
  return {
    message_id:      msg.id,
    msg_created_at:  msg.created_at,
    sender_id:       BACKUP_METADATA_SENTINEL,
    recipient_id:    BACKUP_METADATA_SENTINEL,
    conversation_id: BACKUP_METADATA_SENTINEL,
    msg_type:        BACKUP_METADATA_SENTINEL,
    ciphertext_type: 3,
    payloadJson:     JSON.stringify(payload),
  };
}

/** Full-fidelity payload — identical to the v2 serializer's output. */
function serializeMessagePayload(msg: LocalMessage): Record<string, unknown> {
  return {
    id:               msg.id,
    conversation_id:  msg.conversation_id,
    sender_id:        msg.sender_id,
    type:             msg.type,
    content:          msg.content,
    status:           msg.status,
    created_at:       msg.created_at,
    is_encrypted:     msg.is_encrypted,
    peer:             msg.peer,
    envelope_id:      msg.envelope_id,
    /**
     * SYNC-1 / B-116 — per-recipient envelope ids and the per-member read map.
     *
     * These were deliberately EXCLUDED because a new mirrored field changes
     * every row's `versionHash`, so the next boot sweep re-uploads all history
     * (the B-94 `root_mismatch` window). That reasoning was sound about the
     * cost and wrong about the trade: dropping them silently breaks read
     * receipts for every restored message, permanently.
     *
     * A restored GROUP row keeps only the SCALAR envelope_id, which is
     * participants[0]'s. `readReceiptEnvelopeMatch` can then match exactly one
     * member; the other N-1 receipts reference envelope ids the device no
     * longer knows, so they are unmatchable FOREVER. And `recordReadReceipts`
     * requires every participant before a group goes blue — so a restored
     * group message can never complete. Observed in the field: "Read by"
     * listing seven members, every one showing "—", while the message had
     * demonstrably been read.
     *
     * The re-upload this triggers is a ONE-TIME cost the ledger machinery is
     * built to survive: I2 raises the pending-commit flag before `putMessages`
     * and a failed upload heals on the next boot, and I4's `repairBackupCommit`
     * already re-uploads everything by design. After that single pass the
     * ledger holds the new hashes and I1 (idle boots upload nothing) holds
     * again. Losing receipt state on every restore is not a one-time cost.
     */
    envelope_ids:     msg.envelope_ids,
    receipts:         msg.receipts,
    expires_at:       msg.expires_at,
    reply_to_msg_id:  msg.reply_to_msg_id,
    reply_to_preview: msg.reply_to_preview,
    // MM-09 — undefined on non-forwards, so pre-existing rows keep their
    // versionHash (no B-94-style mass re-upload).
    is_forwarded:     msg.is_forwarded,
    reactions:        msg.reactions,
    call_meta:        msg.call_meta,
    media_object_key: msg.media_object_key,
    media_mime:       msg.media_mime,
    media_key:        msg.media_key,
    media_iv:         msg.media_iv,
    // Media-parity (2026-07-03) — round-trip the display metadata so a
    // restored attachment keeps its thumbnail/filename/dimensions.
    media_meta:       msg.media_meta,
    retract_token:    msg.retract_token,
    // B-187 — per-recipient retract tokens, same restore rationale as
    // envelope_ids/receipts above. Hash-safe for existing history: the field
    // is undefined on every pre-v19 row, so JSON.stringify omits it and their
    // versionHash is unchanged — no B-94-style mass re-upload.
    retract_tokens:   msg.retract_tokens,
    // B-683 — per-member terminal-destroy map (the failure-side pair to
    // receipts), same restore rationale and the same hash-safety as
    // retract_tokens above: undefined on every pre-v21 row, so existing
    // versionHashes are unchanged — no B-94-style mass re-upload.
    undeliverable_legs: msg.undeliverable_legs,
    // Optional recipient hint for v3 — keeps the same shape as the
    // mirrorMessage call site that previously sent it as an outer column.
    recipient_id:     msg.peer?.userId ?? null,
    msg_type:         msg.type,
  };
}

/**
 * Restore-side helper. Prefers the decrypted payload's fields (v3) and
 * falls back to the outer columns (v1/v2). Returns the same shape that
 * the old restoreMessages path constructed.
 */
export function deserializeMessageFromBackup(p: {
  message_id:      string;
  msg_created_at:  string;
  sender_id:       string;
  recipient_id:    string | null;
  conversation_id: string;
  msg_type:        string;
  ciphertext_type: number;
  payload:         Record<string, unknown>;
}): {
  message_id:      string;
  conversation_id: string;
  sender_id:       string;
  recipient_id:    string | null;
  type:            string;
  content:         string;
  status:          string;
  created_at:      string;
  is_encrypted:    boolean;
  peer?:           {userId: string; deviceId: number};
  raw:             Record<string, unknown>;
} {
  const isV3 = p.ciphertext_type === 3 || p.sender_id === BACKUP_METADATA_SENTINEL;
  const pickStr = (payloadKey: string, outer: string | null | undefined): string => {
    if (isV3) {
      const fromPayload = p.payload[payloadKey];
      if (typeof fromPayload === 'string' && fromPayload.length > 0) {return fromPayload;}
    }
    return outer ?? '';
  };
  const senderId      = pickStr('sender_id',       p.sender_id === BACKUP_METADATA_SENTINEL ? null : p.sender_id);
  const recipientId   = pickStr('recipient_id',    p.recipient_id === BACKUP_METADATA_SENTINEL ? null : p.recipient_id);
  const conversationId = pickStr('conversation_id', p.conversation_id === BACKUP_METADATA_SENTINEL ? null : p.conversation_id);
  const msgType       = pickStr('type',            p.msg_type === BACKUP_METADATA_SENTINEL ? null : p.msg_type)
                        || pickStr('msg_type',     p.msg_type === BACKUP_METADATA_SENTINEL ? null : p.msg_type)
                        || 'text';
  return {
    message_id:      p.message_id,
    conversation_id: conversationId,
    sender_id:       senderId,
    recipient_id:    recipientId || null,
    type:            msgType,
    content:         typeof p.payload.content === 'string' ? p.payload.content : '',
    status:          typeof p.payload.status  === 'string' ? p.payload.status  : 'sent',
    created_at:      typeof p.payload.created_at === 'string' ? p.payload.created_at : p.msg_created_at,
    is_encrypted:    !!p.payload.is_encrypted,
    peer:            p.payload.peer as {userId: string; deviceId: number} | undefined,
    raw:             p.payload,
  };
}

// ─── P0-B5 — group_state envelope ────────────────────────────────────

export interface EncryptedGroupStateV3 {
  v:    3;
  blob: string;  // base64 of IV-prefixed AES-256-GCM(ciphertext)
}

/**
 * Encrypt a GroupState (or any JSON-serializable subset) for the
 * server-side conversation_backups.group_state column. The plaintext
 * historically exposed the group master key in raw base64 — anyone
 * with read access to the row could decrypt every message ever sent in
 * the group.
 *
 * Reuses the same AES-GCM-under-master-key flow as the per-row subkey
 * wrap; we don't introduce a separate subkey here because group_state
 * is a single object per conversation (cheap to re-wrap on update).
 */
export async function encryptGroupStateBlob(
  masterKey: CryptoKey,
  state:     Record<string, unknown>,
  aad?:      Uint8Array,
): Promise<EncryptedGroupStateV3> {
  const subtle = (globalThis.crypto as Crypto).subtle;
  const iv = new Uint8Array(12);
  (globalThis.crypto as Crypto).getRandomValues(iv);
  const ptBytes = new TextEncoder().encode(JSON.stringify(state));
  // M-3 — bind the blob to (owner, conversation_id) so the server can't
  // swap one conversation's encrypted group_state (incl. its group master
  // key) into another conversation's row undetected.
  const params: {name: string; iv: ArrayBuffer; additionalData?: ArrayBuffer} = {name: 'AES-GCM', iv: iv.buffer as ArrayBuffer};
  if (aad && aad.length > 0) {params.additionalData = aad.slice().buffer as ArrayBuffer;}
  const ctBuf = await subtle.encrypt(
    params,
    masterKey,
    ptBytes.buffer as ArrayBuffer,
  );
  const ct = new Uint8Array(ctBuf);
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return {v: 3, blob: bytesToB64(out)};
}

/**
 * Reverse of {@link encryptGroupStateBlob}. Honours legacy plaintext
 * shapes by passing through any object that doesn't carry the v3
 * envelope marker — so old conversations restored on a v3 client still
 * recover their GroupState.
 *
 * H-8 hardening: the `group_state` column is server-controlled, and a
 * compromised server could strip the v3 envelope and inject an
 * attacker-shaped plaintext. We can't cryptographically bind the blob
 * without changing the GCM AAD scheme (an architecture-approval stop
 * condition, tracked as M-3), but we CAN refuse an obviously-malformed
 * legacy passthrough (a primitive, an array, or an object with a
 * non-string masterKeyB64) instead of silently constructing a degenerate
 * GroupState, and emit a loud (key-material-free) telemetry signal when
 * an unauthenticated plaintext is accepted.
 */
export async function decryptGroupStateBlob(
  masterKey: CryptoKey,
  raw:       EncryptedGroupStateV3 | Record<string, unknown>,
  aad?:      Uint8Array,
): Promise<GroupState> {
  // Legacy plaintext — no `v: 3` marker, no `blob`.
  const m = raw as {v?: unknown; blob?: unknown};
  if (m.v !== 3 || typeof m.blob !== 'string') {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('group_state_legacy_malformed');
    }
    // If a master key field is present it must be a plausible string —
    // reject a shape a real GroupState would never carry.
    const mk = (raw as Record<string, unknown>).masterKeyB64;
    if (mk !== undefined && (typeof mk !== 'string' || mk.length === 0)) {
      throw new Error('group_state_legacy_malformed');
    }
    // Why: unauthenticated group state accepted from the server — an
    // operator should notice if this ever fires post-v3-rollout.
    console.warn('[backup] accepted unauthenticated legacy group_state (pre-v3)');
    return raw as unknown as GroupState;
  }
  const subtle = (globalThis.crypto as Crypto).subtle;
  const bytes = b64ToBytes(m.blob);
  if (bytes.length < 12 + 16) {throw new Error('group_state_blob_too_short');}
  const iv = bytes.subarray(0, 12);
  const ct = bytes.subarray(12);
  const ivBuf = iv.slice().buffer as ArrayBuffer;
  const ctBuf = ct.slice().buffer as ArrayBuffer;
  // M-3 — try the (owner, conversation_id) AAD; a v3 blob written before
  // AAD binding has none, so fall back to a plain decrypt. A v3 blob
  // served in the WRONG conversation slot fails both.
  let ptBuf: ArrayBuffer;
  if (aad && aad.length > 0) {
    try {
      ptBuf = await subtle.decrypt(
        {name: 'AES-GCM', iv: ivBuf, additionalData: aad.slice().buffer as ArrayBuffer},
        masterKey, ctBuf,
      );
    } catch {
      ptBuf = await subtle.decrypt({name: 'AES-GCM', iv: ivBuf}, masterKey, ctBuf);
    }
  } else {
    ptBuf = await subtle.decrypt({name: 'AES-GCM', iv: ivBuf}, masterKey, ctBuf);
  }
  const pt = new TextDecoder().decode(new Uint8Array(ptBuf));
  return JSON.parse(pt) as GroupState;
}

// ─── tiny base64 helpers (Buffer-free for cross-runtime) ──────────────

function bytesToB64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {return Buffer.from(bytes).toString('base64');}
  let bin = '';
  for (const b of bytes) {bin += String.fromCharCode(b);}
  return (globalThis as {btoa: (s: string) => string}).btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {return new Uint8Array(Buffer.from(b64, 'base64'));}
  const bin = (globalThis as {atob: (s: string) => string}).atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {out[i] = bin.charCodeAt(i);}
  return out;
}
