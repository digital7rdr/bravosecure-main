/**
 * Bravo Ops Console — typed API client.
 *
 * Calls the `/ops/*` REST surface on the NestJS auth-service. All calls
 * go through `fetchJson` which:
 *   • reads `NEXT_PUBLIC_API_BASE_URL` (required in prod — see audit 4.1)
 *   • carries the cookie session via `credentials: 'include'`
 *   • echoes `X-CSRF-Token` from the `bravo_ops_csrf` cookie
 *   • throws `ApiError` for non-2xx with status + parsed body
 */

import useSWR, {type SWRConfiguration} from 'swr';

// Audit fix 4.1 — fail loudly if API base URL is missing in prod. Defaulting
// to localhost in prod meant every fetch silently 404'd against the wrong
// host and the user saw a generic "session expired" loop. In dev we still
// fall back so devs can `npm run dev` without an .env. The throw runs at
// module-eval time so a missing env crashes the build, not at first user
// click — easier to catch in CI.
const ENV_BASE = process.env.NEXT_PUBLIC_API_BASE_URL;
if (!ENV_BASE && process.env.NODE_ENV === 'production') {
  throw new Error('NEXT_PUBLIC_API_BASE_URL is required in production builds');
}
const BASE = ENV_BASE ?? 'http://localhost:3001';

export class ApiError extends Error {
  constructor(public status: number, public body: unknown, message: string) {
    super(message);
  }
}

// Audit fix 0.4 — cookies replace localStorage for the ops session.
// `credentials: 'include'` makes the browser ship `bravo_ops_token` and
// `bravo_ops_csrf` on every same-site fetch. We pull `bravo_ops_csrf`
// out of `document.cookie` and echo it as `X-CSRF-Token` so the
// backend's CsrfGuard can pair them (double-submit pattern).
function readCsrfToken(): string | null {
  if (typeof document === 'undefined') return null;
  const m = /(?:^|;\s*)bravo_ops_csrf=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * B-71 — terminal boot to /login on a genuinely-dead session.
 *
 * A bare `location.assign('/login')` was NOT enough to break the loop: both
 * the login page and the Shell treat the presence of the JS-readable
 * `bravo_ops_csrf` cookie as "still logged in" and auto-forward back to `/`.
 * With the session revoked server-side, that produced an infinite
 * /login⇄/dashboard redirect storm (3,300+ requests). Clear every client-side
 * "logged-in" signal FIRST — the csrf cookie (via the same shotgun
 * clearSession uses), the access-expiry marker, and the in-memory messenger
 * ticket — so /login stays put. Mirrors clearSession() minus the server
 * DELETE (the token is already gone server-side, so there's nothing to revoke).
 */
function bootToLogin(): void {
  if (typeof window === 'undefined') return;
  expireCsrfCookie();
  window.sessionStorage.removeItem('bravo_ops_access_expires_at');
  clearMessengerTicket();
  if (!window.location.pathname.startsWith('/login')) {
    window.location.assign('/login');
  }
}

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const csrf = readCsrfToken();
  // Audit fix 4.3 — Idempotency-Key. Every state-changing opsApi call
  // passes an `idempotencyKey` field as a custom init prop; we lift it
  // into the header and strip from the spread so `fetch` doesn't reject.
  // (auditPiiReveal is deliberately unkeyed — each reveal is its own
  // audit event and must log every time.)
  const {idempotencyKey, ...restInit} = (init ?? {}) as RequestInit & {idempotencyKey?: string};
  const res = await fetch(`${BASE}${path}`, {
    ...restInit,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(csrf ? {'X-CSRF-Token': csrf} : {}),
      ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {}),
      ...(restInit?.headers ?? {}),
    },
    cache: 'no-store',
  });
  const text = await res.text();
  const body = text ? safeParse(text) : null;
  if (!res.ok) {
    // Audit PAGE-14 — only a real session loss should boot to /login.
    // 401 = missing/expired/revoked cookie. A bare 403 is authorization
    // (RBAC) or a CSRF mismatch and belongs to a validly-logged-in
    // operator — booting them to /login (and discarding SWR cache) is
    // wrong; the page surfaces those inline. We still honour a 403 that
    // explicitly tags itself as a session issue.
    const bodyCode = (body as {code?: string})?.code;
    const sessionLost =
      res.status === 401 ||
      (res.status === 403 && (bodyCode === 'session_expired' || bodyCode === 'token_revoked'));
    if (sessionLost) {
      // B-71 — clear stale csrf + expiry markers before redirecting so the
      // login page doesn't auto-forward straight back into the dead session
      // (the infinite /login⇄/dashboard loop).
      bootToLogin();
    }
    throw new ApiError(res.status, body, (body as {message?: string})?.message ?? res.statusText);
  }
  return body as T;
}

// ─── Auth (ops-console login) ───────────────────────────────────────

export interface TotpEnrolment {
  uri:         string;
  secret:      string;
  backupCodes: string[];
}
export interface LoginStartResult {
  userId:       string | null;
  otpSentTo:    string | null;
  challengeId:  string | null;
  secondFactor: 'sms' | 'totp' | 'totp_enrol' | null;
  enrol:        TotpEnrolment | null;
}

export const authApi = {
  /**
   * Step 1 — phone + password. What comes back depends on the server's
   * AUTH_SECOND_FACTOR:
   *   sms         → an OTP was sent to `otpSentTo`
   *   totp        → `challengeId`; user enters their authenticator code
   *   totp_enrol  → `challengeId` + `enrol` (otpauth URI, manual key, backup
   *                 codes) — the account has no verified authenticator yet,
   *                 so this login doubles as enrolment
   * A wrong password returns every field null (no account enumeration).
   */
  loginStart: (phoneE164: string, password: string) =>
    fetchJson<LoginStartResult>(
      `/auth/login`,
      {method: 'POST', body: JSON.stringify({phoneE164, password})},
    ),

  /** Step 2 — code → tokens. `challengeId` is required in TOTP mode. */
  loginVerify: (userId: string, code: string, deviceId: string, challengeId?: string | null) =>
    fetchJson<{user: {id: string; role: string}; accessToken: string; refreshToken: string; expiresIn: number}>(
      `/auth/verify`,
      {method: 'POST', body: JSON.stringify({userId, code, deviceId, platform: 'web', ...(challengeId ? {challengeId} : {})})},
    ),

  // Audit fix 0.1 — registerStart + registerVerifyAdmin removed alongside
  // the deleted /register page. The matching backend route now returns
  // 403 unconditionally; an invite-only flow replaces it in a follow-up.

  /**
   * Audit fix 0.4 — fetch a short-lived (5-min) messenger ticket from the
   * cookie-authenticated /auth/messenger-ticket endpoint. The JS holds
   * this in memory only and passes it to socket.io / messenger-service
   * REST. NEVER stored in localStorage.
   */
  messengerTicket: () =>
    fetchJson<{ticket: string; expiresIn: number}>(
      `/auth/messenger-ticket`,
      {method: 'POST'},
    ),

  /**
   * Audit fix 4.1 — cookie-bound silent refresh. The refresh token
   * itself lives in the httpOnly `bravo_ops_refresh` cookie (set on
   * /auth/verify) and is invisible to JS. The browser ships it on this
   * endpoint only (path-scoped). Returns the new access-cookie's
   * `expiresIn` so the client can schedule the next refresh.
   */
  sessionRefresh: () =>
    fetchJson<{expiresIn: number}>(
      `/auth/session/refresh`,
      {method: 'POST'},
    ),

  /**
   * RS-09 — redeem a single-use admin invite (public, pre-auth). Role,
   * call sign, and email are baked into the invite server-side; the
   * invitee supplies only their own phone + password, then logs in via
   * the normal phone + password + OTP flow.
   */
  acceptAdminInvite: (dto: {token: string; phone_e164: string; password: string; display_name?: string}) =>
    fetchJson<{ok: true; call_sign: string; role: string}>(
      `/auth/admin/accept-invite`,
      {method: 'POST', body: JSON.stringify(dto)},
    ),
};

/**
 * Audit fix 0.4 — in-memory messenger ticket holder. Refreshed before
 * expiry by the messenger runtime. NEVER persisted to disk.
 */
let messengerTicketCache: {token: string; expiresAt: number} | null = null;

/**
 * Mint a messenger ticket WITHOUT the fetchJson login-redirect, so a 401
 * (stale access cookie / rotated jti) can be recovered by a silent session
 * refresh instead of bouncing the operator to /login mid-mission.
 */
async function mintTicketRaw(): Promise<{ticket: string; expiresIn: number} | 401> {
  const res = await fetch(`${BASE}/auth/messenger-ticket`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(readCsrfToken() ? {'X-CSRF-Token': readCsrfToken() as string} : {}),
    },
    cache: 'no-store',
  });
  if (res.status === 401) return 401;
  if (!res.ok) throw new ApiError(res.status, null, `messenger-ticket ${res.status}`);
  return (await res.json()) as {ticket: string; expiresIn: number};
}

export async function getMessengerTicket(forceRefresh = false): Promise<string> {
  const now = Date.now();
  // Refresh 30s before expiry so a slow request doesn't outlive the ticket.
  if (
    !forceRefresh &&
    messengerTicketCache &&
    messengerTicketCache.expiresAt - 30_000 > now
  ) {
    return messengerTicketCache.token;
  }
  // First attempt. On 401 the access cookie's jti has rotated (or expired)
  // out of the server allowlist — surfacing as `token_revoked` on the relay /
  // sender-cert. Silently rotate the session via the httpOnly refresh cookie,
  // then retry the mint ONCE. Only if that also 401s is the session truly gone
  // (→ let fetchJson's redirect take over so the operator re-logs in).
  let res = await mintTicketRaw();
  if (res === 401) {
    try { await authApi.sessionRefresh(); } catch { /* fall through to redirect */ }
    res = await mintTicketRaw();
  }
  if (res === 401) {
    // Definitive: cookie session is dead. Clear markers + route to /login
    // (mirrors fetchJson; B-71 — must clear csrf so /login doesn't bounce back).
    bootToLogin();
    throw new ApiError(401, {message: 'session_expired'}, 'session_expired');
  }
  messengerTicketCache = {
    token:     res.ticket,
    expiresAt: now + res.expiresIn * 1000,
  };
  return res.ticket;
}

export function clearMessengerTicket(): void {
  messengerTicketCache = null;
}

// Audit fix 0.4 — the old saveSession() is gone. The auth-service sets the
// httpOnly `bravo_ops_token` and JS-readable `bravo_ops_csrf` cookies on
// /auth/verify and /auth/refresh; nothing token-shaped is persisted by JS.

/**
 * Audit fix 0.4 — logout posts to DELETE /auth/session which clears the
 * cookies server-side. We can't clear httpOnly cookies from JS, so the
 * server is authoritative.
 */
export async function clearSession(): Promise<void> {
  try {
    await fetchJson('/auth/session', {method: 'DELETE', body: JSON.stringify({allDevices: false})});
  } catch {
    // Best-effort: even if the delete fails (already revoked, etc.),
    // we still want the redirect-to-login to fire. The middleware will
    // bounce the next request to /login because the cookie is absent.
  }
  // Sign-out must not depend on the server's Set-Cookie deletions
  // arriving. If the DELETE 401s (expired access token), fails CORS, or
  // the deletion attributes don't match, the JS-readable `bravo_ops_csrf`
  // cookie survives — and BOTH the login page and Shell treat its
  // presence as "still logged in", bouncing the user straight back into
  // the app (the "can't sign out" loop). Expire it directly from JS so
  // logout is authoritative regardless of the DELETE's outcome. (The
  // httpOnly token/refresh cookies can't be cleared here — the server
  // owns those — but the csrf cookie is the gate every client check reads.)
  expireCsrfCookie();
  // Audit fix #13 — drop the in-memory messenger ticket too. Without
  // this, a re-login as a different admin in the same tab would reuse
  // the previous admin's ticket until it naturally expired (~5 min).
  clearMessengerTicket();
  // B-71 — bravo_ops_device_id is deliberately NOT cleared here. It's a stable
  // per-browser device identity (like the mobile app's Keychain device id);
  // clearing it minted a brand-new web device on every re-login, churning
  // auth_devices and amplifying the takeover/token_revoked loop. Re-login now
  // reuses this browser's device row (INSERT ... ON CONFLICT).
}

