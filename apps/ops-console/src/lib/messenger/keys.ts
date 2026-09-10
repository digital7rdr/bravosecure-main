/**
 * REST client for the auth-service signal-keys endpoints. Used at boot
 * (admin's own bundle upload) and on every outbound session init (peer
 * bundle fetch).
 */

// Audit fix 0.4 — keys endpoints live on auth-service. They accept
// EITHER the cookie session (via `credentials: 'include'`) OR a Bearer
// token. We use the cookie path here so JS never has to hold the
// long-lived access JWT.
// Audit AUTH-07 — warn loudly on a misconfigured prod build instead of
// silently pointing crypto key exchange at localhost. NOT a throw: this is
// module-load code reachable from the root layout, so throwing would crash
// the whole console rather than just degrade the messenger.
const BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? (() => {
  if (process.env.NODE_ENV === 'production' && typeof console !== 'undefined') {
    console.error('[keys] NEXT_PUBLIC_API_BASE_URL not set in a production build — falling back to localhost:3001.');
  }
  return 'http://localhost:3001';
})();

function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)bravo_ops_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const csrf = readCsrfToken();
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? {'X-CSRF-Token': csrf} : {}),
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`keys ${path} ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

export interface UploadKeysBody {
  registrationId: number;
  identityKey: string;
  signedPrekeyId: number;
  signedPrekey: string;
  signedPrekeySig: string;
  oneTimePrekeys: Array<{keyId: number; publicKey: string}>;
}

export interface PeerBundleResponse {
  registrationId: number;
  identityKey: string;
  signedPrekeyId: number;
  signedPrekey: string;
  signedPrekeySig: string;
  oneTimePrekey: {keyId: number; publicKey: string} | null;
}

export const keysApi = {
  upload: (body: UploadKeysBody) =>
    fetchJson<{ok: true; oneTimeKeysStored: number; poolSize: number}>(
      '/auth/keys/upload',
      {method: 'POST', body: JSON.stringify(body)},
    ),

  /** Returns the peer's bundle. Backend pops one OTK atomically. */
  fetchBundle: (userId: string) =>
    fetchJson<PeerBundleResponse>(`/auth/keys/${userId}`),
};
