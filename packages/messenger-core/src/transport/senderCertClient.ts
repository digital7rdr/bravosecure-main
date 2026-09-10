/**
 * HTTP client for auth-service's sealed-sender cert endpoint.
 *
 *   POST /sender-cert  body={senderSignalDeviceId, senderIdentityKey}
 *                      returns {cert, expiresAt}
 *
 * The cert is a short-lived (~1h) Ed25519 JWT. Callers cache it via
 * CertCache and include it inside every outgoing sealed payload.
 */
import {fetchWithTimeout} from './fetchWithTimeout';

export interface SenderCertClientOptions {
  /** Auth-service base URL, e.g. http://10.0.2.2:3001 */
  baseUrl:  string;
  getToken: () => Promise<string | null>;
  /** Fix #19: optional refresh-on-401 — see relayClient for rationale. */
  refreshToken?: () => Promise<void>;
}

export class SenderCertHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'SenderCertHttpError';
  }
}

export interface IssuedCert {
  cert:      string;
  /** Unix seconds — same value the cert's own `exp` claim carries. */
  expiresAt: number;
}

export interface RevocationList {
  jtis: string[];
  asOf: number;
}

export class SenderCertClient {
  constructor(private readonly opts: SenderCertClientOptions) {}

  async issueCert(params: {
    senderSignalDeviceId: number;
    senderIdentityKey:    string;
  }): Promise<IssuedCert> {
    // Fix #19: retry once on 401 after a token refresh — see relayClient.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new SenderCertHttpError(401, 'no_token');}
      return fetchWithTimeout(`${this.opts.baseUrl}/sender-cert`, {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          senderSignalDeviceId: params.senderSignalDeviceId,
          senderIdentityKey:    params.senderIdentityKey,
        }),
      });
    };
    let res = await send();
    if (res.status === 401 && this.opts.refreshToken) {
      try { await this.opts.refreshToken(); res = await send(); } catch { /* fall through */ }
    }
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as {message: unknown}).message)
        : text || res.statusText;
      throw new SenderCertHttpError(res.status, msg);
    }
    return parsed as IssuedCert;
  }

  /**
   * Audit P1-N7 — best-effort revocation of an issued cert that's no
   * longer trustworthy (own identity rotation, leaked device, etc.).
   *
   * The auth-service endpoint may not be deployed yet; treat 404 as
   * non-fatal. Per CLAUDE.md `Stop conditions`, certs are tied to a
   * specific Signal identity public key, so an identity rotation
   * inherently makes every cert minted under the prior key reject on
   * any receiver that's already updated its identity binding for us
   * (they'd surface IdentityKeyMismatchError). Revocation gives us a
   * second line of defence: receivers who poll the revocation list
   * will drop the stale cert by JTI regardless of their local
   * identity binding state.
   *
   * Returns true on success or accepted-404; throws only on transport
   * errors or other 5xx-class server failures.
   */
  async revokeCert(jti: string): Promise<{revoked: boolean; backendMissing: boolean}> {
    const token = await this.opts.getToken();
    if (!token) {throw new SenderCertHttpError(401, 'no_token');}
    const res = await fetchWithTimeout(`${this.opts.baseUrl}/sender-cert/revoke`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({jti}),
    });
    if (res.status === 404) {return {revoked: false, backendMissing: true};}
    if (!res.ok) {
      const text = await res.text();
      throw new SenderCertHttpError(res.status, text || res.statusText);
    }
    return {revoked: true, backendMissing: false};
  }

  /**
   * Audit 1:1 P1-1 — fetch the current sender-cert revocation list.
   *
   * Endpoint is unauthenticated by design (the list itself is non-
   * sensitive — jtis are not secrets) but rate-limited server-side
   * via @Throttle. Caller is expected to poll on a 5–10 min cadence
   * via `RevokedJtiCache` and pass the resulting set to
   * `verifySenderCert.revokedJtis`.
   */
  async fetchRevocationList(): Promise<RevocationList> {
    const res = await fetchWithTimeout(`${this.opts.baseUrl}/sender-cert/revocation-list`, {
      method: 'GET',
      headers: {Accept: 'application/json'},
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as {message: unknown}).message)
        : text || res.statusText;
      throw new SenderCertHttpError(res.status, msg);
    }
    const out = parsed as Partial<RevocationList> | null;
    return {
      jtis: Array.isArray(out?.jtis) ? out!.jtis.filter(j => typeof j === 'string') : [],
      asOf: typeof out?.asOf === 'number' ? out!.asOf : Math.floor(Date.now() / 1000),
    };
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
