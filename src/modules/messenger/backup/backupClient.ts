/**
 * Thin REST wrapper around messenger-service /backup/* endpoints.
 *
 * Every call uses the same auth headers as the rest of the messenger
 * client: Bearer access-token + X-Signal-Device-Id (Phase-1 hardcoded
 * to "1"). Errors get classified into a small union so callers can
 * branch on "no backup yet" vs "wrong password" vs "locked".
 */
import {MSG_BASE_URL} from '@utils/constants';
import {tokenVault} from '@services/tokenVault';

export type BackupErrorKind =
  | 'no_backup'         // 404 — no row for this user yet
  | 'locked'            // 423 — too many failed attempts; cool-down active
  | 'unauthorized'      // 401 — token invalid OR wrong backup password (wrong_proof)
  | 'verify_required'   // 403 — verify token missing/expired/replayed; re-run the verify flow (NOT a wrong password)
  | 'service_disabled'  // 503 — server has no SUPABASE creds wired
  | 'network'           // fetch threw or non-OK without a known mapping
  | 'server'            // 5xx other
  | 'quota_exceeded'    // 507 — backup storage quota reached; PERMANENT for these bytes, do not retry
  | 'invalid_request'   // other 4xx — validation reject; PERMANENT for these bytes, do not retry
  | 'verifier_missing'  // 409 — legacy row w/o verifier key; client must re-setup
  | 'stale_seq'         // 409 {error:'stale_seq'} — merkle commit seq below the server's; meta.currentSeq carries the stored seq
  | 'nonce_expired';    // 410 — verify nonce missing/replayed; refetch header

export class BackupError extends Error {
  constructor(public readonly kind: BackupErrorKind, message: string, public readonly meta?: Record<string, unknown>) {
    super(message);
    this.name = 'BackupError';
  }
}

async function authHeaders(): Promise<Record<string, string>> {
  const access = await tokenVault.getAccess();
  const headers: Record<string, string> = {
    'Content-Type':       'application/json',
    'X-Signal-Device-Id': '1',
  };
  if (access) {headers.Authorization = `Bearer ${access}`;}
  return headers;
}

