/**
 * API clients — auth service (port 3001) + business API
 */
import type {AxiosError} from 'axios';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {API_BASE_URL} from '@utils/constants';
import {tokenVault} from './tokenVault';
import {supabase} from './supabase';
// vs2 item 4 — the org context stamped on every authed request. That store
// imports nothing but zustand, so this cannot cycle back into the client.
import {activeWorkspaceOrgParam} from '@store/activeWorkspace';
import type {AccountKind, Booking, BookingAddOn, Location, TripItinerary} from '@appTypes/index';

// ─── Auth service (NestJS, port 3001) ────────────────────────────────────────

const authHttp = axios.create({
  baseURL: API_BASE_URL,   // EXPO_PUBLIC_API_BASE_URL → http://10.0.2.2:3001
  timeout: 15_000,
  headers: {'Content-Type': 'application/json'},
});
console.log('[api] baseURL =', API_BASE_URL);

// Attach stored access token to every auth request
/**
 * vs2 item 4 — the value of the org-context header for a request, or null.
 *
 * A pure function, because the rule has two halves that are each easy to get
 * wrong and impossible to see going wrong: send the active workspace, and NEVER
 * overwrite one already on the request. The second is the retry case — a 401
 * refresh replays the original config, and the store may have moved to another
 * workspace since. Re-stamping would land the replay against a different
 * company than the one the user was looking at when they tapped, silently,
 * because the request still succeeds.
 *
 * Returning null (rather than an empty string) when no workspace is selected is
 * also deliberate: an absent header means "use my default", which is what every
 * build before this one did, so an older app and a fresh login behave the same.
 */
export function orgContextHeaderFor(existing: unknown, url?: string): string | null {
  if (typeof existing === 'string' && existing.length > 0) {return null;}
  if (!isOrgScopedPath(url)) {return null;}
  return activeWorkspaceOrgParam()?.orgId ?? null;
}

/**
 * Does this request BELONG to the workspace surface?
 *
 * The first version stamped the header on every authed request, which was
 * wrong in a way that broke a shipping product rather than the new one. The
 * active workspace is sticky — nothing clears it when the user leaves the
 * departmental surface — so an agency owner who once visited a client workspace
 * then carried that org id into the AGENCY product. Two failures followed:
 * manager routes rendered the client workspace's data under agency chrome, and
 * dispatch (which scopes against the provider on the booking, not the header)
 * compared two different orgs and 403'd. The agency's core lane died until
 * sign-out.
 *
 * An allowlist rather than a blocklist: a new route that needs the context opts
 * in, and a route that forgets simply behaves as it did before item 4. The
 * opposite default — everything scoped unless excluded — is how the above
 * happened.
 */
/**
 * The WORKSPACE-SURFACE routes, enumerated. Derived from the actual client
 * paths, not from controller names — the first version was written from prose
 * and got both halves wrong:
 *
 *   - `incident` never matched, because the route is `/incidents`. Every
 *     incident request went unscoped, and the test that "proved" otherwise
 *     asserted an invented `/incident/queue`.
 *   - `org` matched the whole AGENCY product. `/org/summary`, `/org/missions`,
 *     `/org/bookings/:id/crew` and `/org/earnings` all live under that prefix,
 *     so a manager of both an agency and a workspace still carried the
 *     workspace id into agency reads and writes — the exact cross-tenant leak
 *     the allowlist was added to stop, narrowed by one character and no more.
 *
 * Anything not listed behaves exactly as it did before item 4.
 */
export const ORG_SCOPED_PREFIXES = [
  'org/workspace',
  'org/employees',
  // `org/cpos` IS shared: the agency roster uses it, and so do six workspace
  // screens (EmployeesScreen, ShiftEditor, IncidentQueue, DayStatus,
  // ChannelMembers, DepartmentChannels). A shared prefix has to be scoped —
  // the workspace half is the half that breaks without it.
  'org/cpos',
  'org/invites',
  // NOT `org/managers` or `org/hierarchy`: their only callers are
  // ManagerPermissionsScreen and OrgHierarchyScreen, both in AgentNavigator.
  // Allowlisting them sent a workspace id into agency reads AND writes for a
  // company agent who had once opened a client workspace — the same
  // cross-tenant leak this list exists to stop, two entries further down.
  'department',
  'enterprise',
  'attendance',
  'incidents',
] as const;

const ORG_SCOPED_PATH = new RegExp('^/?(' + ORG_SCOPED_PREFIXES.join('|') + ')(/|$)');

function isOrgScopedPath(url?: string): boolean {
  if (!url) {return false;}
  return ORG_SCOPED_PATH.test(url);
}


authHttp.interceptors.request.use(async config => {
  const token = await tokenVault.getAccess();
  if (token) {config.headers.Authorization = `Bearer ${token}`;}
  /**
   * vs2 item 4 — WHICH organisation this request is about.
   *
   * Stamped here rather than per-screen, so a workspace screen cannot forget
   * it — and scoped by `isOrgScopedPath`, so it cannot leak into the agency
   * product. The
   * server treats it as a REQUEST, never a grant: it narrows the caller's real
   * memberships and an org they do not belong to is ignored, so this header can
   * never widen access — it only says which of their own organisations they are
   * looking at.
   *
   * Only sent when a workspace has actually been selected in the hub. Absent is
   * meaningful: it tells the server "use my default", which is exactly what
   * every build before this one did.
   *
   * ⚠️ Stamped at CREATION, not at retry. A request queued before a workspace
   * switch must carry the context it was created with — re-reading the store on
   * a retry would let a 401-refresh replay land against a different company
   * than the one the user was looking at when they tapped.
   */
  const orgCtx = orgContextHeaderFor(config.headers['X-Org-Context'], config.url);
  if (orgCtx) {config.headers['X-Org-Context'] = orgCtx;}
  console.log('[api] →', config.method?.toUpperCase(), (config.baseURL ?? '') + (config.url ?? ''));
  return config;
});
// Single in-flight refresh guard — every 401 that races into the
// interceptor in parallel waits on the same refresh, avoiding a flood
// of /auth/refresh calls when the app wakes up with an expired token.
let refreshInFlight: Promise<void> | null = null;

async function refreshAccessToken(): Promise<void> {
  const refreshToken = await tokenVault.getRefresh();
  if (!refreshToken) {throw new Error('No refresh token');}
  const res = await axios.post<{
    accessToken: string; refreshToken: string; expiresIn: number;
  }>(`${API_BASE_URL}/auth/refresh`, {refreshToken}, {timeout: 15_000});
  await tokenVault.set(res.data.accessToken, res.data.refreshToken);
}

/**
 * Round 2 / Security audit fix: dedup-protected refresh hook for the
 * messenger-service HTTP clients (KeysHttpClient, SenderCertClient,
 * RelayHttpClient, UsersHttpClient). They each accept an optional
 * `refreshToken: () => Promise<void>` constructor option but the
 * `productionRuntime` builder was constructing them WITHOUT passing
 * one — so every 401 inside those clients fell through silently and
 * the user was stuck until they navigated to a screen that uses
 * `fetchWithRefresh`. Exposing the same single-flight chain here lets
 * productionRuntime wire it through to ALL the messenger HTTP paths.
 */
