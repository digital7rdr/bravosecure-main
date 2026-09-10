import {Injectable, InternalServerErrorException, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createHmac, randomBytes} from 'node:crypto';

/**
 * TURN credential issuer — coturn `use-auth-secret` REST API pattern.
 *
 * Protocol:
 *   username   = `${unix-timestamp}:${opaque-credential-id}`
 *   credential = base64(HMAC-SHA1(static-auth-secret, username))
 *
 * coturn verifies by computing the same HMAC against its configured
 * static-auth-secret. The `unix-timestamp` embedded in the username
 * is the credential's expiry — coturn rejects any request where
 * `now > that-timestamp`, so stolen creds have bounded value.
 *
 * Audit P1-C8 — `opaque-credential-id` is a random 16-byte HEX value,
 * NOT the auth-service `callerUserId`. Previously the username embedded
 * `${expiresAt}:${callerUserId}` so coturn's access log was a
 * who-called-whom oracle: any operator with `--log-file` access could
 * map TURN sessions to specific users, building a contact graph from
 * call-time correlation. The opaque id is logged INTERNALLY by
 * messenger-service alongside the real callerUserId at issue time so
 * abuse investigations can still join the two — but the join requires
 * access to the messenger-service audit log, not just coturn access
 * logs (and certainly not a leaked URL).
 */
@Injectable()
export class TurnService {
  private readonly logger = new Logger(TurnService.name);
  constructor(private readonly config: ConfigService) {}

  /**
   * Issue time-limited credentials for the given caller.
   *
   * The returned object matches the shape RTCPeerConnection expects
   * for its `iceServers` config — pass it straight through on the
   * client without transformation.
   */
  issueCredentials(callerUserId: string): {
    username:   string;
    credential: string;
    urls:       string[];
    expiresAt:  number;
  } {
    const secret = this.config.get<string>('turn.staticAuthSecret') ?? '';
    if (!secret) {
      throw new InternalServerErrorException('turn_not_configured');
    }
    const turnUrls = this.config.get<string[]>('turn.urls') ?? [];
    if (turnUrls.length === 0) {
      throw new InternalServerErrorException('turn_urls_missing');
    }
    const stunUrls = this.config.get<string[]>('turn.stunUrls') ?? [];
    const ttlSec   = this.config.get<number>('turn.ttlSeconds') ?? 86400;
    const expiresAt = Math.floor(Date.now() / 1000) + ttlSec;
    // Audit P1-C8 — opaque per-credential id replaces the cleartext
    // userId. 16 random bytes hex-encoded (32 chars) — large enough to
    // make collisions astronomical inside any reasonable TTL window
    // (~10^9 issued per second to reach 1% collision risk).
    const opaqueId   = randomBytes(16).toString('hex');
    const username   = `${expiresAt}:${opaqueId}`;
    const credential = createHmac('sha1', secret).update(username).digest('base64');
    // Internal-only attribution log so abuse investigations can still
    // correlate a coturn session to the caller. coturn's access log
    // sees only the opaque id; the (opaque → real) mapping lives in
    // this service's stdout, which is rotated and not shared with
    // operators outside the messenger-service trust boundary.
    this.logger.log(`turn.issue exp=${expiresAt} cid=${opaqueId} sub=${callerUserId}`);
    // STUN URLs first so the engine gathers srflx candidates without
    // waiting on the (potentially slower) TURN allocate round-trip.
    // Per W3C IceServer spec, stun: URLs in the same entry as turn:
    // URLs ignore username/credential, so this single response covers
    // both auth-free STUN binding and authed TURN allocate/permission.
    const urls = [...stunUrls, ...turnUrls];
    return {username, credential, urls, expiresAt};
  }
}