async function callJson<T>(path: string, init: RequestInit): Promise<T> {
  // Round 5 / CRITICAL-7 fix: drive the same single-flight refresh
  // chain the rest of the messenger uses on a 401. Without this the
  // mirror's flush silently drops the entire batch the moment the
  // user's access token expires (default TTL is 15 minutes — every
  // long-running session hits this). The relay client and WS
  // transport both refresh-and-retry on 401; the backup client was
  // the only HTTP layer left out.
  // Lazy-required so this module doesn't pull api.ts into the
  // bootstrap graph (avoids a circular import).
  const {refreshAccessTokenShared} =

    require('@services/api') as typeof import('@services/api');

  // H-14 — bound every request with an AbortController timeout. RN
  // `fetch` can hang for minutes on a black-holed connection; without a
  // timeout a stalled restore/setup wedges the UI with no recourse but
  // force-killing the app. On abort we surface a `network` error so the
  // existing screen error paths (and the retry banners) fire.
  const doFetch = async (): Promise<Response> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch(`${MSG_BASE_URL}${path}`, {
        ...init,
        headers: {...(await authHeaders()), ...(init.headers ?? {})},
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let res: Response;
  try {
    res = await doFetch();
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message;
    throw new BackupError('network', `fetch_failed:${msg}`);
  }

  // 401: could be an expired bearer token OR a wrong backup password
  // (verify endpoint returns 401 {error:'wrong_proof'}). Only the
  // former should refresh+retry — retrying a wrong proof would consume
  // a second nonce and DOUBLE-count the failed attempt against the
  // lockout. So inspect the body first.
  if (res.status === 401) {
    let raw401 = '';
    try { raw401 = await res.clone().text(); } catch { /* ignore */ }
    let parsed401: {error?: string} = {};
    try { parsed401 = JSON.parse(raw401) as {error?: string}; } catch { /* ignore */ }
    if (parsed401.error === 'wrong_proof') {
      throw new BackupError('unauthorized', 'wrong_password');
    }
    try {
      await refreshAccessTokenShared();
      res = await doFetch();
    } catch {
      // refresh itself failed — fall through to the original 401 path.
    }
    if (res.status === 401) {
      throw new BackupError('unauthorized', 'unauthorized');
    }
  }

  if (res.status === 404) {
    throw new BackupError('no_backup', `not_found:${path}`);
  }
  if (res.status === 423) {
    let body: {lockedUntil?: string} = {};
    try { body = await res.json() as {lockedUntil?: string}; } catch { /* ignore */ }
    throw new BackupError('locked', 'backup_locked', {lockedUntil: body.lockedUntil});
  }
  // P0-1 verify-protocol statuses.
  if (res.status === 403) {
    // BUG-K (audit 2026-07-23) — distinct kind. This used to ship as
    // kind 'unauthorized', the same as wrong_proof, so a user whose
    // password was CORRECT (proof verified; the single-use token then
    // expired or was consumed by an aborted request) was told "Wrong
    // password" — and the screen's advertised recovery for a forgotten
    // password is the irreversible wipe.
    throw new BackupError('verify_required', 'verify_required');
  }
  if (res.status === 409) {
    // B-50 — putMerkleCommit's monotonic guard 409s with
    // {error:'stale_seq', currentSeq}. A fresh install's local seq cache
    // is empty, so its first (re-)commit ships seq=1 and always trips
    // this guard; the caller needs currentSeq to adopt-and-retry.
    // Every other 409 on /backup/* remains the legacy verifier_missing.
    let body409: {error?: string; currentSeq?: number} = {};
    try { body409 = await withBodyTimeout(res.clone().json() as Promise<{error?: string; currentSeq?: number}>, 10_000); } catch { /* ignore */ }
    if (body409.error === 'stale_seq') {
      throw new BackupError('stale_seq', 'stale_seq', {currentSeq: body409.currentSeq});
    }
    throw new BackupError('verifier_missing', 'verifier_missing');
  }
  if (res.status === 410) {
    throw new BackupError('nonce_expired', 'nonce_expired');
  }
  if (res.status === 503) {
    throw new BackupError('service_disabled', 'service_disabled');
  }
  // BUG-L (audit 2026-07-23) — 507 (storage quota) used to classify as
  // 'server' and other 4xx as 'network', both of which the mirror treats
  // as retryable: the same batch was re-encrypted and re-POSTed every
  // 5-8s forever, with the user never told the backup had stopped.
  if (res.status === 507) {
    throw new BackupError('quota_exceeded', 'backup_quota_exceeded');
  }
  if (!res.ok) {
    let body = '';
    try { body = await withBodyTimeout(res.text(), 10_000); } catch { /* ignore */ }
    if (res.status >= 500) {
      throw new BackupError('server', `http_${res.status}:${body.slice(0, 200)}`);
    }
    if (res.status >= 400) {
      throw new BackupError('invalid_request', `http_${res.status}:${body.slice(0, 200)}`);
    }
    throw new BackupError('network', `http_${res.status}:${body.slice(0, 200)}`);
  }
  if (res.status === 204) {return undefined as T;}
  // B-690 — the H-14 abort timer above is cleared the moment HEADERS land
  // (doFetch's finally), so the BODY read ran unbounded. On-device
  // 2026-08-28: a mid-body `connection reset by peer` (Caddy-logged) left
  // RN's res.json() pending FOREVER with no error — netRetry never saw a
  // throw, and the hung promise wedged the single-flight Merkle commit
  // chain silently for the rest of the session (no commit, no warn, boot
  // heal left to cover it). Bound the body read too; a timeout throws the
  // 'network' kind, which is exactly what netRetry retries. The race
  // ABANDONS a hung json() rather than cancelling it — the request is
  // already dead, and abandonment is the documented house trade
  // (BACKUP_BOUNDARY_BATCHING_PLAN §5.1).
  return await withBodyTimeout(res.json() as Promise<T>);
}

/** B-690 — see above. Exported seam for the timeout so tests can shrink it. */
export async function withBodyTimeout<T>(body: Promise<T>, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      body,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BackupError('network', 'fetch_failed:body_timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** H-14 — per-request timeout for all backup HTTP calls. */
const REQUEST_TIMEOUT_MS = 30_000;

// ─── Identity ──────────────────────────────────────────────────────────

export interface IdentityHeader {
  userId:            string;
  verifierMissing:   boolean;
  verifyNonce:       string;
  verifyNonceTtlSec: number;
  salt:              string;
  kdfParams:         Record<string, unknown>;
  failedAttempts:    number;
  lockedUntil:       string | null;
}

export interface IdentityBundle {
  wrappedMasterKey:       string;
  salt:                   string;
  kdfParams:              Record<string, unknown>;
  wrappedIdentityBundle:  string;
}

export const backupClient = {
  putIdentity: (payload: {
    wrappedMasterKey: string;
    salt: string;
    kdfParams: Record<string, unknown>;
    wrappedIdentityBundle: string;
    verifierKey: string;
  }): Promise<{ok: true}> =>
    callJson('/backup/identity', {method: 'POST', body: JSON.stringify(payload)}),

  getIdentityHeader: (): Promise<IdentityHeader> =>
    callJson('/backup/identity/header', {method: 'GET'}),

  // P0-1 — prove password knowledge; returns a single-use token that
  // unlocks getIdentityBundle. Wrong proof surfaces as
  // BackupError('unauthorized','wrong_password').
  verify: (payload: {nonce: string; proofB64: string}): Promise<{verifyToken: string; verifyTokenTtlSec: number}> =>
    callJson('/backup/identity/verify', {method: 'POST', body: JSON.stringify(payload)}),

  getIdentityBundle: (verifyToken: string): Promise<IdentityBundle> =>
    callJson(`/backup/identity/bundle?verifyToken=${encodeURIComponent(verifyToken)}`, {method: 'GET'}),

  forget: (): Promise<{ok: true}> =>
    callJson('/backup', {method: 'DELETE'}),

  /**
   * Round 5 / Security S8 — upload a signed Merkle commit. Server
   * stores opaquely; the signature is verified at restore time
   * against the identity public key.
   */
  putMerkleCommit: (payload: {
    rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string;
  }): Promise<{ok: true}> =>
    callJson('/backup/identity/merkle', {method: 'POST', body: JSON.stringify(payload)}),

  /**
   * Round 5 / Security S8 — pull the most recent signed Merkle commit.
   * Returns `null` when no commit has been uploaded yet (legacy
   * accounts that pre-date S8) — caller decides whether to refuse the
   * restore or accept under the rollout-window policy.
   */
  getMerkleCommit: async (): Promise<{
    rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string;
  } | null> => {
    try {
      const r = await callJson<{rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string}>(
        '/backup/identity/merkle', {method: 'GET'},
      );
      return r ?? null;
    } catch (e) {
      if (e instanceof BackupError && e.kind === 'service_disabled') {return null;}
      throw e;
    }
  },

  // ─── Session-ratchet snapshot (Sprint-6 backend hand-off) ──────────
  //
  // Encrypted snapshot of per-peer Double-Ratchet state. The blob is
  // AES-256-GCM under the local backup master key (server never sees
  // plaintext). Server enforces monotonic `seq` so a compromised server
  // can't roll the client back to a prior ratchet state.

  putSessions: (payload: {blob: string; seq: number}): Promise<{ok: true; seq: number}> =>
    callJson('/backup/identity/sessions', {method: 'POST', body: JSON.stringify(payload)}),

  /**
   * Returns `null` when no snapshot has been uploaded yet (normal pre-
   * restore state on a brand-new account). Pre-migration backends
   * surface as `service_disabled` (503) — caller treats that as
   * `no_snapshot` so the rest of the restore proceeds.
   */
  getSessions: async (): Promise<{blob: string; seq: number} | null> => {
    try {
      const r = await callJson<{blob: string; seq: number} | null>(
        '/backup/identity/sessions', {method: 'GET'},
      );
      return r ?? null;
    } catch (e) {
      if (e instanceof BackupError && (e.kind === 'service_disabled' || e.kind === 'no_backup')) {
        return null;
      }
      throw e;
    }
  },

  // ─── Messages ────────────────────────────────────────────────────────

  putMessages: (messages: Array<{
    message_id:      string;
    conversation_id: string;
    sender_id:       string;
    recipient_id?:   string | null;
    msg_type?:       string;
    ciphertext:      string;            // base64 of master-key-wrapped JSON
    ciphertext_type?: number;
    envelope_meta?:   Record<string, unknown>;
    msg_created_at:   string;
  }>): Promise<{written: number}> =>
    callJson('/backup/messages', {method: 'POST', body: JSON.stringify({messages})}),

  getMessages: (since?: string, limit?: number, sinceId?: string): Promise<{messages: Array<{
    message_id:      string;
    conversation_id: string;
    sender_id:       string;
    recipient_id:    string | null;
    msg_type:        string;
    ciphertext:      string;
    ciphertext_type: number;
    envelope_meta:   Record<string, unknown>;
    msg_created_at:  string;
  }>}> => {
    const qs = new URLSearchParams();
    if (since) {qs.set('since', since);}
    // Round 8 — tuple cursor. Pair (since, sinceId) so duplicate
    // timestamps at page boundaries don't drop rows.
    if (sinceId) {qs.set('sinceId', sinceId);}
    if (limit) {qs.set('limit', String(limit));}
    const path = qs.toString() ? `/backup/messages?${qs.toString()}` : '/backup/messages';
    return callJson(path, {method: 'GET'});
  },

  // ─── Conversations ───────────────────────────────────────────────────

  putConversations: (conversations: Array<{
    conversation_id: string;
    kind:            'direct' | 'group' | 'system';
    name?:           string | null;
    members?:        Array<{userId: string; displayName?: string}>;
    last_message_at?: string | null;
    // Round 8 — extended schema.
    is_muted?:        boolean;
    is_pinned?:       boolean;
    default_ttl_sec?: number | null;
    unread_count?:    number;
    is_custom_name?:  boolean;
    group_state?:     Record<string, unknown> | null;
    // B-594 fresh-install restore — the delete path mirrors deleted:true; a
    // live mirror sends deleted:false so re-adding a room clears the flag.
    deleted?:         boolean;
  }>): Promise<{written: number}> =>
    callJson('/backup/conversations', {method: 'POST', body: JSON.stringify({conversations})}),

  // BUG-T (audit 2026-07-23) — tuple-cursor pagination (cursor =
  // last_message_at DESC, cursorId = conversation_id tie-break). The
  // restore path pages until a short page; accounts past the server's
  // previous 5000-row cap no longer silently lose the remainder.
  getConversations: (cursor?: string, limit?: number, cursorId?: string): Promise<{conversations: Array<{
    conversation_id: string;
    kind:            'direct' | 'group' | 'system';
    name:            string | null;
    members:         Array<{userId: string; displayName?: string}>;
    last_message_at: string | null;
    is_muted?:        boolean;
    is_pinned?:       boolean;
    default_ttl_sec?: number | null;
    unread_count?:    number;
    is_custom_name?:  boolean;
    group_state?:     Record<string, unknown> | null;
    deleted?:         boolean;
  }>}> => {
    const qs = new URLSearchParams();
    if (cursor) {qs.set('cursor', cursor);}
    if (cursorId) {qs.set('cursorId', cursorId);}
    if (typeof limit === 'number') {qs.set('limit', String(limit));}
    const path = qs.toString() ? `/backup/conversations?${qs.toString()}` : '/backup/conversations';
    return callJson(path, {method: 'GET'});
  },

  // ─── Sealed-envelope archive (Restore-after-reinstall fix #3) ───────
  //
  // Returns the list of opaque outer-sealed envelopes the server has on
  // file for this user, since the optional `since` cursor (epoch ms).
  // Caller unseals each with their identity priv key locally — the
  // server cannot read them. Rolling 90-day retention server-side.
  getSealedArchive: (sinceMs?: number, limit?: number, sinceId?: string): Promise<{envelopes: Array<{
    envelopeId:  string;
    outerSealed: string;   // base64
    timestampMs: number;
  }>}> => {
    const qs = new URLSearchParams();
    if (typeof sinceMs === 'number') {qs.set('since', String(sinceMs));}
    // Round 8 — tuple cursor. Same fix as getMessages.
    if (sinceId) {qs.set('sinceId', sinceId);}
    if (typeof limit === 'number')   {qs.set('limit', String(limit));}
    const path = qs.toString() ? `/backup/sealed-archive?${qs.toString()}` : '/backup/sealed-archive';
    return callJson(path, {method: 'GET'});
  },
};
