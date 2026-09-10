import type {SenderCertClient, IssuedCert} from '../transport';

/**
 * Caches the sealed-sender cert and refreshes it before expiry.
 * A single in-memory slot is fine — the cert is bound to this device's
 * identity key, which doesn't change at runtime. If the identity key
 * ever rotates, the cache must be invalidated.
 *
 * Refresh policy: request a new cert when less than 10 minutes remain.
 * This gives comfortable headroom for clock skew and network delay
 * without burning a call on every send.
 */

const REFRESH_MARGIN_SEC = 10 * 60;
/**
 * Fix #14: negative-cache TTL. Without it, a flapping auth-service
 * (rate-limited, briefly down) would hammer /sender-cert on EVERY
 * outbound message — each send blocks on a fresh fetch that re-fails
 * immediately, and the user sees one banner per send. Caching the
 * failure for 30s coalesces the storm into one error per window
 * while still recovering quickly when the server comes back.
 */
const NEGATIVE_CACHE_MS = 30_000;

export class SenderCertCache {
  private current: IssuedCert | null = null;
  private inflight: Promise<IssuedCert> | null = null;
  /** Last failure wall-clock + cached error for the negative-cache window. */
  private lastFailureAt: number = 0;
  private lastFailureErr: Error | null = null;

  constructor(
    private readonly client:             SenderCertClient,
    private readonly signalDeviceId:     number,
    private readonly ownIdentityKeyB64:  string,
  ) {}

  /**
   * Return a valid cert, fetching or refreshing if needed. Concurrent
   * callers share a single inflight request — no thundering herd.
   */
  async get(): Promise<string> {
    return (await this.getIssued()).cert;
  }

  /**
   * SN-06 — as `get()`, but also surfaces the cert's `exp`.
   *
   * The outbox stores fully-sealed envelope bytes, and a sender cert lives
   * only ~1h. A row queued through a long offline stretch was therefore
   * re-shipped carrying an EXPIRED cert, which the recipient hard-rejects
   * before libsignal decrypt — the message was destroyed on arrival while the
   * sender's bubble showed a delivered tick. Callers persist this expiry
   * alongside the sealed bytes so the drain can tell a still-valid envelope
   * from one that must be re-minted.
   */
  async getIssued(): Promise<IssuedCert> {
    const nowSec = Math.floor(Date.now() / 1000);
    if (this.current && this.current.expiresAt - nowSec > REFRESH_MARGIN_SEC) {
      return this.current;
    }
    // Fix #14: short-circuit if a recent fetch failed. Throw the same
    // cached error so callers see consistent messaging instead of a
    // fresh auth-service round-trip per send.
    if (this.lastFailureErr && Date.now() - this.lastFailureAt < NEGATIVE_CACHE_MS) {
      throw this.lastFailureErr;
    }
    if (!this.inflight) {
      this.inflight = this.client.issueCert({
        senderSignalDeviceId: this.signalDeviceId,
        senderIdentityKey:    this.ownIdentityKeyB64,
      }).then(issued => {
        this.current = issued;
        // Success — clear any prior failure so the next miss can fetch.
        this.lastFailureErr = null;
        this.lastFailureAt  = 0;
        return issued;
      }).catch(err => {
        // Fix #14: arm the negative cache. Re-throw so the awaiter
        // sees the failure synchronously this time; subsequent calls
        // within the window get the cached throw above.
        this.lastFailureErr = err instanceof Error ? err : new Error(String(err));
        this.lastFailureAt  = Date.now();
        throw err;
      }).finally(() => {
        this.inflight = null;
      });
    }
    return await this.inflight;
  }

  /** Drop the cached cert — next call will re-fetch. Use on auth change. */
  invalidate(): void {
    this.current = null;
    // Also clear the negative cache so a forced invalidate (typically
    // post-login) doesn't get blocked by a stale 30s window.
    this.lastFailureErr = null;
    this.lastFailureAt  = 0;
  }

  /**
   * Audit P1-N7 — revoke the currently-cached cert and invalidate.
   *
   * Called when our own identity rotates: the cert that was just
   * issued binds the SUPERSEDED identity key, so any receiver who
   * eventually catches up to our new identity will reject decrypts
   * under the stale cert with `IdentityKeyMismatchError`. Adding the
   * cert's JTI to the auth-service revocation list lets every
   * receiver who polls the list drop it actively rather than waiting
   * for the natural identity-mismatch reject.
   *
   * Safe under missing-endpoint (404): the local cache is still
   * invalidated so the next `get()` re-fetches a cert minted under
   * the new identity.
   */
  async revokeCurrentAndInvalidate(): Promise<{revoked: boolean; backendMissing: boolean}> {
    const cert = this.current?.cert;
    this.invalidate();
    if (!cert) {return {revoked: false, backendMissing: false};}
    const jti = parseCertJti(cert);
    if (!jti) {return {revoked: false, backendMissing: false};}
    try {
      return await this.client.revokeCert(jti);
    } catch {
      // Best-effort — never fail the rotation flow on a revoke error.
      return {revoked: false, backendMissing: false};
    }
  }
}

/**
 * Parse the JTI claim out of a sender cert (`<headerB64>.<payloadB64>.<sigB64>`).
 * Returns null on any parse failure rather than throwing — this is a
 * pure inspection helper and the caller already handles missing data.
 */
function parseCertJti(cert: string): string | null {
  const parts = cert.split('.');
  if (parts.length !== 3) {return null;}
  try {
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padding = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
    const json = typeof atob === 'function'
      ? atob(b64 + padding)
      : Buffer.from(b64 + padding, 'base64').toString('utf8');
    const obj = JSON.parse(json);
    return typeof obj?.jti === 'string' ? obj.jti : null;
  } catch {
    return null;
  }
}