/**
 * Expire the JS-readable `bravo_ops_csrf` cookie from the client. The
 * cookie may carry a `Domain` attribute (COOKIE_DOMAIN, e.g. the shared
 * parent of the auth + ops subdomains on staging/prod) or be host-only in
 * dev, so we clear every candidate: host-only, the current host, and each
 * parent suffix down to the registrable domain — with and without a
 * leading dot. A deletion only takes effect when name+path+domain match
 * how the cookie was set, hence the shotgun.
 */
function expireCsrfCookie(): void {
  if (typeof document === 'undefined') return;
  const past = 'Thu, 01 Jan 1970 00:00:00 GMT';
  const host = window.location.hostname;
  const parts = host.split('.');
  const domains: Array<string | null> = [null, host];
  for (let i = 1; i < parts.length - 1; i++) {
    const suffix = parts.slice(i).join('.');
    domains.push(suffix, '.' + suffix);
  }
  for (const d of domains) {
    document.cookie =
      `bravo_ops_csrf=; expires=${past}; max-age=0; path=/` + (d ? `; domain=${d}` : '');
  }
}

/** Generate / re-use a stable device id for this browser. */
export function deviceId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = window.localStorage.getItem('bravo_ops_device_id');
  if (!id) {
    id = `web-${crypto.randomUUID()}`;
    window.localStorage.setItem('bravo_ops_device_id', id);
  }
  return id;
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Audit fix 4.3 — fresh Idempotency-Key per call. Uses crypto.randomUUID
 * when available (every modern browser); falls back to a longer
 * random.toString(36) so we still meet the server's 8–128 char
 * [A-Za-z0-9_-] regex even if randomUUID is shimmed.
 */
