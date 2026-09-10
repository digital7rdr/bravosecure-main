/**
 * APNs HTTP/2 client for VoIP pushes.
 *
 * No external dependency — uses Node's built-in `node:http2` and
 * `node:crypto`. The .p8 key is loaded once from disk and used to
 * sign a JWT every ~50 minutes (Apple rejects tokens older than 1h).
 *
 * Why a hand-rolled client instead of `node-apn` / `apn` / `@parse/node-apn`:
 *   - Smallest possible attack surface for what's literally three
 *     header fields and a JSON body.
 *   - The published apn libraries haven't tracked Apple's HTTP/2
 *     contract closely (one is unmaintained, the other is opinionated
 *     about provider tokens vs. cert auth).
 *   - We only do VoIP pushes from this service — none of the rich
 *     features (silent push throttling, certificate auth, channel
 *     priority tuning) other libraries provide.
 *
 * Apple's VoIP push contract (mid-2026):
 *   POST https://api.push.apple.com/3/device/<deviceToken>
 *   :method = POST
 *   :path   = /3/device/<deviceToken>
 *   apns-topic        = <bundleId>.voip
 *   apns-push-type    = voip
 *   apns-priority     = 10
 *   apns-expiration   = 0          (deliver-or-drop, no queue)
 *   authorization     = bearer <jwt>
 *   content-type      = application/json
 *   <body: arbitrary JSON delivered to PKPushRegistry>
 *
 * 200 = delivered. 400/410/etc = client error (token invalid, key
 * mis-signed). The full reason is in `:status` + JSON body's
 * `reason` field.
 */
import * as http2 from 'node:http2';
import * as fs from 'node:fs';
import * as crypto from 'node:crypto';

const APNS_HOST_PROD    = 'https://api.push.apple.com';
const APNS_HOST_SANDBOX = 'https://api.sandbox.push.apple.com';

/** Tokens are valid for 1h; refresh every 50min to give a buffer. */
const TOKEN_REFRESH_MS = 50 * 60 * 1000;

export interface ApnsConfig {
  keyId:    string;       // From Apple Developer → Keys (e.g. ABC1234DEF)
  teamId:   string;       // 10-char team ID
  bundleId: string;       // e.g. com.bravosecure.app
  keyPath:  string;       // Path to AuthKey_<keyId>.p8 file on disk
  /** Default false (production). Set true for sandbox token testing. */
  sandbox?: boolean;
  /**
   * P0-N7: SHA-256 pin of the expected .p8 contents (hex). When set,
   * the client refuses to mint a JWT if the file's hash doesn't match.
   * Closes the "swap the .p8 on disk and the next 50min the worker will
   * happily sign with the attacker key" path. Tracked end-to-end
   * via the operator pipeline: rotate the .p8 → re-deploy with the
   * new pin → workers refuse the old key until they pick up the new
   * config. Without a pin the client logs a single warn at boot.
   */
  expectedKeySha256Hex?: string;
}

export interface ApnsSendResult {
  /** HTTP status code from APNs (200 = delivered). */
  status:  number;
  /** Apple's reason string when status !== 200 (BadDeviceToken, etc). */
  reason?: string;
  /** Raw response text for diagnostics. */
  body?:   string;
}

/**
 * Singleton-ish client. Multi-instance is fine but each instance
 * holds its own HTTP/2 session — share when possible to keep the
 * connection warm (HTTP/2 multiplexing means one session handles
 * thousands of pushes per second).
 */
export class ApnsClient {
  private readonly cfg: ApnsConfig;
  private readonly host: string;
  private session: http2.ClientHttp2Session | null = null;
  private privateKeyPem: string | null = null;
  /** P0-N7: mtime of the .p8 at last load; mismatch forces re-read+rehash. */
  private privateKeyMtimeMs: number = 0;
  private cachedToken: {jwt: string; mintedAtMs: number} | null = null;

  constructor(cfg: ApnsConfig) {
    this.cfg  = cfg;
    this.host = cfg.sandbox ? APNS_HOST_SANDBOX : APNS_HOST_PROD;
    if (!cfg.expectedKeySha256Hex) {
      console.warn('[apns] expectedKeySha256Hex not set — .p8 swap-detection is OFF (P0-N7)');
    }
  }

