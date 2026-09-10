import type {SessionAddress} from './protocol';
import {fetchWithTimeout} from './fetchWithTimeout';

/**
 * HTTP companion to the WS TransportClient. Used for:
 *   - Backup send path when the WS is down
 *   - Batch pull after reconnect
 *   - Ack on delivery
 *
 * Headers:
 *   Authorization: Bearer <JWT>
 *   X-Signal-Device-Id: <caller's Signal device id>
 *
 * Endpoints (apps/messenger-service/src/relay/envelope.controller.ts):
 *   POST /envelopes           — submit one envelope
 *   GET  /envelopes           — pull pending for this device (supports ?after=&limit=)
 *   POST /envelopes/:id/ack   — hard-delete on successful decrypt
 */

export interface RelayEnvelope {
  envelopeId:   string;
  recipient:    SessionAddress;
  /**
   * Sealed Sender v2 outer ECIES wrap (base64). Recipient unwraps via
   * `unwrapOuter` to recover the libsignal SessionCipher input + the
   * sender's address. The relay treats this string as opaque bytes —
   * no field on the wire links the envelope back to the sender.
   */
  outerSealed:  string;
  timestamp:    number;
  dwellExpires: number;
  /**
   * Audit P0-N9 — possession-proof token. Random per-envelope value
   * issued by the relay on first delivery; the recipient must present
   * it back on ack. Optional during the rollout window so legacy
   * clients can still ack pending envelopes; missing tokens fall back
   * to the recipient-identity check (legacy semantics) server-side.
   */
  ackToken?:    string;
}

/** OM-03 — delivery outcome of an anonymous receipt slot (`rcpt:{envelopeId}`). */
export type RelayReceiptOutcome = 'pending' | 'delivered' | 'discarded' | 'unknown';

export interface RelayHttpClientOptions {
  /** Base URL including scheme/host/port, no trailing slash. e.g. `http://10.0.2.2:3100` */
  baseUrl: string;
  /** Called before each request. Return null to abort with a friendly error. */
  getToken: () => Promise<string | null>;
  /** The caller's Signal deviceId. Required by the relay on every call. */
  signalDeviceId: number;
  /**
   * Fix #19: optional refresh callback. When the relay returns 401
   * the client invokes this once, then retries with the freshly-
   * refreshed token from `getToken`. Without this, an expired access-
   * token after wake-from-sleep made every send fail; the user had to
   * relaunch the app to recover.
   */
  refreshToken?: () => Promise<void>;
  /**
   * GF-1 — optional gate awaited around each `POST /envelopes`. Lets the host
   * runtime pace submits under the relay's per-user throttle without every
   * call site knowing about it. Absent → unchanged behaviour (ops-console).
   */
  sendGate?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
    // Why: XO-3 — the relay's own throttler answers 429 with Retry-After;
    // the durable outbox reschedules on it instead of guessing.
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}

export class RelayHttpClient {
  constructor(private readonly opts: RelayHttpClientOptions) {}

  async send(input: {
    recipient:    SessionAddress;
    outerSealed:  string;
    clientMsgId?: string;
    /**
     * Disappearing-message deadline (epoch seconds). When set, the relay
     * shortens the envelope's Redis TTL to match so the ciphertext self-
     * evicts at this time even if the recipient never comes online.
     * The deadline is also carried encrypted inside the sealed-sender
     * body for the recipient's own expiry sweep.
     */
    expiresAtSec?: number;
    /**
     * Killed-app wake suppression (server DTO `urgent`). Absent/true wakes
     * the recipient for displayable envelopes; `false` for non-displayable
     * ones (reactions, group-control/rekey) suppresses the phantom wake.
     */
    urgent?: boolean;
    /**
     * OM-03 — ask the relay to park an anonymous delivery-receipt slot so
     * this submit can still reach `delivered` / `undeliverable`. HTTP
     * submitters have no live socket, and the relay must not record who
     * sent; the receipt is gated on the returned `retractToken`.
     */
    receipt?: boolean;
  }): Promise<{envelopeId: string; deliveredNow: boolean; clientMsgId?: string; retractToken?: string}> {
    const submit = (): Promise<{envelopeId: string; deliveredNow: boolean; clientMsgId?: string; retractToken?: string}> =>
      this.request('POST', '/envelopes', input);
    return this.opts.sendGate ? this.opts.sendGate(submit) : submit();
  }

