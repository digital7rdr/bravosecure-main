import {Injectable, InternalServerErrorException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHmac, timingSafeEqual} from 'node:crypto';
import type {RoomId, UserId} from '../common/ids';

/**
 * Audit P0-C2 — server-issued per-recipient room access token.
 *
 * Without this gate, knowing a `roomId` was sufficient to call
 * `sfu.join` and admit oneself to the SFU room. A malicious group
 * member who saw a `sfu.ring.incoming` for unrelated calls (or who
 * guessed a 16-byte hex roomId via timing-side-channels) could land
 * uninvited in any room.
 *
 * Token shape (HMAC-SHA256 base64url, opaque to clients):
 *
 *   payload = `${roomId}|${userId}|${exp}`
 *   token   = `${payload}|${base64url(HMAC-SHA256(secret, payload))}`
 *
 * Properties:
 *   - Per-recipient: rebinding the token to a different userId
 *     produces an HMAC mismatch (constant-time compared).
 *   - Time-bounded: exp is the unix-second deadline beyond which join
 *     is refused (default 10 minutes from issue, easily long enough
 *     for a normal ring-and-answer cycle plus retries).
 *   - Stateless: the server doesn't keep an allowlist — the HMAC IS
 *     the allowlist. A revoked token cannot be replayed past `exp`.
 *
 * Secret rotation: changing `SFU_ROOM_TOKEN_SECRET` invalidates every
 * outstanding token at once. This is the intended kill-switch for
 * "any in-flight rings are compromised" scenarios.
 */
@Injectable()
export class RoomTokenService {
  constructor(private readonly config: ConfigService) {}

  private get secret(): Buffer {
    const s = this.config.get<string>('sfu.roomTokenSecret') ?? '';
    if (!s) {
      throw new InternalServerErrorException('sfu_room_token_not_configured');
    }
    return Buffer.from(s, 'utf8');
  }

  /**
   * Mint a token for a specific recipient. Defaults to a 30-minute
   * TTL — short enough that a stolen/replayed ring frame has bounded
   * value, long enough to absorb push delivery + cold-start + ICE
   * gather on a slow network plus iOS PushKit / Android Doze thaw.
   *
   * Audit row #5 (M1) — bumped from 10 to 30 minutes because aggressive
   * Doze / iOS Low Power can delay app foreground past the prior cap;
   * recipient would then hit `sfu.join` → `room_token_expired` with no
   * client-side re-mint path. 30 minutes is well under the window where
   * a captured ring frame has meaningful utility (the room itself is
   * gone by then in most failure modes).
   */
  issue(roomId: RoomId, recipientUserId: UserId, ttlSec = 1800): {token: string; exp: number} {
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const payload = `${roomId}|${recipientUserId}|${exp}`;
    const sig = createHmac('sha256', this.secret).update(payload).digest('base64url');
    return {token: `${payload}|${sig}`, exp};
  }

  /**
   * Verify a token presented at `sfu.join`. Returns `{ok: true}` when
   * the binding holds, `{ok: false, reason}` otherwise. Constant-time
   * HMAC comparison defends against the canonical timing oracle that
   * a `===` comparison would expose.
   */
  verify(token: string, expectedRoomId: string, expectedUserId: string): {ok: true} | {ok: false; reason: string} {
    if (typeof token !== 'string' || token.length < 16) {
      return {ok: false, reason: 'malformed_token'};
    }
    const parts = token.split('|');
    if (parts.length !== 4) return {ok: false, reason: 'malformed_token'};
    const [roomId, userId, expStr, sig] = parts;
    if (roomId !== expectedRoomId) return {ok: false, reason: 'room_mismatch'};
    if (userId !== expectedUserId) return {ok: false, reason: 'user_mismatch'};
    const exp = Number.parseInt(expStr, 10);
    if (!Number.isFinite(exp)) return {ok: false, reason: 'malformed_exp'};
    if (Math.floor(Date.now() / 1000) > exp) return {ok: false, reason: 'expired'};
    const payload = `${roomId}|${userId}|${expStr}`;
    const expected = createHmac('sha256', this.secret).update(payload).digest('base64url');
    let a: Buffer, b: Buffer;
    try {
      a = Buffer.from(sig, 'base64url');
      b = Buffer.from(expected, 'base64url');
    } catch {
      return {ok: false, reason: 'malformed_sig'};
    }
    if (a.length !== b.length || a.length === 0) return {ok: false, reason: 'sig_mismatch'};
    if (!timingSafeEqual(a, b)) return {ok: false, reason: 'sig_mismatch'};
    return {ok: true};
  }
}