function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Audit L4 — keep the fallback UNGUESSABLE. Prefer crypto.getRandomValues
  // (present wherever randomUUID is merely shimmed away) so the key can't be
  // predicted by an observer; only drop to Math.random as a last resort in a
  // crypto-less runtime (not the browser ops-console ships to). The server
  // additionally scopes the cache key by admin id + route, so a guessed key
  // still can't collide with another operator's request — this is
  // defence-in-depth on top of that.
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return 'idem-' + Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  }
  return `idem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

// ─── Types ─────────────────────────────────────────────────────────

export type BookingStatus =
  | 'DRAFT' | 'PENDING_OPS' | 'OPS_APPROVED' | 'PAYMENT_PENDING'
  // Auto-dispatch pipeline state + its two stall outcomes (SK-04).
  | 'DISPATCHING' | 'NO_PROVIDER' | 'AGENCY_NO_SHOW'
  | 'CONFIRMED' | 'LIVE' | 'COMPLETED' | 'CANCELLED';

export type MissionStatus =
  | 'DISPATCHED' | 'PICKUP' | 'LIVE' | 'SOS' | 'COMPLETED' | 'ABORTED';

export type JobStatus =
  | 'PUBLISHED' | 'REVIEW' | 'ASSIGNED' | 'DISPATCHED' | 'CANCELLED';

export type AgentStatus =
  | 'DRAFT' | 'PROFILE_COMPLETE' | 'KYC_PENDING' | 'DOCS_PENDING'
  | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ACTIVE';

export interface DashboardResponse {
  kpis: {
    pending_approval: number;
    active_missions: number;
    agents_on_duty: number;
    agents_total: number;
    open_jobs: number;
    gmv_today_aed: number;
    /** BC-denominated GMV (== SUM(total_eur), 1:1 peg). */
    gmv_today_bc: number;
    sos_active: number;
    /** IS-14 — Pro applications waiting on ops (PENDING_PROPOSAL + REVISION_REQUESTED). */
    pro_pending?: number;
    /** IS-14 — Pro protection-date requests awaiting officers (REQUESTED). */
    pro_requests?: number;
  };
  activity: Array<{
    id: number; kind: string; severity: 'info' | 'ok' | 'warn' | 'err';
    actor: string | null; subject: string | null;
    message: string; created_at: string;
  }>;
}

export interface BookingRow {
  id: string;
  status: BookingStatus;
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;
  pickup_address: string;
  dropoff_address: string | null;
  cpo_count: number;
  vehicle_count: number;
  total_eur: string;
  total_aed: string;
  created_at: string;
  /** IS-11 — the actual client's display name (users join). */
  client_name?: string | null;
  /** Family-charged bookings only: the OWNER whose wallet paid (member "under" them). */
  payer_name?: string | null;
}

/** IS-07 — one per-unit line of the executive-protection price composition. */
export interface PriceBreakdownItem {
  id: string;
  label: string;
  qty: number;
  rate_eur: number;
  subtotal_eur: number;
}

export interface PriceBreakdown {
  items: PriceBreakdownItem[];
  rate_eur_per_hour: number;
  duration_hours: number;
  total_eur: number;
}

export interface MissionRow {
  id: string;
  booking_id: string;
  status: MissionStatus;
  short_code: string;
  started_at: string;
  ended_at: string | null;
  current_lat: number | null;
  current_lng: number | null;
  heading_deg: number | null;
  speed_kph: number | null;
  risk_level: string;
  comms_pct: number;
  gps_rtk_lock: boolean;
  vehicle_model: string | null;
  vehicle_plate: string | null;
  vehicle_armour: string | null;
  client_id: string | null;
  client_display_name: string | null;
  client_email: string | null;
  pickup_address: string | null;
  dropoff_address: string | null;
  region_code: string | null;
  region_label: string | null;
  route_distance_m: number | null;
  route_duration_s: number | null;
  route_polyline: string | null;
  /** Latest principal/client GPS fix (client app foreground push). Null
   *  until the client telemetry endpoint is wired and the client side
   *  starts pushing — the live page renders an "AWAITING" placeholder. */
  client_lat: number | null;
  client_lng: number | null;
  client_recorded_at: string | null;
  /** B-89 MG-15 — bumped on every CPO telemetry push; drives the lost-signal staleness badge. */
  updated_at: string | null;
  /** Conversation_id of the encrypted mission group (set at dispatch). */
  comms_channel_id: string | null;
}

export interface MissionDetail {
  mission: MissionRow;
  crew: Array<{
    mission_id: string; agent_id: string; slot: number;
    role: string; call_sign: string; armed: boolean;
    comms_ch: number; mic_hot: boolean; status: string;
    is_lead?: boolean; team_idx?: number;
  }>;
  waypoints: Array<{
    id: number; seq: number; tag: string; event: string; sub: string | null;
    state: 'pending' | 'current' | 'done' | 'sos';
    planned_at: string | null; settled_at: string | null;
  }>;
  principals: Array<{
    id: string; display_name: string; sub_label: string | null;
    phone: string | null; onboard: boolean; order_idx: number;
  }>;
  sos: Array<{
    id: string; reason: string; triggered_at: string;
    acknowledged_at: string | null; acknowledged_by: string | null;
    resolved_at: string | null; escalated_at: string | null;
    agent_call_sign: string | null;
  }>;
  audit: Array<{
    id: number; actor_role: string; actor_call: string | null;
    action: string; metadata: Record<string, unknown>; created_at: string;
  }>;
  booking: {
    id: string;
    client_id: string;
    pickup_address: string;
    pickup_lat: string | null; pickup_lng: string | null;
    dropoff_address: string | null;
    dropoff_lat: string | null; dropoff_lng: string | null;
    region_code: string; region_label: string;
    service: string; pickup_time: string;
    cpo_count: number; vehicle_count: number;
    total_eur: string; total_aed: string;
    dress_instructions: string | null;
    /** CA-07 — Executive Protection fields (mission.service getById projection). */
    task_type: string | null;
    duration_hours: number;
    exec_transport: unknown | null;
    client_display_name: string | null;
    client_email: string | null;
    client_phone: string | null;
  } | null;
  vehicle: {
    id: string; call_sign: string; make_model: string; plate: string;
    armored: boolean; armor_grade: string | null; capacity: number;
  } | null;
  /** CA-07 — Executive Protection hourly check-ins (empty for non-exec missions). */
  hourly_checkins: Array<{
    hour_index: number; status: string; comment: string | null; created_at: string;
  }>;
}

export interface JobRow {
  id: string;
  booking_id: string;
  short_code: string;
  status: JobStatus;
  region_code: string;
  route_label: string;
  dispatch_at: string;
  duration_hours: number;
  cpo_slots: number;
  slots_filled: number;
  published_at: string;
}

export interface AgentListRow {
  user_id: string;
  type: 'company' | 'cpo' | 'transport';
  status: AgentStatus;
  tier: number;
  call_sign: string | null;
  display_name: string | null;
  rate_aed_per_hour: string | null;
  rating: string | null;
  jobs_total: number;
  duty_hours_mtd: number;
  on_duty: boolean;
  submitted_at: string | null;
  approved_at: string | null;
  created_at: string;
  email: string | null;
  phone: string | null;
  coverage: {countries: Array<{code: string; on: boolean}>; services: Array<{key: string; on: boolean}>} | null;
}

export interface AgentDetail {
  agent: AgentListRow;
  profile: {
    company: Record<string, unknown>;
    contact: Record<string, unknown>;
    capabilities: string[];
    coverage: {countries: Array<{code: string; on: boolean}>; services: Array<{key: string; on: boolean}>};
    availability: {mode: string; loadout: string[]};
  };
  contact: {email: string | null; phone: string | null};
  kyc: Array<{
    kind: 'gov_id' | 'proof_address' | 'sia_licence' | 'police';
    state: 'queued' | 'running' | 'done' | 'failed';
    subject: string | null;
    file_url: string | null;
    uploaded_at: string | null;
    reviewed_at: string | null;
  }>;
  documents: Array<{
    id: string; slot: string; required: boolean; title: string;
    state: 'upload' | 'done' | 'rejected';
    file_url: string | null; uploaded_at: string | null;
    reviewed_at: string | null;
  }>;
  review: Array<{
    step: 'submit' | 'docs' | 'kyc' | 'ops' | 'partner';
    state: 'pending' | 'in_progress' | 'done' | 'rejected';
    notes: string | null; settled_at: string | null;
  }>;
  deployment: Array<{
    check_key: 'dress' | 'vehicle' | 'equip' | 'briefing';
    state: 'pending' | 'passed' | 'failed';
    notes: string | null; signed_at: string | null;
  }>;
  /** DC-08 — agent_audit lifecycle trail (status flips), newest first. */
  state_audit?: Array<{
    id: number; from_status: string | null; to_status: string;
    actor_id: string | null; actor_role: string | null;
    metadata: Record<string, unknown> | null; created_at: string;
  }>;
}

export interface AgentStats {
  activeMission: {
    id: string; short_code: string; status: string;
    current_lat: number | null; current_lng: number | null;
    started_at: string; risk_level: string;
    pickup_address: string | null; dropoff_address: string | null;
  } | null;
  recentMissions: Array<{
    id: string; short_code: string; status: string;
    started_at: string; ended_at: string | null;
    pickup_address: string | null; total_aed: string | null;
    /** BC value (== total_eur, 1:1 peg). */
    total_eur: string | null;
  }>;
  lastLocation: {lat: number; lng: number; recorded_at: string} | null;
}

export interface ApplicationRow {
  id: string;
  job_id: string;
  agent_id: string;
  agent_call_sign: string;
  status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';
  rank: number | null;
  fit_score: number | null;
  distance_km: string | null;
  rate_ccy: string;
  rate_per_hour: string | null;
  applied_at: string;
  // Dress pledge captured at apply-time. Audit field — compare against
  // the booking's dress_instructions on the job/applications view.
  dress_pledge: string | null;
  dress_pledged_at: string | null;
}

// ─── Endpoints ──────────────────────────────────────────────────────

export interface OpsMe {
  admin: {
    user_id: string; role: 'OPS' | 'SUPERVISOR' | 'ADMIN';
    call_sign: string; region: string;
  };
}

export interface PoolCpo {
  id: string;
  call_sign: string;
  display_name: string;
  role: string;
}

export interface PoolVehicle {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
}

export type ApplicationStatus = 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';

export interface BookingApplicant {
  id: string;            // application id
  agent_id: string;
  agent_call_sign: string;
  display_name: string | null;
  status: ApplicationStatus;
  rating: string | null;
  jobs_total: number;
  tier: number;
  applied_at: string;
  dress_pledge: string | null;
  dress_pledged_at: string | null;
}

export const opsApi = {
  me:              () => fetchJson<OpsMe>(`/ops/me`),

  dashboard:       (region?: string) =>
    fetchJson<DashboardResponse>(`/ops/dashboard${region ? `?region=${region}` : ''}`),

  activity:        (limit = 50) => fetchJson<DashboardResponse['activity']>(`/ops/activity?limit=${limit}`),

  // Bookings
  listBookings:    (q?: {status?: BookingStatus; region?: string; limit?: number}) => {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.region) p.set('region', q.region);
    if (q?.limit)  p.set('limit', String(q.limit));
    const qs = p.toString();
    return fetchJson<BookingRow[]>(`/ops/bookings${qs ? `?${qs}` : ''}`);
  },
  getBooking:      (id: string) =>
    fetchJson<{
      booking: BookingRow & {
        client_id: string;
        booking_mode: string;
        passengers: number;
        driver_only: boolean;
        add_ons: Array<string | {id: string; label?: string}>;
        duration_hours: number;
        rate_eur_per_hour: string;
        rate_aed_per_hour: string;
        payment_method: string;
        payment_captured: boolean;
        /** SK-12 — stamped at the CONFIRMED flip; null on pre-B-386 rows. */
        confirmed_at?: string | null;
        notes: string | null;
        pickup_lat: string | null;
        pickup_lng: string | null;
        dropoff_lat: string | null;
        dropoff_lng: string | null;
        /** Executive Protection (service 'executive_protection') — task + optional secure-transfer leg. */
        task_type?: string | null;
        exec_transport?: {
          mode?: string;
          pickup?: {address?: string; latitude?: number; longitude?: number};
          dropoff?: {address?: string; latitude?: number; longitude?: number};
          pickup_time?: string | null;
          passengers?: number;
        } | null;
        /** SK-05 — client rating, present once submitted on a COMPLETED booking. */
        rating?: number | null;
        rating_tags?: string[] | null;
        rating_remarks?: string | null;
      };
      audit: unknown[];
      job: JobRow | null;
      team: {cpos: PoolCpo[]; vehicle: PoolVehicle | null};
      client: {
        id: string;
        display_name: string;
        email: string | null;
        phone: string | null;
        subscription_tier: string;
        country_code: string | null;
        kyc_status: string;
        avatar_url: string | null;
        created_at: string;
      } | null;
      mission: {id: string; short_code: string; status: string} | null;
      /** Set when a family member booked under an owner's wallet. */
      payer: {id: string; display_name: string | null} | null;
      /** IS-07 — per-unit exec price composition; null for non-exec services. */
      price_breakdown?: PriceBreakdown | null;
    }>(`/ops/bookings/${id}`),
  approveBooking:  (id: string, dressInstructions: string, notes?: string) =>
    // Audit fix 4.3 — Idempotency-Key auto-issued per call. A double-click
    // or network retry inside 24h returns the cached first response from
    // Redis (handler is never re-invoked).
    fetchJson(`/ops/bookings/${id}/approve`, {
      method: 'POST',
      body: JSON.stringify({dress_instructions: dressInstructions, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  rejectBooking:   (id: string, reason: string, notes?: string) =>
    fetchJson(`/ops/bookings/${id}/reject`, {
      method: 'POST', body: JSON.stringify({reason, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  // vehicleId is omitted for driver-only / exec protection-only bookings —
  // the server rejects a vehicle pick there (driver_only_no_vehicle).
  dispatchBooking: (id: string, body: {applicationIds: string[]; vehicleId?: string; dressInstructions?: string | null; leadAgentId?: string | null}) =>
    fetchJson<{ok: true; status: 'LIVE'; conversation_id: string | null; mission_id: string}>(`/ops/bookings/${id}/dispatch`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  getProposedPayouts: (id: string) =>
    fetchJson<{
      booking_id: string;
      escrow_credits: number;
      cpo_count: number;
      even_split: number;
      platform_remainder: number;
      proposed: Array<{user_id: string; call_sign: string; display_name: string; proposed_credits: number}>;
    }>(`/ops/bookings/${id}/proposed-payouts`),

  completeBooking: (
    id: string,
    body?: {payouts?: Array<{user_id: string; credits: number; deduction_reason?: string | null}>},
  ) =>
    fetchJson<{
      ok: true; status: 'COMPLETED';
      payouts: Array<{user_id: string; credits: number; deduction_reason: string | null}>;
      platform_fee: number;
      group_purged: boolean;
    }>(`/ops/bookings/${id}/complete`, {
      method: 'POST',
      body: JSON.stringify(body ?? {}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  // Manual BC grant (+) / deduction (−) on a user wallet. SUPERVISOR/ADMIN
  // only (backend @RequireRoles). Keyed so a double-click or network retry
  // can't credit the wallet twice.
  adjustWallet: (userId: string, body: {credits: number; reason: string}) =>
    fetchJson<{
      balance: {bravo_credits: number; currency: string};
      transaction_id: string;
    }>(`/ops/wallets/${userId}/adjust`, {
      method: 'POST',
      body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  listBookingApplicants: (id: string) =>
    fetchJson<{
      job: {id: string; cpo_slots: number; status: string} | null;
      applicants: BookingApplicant[];
    }>(`/ops/bookings/${id}/applicants`),
  listAvailableVehicles: (region: string) =>
    fetchJson<PoolVehicle[]>(`/ops/pool/vehicles?region=${encodeURIComponent(region)}`),

  // Department Channels (admin oversight)
  listDepartments: () =>
    fetchJson<DepartmentChannelRow[]>('/ops/departments'),

  // Jobs
  listJobs:        (status?: JobStatus) =>
    fetchJson<JobRow[]>(`/ops/jobs${status ? `?status=${status}` : ''}`),
  getJob:          (id: string) =>
    fetchJson<{job: JobRow; applications: ApplicationRow[]}>(`/ops/jobs/${id}`),
  // Job + application mutations carry an Idempotency-Key too — a retried
  // dispatch must not mint two missions, and a double-clicked assign must
  // not consume two slots.
  cancelJob:       (id: string, reason: string) =>
    fetchJson(`/ops/jobs/${id}/cancel`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  dispatchJob:     (id: string) =>
    fetchJson<{mission_id: string}>(`/ops/jobs/${id}/dispatch`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Applications
  shortlistApp:    (id: string) =>
    fetchJson(`/ops/applications/${id}/shortlist`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  assignApp:       (id: string) =>
    fetchJson(`/ops/applications/${id}/assign`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  rejectApp:       (id: string, notes?: string) =>
    fetchJson(`/ops/applications/${id}/reject`, {
      method: 'POST', body: JSON.stringify({notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Agents
  listAgents:      (q?: {status?: string; type?: string; limit?: number}) => {
    const p = new URLSearchParams();
    if (q?.status) p.set('status', q.status);
    if (q?.type)   p.set('type', q.type);
    if (q?.limit)  p.set('limit', String(q.limit));
    const qs = p.toString();
    return fetchJson<AgentListRow[]>(`/ops/agents${qs ? `?${qs}` : ''}`);
  },
  getAgent:        (id: string) =>
    fetchJson<AgentDetail>(`/ops/agents/${id}`),
  decideAgent:     (id: string, decision: 'APPROVED' | 'REJECTED', notes?: string) =>
    fetchJson(`/ops/agents/${id}/decide`, {
      method: 'POST', body: JSON.stringify({decision, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  reviewDoc:       (agentId: string, slot: string) =>
    fetchJson(`/ops/agents/${agentId}/docs/${slot}/review`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  reviewKyc:       (agentId: string, kind: string) =>
    fetchJson(`/ops/agents/${agentId}/kyc/${kind}/review`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  agentStats:      (id: string) => fetchJson<AgentStats>(`/ops/agents/${id}/stats`),
  terminateAgent:  (id: string, notes?: string) =>
    fetchJson(`/ops/agents/${id}/terminate`, {
      method: 'POST', body: JSON.stringify({notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Audit fix 4.2 — log every click-to-reveal of customer PII. Best-effort:
  // failure to log shouldn't refuse the reveal (the admin already has the
  // value in memory from the parent fetch).
  auditPiiReveal: (body: {kind: 'phone' | 'email' | 'address'; subject: string}) =>
    fetchJson(`/ops/audit/pii-reveal`, {method: 'POST', body: JSON.stringify(body)}),

  // Mission deployment checklist
  getMissionDeployment: (missionId: string) =>
    fetchJson<{
      crew: Array<{agent_id: string; call_sign: string; role: string}>;
      checks: Array<{user_id: string; check_key: string; state: string; signed_at: string | null; notes: string | null}>;
    }>(`/ops/missions/${missionId}/deployment`),
  signoffMissionDeploy: (missionId: string, agent_id: string, check_key: string, state: 'passed' | 'failed') =>
    fetchJson(`/ops/missions/${missionId}/deployment/signoff`, {
      method: 'POST', body: JSON.stringify({agent_id, check_key, state}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Missions — status='active' (default, omitted) returns LIVE/DISPATCHED/PICKUP/SOS,
  // status='completed' returns COMPLETED/ABORTED for the closed-history tab.
  listMissions:    (region?: string, status?: 'active' | 'completed', limit?: number) => {
    const qs = new URLSearchParams();
    if (region) qs.set('region', region);
    if (status) qs.set('status', status);
    if (limit)  qs.set('limit', String(limit));
    const tail = qs.toString();
    return fetchJson<MissionRow[]>(`/ops/missions${tail ? `?${tail}` : ''}`);
  },
  getMission:      (id: string) => fetchJson<MissionDetail>(`/ops/missions/${id}`),
  // Audit H4 — destructive mission/SOS mutations carry an Idempotency-Key
  // so a double-click or network retry collapses to one server action
  // instead of two audit rows / duplicate state changes. Pairs with the
  // IdempotencyInterceptor now mounted on these endpoints server-side.
  abortMission:    (id: string, reason: string, notes?: string) =>
    fetchJson(`/ops/missions/${id}/abort`, {
      method: 'POST', body: JSON.stringify({reason, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // SOS
  ackSos:          (id: string, notes?: string) =>
    fetchJson(`/ops/sos/${id}/ack`, {
      method: 'POST', body: JSON.stringify({notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  escalateSos:     (id: string, escalated_to: string, notes?: string) =>
    fetchJson(`/ops/sos/${id}/escalate`, {
      method: 'POST', body: JSON.stringify({escalated_to, notes}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  resolveSos:      (id: string, resolution: string) =>
    fetchJson(`/ops/sos/${id}/resolve`, {
      method: 'POST', body: JSON.stringify({resolution}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Conversation roster — used by the Mission Group panel to know who
  // it should encrypt envelopes for. Returns members + my admin role.
  getConversation: (id: string) =>
    fetchJson<{
      id: string; kind: 'direct' | 'group'; title: string | null;
      createdAt: string; createdBy: string;
      members: Array<{userId: string; displayName: string; role: 'admin' | 'member'; joinedAt: string}>;
      myRole: 'admin' | 'member';
    }>(`/conversations/${id}`),

  // Mission RE-ROUTE picker — fetch up to 3 driving alternatives between
  // the booking's pickup and dropoff, then persist the chosen polyline.
  // The CPO mobile app polls the mission row and switches roads within
  // one cycle, so no agent-side changes are needed.
  getRouteOptions: (missionId: string) =>
    fetchJson<{
      options: Array<{
        key: string; distance_m: number; duration_s: number;
        polyline: string | null; is_current: boolean;
      }>;
      pickup:  {lat: number; lng: number} | null;
      dropoff: {lat: number; lng: number} | null;
    }>(`/ops/missions/${missionId}/route-options`),
  selectRoute: (missionId: string, body: {polyline: string; distance_m: number; duration_s: number}) =>
    fetchJson<void>(`/ops/missions/${missionId}/route-select`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // Mission ops-room messaging — free-form ops ↔ CPO/principal text.
  // Messages are stored as system_broadcasts on the mission's
  // comms_channel_id, so CPOs see them inline in their messenger feed.
  listMissionMessages: (id: string) =>
    fetchJson<{
      messages: Array<{
        id: string; kind: string; title: string; body: string;
        severity: string; created_at: string;
        payload?: {sender_label?: string; mission_short_code?: string};
      }>;
      conversation_id?: string;
    }>(`/ops/missions/${id}/messages`),
  sendMissionMessage: (id: string, text: string) =>
    // Keyed so a retried send doesn't broadcast the same ops message to
    // the mission channel twice.
    fetchJson<{ok: boolean; id?: string; reason?: string}>(
      `/ops/missions/${id}/messages`,
      {
        method: 'POST', body: JSON.stringify({text}),
        idempotencyKey: newIdempotencyKey(),
      } as RequestInit & {idempotencyKey?: string},
    ),

  // ─── Auto-dispatch monitor (watch the matchmaker work) ───────────────
  dispatchMonitor: () => fetchJson<DispatchMonitor>(`/ops/dispatch/monitor`),
  // Audit PAGE-17 — keyed so a network retry can't mint two real
  // DISPATCHING bookings cascading offers to live agencies.
  fireTestDispatch: (args: FireTestDispatchArgs) =>
    fetchJson<{booking_id: string}>(`/ops/dispatch/test`, {
      method: 'POST', body: JSON.stringify(args),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  // Step 26 — runtime kill-switch state + admin overrides (idempotent, attributable).
  killswitchState: () =>
    fetchJson<{runtime: 'true' | 'false' | 'unset'; enabled: boolean}>(`/ops/dispatch/killswitch`),
  setKillswitch: (enabled: boolean) =>
    fetchJson<{ok: true; enabled: boolean}>(`/ops/dispatch/killswitch`, {
      method: 'PUT', body: JSON.stringify({enabled}),
    }),
  cancelDispatch: (bookingId: string) =>
    fetchJson<{ok: true; cancelled: true}>(`/ops/dispatch/${bookingId}/cancel`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  forceAssign: (bookingId: string) =>
    fetchJson<{ok: true; offer_id: string; provider_user_id: string; booking_id: string}>(`/ops/dispatch/${bookingId}/force-assign`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // ─── Dispatch Inspector (read-only audit of every dispatch request) ──
  dispatchRequests: (q?: {status?: string}) => {
    const p = new URLSearchParams();
    if (q?.status) { p.set('status', q.status); }
    const qs = p.toString();
    return fetchJson<DispatchRequestRow[]>(`/ops/dispatch/requests${qs ? `?${qs}` : ''}`);
  },
  dispatchRequestDetail: (id: string) =>
    fetchJson<DispatchRequestDetail>(`/ops/dispatch/requests/${id}`),

  // ─── Provider compliance review (vetting gate, Step 15) ──────────────
  compliancePending: () => fetchJson<CompliancePendingRow[]>(`/ops/compliance/pending`),
  // Audit PAGE-18 — keyed like every other decision mutation so a retry can't double-apply.
  verifyCompliance: (id: string) => fetchJson<{ok: true}>(`/ops/compliance/${id}/verify`, {
    method: 'POST', idempotencyKey: newIdempotencyKey(),
  } as RequestInit & {idempotencyKey?: string}),
  rejectCompliance: (id: string, reason: string) =>
    fetchJson<{ok: true}>(`/ops/compliance/${id}/reject`, {
      method: 'POST', body: JSON.stringify({reason}), idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // ── Dept Chat v2 oversight (Step 15; AdminGuard tier) ──
  deptIncidents: (params?: {org_id?: string; status?: string; severity?: string}) => {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => Boolean(v)) as [string, string][],
    ).toString();
    return fetchJson<DeptIncidentRow[]>(`/ops/deptchat/incidents${qs ? `?${qs}` : ''}`);
  },
  deptAttendanceSummary: (orgId: string, from?: string, to?: string) => {
    const qs = new URLSearchParams({
      org_id: orgId, ...(from ? {from} : {}), ...(to ? {to} : {}),
    }).toString();
    return fetchJson<DeptAttendanceSummary>(`/ops/deptchat/attendance/summary?${qs}`);
  },
  // Export returns text/csv (not JSON) → raw fetch so we can hand back the body
  // for a client-side Blob download. SUPERVISOR/ADMIN only (backend @RequireRoles).
  deptAttendanceExport: async (orgId: string, from?: string, to?: string): Promise<string> => {
    const csrf = readCsrfToken();
    const res = await fetch(`${BASE}/ops/deptchat/attendance/export`, {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json', ...(csrf ? {'X-CSRF-Token': csrf} : {})},
      body: JSON.stringify({org_id: orgId, from, to}),
      cache: 'no-store',
    });
    if (!res.ok) {throw new ApiError(res.status, null, res.statusText);}
    return res.text();
  },

  // ── RS-09 — admin lifecycle (ADMIN-only, backend class-wide gate) ──
  listAdmins: () => fetchJson<AdminAccountRow[]>(`/ops/admins`),
  setAdminRole: (userId: string, role: 'OPS' | 'SUPERVISOR' | 'ADMIN') =>
    fetchJson<{role: string}>(`/ops/admins/${userId}/role`, {
      method: 'PATCH', body: JSON.stringify({role}),
    }),
  // OC-09 — offboard/reinstate an operator (sets admin_users.active).
  setAdminActive: (userId: string, active: boolean) =>
    fetchJson<{active: boolean}>(`/ops/admins/${userId}/active`, {
      method: 'PATCH', body: JSON.stringify({active}),
    }),
  listAdminInvites: () => fetchJson<AdminInviteRow[]>(`/ops/admins/invites`),
  createAdminInvite: (dto: {
    email: string; display_name: string; call_sign: string;
    role?: 'OPS' | 'SUPERVISOR' | 'ADMIN'; region?: string;
  }) =>
    // CA-18 — keyed like every sibling POST: a retried create must not mint
    // two live invite tokens for the same admin.
    fetchJson<{invite: AdminInviteRow; token: string}>(`/ops/admins/invites`, {
      method: 'POST', body: JSON.stringify(dto),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  revokeAdminInvite: (id: string) =>
    fetchJson<{ok: true}>(`/ops/admins/invites/${id}`, {method: 'DELETE'}),

  // ── Issue 28 — partner / referral code mint + deactivate ──
  listReferralCodes: () => fetchJson<ReferralCodeRow[]>(`/ops/referral-codes`),
  createReferralCode: (dto: {
    code: string; owner_user_id?: string; partner_name?: string;
    purpose?: string; expires_at?: string;
  }) =>
    // Keyed like every sibling POST: a transport-level replay of this exact
    // request is deduped (the key is per click, so a fresh click is a fresh
    // create — the unique code constraint catches real duplicates with a 409).
    fetchJson<ReferralCodeRow>(`/ops/referral-codes`, {
      method: 'POST', body: JSON.stringify(dto),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  setReferralCodeActive: (id: string, active: boolean) =>
    fetchJson<{id: string; code: string; active: boolean; expires_at: string | null}>(
      `/ops/referral-codes/${id}/active`, {
        method: 'PATCH', body: JSON.stringify({active}),
      }),
};

export interface AdminAccountRow {
  user_id: string;
  display_name: string;
  call_sign: string;
  role: 'OPS' | 'SUPERVISOR' | 'ADMIN';
  region: string;
  active: boolean;
  last_active_at: string | null;
  created_at: string;
  email: string | null;
}

export interface AdminInviteRow {
  id: string;
  email: string;
  display_name: string;
  call_sign: string;
  role: 'OPS' | 'SUPERVISOR' | 'ADMIN';
  region: string;
  invited_by: string;
  expires_at: string;
  redeemed_at: string | null;
  revoked_at: string | null;
  created_at: string;
  status: 'pending' | 'redeemed' | 'revoked' | 'expired';
}

export interface ReferralCodeRow {
  id: string;
  code: string;
  owner_user_id: string | null;
  owner_name: string | null;
  partner_name: string | null;
  purpose: string | null;
  active: boolean;
  expires_at: string | null;
  redeemed_count: number;
  booking_count: number;
  created_at: string;
  status: 'active' | 'inactive' | 'expired';
}

export interface DeptIncidentRow {
  id: string;
  ref: string | null;
  org_user_id: string;
  /** IS-09 — org display name joined server-side. */
  org_name?: string | null;
  submitter_id: string;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  status: 'submitted' | 'received' | 'under_review' | 'action_assigned' | 'resolved' | 'closed';
  created_at: string;
  updated_at: string;
}

export interface DeptAttendanceSummary {
  counts: Record<string, number>;
  total: number;
  pendingReview: number;
}

export interface CompliancePendingRow {
  id: string; doc_type: string; subject_user_id: string; region_code: string;
  reference: string | null; expires_at: string; created_at: string;
  /** DC-03 — armed permits ride the same queue; verify/reject route to /ops/armed/:id/*. */
  armed: boolean;
  /** IS-06 — reviewer context: who submitted + the doc itself (armed rows have no file). */
  provider_name?: string | null;
  file_url?: string | null;
}

export interface DispatchOfferRow {
  offer_id: string; provider_user_id: string; provider_email: string | null;
  status: string; rank: number; distance_km: string | null;
  offered_at: string; expires_at: string; reject_reason: string | null;
}
export interface DispatchMonitor {
  dispatching: Array<{
    booking_id: string; region_code: string; region_label: string; service: string;
    cpo_count: number; armed_required: boolean; dispatch_started_at: string | null;
    offers: DispatchOfferRow[];
  }>;
  recent: Array<{
    booking_id: string; status: string; region_code: string; service: string; cpo_count: number;
    assigned_provider_user_id: string | null; provider_email: string | null;
    dispatch_started_at: string | null; dispatch_settled_at: string | null; updated_at: string;
  }>;
}
export interface FireTestDispatchArgs {
  region_code: string; region_label?: string; pickup_lat: number; pickup_lng: number;
  pickup_address?: string; cpo_count?: number; duration_hours?: number; armed?: boolean; total_eur?: number;
}

// ─── Dispatch Inspector (read-only) ──────────────────────────────────
// Field names mirror the backend JSON exactly. DECIMAL columns (distance_km,
// rating, total_eur/aed) arrive as strings — coerce with Number(...) at render.
export interface DispatchRequestRow {
  booking_id: string; status: string; region_code: string; region_label: string;
  service: string; cpo_count: number; armed_required: boolean; dispatch_mode: string | null;
  dispatch_started_at: string | null; dispatch_settled_at: string | null;
  created_at: string; updated_at: string; assigned_provider_user_id: string | null;
  accepting_agency_name: string | null; accepting_agency_call_sign: string | null;
  offers_count: number; crew_count: number;
  escrow_status: string | null; escrow_gross_credits: number | null;
  mission_status: string | null; mission_short_code: string | null; last_activity_at: string;
}
export interface DispatchRequestDetailOffer {
  offer_id: string; provider_user_id: string;
  agency_name: string | null; agency_call_sign: string | null; agency_email: string | null;
  agency_rating: string | null; agency_region: string | null;
  rank: number; status: string; distance_km: string | null;
  offered_at: string; expires_at: string; responded_at: string | null; reject_reason: string | null;
}
export interface DispatchRequestCrew {
  agent_id: string; agent_name: string | null; agent_rating: string | null;
  call_sign: string; role: string; is_lead: boolean; slot: number; team_idx: number;
  armed: boolean; status: string;
}
export interface DispatchRequestEscrow {
  escrow_id: string; status: string; gross_credits: number; currency: string;
  to_provider_credits: number | null; to_client_credits: number | null; platform_fee_credits: number | null;
  basis: string | null; review_required: boolean;
  held_at: string; completed_at: string | null; release_eligible_at: string | null; settled_at: string | null;
  offer_id: string | null;
}
export interface DispatchRequestMission {
  mission_id: string; status: string; short_code: string;
  started_at: string; created_at: string; pickup_at: string | null; live_at: string | null;
  ended_at: string | null; end_reason: string | null; comms_channel_id: string | null;
}
export interface DispatchTimelineEntry {
  at: string; source: string; label: string;
  actor_role: string | null; actor_call: string | null; metadata: Record<string, unknown>;
}
export interface DispatchRequestDetail {
  booking: {
    booking_id: string; status: string; dispatch_mode: string | null;
    region_code: string; region_label: string; service: string;
    cpo_count: number; armed_required: boolean; requirements: Record<string, unknown> | null;
    client_id: string; assigned_provider_user_id: string | null;
    agency_name: string | null; agency_call_sign: string | null; agency_rating: string | null; agency_email: string | null;
    pickup_address: string | null; pickup_time: string | null; duration_hours: number | null;
    total_eur: string | null; total_aed: string | null;
    dispatch_started_at: string | null; dispatch_settled_at: string | null;
    crew_deadline_at: string | null; arrival_deadline_at: string | null;
    created_at: string; updated_at: string;
  };
  offers: DispatchRequestDetailOffer[];
  escrow: DispatchRequestEscrow | null;
  mission: DispatchRequestMission | null;
  crew: DispatchRequestCrew[];
  timeline: DispatchTimelineEntry[];
}

// ─── SWR hooks (real-time feel via polling) ─────────────────────────

const POLL_DASH = Number(process.env.NEXT_PUBLIC_DASHBOARD_POLL_MS ?? 5000);
const POLL_MSN  = Number(process.env.NEXT_PUBLIC_MISSION_POLL_MS   ?? 2000);

export function useDashboard(region?: string, opts?: SWRConfiguration) {
  return useSWR<DashboardResponse>(
    ['dashboard', region ?? 'all'],
    () => opsApi.dashboard(region),
    {refreshInterval: POLL_DASH, ...opts},
  );
}

export function useDispatchMonitor() {
  return useSWR<DispatchMonitor>('dispatch-monitor', () => opsApi.dispatchMonitor(), {refreshInterval: POLL_MSN});
}

export function useDispatchRequests(status?: string) {
  return useSWR<DispatchRequestRow[]>(
    ['dispatch-requests', status ?? 'all'],
    () => opsApi.dispatchRequests({status}),
    {refreshInterval: POLL_DASH},
  );
}

export function useDispatchRequest(id: string | null) {
  return useSWR(
    id ? ['dispatch-request', id] : null,
    () => (id ? opsApi.dispatchRequestDetail(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

export function useCompliancePending() {
  return useSWR<CompliancePendingRow[]>('compliance-pending', () => opsApi.compliancePending(), {refreshInterval: POLL_DASH});
}

export function useDeptIncidents(params?: {org_id?: string; status?: string; severity?: string}) {
  return useSWR<DeptIncidentRow[]>(
    ['dept-incidents', params?.org_id ?? 'all', params?.status ?? 'all', params?.severity ?? 'all'],
    () => opsApi.deptIncidents(params),
    {refreshInterval: POLL_DASH},
  );
}

export function useBookings(status?: BookingStatus, region?: string, limit?: number) {
  return useSWR<BookingRow[]>(
    ['bookings', status ?? 'all', region ?? 'all', limit ?? 50],
    () => opsApi.listBookings({status, region, limit}),
    {refreshInterval: POLL_DASH},
  );
}

export function useBookingDetail(id: string | null) {
  return useSWR(
    id ? ['booking', id] : null,
    () => (id ? opsApi.getBooking(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useJobs(status?: JobStatus) {
  return useSWR<JobRow[]>(
    ['jobs', status ?? 'all'],
    () => opsApi.listJobs(status),
    {refreshInterval: POLL_DASH},
  );
}

// ─── Bravo Secure Pro applications (request-and-approval custom plans) ──────
// NOT the agent job `ApplicationRow` above — this is the client-facing Pro
// plan pipeline (pro_applications tables, /ops/pro-applications surface).

export type ProApplicationStatus =
  | 'PENDING_PROPOSAL' | 'PROPOSAL_CREATED' | 'REVISION_REQUESTED'
  | 'ACCEPTED' | 'ACTIVE' | 'EXPIRED' | 'REJECTED' | 'CANCELLED';

export interface ProHistoryEntry {
  id: string;
  status: ProApplicationStatus;
  intended_use: string;
  submitted_at: string;
  activated_at: string | null;
  current_period_end: string | null;
  total_credits: number | null;
  coverage_start: string | null;
  coverage_end: string | null;
}

export interface ProApplicationRow {
  id: string;
  status: ProApplicationStatus;
  intended_use: string;
  intended_use_note: string | null;
  duration_months: number | null;
  duration_note: string | null;
  start_date: string;
  coverage_area: string;
  cpo_count: number;
  driver_count: number;
  support_staff_count: number;
  gender_preference: string;
  services: string[];
  submitted_at: string;
  updated_at: string;
  client_name: string | null;
  client_email: string;
  client_phone: string | null;
  /** Latest proposal's TOTAL credits for the whole coverage period. */
  total_credits: number | null;
  proposal_version: number | null;
  activated_at?: string | null;
  current_period_end?: string | null;
  /** Last COVERED day (period end − 1 day) — render THIS, not current_period_end. */
  covered_until?: string | null;
}

/** SK-07/IS-03 — a linked family member riding (or held off) the owner's plan. */
export interface ProFamilyMember {
  id: string;
  member_id: string | null;
  member_name: string | null;
  member_email: string | null;
  status: 'pending' | 'active';
  relationship: string | null;
  held_until: string | null;
  spend_limit_credits: number | null;
  spent_credits: number;
  invited_at: string;
  accepted_at: string | null;
}

export interface ProProposalRecord {
  id: string;
  application_id: string;
  version: number;
  proposal_number: string;
  valid_until: string;
  coverage_start: string;
  coverage_end: string;
  /** Total BC for the whole coverage period (debited once at activation). */
  total_credits: number;
  included_services: string[];
  assigned_team: Array<{role: string; count: number; label?: string}>;
  terms: string | null;
  created_at: string;
}

export interface ProAppEvent {
  id: string;
  event: string;
  actor: 'client' | 'ops' | 'system';
  message: string | null;
  created_at: string;
}

export interface ProAppMessage {
  id: string;
  sender: 'client' | 'ops';
  body: string;
  created_at: string;
}

export interface ProMissionRecord {
  id: string;
  application_id: string;
  requested_by: string;
  requested_by_name?: string | null;
  mission_dates: string[];
  note: string | null;
  status: 'REQUESTED' | 'SCHEDULED' | 'DECLINED' | 'COMPLETED';
  assigned_team: Array<{role: string; count: number; label?: string}>;
  ops_note: string | null;
  created_at: string;
}

export interface ProApplicationDetail {
  application: ProApplicationRow & {
    user_id: string;
    notes: string | null;
    service_other_note: string | null;
    internal_notes: string | null;
    rejected_reason: string | null;
    decided_at: string | null;
    activated_at: string | null;
    current_period_end: string | null;
    /** Last COVERED day (period end - 1 day) - render THIS, not current_period_end. */
    covered_until?: string | null;
    /** IS-02 — resolved identity of the deciding admin (reject / cancel). */
    decided_by?: string | null;
    decided_by_name?: string | null;
    decided_by_email?: string | null;
  };
  proposals: ProProposalRecord[];
  events: ProAppEvent[];
  messages: ProAppMessage[];
  missions: ProMissionRecord[];
  /** The client's other applications — full past + present at a glance. */
  history: ProHistoryEntry[];
  /** SK-07/IS-03 — the applicant's linked family members (plan riders). */
  family?: ProFamilyMember[];
}

export interface CreateProProposalBody {
  total_credits: number;
  valid_until: string;
  coverage_start: string;
  coverage_end: string;
  included_services: string[];
  assigned_team: Array<{role: string; count: number; label?: string}>;
  terms?: string;
  note?: string;
}

export const proAppsApi = {
  list: (status?: string, limit?: number) => {
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return fetchJson<{applications: ProApplicationRow[]}>(
      `/ops/pro-applications${query ? `?${query}` : ''}`);
  },
  get: (id: string) =>
    fetchJson<ProApplicationDetail>(`/ops/pro-applications/${id}`),
  createProposal: (id: string, body: CreateProProposalBody) =>
    fetchJson<{application: ProApplicationRow; proposal: ProProposalRecord}>(
      `/ops/pro-applications/${id}/proposal`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  reject: (id: string, reason: string) =>
    fetchJson<{application: ProApplicationRow}>(
      `/ops/pro-applications/${id}/reject`,
      {method: 'POST', body: JSON.stringify({reason}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  cancel: (id: string, note?: string) =>
    fetchJson<{application: ProApplicationRow}>(
      `/ops/pro-applications/${id}/cancel`,
      {method: 'POST', body: JSON.stringify(note?.trim() ? {note: note.trim()} : {}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  setInternalNotes: (id: string, notes: string) =>
    fetchJson<{ok: true}>(
      `/ops/pro-applications/${id}/internal-notes`,
      {method: 'PUT', body: JSON.stringify({notes})},
    ),
  sendMessage: (id: string, body: string) =>
    // CA-05 — keyed so a double-send (Enter + click race) collapses server-side.
    fetchJson<{message: ProAppMessage}>(
      `/ops/pro-applications/${id}/messages`,
      {method: 'POST', body: JSON.stringify({body}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  scheduleMission: (id: string, missionId: string, body: {assigned_team?: Array<{role: string; count: number; label?: string}>; ops_note?: string}) =>
    fetchJson<{mission: ProMissionRecord}>(
      `/ops/pro-applications/${id}/missions/${missionId}/schedule`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
  declineMission: (id: string, missionId: string, opsNote?: string) =>
    fetchJson<{mission: ProMissionRecord}>(
      `/ops/pro-applications/${id}/missions/${missionId}/decline`,
      {method: 'POST', body: JSON.stringify({ops_note: opsNote}), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string},
    ),
};

// ─── Pro management (orgs / CPOs / assignments / mission codes) ─────────────

export interface ProOrgRow {
  id: string;
  display_name: string;
  status: string;
  internal: boolean;
  email: string;
  phone_e164: string | null;
  created_at: string;
  cpo_count: number;
  live_assignments: number;
}

export interface ProPoolCpo {
  id: string;
  display_name: string;
  avatar_url: string | null;
  agent_status: string;
  org_user_id: string | null;
  org_name: string | null;
  member_status: string;
  call_sign: string | null;
  internal: boolean;
  busy_in_window: boolean;
  /** ASSIGNED window on the requesting application covers the whole window —
   *  the member's own dedicated officer (selectable even though "busy"). */
  dedicated?: boolean;
  suspended_now: boolean;
  available: boolean;
  next_assignment_start: string | null;
}

export interface ProAssignmentRecord {
  id: string;
  application_id: string;
  mission_id: string | null;
  cpo_user_id: string;
  org_user_id: string | null;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
  mission_code: string;
  note: string | null;
  created_at: string;
  cpo_name: string | null;
  org_name: string | null;
  member_name: string | null;
}

export interface ProMissionRequestRow {
  id: string;
  application_id: string;
  mission_dates: string[];
  note: string | null;
  status: string;
  created_at: string;
  member_name: string | null;
  requested_by_name: string | null;
}

export const proMgmtApi = {
  requests: () => fetchJson<{requests: ProMissionRequestRow[]}>(`/ops/pro-management/requests`),
  listOrgs: () => fetchJson<{orgs: ProOrgRow[]}>(`/ops/pro-management/orgs`),
  createOrg: (body: {display_name: string; email: string; phone_e164: string; temp_password: string; coverage_country?: string}) =>
    fetchJson<{org: ProOrgRow}>(`/ops/pro-management/orgs`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  orgDetail: (id: string) =>
    fetchJson<{org: ProOrgRow; roster: Array<{user_id: string; display_name: string; member_role: string; status: string; call_sign: string | null; agent_status: string | null}>; protected_members: Array<{application_id: string; member_name: string; application_status: string}>}>(
      `/ops/pro-management/orgs/${id}`),
  createCpo: (body: {org_user_id: string; display_name: string; email: string; phone_e164: string; temp_password: string; call_sign?: string}) =>
    fetchJson<{member: unknown}>(`/ops/pro-management/cpos`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  suspendCpo: (userId: string, body: {suspend: boolean; days?: number; reason?: string}) =>
    fetchJson<{ok: true}>(`/ops/pro-management/cpos/${userId}/suspension`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  pool: (from?: string, to?: string, applicationId?: string) => {
    const p = new URLSearchParams();
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (applicationId) p.set('application_id', applicationId);
    const q = p.toString();
    return fetchJson<{cpos: ProPoolCpo[]}>(`/ops/pro-management/pool${q ? `?${q}` : ''}`);
  },
  assignments: (filter?: {application_id?: string; cpo_user_id?: string; status?: string}) => {
    const p = new URLSearchParams();
    if (filter?.application_id) p.set('application_id', filter.application_id);
    if (filter?.cpo_user_id) p.set('cpo_user_id', filter.cpo_user_id);
    if (filter?.status) p.set('status', filter.status);
    const q = p.toString();
    return fetchJson<{assignments: ProAssignmentRecord[]}>(`/ops/pro-management/assignments${q ? `?${q}` : ''}`);
  },
  createAssignment: (body: {application_id: string; cpo_user_id: string; starts_on: string; ends_on: string; note?: string; mission_id?: string}) =>
    fetchJson<{assignment: ProAssignmentRecord}>(`/ops/pro-management/assignments`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  cancelAssignment: (id: string) =>
    fetchJson<{assignment: ProAssignmentRecord}>(`/ops/pro-management/assignments/${id}/cancel`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  completeAssignment: (id: string) =>
    fetchJson<{assignment: ProAssignmentRecord}>(`/ops/pro-management/assignments/${id}/complete`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  scheduleWithCpos: (applicationId: string, missionId: string, body: {cpo_user_ids: string[]; ops_note?: string}) =>
    fetchJson<{mission: unknown; assignments: ProAssignmentRecord[]}>(
      `/ops/pro-management/applications/${applicationId}/missions/${missionId}/schedule-cpos`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
};

// ─── Issue 30 — Pro fleet + resources (vehicle/resource catalogs + assignments) ──
// The separate Pro vehicle fleet (NOT the Lite vehicle_pool) and an assignable
// resources inventory, plus their plan-scoped link tables. Ops sees the full
// catalog INCLUDING a resource's `identifier` (ops-internal serial) — the client
// projection (listTeam) withholds it. Base path /ops/pro-management (Layer 1).

export type ProResourceKind = 'comms' | 'medical' | 'tactical' | 'other';

export interface ProFleetVehicle {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  colour: string | null;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
  region_code: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProResource {
  id: string;
  kind: ProResourceKind;
  label: string;
  /** Ops-internal serial — shown to OPS here; withheld from the client projection. */
  identifier: string | null;
  active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** A plan-scoped vehicle assignment. Joined catalog fields are present on the
 *  list row; absent on the assign/release return (which the UI only revalidates). */
export interface ProVehicleAssignment {
  id: string;
  application_id: string;
  vehicle_id: string;
  assignment_id: string | null;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'RELEASED';
  note: string | null;
  created_at: string;
  released_at: string | null;
  call_sign?: string;
  make_model?: string;
  plate?: string;
  colour?: string | null;
  armored?: boolean;
  armor_grade?: string | null;
  capacity?: number;
}

export interface ProResourceAssignment {
  id: string;
  application_id: string;
  resource_id: string;
  assignment_id: string | null;
  qty: number;
  starts_on: string;
  ends_on: string;
  status: 'ASSIGNED' | 'RELEASED';
  note: string | null;
  created_at: string;
  released_at: string | null;
  kind?: ProResourceKind;
  label?: string;
  identifier?: string | null;
}

export interface CreateProFleetVehicleBody {
  call_sign: string;
  make_model: string;
  plate: string;
  colour?: string;
  armored?: boolean;
  armor_grade?: string;
  capacity?: number;
  region_code?: string;
  notes?: string;
}
/** Partial update / retire (active=false). */
export type UpdateProFleetVehicleBody = Partial<CreateProFleetVehicleBody> & {active?: boolean};

export interface CreateProResourceBody {
  kind: ProResourceKind;
  label: string;
  identifier?: string;
  notes?: string;
}
export type UpdateProResourceBody = Partial<CreateProResourceBody> & {active?: boolean};

export interface AssignProVehicleBody {
  vehicle_id: string;
  starts_on: string;
  ends_on: string;
  assignment_id?: string;
  note?: string;
}
export interface AssignProResourceBody {
  resource_id: string;
  qty?: number;
  starts_on: string;
  ends_on: string;
  assignment_id?: string;
  note?: string;
}

export const proFleetApi = {
  // ── Vehicle catalog ──
  listFleet: (includeInactive?: boolean) =>
    fetchJson<{vehicles: ProFleetVehicle[]}>(
      `/ops/pro-management/fleet${includeInactive ? '?include_inactive=true' : ''}`),
  createFleet: (body: CreateProFleetVehicleBody) =>
    fetchJson<{vehicle: ProFleetVehicle}>(`/ops/pro-management/fleet`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  updateFleet: (id: string, body: UpdateProFleetVehicleBody) =>
    fetchJson<{vehicle: ProFleetVehicle}>(`/ops/pro-management/fleet/${id}`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),

  // ── Resource catalog ──
  listResources: (includeInactive?: boolean) =>
    fetchJson<{resources: ProResource[]}>(
      `/ops/pro-management/resources${includeInactive ? '?include_inactive=true' : ''}`),
  createResource: (body: CreateProResourceBody) =>
    fetchJson<{resource: ProResource}>(`/ops/pro-management/resources`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  updateResource: (id: string, body: UpdateProResourceBody) =>
    fetchJson<{resource: ProResource}>(`/ops/pro-management/resources/${id}`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),

  // ── Vehicle assignments (plan-scoped) ──
  applicationVehicles: (appId: string) =>
    fetchJson<{assignments: ProVehicleAssignment[]}>(`/ops/pro-management/applications/${appId}/vehicles`),
  assignVehicle: (appId: string, body: AssignProVehicleBody) =>
    fetchJson<{assignment: ProVehicleAssignment}>(`/ops/pro-management/applications/${appId}/vehicles`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  releaseVehicle: (id: string) =>
    fetchJson<{assignment: ProVehicleAssignment}>(`/ops/pro-management/vehicle-assignments/${id}/release`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),

  // ── Resource assignments (plan-scoped) ──
  applicationResources: (appId: string) =>
    fetchJson<{assignments: ProResourceAssignment[]}>(`/ops/pro-management/applications/${appId}/resources`),
  assignResource: (appId: string, body: AssignProResourceBody) =>
    fetchJson<{assignment: ProResourceAssignment}>(`/ops/pro-management/applications/${appId}/resources`,
      {method: 'POST', body: JSON.stringify(body), idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
  releaseResource: (id: string) =>
    fetchJson<{assignment: ProResourceAssignment}>(`/ops/pro-management/resource-assignments/${id}/release`,
      {method: 'POST', body: '{}', idempotencyKey: newIdempotencyKey()} as RequestInit & {idempotencyKey?: string}),
};

export function useProFleet(includeInactive?: boolean) {
  return useSWR<{vehicles: ProFleetVehicle[]}>(
    ['pro-fleet', includeInactive ? 'all' : 'active'],
    () => proFleetApi.listFleet(includeInactive),
    {refreshInterval: POLL_DASH},
  );
}

export function useProResources(includeInactive?: boolean) {
  return useSWR<{resources: ProResource[]}>(
    ['pro-resources', includeInactive ? 'all' : 'active'],
    () => proFleetApi.listResources(includeInactive),
    {refreshInterval: POLL_DASH},
  );
}

export function useProApplicationVehicles(id: string | null) {
  return useSWR<{assignments: ProVehicleAssignment[]}>(
    id ? ['pro-app-vehicles', id] : null,
    () => (id ? proFleetApi.applicationVehicles(id) : Promise.resolve({assignments: []})),
    {refreshInterval: POLL_DASH},
  );
}

export function useProApplicationResources(id: string | null) {
  return useSWR<{assignments: ProResourceAssignment[]}>(
    id ? ['pro-app-resources', id] : null,
    () => (id ? proFleetApi.applicationResources(id) : Promise.resolve({assignments: []})),
    {refreshInterval: POLL_DASH},
  );
}

// ─── Protection sessions monitoring (spec §8) ────────────────────────────────

export type ProtectionStalenessState = 'idle' | 'live' | 'delayed' | 'unavailable';
export interface ProtectionStaleness {
  age_seconds: number | null;
  state: ProtectionStalenessState;
}
export interface ProtectionSessionRow {
  id: string;
  application_id: string;
  status: string;
  customer_id: string;
  cpo_user_id: string;
  requested_at: string;
  activated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_fix_at: string | null;
  sos_active: boolean;
  protect_activated_at?: string | null;
  protection_status?: 'not_activated' | 'active' | 'ended';
  customer_name: string | null;
  cpo_name: string | null;
  staleness: ProtectionStaleness;
}
export interface ProtectionTrailFix {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  recorded_at: string;
  received_at: string;
}
export interface ProtectionNote {
  id: string;
  sender: 'customer' | 'cpo';
  body: string;
  created_at: string;
}
export interface ProtectionSessionDetail {
  session: Record<string, unknown> & {customer_name?: string | null; cpo_name?: string | null; protect_activated_at?: string | null};
  staleness: ProtectionStaleness;
  trail: ProtectionTrailFix[];
  cpo_trail: ProtectionTrailFix[];
  notes: ProtectionNote[];
  server_now: string;
}

export const opsProtectionApi = {
  list: (status?: string) =>
    fetchJson<{sessions: ProtectionSessionRow[]; server_now: string}>(
      `/ops/protection/sessions${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  detail: (id: string) =>
    fetchJson<ProtectionSessionDetail>(`/ops/protection/sessions/${id}`),
  end: (id: string, reason: string) =>
    fetchJson<{session: unknown}>(`/ops/protection/sessions/${id}/end`,
      {method: 'POST', body: JSON.stringify({reason})}),
  transfer: (id: string, newCpoUserId: string) =>
    fetchJson<{session: unknown; previous_cpo_user_id: string}>(`/ops/protection/sessions/${id}/transfer`,
      {method: 'POST', body: JSON.stringify({new_cpo_user_id: newCpoUserId})}),
};

