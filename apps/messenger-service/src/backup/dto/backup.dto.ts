/**
 * P0-V4 — typed DTOs for BackupController.
 *
 * Previously every Body() was an inline TypeScript interface, which the
 * runtime ValidationPipe cannot inspect — class-validator only fires on
 * decorated classes. That left every field unchecked: an attacker could
 * ship `wrappedIdentityBundle` as a 100 MB string, `kdfParams` as
 * arbitrary nested JSON, `messages` as an unbounded array, etc.
 *
 * Caps below are deliberately conservative: oversize legitimate payloads
 * cause a single 400 and the client retries with a smaller batch, while
 * an attacker can no longer pin server memory with one POST.
 */

import {
  IsArray, IsBase64, IsBoolean, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString,
  Max, MaxLength, Min, MinLength, ValidateNested, ArrayMaxSize, Validate,
  ValidatorConstraint, type ValidatorConstraintInterface,
} from 'class-validator';
import {Type} from 'class-transformer';

/**
 * L-1 — bound object-valued fields (`kdfParams`, `envelope_meta`,
 * `group_state`) that class-validator's `@IsObject()` leaves unchecked.
 * Caps both the key count and the serialized byte size so a JSON-bomb
 * can't pin server memory once the Express body limit is raised.
 */
@ValidatorConstraint({name: 'boundedObject', async: false})
class BoundedObjectConstraint implements ValidatorConstraintInterface {
  validate(value: unknown, args?: {constraints?: unknown[]}): boolean {
    if (value == null) return true; // @IsOptional handles presence
    if (typeof value !== 'object' || Array.isArray(value)) return false;
    const [maxKeys, maxBytes] = (args?.constraints ?? [32, 16 * 1024]) as [number, number];
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length > maxKeys) return false;
    try {
      if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes) return false;
    } catch {
      return false; // circular / non-serializable
    }
    return true;
  }
  defaultMessage(): string { return 'object exceeds key-count or byte-size cap'; }
}

/** M-10 — reject a non-parseable msg_created_at at the edge (→ 400). */
@ValidatorConstraint({name: 'isTimestamp', async: false})
class IsTimestampConstraint implements ValidatorConstraintInterface {
  validate(v: unknown): boolean {
    return typeof v === 'string' && v.length > 0 && !Number.isNaN(Date.parse(v));
  }
  defaultMessage(): string { return 'msg_created_at must be a parseable timestamp'; }
}

// ── caps ──────────────────────────────────────────────────────────────
// Identity bundle wraps the libsignal identity + signed prekey + OPKs.
// Empirically ~5–8 KB per device; allow 64 KB for headroom.
const MAX_WRAPPED_BUNDLE_B64    = 96 * 1024;
const MAX_WRAPPED_MASTER_KEY_B64 = 1024;
const MAX_SALT_B64               = 256;
const MAX_VERIFIER_KEY_B64       = 128;   // 32-byte HKDF output → 44 b64 chars
const MAX_KDF_PARAMS_KEYS        = 16;
const MAX_KDF_PARAMS_BYTES       = 2 * 1024;
// group_state is opaque AES-GCM-wrapped bytes wrapped in a small JSON
// envelope; envelope_meta carries a wrapped subkey. Both are tiny.
const MAX_META_OBJECT_KEYS       = 32;
const MAX_GROUP_STATE_BYTES      = 32 * 1024;
const MAX_ENVELOPE_META_BYTES    = 8 * 1024;
// Per-message ciphertext caps mirror the relay envelope.service ceiling
// (700 KB ciphertext + envelope overhead). 800 KB B64 is the safe wire.
const MAX_MESSAGE_CIPHERTEXT_B64 = 800 * 1024;
// L-7 — this DTO array cap is the HARD wire ceiling, enforced by the
// ValidationPipe before the service runs. The BACKUP_MAX_MESSAGE_BATCH
// env var (configuration.ts → maxMessageBatchSize, service-side check)
// can only LOWER the accepted batch: a request over THIS number is 400'd
// at the edge regardless of the env value. Keep them equal (500) so the
// two limits don't drift; raise BOTH together if a larger batch is ever
// needed.
const MAX_MESSAGES_PER_BATCH     = 500;
// Conversation rows are tiny metadata pointers.
const MAX_CONVERSATION_BLOB      = 8 * 1024;
const MAX_CONVERSATIONS_PER_BATCH = 1_000;
// Sessions snapshot — encrypted Double-Ratchet state. ~2 KB per peer;
// 16 MB ceiling covers ~8k peer sessions.
const MAX_SESSIONS_BLOB          = 16 * 1024 * 1024;

export class PutIdentityDto {
  @IsBase64()
  @MaxLength(MAX_WRAPPED_MASTER_KEY_B64)
  wrappedMasterKey!: string;

  @IsBase64()
  @MaxLength(MAX_SALT_B64)
  salt!: string;

  // P0-V4 / L-1: kdfParams was `Record<string, unknown>` with no
  // validation. We can't `@ValidateNested` an arbitrary record, so
  // accept it as a generic object and enforce a key-count + byte-size
  // cap (BoundedObjectConstraint) to prevent JSON-bomb payloads. The
  // service layer is the only consumer; it reads a few documented
  // fields (algo, memoryKib, ...) and ignores the rest.
  @IsObject()
  @Validate(BoundedObjectConstraint, [MAX_KDF_PARAMS_KEYS, MAX_KDF_PARAMS_BYTES])
  kdfParams!: Record<string, unknown>;

  @IsBase64()
  @MaxLength(MAX_WRAPPED_BUNDLE_B64)
  wrappedIdentityBundle!: string;