  /**
   * OM-03 — batched receipt poll. `outcome` is `'pending'` while the
   * recipient has not acked, `'delivered'` / `'discarded'` once they
   * have, and `'unknown'` when the slot is gone (dwell expiry, retract,
   * or a submit that predates this feature). Throws RelayHttpError 404
   * on a backend that has not shipped the route — callers treat that as
   * "not deployed" and stop polling for the session.
   */
  async receipts(
    items: Array<{envelopeId: string; retractToken: string}>,
  ): Promise<{receipts: Array<{envelopeId: string; outcome: RelayReceiptOutcome}>}> {
    return this.request('POST', '/envelopes/receipts', {items});
  }

  async pull(opts?: {after?: number; limit?: number; bootstrap?: boolean}): Promise<{envelopes: RelayEnvelope[]}> {
    const params = new URLSearchParams();
    if (opts?.after !== null && opts?.after !== undefined) {params.set('after', String(opts.after));}
    if (opts?.limit !== null && opts?.limit !== undefined) {params.set('limit', String(opts.limit));}
    // Restore-after-reinstall fix #4 — flag the FIRST pull on a fresh
    // install so the server lets us drain the entire backlog (up to
    // relay.maxBootstrapLimit, default 1000) instead of paginating
    // through the normal 100-cap window. Without this a user with a
    // multi-week backlog of dwelling envelopes would see only the
    // most-recent slice on a reinstall.
    if (opts?.bootstrap) {params.set('bootstrap', '1');}
    const q = params.toString();
    return this.request('GET', `/envelopes${q ? `?${q}` : ''}`);
  }

  /**
   * Audit P0-N9 — `ackToken` is the possession-proof issued in the
   * deliver frame / pull response. Optional during the rollout window
   * so legacy callers don't have to thread it through immediately;
   * once 100% of clients are sending it, server-side enforcement flips
   * from "warn on missing" to "reject on missing".
   */
  async ack(
    envelopeId: string,
    ackToken?: string,
    /**
     * Handoff §3.6(c) — 'discarded' when the device destroyed the
     * message (terminal decrypt failure): the relay still hard-deletes
     * but emits `envelope.undeliverable` to the sender instead of the
     * ✓✓ `envelope.delivered`. Absent/'delivered' keeps legacy behavior.
     */
    disposition?: 'delivered' | 'discarded',
  ): Promise<void> {
    const body = (ackToken || disposition)
      ? {...(ackToken ? {ackToken} : {}), ...(disposition ? {disposition} : {})}
      : undefined;
    await this.request(
      'POST',
      `/envelopes/${encodeURIComponent(envelopeId)}/ack`,
      body,
    );
  }

  /**
   * SRV-05 — batch ack. One request, up to 100 envelopes, each carrying
   * its own P0-N9 possession-proof token (the relay verifies them
   * individually — batching changes the transport, not the proof).
   *
   * Back-compat: an older relay has no `/envelopes/ack-batch` route and
   * answers 404. Callers must treat `RelayHttpError.status === 404` as
   * "server not upgraded yet" and fall back to per-envelope `ack()`.
   */
  async ackBatch(
    items: Array<{envelopeId: string; ackToken: string; disposition?: 'delivered' | 'discarded'}>,
  ): Promise<{results: Array<{envelopeId: string; status: string}>}> {
    return this.request('POST', '/envelopes/ack-batch', {acks: items});
  }

  /**
   * Sender-initiated retract — the server hard-deletes the envelope
   * if it's still in the relay queue. Idempotent: if the recipient
   * has already pulled + ACKed, returns `{retracted: false}` without
   * error. Capability auth: the token alone is the proof, no JWT
   * identity check (preserves Sealed Sender — see envelope.service.ts).
   */
  async retract(retractToken: string): Promise<{retracted: boolean}> {
    return this.request('POST', '/envelopes/retract', {retractToken});
  }