export function useProtectionSessions(status?: string) {
  return useSWR<{sessions: ProtectionSessionRow[]; server_now: string}>(
    ['protection-sessions', status ?? 'live'],
    () => opsProtectionApi.list(status),
    {refreshInterval: 2000},
  );
}
export function useProtectionSession(id: string | null) {
  return useSWR<ProtectionSessionDetail>(
    id ? ['protection-session', id] : null,
    () => opsProtectionApi.detail(id as string),
    {refreshInterval: 2000},
  );
}

export interface ProtectionEvent {
  id: string;
  seq: string;
  event_type: string;
  actor_role: string;
  prev_status: string | null;
  new_status: string | null;
  comment: string | null;
  created_at: string;
}
export function useProtectionTimeline(id: string | null) {
  return useSWR<{events: ProtectionEvent[]; mission_status: string; protection_status: string}>(
    id ? ['protection-timeline', id] : null,
    () => fetchJson(`/ops/protection/sessions/${id as string}/timeline`),
    {refreshInterval: 3000},
  );
}

/** Incoming protection-date requests must feel instant — mission cadence. */
export function useProMissionRequests() {
  return useSWR<{requests: ProMissionRequestRow[]}>(
    'pro-mission-requests', () => proMgmtApi.requests(), {refreshInterval: POLL_MSN});
}

