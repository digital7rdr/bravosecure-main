import {Injectable, Logger, InternalServerErrorException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {AsyncCurve25519Wrapper} from '@privacyresearch/curve25519-typescript';
import {randomUUID} from 'node:crypto';
import {RedisService} from '../redis/redis.service';
import {encodeCert, signingInput, type CertPayload} from './cert-format';

/**
 * Issues short-lived XEd25519-signed sender certificates for Sealed
 * Sender (M4) and tracks revocations (M12-follow-up per WBS BE-2.2).
 *
 * Signing primitive: XEd25519 over Curve25519, the same primitive
 * libsignal uses for SignedPreKey signatures. We deliberately don't
 * use Node's native Ed25519 — react-native-quick-crypto on mobile
 * doesn't expose Ed25519 in `crypto.subtle`, but it does ship the
 * curve25519-typescript wasm via libsignal, so the receiving clients
 * verify with no extra polyfill. Matches the architecture-spec line
 * "uses libsignal … and Sealed Sender metadata protection".
 *
 * Cert claims bind:
 *   - auth-service user id (`sub`)
 *   - Signal device id (numeric)
 *   - Signal identity public key (base64 Curve25519)
 *
 * Private key (32-byte Curve25519 priv, base64) lives in the Nest
 * process memory only. Public key (32 bytes, base64) ships with the
 * client bundle. Messenger-service does NOT verify certs — they're
 * opaque to the relay (see M4).
 *
 * Revocation model:
 *   - Each minted cert has a UUID `jti` claim.
 *   - Admin / sign-out flows can revoke a jti via `revoke()` — stored
 *     in Redis with a TTL matching the cert expiry (post-expiry
 *     revocation is moot).
 *   - Clients periodically poll `revocationList()` and consult their
 *     local cache before treating a cert as valid.
 *   - Shorter cert TTL + the revocation list together bound compromise
 *     exposure to at most `TTL - (poll interval)`.
 */
@Injectable()
export class SenderCertService {
  private readonly logger = new Logger(SenderCertService.name);
  private readonly curve = new AsyncCurve25519Wrapper();
  private privateKeyAb: ArrayBuffer | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly redis:  RedisService,
  ) {}

  private getPrivateKeyAb(): ArrayBuffer {
    if (this.privateKeyAb) return this.privateKeyAb;
    const b64 = this.config.get<string>('senderCert.privateKeyB64');
    if (!b64) throw new InternalServerErrorException('sender_cert_private_key_missing');
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, 'base64');
    } catch (e) {
      this.logger.error('sender-cert priv key not valid base64: ' + (e as Error).message);
      throw new InternalServerErrorException('sender_cert_private_key_invalid');
    }
    if (buf.byteLength !== 32) {
      this.logger.error(`sender-cert priv key wrong length: ${buf.byteLength} (need 32)`);
      throw new InternalServerErrorException('sender_cert_private_key_invalid');
    }
    // `.buffer` on Node Buffer is now typed `ArrayBuffer | SharedArrayBuffer`;
    // the runtime value here is always an ArrayBuffer (Buffer.from(string,
    // 'base64') doesn't share). Cast for assignability.
    this.privateKeyAb = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return this.privateKeyAb;
  }

  /**
   * Mint a cert. Caller must have proven auth via JwtAuthGuard; we
   * copy `sub` from the verified JWT, not from request input.
   */
  async issue(params: {
    senderUserId:        string;
    senderSignalDeviceId: number;
    senderIdentityKey:   string;
  }): Promise<{cert: string; expiresAt: number; jti: string}> {
    // Audit 1:1 P1-2 — cert TTL aligned with the AAD freshness window.
    //
    // Previously 24h (86400s). The receiver's AAD timestamp check
    // (SEALED_AAD_SKEW_MS in sealedSender.ts) hard-rejects any
    // ciphertext sealed more than 15 min ago, so a leaked cert was
    // useful only for as long as the attacker could mint fresh AADs —
    // ~24h. Dropping cert TTL to 1h means even with the revocation-
    // list poll cadence (5 min, see P1-1) and SenderCertCache refresh
    // margin (10 min, see certCache.ts), the worst-case leaked-cert
    // window collapses from 24h to roughly cert-TTL + poll-cadence.
    // Clients refresh every cert at the 10-min-remaining mark, so the
    // visible cadence is one refresh per ~50 min of activity — well
    // within steady-state quota.
    const ttlSec = this.config.get<number>('senderCert.ttlSeconds') ?? 3600;
    const issuer = this.config.get<string>('senderCert.issuer') ?? 'auth-service';
    const now = Math.floor(Date.now() / 1000);
    const exp = now + ttlSec;
    const jti = randomUUID();
    // P2-17 — stamp the caller's CURRENT revoke-all generation into the
    // signed payload. `revokeAllForUser` increments this counter, so once a
    // verifier compares `cert.gen >= currentUserGeneration`, every cert
    // minted before a "revoke all sessions" is rejected. Additive field —
    // clients that don't read it are unaffected.
    const gen = await this.userGeneration(params.senderUserId);
    const payload: CertPayload = {
      senderUserId:         params.senderUserId,
      senderSignalDeviceId: params.senderSignalDeviceId,
      senderIdentityKey:    params.senderIdentityKey,
      iat: now,
      exp,
      iss: issuer,
      jti,
      gen,
    };
    const msg = signingInput(payload);
    const msgAb = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer;
    const sigAb = await this.curve.sign(this.getPrivateKeyAb(), msgAb);
    const cert  = encodeCert(payload, new Uint8Array(sigAb));
    // Auth audit P0-A7 — record the owner of this jti so `revoke()`
    // can enforce ownership. Without this, any authed user could
    // revoke any other user's cert (jtis are not secret — they appear
    // in the public revocation-list AND inside the cert blob the
    // receiver decrypts). TTL matches the cert's `exp` so the owner
    // record auto-evicts when the cert is no longer useful anyway.
    await this.redis.client.set(ownerKey(jti), params.senderUserId, 'EX', ttlSec);
    return {cert, expiresAt: exp, jti};
  }

  /**
   * Revoke a cert by its jti. Idempotent — the Redis SET just gets
   * refreshed on repeat. TTL matches the cert's remaining lifetime
   * (caller supplies it because the server doesn't store cert bodies).
   *
   * Auth audit P0-A7 — `callerSub` is now REQUIRED and verified against
   * the per-jti owner record stored at `issue()` time. Without this
   * check, any authed user could revoke any other user's cert; jtis
   * are not secret (they live inside the cert blob the receiver sees
   * AND in the public revocation-list). Returns `{ok}` so the
   * controller can surface 403s vs 200s cleanly.
   *
   * Unknown jti (e.g. owner record TTL'd out, or never issued by us):
   * we accept the revocation defensively but log it — there's no harm
   * in revoking a cert that doesn't exist, and refusing would create
   * a probe oracle for "is jti X live?".
   */
  async revoke(jti: string, ttlSeconds: number, callerSub: string): Promise<{ok: true}> {
    if (!/^[0-9a-f-]{36}$/i.test(jti)) {
      throw new Error('invalid_jti');
    }
    const owner = await this.redis.client.get(ownerKey(jti));
    if (owner && owner !== callerSub) {
      this.logger.warn(
        `[P0-A7] cross-user revoke blocked jti=${jti.slice(0, 8)} caller=${callerSub.slice(0, 8)} owner=${owner.slice(0, 8)}`,
      );
      throw new Error('not_owner');
    }
    const ttl = Math.max(60, Math.min(ttlSeconds, 86400 * 2));
    await this.redis.client.set(revokedKey(jti), '1', 'EX', ttl);
    this.logger.log(`sender-cert.revoke jti=${jti} ttl=${ttl}s caller=${callerSub.slice(0, 8)}`);
    return {ok: true};
  }

  /**
   * Revoke ALL of a user's active certs — used by sign-out / "revoke
   * all sessions" flows. Uses a per-user generation counter: certs
   * minted before the current generation are considered revoked.
   *
   * Clients check `genAtCertIat >= userGeneration` when verifying.
   * Advancing the counter instantly invalidates every outstanding
   * cert for that user without needing to enumerate jtis.
   */
  async revokeAllForUser(userId: string): Promise<{newGeneration: number}> {
    const key = userGenKey(userId);
    const next = await this.redis.client.incr(key);
    await this.redis.client.expire(key, 86400 * 30);
    this.logger.log(`sender-cert.revoke-all sub=${userId} gen=${next}`);
    return {newGeneration: next};
  }

  /** Return the full active-revoked-jti list (bounded by Redis TTL auto-expiry). */
  async revocationList(): Promise<{jtis: string[]; asOf: number}> {
    const jtis: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.redis.client.scan(
        cursor, 'MATCH', `${REVOKED_KEY_PREFIX}*`, 'COUNT', 256,
      );
      cursor = next;
      for (const k of batch) jtis.push(k.slice(REVOKED_KEY_PREFIX.length));
    } while (cursor !== '0');
    return {jtis, asOf: Math.floor(Date.now() / 1000)};
  }

  async userGeneration(userId: string): Promise<number> {
    const v = await this.redis.client.get(userGenKey(userId));
    return v ? Number.parseInt(v, 10) || 0 : 0;
  }
}

const REVOKED_KEY_PREFIX = 'sender-cert:revoked:';

function revokedKey(jti: string): string {
  return `${REVOKED_KEY_PREFIX}${jti}`;
}

function userGenKey(userId: string): string {
  return `sender-cert:gen:${userId}`;
}

// Auth audit P0-A7 — per-jti owner mapping. Looked up by `revoke()` to
// enforce that only the original issuer can revoke their own cert.
function ownerKey(jti: string): string {
  return `sender-cert:owner:${jti}`;
}
