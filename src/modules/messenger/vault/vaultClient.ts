import {encryptAttachment, decryptAttachment} from '../media/aesCbc';

/**
 * Client adapter for the File Vault (M10). Distinct from MediaClient
 * (M6) — every call here REQUIRES a fresh MFA proof in the
 * `X-Mfa-Proof` header, obtained via the host's MFA flow:
 *
 *   1. user performs biometric (expo-local-authentication) locally
 *   2. user enters TOTP code
 *   3. app POSTs code to auth-service /auth/totp/verify → action token
 *   4. action token passed here as `mfaProof`
 *
 * The MFA step is NOT performed by this module — the host owns the
 * UX decision of when to re-prompt. This module just threads the
 * proof string through to messenger-service.
 */

export interface VaultClientOptions {
  baseUrl:         string;
  getToken:        () => Promise<string | null>;
  signalDeviceId:  number;
}

export class VaultHttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'VaultHttpError';
  }
}

export interface VaultUploadResult {
  objectKey: string;
  keyB64:    string;
  ivB64:     string;
  size:      number;
  mimeType:  string;
}

export class VaultClient {
  constructor(private readonly opts: VaultClientOptions) {}

  /**
   * Encrypt locally, request presigned PUT, upload. The per-file AES
   * key + IV are returned to the caller — STORE THEM LOCALLY ONLY,
   * never log, never transmit outside sealed messenger envelopes.
   */
  async uploadEncrypted(
    plaintext: Uint8Array,
    mimeType:  string,
    mfaProof:  string,
  ): Promise<VaultUploadResult> {
    const enc = await encryptAttachment(plaintext);
    const {uploadUrl, objectKey} = await this.authJson<{uploadUrl: string; objectKey: string}>(
      'POST', '/vault/upload-url', mfaProof,
      {contentLength: enc.ciphertext.byteLength, contentType: mimeType},
    );
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {'Content-Type': mimeType, 'Content-Length': String(enc.ciphertext.byteLength)},
      body:    enc.ciphertext,
    });
    if (!put.ok) {throw new VaultHttpError(put.status, 'upload failed');}
    return {
      objectKey,
      keyB64:   enc.key,
      ivB64:    enc.iv,
      size:     plaintext.byteLength,
      mimeType,
    };
  }

  async downloadAndDecrypt(params: {
    objectKey: string;
    keyB64:    string;
    ivB64:     string;
    mfaProof:  string;
  }): Promise<Uint8Array> {
    const {downloadUrl} = await this.authJson<{downloadUrl: string}>(
      'POST', `/vault/download-url/${params.objectKey}`, params.mfaProof,
    );
    const res = await fetch(downloadUrl);
    if (!res.ok) {throw new VaultHttpError(res.status, 'download failed');}
    const bytes = new Uint8Array(await res.arrayBuffer());
    return decryptAttachment({keyB64: params.keyB64, ivB64: params.ivB64, ciphertext: bytes});
  }

  private async authJson<T>(method: string, path: string, mfaProof: string, body?: unknown): Promise<T> {
    const token = await this.opts.getToken();
    if (!token) {throw new VaultHttpError(401, 'no_token');}
    const headers: Record<string, string> = {
      Authorization:        `Bearer ${token}`,
      'X-Signal-Device-Id': String(this.opts.signalDeviceId),
      'X-Mfa-Proof':        mfaProof,
    };
    if (body !== undefined) {headers['Content-Type'] = 'application/json';}
    const res = await fetch(`${this.opts.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg = typeof parsed === 'object' && parsed && 'message' in parsed
        ? String((parsed as {message: unknown}).message)
        : text || res.statusText;
      throw new VaultHttpError(res.status, msg);
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