export function useProOrgs() {
  return useSWR<{orgs: ProOrgRow[]}>('pro-orgs', () => proMgmtApi.listOrgs(), {refreshInterval: POLL_DASH});
}

export function useProPool(from?: string, to?: string) {
  return useSWR<{cpos: ProPoolCpo[]}>(
    ['pro-pool', from ?? 'today', to ?? 'today'],
    () => proMgmtApi.pool(from, to),
    {refreshInterval: POLL_DASH},
  );
}

export function useProAssignments(status?: string) {
  return useSWR<{assignments: ProAssignmentRecord[]}>(
    ['pro-assignments', status ?? 'all'],
    () => proMgmtApi.assignments(status && status !== 'all' ? {status} : undefined),
    {refreshInterval: POLL_DASH},
  );
}

/** New-application cards must feel instant — poll at the mission cadence. */
export function useProApplications(status?: string, limit?: number) {
  return useSWR<{applications: ProApplicationRow[]}>(
    ['pro-applications', status ?? 'all', limit ?? 50],
    () => proAppsApi.list(status, limit),
    {refreshInterval: POLL_MSN},
  );
}

export function useProApplication(id: string | null) {
  // CA-11 — dashboard cadence, not mission cadence: every detail GET runs the
  // server's sweepExpired UPDATE, so a 2s poll was write-amplifying per open
  // tab. The 2s cadence stays on the LIST hook where "instant" matters.
  return useSWR<ProApplicationDetail | null>(
    id ? ['pro-application', id] : null,
    () => (id ? proAppsApi.get(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export interface DepartmentChannelRow {
  id: string;
  name: string;
  department: string | null;
  description: string | null;
  /** SK-06 — hierarchy + policy fields the server already returned. */
  channel_type: 'board' | 'department' | 'incident';
  access: 'standard' | 'read_only' | 'restricted';
  parent_id: string | null;
  level: number;
  member_count: number;
  /** True once an admin device has bootstrapped the channel's E2EE group.
   *  Post content is end-to-end encrypted on the relay, not visible to ops. */
  provisioned: boolean;
  created_at: string;
}

export function useDepartments() {
  return useSWR<DepartmentChannelRow[]>(
    'departments',
    () => opsApi.listDepartments(),
    {refreshInterval: POLL_DASH},
  );
}

export function useJobDetail(id: string | null) {
  return useSWR(
    id ? ['job', id] : null,
    () => (id ? opsApi.getJob(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useMissions(region?: string, status?: 'active' | 'completed', limit?: number) {
  return useSWR<MissionRow[]>(
    ['missions', region ?? 'all', status ?? 'active', limit ?? 0],
    () => opsApi.listMissions(region, status, limit),
    {refreshInterval: POLL_MSN},
  );
}

export function useMissionDetail(id: string | null) {
  return useSWR(
    id ? ['mission', id] : null,
    () => (id ? opsApi.getMission(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

export function useMissionMessages(id: string | null) {
  return useSWR(
    id ? ['mission-messages', id] : null,
    () => (id ? opsApi.listMissionMessages(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

export function useOpsMe() {
  return useSWR<OpsMe>('me', () => opsApi.me(), {revalidateOnFocus: false});
}

export function useAgents(filter?: {status?: string; type?: string; limit?: number}) {
  return useSWR<AgentListRow[]>(
    ['agents', filter?.status ?? 'all', filter?.type ?? 'all', filter?.limit ?? 200],
    () => opsApi.listAgents(filter),
    {refreshInterval: POLL_DASH},
  );
}

export function useAgentDetail(id: string | null) {
  return useSWR<AgentDetail | null>(
    id ? ['agent', id] : null,
    () => (id ? opsApi.getAgent(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useAgentStats(id: string | null) {
  return useSWR<AgentStats | null>(
    id ? ['agent-stats', id] : null,
    () => (id ? opsApi.agentStats(id) : Promise.resolve(null)),
    {refreshInterval: POLL_MSN},
  );
}

// ═══ 2026-07-07 data-coverage audit surfaces (opsDataApi) ════════════
// Read endpoints added by DC-01..DC-20 remediation. Finance / users /
// audit reads are SUPERVISOR+ on the server — pages must handle 403.

export interface DisputeRow {
  id: string; booking_id: string; category: string | null; reason: string | null;
  status: string; to_client_credits: number | null; to_provider_credits: number | null;
  raised_by: string | null; raised_by_name: string | null;
  decided_by: string | null; created_at: string; decided_at: string | null;
  region_code: string; region_label: string; service: string;
  total_eur: string; booking_status: string;
  escrow_status: string | null; gross_credits: number | null; review_required: boolean | null;
}

export interface FinanceTxRow {
  id: string; user_id: string; display_name: string | null; user_role: string | null;
  type: string; status: string; amount_credits: number;
  amount_fiat_cents: number | null; fiat_currency: string | null;
  description: string | null; booking_id: string | null;
  created_at: string; settled_at: string | null;
}

export interface EscrowRow {
  id: string; booking_id: string; status: string; basis: string | null;
  review_required: boolean; gross_credits: number;
  to_provider_credits: number | null; to_client_credits: number | null;
  platform_fee_credits: number | null;
  held_at: string; completed_at: string | null;
  release_eligible_at: string | null; settled_at: string | null;
  client_id: string | null; client_name: string | null;
  provider_user_id: string | null; provider_name: string | null;
  region_code: string; region_label: string; service: string; booking_status: string;
}

export interface PayoutRow {
  id: string; mission_id: string | null; booking_id: string | null;
  agent_user_id: string | null; call_sign: string | null;
  proposed_credits: number | null; paid_credits: number | null;
  deduction_credits: number | null; deduction_reason: string | null;
  decided_by: string | null; decided_at: string | null;
  payee_user_id: string | null; payee_name: string | null;
  mission_short_code: string | null; region_code: string | null; region_label: string | null;
}

export interface InvoiceRow {
  id: string; invoice_number: string; booking_id: string | null; kind: string;
  issued_at: string; currency: string; subtotal_credits: number;
  tax_rate_pct: string | null; tax_credits: number; total_credits: number;
  pdf_url: string | null; region_code: string | null; region_label: string | null;
  service: string | null;
}

export interface PromoRow {
  id: string; code: string; credits: number; max_redemptions: number | null;
  redeemed_count: number; redemptions: number; expires_at: string | null;
  active: boolean; created_at: string;
}

export interface WalletOverview {
  user: {id: string; display_name: string | null; role: string; kyc_status: string; subscription_tier: string};
  balance: {bravo_credits: number; currency: string; updated_at: string | null};
  batches: Array<{id: string; amount_credits: number; consumed_credits: number; issued_at: string; expires_at: string | null; expired_at: string | null}>;
  transactions: FinanceTxRow[];
}

export interface OpsUserRow {
  id: string; display_name: string | null; phone_e164: string | null;
  email: string | null; role: string; subscription_tier: string;
  kyc_status: string; country_code: string | null; home_region: string | null;
  created_at: string; deleted_at: string | null; bravo_credits: number | null;
}

export interface OpsUserDetail {
  user: OpsUserRow & {
    bio: string | null; language: string | null; currency: string | null;
    avatar_url: string | null; pro_active_until: string | null;
    pro_renew_status: string | null; app_lock: boolean | null;
    location_scope: string | null; updated_at: string; password_set_at: string | null;
    suspended_at: string | null; suspended_reason: string | null; suspended_by: string | null;
  };
  devices: Array<{
    id: string; device_id: string; platform: string | null; signal_device_id: number | null;
    created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null;
  }>;
  balance: {bravo_credits: number; currency: string; updated_at: string} | null;
  bookings: Array<{id: string; status: string; region_code: string; service: string; pickup_time: string; total_eur: string; created_at: string}>;
  agent: {user_id: string; type: string; status: string; call_sign: string | null; tier: number; on_duty: boolean} | null;
}

/** SK-07/IS-03 — family memberships around one user, both directions. */
export interface OpsUserFamily {
  owner_of: Array<{
    id: string; member_id: string | null; member_name: string | null; member_email: string | null;
    status: 'pending' | 'active'; relationship: string | null; held_until: string | null;
    spend_limit_credits: number | null; spent_credits: number;
    invited_at: string; accepted_at: string | null;
  }>;
  member_of: Array<{
    id: string; holder_id: string; holder_name: string | null; holder_email: string | null;
    status: 'pending' | 'active'; relationship: string | null; held_until: string | null;
    spend_limit_credits: number | null; spent_credits: number;
    invited_at: string; accepted_at: string | null;
  }>;
}

export interface SosEventRow {
  id: string; mission_id: string | null; booking_id: string | null;
  agent_id: string | null; user_id: string | null;
  agent_call_sign: string | null; reason: string | null; status: string | null;
  lat: number | null; lng: number | null;
  triggered_at: string; acknowledged_at: string | null; acknowledged_by: string | null;
  escalated_at: string | null; escalated_to: string | null;
  resolved_at: string | null; resolved_by: string | null; resolution: string | null;
  mission_short_code: string | null; region_code: string | null; region_label: string | null;
  user_display_name: string | null;
}

export interface VbgMonitoringRow {
  user_id: string; display_name: string | null; phone_e164: string | null;
  home_region: string | null; status: string; interval_min: number;
  enrolled_at: string | null; last_heartbeat_at: string | null;
  missed_count: number; consecutive_fails: number;
  last_zone_state: string | null; escalated_at: string | null;
  lat: number | null; lng: number | null;
  last_lat: number | null; last_lng: number | null; last_telemetry_at: string | null;
  risk_score: number | null; sra_level: string | null; sra_at: string | null;
}

export interface OpsAuditRow {
  id: number; actor_id: string | null; actor_role: string | null;
  actor_call: string | null; action: string;
  subject_type: string | null; subject_id: string | null;
  metadata: Record<string, unknown> | null; ip_address: string | null;
  created_at: string;
}

export interface BroadcastRow {
  id: string; conversation_id: string | null; kind: string;
  title: string | null; body: string | null; severity: string | null;
  subject_type: string | null; subject_id: string | null;
  created_by: string | null; created_at: string;
}

export interface TelemetryPoint {
  agent_id: string; lat: number; lng: number;
  heading_deg: number | null; speed_kph: number | null; accuracy_m: number | null;
  distance_to_dropoff_m: number | null; battery_pct: number | null; recorded_at: string;
}

export interface AnalyticsResponse {
  window_days: number;
  region: string;
  bookings_by_day: Array<{day: string; bookings: number; gmv_bc: string}>;
  bookings_by_status: Array<{status: string; count: number}>;
  dispatch_offers: Array<{status: string; count: number}>;
  missions: {completed: number; aborted: number; avg_duration_s: number; sos_events: number} | null;
  wallet_flows: Array<{type: string; count: number; credits: string}>;
  regions: Array<{region_code: string; bookings: number; gmv_bc: string}>;
  signal_prekeys: {low: number; total_devices: number};
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') p.set(k, String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const opsDataApi = {
  // DC-02 — disputes are finally discoverable (resolve stays on opsApi flow: POST /ops/disputes/:id/resolve).
  listDisputes: (q?: {status?: string; limit?: number}) =>
    fetchJson<DisputeRow[]>(`/ops/disputes${qs({status: q?.status, limit: q?.limit})}`),
  resolveDispute: (id: string, body: {to_client: number; to_provider: number; resolution: string}) =>
    fetchJson<{ok: true}>(`/ops/disputes/${id}/resolve`, {
      method: 'POST', body: JSON.stringify(body),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // DC-01 — finance ledger reads (SUPERVISOR+).
  financeTransactions: (q?: {user_id?: string; type?: string; status?: string; before?: string; limit?: number}) =>
    fetchJson<FinanceTxRow[]>(`/ops/finance/transactions${qs({...q})}`),
  financeEscrows: (q?: {status?: string; limit?: number}) =>
    fetchJson<EscrowRow[]>(`/ops/finance/escrows${qs({status: q?.status, limit: q?.limit})}`),
  financePayouts: (limit?: number) =>
    fetchJson<PayoutRow[]>(`/ops/finance/payouts${qs({limit})}`),
  financeInvoices: (limit?: number) =>
    fetchJson<InvoiceRow[]>(`/ops/finance/invoices${qs({limit})}`),
  financePromos: () => fetchJson<PromoRow[]>(`/ops/finance/promos`),
  financeWallet: (userId: string) =>
    fetchJson<WalletOverview>(`/ops/finance/wallet/${userId}`),

  // DC-04 — user directory (SUPERVISOR+).
  listUsers: (q?: {q?: string; role?: string; kyc?: string; tier?: string; limit?: number}) =>
    fetchJson<OpsUserRow[]>(`/ops/users${qs({...q})}`),
  getUser: (id: string) => fetchJson<OpsUserDetail>(`/ops/users/${id}`),
  getUserFamily: (id: string) => fetchJson<OpsUserFamily>(`/ops/users/${id}/family`),
  revokeUserDevice: (userId: string, deviceRowId: string) =>
    fetchJson<{ok: true; device_row_id: string}>(`/ops/users/${userId}/devices/${deviceRowId}/revoke`, {
      method: 'POST',
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  suspendUser: (userId: string, reason: string) =>
    fetchJson<{ok: true; revoked_sessions: number}>(`/ops/users/${userId}/suspend`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  restoreUser: (userId: string) =>
    fetchJson<{ok: true}>(`/ops/users/${userId}/restore`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  eraseUser: (userId: string, reason: string) =>
    fetchJson<{ok: true; revoked_sessions: number}>(`/ops/users/${userId}/erase`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),

  // M1A/S9 — subscription pricing (charged at charge time: a change here
  // applies to every subscribe/renewal after it) + the user tier editor
  // (comp grants / support fixes; RS-17 NULL expiry = permanent).
  subscriptionPrices: () =>
    fetchJson<{prices: Array<{tier: 'pro' | 'enterprise'; price_bc: number; updated_at: string}>}>(
      `/ops/subscription/prices`),
  setSubscriptionPrice: (tier: 'pro' | 'enterprise', price_bc: number) =>
    fetchJson<{tier: string; price_bc: number}>(`/ops/subscription/prices`, {
      method: 'PATCH', body: JSON.stringify({tier, price_bc}),
    }),
  // Founder 2026-08-26 — every package card's NAME + DESCRIPTION are
  // ops-editable (plan_catalog). Prices stay on the endpoint above: one
  // charge-time source, never a display fork.
  // Founder 2026-08-26 — SERVICE pricing board (transfer/executive rates,
  // factors, add-ons, and the eur_per_bc root). Charged at charge time.
  servicePricing: () =>
    fetchJson<{pricing: Array<{key: string; value: number; default_value: number; updated_at: string | null; min: number; max: number}>}>(
      `/ops/service-pricing`),
  setServicePrice: (key: string, value: number) =>
    fetchJson<{key: string; value: number}>(`/ops/service-pricing`, {
      method: 'PATCH', body: JSON.stringify({key, value}),
    }),
  subscriptionCatalog: () =>
    fetchJson<{catalog: Array<{key: string; display_name: string; description: string; updated_at: string}>}>(
      `/ops/subscription/catalog`),
  setSubscriptionCatalogEntry: (body: {key: string; display_name?: string; description?: string}) =>
    fetchJson<{key: string; display_name: string; description: string}>(`/ops/subscription/catalog`, {
      method: 'PATCH', body: JSON.stringify(body),
    }),
  setUserTier: (userId: string, body: {tier: 'lite' | 'pro' | 'enterprise'; days?: number | null; clear_auto_renew?: boolean}) =>
    fetchJson<{id: string; subscription_tier: string; pro_active_until: string | null}>(
      `/ops/subscription/users/${userId}/tier`, {
        method: 'PATCH', body: JSON.stringify(body),
      }),

  // DC-06 — full SOS log incl. mission-less client/VBG panics.
  listSosEvents: (q?: {status?: 'active' | 'resolved' | 'all'; limit?: number}) =>
    fetchJson<SosEventRow[]>(`/ops/sos${qs({status: q?.status, limit: q?.limit})}`),

  // DC-07 — VBG enrollment health + escalation queue.
  vbgMonitoring: () => fetchJson<VbgMonitoringRow[]>(`/ops/vbg/monitoring`),

  // DC-08 — global audit browser (SUPERVISOR+), keyset-paginated via `before`.
  browseAudit: (q?: {actor_id?: string; action?: string; subject_type?: string; from?: string; to?: string; before?: string; limit?: number}) =>
    fetchJson<OpsAuditRow[]>(`/ops/audit${qs({...q})}`),
  // SK-08 — moved off the shadowed `/ops/audit/org/…` path (see ops-data.controller).
  orgAudit: (orgUserId: string, limit?: number) =>
    fetchJson<Array<{id: string; org_user_id: string; actor_id: string | null; action: string; target_kind: string | null; target_id: string | null; metadata: Record<string, unknown> | null; created_at: string}>>(
      `/ops/audit-log/org/${orgUserId}${qs({limit})}`),

  // DC-16 — post-mission route replay.
  missionTelemetry: (missionId: string) =>
    fetchJson<{mission_id: string; points: TelemetryPoint[]}>(`/ops/missions/${missionId}/telemetry`),

  // DC-20 — broadcast log.
  broadcastsRecent: (q?: {kind?: string; limit?: number}) =>
    fetchJson<BroadcastRow[]>(`/ops/broadcasts/recent${qs({kind: q?.kind, limit: q?.limit})}`),

  // DC-10 — analytics rollups.
  analytics: (q?: {days?: number; region?: string}) =>
    fetchJson<AnalyticsResponse>(`/ops/analytics${qs({days: q?.days, region: q?.region})}`),

  // DC-03 — armed permit decisions (queue rows arrive with armed:true).
  verifyArmed: (id: string) =>
    fetchJson<{ok: true}>(`/ops/armed/${id}/verify`, {
      method: 'POST', idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
  rejectArmed: (id: string, reason: string) =>
    fetchJson<{ok: true}>(`/ops/armed/${id}/reject`, {
      method: 'POST', body: JSON.stringify({reason}),
      idempotencyKey: newIdempotencyKey(),
    } as RequestInit & {idempotencyKey?: string}),
};

export function useDisputes(status?: string) {
  return useSWR<DisputeRow[]>(
    ['disputes', status ?? 'all'],
    () => opsDataApi.listDisputes({status}),
    {refreshInterval: POLL_DASH},
  );
}

export function useFinanceTransactions(f?: {user_id?: string; type?: string; status?: string; limit?: number}) {
  return useSWR<FinanceTxRow[]>(
    ['finance-tx', f?.user_id ?? '', f?.type ?? '', f?.status ?? '', f?.limit ?? 50],
    () => opsDataApi.financeTransactions(f),
    {refreshInterval: POLL_DASH},
  );
}

export function useFinanceEscrows(status?: string) {
  return useSWR<EscrowRow[]>(
    ['finance-escrows', status ?? 'all'],
    () => opsDataApi.financeEscrows({status}),
    {refreshInterval: POLL_DASH},
  );
}

export function useFinancePayouts() {
  return useSWR<PayoutRow[]>('finance-payouts', () => opsDataApi.financePayouts(), {refreshInterval: POLL_DASH});
}

export function useFinanceInvoices() {
  return useSWR<InvoiceRow[]>('finance-invoices', () => opsDataApi.financeInvoices(), {refreshInterval: POLL_DASH});
}

export function useFinancePromos() {
  return useSWR<PromoRow[]>('finance-promos', () => opsDataApi.financePromos(), {refreshInterval: POLL_DASH});
}

export function useWalletOverview(userId: string | null) {
  return useSWR<WalletOverview | null>(
    userId ? ['wallet-overview', userId] : null,
    () => (userId ? opsDataApi.financeWallet(userId) : Promise.resolve(null)),
  );
}

export function useOpsUsers(f?: {q?: string; role?: string; kyc?: string; tier?: string; limit?: number}) {
  return useSWR<OpsUserRow[]>(
    ['ops-users', f?.q ?? '', f?.role ?? '', f?.kyc ?? '', f?.tier ?? '', f?.limit ?? 100],
    () => opsDataApi.listUsers(f),
    {refreshInterval: POLL_DASH},
  );
}

export function useOpsUserDetail(id: string | null) {
  return useSWR<OpsUserDetail | null>(
    id ? ['ops-user', id] : null,
    () => (id ? opsDataApi.getUser(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useUserFamily(id: string | null) {
  return useSWR<OpsUserFamily | null>(
    id ? ['ops-user-family', id] : null,
    () => (id ? opsDataApi.getUserFamily(id) : Promise.resolve(null)),
    {refreshInterval: POLL_DASH},
  );
}

export function useSosEvents(status?: 'active' | 'resolved' | 'all') {
  return useSWR<SosEventRow[]>(
    ['sos-events', status ?? 'all'],
    () => opsDataApi.listSosEvents({status}),
    // OC-01 — SWR's default refreshWhenHidden:false made the SOS bar go blind
    // the moment the tab was backgrounded: a control room running the console
    // behind another window detected nothing. The life-safety poll is the one
    // poll that must keep running while hidden.
    {refreshInterval: POLL_MSN, refreshWhenHidden: true},
  );
}

export function useVbgMonitoring() {
  return useSWR<VbgMonitoringRow[]>('vbg-monitoring', () => opsDataApi.vbgMonitoring(), {refreshInterval: POLL_DASH});
}

export function useAuditBrowse(f?: {actor_id?: string; action?: string; subject_type?: string; from?: string; to?: string; limit?: number}) {
  return useSWR<OpsAuditRow[]>(
    ['audit-browse', f?.actor_id ?? '', f?.action ?? '', f?.subject_type ?? '', f?.from ?? '', f?.to ?? '', f?.limit ?? 100],
    () => opsDataApi.browseAudit(f),
    {refreshInterval: POLL_DASH},
  );
}

export function useBroadcastsRecent(kind?: string) {
  return useSWR<BroadcastRow[]>(
    ['broadcasts-recent', kind ?? 'all'],
    () => opsDataApi.broadcastsRecent({kind}),
    {refreshInterval: POLL_DASH},
  );
}

export function useAnalytics(days?: number, region?: string) {
  return useSWR<AnalyticsResponse>(
    ['analytics', days ?? 30, region ?? 'all'],
    () => opsDataApi.analytics({days, region}),
    {refreshInterval: 60_000},
  );
}

export function useMissionTelemetry(missionId: string | null) {
  return useSWR<{mission_id: string; points: TelemetryPoint[]} | null>(
    missionId ? ['mission-telemetry', missionId] : null,
    () => (missionId ? opsDataApi.missionTelemetry(missionId) : Promise.resolve(null)),
  );
}