  // P0-1 — HKDF verifier key. Required: the server rejects uploads
  // without it so a legacy client fails loudly rather than writing an
  // unrestorable row.
  @IsBase64()
  @MaxLength(MAX_VERIFIER_KEY_B64)
  verifierKey!: string;
}

/**
 * P0-1 — proof body for POST /backup/identity/verify. `nonce` is the
 * value handed back by GET /identity/header; `proofB64` is
 * HMAC-SHA256(verifier_key, "bravo-backup-verify-v1:userId:nonce").
 */
export class VerifyProofDto {
  @IsString() @MinLength(1) @MaxLength(128)
  nonce!: string;

  @IsBase64() @MaxLength(128)
  proofB64!: string;
}

/**
 * Field names match the storage row + service layer (`putMessages` reads
 * `r.ciphertext`, `r.sender_id`, etc.). P0-B4 blinding is enforced by
 * the client supplying the `__v3_blinded__` sentinel VALUE for
 * sender/recipient/conversation/msg_type when ciphertext_type === 3 —
 * the field NAMES are not the privacy boundary.
 */
export class MessageMirrorRowDto {
  @IsString()  @MinLength(1) @MaxLength(128)
  message_id!: string;

  @IsString()  @MinLength(1) @MaxLength(128)
  conversation_id!: string;

  @IsString()  @MinLength(1) @MaxLength(128)
  sender_id!: string;

  @IsOptional() @IsString() @MaxLength(128)
  recipient_id?: string | null;

  @IsOptional() @IsString() @MaxLength(64)
  msg_type?: string;

  @IsBase64()  @MaxLength(MAX_MESSAGE_CIPHERTEXT_B64)
  ciphertext!: string;

  @IsOptional() @IsInt() @Min(1) @Max(3)
  ciphertext_type?: number;

  @IsOptional() @IsObject()
  @Validate(BoundedObjectConstraint, [MAX_META_OBJECT_KEYS, MAX_ENVELOPE_META_BYTES])
  envelope_meta?: Record<string, unknown>;

  // ISO 8601 timestamp (mobile sends ISO strings; service stores as
  // TIMESTAMPTZ and uses it as the page cursor in getMessages). M-10 —
  // validate the format here so a malformed value returns 400 at the
  // edge instead of failing the whole batch upsert with a 502 the
  // client retries forever.
  @IsString() @MaxLength(64)
  @Validate(IsTimestampConstraint)
  msg_created_at!: string;
}

export class PutMessagesDto {
  @IsArray()
  @ArrayMaxSize(MAX_MESSAGES_PER_BATCH)
  @ValidateNested({each: true})
  @Type(() => MessageMirrorRowDto)
  messages!: MessageMirrorRowDto[];
}

export class PutMerkleDto {
  @IsBase64()  @MaxLength(128)
  rootB64!: string;

  @IsInt() @Min(0) @Max(10_000_000)
  rowCount!: number;

  @IsInt() @Min(0)
  seq!: number;

  @IsNumber() @Min(0)
  sentAtMs!: number;

  @IsBase64() @MaxLength(256)
  sigB64!: string;
}

export class PutSessionsDto {
  @IsBase64()
  @MaxLength(MAX_SESSIONS_BLOB)
  blob!: string;

  @IsInt() @Min(0)
  seq!: number;
}

/**
 * Field names match the storage row + service layer (`putConversations`
 * reads r.kind, r.name, r.members, r.group_state, ...). P0-B5 group_state
 * blinding is enforced by the client wrapping the GroupState in
 * AES-GCM-under-master-key BEFORE send — the `group_state` field here
 * is opaque to the server (no shape validation beyond IsObject + size).
 */
export class ConversationMirrorRowDto {
  @IsString() @MinLength(1) @MaxLength(128)
  conversation_id!: string;

  // M-10 — DB has CHECK (kind IN ('direct','group','system')); mirror
  // that here so an out-of-enum value 400s at the edge instead of
  // failing the whole batch upsert with a retried 502.
  @IsString() @IsIn(['direct', 'group', 'system'])
  kind!: string;

  @IsOptional() @IsString() @MaxLength(256)
  name?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(1000)
  members?: Array<{userId: string; displayName?: string}>;

  @IsOptional() @IsString() @MaxLength(64)
  last_message_at?: string | null;

  @IsOptional() @IsBoolean()
  is_muted?: boolean;

  @IsOptional() @IsBoolean()
  is_pinned?: boolean;

  @IsOptional() @IsInt() @Min(0)
  default_ttl_sec?: number | null;

  @IsOptional() @IsInt() @Min(0)
  unread_count?: number;

  @IsOptional() @IsBoolean()
  is_custom_name?: boolean;

  @IsOptional() @IsObject()
  @Validate(BoundedObjectConstraint, [MAX_META_OBJECT_KEYS, MAX_GROUP_STATE_BYTES])
  group_state?: Record<string, unknown> | null;

  // B-594 fresh-install restore — the user's delete intent, so a restore
  // does not hand a deleted conversation straight back. IDs/flags only, no
  // plaintext (I9). Omit-if-absent on the server (like group_state): a
  // legacy/partial mirror without it must NOT clobber a stored delete.
  @IsOptional() @IsBoolean()
  deleted?: boolean;
}

export class PutConversationsDto {
  @IsArray()
  @ArrayMaxSize(MAX_CONVERSATIONS_PER_BATCH)
  @ValidateNested({each: true})
  @Type(() => ConversationMirrorRowDto)
  conversations!: ConversationMirrorRowDto[];
}
