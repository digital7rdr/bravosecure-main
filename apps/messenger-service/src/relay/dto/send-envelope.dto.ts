import {IsBoolean, IsDefined, IsInt, IsOptional, IsString, Min, ValidateNested, MinLength, MaxLength} from 'class-validator';
import {Type} from 'class-transformer';

class RecipientDto {
  @IsString() @MinLength(1)
  userId!: string;

  @IsInt() @Min(1)
  deviceId!: number;
}

export class SendEnvelopeDto {
  @IsDefined() @ValidateNested() @Type(() => RecipientDto)
  recipient!: RecipientDto;

  /**
   * Sealed Sender v2 outer ECIES wrap. Base64 string. Opaque to the
   * relay; the recipient's identity-key-driven AES-GCM unwrap recovers
   * the original libsignal SessionCipher ciphertext and the sender's
   * address. We bound the size at 512 KB — the inner Signal ciphertext
   * is capped at 256 KB and the outer adds a 45-byte header + 16-byte
   * GCM tag, so 2× headroom is plenty without inviting memory abuse.
   */
  @IsString() @MinLength(60) @MaxLength(700_000)
  outerSealed!: string;

  @IsOptional() @IsString()
  clientMsgId?: string;

  /**
   * Disappearing-message deadline (epoch seconds). Optional.
   * If set and earlier than the default dwell, the relay uses this as
   * the Redis TTL so Redis auto-evicts the ciphertext at that time —
   * even if the recipient stays offline past the deadline. Leaking the
   * deadline to the relay is deliberate: an attacker already learns the
   * relative send-time from envelope ordering, and the content stays
   * sealed either way.
   */
  @IsOptional() @IsInt() @Min(1)
  expiresAtSec?: number;

  /**
   * Audit P2-BR-3 — Signal-style urgency hint. Optional; defaults to `true`
   * (backward compatible — omitting it preserves today's behavior). When
   * explicitly `false`, the relay skips the high-importance "New secure
   * message" chat wake for this envelope. The client sets `urgent:false` for
   * non-displayable envelopes (reactions, group-control/rekey, etc.) so they
   * sync silently instead of phantom-bannering a killed device. This flag
   * reveals only "notification-worthy or not" — the same single bit Signal's
   * `urgent` flag exposes; it carries NO content/kind field.
   */
  @IsOptional() @IsBoolean()
  urgent?: boolean;

  /**
   * OM-03 — request an anonymous delivery receipt. Optional; absent is
   * today's behavior exactly (old clients allocate nothing). Carries no
   * identity: the relay parks `rcpt:{envelopeId}` holding only the
   * SHA-256 of this envelope's retract token.
   *
   * Must be whitelisted HERE before any client ships it — the global
   * ValidationPipe runs with `forbidNonWhitelisted: true`, so an
   * un-declared field 400s the whole submit.
   */
  @IsOptional() @IsBoolean()
  receipt?: boolean;
}
