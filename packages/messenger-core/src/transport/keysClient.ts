import type {PreKeyBundle, SessionAddress} from '../crypto/types';
import {verifyBundleBinding, type BundleAuthoritySig} from '../crypto/bundleBinding';
import {fetchWithTimeout} from './fetchWithTimeout';

/**
 * HTTP adapter for auth-service's existing keys endpoints.
 *
 *   POST /auth/keys/upload   — upload bundle + batch of pre-keys
 *   GET  /auth/keys/:userId  — fetch peer's bundle; server atomically
 *                              pops one one-time pre-key per call.
 *
 * Field-name translation lives HERE so the rest of the client uses
 * the internal `PreKeyBundle` shape (camelCase, nested signedPreKey).
 * Auth-service speaks `signedPrekey`/`oneTimePrekeys` (legacy casing).
 *
 * Phase-1 simplification: auth-service stores ONE identity per user,
 * no per-device dimension. We hardcode `deviceId: 1` when wrapping
 * fetched bundles into our internal shape. Multi-device support in
 * auth-service is a Phase-2 project.
 */

/** Server DTO — what POST /auth/keys/upload accepts. */
interface ServerUploadDto {
  registrationId:  number;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  oneTimePrekeys?: {keyId: number; publicKey: string}[];
}

/** Server response — what GET /auth/keys/:userId returns. */
interface ServerBundleResponse {
  registrationId:  number;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  oneTimePrekey:   {keyId: number; publicKey: string} | null;
  /** Audit P0-I2 — server-side authority binding over the fields above. */
  authoritySig?:   BundleAuthoritySig | null;
}

export interface KeysHttpClientOptions {
  /** Auth-service base URL, e.g. http://10.0.2.2:3001 */
  baseUrl:  string;
  getToken: () => Promise<string | null>;
  /**
   * Fix #19: optional refresh-on-401. When auth-service returns 401
   * (typically expired access token), the client invokes this once
   * and retries with the freshly-refreshed token from `getToken`.
   * Caller is expected to dedupe concurrent refreshes (api.ts's
   * `fetchWithRefresh` does this via `refreshInFlight`).
   */
  refreshToken?: () => Promise<void>;
  /**
   * Audit P0-I2 — pinned base64 Curve25519 authority pubkey (same key
   * the sender-cert verifier uses). When set, every fetched peer
   * bundle is verified against the server's authority signature
   * before being returned to the caller. Leave undefined for the
   * legacy harness path; production clients should always pin.
   */
  authorityPubKeyB64?:   string;
  /**
   * Audit P0-I2 — strict-mode flag. When true (default) a fetched
   * bundle missing `authoritySig` is rejected. The rollback escape
   * hatch is for the brief window between a coordinated server
   * deploy and the client fleet rolling forward.
   */
  requireBundleBinding?: boolean;
  /**
   * Audit P0-I2 — freshness cap on the authority signature
   * (`now - signedAtMs <= bundleBindingMaxAgeMs`). Defaults to the
   * crypto/bundleBinding.ts library default (7d). Operators can tune
   * down once P0-I1 signed-prekey rotation actually fires regularly.
   */
  bundleBindingMaxAgeMs?: number;
}

export class KeysHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'KeysHttpError';
  }
}

export class KeysHttpClient {
  constructor(private readonly opts: KeysHttpClientOptions) {}

  /**
   * Upload our own bundle + pre-key pool. Call after first install
   * (or when refilling the OPK pool — server supports append-only).
   */
  async uploadBundle(params: {
    registrationId:  number;
    identityKey:     string;
    signedPreKey:    {keyId: number; publicKey: string; signature: string};
    oneTimePreKeys?: {keyId: number; publicKey: string}[];
  }): Promise<{
    ok: true;
    oneTimeKeysStored: number;
    poolSize: number;
    /**
     * Handoff §4.5-1 — server-detected identity rotation. True when the
     * uploaded identity differs from the one previously on file for this
     * (userId, deviceId) — a reinstall/recovery minted a new keypair.
     * `previousIdentityKey` (base64 PUBLIC key) is the superseded
     * identity the relay purge endpoint needs; present only when
     * rotated. Absent on servers predating the field (treat as
     * not-rotated).
     */
    identityRotated?: boolean;
    previousIdentityKey?: string;
  }> {
    const body: ServerUploadDto = {
      registrationId:  params.registrationId,
      identityKey:     params.identityKey,
      signedPrekeyId:  params.signedPreKey.keyId,
      signedPrekey:    params.signedPreKey.publicKey,
      signedPrekeySig: params.signedPreKey.signature,
      oneTimePrekeys:  params.oneTimePreKeys,
    };
    return this.request('POST', '/auth/keys/upload', body);
  }