  /**
   * Send a VoIP push. Body must be a JSON-serialisable object — the
   * VoIP delivery contract has no `aps` envelope; the entire body is
   * forwarded to PKPushRegistry's `payload` field.
   */
  async sendVoip(deviceToken: string, body: Record<string, unknown>): Promise<ApnsSendResult> {
    const jwt = this.getOrMintJwt();
    const session = this.ensureSession();
    const json = JSON.stringify(body);

    return new Promise<ApnsSendResult>((resolve, reject) => {
      const req = session.request({
        ':method':         'POST',
        ':path':           `/3/device/${deviceToken}`,
        'apns-topic':      `${this.cfg.bundleId}.voip`,
        'apns-push-type':  'voip',
        'apns-priority':   '10',
        'apns-expiration': '0',
        'authorization':   `bearer ${jwt}`,
        'content-type':    'application/json',
        'content-length':  Buffer.byteLength(json).toString(),
      });

      let status = 0;
      let respBody = '';

      req.on('response', (headers) => {
        const s = headers[':status'];
        status = typeof s === 'number' ? s : Number(s ?? 0);
      });
      req.on('data', (chunk: Buffer | string) => {
        respBody += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      });
      req.on('end', () => {
        let reason: string | undefined;
        if (status !== 200 && respBody) {
          try {
            const parsed = JSON.parse(respBody) as {reason?: string};
            reason = parsed.reason;
          } catch { /* non-JSON error body — keep raw */ }
        }
        resolve({status, reason, body: respBody || undefined});
      });
      req.on('error', (err) => {
        // Drop the session so the next call rebuilds it. http2 sessions
        // do NOT auto-recover from socket errors.
        this.dropSession();
        reject(err);
      });

      req.setEncoding('utf8');
      req.end(json);
    });
  }

  /**
   * Close the HTTP/2 session. Optional — Node will close on process
   * exit anyway. Useful for graceful shutdown / testing.
   */
  close(): void { this.dropSession(); }

  // ── internals ────────────────────────────────────────────────────

  private ensureSession(): http2.ClientHttp2Session {
    if (this.session && !this.session.closed && !this.session.destroyed) {
      return this.session;
    }
    this.session = http2.connect(this.host);
    this.session.on('error', () => { this.dropSession(); });
    this.session.on('close', () => { this.session = null; });
    return this.session;
  }

  private dropSession(): void {
    if (this.session) {
      try { this.session.close(); } catch { /* ignore */ }
      this.session = null;
    }
  }

  private getOrMintJwt(): string {
    const now = Date.now();
    if (this.cachedToken && now - this.cachedToken.mintedAtMs < TOKEN_REFRESH_MS) {
      return this.cachedToken.jwt;
    }
    const jwt = this.mintJwt(now);
    this.cachedToken = {jwt, mintedAtMs: now};
    return jwt;
  }

  /**
   * Mint a fresh ES256-signed JWT for APNs. Apple's contract:
   *   header  { alg: 'ES256', kid: keyId, typ: 'JWT' }
   *   payload { iss: teamId, iat: <unix-secs> }
   *   signature = ECDSA-P256-SHA256( base64url(header) + '.' + base64url(payload) )
   *
   * Node's `crypto.sign` with the .p8 key returns DER. Apple wants
   * the JOSE format (raw r || s, 64 bytes total). We convert via the
   * `dsaEncoding: 'ieee-p1363'` option — saves ~30 lines of manual
   * DER → JOSE conversion.
   */
  private mintJwt(nowMs: number): string {
    // P0-N7: stat the file every mint to detect in-place rotation. The
    // 50-min cache means at most one stat per ~50 min per worker; the
    // syscall cost is negligible. On mtime change we re-read AND
    // re-verify the SHA pin so a swapped key never signs a token.
    const stat = fs.statSync(this.cfg.keyPath);
    if (!this.privateKeyPem || stat.mtimeMs !== this.privateKeyMtimeMs) {
      const pem = fs.readFileSync(this.cfg.keyPath, 'utf8');
      if (this.cfg.expectedKeySha256Hex) {
        const actual = crypto.createHash('sha256').update(pem).digest('hex');
        if (actual !== this.cfg.expectedKeySha256Hex.toLowerCase()) {
          // Refuse to mint. The caller will surface this to ops; do not
          // log the key bytes, only the hash mismatch.
          throw new Error(`[apns] .p8 pin mismatch — refusing to mint (P0-N7). expected=${this.cfg.expectedKeySha256Hex.slice(0, 8)}… actual=${actual.slice(0, 8)}…`);
        }
      }
      this.privateKeyPem = pem;
      this.privateKeyMtimeMs = stat.mtimeMs;
      // Force token re-mint after rotation: drop the cached JWT.
      this.cachedToken = null;
    }

    const header  = {alg: 'ES256', kid: this.cfg.keyId, typ: 'JWT'};
    const payload = {iss: this.cfg.teamId, iat: Math.floor(nowMs / 1000)};

    const headerB64  = base64UrlJson(header);
    const payloadB64 = base64UrlJson(payload);
    const signingInput = `${headerB64}.${payloadB64}`;

    const signature = crypto.sign(null, Buffer.from(signingInput), {
      key:           this.privateKeyPem,
      dsaEncoding:   'ieee-p1363',
    });
    const signatureB64 = bufferToBase64Url(signature);

    return `${signingInput}.${signatureB64}`;
  }
}

function base64UrlJson(obj: unknown): string {
  return bufferToBase64Url(Buffer.from(JSON.stringify(obj), 'utf8'));
}

function bufferToBase64Url(buf: Buffer): string {
  return buf.toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