export function refreshAccessTokenShared(): Promise<void> {
  refreshInFlight ??= refreshAccessToken().finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

/**
 * Audit fix 0.8 — surface backend `403 tier_insufficient` to the UI
 * (e.g. an upgrade modal) without coupling axios to react-navigation.
 * Screens subscribe via `onTierInsufficient`; the interceptor fans the
 * event on any 403 whose body has `{code: 'tier_insufficient'}`.
 */
type TierInsufficientHandler = (info: {required_tier?: string; message?: string}) => void;
const tierInsufficientHandlers = new Set<TierInsufficientHandler>();

export function onTierInsufficient(fn: TierInsufficientHandler): () => void {
  tierInsufficientHandlers.add(fn);
  return () => tierInsufficientHandlers.delete(fn);
}

/**
 * LB-API1 — fired ONCE when the interceptor destroys the session because a
 * refresh genuinely failed (revoked/absent refresh token), so the app root can
 * route to a clean re-auth instead of leaving the user on a booking screen with
 * no tokens (where every subsequent call 401s and looks like "the API is down").
 * A transient network/timeout/5xx failure does NOT fire this and does NOT clear
 * tokens — see the interceptor below.
 */
type AuthLostHandler = () => void;
const authLostHandlers = new Set<AuthLostHandler>();
export function onAuthLost(fn: AuthLostHandler): () => void {
  authLostHandlers.add(fn);
  return () => authLostHandlers.delete(fn);
}
function emitAuthLost(): void {
  for (const fn of authLostHandlers) {
    try { fn(); } catch (cbErr) { console.log('[api] authLost handler threw', (cbErr as Error).message); }
  }
}

authHttp.interceptors.response.use(
  r => { console.log('[api] ←', r.status, r.config.url); return r; },
  async (e: AxiosError) => {
    const original = e.config as (typeof e.config & {_retry?: boolean}) | undefined;
    const status   = e.response?.status;
    // Auto-recover from an expired access token: refresh + replay once.
    // Guard against:
    //   - no original config (can't retry)
    //   - second 401 on the same request (the refresh itself is stale → bail)
    //   - 401 ON /auth/refresh (refresh token itself invalid → bail)
    if (
      status === 401 &&
      original &&
      !original._retry &&
      !original.url?.includes('/auth/refresh')
    ) {
      original._retry = true;
      try {
        refreshInFlight ??= refreshAccessToken().finally(() => { refreshInFlight = null; });
        await refreshInFlight;
        const fresh = await tokenVault.getAccess();
        if (fresh && original.headers) {original.headers.Authorization = `Bearer ${fresh}`;}
        console.log('[api] ↻ refreshed + retrying', original.method?.toUpperCase(), original.url);
        return authHttp(original);
      } catch (refreshErr) {
        // LB-API1 — only DESTROY the session on a genuine auth failure (the refresh
        // token is revoked/absent/rejected). A network blip, the 15s timeout, or a
        // 5xx (e.g. a 502 while auth-service redeploys) must NOT wipe a still-valid
        // refresh token — doing so turned a transient outage into a permanent,
        // self-perpetuating logout (every later call then 401s with no token).
        const refreshStatus = axios.isAxiosError(refreshErr) ? refreshErr.response?.status : undefined;
        const noToken = refreshErr instanceof Error && refreshErr.message === 'No refresh token';
        // 401/403 = revoked/invalid refresh; 404 = user_not_found (the account was
        // deleted) — also unrecoverable, so don't leave a zombie session on it.
        const authFailed = noToken || refreshStatus === 401 || refreshStatus === 403 || refreshStatus === 404;
        if (authFailed) {
          console.log('[api] ✗ refresh rejected (auth) — clearing tokens', (refreshErr as Error).message);
          await tokenVault.clear();
          emitAuthLost();
        } else {
          console.log('[api] ✗ refresh failed (transient) — keeping tokens', (refreshErr as Error).message);
        }
      }
    }
    // Audit fix 0.8 — Pro tier paywall hook. Body shape is the NestJS
    // ForbiddenException payload we throw in booking.service:
    //   {code: 'tier_insufficient', required_tier: 'pro', message: '…'}.
    if (status === 403) {
      const body = e.response?.data as {code?: string; required_tier?: string; message?: string} | undefined;
      if (body?.code === 'tier_insufficient') {
        for (const fn of tierInsufficientHandlers) {
          try { fn({required_tier: body.required_tier, message: body.message}); }
          catch (cbErr) { console.log('[api] tier handler threw', (cbErr as Error).message); }
        }
      }
    }
    console.log('[api] ✗', e.code, e.message, 'url:', original?.url, 'resp:', status, e.response?.data);
    return Promise.reject(e);
  },
);

// B-76 — session-loss classifier lives in a pure leaf module so it can be unit
// tested without api.ts's bundle/side-effect import chain. Re-exported here so
// existing `import {isAuthLostError} from '@services/api'` call sites keep working.
export {isAuthLostError} from './authError';

/**
 * Persist / retrieve / clear auth tokens.
 *
 * The public accessor named by the architecture reference (it is the injected
 * `getToken` seam for the messenger runtime). Backed by the hardware keychain
 * since FIX-01 — see `@services/tokenVault`. Never read the underlying storage
 * keys directly; `tokenStorageContract.test.ts` fails the build if you do.
 */
export const tokenStore = {
  get:         (): Promise<string | null> => tokenVault.getAccess(),
  getRefresh:  (): Promise<string | null> => tokenVault.getRefresh(),
  set:         (access: string, refresh: string): Promise<void> => tokenVault.set(access, refresh),
  clear:       (): Promise<void> => tokenVault.clear(),
};

/**
 * Cross-host fetch with the same access-token + 401-refresh semantics
 * as the axios `authHttp` interceptor. Intended for non-axios call
 * sites that target services other than auth-service (e.g. the
 * messenger-service `/webrtc/turn-credentials` and `/sfu/*` endpoints).
 *
 * On a first 401 we drive the SAME `refreshAccessToken` chain that
 * axios uses (deduped via the `refreshInFlight` guard so concurrent
 * callers share one /auth/refresh round-trip), then replay the request
 * once with the fresh token. Any other status — or a second 401 after
 * refresh — surfaces to the caller as the original Response.
 */
export interface FetchWithRefreshInit extends Omit<RequestInit, 'headers'> {
  headers?: Record<string, string>;
}
export async function fetchWithRefresh(
  url: string,
  init: FetchWithRefreshInit = {},
): Promise<Response> {
  const {headers: callerHeaders, ...rest} = init;
  const buildHeaders = async (): Promise<Record<string, string>> => {
    const tok = await tokenVault.getAccess();
    return {
      ...(callerHeaders ?? {}),
      ...(tok ? {Authorization: `Bearer ${tok}`} : {}),
    };
  };
  let res = await fetch(url, {...rest, headers: await buildHeaders()});
  if (res.status !== 401) {return res;}
  // Single in-flight refresh — mirrors axios interceptor's dedupe.
  try {
    refreshInFlight ??= refreshAccessToken().finally(() => { refreshInFlight = null; });
    await refreshInFlight;
  } catch {
    return res; // refresh failed; let caller see the 401
  }
  res = await fetch(url, {...rest, headers: await buildHeaders()});
  return res;
}

/** Generate (once) and persist a random device UUID */
export async function getDeviceId(): Promise<string> {
  let id = await AsyncStorage.getItem('device:id');
  if (!id) {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
    await AsyncStorage.setItem('device:id', id);
  }
  return id;
}

export interface ApiUser {
  id: string;
  email: string;
  display_name: string;
  role: string;
  subscription_tier: string;
  phone_e164: string | null;
  /** ISO timestamp the current paid Pro period runs until (null on Lite). */
  pro_active_until?: string | null;
  /** Profile photo — a base64 data-URI (or null/absent). */
  avatar_url?: string | null;
}

export const authApi = {
  /**
   * Step 1 of registration: duplicate check + Twilio OTP send. Does NOT create
   * the user row — that only happens on registerVerify() after the OTP is
   * approved by Twilio.
   */
  register: async (dto: {
    email: string; password: string; displayName: string;
    phoneE164: string;
  }) => {
    // Why: DTO audit P0-V1 — the server rejects `role`/`subscriptionTier`
    // on the unauthenticated registration surface (forbidNonWhitelisted),
    // so sending them 400s under STRICT_VALIDATION. Role/tier are
    // server-defaulted ('individual'/'lite').
    const res = await authHttp.post<{otpSentTo: string}>('/auth/register', dto);
    return res.data;
  },

  /** Step 2: verify the OTP and create the user atomically. Returns tokens. */
  registerVerify: async (dto: {
    email: string; password: string; displayName: string;
    phoneE164: string;
    code: string; deviceId: string; platform: string;
  }) => {
    const res = await authHttp.post<{
      user: ApiUser; accessToken: string; refreshToken: string; expiresIn: number;
    }>('/auth/register/verify', dto);
    await tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  login: async (dto: {email?: string; phoneE164?: string; password: string}) => {
    const res = await authHttp.post<{
      userId: string | null; otpSentTo: string | null; devOtpCode?: string;
    }>('/auth/login', dto);
    return res.data;
  },

  verify: async (dto: {userId: string; code: string; deviceId: string; platform: string}) => {
    const res = await authHttp.post<{
      user: ApiUser; accessToken: string; refreshToken: string; expiresIn: number;
    }>('/auth/verify', dto);
    await tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  refresh: async () => {
    const refreshToken = await tokenStore.getRefresh();
    if (!refreshToken) {throw new Error('No refresh token');}
    const res = await authHttp.post<{
      accessToken: string; refreshToken: string; expiresIn: number;
    }>('/auth/refresh', {refreshToken});
    await tokenStore.set(res.data.accessToken, res.data.refreshToken);
    return res.data;
  },

  me: async () => {
    // Server-computed app-routing fields (§35A) ride alongside the user; the
    // discriminator is never a client flag or a JWT claim.
    const res = await authHttp.get<{
      user: ApiUser;
      account_kind: AccountKind;
      is_org_manager: boolean;
      // Owner-granted dashboard modules — null for anyone but a promoted
      // manager. Optional so an older server simply yields no filtering.
      permitted_modules?: string[] | null;
      // The org a DELEGATED manager manages (null for the owner, who manages
      // their own). The manager discriminator — account_kind can't be one,
      // since a promoted CPO keeps account_kind='cpo'. Optional so an older
      // server just yields no manager UI rather than breaking the parse.
      managed_org?: {id: string; name: string} | null;
      org: {id: string; name: string} | null;
      must_set_password: boolean;
      membership_status: string | null;
      // Non-null only while membership_status === 'suspended'. Optional so an
      // older server simply yields no reason rather than breaking the parse.
      suspension?: {reason: string | null; until: string | null} | null;
      cpo_needs_onboarding?: boolean; // CPO onboarding gate; optional so old servers default false
      // Scope v2 Phase 6 — owns an Enterprise workspace. Optional so a server
      // that predates the workspace table reads as `false`, never as owning one.
      owns_workspace?: boolean;
      // Founder QA 2026-08-08 — the caller's ORG is an Enterprise WORKSPACE
      // (tenant type), not an agency. Drives vocabulary (Member vs CPO).
      // Optional: an older server reads as false → agency wording, the
      // pre-existing behaviour.
      org_is_workspace?: boolean;
      // Phase B — every enterable workspace affiliation. Optional so an older
      // server yields undefined and the hub falls back to org/owns_workspace.
      workspaces?: Array<{org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'}>;
      // B-417 — ACTIVE agency company account (the direct owner fact for Ops
      // Room key authority). Optional: an older server yields undefined and
      // the predicate's legacy owner arm still admits the un-joined owner.
      owns_agency?: boolean;
      auto_dispatch_enabled?: boolean; // Bug 1: server-driven; optional so old servers default false
    }>('/auth/me');
    return res.data;
  },

  // Self-service profile update — display name and/or avatar (a small base64
  // data-URI, or null to clear). Returns the same {user} shape as /auth/me.
  updateProfile: async (dto: {display_name?: string; avatar_url?: string | null}) => {
    const res = await authHttp.patch<{user: ApiUser}>('/auth/me', dto);
    return res.data;
  },

  // Credential rotation (POST /auth/me/password). Used by the CPO first-login
  // activation (Step 17) to swap the agency-set temp password for the guard's own.
  // ⚠️ The server revokes EVERY live session on success (incl. this one) and returns
  // no new tokens — the caller must re-authenticate with the new password afterwards.
  changePassword: async (dto: {currentPassword: string; newPassword: string}) => {
    const res = await authHttp.post<{ok: true; sessionsRevoked: number}>('/auth/me/password', dto);
    return res.data;
  },

  // B-696 — vault PIN verifier (VAULT_DURABILITY_DESIGN_2026-08-29 §4-§5).
  // The server stores an argon2id hash only; these calls never carry key
  // material, and the local Argon2 gate stays the unlock authority.
  getVaultPinStatus: async () => {
    const res = await authHttp.get<{exists: boolean}>('/auth/vault-pin');
    return res.data;
  },
  setVaultPin: async (dto: {pin: string; currentPin?: string}) => {
    const res = await authHttp.post<{ok: true}>('/auth/vault-pin', dto);
    return res.data;
  },
  verifyVaultPin: async (dto: {pin: string}) => {
    const res = await authHttp.post<{ok: true}>('/auth/vault-pin/verify', dto);
    return res.data;
  },
  requestVaultPinReset: async (dto: {password: string}) => {
    const res = await authHttp.post<{maskedPhone: string}>('/auth/vault-pin/reset/request', dto);
    return res.data;
  },
  verifyVaultPinReset: async (dto: {code: string}) => {
    const res = await authHttp.post<{resetToken: string; expiresIn: number}>('/auth/vault-pin/reset/verify', dto);
    return res.data;
  },
  completeVaultPinReset: async (dto: {resetToken: string; pin: string}) => {
    const res = await authHttp.post<{ok: true}>('/auth/vault-pin/reset/complete', dto);
    return res.data;
  },

  signOut: async (deviceId: string) => {
    try {
      await authHttp.delete('/auth/session', {data: {deviceId}});
    } finally {
      await tokenStore.clear();
    }
  },
};

// Step 25 — user preferences (language / currency / notifications / location-scope /
// app-lock). The server forces the Safety notification category on regardless of input.
export interface UserPreferences {
  language: 'en' | 'ar' | 'bn';
  currency: 'AED' | 'SAR' | 'BDT' | 'GBP' | null;
  notifPrefs: Record<string, boolean>;
  locationScope: 'while_on_duty' | 'during_mission' | 'never';
  appLock: boolean;
  // REGION (#8) — persisted home region; 'N/A' = outside supported coverage, null = unset.
  homeRegion: 'AE' | 'SA' | 'BD' | 'GB' | 'ZA' | 'N/A' | null;
}

export const preferencesApi = {
  get: () => authHttp.get<UserPreferences & {id: string}>('/users/me'),
  patch: (patch: Partial<UserPreferences>) =>
    authHttp.patch<UserPreferences & {id: string}>('/users/me/preferences', patch),
};

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: {'Content-Type': 'application/json'},
});

// Attach Supabase JWT to every request
api.interceptors.request.use(async config => {
  const {data} = await supabase.auth.getSession();
  if (data.session?.access_token) {
    config.headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  return config;
});

// Global error handling
api.interceptors.response.use(
  response => response,
  (error: AxiosError) => {
    if (error.response?.status === 401) {
      void supabase.auth.signOut();
    }
    return Promise.reject(error);
  },
);

// ─── Booking API ─────────────────────────────────────────────────────────────
//
// Routes through `authHttp` (auth-service on port 3001) — the booking module
// now lives inside auth-service and relies on the auth-service JWT for identity.

/** Executive Protection — optional secure-transfer leg attached to an executive booking. */
export interface ExecTransportBody {
  mode: 'one_way' | 'return' | 'both_ways';
  pickup: Location;
  dropoff: Location;
  /** ISO time of the transfer pickup; omitted = same as the booking start. */
  pickup_time?: string;
  passengers: number;
}

export interface BookingCreateBody {
  type: Booking['type'];
  pickup: Location;
  dropoff?: Location;
  start_time: string;
  duration_hours?: number;
  add_ons: string[];
  payment_method: Booking['payment_method'];
  region: string;
  region_label?: string;
  service?: string;
  booking_mode?: 'now' | 'later';
  passengers?: number;
  cpo_count?: number;
  vehicle_count?: number;
  driver_only?: boolean;
  notes?: string;
  /** Issue 28 — optional partner / preferred-provider attribution code. */
  referral_code?: string;
  // Step 22 — lawful-basis consent (required by the server on the auto path).
  location_consent?: boolean;
  terms_accepted?: boolean;
  location_consent_version?: string;
  terms_accepted_version?: string;
  // ─── Executive Protection (service 'executive_protection') ────────────────────────────────────────
  /** What the protection detail is for (site_protection / event_security / …). */
  task_type?: string;
  /** Optional secure-transfer leg; omitted = protection only. */
  exec_transport?: ExecTransportBody;
}

export const bookingApi = {
  create: (data: BookingCreateBody) =>
    authHttp.post<{booking: Booking; client_secret?: string}>('/bookings', data),

  // Step 19 — auto-dispatch request (POST /dispatch/request): creates the booking + starts
  // the matchmaker server-side in one call, so it comes back already DISPATCHING (or
  // NO_PROVIDER if the pool was empty). DARK behind AUTO_DISPATCH_ENABLED — 400s
  // `auto_dispatch_disabled` until cut-over. Idempotency-Key prevents a retry double-create
  // (the server's one-active-booking guard is the backstop). The client must run its own
  // affordability soft-check before calling this (route a short balance to the paywall).
  requestAuto: (data: BookingCreateBody, idempotencyKey: string) =>
    authHttp.post<{booking: Booking}>('/dispatch/request', data, {
      headers: {'Idempotency-Key': idempotencyKey},
    }),

  getById: (id: string) => authHttp.get<Booking>(`/bookings/${id}`),

  // Step 19 — coarse provider reveal for the agency that accepted an auto booking
  // (name/call-sign/★/missions only; no precise location, LB1). 404 `no_provider_yet`
  // while still searching.
  getProvider: (id: string) =>
    authHttp.get<{
      display_name: string | null;
      call_sign: string | null;
      rating: number | null;
      jobs_total: number;
    }>(`/bookings/${id}/provider`),

  list: (params?: {status?: Booking['status']; page?: number}) =>
    authHttp.get<{bookings: Booking[]; total: number}>('/bookings', {params}),

  // `already_ended` — the search finished on its own (NO_PROVIDER / earlier cancel /
  // agency no-show) before the tap landed; the server answers idempotent-success
  // instead of the old FSM 403. Route on `status`, don't assume CANCELLED.
  cancel: (id: string) =>
    authHttp.post<{id: string; status: string; refunded_credits?: number; already_ended?: boolean}>(`/bookings/${id}/cancel`),

  // Step 24 — client rates the agency on a COMPLETED booking. Server is idempotent
  // (one rating per booking) + recomputes agents.rating; a stable key collapses retries.
  submitRating: (id: string, body: {stars: number; tags?: string[]; tip?: number; remarks?: string}) =>
    authHttp.post<{id: string; rating: number; agency_rating: number | null}>(
      `/bookings/${id}/rating`, body, {headers: {'Idempotency-Key': `rate-${id}`}},
    ),

  // Stable per-booking idempotency key — server-side IdempotencyInterceptor
  // (booking.controller.ts) collapses retries onto the cached first
  // response (24h TTL). A network blip auto-retry or a multi-device race
  // therefore cannot double-debit the wallet. Key is `paywc-<bookingId>`
  // so concurrent calls for the SAME booking converge; different bookings
  // (or, in future, a deliberate fresh attempt) get distinct keys.
  //
  // Separator is `-`, NOT `:` — the interceptor's shape gate is
  // /^[A-Za-z0-9_-]{8,128}$/ and a `:` makes it throw
  // `idempotency_key_invalid_shape` (the "PAYMENT FAILED" bug). Booking
  // ids are UUIDs ([0-9a-f-]) so the whole key stays inside the charset.
  payWithCredits: (id: string) =>
    authHttp.post<{booking: Booking}>(
      `/bookings/${id}/pay-with-credits`,
      undefined,
      {headers: {'Idempotency-Key': `paywc-${id}`}},
    ),

  getAddOns: (region: string) =>
    authHttp.get<BookingAddOn[]>('/bookings/add-ons', {params: {region}}),

  // Audit fix 3.1 — live CPO availability per region. Replaces the
  // mobile-side hardcoded REGIONS array. Returned shape is stable so
  // a network failure in the screen falls back gracefully to the
  // static label list.
  regionsAvailability: () =>
    authHttp.get<Array<{
      code: string;
      name: string;
      cpos_available: number;
      cpos_total: number;
      available: boolean;
    }>>('/bookings/regions/availability'),

  estimatePrice: (data: {
    type: Booking['type'];
    /** 'executive_protection' switches the server to the per-unit fixed-block formula —
     *  omitting it on an executive draft quotes the WRONG (Lite) price. */
    service?: string;
    duration_hours?: number;
    add_ons: string[];
    region: string;
    cpo_count?: number;
    vehicle_count?: number;
    driver_only?: boolean;
    /** Drives the driver-only seat cap server-side (mirror of create()). */
    passengers?: number;
    pickup_time?: string;
  }) =>
    authHttp.post<{total: number; breakdown: Record<string, number>}>(
      '/bookings/estimate',
      data,
    ),
  /** Founder 2026-08-26 — live ops-editable service pricing (fail-open mirror). */
  servicePricing: () =>
    authHttp.get<{pricing: Record<string, number>}>('/bookings/service-pricing'),

  // Step 16 — on-arrival identity handshake. The client reads the rotating verify
  // code (+ the assigned lead's name/call-sign) and compares it face-to-face with the
  // code the lead shows from their app. 400 (`no_crew_assigned`) until crew is assigned.
  //
  // FRAUD-2 / P0 — `arrival_code` is the SEPARATE code the principal SHOWS the guard,
  // who types it into their app (agentApi.verifyArrival) to prove presence server-side.
  // Bound to the client's id so the guard cannot self-derive it; rotates on its own
  // window (`arrival_rotates_at`). Distinct from `code`, which is the older symmetric
  // "ask the guard for their code and compare" flow.
  getVerifyCode: (id: string) =>
    authHttp.get<{
      code: string;
      rotates_at: string;
      arrival_code: string;
      arrival_rotates_at: string;
      lead: {display_name: string | null; call_sign: string | null};
    }>(`/bookings/${id}/verify-code`),

  // F1 — the numbered receipt (COMPLETED) / credit note (refunded terminal).
  getInvoice: (id: string) =>
    authHttp.get<InvoiceDto>(`/bookings/${id}/invoice`),

  // Step 16 — panic path: the arriving person is NOT the dispatched guard. Stamps the
  // marker AND raises a booking-scoped SOS (crew + ops alerted). Idempotency-keyed so a
  // frantic double-tap doesn't double-raise. NO "are you sure" gate — it's a panic press.
  notMyGuard: (id: string) =>
    authHttp.post<{ok: true; sos_event_id: string}>(
      `/bookings/${id}/not-my-guard`,
      undefined,
      {headers: {'Idempotency-Key': `nmg-${id}`}},
    ),

  // B-379 — Step-11 client escrow controls (server shipped 2026-07; the client
  // half never did, so money moved on the sweep timer alone).
  /** Hold state + final split. 404s on legacy bookings (no escrow hold). */
  getEscrow: (id: string) =>
    authHttp.get<{
      booking_id: string; status: string; basis: string | null; currency: string;
      gross_credits: number; to_provider_credits: number | null; to_client_credits: number | null;
      platform_fee_credits: number | null; release_eligible_at: string | null; review_required: boolean;
    }>(`/bookings/${id}/escrow`),
  /** Release the escrow to the agency NOW instead of waiting for the sweep. */
  confirmComplete: (id: string) =>
    authHttp.post<{id: string; status: 'RELEASED'; to_provider_credits: number}>(
      `/bookings/${id}/confirm-complete`,
      undefined,
      {headers: {'Idempotency-Key': `confirm-${id}`}},
    ),
  /** Freeze the escrow before the sweep releases it (dispute wins the race). */
  openDispute: (id: string, category: 'not_performed' | 'left_early' | 'wrong_guard' | 'conduct' | 'billing', reason?: string) =>
    authHttp.post<{id: string; status: 'DISPUTED'; dispute_id: string}>(
      `/bookings/${id}/dispute`,
      {category, reason: reason?.trim() || undefined},
      {headers: {'Idempotency-Key': `dispute-${id}`}},
    ),

  // Step 16 — escalate a stranded NO_PROVIDER booking to the safety hotline. Side-channel
  // only (no status change); the fallback block on getById drives the NoDetail UI.
  escalate: (id: string) =>
    authHttp.post<{ok: true; hotline_e164: string}>(
      `/bookings/${id}/escalate`,
      undefined,
      {headers: {'Idempotency-Key': `esc-${id}`}},
    ),
};

// ─── Agent Matching API ──────────────────────────────────────────────────────

// ─── Agent Portal — backs the 9-screen onboarding flow ──────────────────
// Lifecycle: DRAFT → PROFILE_COMPLETE → KYC_PENDING → DOCS_PENDING →
//            SUBMITTED → UNDER_REVIEW → APPROVED → ACTIVE (or REJECTED)

export type AgentPortalStatus =
  | 'DRAFT' | 'PROFILE_COMPLETE' | 'KYC_PENDING' | 'DOCS_PENDING'
  | 'SUBMITTED' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED' | 'ACTIVE';

export type AgentPortalType = 'company' | 'cpo' | 'transport';

export interface AgentPortalState {
  agent: {
    user_id: string;
    type: AgentPortalType;
    status: AgentPortalStatus;
    tier: number;
    call_sign: string | null;
    display_name: string | null;
    rate_aed_per_hour: string | null;
    rating: string | null;
    jobs_total: number;
    duty_hours_mtd: number;
    on_duty: boolean;
    // Bug 3 — dispatch eligibility inputs (region the agency operates in + DPA acceptance time).
    region_code?: string | null;
    dpa_accepted_at?: string | null;
  };
  profile: {
    company: Record<string, unknown>;
    contact: Record<string, unknown>;
    capabilities: string[];
    coverage: {
      countries: Array<{code: string; on: boolean}>;
      services: Array<{key: string; on: boolean}>;
    };
    availability: {mode: string; loadout: string[]};
  };
  kyc: Array<{
    kind: 'gov_id' | 'proof_address' | 'sia_licence' | 'police';
    state: 'queued' | 'running' | 'done' | 'failed';
    subject: string | null;
    file_url?: string | null;
    uploaded_at?: string | null;
  }>;
  documents: Array<{
    id: string;
    slot: 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';
    required: boolean;
    title: string;
    state: 'upload' | 'done' | 'rejected';
  }>;
  review: Array<{
    step: 'submit' | 'docs' | 'kyc' | 'ops' | 'partner';
    state: 'pending' | 'in_progress' | 'done' | 'rejected';
    // Server includes the operator's review note on the `partner` step
    // when a decision is recorded — surfaced on AgentRejectedScreen so
    // the agent can see the actual rejection reason.
    notes?: string | null;
  }>;
  deployment: Array<{
    check_key: 'dress' | 'vehicle' | 'equip' | 'briefing';
    state: 'pending' | 'passed' | 'failed';
  }>;
}

// Shared shape for a per-mission live read consumed by the live tracker. The
// crew-gated agent deployment read (Step 21/29) and the org-scoped manager
// monitor (Step 32) both return this, so the tracker works against either source.
export interface MissionDeploymentResponse {
  checks: Array<{
    check_key: 'dress' | 'vehicle' | 'equip' | 'briefing';
    state: 'pending' | 'passed' | 'failed';
    notes: string | null;
    signed_at: string | null;
  }>;
  mission: {
    short_code: string; status: string; booking_id: string;
    route_distance_m: number | null; route_duration_s: number | null;
    route_polyline: string | null;
    current_lat: number | null; current_lng: number | null;
    // Optional — rotates the tracker's heading cone when the server surfaces it.
    current_heading_deg?: number | null;
    // Step 29 — the principal's last-known GPS (client-ping) for the user marker.
    client_lat: number | null; client_lng: number | null;
    client_recorded_at: string | null;
    comms_channel_id: string | null;
    // Executive Protection — anchors the hourly check-in clock (mission went LIVE).
    pickup_at?: string | null;
    live_at?: string | null;
  } | null;
  crew_role: {
    is_lead: boolean; team_idx: number; role: string; call_sign: string;
    /** B-377 — the officer's own answer; both null = response pending. */
    accepted_at?: string | null; declined_at?: string | null;
  } | null;
  dress_instructions: string | null;
  dress_acknowledged_at: string | null;
  waypoints: Array<{
    seq: number; tag: string; event: string; state: string;
    settled_at: string | null; marked_via: string | null;
  }>;
  booking: {
    pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
    dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
    booking_status: string; client_name: string | null;
    // Executive Protection — product/task/block/brief so the CPO can run the detail.
    service?: string; task_type?: string | null; duration_hours?: number;
    notes?: string | null;
    exec_transport?: ExecTransportBody | null;
  } | null;
  crew: Array<{call_sign: string | null; role: string; team_idx: number; is_lead: boolean; is_me: boolean}>;
  /** Executive Protection — hourly "all smooth" confirmations (empty on non-executive). */
  hourly_checkins?: Array<{
    hour_index: number; status: string; comment: string | null; created_at: string;
  }>;
}

export const orgInviteApi = {
  /** Issue 34 — join a provider's roster with an invitation code. */
  redeem: (code: string) =>
    authHttp.post<{org_user_id: string; member_role: string}>('/org/invites/redeem', {code}),
};

export const agentApi = {
  // 01 · Profile creation
  create: (type: AgentPortalType, display_name?: string) =>
    authHttp.post('/agents', {type, display_name}),

  getMe: () => authHttp.get<AgentPortalState>('/agents/me'),

  // 02 · Registration wizard
  updateCompany: (
    dto: {
      legal_name?: string; company_number?: string; regulator?: string;
      established?: string; primary_contact?: string; primary_email?: string;
      primary_phone?: string; capabilities?: string[];
    },
  ) => authHttp.patch('/agents/me/company', dto),

  // 03 · KYC
  startKyc: () => authHttp.post('/agents/me/kyc/start'),

  // 03b · Agent attaches supporting evidence for a KYC slot.
  uploadKycDoc: (
    kind: 'gov_id' | 'proof_address' | 'sia_licence' | 'police',
    dto: {file_url: string; subject?: string; file_hash_sha256?: string},
  ) => authHttp.post(`/agents/me/kyc/${kind}/upload`, dto),

  // 03c · Skip the standalone KYC screen — auto-settles all 4 KYC
  // checks and mirrors any uploads into the compliance pack. Idempotent.
  skipKyc: () => authHttp.post('/agents/me/kyc/skip'),

  // Generic file upload — POSTs the file as multipart/form-data and
  // returns the absolute URL where ops-console can render it.
  uploadFile: async (file: {uri: string; name: string; type?: string}): Promise<string> => {
    const fd = new FormData();
    fd.append('file', {
      uri:  file.uri,
      name: file.name,
      type: file.type ?? 'application/octet-stream',
    } as unknown as Blob);
    const res = await authHttp.post<{file_url: string}>('/agents/me/upload', fd, {
      headers: {'Content-Type': 'multipart/form-data'},
    });
    return res.data.file_url;
  },

  // 04 · Coverage
  updateCoverage: (dto: {
    countries: Array<{code: string; on: boolean}>;
    services: Array<{key: string; on: boolean}>;
  }) => authHttp.patch('/agents/me/coverage', dto),

  // 05 · Availability
  updateAvailability: (dto: {mode: string; loadout: string[]}) =>
    authHttp.patch('/agents/me/availability', dto),

  // 06 · Documents
  uploadDoc: (dto: {
    slot: 'sia' | 'passport' | 'insurance' | 'dbs' | 'firstaid' | 'cv';
    title: string; file_url: string; file_hash_sha256?: string;
  }) => authHttp.post('/agents/me/documents', dto),

  submit: () => authHttp.post('/agents/me/submit'),

  // Bug 3 · operating region + DPA acceptance (dispatch-eligibility inputs, company agents only).
  setAgencyProfile: (dto: {region_code: string; dpa_accepted: boolean; dpa_version?: string}) =>
    authHttp.patch<{region_code: string | null; dpa_accepted_at: string | null}>('/agents/me/agency-profile', dto),

  // C-4 — the admin review + stats routes were REMOVED server-side (review moved
  // to /ops/agents/:id/decide; stats was a self-inflation hole). Their client
  // functions were deleted with them: a future caller would raw-404 (B-376 class).

  // 08 · Dashboard mutations
  setDuty:        (on_duty: boolean) => authHttp.patch('/agents/me/duty', {on_duty}),
  updateLocation: (
    lat: number, lng: number,
    quality?: {accuracy_m?: number; speed_kph?: number; is_mocked?: boolean},
  ) => authHttp.patch('/agents/me/location', {lat, lng, ...quality}),

  // Published jobs the agent can see and apply for.
  getAvailableJobs: () =>
    authHttp.get<{jobs: Array<{
      id: string; short_code: string; status: string; region_code: string;
      route_label: string; dispatch_at: string; duration_hours: number;
      cpo_slots: number; slots_filled: number;
      service: string;
      pickup_lat: string | null; pickup_lng: string | null;
      dropoff_lat: string | null; dropoff_lng: string | null;
      applied: boolean;
      application_status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN' | null;
    }>}>('/agents/me/available-jobs'),

  // Job Portal browse (company agents only, LB1 coarse cards). Omit region (or
  // pass 'ALL') for every supported region.
  getOpenJobs: (region?: string) =>
    authHttp.get<{jobs: OpenJobDto[]}>('/agents/me/open-jobs',
      region && region !== 'ALL' ? {params: {region}} : undefined),

  // Job Portal pull-claim (JOB_PORTAL_MARKETPLACE_SPEC §2) — first agency to tap wins;
  // a 409 means the job was taken/withdrawn in the race (refresh the feed, never retry
  // blind). Why the key carries a per-tap nonce: a booking can legitimately become
  // claimable AGAIN (claim → withdraw → relist), and a static `claim-<id>` key would
  // replay the first claim's cached success for 24h — a false "accepted" masking the
  // real provider_excluded 409. One key per user intent, not per booking.
  claimOpenJob: (bookingId: string) =>
    authHttp.post<{offer_id: string; booking_id: string; status: 'CONFIRMED'}>(
      `/dispatch/open-jobs/${bookingId}/claim`, undefined,
      {headers: {'Idempotency-Key': `claim-${bookingId}-${Date.now()}`}},
    ),

  applyToJob: (jobId: string, dressPledge: string) =>
    authHttp.post<{application: {id: string; status: string; applied_at: string}}>(
      `/agents/me/jobs/${jobId}/apply`, {dress_pledge: dressPledge},
      // Stable per-job key — a network blip auto-retry returns the
      // cached first response rather than bumping `dress_pledged_at`.
      {headers: {'Idempotency-Key': `apply-${jobId}`}},
    ),

  withdrawApplication: (jobId: string) =>
    authHttp.post<{ok: true}>(`/agents/me/jobs/${jobId}/withdraw`, {},
      {headers: {'Idempotency-Key': `withdraw-${jobId}`}}),

  // Mission post-mortem the Earnings screen taps into. Server gates this
  // on a real mission_payouts row for (booking, agent), so 404 == "you
  // never crewed this booking" rather than "this booking doesn't exist".
  getPayoutSummary: (bookingId: string) =>
    authHttp.get<{
      mission: {
        id: string; short_code: string; status: string;
        started_at: string | null; ended_at: string | null;
        route_distance_m: number | null; route_duration_s: number | null;
      };
      booking: {
        id: string; pickup_address: string; dropoff_address: string | null;
        pickup_time: string; service: string; region_label: string;
        total_eur: string; total_aed: string; cpo_count: number;
      };
      payout: {
        paid_credits: number; proposed_credits: number;
        deduction_credits: number; deduction_reason: string | null;
        decided_at: string;
      };
    }>(`/agents/me/payouts/${bookingId}/summary`),

  getMyApplications: () =>
    authHttp.get<{applications: Array<{
      id: string; status: 'PENDING' | 'SHORTLISTED' | 'ASSIGNED' | 'REJECTED' | 'WITHDRAWN';
      applied_at: string;
      job_id: string; short_code: string; route_label: string;
      dispatch_at: string; duration_hours: number; cpo_slots: number;
      slots_filled: number; job_status: string;
    }>}>('/agents/me/applications'),

  // Mission deployment checks for the agent (polled on deployment screen).
  getMissionDeployment: (missionId: string) =>
    authHttp.get<MissionDeploymentResponse>(`/agents/me/missions/${missionId}/deployment`),

  acknowledgeDress: (missionId: string) =>
    authHttp.post<{ok: true; acknowledged_at: string}>(
      `/agents/me/missions/${missionId}/dress-acknowledge`,
      undefined,
      {headers: {'Idempotency-Key': `dress-${missionId}`}},
    ),

  // LM-C2 — self-acknowledge one deploy check (dress/vehicle/equip/briefing).
  // All four gate the lead's Start server-side.
  acknowledgeDeployCheck: (missionId: string, checkKey: string) =>
    authHttp.post<{ok: true}>(
      `/agents/me/missions/${missionId}/checks/${encodeURIComponent(checkKey)}/acknowledge`,
      undefined,
      {headers: {'Idempotency-Key': `check-${missionId}-${checkKey}`}},
    ),

  // LM-C4 — any crew member marks themselves in position (not just the lead).
  crewCheckIn: (missionId: string) =>
    authHttp.post<{ok: true; checked_in_at: string}>(
      `/agents/me/missions/${missionId}/check-in`,
      undefined,
      {headers: {'Idempotency-Key': `checkin-${missionId}`}},
    ),

  // Executive Protection — the lead confirms an elapsed hour ("all smooth" + optional
  // comment). Idempotent per (mission, hour): a re-tap adopts the server row.
  hourlyCheckin: (missionId: string, hourIndex: number, comment?: string) =>
    authHttp.post<{ok: true; hour_index: number; status: string; created_at: string}>(
      `/agents/me/missions/${missionId}/hourly-checkin`,
      {hour_index: hourIndex, comment: comment?.trim() || undefined},
      {headers: {'Idempotency-Key': `hourly-${missionId}-${hourIndex}`}},
    ),

  // B-377 (Issue 41) — the assigned officer accepts or declines the assignment.
  // Idempotency-keyed: a double-tap collapses; first write wins server-side.
  respondToMission: (missionId: string, action: 'accept' | 'decline', reason?: string) =>
    authHttp.post<{ok: true; accepted: boolean}>(
      `/agents/me/missions/${missionId}/respond`,
      {action, reason: reason?.trim() || undefined},
      {headers: {'Idempotency-Key': `respond-${missionId}-${action}`}},
    ),

  // LM-C7 — ask the agency to close the mission when the lead is unreachable.
  requestComplete: (missionId: string) =>
    authHttp.post<{ok: true}>(
      `/agents/me/missions/${missionId}/request-complete`,
      undefined,
      {headers: {'Idempotency-Key': `reqcomplete-${missionId}-${Math.floor(Date.now() / 60_000)}`}},
    ),

  // Lead-CPO mission FSM transitions. Idempotency-Key collapses retries
  // onto the cached server response so a network blip + auto-retry
  // doesn't double-fire side effects. LM-C3 — each may carry the device fix
  // for the server's geofence warning (never blocks).
  missionPickup: (missionId: string, fix?: {lat?: number; lng?: number}) =>
    authHttp.post<{ok: true}>(`/agents/me/missions/${missionId}/pickup`, fix ?? {},
      {headers: {'Idempotency-Key': `pickup-${missionId}`}}),
  missionGoLive: (missionId: string, fix?: {lat?: number; lng?: number}) =>
    authHttp.post<{ok: true}>(`/agents/me/missions/${missionId}/go-live`, fix ?? {},
      {headers: {'Idempotency-Key': `golive-${missionId}`}}),
  missionComplete: (missionId: string, fix?: {lat?: number; lng?: number}) =>
    // B-76 — Finish runs the escrow proof-gate + settle server-side (a longer
    // round-trip than start/go-live). Give it 30s so a slow-but-succeeding
    // settle doesn't trip the default 15s timeout and surface a "lost-200"
    // error for a mission that actually completed.
    authHttp.post<{ok: true}>(`/agents/me/missions/${missionId}/complete`, fix ?? {},
      {headers: {'Idempotency-Key': `complete-${missionId}`}, timeout: 30_000}),

  // Step 16 — the assigned lead reads the SAME rotating verify code the client sees, to
  // confirm identity at handover. Lead-only (non-lead / non-member is rejected). The
  // lead's "Arrived" confirm is missionPickup above (DISPATCHED → PICKUP).
  missionVerifyCode: (missionId: string) =>
    authHttp.get<{code: string; rotates_at: string}>(
      `/agents/me/missions/${missionId}/verify-code`),

  // FRAUD-2 / P0 — the assigned lead ENTERS the arrival code the principal's screen
  // shows, proving physical presence. Server checks it against a client-bound HMAC the
  // lead cannot self-derive, then stamps missions.identity_verified_at (which the
  // proof-of-completion gate requires before escrow may auto-release, once the flag is
  // on). Lead-only; idempotent (a re-submit after a verified handshake is a no-op
  // success). 400 `verify_code_mismatch` on a wrong code, `lead_only` for non-leads.
  verifyArrival: (missionId: string, code: string) =>
    authHttp.post<{verified: boolean; rotates_at: string}>(
      `/agents/me/missions/${missionId}/verify-arrival`, {code}),

  // CPO panic button. The reason is bounded server-side to 200 chars.
  raiseSos: (missionId: string, body: {reason: string; lat?: number; lng?: number}) =>
    authHttp.post<{ok: true; sos_event_id: string}>(
      `/agents/me/missions/${missionId}/sos`,
      body,
      // Bucket the idempotency key to a 60s window so a deliberate
      // second SOS minutes later DOES fire — but a frantic multi-tap
      // collapses to one row.
      {headers: {'Idempotency-Key': `sos-${missionId}-${Math.floor(Date.now() / 60_000)}`}},
    ),

  // The mission this agent is currently crewed on (DISPATCHED/PICKUP/LIVE/SOS),
  // or null. Used by the dashboard "Next on Ops" card.
  getActiveMission: () =>
    authHttp.get<null | {
      mission_id: string; short_code: string; status: string;
      is_lead: boolean; role: string;
      pickup_address: string; dropoff_address: string | null;
      pickup_time: string; region_label: string | null;
      // FRAUD-2 / P0 — whether the arrival handshake is already stamped.
      identity_verified: boolean;
    }>('/agents/me/active-mission'),

  // Completed/aborted mission history (newest first), each row carrying the
  // agent's own payout if one was settled. Powers the "My Missions" list.
  getMissionHistory: () =>
    authHttp.get<Array<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean;
      started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null; deduction_credits: number | null;
    }>>('/agents/me/missions'),

  // Detail view for one job — used by JobDetailScreen.
  getJob: (jobId: string) =>
    authHttp.get<{
      job: {
        id: string; booking_id: string; short_code: string; status: string;
        region_code: string; route_label: string; dispatch_at: string;
        duration_hours: number; cpo_slots: number; slots_filled: number;
        published_at: string;
      };
      booking: {
        pickup_address: string; pickup_lat: string | null; pickup_lng: string | null;
        dropoff_address: string | null; dropoff_lat: string | null; dropoff_lng: string | null;
        pickup_time: string; total_eur: string; total_aed: string;
        cpo_count: number; vehicle_count: number; driver_only: boolean;
        passengers: number; add_ons: unknown; notes: string | null;
        service: string; region_label: string; dress_instructions: string | null;
      } | null;
      application: {id: string; status: string; applied_at: string} | null;
    }>(`/agents/me/jobs/${jobId}`),

  // Mission lead — mark a manual waypoint.
  markWaypoint: (missionId: string, tag: 'DISPATCH' | 'RECON' | 'PICKUP' | 'DROPOFF') =>
    authHttp.post<{
      ok: true; tag: string; seq: number; settled_at: string;
      auto_marks: string[];
    }>(`/agents/me/missions/${missionId}/waypoints/mark`, {tag},
      {headers: {'Idempotency-Key': `wp-${missionId}-${tag}`}}),

  // Mission lead — push GPS telemetry. Backend auto-fires CHKPT 01/02.
  pushTelemetry: (missionId: string, sample: {
    lat: number; lng: number;
    heading_deg?: number; speed_kph?: number;
    accuracy_m?: number; battery_pct?: number;
  }) =>
    authHttp.post<{
      ok: true; auto_marks: string[];
      distance_to_dropoff_m: number | null;
      progress_pct: number | null;
    }>(`/agents/me/missions/${missionId}/telemetry`, sample),

  // Deployment sign-off moved server-side to `OpsController` under
  // AdminGuard. Mobile agents don't sign their own checks — ops does, via
  // the ops console. No agent-facing route remains here.
};

// ─── Org API (NestJS /org/*, OrgManagerGuard-gated) ──────────────────────────
// Service-provider managers manage their own CPO roster. Every route resolves
// the caller's org server-side from org_members — no org id is sent from here.

export interface RosterMember {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  call_sign: string | null;
  member_role: 'cpo' | 'manager' | 'employee';
  status: 'invited' | 'active' | 'suspended' | 'removed';
  /** Branch (org_members.department) — NULL = unassigned. Groups the A7.3
   *  batch picker; the PDF's "team" maps to this (no team entity exists). */
  department: string | null;
  agent_status: string | null;
  missions_completed: number;
  created_at: string;
  // LM-A4/F11 — server-truth availability for the assign sheet + roster.
  on_duty: boolean;
  on_mission: boolean;
  armed_authorized: boolean;
  avatar_url: string | null;
  // Suspension window. While status==='suspended', a null suspended_until
  // means indefinite; otherwise it auto-expires and the member reinstates.
  suspended_from: string | null;
  suspended_until: string | null;
  suspend_reason: string | null;
}

/** One node of the org chart (owner / manager / cpo / employee). */
export interface OrgHierarchyNode {
  user_id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  position: 'Owner' | 'Manager' | 'CPO' | 'Employee';
  status: string;
  call_sign: string | null;
  // The member's DUTY toggle (B-203) — the org-chart dot is green iff on duty,
  // NOT merely app-connected.
  on_duty: boolean;
}

export interface OrgHierarchy {
  owner: OrgHierarchyNode;
  managers: OrgHierarchyNode[];
  members: OrgHierarchyNode[];
}

export interface OrgMemberProfile {
  member_user_id: string;
  display_name: string | null;
  email: string | null;
  phone_e164: string | null;
  avatar_url: string | null;
  call_sign: string | null;
  member_role: 'cpo' | 'manager' | 'employee' | 'owner';
  status: 'invited' | 'active' | 'suspended' | 'removed';
  agent_status: string | null;
  /** Issue 39 — null until the CPO has been rated at least once. */
  rating?: number | null;
  /** Issue 39 — capability tokens, incl. the `medical_<level>` one (Issue 36). */
  capabilities?: string[];
  armed_authorized: boolean;
  /** Issue 39 — soonest expiry across live armed permits. null = none recorded,
   *  which must NOT be rendered as expired. */
  armed_expires_at?: string | null;
  /** Issue 39 — the compliance pack with validity windows, so a lapsed
   *  certificate is visible instead of a bare capability tag. */
  qualifications?: Array<{
    slot: string;
    title: string;
    state: string;
    expires_at: string | null;
    issuing_body: string | null;
  }>;
  on_duty: boolean;
  on_mission: boolean;
  created_at: string;
  suspended_from: string | null;
  suspended_until: string | null;
  suspend_reason: string | null;
  suspended_by_name: string | null;
  stats: {
    missions_total: number;
    missions_completed: number;
    missions_aborted: number;
    missions_led: number;
    total_distance_m: number;
    total_duration_s: number;
    credits_earned: number;
  };
}

export interface OrgManagerDto {
  user_id: string; display_name: string | null; email: string | null;
  avatar_url: string | null; call_sign: string | null; status: string;
  permitted_modules: string[];
}

export const orgApi = {
  listCpos: () => authHttp.get<RosterMember[]>('/org/cpos'),

  /**
   * vs2 item 17b — which modules this workspace hides from its home screen.
   *
   * MEMBER-readable; the PATCH is manager-only server-side. The response echoes
   * `orgUserId` so the client can key on the org the SERVER resolved rather than
   * on the id it asked with — the request param is undefined on most paths.
   */
  workspaceSettings: () =>
    // PDF checklist line 9 — `levelNames` rides the SAME response, so a screen
    // that already loads settings gets the tier vocabulary for free. Optional:
    // an older server omits it, and the resolver reads absent as "use the
    // built-ins", which is exactly today's behaviour.
    authHttp.get<{orgUserId: string | null; hiddenModules: string[]; levelNames?: string[]}>(
      '/org/workspace/settings'),
  setWorkspaceSettings: (hiddenModules: string[]) =>
    authHttp.patch<{orgUserId: string; hiddenModules: string[]; levelNames?: string[]}>(
      '/org/workspace/settings', {hiddenModules}),
  /**
   * Its OWN route, not another field on the PATCH above. That one replaces the
   * WHOLE hidden-module set, so renaming a tier through it would force the
   * caller to resend the module set — and an app that forgot would silently
   * un-hide every hidden module.
   */
  setWorkspaceLevelNames: (levelNames: string[]) =>
    authHttp.patch<{orgUserId: string; hiddenModules: string[]; levelNames: string[]}>(
      '/org/workspace/settings/level-names', {levelNames}),

  /** Owner's "Manager Permissions" screen — every manager + granted modules. */
  listManagers: () => authHttp.get<OrgManagerDto[]>('/org/managers'),
  /** Owner-only (enforced server-side) — replaces the full granted-module set. */
  setManagerPermissions: (memberUserId: string, modules: string[]) =>
    authHttp.patch<{ok: true; permitted_modules: string[]}>(
      `/org/managers/${memberUserId}/permissions`, {modules},
    ),

  /** M1A rule 16 — enroll an EXISTING app user as an org 'employee'
   *  (Enterprise workspace: dept channels + attendance + incidents; never a
   *  deployable CPO and never changes the member's own app shell). */
  addEmployee: (emailOrPhone: string) =>
    authHttp.post<RosterMember>('/org/employees', {email_or_phone: emailOrPhone}),

  createCpo: (dto: {
    display_name: string; email: string; phone_e164: string;
    temp_password: string; call_sign?: string; member_role?: 'cpo' | 'manager';
  }) => authHttp.post<RosterMember>('/org/cpos', dto),

  // Suspending requires a reason (the CPO is shown it at login) and optionally a
  // window; omitting suspended_until means indefinite. The server rejects an
  // empty reason and refuses outright while the member is on a live mission.
  setCpoStatus: (
    memberUserId: string,
    status: 'active' | 'suspended' | 'removed',
    window?: {suspended_from?: string; suspended_until?: string | null; suspend_reason?: string},
  ) =>
    // B-417 — stranded_room_claims: Ops Rooms whose crypto claim (B-416) this
    // member holds; suspending/removing them pauses key delivery there.
    // Optional so an older server parses fine.
    authHttp.patch<{ok: true; member_user_id: string; status: string; stranded_room_claims?: string[]}>(
      `/org/cpos/${memberUserId}/status`, {status, ...window}),

  getMemberProfile: (memberUserId: string) =>
    authHttp.get<OrgMemberProfile>(`/org/cpos/${memberUserId}/profile`),

  getOrgHierarchy: () => authHttp.get<OrgHierarchy>('/org/hierarchy'),

  // RS-10 — promote/demote a roster member (owner-only, server-enforced).
  // Q7 — 'employee' is the workspace demote target (employee ⇄ manager);
  // agencies keep cpo ⇄ manager. The server refuses cpo ⇄ employee.
  setCpoRole: (memberUserId: string, member_role: 'cpo' | 'manager' | 'employee') =>
    authHttp.patch<{ok: true; member_user_id: string; member_role: 'cpo' | 'manager' | 'employee'; stranded_room_claims?: string[]}>(
      `/org/cpos/${memberUserId}/role`, {member_role}),

  // Step 13 — the agency mission board (jobs grouped needs-crew / active / recent).
  listMissions: () =>
    authHttp.get<{
      needs_crew: OrgMissionDto[]; active: OrgMissionDto[]; recent: OrgMissionDto[];
    }>('/org/missions'),

  // Step 32 — one mission's live positions (CPO leader + principal) for the org
  // desk monitor. Same shape as the crew-gated agent read so the tracker reuses it.
  getMissionLive: (missionId: string) =>
    authHttp.get<MissionDeploymentResponse>(`/org/missions/${missionId}/live`),

  // JOB_PORTAL_MARKETPLACE_SPEC §3 — hand an accepted-but-uncrewed booking back to the
  // Job Portal (pre-crew only; 409 crew_already_assigned once a mission exists). The
  // client keeps their escrow hold — the next accepting agency takes it over. Per-tap
  // nonce for the same reason as claimOpenJob (the booking can be re-accepted later).
  withdrawBooking: (bookingId: string, reason?: string) =>
    authHttp.post<{booking_id: string; status: 'DISPATCHING'}>(
      `/dispatch/bookings/${bookingId}/withdraw`, {reason},
      {headers: {'Idempotency-Key': `withdraw-bk-${bookingId}-${Date.now()}`}},
    ),

  // Step 13 — crew a CONFIRMED booking (pick guards + a leader → creates the mission).
  // Idempotency-Key collapses a double-confirm onto one mission (server-enforced).
  assignCrew: (bookingId: string, body: {cpo_user_ids: string[]; lead_user_id: string}) =>
    authHttp.post<{ok: true; mission_id: string; short_code: string; crew: number; lead_user_id: string}>(
      `/org/bookings/${bookingId}/crew`, body,
      {headers: {'Idempotency-Key': `crew-${bookingId}`}},
    ),

  // Step 20 — capacity summary for the dashboard "X of Y guards free" strip.
  getSummary: () =>
    authHttp.get<{
      guards_total: number;
      guards_free: number;
      guards_on_duty: number;
      active_missions: number;
      // The ORG's headline KPIs — served here rather than read off /agents/me,
      // which is a SELF endpoint and gave a manager their own numbers.
      org_rating: number | null;
      org_jobs_total: number;
    }>('/org/summary'),

  // MISSION-HISTORY (#3) — a roster CPO's completed/aborted-mission call-log
  // (org-scoped + IDOR-gated server-side).
  listMemberMissions: (memberUserId: string) =>
    authHttp.get<Array<{
      mission_id: string; booking_id: string; short_code: string; status: string;
      role: string; is_lead: boolean; started_at: string | null; ended_at: string | null;
      route_distance_m: number | null; route_duration_s: number | null;
      pickup_address: string; dropoff_address: string | null; region_label: string | null;
      paid_credits: number | null;
    }>>(`/org/cpos/${memberUserId}/missions`),

  // MISSION-HISTORY (#3) — the agency's all-completed-missions list + total count.
  listCompletedMissions: () =>
    authHttp.get<{completed_count: number; missions: OrgMissionDto[]}>('/org/missions/completed'),

  // SP-MISSION-DETAIL (#2nd) — the agency's escrow view for a booking it owns
  // (payout + hold status only; null = legacy booking with no hold).
  getMissionEscrow: (bookingId: string) =>
    authHttp.get<{
      status: string; basis: string | null; currency: string | null;
      gross_credits: number; to_provider_credits: number | null; platform_fee_credits: number | null;
    } | null>(`/org/bookings/${bookingId}/escrow`),

  // LM-C7 — the agency confirms completion when the lead can't (crew requested
  // it / lead phone died). Same money-safe path as the lead Finish.
  completeMission: (missionId: string) =>
    authHttp.post<{ok: true; completed: boolean}>(
      `/org/missions/${missionId}/complete`, undefined,
      {headers: {'Idempotency-Key': `orgcomplete-${missionId}`}},
    ),

  // F6 — the agency earnings roll-up (totals + per-mission escrow splits).
  getEarnings: () =>
    authHttp.get<{
      total_missions: number;
      total_gross_credits: number;
      total_fee_credits: number;
      total_net_credits: number;
      pending_credits: number;
      rows: Array<{
        booking_id: string; short_code: string | null; service: string;
        region_label: string; ended_at: string | null; hold_status: string;
        gross_credits: number; platform_fee_credits: number | null; to_provider_credits: number | null;
      }>;
    }>('/org/earnings'),
};

// F1 — numbered, line-itemised receipt / credit note.
export interface InvoiceDto {
  id: string;
  invoice_number: string;
  booking_id: string;
  kind: 'client_receipt' | 'credit_note';
  issued_at: string;
  currency: string;
  line_items: Array<{label: string; per_hour: number | null; hours: number | null; amount_credits: number}>;
  subtotal_credits: number;
  tax_rate_pct: number;
  tax_credits: number;
  total_credits: number;
  booking: {
    service: string; region_label: string; pickup_time: string;
    pickup_address: string; dropoff_address: string | null;
    cpo_count: number; duration_hours: number;
  };
}

// ─── Auto-dispatch offer card (agency-facing, Step 20) ───────────────────────
// CoarseOfferDto (LB1): the agency's single live OFFERED offer joined with COARSE
// booking data — region + bucketed distance + when/price/headcount/requirements, and
// crucially the server `expires_at` (the countdown MUST bind to this, not a 0-start
// local timer). NO exact pickup/dropoff coord or address pre-accept.
export interface CoarseOffer {
  offer_id: string;
  expires_at: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;
  duration_hours: number;
  distance_bucket: string; // '<2km' | '2-5km' | '5-10km' | '>10km' | 'unknown'
  cpo_count: number;
  vehicle_count: number;
  price: {eur: string; aed: string};
  requirements: {armed: boolean; driver_only: boolean; add_ons: string[]; flags: Record<string, boolean>};
  /** Executive Protection — what the detail is for + whether a transfer leg exists
   *  (still no location/identity pre-accept). Null on non-executive offers. */
  task_type?: string | null;
  has_transport?: boolean;
}

// Testing affordance — provider region browse of open jobs. LB1 coarse-only:
// region, truncated pickup area (zone), time window, service, cpo_count, armed
// flag, price — never exact coords, full addresses, or client identity pre-accept.
export interface OpenJobDto {
  booking_id: string;
  status: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_area: string | null;
  pickup_time: string;
  duration_hours: number;
  cpo_count: number;
  armed_required: boolean;
  total_eur: string;
  total_aed: string;
  created_at: string;
  // Only 'auto' bookings are claimable (charge-on-accept consent); legacy rows render
  // browse-only. Optional so a not-yet-redeployed server (field absent) degrades to
  // claimable — the server-side consent gate is authoritative either way.
  dispatch_mode?: string | null;
}

export interface OrgMissionDto {
  booking_id: string;
  booking_status: string;
  service: string;
  region_label: string;
  pickup_time: string;
  pickup_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  dropoff_address: string | null;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  cpo_count: number;
  armed_required: boolean;
  // Executive Protection — task, fixed block length, and transfer-leg presence.
  task_type?: string | null;
  duration_hours?: number;
  has_transport?: boolean;
  mission_id: string | null;
  mission_status: string | null;
  short_code: string | null;
  crew: Array<{user_id: string; call_sign: string | null; role: string; is_lead: boolean}>;
}

// ─── Attendance API (NestJS /attendance/*) ───────────────────────────────────

// Dept Chat v2 closed sets (mirror attendance.service.ts / the CHECK constraints).
// Day-status v2 widened the set to 10 — this union had silently stayed at 8,
// which made a corrected/day-status value of emergency_leave or mission
// un-typeable client-side (found during C1, 2026-08-08).
export type AttendanceStatusDto =
  | 'present' | 'late' | 'absent' | 'early_checkout'
  | 'leave' | 'sick_leave' | 'off_duty' | 'pending_review'
  | 'emergency_leave' | 'mission';
export type ReviewStatusDto = 'none' | 'pending' | 'approved' | 'rejected';
// 'camera_unavailable' and 'disputed' arrive from the server (disputeSession
// writes the latter) — the union had drifted behind reviewReasonLabel's cases.
export type ReviewReasonDto =
  | 'face_mismatch' | 'out_of_radius' | 'permission_denied' | 'offline'
  | 'camera_unavailable' | 'disputed';

export interface ShiftSessionDto {
  id: string;
  org_user_id: string;
  /**
   * vs2 item 4 — the COMPANY this record belongs to.
   *
   * These lists are deliberately CROSS-ORG (founder decision 2026-08-12):
   * scoping them against a workspace context that is absent after every
   * restart would turn "my shifts" into "some of my shifts", and a missing
   * record is worse than a confusing one. So each row names its own
   * organisation instead. Optional because an older server omits it.
   */
  org_name?: string | null;
  cpo_user_id: string;
  status: 'open' | 'closed' | 'edited';
  clock_in_at: string;
  clock_in_lat: number | null;
  clock_in_lng: number | null;
  clock_out_at: string | null;
  edit_reason: string | null;
  // Dept Chat v2 — null/absent on legacy rows.
  shift_id?: string | null;
  face_verified?: boolean | null;
  within_radius?: boolean | null;
  distance_m?: number | null;
  attendance_status?: AttendanceStatusDto | null;
  review_status?: ReviewStatusDto;
  review_reason?: ReviewReasonDto | null;
  reviewed_at?: string | null;
  admin_notes?: string | null;
  /** The member's dispute text (A7.4) — arrives on ses.* reads; surfaced to
   *  the correcting admin, never edited client-side. */
  dispute_note?: string | null;
}

// ─── Monthly roster + corrections (A7.2 / A7.4, manager-only) ────────────────
export interface RosterMonthDto {
  id: string;
  month: string;
  status: 'draft' | 'published' | 'amended' | 'archived';
  published_at: string | null;
  amended_at: string | null;
  archived_at: string | null;
  department: string | null;
}
export interface RosterConflictDto {
  cpo_user_id: string;
  cpo_name: string | null;
  shift_a: string;
  shift_b: string;
  start_a: string;
  end_a: string;
  start_b: string;
  end_b: string;
}
export type PublishRosterResultDto =
  | {ok: true; month: RosterMonthDto; conflicts: RosterConflictDto[]}
  | {ok: false; reason: 'conflicts'; conflicts: RosterConflictDto[]; status: RosterMonthDto['status']};
export interface CorrectionRowDto {
  id: string;
  session_id: string;
  corrected_by: string;
  corrected_at: string;
  reason: string;
  before_value: Record<string, unknown>;
  after_value: Record<string, unknown>;
}

// cpo_shifts — an expected duty window + geofence centre + radius (Dept Chat v2).
export interface ShiftDto {
  id: string;
  org_user_id: string;
  /**
   * vs2 item 4 — the COMPANY this record belongs to.
   *
   * These lists are deliberately CROSS-ORG (founder decision 2026-08-12):
   * scoping them against a workspace context that is absent after every
   * restart would turn "my shifts" into "some of my shifts", and a missing
   * record is worse than a confusing one. So each row names its own
   * organisation instead. Optional because an older server omits it.
   */
  org_name?: string | null;
  department: string | null;
  site_label: string | null;
  site_lat: number | null;
  site_lng: number | null;
  approved_radius_m: number;
  start_at: string;
  end_at: string;
  created_by: string;
  archived_at: string | null;
  created_at: string;
  assigned_count?: number;
}

export interface ClockInBody {
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  // Dept Chat v2 verified check-in (Step 5). face_meta is non-biometric metadata
  // only (model/version tag, confidence bucket) — never frames or descriptors.
  shift_id?: string;
  face_ok?: boolean;
  // Camera/face step couldn't run (permission denied) — distinct review reason.
  face_unavailable?: boolean;
  face_meta?: Record<string, unknown>;
  offline?: boolean;
}

export const attendanceApi = {
  clockIn: (body?: ClockInBody) =>
    authHttp.post<ShiftSessionDto>('/attendance/clock-in', body ?? {}),
  // PDF p.5 — check-out carries the same face + location verification fields.
  clockOut: (body?: {lat?: number; lng?: number; accuracy_m?: number; face_ok?: boolean; face_unavailable?: boolean}) =>
    authHttp.post<ShiftSessionDto>('/attendance/clock-out', body ?? {}),
  disputeSession: (id: string, note: string) =>
    authHttp.post<ShiftSessionDto>(`/attendance/sessions/${id}/dispute`, {note}),
  updateShift: (id: string, body: {
    department?: string; site_label?: string; site_lat?: number; site_lng?: number;
    approved_radius_m?: number; start_at?: string; end_at?: string;
  }) => authHttp.patch<ShiftDto>(`/attendance/shifts/${id}`, body),
  archiveShift: (id: string) => authHttp.delete<ShiftDto>(`/attendance/shifts/${id}`),
  myShifts: () => authHttp.get<ShiftSessionDto[]>('/attendance/me'),
  // Provider (org manager) roster view.
  orgSessions: (cpoUserId?: string) =>
    authHttp.get<ShiftSessionDto[]>('/attendance/org/sessions', {
      params: cpoUserId ? {cpo_user_id: cpoUserId} : undefined,
    }),
  // Dept Chat v2 (flag-gated server-side — 404 when off).
  myTodayShift: () => authHttp.get<ShiftDto | null>('/attendance/my-shift/today'),
  listShifts: () => authHttp.get<ShiftDto[]>('/attendance/shifts'),
  /** G-d — one server transaction: shift(s), assignments and audits commit
   *  together. repeat_weeks (2..12) materialises real weekly rows sharing a
   *  recurrence group; cpo_user_ids are copied to every occurrence;
   *  assign_department (G-c) expands to the branch's active non-managers. */
  createShift: (body: {
    department?: string; site_label?: string; site_lat?: number; site_lng?: number;
    approved_radius_m?: number; start_at: string; end_at: string;
    repeat_weeks?: number; cpo_user_ids?: string[]; assign_department?: string;
    // Q6 — multi-date create: explicit windows (one row each, one transaction).
    // start_at/end_at must carry the FIRST window (old-server degrade rule).
    occurrences?: Array<{start_at: string; end_at: string}>;
  }) => authHttp.post<{shift: ShiftDto; occurrences: number}>('/attendance/shifts', body),
  assignCpos: (shiftId: string, cpoUserIds: string[]) =>
    authHttp.post<{assigned: number}>(`/attendance/shifts/${shiftId}/assignments`, {
      cpo_user_ids: cpoUserIds,
    }),
  // G-ab — edit-mode prefill + the diff (un-assign finally exists; assignCpos
  // is insert-only, so a mis-assignment used to be permanent).
  listShiftAssignments: (shiftId: string) =>
    authHttp.get<{assignments: Array<{cpo_user_id: string; display_name: string | null}>}>(
      `/attendance/shifts/${shiftId}/assignments`),
  patchShiftAssignments: (shiftId: string, diff: {add?: string[]; remove?: string[]; assign_department?: string}) =>
    authHttp.patch<{added: number; removed: number}>(`/attendance/shifts/${shiftId}/assignments`, diff),
  // Manager (org) — Step 6/7.
  orgSummary: (params?: {from?: string; to?: string; cpo_user_id?: string; department?: string; shift_id?: string}) =>
    authHttp.get<{counts: Record<string, number>; total: number; pendingReview: number}>(
      '/attendance/org/summary', {params},
    ),
  pendingQueue: (params?: {department?: string}) =>
    authHttp.get<ShiftSessionDto[]>('/attendance/org/pending', {params}),
  reviewSession: (id: string, decision: 'approve' | 'reject', notes?: string) =>
    authHttp.patch<ShiftSessionDto>(`/attendance/sessions/${id}/review`, {decision, notes}),
  // A7.3 batch shape (scope-v2 F): one targeting mode per call — legacy
  // cpo_user_id | member_ids[] | department (server-expanded). Ranges are
  // client-expanded into dates[] (≤62); server caps targets×dates at 500.
  setDayStatus: (body: {
    cpo_user_id?: string; member_ids?: string[]; department?: string;
    status: 'leave' | 'sick_leave' | 'emergency_leave' | 'off_duty' | 'absent' | 'mission';
    date?: string; dates?: string[]; notes?: string;
  }) =>
    authHttp.post<ShiftSessionDto | {ok: true; members: number; dates: number}>('/attendance/day-status', body),
  exportSessions: (body?: {from?: string; to?: string; cpo_user_id?: string; department?: string; shift_id?: string}) =>
    authHttp.post<string>('/attendance/org/export', body ?? {}, {responseType: 'text'}),
  // ── Monthly roster (A7.2) — manager-only, 404s while the v2 flag is off.
  /** READ the month — never writes; `month: null` = never planned. */
  rosterMonth: (month: string) =>
    authHttp.get<{month: RosterMonthDto | null}>('/attendance/roster/month', {params: {month}}),
  /** Open the month as a DRAFT. Call ONLY from an explicit "Start planning"
   *  tap — never from a focus/load handler (a focus effect fires on every
   *  back-swipe and would mint phantom draft months, defeating the B1 split). */
  ensureRosterMonth: (month: string) =>
    authHttp.post<{month: RosterMonthDto}>('/attendance/roster/month/ensure', {month}),
  rosterConflicts: (rosterMonthId: string) =>
    authHttp.get<{conflicts: RosterConflictDto[]}>(`/attendance/roster/month/${rosterMonthId}/conflicts`),
  publishRosterMonth: (month: string, force?: boolean) =>
    authHttp.post<PublishRosterResultDto>('/attendance/roster/publish', {month, ...(force ? {force} : {})}),
  archiveRosterMonth: (month: string) =>
    authHttp.post<{month: RosterMonthDto}>('/attendance/roster/archive', {month}),
  // ── Corrections (A7.4) — append-only; the original session is never edited.
  listCorrections: (sessionId: string) =>
    authHttp.get<{corrections: CorrectionRowDto[]}>(`/attendance/roster/corrections/${sessionId}`),
  recordCorrection: (body: {session_id: string; reason: string; after: Record<string, unknown>}) =>
    authHttp.post<CorrectionRowDto>('/attendance/roster/corrections', body),
};

// ─── Incident API (NestJS /incidents/*, Dept Chat v2) ────────────────────────

export type IncidentCategoryDto =
  | 'security_concern' | 'safety_issue' | 'medical_incident' | 'suspicious_activity'
  | 'access_control' | 'property_damage' | 'vehicle_issue' | 'staff_misconduct'
  | 'visitor_contractor' | 'equipment_failure' | 'operational_disruption'
  | 'harassment_workplace' | 'lost_property' | 'fire_hazard' | 'other';
export type IncidentSeverityDto = 'low' | 'medium' | 'high' | 'critical';
export type IncidentStatusDto =
  | 'submitted' | 'received' | 'under_review' | 'action_assigned' | 'resolved' | 'closed';

export interface IncidentReportDto {
  id: string;
  ref: string | null;
  org_user_id: string;
  /**
   * vs2 item 4 — the COMPANY this record belongs to.
   *
   * These lists are deliberately CROSS-ORG (founder decision 2026-08-12):
   * scoping them against a workspace context that is absent after every
   * restart would turn "my shifts" into "some of my shifts", and a missing
   * record is worse than a confusing one. So each row names its own
   * organisation instead. Optional because an older server omits it.
   */
  org_name?: string | null;
  submitter_id: string;
  department: string | null;
  category: IncidentCategoryDto;
  severity: IncidentSeverityDto;
  description: string;
  location_label: string | null;
  location_lat: number | null;
  location_lng: number | null;
  status: IncidentStatusDto;
  assigned_to: string | null;
  created_at: string;
  updated_at: string;
}

export interface IncidentEventDto {
  id: string;
  incident_id: string;
  actor_id: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  note_internal: boolean;
  created_at: string;
}

export const incidentApi = {
  submit: (body: {
    category: IncidentCategoryDto;
    severity: IncidentSeverityDto;
    description: string;
    department?: string;
    location_label?: string;
    location_lat?: number;
    location_lng?: number;
  }) =>
    authHttp.post<{id: string; ref: string | null; status: IncidentStatusDto; severity: IncidentSeverityDto}>(
      '/incidents', body,
    ),
  mine: () => authHttp.get<IncidentReportDto[]>('/incidents/mine'),
  // Manager (org) — Step 9.
  queue: (params?: {
    status?: string; severity?: string; category?: string; submitter_id?: string;
    from?: string; to?: string; department?: string;
  }) =>
    authHttp.get<IncidentReportDto[]>('/incidents/queue', {params}),
  detail: (id: string) =>
    authHttp.get<{report: IncidentReportDto; events: IncidentEventDto[]}>(`/incidents/${id}`),
  updateStatus: (id: string, to: IncidentStatusDto, note?: string) =>
    authHttp.patch<{id: string; status: IncidentStatusDto}>(`/incidents/${id}/status`, {to, note}),
  assign: (id: string, assigneeUserId: string) =>
    authHttp.post<{id: string; assigned_to: string}>(`/incidents/${id}/assign`, {assignee_user_id: assigneeUserId}),
  addNote: (id: string, note: string, internal = true) =>
    authHttp.post<{ok: true}>(`/incidents/${id}/note`, {note, internal}),
  // Step 10 — evidence pointers. The bytes are encrypted + uploaded via the
  // existing media pipeline (MediaClient.uploadEncrypted); only the opaque
  // objectKey is posted here. The per-file key/iv ride the sealed envelope.
  attach: (id: string, storageKey: string) =>
    authHttp.post<{id: string}>(`/incidents/${id}/attachments`, {storage_key: storageKey}),
  listAttachments: (id: string) =>
    authHttp.get<Array<{id: string; incident_id: string; storage_key: string; created_by: string; created_at: string}>>(
      `/incidents/${id}/attachments`,
    ),
  // Step 10 · E2 — E2EE evidence key delivery. The per-file media key is sealed
  // (outer-ECIES) to each recipient device; the server stores opaque blobs only.
  evidenceRecipients: (id: string) =>
    authHttp.get<string[]>(`/incidents/${id}/recipients`),
  storeAttachmentKeys: (
    id: string, attachmentId: string,
    keys: {recipient_user_id: string; device_id: number; sealed_key: string}[],
  ) =>
    authHttp.post<{stored: number}>(`/incidents/${id}/attachments/${attachmentId}/keys`, {keys}),
  getAttachmentKey: (id: string, attachmentId: string, deviceId: number) =>
    authHttp.get<{sealed_key: string}>(`/incidents/${id}/attachments/${attachmentId}/key`, {
      params: {device_id: deviceId},
    }),
};

// ─── Ops API (NestJS /ops/*, admin-gated) ────────────────────────────────────

export const opsApi = {
  // Mission detail bundle — backs the mobile OpsMissionDetailScreen.
  // Server returns the mission row (with comms_channel_id), assigned crew,
  // waypoints, principals, sos, audit, booking, and vehicle. The group chat
  // is provisioned at dispatch (ops.service.ts:dispatchBooking), so
  // comms_channel_id is non-null for LIVE / PICKUP / SOS missions.
  getMission: (missionId: string) =>
    authHttp.get<{
      mission: {
        id: string; booking_id: string; status: string; short_code: string;
        started_at: string; ended_at: string | null;
        current_lat: number | null; current_lng: number | null;
        comms_channel_id: string | null;
      };
      crew: Array<{
        mission_id: string; agent_id: string; slot: number;
        role: string; call_sign: string | null; is_lead: boolean;
        team_idx: number;
      }>;
      booking: {
        id: string; client_id: string;
        pickup_address: string; dropoff_address: string | null;
        pickup_time: string; total_eur: string; total_aed: string;
        client_display_name: string | null;
      } | null;
    }>(`/ops/missions/${missionId}`),
};

// ─── AI / Claude API (Edge functions on Vercel) ──────────────────────────────

export const aiApi = {
  parseItinerary: (fileUri: string, mimeType: string) => {
    const formData = new FormData();
    formData.append('file', {uri: fileUri, type: mimeType, name: 'itinerary'} as unknown as Blob);
    return api.post<TripItinerary>('/ai/parse-itinerary', formData, {
      headers: {'Content-Type': 'multipart/form-data'},
    });
  },

  getRiskScore: (location: Location) =>
    api.post<{score: number; reason: string; recommendations: string[]}>('/ai/risk-score', {location}),

  getBookingSuggestions: (location: Location, date: string) =>
    api.post('/ai/booking-suggestions', {location, date}),
};

// ─── News API ────────────────────────────────────────────────────────────────

// Served by auth-service (VBG module — inherits the VBG news sources), so it
// rides authHttp for the JWT + refresh interceptors. CSV params come straight
// from the saved News Preferences (see @modules/news/newsPrefs).
export const newsApi = {
  getFeed: (params?: {countries?: string; categories?: string}) =>
    authHttp.get<{articles: Array<Record<string, unknown>>}>('/news/feed', {params}),
  // Category-aware worldwide sweep for the Bravo Intel map (server-cached).
  getWorldMap: (params?: {categories?: string}) =>
    authHttp.get<{articles: Array<Record<string, unknown>>}>('/news/worldmap', {params}),
};

// ─── Wallet API ──────────────────────────────────────────────────────────────
//
// Wallet endpoints live on auth-service now (port 3001). `authHttp` carries
// the access-token interceptor + refresh flow, so we route through it.
// Vault-storage endpoints still hit the legacy `api` surface until that
// backend lands.

export interface WalletBalanceDto {
  bravo_credits: number;
  currency: string;
  stripe_customer_id?: string | null;
}

export interface WalletTransactionDto {
  id: string;
  user_id: string;
  type: 'topup' | 'payment' | 'refund' | 'payout';
  status: 'pending' | 'succeeded' | 'failed' | 'refunded';
  amount: number;
  currency: string;
  description: string;
  booking_id?: string;
  created_at: string;
}

export interface WalletTopUpResponse {
  transaction_id: string;
  credits_awarded: number;
  client_secret?: string;
  intent_id?: string;
  customer_id?: string;
  fallback?: true;
  balance: WalletBalanceDto;
}

export interface SavedCardDto {
  id: string;
  brand: string;
  last4: string;
  exp_month: number;
  exp_year: number;
  is_default: boolean;
}

export const walletApi = {
  getBalance: () => authHttp.get<WalletBalanceDto>('/wallet/balance'),
  // Saved cards (Payment Methods)
  listCards: () => authHttp.get<{cards: SavedCardDto[]}>('/wallet/payment-methods'),
  cardSetupIntent: () => authHttp.post<{client_secret: string}>('/wallet/payment-methods/setup-intent'),
  removeCard: (id: string) => authHttp.delete<{removed: true}>(`/wallet/payment-methods/${id}`),
  setDefaultCard: (id: string) => authHttp.post<{default_id: string}>(`/wallet/payment-methods/${id}/default`),
  getTransactions: (params?: {limit?: number; offset?: number}) =>
    authHttp.get<{transactions: WalletTransactionDto[]}>('/wallet/transactions', {params}),
  topUp: (amount: number, currency: string) =>
    authHttp.post<WalletTopUpResponse>('/wallet/topup', {amount, currency}),
  redeemPromo: (code: string) =>
    authHttp.post<{credits_awarded: number; balance: WalletBalanceDto}>('/wallet/redeem-promo', {code}),
  /**
   * Called after PaymentSheet reports success. Asks the server to verify
   * the intent with Stripe + settle the pending ledger row + credit BC.
   * Safe to re-call (idempotent server-side).
   */
  confirmTopUp: (intentId: string) =>
    authHttp.post<{
      transaction_id: string;
      status: 'pending' | 'succeeded' | 'failed' | 'refunded';
      credits_awarded: number;
      balance: WalletBalanceDto;
    }>('/wallet/topup/confirm', {intent_id: intentId}),
  /** Active credit batches with expiry — live endpoint since CREDITS_BC_AUDIT F-06. */
  getCreditBatches: () => authHttp.get('/wallet/credits/batches'),
  // Phase-1 placeholders — no backend yet. Left on the Supabase-auth client
  // so their 404s fail independently of wallet-balance health.
  purchaseVaultStorage: (incrementMb: number) =>
    api.post('/vault/storage/purchase', {increment_mb: incrementMb}),
  getVaultStorage: () => api.get('/vault/storage'),
};

// ─── Subscription (Bravo Pro) ─────────────────────────────────────────────────

export interface SubscribeProResponse {
  subscription_tier: 'pro';
  active_until: string;
  charged_credits: number;
  balance: {bravo_credits: number; currency: string};
  auto_renew: boolean;
}

/**
 * B-91 M1 R4 — the permanently pinned sponsored slot on the Chat list.
 * Content is meant to be a remotely-managed client campaign; the endpoint
 * is not deployed yet (INDEX Q3), so callers fall back to the bundled
 * default campaign when this 404s.
 */
export interface SponsoredCampaign {
  headline: string;
  body: string;
  cta_label: string;
  cta_url: string;
  icon_url?: string | null;
}

export const adsApi = {
  getPinnedCampaign: (slot = 'messenger_pinned') =>
    authHttp.get<SponsoredCampaign>('/ads/campaign', {params: {slot}}),
};

/** E-10 — one key per subscribe ATTEMPT: an axios retry of the same call reuses
 *  it (no double debit), while a deliberate second purchase mints a new one. */
function subscribeKey(tier: string): string {
  return `subtier-${tier}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export const subscriptionApi = {
  /**
   * Debit the Pro price in Bravo Credits and flip the caller's tier to
   * 'pro'. Returns 400 `insufficient_credits` when the wallet is short —
   * the paywall catches that and routes into the card top-up fallback.
   * Pass {autoRenew:true} to also create a Stripe recurring subscription.
   */
  // E-10 — PER-ATTEMPT idempotency key (same shape as bookingApi.requestAuto).
  // It must protect a retry of ONE tap without swallowing a deliberate second
  // purchase: a day-bucketed key replayed the first response for 24 h, so a
  // same-day re-subscribe (or flipping auto_renew on) silently did nothing while
  // reporting success. Server side is OPTIONAL-idempotent, so builds that send
  // no header keep working.
  subscribePro: (autoRenew = false) =>
    authHttp.post<SubscribeProResponse>('/subscription/pro', {auto_renew: autoRenew},
      {headers: {'Idempotency-Key': subscribeKey('pro')}}),
  /** M1A — Enterprise (individual paid tier). Same contract as subscribePro. */
  subscribeEnterprise: (autoRenew = false) =>
    authHttp.post<SubscribeProResponse>('/subscription/enterprise', {auto_renew: autoRenew},
      {headers: {'Idempotency-Key': subscribeKey('enterprise')}}),
  /** Generic paid-tier subscribe — routes to the tier's endpoint. */
  subscribeTier: (tier: 'pro' | 'enterprise', autoRenew = false) =>
    authHttp.post<SubscribeProResponse>(`/subscription/${tier}`, {auto_renew: autoRenew},
      {headers: {'Idempotency-Key': subscribeKey(tier)}}),
  /** Stop auto-renew; the current paid period is kept until it lapses. */
  cancelAutoRenew: () =>
    authHttp.post<{cancelled: boolean}>('/subscription/pro/cancel', {}),
  /**
   * Live tier prices in BC (ops-editable — M1A/S9). Charged at charge time:
   * a price change applies to every subscribe/renewal AFTER it, while paid
   * periods finish at the price already charged. Falls back to the bundled
   * constants when unreachable.
   */
  getPrices: () =>
    authHttp.get<{pro: number; enterprise: number}>('/subscription/prices'),
  /** Founder 2026-08-26 — ops-editable package copy + live prices, one fetch. */
  catalog: () =>
    authHttp.get<{catalog: Array<{key: string; display_name: string; description: string; price_bc: number | null}>}>(
      '/subscription/catalog'),
};

// ─── Department Channels (Pro) ────────────────────────────────────────────────

export interface DepartmentChannelDto {
  id: string;
  name: string;
  description: string | null;
  department: string | null;
  /** Phase B — owning org. Optional: an old server omits it, and the client
   *  scoping falls open to today's single-org behaviour. */
  org_id?: string;
  /** Messenger group conversation id carrying the E2EE posts (null until an
   *  admin device has bootstrapped the Signal group). */
  group_conversation_id: string | null;
  unread_count: number;
  my_role: 'admin' | 'viewer';
  // Dept Chat v2 (Step 12). Default 'department'/'standard' on pre-v2 channels.
  channel_type?: 'board' | 'department' | 'incident';
  access?: 'standard' | 'read_only' | 'restricted';
  // Scope v2 Phase 1 — four-level hierarchy (Enterprise 0 / Main 1 / Sub 2 /
  // Sub-sub 3). Optional so a pre-hierarchy server response still parses; treat
  // a missing `level` as 1 (Main), which is how those rows already render.
  parent_id?: string | null;
  level?: number;
  // vs2 item 2 — the server masks `parent_id` to null when the caller is not a
  // member of the parent, which makes "no parent" ambiguous: a genuine
  // organisation root and an orphan whose parent is hidden look identical. These
  // three disambiguate it. ABSENT means an old server, and the grouping helper
  // must then route the row to "Other channels" — never to the organisation
  // list, or every orphan renders as its own organisation (the flat pile item 2
  // exists to kill).
  parent_hidden?: boolean;
  visible_ancestor_id?: string | null;
  /** Topmost ancestor regardless of visibility — grouping key of last resort. */
  root_id?: string | null;
  // Scope v2 Phase 2 — POSTING rights, deliberately separate from `access`
  // (visibility). A9: Open Chat / Read-only / Announcement-only / Admin-only.
  post_mode?: 'open' | 'read_only' | 'announcement' | 'admin_only';
  is_broadcast?: boolean;
  /**
   * item 04 — a chat channel attached to its parent WITHOUT consuming a tier.
   * Drawn as a neutral card at the parent's tier, never as a coloured level row.
   *
   * Its ABSENCE is load-bearing: an old server omits it, and the create
   * affordance is gated on having SEEN the field (serverKnowsLaterals) rather
   * than on its value — because in production an old server STRIPS a
   * "lateral: true" request silently and creates a structural child instead.
   */
  is_lateral?: boolean;
  /**
   * item 02/03 — is the ORG THIS ROW BELONGS TO a workspace (not an agency)?
   *
   * Per-row, and that is the point. The client used to answer this from a
   * USER-level flag that is true for anyone with any workspace affiliation, so
   * the dual persona (an agency manager who had also joined a workspace) got
   * workspace-shaped UI on their AGENCY's channels — edge A3, which the admin
   * endpoint already fixed and the member directory never did.
   * Absent = old server → fall back, never guess.
   */
  workspace_tenant?: boolean;
  /** M8 mockup renders "N members" per row. Optional so a pre-Phase-2 server response still parses. */
  member_count?: number;
  // Creator — gates owner-only actions (re-provision orphaned channel, delete).
  created_by?: string;
  // Rename attribution — used to synthesize the "X renamed the channel" system line.
  name_changed_by?: string | null;
  name_changed_at?: string | null;
}

export interface DepartmentMemberDto {
  user_id: string;
  role: 'admin' | 'viewer';
  role_label: string | null;
  display_name: string;
  avatar_url: string | null;
  // B-205 — whether the CALLER may change this member's access / remove them
  // (server-computed strict-outrank rule). Optional so an old server that
  // omits it defaults the client to its prior behaviour. The screen hides the
  // access + remove controls when this is explicitly false.
  manageable?: boolean;
}

export type ChannelTypeDto = 'board' | 'department' | 'incident';
export type ChannelAccessDto = 'standard' | 'read_only' | 'restricted';
/** Scope v2 Phase 2 — POSTING rights, separate from ChannelAccessDto (visibility). */
export type ChannelPostModeDto = 'open' | 'read_only' | 'announcement' | 'admin_only';

// Manager manage-screen view of an org channel (Step 18) — org-wide, incl. archived.
export interface ManagedChannelDto {
  id: string;
  name: string;
  department: string | null;
  description: string | null;
  channel_type: ChannelTypeDto;
  access: ChannelAccessDto;
  // Scope v2 Phase 1 — frame A9 renders the hierarchy from THIS shape. Optional
  // so a pre-hierarchy server still parses; a missing level reads as 1 (Main).
  parent_id?: string | null;
  level?: number;
  // vs2 item 2 — this source is NOT membership-filtered (a manager governs the
  // whole org), so the server emits these EXPLICITLY as false/null rather than
  // omitting them. That is what lets the shared grouping helper stay mode-free:
  // absent means "old server", present-and-false means "nothing is hidden here".
  parent_hidden?: boolean;
  visible_ancestor_id?: string | null;
  /** Whether THIS manager may attach this channel to an invite. Absent (old
   *  server) means not greyed — the post-submit 403 is the real boundary. */
  mintable_by_me?: boolean;
  /** WHY not, when not — the server's refusal code. A boolean alone made the
   *  client guess, and it guessed "outside your branch" at unscoped owners. */
  mint_refusal?: string | null;
  /** vs2 edge A4 — may THIS caller delete this channel (creator, or the
   *  workspace owner)? Server-computed from the same predicate `deleteChannel`
   *  enforces. Absent (old server) → no Delete door, i.e. today's behaviour. */
  deletable?: boolean;
  /** item 04 — see DepartmentChannelDto.is_lateral. The admin source emits it
   *  explicitly, so absent here means "server too old to say". */
  is_lateral?: boolean;
  root_id?: string | null;
  member_count: number;
  provisioned: boolean;
  archived: boolean;
  created_at: string;
  // Phase 2 — must round-trip through the editor: `access` alone cannot tell
  // Standard from Read only (both store 'standard').
  post_mode?: ChannelPostModeDto;
  is_broadcast?: boolean;
}

export interface ChannelInput {
  name?: string;
  department?: string | null;
  channel_type?: ChannelTypeDto;
  access?: ChannelAccessDto;
  // Phase 2 — posting rights. Unlike `parent_id` this IS on ChannelInput:
  // changing who may post is a legitimate edit (unlike moving a channel, which
  // would need a subtree re-level).
  post_mode?: ChannelPostModeDto;
}

/** Scope v2 Phase 3 — the join → approve loop (M5 / M11A / A11). */
export interface JoinRequestDto {
  id: string;
  applicant_user_id: string;
  applicant_name: string | null;
  applicant_phone: string | null;
  applicant_email: string | null;
  referrer_name: string | null;
  team_name: string | null;
  message: string | null;
  created_at: string;
}

export const enterpriseApi = {
  /** A5 — create the caller's Enterprise workspace. The owner is ALWAYS taken
   *  from the token server-side; there is deliberately no owner field here, so
   *  a future edit cannot start sending one. */
  createWorkspace: (name: string) =>
    authHttp.post<{owner_user_id: string; name: string; created_at: string}>(
      '/org/workspace', {name}),
  /** A5 — the caller's own workspace, or null. Drives the create-vs-enter fork. */
  myWorkspace: () =>
    authHttp.get<{workspace: null | {owner_user_id: string; name: string; created_at: string}}>(
      '/org/workspace'),
  /** M5 — resolve a shared link BEFORE applying. An expired/revoked code comes
   *  back `{valid:false}` with no organisation data at all. `invite` present
   *  means this is a bound single-use invite: show "Join", call acceptInvite —
   *  never submitJoinRequest (the server refuses it anyway). B-413 — a caller
   *  who owns a workspace gets `{valid:false, reason}` for an otherwise-valid
   *  link: their accept can only 409, so no Join button is armed. */
  resolveReferralLink: (code: string) =>
    authHttp.get<{valid: false; reason?: 'workspace_owner_cannot_join' | 'already_active_in_another_org'}
      | {valid: true; code: string; org_name: string | null; team_name: string | null;
      invite?: {invited_role: 'employee' | 'manager'}}>(
      `/enterprise/referral-links/${encodeURIComponent(code)}`),
  /** M5 — Submit Request. Note there is NO team field: the applicant cannot
   *  choose their department, it comes from the link server-side. */
  submitJoinRequest: (body: {code: string; full_name?: string; phone?: string; email?: string; message?: string}) =>
    authHttp.post<{status: 'pending'; id: string}>('/enterprise/join-requests', body),
  /** M11A — the applicant's own status. */
  myJoinRequest: () =>
    authHttp.get<{request: null | {
      status: 'pending' | 'approved' | 'declined';
      org_name: string | null; team_name: string | null; decided_at: string | null;
    }}>('/enterprise/join-requests/me'),
  /** A11 — admin inbox + decisions. Approve/Decline are separate routes so no
   *  third state can be requested. */
  listJoinRequests: () =>
    authHttp.get<{requests: JoinRequestDto[]}>('/enterprise/join-requests'),
  approveJoinRequest: (id: string) =>
    authHttp.post<{ok: true; decision: 'approved'}>(`/enterprise/join-requests/${id}/approve`),
  declineJoinRequest: (id: string) =>
    authHttp.post<{ok: true; decision: 'declined'}>(`/enterprise/join-requests/${id}/decline`),
  createReferralLink: (body: {team_channel_id?: string; expires_in_days?: number}) =>
    authHttp.post<{code: string; expires_at: string | null}>('/enterprise/referral-links', body),
  /** Page 10 rule 2 — "revocable invitation tokens". */
  revokeReferralLink: (code: string) =>
    authHttp.post<{ok: true}>(`/enterprise/referral-links/${encodeURIComponent(code)}/revoke`),
  listReferralLinks: () =>
    authHttp.get<{links: Array<{code: string; team_name: string | null; expires_at: string | null; revoked: boolean; created_at: string}>}>(
      '/enterprise/referral-links'),
  // ── Item E — member invites by phone/email (bound, single-use, auto-approve).
  /** A5-inv — mint. contact_phone must already be E.164 (normalise with
   *  normalizeToE164 BEFORE calling — the server refuses, never guesses). */
  createInvite: (body: {
    contact_phone?: string; contact_email?: string; invited_name?: string;
    team_channel_id?: string; invited_role?: 'employee' | 'manager';
    invited_department?: string; expires_in_days?: number;
  }) =>
    authHttp.post<{code: string; expires_at: string | null}>('/enterprise/invites', body),
  listInvites: () =>
    authHttp.get<{invites: Array<{
      code: string; contact: string; contact_kind: 'phone' | 'email';
      invited_name: string | null; invited_role: string; team_name: string | null;
      status: 'pending' | 'accepted' | 'expired' | 'revoked';
      expires_at: string | null; created_at: string;
    }>}>('/enterprise/invites'),
  revokeInvite: (code: string) =>
    authHttp.post<{ok: true}>(`/enterprise/invites/${encodeURIComponent(code)}/revoke`),
  /** The caller's own open invites (matched on verified phone / account
   *  email). `code` is null for EMAIL-matched rows — the account email is
   *  unverified, so the credential travels out-of-band; only a phone match
   *  (OTP-verified) carries it. B-413 — `acceptable:false` rows (workspace
   *  owners / members active in another org, whose accept can only 409) are
   *  informational: the Workspace Hub lists them with the reason; no CTA
   *  surface may arm on them. */
  myInvites: () =>
    authHttp.get<{invites: Array<{
      code: string | null; org_name: string | null; team_name: string | null;
      invited_role: 'employee' | 'manager'; expires_at: string | null;
      acceptable: boolean;
      blocked_reason?: 'workspace_owner_cannot_join' | 'already_active_in_another_org';
    }>}>('/enterprise/invites/me'),
  acceptInvite: (code: string) =>
    authHttp.post<{ok: true}>('/enterprise/invites/accept', {code}),
};

// METADATA ONLY — message content is E2EE and flows through the messenger
// runtime (broadcastToGroup), never these endpoints. These manage the
// directory, roster/role, and the encrypted-group linkage.
export const departmentApi = {
  // Phase B — optional workspace scope; an old server ignores the param and
  // returns everything (the caller's client-side filter stays fail-open).
  /**
   * ⚠️ PAGED. The server caps a page at 500 rows and returns a `next_cursor`;
   * this call FOLLOWS it until the cursor comes back null.
   *
   * It used to take the first page and discard the cursor, which was survivable
   * only while a channel list was short. Item 04 makes it unsurvivable: laterals
   * multiply the row count by design (the PDF's own example gives every level
   * two or three), so a 200-node organisation with three laterals apiece is 800
   * rows — and the 300 that fell off the end took whole branches with them,
   * SILENTLY. A member would simply not see part of their own tree, with no
   * error anywhere.
   *
   * The loop is bounded rather than `while (cursor)`: a server bug that returned
   * a constant cursor would otherwise spin forever on the app's start-up path.
   * 20 pages is 10,000 channels — far past any real tenant — and the cap is
   * WARNED about rather than swallowed, because silent truncation is the exact
   * failure this replaces.
   */
  listChannels: async (opts?: {orgId?: string}) => {
    const MAX_PAGES = 20;
    const params: Record<string, string> = {};
    if (opts?.orgId) {params.orgId = opts.orgId;}
    const all: DepartmentChannelDto[] = [];
    let cursor: string | null = null;
    let first: {channels: DepartmentChannelDto[]; next_cursor?: string | null} | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res: {data: {channels: DepartmentChannelDto[]; next_cursor?: string | null}} =
        await authHttp.get<{channels: DepartmentChannelDto[]; next_cursor?: string | null}>(
          '/department/channels',
          Object.keys(params).length || cursor
            ? {params: {...params, ...(cursor ? {cursor} : {})}}
            : undefined,
        );
      first ??= res.data;
      all.push(...(res.data.channels ?? []));
      cursor = res.data.next_cursor ?? null;
      if (!cursor) {break;}
      if (page === MAX_PAGES - 1) {
        console.warn('[deptchan] listChannels hit the page cap — the tree may be incomplete');
      }
    }
    // The SHAPE every caller already parses, with the full set in it. Returning
    // the first response's other fields keeps any future top-level field intact.
    return {data: {...(first ?? {channels: []}), channels: all}};
  },
  listMembers: (channelId: string) =>
    // `post_mode` is server-authoritative and serves the receive-side poster
    // filter. It rides this call because the thread already makes it on every
    // focus — a route param frozen at navigation time left the filter OFF on
    // every lane that opens a thread without setting it (notification tap,
    // forward, link), and could never see a mode change made while open.
    authHttp.get<{
      members: DepartmentMemberDto[];
      my_role: 'admin' | 'viewer';
      post_mode?: ChannelPostModeDto | null;
    }>(
      `/department/channels/${channelId}/members`,
    ),
  /** Admin device registers the messenger group it created for this channel. */
  registerGroup: (channelId: string, groupConversationId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/group`, {
      group_conversation_id: groupConversationId,
    }),

  // ── Manager channel management (Step 18; OrgManagerGuard server-side) ──
  /** Every channel of the manager's org (incl. archived) for the manage screen. */
  listManagedChannels: () =>
    // vs2 edge A3 — `workspace_tenant` describes the ORG THIS RESPONSE IS
    // ABOUT. The client's own `isWorkspaceTenant` is a USER-level fact (true
    // for anyone with any workspace affiliation), so the dual persona — an
    // agency manager who has also joined a workspace — got the workspace UI on
    // their AGENCY, where the editor drops the DEPARTMENT field that is the
    // live branch-scope key. Optional: absent (old server) falls back to the
    // user-level flag, i.e. exactly today's behaviour.
    // vs2 edge A8 — `can_grant_manager` is a per-MINTER fact (may THIS caller
    // grant the manager role?), which is why it cannot ride the per-ROW
    // `mintable_by_me`. Absent (old server) → offer the role, i.e. today's
    // behaviour; the submit-time refusal stays the real boundary.
    // G5 — `manager_scope_root_ids` names the ORGANISATION ROOTS this admin is
    // actually part of. `null` = unscoped (owner, agency, or no seeded
    // membership); a non-empty array narrows the admin surfaces to those roots.
    // Absent (old server) → undefined → today's behaviour, unscoped.
    authHttp.get<{channels: ManagedChannelDto[]; workspace_tenant?: boolean; can_grant_manager?: boolean;
      manager_scope_root_ids?: string[] | null}>('/department/manage/channels'),
  // `parent_id` is CREATE-ONLY on purpose — it is absent from ChannelInput (and
  // so from configureChannel) because moving a channel would have to re-level
  // its whole subtree, which Phase 1 does not do. The DB trigger refuses a
  // re-parent outright; keeping the type narrow means nothing tries.
  // vs2 item 8 — `root: true` mints a level-0 organisation. A boolean, never a
  // level: depth is derived by a DB trigger, and a caller must not be able to
  // assert its own.
  // item 04 — "lateral" rides beside parent_id. The response echoes is_lateral
  // back and the CALLER MUST CHECK IT: in production forbidNonWhitelisted is
  // false, so an old server silently STRIPS the field and creates a structural
  // child — frozen and un-re-parentable, i.e. unfixable afterwards. A read-side
  // capability probe cannot cover that (a rolling deploy can serve the read from
  // a new instance and the write from an old one), so the echo is the only real
  // signal that the request was honoured.
  createChannel: (input: ChannelInput & {name: string; parent_id?: string; root?: boolean; lateral?: boolean}) =>
    authHttp.post<{id: string; name: string; channel_type: ChannelTypeDto; access: ChannelAccessDto; level: number; is_lateral?: boolean}>(
      '/department/channels', input,
    ),
  configureChannel: (channelId: string, input: ChannelInput) =>
    authHttp.patch<{ok: true}>(`/department/channels/${channelId}`, input),
  archiveChannel: (channelId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/archive`),
  unarchiveChannel: (channelId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/unarchive`),

  // Membership management (channel admins / org). Each enqueues a server-side
  // intent the admin device drains to broadcast the matching E2EE rekey.
  addMember: (channelId: string, userId: string, role: 'admin' | 'viewer' = 'viewer', roleLabel?: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/members`, {
      user_id: userId, role, role_label: roleLabel,
    }),
  removeMember: (channelId: string, userId: string) =>
    authHttp.delete<{ok: true}>(`/department/channels/${channelId}/members/${userId}`),
  /** Change a member's access: viewer (read-only) ↔ admin (can post). Admin-only. */
  updateMemberRole: (channelId: string, userId: string, role: 'admin' | 'viewer') =>
    authHttp.patch<{ok: true}>(`/department/channels/${channelId}/members/${userId}/role`, {role}),
  /** Delete the channel — creator only. */
  deleteChannel: (channelId: string) =>
    authHttp.delete<{ok: true}>(`/department/channels/${channelId}`),
  /** Owner only: clear the E2EE group linkage so the owner can re-provision an
   *  orphaned channel (recovery for "explicit peer address" on send / empty thread). */
  resetGroup: (channelId: string) =>
    authHttp.post<{ok: true}>(`/department/channels/${channelId}/reset-group`),

  // Pending add/remove intents for channels the caller administers. The admin
  // device runs the matching rekey (addGroupMember/removeGroupMember) then acks.
  listMembershipIntents: () =>
    authHttp.get<{intents: Array<{
      id: string; channel_id: string; group_conversation_id: string | null;
      member_user_id: string; action: 'add' | 'remove'; created_at: string;
    }>}>('/department/membership-intents'),
  ackMembershipIntent: (intentId: string) =>
    authHttp.post<{ok: true}>(`/department/membership-intents/${intentId}/ack`),
};

// ─── Dispatch Ops Room intents (agency device) ───────────────────────────────
// METADATA ONLY — message content is E2EE through the messenger runtime. These
// manage the encrypted booking Ops Room roster linkage (Step 12): when a CPO is
// assigned to a booking, the server enqueues a pending intent; the agency device
// (the room creator/admin that holds the group key) drains it by running the
// matching rekey then acks. Mirrors departmentApi.{list,ack}MembershipIntent.
export const dispatchApi = {
  listRoomIntents: () =>
    authHttp.get<{intents: Array<{
      id: string; booking_id: string; conversation_id: string;
      member_user_id: string; action: 'add' | 'remove'; created_at: string;
      // MISSION-GROUP (area 5) — agency device bootstraps the Ops Room E2EE
      // group (with the client as initial member) before applying CPO adds.
      client_id: string; conversation_title: string | null;
    }>}>('/dispatch/room-intents'),
  ackRoomIntent: (intentId: string) =>
    authHttp.post<{ok: true}>(`/dispatch/room-intents/${intentId}/ack`),
  // B-416 — atomically claim a room's single E2EE key authority BEFORE
  // bootstrapping it; the response names the winner (first admin wins).
  claimRoomCrypto: (conversationId: string) =>
    authHttp.post<{claimed_by: string}>(
      `/dispatch/room-intents/rooms/${encodeURIComponent(conversationId)}/claim`),

  // Step 20 — the agency's single live coarse offer (or null). Polled while Online +
  // re-fetched on a dispatch push wake (the FCM payload itself stays opaque).
  getCurrentOffer: () =>
    authHttp.get<CoarseOffer | null>('/dispatch/offers/current'),

  // Accept the offer → charges the client into escrow server-side + flips the booking
  // CONFIRMED. Idempotency-Key (accept-<offerId>) so a retry can't double-act; a 400
  // (`offer_not_available`) means it was won/expired in the race — show "passed", NEVER retry.
  accept: (offerId: string) =>
    authHttp.post<{offer_id: string; booking_id: string; status: 'CONFIRMED'}>(
      `/dispatch/offers/${offerId}/accept`,
      undefined,
      {headers: {'Idempotency-Key': `accept-${offerId}`}},
    ),

  // Decline → cascades to the next-nearest agency. Reason is optional + server-redacted.
  reject: (offerId: string, reason?: string) =>
    authHttp.post<{ok: true}>(`/dispatch/offers/${offerId}/reject`, reason ? {reason} : {}),
};

// ─── Provider compliance (vetting docs — Step 15) ────────────────────────────
export interface ComplianceDocDto {
  id: string; doc_type: string; region_code: string; reference: string | null;
  expires_at: string; state: 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED'; reject_reason: string | null;
}
export const complianceApi = {
  listMine: () => authHttp.get<ComplianceDocDto[]>('/compliance/me'),
  submit: (body: {doc_type: 'licence' | 'insurance' | 'armed_permit'; region_code: string; expires_at: string; reference?: string; cpo_user_id?: string}) =>
    authHttp.post<{id: string; doc_type: string; state: 'PENDING'}>('/compliance', body),
};

// ─── Assignment / Telemetry ──────────────────────────────────────────────────

export interface AssignedCpoDto {
  // Audit H5 — the server no longer sends the internal agent user id to
  // clients. `call_sign` is the stable public identifier the UI keys on.
  call_sign: string;
  display_name: string;
  role: string;
  armed: boolean;
  female: boolean;
  specialties: string[];
  /** Public profile photo, or null when the officer has none. */
  avatar_url: string | null;
  /** Service provider this officer belongs to, or null if self-registered. */
  company: string | null;
  /** Vetting complete. */
  verified: boolean;
  /** Has accepted this specific assignment. */
  accepted: boolean;
}

export interface AssignedVehicleDto {
  id: string;
  call_sign: string;
  make_model: string;
  plate: string;
  /** Issue 30 — may be null on a vehicle whose colour was never recorded. */
  colour?: string | null;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
}

export interface TelemetryFixDto {
  lat: number;
  lng: number;
  heading_deg?: number;
  speed_kph?: number;
  eta_minutes?: number;
  recorded_at: string;
  source: string;
}

export const assignmentApi = {
  getTeam: (bookingId: string) =>
    authHttp.get<{cpos: AssignedCpoDto[]; vehicle: AssignedVehicleDto | null}>(
      `/bookings/${bookingId}/team`,
    ),
};

/**
 * Audit fix 0.7 — client-raised SOS. Wires the dashboard panic button
 * to /sos/raise on the auth-service. Cancel is local to the user.
 */
export interface SosStatusDto {
  id:                string;
  status:            string;
  triggered_at:      string;
  acknowledged_at:   string | null;
  acknowledged_by:   string | null;
  escalated_at:      string | null;
  resolved_at:       string | null;
}

export const sosApi = {
  raise: (body: {
    bookingId?: string;
    lat?: number;
    lng?: number;
    reason?: string;
    payload?: Record<string, unknown>;
  }) =>
    authHttp.post<{id: string; triggered_at: string}>('/sos/raise', body),
  cancel: (sosId: string) =>
    authHttp.post<{ok: true}>(`/sos/${sosId}/cancel`, {}),
  // Audit fix 0.7 (round-trip) — dashboard polls this until
  // `acknowledged_at !== null` before showing "Ops Room On Standby".
  status: (sosId: string) =>
    authHttp.get<SosStatusDto>(`/sos/${sosId}/status`),
};

export const telemetryApi = {
  latest: (bookingId: string) =>
    authHttp.get<{latest: TelemetryFixDto | null}>(`/telemetry/${bookingId}/latest`),
  recent: (bookingId: string, count = 60) =>
    authHttp.get<{fixes: TelemetryFixDto[]}>(`/telemetry/${bookingId}/recent`, {params: {count}}),
  // B-89 P3-D — the client-side `ping` wrapper was removed: it had ZERO
  // callers, and the fact that nothing wrote the client-facing stores was
  // exactly the MG-01 bug (the server now mirrors the CPO's push).
  // Client (booking owner) pushes their own GPS so ops can see the
  // principal marker on /live alongside the CPO Lead. Backend stores
  // these as missions.client_lat/lng (separate from agent telemetry).
  clientPing: (bookingId: string, fix: {lat: number; lng: number}) =>
    authHttp.post<{ok: true}>(`/telemetry/${bookingId}/client-ping`, fix),
};

export interface ConversationRecordDto {
  id:         string;
  kind:       'direct' | 'group';
  title:      string | null;
  createdAt:  string;
  createdBy:  string;
  members:    Array<{userId: string; displayName: string; role: 'admin' | 'member'; joinedAt: string}>;
  myRole:     'admin' | 'member';
}

export const conversationApi = {
  /** All conversations the signed-in user is a member of. */
  listMine: () =>
    authHttp.get<{conversations: ConversationRecordDto[]}>('/conversations/mine'),

  // Audit P1-5 / P1-6 — write the server `conversation_members` roster after a
  // mobile add/remove/leave whose E2EE rekey already ran on-device. Without
  // this the /conversations/mine sync resurrects a removed member (media-grant
  // leak) or drops an added one. The server also enqueues an RS-02 intent for
  // the metadata→rekey seam; since this device already rekeyed, its own drain
  // treats that intent as an idempotent no-op and self-acks.
  addMember: (conversationId: string, userId: string) =>
    authHttp.post<ConversationRecordDto>(`/conversations/${conversationId}/members`, {userId}),
  removeMember: (conversationId: string, userId: string) =>
    authHttp.delete<{ok: true}>(`/conversations/${conversationId}/members/${userId}`),

  // RS-02 — membership-intent drain for conversation-admin devices (the
  // conversations parallel of departmentApi.listMembershipIntents).
  listMembershipIntents: () =>
    authHttp.get<{intents: Array<{
      id: string; conversation_id: string; member_user_id: string;
      action: 'add' | 'remove'; created_at: string;
    }>}>('/conversations/membership-intents'),

  ackMembershipIntent: (intentId: string) =>
    authHttp.post<{ok: true}>(`/conversations/membership-intents/${intentId}/ack`),
};

// ─── Virtual Bodyguard (VBG) ──────────────────────────────────────────────────
// VBG-specific persistence the rest of the app didn't already have. The
// live threat feed itself stays client-side (useIntelFeed / Bravo Intel
// aggregator); these endpoints back biometric-liveness monitoring, the
// SRA snapshot, and nearby key points. All go through authHttp so the
// JWT + refresh interceptors apply automatically.
export interface VbgMonitoringStatus {
  enrolled:          boolean;
  status:            string | null;
  interval_min:      number | null;
  enrolled_at:       string | null;
  last_heartbeat_at: string | null;
  missed_count:      number;
  overdue:           boolean;
}

export interface VbgThreatCounts {
  critical:    number;
  caution:     number;
  information: number;
}

export interface VbgSraSnapshot {
  region:          string;
  context:         string;
  risk_score:      number;
  level:           'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  summary:         string;
  risks:           Array<{
    name:    string;
    level:   'low' | 'medium' | 'high';
    /** Live news backing this category — shown when the row is tapped. */
    articles?: Array<{title: string; url: string; source: string; seenAt: string; severity: 'critical' | 'caution' | 'information'}>;
  }>;
  recommendations: string[];
  counts:          VbgThreatCounts;
  lat:             number | null;
  lng:             number | null;
  created_at:      string;
}

export interface VbgThreat {
  title:    string;
  url:      string;
  source:   string;
  seenAt:   string;
  severity: 'critical' | 'caution' | 'information';
  theme:    string;
}

export interface VbgRegionThreats {
  region:  string;
  context: string;
  /** ISO-3166 alpha-2 of the reverse-geocoded country (emergency-number pinning). */
  country: string | null;
  threats: VbgThreat[];
  counts:  VbgThreatCounts;
}

export interface VbgKeyPoint {
  kind:       'police' | 'hospital' | 'embassy' | 'fire';
  label:      string;
  lat:        number;
  lng:        number;
  distanceKm: number;
}

export interface VbgGeofence {
  id:     string;
  name:   string;
  kind:   'safe' | 'danger';
  active: boolean;
}

export interface VbgFavorite {
  id:       string;
  name:     string;
  phone:    string;
  position: number;
}

export const vbgApi = {
  // Enroll returns a one-time per-device AES-256 telemetry key the client
  // must persist in the keychain (see modules/vbg/telemetryCrypto).
  enrollMonitoring: (body: {intervalMin?: number; lat?: number; lng?: number} = {}) =>
    authHttp.post<VbgMonitoringStatus & {telemetryKeyB64?: string}>('/vbg/monitoring/enroll', body),
  /** @deprecated use biometricCheckin('pass') — kept for back-compat. */
  heartbeat: (body: {lat?: number; lng?: number} = {}) =>
    authHttp.post<VbgMonitoringStatus>('/vbg/monitoring/heartbeat', body),
  biometricCheckin: (body: {result: 'pass' | 'fail'; lat?: number; lng?: number}) =>
    authHttp.post<VbgMonitoringStatus>('/vbg/biometric/checkin', body),
  monitoringStatus: () =>
    authHttp.get<VbgMonitoringStatus>('/vbg/monitoring/status'),
  // BE-7.1 — encrypted telemetry body (AES-256-GCM, base64 iv‖ct‖tag).
  telemetry: (sealed: string) =>
    authHttp.post<{ok: true; breach: boolean}>('/vbg/telemetry', {sealed}),
  panic: (body: {lat?: number; lng?: number} = {}) =>
    authHttp.post<{id: string; triggered_at: string}>('/vbg/panic', body),
  track: (sinceSec = 600) =>
    authHttp.get<{fixes: Array<{lat: number; lng: number; recordedAt: string}>}>('/vbg/track', {params: {sinceSec}}),
  // Cached ~1km-snap reverse geocode — country resolution for the booking
  // zone screen. country is ISO2 or null (honest fallback, never throws).
  geocode: (params: {lat: number; lng: number}) =>
    authHttp.get<{region: string; context: string; country: string | null}>('/vbg/geocode', {params}),
  // radiusKm (5/50/200) + timeWindowHours (24/48/72) are the GeoRisk search
  // controls; both optional — omitted falls back to region defaults.
  sra: (params: {lat?: number; lng?: number; radiusKm?: number; timeWindowHours?: number} = {}) =>
    authHttp.get<VbgSraSnapshot>('/vbg/sra', {params}),
  threats: (params: {lat?: number; lng?: number; timeWindowHours?: number} = {}) =>
    authHttp.get<VbgRegionThreats>('/vbg/threats', {params}),
  keypoints: (params: {lat?: number; lng?: number; radiusKm?: number} = {}) =>
    authHttp.get<{keypoints: VbgKeyPoint[]}>('/vbg/keypoints', {params}),
  // BE-7.3 — geofence management.
  listGeofences: () =>
    authHttp.get<{zones: VbgGeofence[]}>('/vbg/geofences'),
  createGeofence: (body: {name: string; kind: 'safe' | 'danger'; ring: Array<[number, number]>}) =>
    authHttp.post<{id: string}>('/vbg/geofences', body),
  deleteGeofence: (id: string) =>
    authHttp.delete<{ok: true}>(`/vbg/geofences/${id}`),
  // BE-7.6 — Next-of-Kin favorites (server-backed; survive reinstall).
  listFavorites: () =>
    authHttp.get<{favorites: VbgFavorite[]}>('/vbg/favorites'),
  setFavorites: (favorites: Array<{name: string; phone: string}>) =>
    authHttp.put<{favorites: VbgFavorite[]}>('/vbg/favorites', {favorites}),
};

// ─── Family hierarchy + shared credits ───────────────────────────────────────
export interface FamilyMemberLocation {
  lat:        number;
  lng:        number;
  /** Reverse-geocoded area name ("Benoni") — server-resolved, may be null. */
  label:      string | null;
  accuracyM:  number | null;
  recordedAt: string;
}

export interface FamilyMember {
  id:           string;
  memberId:     string | null;
  name:         string;
  avatarUrl:    string | null;
  status:       'pending' | 'active' | 'revoked' | 'declined';
  /** Owner-declared relationship — rendered as the badge on the member row. */
  relationship: string | null;
  /** ISO — while in the future the member is ON HOLD. */
  heldUntil:    string | null;
  spendLimit:   number | null;
  spent:        number;
  invitedAt:    string;
  acceptedAt:   string | null;
  /** Last device fix — ACTIVE, non-held members only; null until they report. */
  lastLocation: FamilyMemberLocation | null;
}

export interface FamilyMemberSpend {
  member: {id: string; name: string; spent: number; spendLimit: number | null};
  byFeature: Array<{feature: string; spent: number; refunded: number; count: number}>;
  transactions: Array<{
    id: string;
    type: 'payment' | 'refund';
    feature: string | null;
    description: string;
    /** Signed credits — negative = spent from the owner's wallet, positive = refunded back. */
    amount: number;
    bookingId: string | null;
    at: string;
  }>;
}

export interface FamilyInvite {
  id:           string;
  holderId:     string;
  holderName:   string;
  relationship: string | null;
  invitedAt:    string;
}

export interface FamilyMembership {
  holderId:     string;
  holderName:   string;
  relationship: string | null;
  heldUntil:    string | null;
  /** Allocated quota. `null` = unlimited within the holder's balance. */
  spendLimit:   number | null;
  /** Used amount. */
  spent:        number;
  /** `spendLimit - spent`; null when unlimited. Server-computed — never derive it locally. */
  remaining:    number | null;
  /**
   * `min(remaining quota, root available credit)` — what this member can
   * ACTUALLY spend right now. The holder's raw balance is deliberately not
   * exposed; this number explains a refusal without disclosing their finances.
   */
  effectiveSpendable: number;
  /** The root account is suspended — nothing is spendable regardless of quota. */
  rootSuspended: boolean;
  /** Present while a credit request is open, so the UI offers "View Request". */
  pendingRequest: {id: string; requestedCredits: number; createdAt: string} | null;
}

export type FamilyCreditRequestStatus =
  'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';

export interface FamilyCreditRequest {
  id:               string;
  familyRowId:      string;
  holderId:         string;
  memberId:         string;
  memberName:       string | null;
  requestedCredits: number;
  /** Set on approval; may be LESS than requested (partial approval). */
  approvedCredits:  number | null;
  reason:           string | null;
  status:           FamilyCreditRequestStatus;
  decisionReason:   string | null;
  createdAt:        string;
  decidedAt:        string | null;
  expiresAt:        string;
}

export interface FamilyQuotaAuditEntry {
  id:            string;
  action:        string;
  previousLimit: number | null;
  newLimit:      number | null;
  deltaCredits:  number | null;
  spentAtTime:   number;
  requestId:     string | null;
  reason:        string | null;
  actorId:       string | null;
  createdAt:     string;
}

export interface FamilyUsage {
  totalSpent: number;
  members: Array<{id: string; name: string; spent: number; spendLimit: number | null; sharePct: number}>;
  recent: Array<{name: string; credits: number; at: string; bookingId: string | null}>;
}

export const familyApi = {
  // Holder side
  invite: (phoneE164: string, spendLimitCredits?: number | null, relationship?: string | null) =>
    authHttp.post<{id: string; status: string}>('/family/invite', {phoneE164, spendLimitCredits, relationship}),
  /** At the 4/4 cap — file an Ops request to raise the linked-member seat limit. */
  requestSeats: () =>
    authHttp.post<{ok: true}>('/family/request-seats', {}),
  /** Hold / unhold a member — heldUntilIso null lifts the hold. */
  setHold: (id: string, heldUntilIso: string | null) =>
    authHttp.patch<{ok: true}>(`/family/members/${id}/hold`, {heldUntilIso}),
  members: () =>
    authHttp.get<{members: FamilyMember[]}>('/family/members'),
  usage: () =>
    authHttp.get<FamilyUsage>('/family/usage'),
  /**
   * Set / clear a member's spending quota.
   *
   * Refused with `QUOTA_BELOW_SPENT` (plus `minimumCredits`) when the new limit
   * is under what the member has already spent — that would create a negative
   * remaining. Surface the minimum, do not retry silently.
   */
  setLimit: (id: string, spendLimitCredits: number | null, reason?: string | null) =>
    authHttp.patch<{
      ok: true; previousLimit: number | null; newLimit: number | null;
      spent: number; remaining: number | null;
    }>(`/family/members/${id}/limit`, {spendLimitCredits, reason}),
  /** Append-only history of every quota change for one member. */
  quotaHistory: (id: string) =>
    authHttp.get<{history: FamilyQuotaAuditEntry[]}>(`/family/members/${id}/quota-history`),

  // ── Credit requests · holder side ──
  creditRequests: () =>
    authHttp.get<{requests: FamilyCreditRequest[]}>('/family/credit-requests'),
  /** Omit `approvedCredits` to approve in full; pass less for a partial approval. */
  approveCredit: (id: string, approvedCredits?: number | null, reason?: string | null) =>
    authHttp.post<{
      ok: true; requestId: string; approvedCredits: number;
      previousLimit: number | null; newLimit: number; partial: boolean;
    }>(`/family/credit-requests/${id}/approve`, {approvedCredits, reason}),
  rejectCredit: (id: string, reason?: string | null) =>
    authHttp.post<{ok: true}>(`/family/credit-requests/${id}/reject`, {reason}),

  // ── Credit requests · member side ──
  /**
   * Ask the holder for more spending credit. Refused with
   * `CREDIT_REQUEST_PENDING` (plus the open `requestId`) if one is already
   * open — show "View Request", never a second create button.
   */
  requestCredit: (requestedCredits: number, reason?: string | null) =>
    authHttp.post<{request: FamilyCreditRequest}>('/family/credit-requests', {requestedCredits, reason}),
  myCreditRequests: () =>
    authHttp.get<{requests: FamilyCreditRequest[]}>('/family/credit-requests/mine'),
  /** Cancel a PENDING request — allowed for either the holder or the member. */
  cancelCredit: (id: string) =>
    authHttp.post<{ok: true}>(`/family/credit-requests/${id}/cancel`, {}),
  /** Itemised per-member spend from the owner's wallet (actor-stamped ledger). */
  memberSpend: (id: string) =>
    authHttp.get<FamilyMemberSpend>(`/family/members/${id}/spend`),
  remove: (id: string) =>
    authHttp.delete<{ok: true}>(`/family/members/${id}`),
  // Member side
  membership: () =>
    authHttp.get<{membership: FamilyMembership | null}>('/family/membership'),
  /** Member device reports its last fix; non-members get {reported:false}. */
  reportLocation: (fix: {lat: number; lng: number; accuracyM?: number | null}) =>
    authHttp.post<{ok: true; reported: boolean}>('/family/location', fix),
  invites: () =>
    authHttp.get<{invites: FamilyInvite[]}>('/family/invites'),
  accept: (id: string) =>
    authHttp.post<{ok: true}>(`/family/invites/${id}/accept`, {}),
  decline: (id: string) =>
    authHttp.post<{ok: true}>(`/family/invites/${id}/decline`, {}),
};

// ─── Bravo Secure Pro applications (request-and-approval custom plans) ──────
// Distinct from `subscriptionApi` (M1A self-serve tiers): a Pro application is
// reviewed by the Bravo Control System, which returns a custom proposal priced
// in Bravo Credits per month.

export type ProApplicationStatus =
  | 'PENDING_PROPOSAL'
  | 'PROPOSAL_CREATED'
  | 'REVISION_REQUESTED'
  | 'ACCEPTED'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'REJECTED'
  | 'CANCELLED';

/** Compact previous-plan row (client "previous plans" + ops history). */
export interface ProApplicationHistoryEntry {
  id: string;
  status: ProApplicationStatus;
  intended_use: string;
  submitted_at: string;
  activated_at: string | null;
  current_period_end: string | null;
  /** Last COVERED day (period end − 1 day) — render THIS, not current_period_end,
   *  which is the exclusive end that drives expiry. */
  covered_until?: string | null;
  total_credits: number | null;
  coverage_start: string | null;
  coverage_end: string | null;
}

export interface ProApplicationCreateBody {
  intended_use: 'family_support' | 'executive_protection' | 'travel_protection' | 'residential_support' | 'event_support' | 'custom';
  intended_use_note?: string;
  duration_months?: number;
  duration_note?: string;
  start_date: string; // YYYY-MM-DD
  coverage_area: string;
  cpo_count: number;
  driver_count: number;
  support_staff_count: number;
  gender_preference: 'no_preference' | 'male' | 'female' | 'mixed';
  services: string[];
  service_other_note?: string;
  notes?: string;
}

export interface ProProposal {
  id: string;
  application_id: string;
  version: number;
  proposal_number: string;
  valid_until: string;
  coverage_start: string;
  coverage_end: string;
  /** Total BC for the WHOLE coverage period — debited once at activation. */
  total_credits: number;
  included_services: string[];
  assigned_team: Array<{role: string; count: number; label?: string}>;
  terms: string | null;
  created_at: string;
}

export interface ProApplicationEvent {
  id: string;
  event: string;
  actor: 'client' | 'ops' | 'system';
  message: string | null;
  created_at: string;
}

export interface ProApplication {
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
  service_other_note: string | null;
  notes: string | null;
  rejected_reason: string | null;
  submitted_at: string;
  activated_at: string | null;
  current_period_end: string | null;
  /** Last COVERED day (period end − 1 day) — render THIS, not current_period_end,
   *  which is the exclusive end that drives expiry. */
  covered_until?: string | null;
  proposal: ProProposal | null;
  events: ProApplicationEvent[];
  /** Present when this is the family OWNER's plan surfaced to a member. */
  via_owner?: {name: string} | null;
}

export interface ProApplicationMessage {
  id: string;
  sender: 'client' | 'ops';
  body: string;
  created_at: string;
}

export interface ProPlanMission {
  id: string;
  application_id: string;
  requested_by: string;
  mission_dates: string[];
  note: string | null;
  status: 'REQUESTED' | 'SCHEDULED' | 'DECLINED' | 'COMPLETED';
  assigned_team: Array<{role: string; count: number; label?: string}>;
  ops_note: string | null;
  created_at: string;
}

export interface ProTeamMember {
  id: string;
  cpo_user_id: string;
  starts_on: string;
  ends_on: string;
  cpo_name: string | null;
  avatar_url: string | null;
  call_sign: string | null;
  org_name: string | null;
  live_today: boolean;
}

// Client-visible fleet projection (Issue 30). The plate IS shown; the server
// withholds no vehicle field the client may see here.
export interface ProAssignedVehicle {
  id: string;
  call_sign: string | null;
  make_model: string;
  plate: string;
  colour: string | null;
  armored: boolean;
  armor_grade: string | null;
  capacity: number;
  starts_on: string;
  ends_on: string;
  live_today: boolean;
}

// Client-visible resource projection (Issue 30). The ops-internal serial
// (`identifier`) is deliberately WITHHELD by the server — do not expect it.
export interface ProAssignedResource {
  id: string;
  kind: 'comms' | 'medical' | 'tactical' | 'other';
  label: string;
  qty: number;
  starts_on: string;
  ends_on: string;
  live_today: boolean;
}

export const secureProApi = {
  create: (body: ProApplicationCreateBody) =>
    authHttp.post<{application: ProApplication}>('/pro-applications', body),
  me: () =>
    authHttp.get<{application: ProApplication | null; history: ProApplicationHistoryEntry[]}>('/pro-applications/me'),
  renew: (id: string) =>
    authHttp.post<{application: ProApplication}>(`/pro-applications/${id}/renew`, {}),
  accept: (id: string) =>
    authHttp.post<{application: ProApplication}>(`/pro-applications/${id}/accept`, {}),
  requestChanges: (id: string, message: string) =>
    authHttp.post<{application: ProApplication}>(`/pro-applications/${id}/request-changes`, {message}),
  activate: (id: string) =>
    authHttp.post<{application: ProApplication}>(`/pro-applications/${id}/activate`, {}, {
      headers: {'Idempotency-Key': `proapp-activate-${id}`},
    }),
  /** Withdraw a pre-activation application (terminal; re-apply is free). */
  cancel: (id: string) =>
    authHttp.post<{application: ProApplication}>(`/pro-applications/${id}/cancel`, {}),
  messages: (id: string) =>
    authHttp.get<{messages: ProApplicationMessage[]}>(`/pro-applications/${id}/messages`),
  sendMessage: (id: string, body: string) =>
    authHttp.post<{message: ProApplicationMessage}>(`/pro-applications/${id}/messages`, {body}),
  missions: (id: string) =>
    authHttp.get<{missions: ProPlanMission[]}>(`/pro-applications/${id}/missions`),
  requestMission: (id: string, dates: string[], note?: string) =>
    authHttp.post<{mission: ProPlanMission}>(`/pro-applications/${id}/missions`, {dates, note}),
  /** The plan's ops-assigned dedicated protection team + fleet + resources (live). */
  team: (id: string) =>
    authHttp.get<{team: ProTeamMember[]; vehicles: ProAssignedVehicle[]; resources: ProAssignedResource[]}>(`/pro-applications/${id}/team`),
};

// ─── Protection sessions (on-demand live tracking) ──────────────────────────

export type ProtectionSessionStatus = 'REQUESTED' | 'ACTIVE' | 'ENDING' | 'COMPLETED' | 'ABORTED';

export interface ProtectionSession {
  id: string;
  application_id: string;
  customer_id: string;
  cpo_user_id: string;
  assignment_id: string;
  status: ProtectionSessionStatus;
  requested_at: string;
  activated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  last_fix_at: string | null;
  sos_active: boolean;
  /** Set once the officer taps CPO Protect (null until then). */
  protect_activated_at?: string | null;
  /** CPO identity (never the PMC code). Present on create / current. */
  cpo_name?: string | null;
  cpo_avatar?: string | null;
  call_sign?: string | null;
}

export interface ProtectionNote {
  id: string;
  sender: 'customer' | 'cpo';
  body: string;
  created_at: string;
}

export interface ProtectionEvent {
  id: string;
  seq: string;
  event_type: string;
  actor_role: 'customer' | 'cpo' | 'ops' | 'system';
  prev_status: string | null;
  new_status: string | null;
  comment: string | null;
  created_at: string;
}
export interface ProtectionTimeline {
  events: ProtectionEvent[];
  mission_status: string;
  protection_status: 'not_activated' | 'active' | 'ended';
}
export interface ProtectionHistorySession {
  id: string;
  status: ProtectionSessionStatus;
  requested_at: string;
  activated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  protect_activated_at: string | null;
  sos_active: boolean;
  created_at: string;
  customer_name: string | null;
  protection_status: 'not_activated' | 'active' | 'ended';
}

export interface ProtectionSessionHistoryEntry {
  id: string;
  application_id: string;
  status: ProtectionSessionStatus;
  requested_at: string;
  activated_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  sos_active: boolean;
  protect_activated_at: string | null;
  created_at: string;
  cpo_name: string | null;
  cpo_avatar: string | null;
  protection_status: 'not_activated' | 'active' | 'ended';
}

export interface ProtectionFix {
  lat: number;
  lng: number;
  accuracy_m?: number;
  recorded_at: string;
}

/** Per-side device readiness for a protection session (mission-start gate). */
export interface ProtectionReadinessSide {
  ready: boolean;
  reported: boolean;
  reported_at: string | null;
  missing: string[];
}
export interface ProtectionReadiness {
  state: 'READY' | 'WAITING_FOR_READINESS';
  customer: ProtectionReadinessSide;
  cpo: ProtectionReadinessSide;
  blocked_by: string[];
}
export interface ReadinessReport {
  location_permission: boolean;
  location_services: boolean;
  precise_location: boolean;
  connectivity: boolean;
  location_available: boolean;
  platform?: string;
}

export const protectionApi = {
  /** Open a session (or return the existing live one). Per-attempt key — the DB
   *  unique index makes a double-create safe (returns the live session). */
  create: (applicationId: string) =>
    authHttp.post<{session: ProtectionSession; already_active: boolean}>(
      '/protection/sessions', {application_id: applicationId},
      {headers: {'Idempotency-Key': `psession-create-${applicationId}-${Date.now()}`}},
    ),
  /** The caller's live session + CPO + server clock (404 no_active_session). */
  current: () =>
    authHttp.get<{session: ProtectionSession; server_now: string}>('/protection/sessions/current'),
  /** Stream a batch of the caller's own fixes. First accepted fix flips ACTIVE. */
  sendLocations: (id: string, fixes: ProtectionFix[]) =>
    authHttp.post<{accepted: number; status: ProtectionSessionStatus; activated: boolean}>(
      `/protection/sessions/${id}/locations`, {fixes},
    ),
  /** End the caller's session (idempotent). */
  end: (id: string) =>
    authHttp.post<{session: ProtectionSession}>(
      `/protection/sessions/${id}/end`, {}, {headers: {'Idempotency-Key': `psession-end-${id}`}},
    ),
  /** Session history (times, CPO, SOS flag — no coordinates). Cursor-paginated. */
  history: (limit = 20, before?: string) =>
    authHttp.get<{sessions: ProtectionSessionHistoryEntry[]}>('/protection/sessions', {params: {limit, ...(before ? {before} : {})}}),
  /** In-session note thread (customer comments + officer replies). */
  notes: (id: string) =>
    authHttp.get<{notes: ProtectionNote[]}>(`/protection/sessions/${id}/notes`),
  /** Customer posts a predefined option or a free comment (one-way to the officer).
   *  Idempotency-keyed (§6) so a retry after a disconnect never duplicates. */
  postNote: (id: string, body: string, idemKey: string) =>
    authHttp.post<{note: ProtectionNote}>(`/protection/sessions/${id}/notes`, {body}, {headers: {'Idempotency-Key': idemKey}}),
  /** Report this device's location capability — the mission-start gate. */
  reportReadiness: (id: string, body: ReadinessReport) =>
    authHttp.post<{readiness: ProtectionReadiness; activated: boolean}>(`/protection/sessions/${id}/readiness`, body),
  /** Mission-history timeline for the customer's own session. */
  timeline: (id: string) =>
    authHttp.get<ProtectionTimeline>(`/protection/sessions/${id}/timeline`),
};

export type StalenessState = 'idle' | 'live' | 'delayed' | 'unavailable';
export interface Staleness {
  age_seconds: number | null;
  state: StalenessState;
}

export interface ProtectionTrailFix {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  recorded_at: string;
  received_at: string;
}

export interface CpoProtectionCustomer {
  assignment_id: string;
  application_id: string;
  starts_on: string;
  ends_on: string;
  owner_id: string;
  owner_name: string | null;
  owner_avatar: string | null;
  session_id: string | null;
  session_status: ProtectionSessionStatus | null;
  session_customer_id: string | null;
  session_customer_name: string | null;
  activated_at: string | null;
  last_fix_at: string | null;
  sos_active: boolean | null;
  staleness: Staleness | null;
}

export interface CpoProtectionSessionDetail {
  session: ProtectionSession & {customer_name?: string | null; customer_avatar?: string | null};
  staleness: Staleness;
  trail: ProtectionTrailFix[];
  /** The officer's own location stream (subject='cpo'). */
  cpo_trail: ProtectionTrailFix[];
  notes: ProtectionNote[];
  server_now: string;
}

/** CPO protection surface (§6) — server scopes every read to the caller. */
export const cpoProtectionApi = {
  overview: () =>
    authHttp.get<{customers: CpoProtectionCustomer[]; server_now: string}>('/agents/me/protection/overview'),
  session: (id: string) =>
    authHttp.get<CpoProtectionSessionDetail>(`/agents/me/protection/sessions/${id}`),
  locations: (id: string, since?: string) =>
    authHttp.get<{fixes: ProtectionTrailFix[]; server_now: string}>(
      `/agents/me/protection/sessions/${id}/locations`, {params: since ? {since} : {}},
    ),
  /** Officer streams their OWN location during a session (client/CPO/combined maps). */
  cpoPing: (id: string, fixes: ProtectionFix[]) =>
    authHttp.post<{accepted: number}>(`/agents/me/protection/sessions/${id}/cpo-ping`, {fixes}),
  /** Officer posts a predefined status / comment (mission update → Ops).
   *  Idempotency-keyed (§6) so a retry after a disconnect never duplicates. */
  postNote: (id: string, body: string, idemKey: string) =>
    authHttp.post<{note: ProtectionNote}>(`/agents/me/protection/sessions/${id}/notes`, {body}, {headers: {'Idempotency-Key': idemKey}}),
  /** Report the officer device's location capability — the mission-start gate. */
  reportReadiness: (id: string, body: ReadinessReport) =>
    authHttp.post<{readiness: ProtectionReadiness; activated: boolean}>(`/agents/me/protection/sessions/${id}/readiness`, body),
  /** CPO Protect — formally engage protection (idempotent). */
  activateProtect: (id: string) =>
    authHttp.post<{protect_activated_at: string | null; already: boolean}>(`/agents/me/protection/sessions/${id}/protect`, {}),
  /** Mission history — this officer's past + present sessions (paginated). */
  history: (limit = 20, before?: string) =>
    authHttp.get<{sessions: ProtectionHistorySession[]}>('/agents/me/protection/history', {params: {limit, ...(before ? {before} : {})}}),
  /** Full operational timeline for a session the officer owns. */
  timeline: (id: string) =>
    authHttp.get<ProtectionTimeline>(`/agents/me/protection/sessions/${id}/timeline`),
};

// ─── CPO ↔ Pro mission-code gate ────────────────────────────────────────────

export interface ProCpoMissionView {
  assignment: {
    id: string;
    application_id: string;
    starts_on: string;
    ends_on: string;
    status: 'ASSIGNED' | 'COMPLETED' | 'CANCELLED';
    mission_code: string;
    note: string | null;
    member_name: string | null;
    member_avatar: string | null;
    org_name: string | null;
    coverage_area: string | null;
    authorized_at: string | null;
    revoked_at: string | null;
  };
  protection_dates: string[];
  live_today: boolean;
}

export const proMissionApi = {
  /** Validate a mission code for THIS logged-in CPO; valid → mission view. */
  enterCode: (code: string) =>
    authHttp.post<ProCpoMissionView>('/agents/me/pro-mission-code', {code}),
  /**
   * Restore an already-authorized mission — no code. The backend is the source
   * of truth: 404 `no_active_assignment` means ops revoked it or the schedule
   * finished, and the code gate should be shown again.
   */
  current: () => authHttp.get<ProCpoMissionView>('/agents/me/pro-mission'),
};

export default api;