  /**
   * Handoff §4.5-4 — mint a short-lived MFA action token (auth-service
   * `POST /auth/biometric/assert`) for a purpose-gated relay call
   * (current consumer: `recipient_purge` for the stale-queue purge).
   * Returns null on ANY failure — callers are best-effort flows that
   * must proceed without the proof.
   *
   * `attestationToken`: a real Play Integrity / DeviceCheck token when
   * the app has one. The default placeholder only passes where
   * BIOMETRIC_DEV_BYPASS=true (staging); production correctly rejects
   * it and the caller degrades gracefully. Deliberately NOT a bypass —
   * the server-side MFA gate stays fully intact.
   */
  async mintActionToken(
    purpose: string,
    attestationToken = 'attestation-unavailable',
  ): Promise<{actionToken: string} | null> {
    try {
      const res = await this.request<{actionToken?: string}>('POST', '/auth/biometric/assert', {
        attestationToken,
        platform: 'android',
        purpose,
      });
      return res?.actionToken ? {actionToken: res.actionToken} : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a peer bundle AND surface the pool-size header so the
   * runtime can trigger an OPK refill when the pool is getting low.
   * auth-service sets `X-Pre-Key-Count` whenever the pool drops below
   * its threshold; we translate that into an optional field here.
   */
  async fetchPeerBundleWithPoolSize(userId: string): Promise<{
    bundle:   PreKeyBundle;
    poolSize: number | null;
  }> {
    // Fix #19: retry once on 401 after a token refresh.
    const fetchOnce = async (): Promise<Response> => {
      const tok = await this.opts.getToken();
      if (!tok) {throw new KeysHttpError(401, 'no_token');}
      return fetchWithTimeout(`${this.opts.baseUrl}/auth/keys/${encodeURIComponent(userId)}`, {
        headers: {Authorization: `Bearer ${tok}`},
      });
    };
    let res = await fetchOnce();
    if (res.status === 401 && this.opts.refreshToken) {
      try { await this.opts.refreshToken(); res = await fetchOnce(); } catch { /* fall through */ }
    }
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (!res.ok) {throw new KeysHttpError(res.status, (parsed?.message as string) ?? res.statusText);}

    const poolHeader = res.headers.get('x-pre-key-count') ?? res.headers.get('X-Pre-Key-Count');
    const poolSize   = poolHeader ? Number.parseInt(poolHeader, 10) : null;

    const resp = parsed as ServerBundleResponse;
    const bundle: PreKeyBundle = {
      registrationId: resp.registrationId,
      address:        {userId, deviceId: 1},
      identityKey:    resp.identityKey,
      signedPreKey: {
        keyId:     resp.signedPrekeyId,
        publicKey: resp.signedPrekey,
        signature: resp.signedPrekeySig,
      },
    };
    if (resp.oneTimePrekey) {
      bundle.preKey = {keyId: resp.oneTimePrekey.keyId, publicKey: resp.oneTimePrekey.publicKey};
    }
    // Audit P0-I2 — verify the server-supplied authority binding before
    // handing the bundle to the caller. A malicious / coerced keys-
    // service can MITM identity end-to-end if we trust unverified bundles.
    await this.verifyOrThrow(bundle, resp.authoritySig ?? null);
    return {bundle, poolSize: Number.isFinite(poolSize as number) ? poolSize : null};
  }

  /**
   * Fetch a peer's bundle for X3DH. Returns an internal PreKeyBundle
   * shape. Each call consumes ONE one-time pre-key from the peer's
   * server-side pool — never call speculatively.
   */
  async fetchPeerBundle(userId: string): Promise<PreKeyBundle> {
    const resp = await this.request<ServerBundleResponse>(
      'GET',
      `/auth/keys/${encodeURIComponent(userId)}`,
    );
    const address: SessionAddress = {userId, deviceId: 1};
    const bundle: PreKeyBundle = {
      registrationId: resp.registrationId,
      address,
      identityKey:    resp.identityKey,
      signedPreKey: {
        keyId:     resp.signedPrekeyId,
        publicKey: resp.signedPrekey,
        signature: resp.signedPrekeySig,
      },
    };
    if (resp.oneTimePrekey) {
      bundle.preKey = {
        keyId:     resp.oneTimePrekey.keyId,
        publicKey: resp.oneTimePrekey.publicKey,
      };
    }
    // Audit P0-I2 — verify before returning. See verifyOrThrow.
    await this.verifyOrThrow(bundle, resp.authoritySig ?? null);
    return bundle;
  }

  /**
   * B-18 / CRIT-7 — fetch ALL of a peer's device bundles for multi-device
   * fan-out. Each entry carries its real deviceId and its OWN authority binding
   * (verified here). Consumes one OPK per device server-side, so only call when
   * multi-device fan-out is enabled. Returns one PreKeyBundle per live device.
   */
  async fetchDevices(userId: string): Promise<PreKeyBundle[]> {
    const resp = await this.request<{devices: Array<ServerBundleResponse & {deviceId: number}>}>(
      'GET',
      `/auth/keys/${encodeURIComponent(userId)}/devices`,
    );
    const out: PreKeyBundle[] = [];
    for (const d of resp.devices ?? []) {
      const bundle: PreKeyBundle = {
        registrationId: d.registrationId,
        address:        {userId, deviceId: d.deviceId},
        identityKey:    d.identityKey,
        signedPreKey: {
          keyId:     d.signedPrekeyId,
          publicKey: d.signedPrekey,
          signature: d.signedPrekeySig,
        },
      };
      if (d.oneTimePrekey) {
        bundle.preKey = {keyId: d.oneTimePrekey.keyId, publicKey: d.oneTimePrekey.publicKey};
      }
      // Verify each device's authority binding independently.
      await this.verifyOrThrow(bundle, d.authoritySig ?? null);
      out.push(bundle);
    }
    return out;
  }

  /**
   * Audit P0-I2 — verify the authority binding on a freshly-fetched
   * peer bundle. Throws KeysHttpError(495) on missing / invalid /
   * expired. No-op when the client has no `authorityPubKeyB64`
   * pinned (legacy harness path; tests that don't care about the
   * binding rely on this).
   *
   * Error vocabulary (`KeysHttpError.message`):
   *   - `bundle_authority_sig_missing` — strict-mode reject when
   *     server omitted the signature entirely.
   *   - `bundle_authority_sig_invalid: <reason>` — signature failed
   *     to verify (key MITM, identityKey swap, sig tamper).
   *   - `bundle_authority_sig_invalid: ...expired...` — signedAtMs
   *     older than `bundleBindingMaxAgeMs`. The substring "expired"
   *     is preserved so callers can pattern-match on the broader
   *     class.
   */
  private async verifyOrThrow(
    bundle:       PreKeyBundle,
    authoritySig: BundleAuthoritySig | null,
  ): Promise<void> {
    const pinned = this.opts.authorityPubKeyB64;
    if (!pinned) {return;} // legacy / harness path

    const strict = this.opts.requireBundleBinding ?? true;
    if (!authoritySig) {
      if (strict) {throw new KeysHttpError(495, 'bundle_authority_sig_missing');}
      return;
    }
    try {
      await verifyBundleBinding({
        bundle,
        authoritySig,
        authorityPubKeyB64: pinned,
        maxAgeMs:           this.opts.bundleBindingMaxAgeMs,
      });
    } catch (e) {
      const reason = (e as Error)?.message ?? 'unknown';
      throw new KeysHttpError(495, `bundle_authority_sig_invalid: ${reason}`);
    }
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    // Fix #19: retry once on 401 after a token refresh.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new KeysHttpError(401, 'no_token');}
      return fetchWithTimeout(`${this.opts.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? {'Content-Type': 'application/json'} : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
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
      throw new KeysHttpError(res.status, msg);
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