  /**
   * Audit P0-1 follow-up — purge queued envelopes addressed to a
   * SUPERSEDED recipient identity. Called by the client immediately
   * after `installIdentity` publishes a new identity to the keys
   * service. The relay enumerates its queue for the JWT-authenticated
   * user and drops every envelope whose outer ECIES wrap was built
   * against the supplied `supersededIdentityB64` — those envelopes
   * are unrecoverable on the client (the matching private key was
   * discarded with the old install) so leaving them on the relay
   * just blocks the drain for up to 30 days.
   *
   * Idempotency: safe to call any number of times. Returns
   * `{purged}` count when the backend honours it. If the endpoint
   * doesn't exist (older backend), throws RelayHttpError with status
   * 404 — caller treats that as "feature not yet deployed" and
   * silently no-ops. NEVER include the NEW identity in the request
   * (that would let an attacker who learned the new identity also
   * trigger purges).
   */
  /**
   * Audit P1-T2 — `mfaProofToken` is the fresh MFA action token
   * (purpose=`recipient_purge`, minted by auth-service after an
   * identity-rotation ceremony). Required by the server-side
   * `RecipientPurgeGuard`; without it the request 401s with
   * `missing_mfa_proof`. Caller (mobile installIdentity flow) obtains
   * the token from auth-service immediately after publishing the new
   * bundle, then hands it to us.
   *
   * Backward-compat: when the auth-service has not yet shipped the
   * `recipient_purge` purpose, the caller can pass `undefined` and the
   * server will reject — exactly the desired posture (fail-closed on
   * an under-provisioned auth-service rather than silently succeeding).
   */
  async purgeStaleRecipientQueue(
    supersededIdentityB64: string,
    mfaProofToken?: string,
  ): Promise<{purged: number}> {
    return this.request<{purged: number}>(
      'POST',
      '/envelopes/purge-stale-recipient',
      {supersededIdentity: supersededIdentityB64},
      mfaProofToken ? {'X-Mfa-Proof': mfaProofToken} : undefined,
    );
  }

  private async request<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
    // Fix #19: retry once on 401 after a token refresh. The first
    // attempt is identical to the original code; on 401 we drive the
    // (deduped) refresh callback and retry with fresh credentials.
    // Any other status — or a second 401 after refresh — bubbles up.
    const send = async (): Promise<Response> => {
      const token = await this.opts.getToken();
      if (!token) {throw new RelayHttpError(401, 'no_token');}
      const headers: Record<string, string> = {
        Authorization:        `Bearer ${token}`,
        'X-Signal-Device-Id': String(this.opts.signalDeviceId),
        ...(extraHeaders ?? {}),
      };
      if (body !== undefined) {headers['Content-Type'] = 'application/json';}
      return fetchWithTimeout(`${this.opts.baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };

    let res = await send();
    if (res.status === 401 && this.opts.refreshToken) {
      try {
        await this.opts.refreshToken();
        res = await send();
      } catch { /* refresh failed — fall through with the original 401 */ }
    }

    if (res.status === 204) {return undefined as T;}
    const text = await res.text();
    const parsed = text ? safeJson(text) : null;
    if (!res.ok) {
      const msg  = typeof parsed === 'object' && parsed && 'message' in parsed ? String((parsed as {message: unknown}).message) : text || res.statusText;
      const code = typeof parsed === 'object' && parsed && 'code' in parsed    ? String((parsed as {code:    unknown}).code)    : undefined;
      throw new RelayHttpError(res.status, msg, code, parseRetryAfterMs(res));
    }
    return (parsed ?? {}) as T;
  }
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

/**
 * XO-3 — RFC 7231 `Retry-After`: either delta-seconds or an HTTP-date.
 * Returns undefined when absent/unparseable/non-positive so callers fall back
 * to their own backoff. `headers` is typed structurally (and read through
 * optional chaining) because the transport test harness mocks `fetch` with
 * plain objects that carry no `headers` key at all.
 */
function parseRetryAfterMs(res: {headers?: {get?(name: string): string | null}}): number | undefined {
  const raw = res.headers?.get?.('Retry-After');
  if (!raw) {return undefined;}
  const secs = Number(raw);
  if (Number.isFinite(secs)) {return secs > 0 ? Math.round(secs * 1000) : undefined;}
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {return undefined;}
  const delta = at - Date.now();
  return delta > 0 ? delta : undefined;
}
