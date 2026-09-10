import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {Platform} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import {authApi, agentApi, getDeviceId, tokenStore, subscriptionApi, type ApiUser} from '@services/api';
import {decodeAccessTokenClaims, minimalUserFromClaims} from '@services/jwtClaims';
import type {AccountKind, User, UserRole} from '@appTypes/index';
import {setUser as setObservabilityUser} from '@modules/observability';
import {pendingProvider} from '@store/pendingProvider';
// Type-only imports for the lazy `require(...)` calls inside signOut.
// We keep the require's so messenger modules don't get pulled into the
// bootstrap graph until logout actually runs (avoids circular boot-time
// dependencies between authStore and the runtime). The `import type *
// as` form is type-only at compile-time (no runtime value emitted) and
// is the form the lint config allows.
import type * as IncomingOneToOneBannerModule
  from '@/modules/messenger/webrtc/incomingOneToOneBanner';
import type * as CallRegistryModule
  from '@/modules/messenger/runtime/callRegistry';
import type * as GroupCallRegistryModule
  from '@/modules/messenger/runtime/groupCallRegistry';
import type * as BravoTonesModule
  from '@/modules/messenger/runtime/bravoTones';
import type * as ProductionRuntimeModule
  from '@/modules/messenger/runtime/productionRuntime';
import type * as RuntimeModule
  from '@/modules/messenger/runtime';
import type * as TransportRegistryModule
  from '@/modules/messenger/runtime/transportRegistry';
import type * as CallDispatcherModule
  from '@/modules/messenger/webrtc/callDispatcher';
import type * as SfuDispatcherModule
  from '@/modules/messenger/webrtc/sfuDispatcher';
import type * as GroupCallIdentityRegistryModule
  from '@/modules/messenger/webrtc/groupCallIdentityRegistry';
import type * as GroupCallRingDispatcherModule
  from '@/modules/messenger/webrtc/groupCallRingDispatcher';
import type * as RttRegistryModule
  from '@/modules/messenger/runtime/rttRegistry';
import type * as FcmBootstrapModule
  from '@/modules/messenger/push/fcmBootstrap';
import type * as MessageMirrorModule
  from '@/modules/messenger/backup/messageMirror';
import type * as MirrorBootstrapModule
  from '@/modules/messenger/backup/mirrorBootstrap';
import type * as DiscoveredContactsModule
  from '@/modules/messenger/contacts/useDiscoveredContacts';
import type * as IdentityBackupModule
  from '@/modules/messenger/backup/identityBackup';
import type * as MessengerStoreModule
  from '@/modules/messenger/store/messengerStore';
import type * as VoipWakeVerifyModule
  from '@/modules/messenger/push/voipWakeVerify';
import type * as UnregisterPushModule
  from '@/modules/messenger/push/unregisterPush';
import type * as WalletStoreModule from '@store/walletStore';
import type * as BookingStoreModule from '@store/bookingStore';

/**
 * Round 2 / Architecture audit fix: registration + verifyOtp used to
 * hard-code `platform: 'android'`, which meant iOS users were registered
 * as Android devices for FCM/APNs routing — push tokens went to the
 * wrong dispatcher and iOS users never received VoIP wakes. Use the
 * actual platform so the server's push.service.ts can route correctly.
 */
const DEVICE_PLATFORM: 'android' | 'ios' = Platform.OS === 'ios' ? 'ios' : 'android';

/**
 * Notif-latency D1 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md) —
 * the last /auth/me result, persisted so a cold boot can authenticate from
 * disk instead of waiting a network roundtrip before ANYTHING renders.
 * Profile/routing fields only — NO tokens, NO key material (those stay in
 * tokenStore / the keychain). Written and cleared by the store subscriber at
 * the bottom of this file; consumed only by initialize().
 */
const USER_SNAPSHOT_KEY = 'auth:user_snapshot';

async function readUserSnapshot(): Promise<User | null> {
  try {
    const raw = await AsyncStorage.getItem(USER_SNAPSHOT_KEY);
    if (!raw) {return null;}
    const parsed = JSON.parse(raw) as User;
    // A snapshot that cannot drive the role-gated RootNavigator is useless —
    // fall back to the blocking path rather than boot into a broken shell.
    if (!parsed || typeof parsed !== 'object' || !parsed.id || !parsed.role) {return null;}
    return parsed;
  } catch { return null; }
}

/**
 * Warm-start FIX-02 — how long the snapshot-less boot may wait for `/auth/me`
 * before falling back to a claims-derived session. Well under the 15s axios
 * timeout: past a couple of seconds the user reads it as "the app is broken",
 * and the degraded session is strictly better than a spinner.
 */
const BOOT_ME_TIMEOUT_MS = 4_000;

class BootTimeout extends Error {
  constructor() { super('boot /auth/me timed out'); this.name = 'BootTimeout'; }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BootTimeout()), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

// Backoff for the degraded-session re-verify. Capped rather than infinite:
// `recheckMembership` (AppState → active) and the axios refresh interceptor
// both re-fetch /auth/me, so a session that outlives this ladder still heals
// the moment the user backgrounds and returns, or touches any authed screen.
const REVALIDATE_DELAYS_MS = [3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000, 30_000] as const;
let revalidateRunning = false;
let revalidateCancel: (() => void) | null = null;

/**
 * Stop the degraded-session re-verify ladder.
 *
 * Called by signOut: a torn-down session must not leave a loop polling
 * /auth/me behind it (it would 401 against cleared tokens, and on a shared
 * device it would do so under the previous account's identity).
 */
export function cancelSessionRevalidation(): void {
  const c = revalidateCancel;
  revalidateCancel = null;
  revalidateRunning = false;
  c?.();
}

function cancellableSleep(ms: number): {promise: Promise<boolean>; cancel: () => void} {
  let cancel = (): void => {};
  const promise = new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(true), ms);
    cancel = () => { clearTimeout(timer); resolve(false); };
  });
  return {promise, cancel};
}

/**
 * Re-verify a claims-derived session until the server answers.
 *
 * Stops on success (applyMe flips `sessionUnverified` false), on a definitive
 * 401/403 (tokens cleared + signOut, same rule as every other lane), on
 * sign-out, or when the ladder runs out.
 */
async function revalidateUnverifiedSession(
  applyMe: (opts?: {requireLive?: boolean}) => Promise<void>,
): Promise<void> {
  if (revalidateRunning) {return;}
  revalidateRunning = true;
  try {
    for (const delay of REVALIDATE_DELAYS_MS) {
      const sleep = cancellableSleep(delay);
      revalidateCancel = sleep.cancel;
      const slept = await sleep.promise;
      revalidateCancel = null;
      if (!slept) {return;}
      const st = useAuthStore.getState();
      if (!st.sessionUnverified || st.isSigningOut || !st.isAuthenticated) {return;}
      try {
        await applyMe({requireLive: true});
        if (!useAuthStore.getState().sessionUnverified) {
          console.warn('[auth] degraded session re-verified against /auth/me');
          return;
        }
      } catch (e: unknown) {
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        if (status === 401 || status === 403) {
          await tokenStore.clear();
          const cur = useAuthStore.getState();
          if (!cur.isSigningOut && cur.isAuthenticated) {cur.signOut().catch(() => { /* self-guarded */ });}
          return;
        }
        // Still offline — keep laddering.
      }
    }
  } finally { revalidateRunning = false; revalidateCancel = null; }
}

// Coerce API user (snake_case) into the mobile `User` model. The optional
// `kind` carries the server-computed app-routing fields from /auth/me (§35A):
// account_kind, org, must_set_password, membership_status — the discriminator the
// root routes off (never a client flag or JWT claim).
/**
 * The server-computed routing fields (§35A) carried on the current user.
 *
 * PATCH /auth/me returns only the user ROW, so rebuilding from it alone drops
 * every one of them: a manager who changed their photo or name instantly lost
 * the manager dashboard, a managed CPO lost their org, and auto-dispatch
 * fell back to off — until the next /auth/me happened to run. Re-reading the
 * server here would be wrong too (a profile edit can't change routing), so the
 * existing values are carried across.
 */
function routingOf(u: User | null): Parameters<typeof toUser>[1] {
  if (!u) {return undefined;}
  return {
    account_kind: u.account_kind, is_org_manager: u.is_org_manager,
    permitted_modules: u.permitted_modules, managed_org: u.managed_org,
    membership_status: u.membership_status, suspension: u.suspension,
    org: u.org, must_set_password: u.must_set_password,
    owns_workspace: u.owns_workspace,
    org_is_workspace: u.org_is_workspace,
    // Phase B — the snapshot must carry the hub's data or the optimistic
    // boot (notif-latency D1) renders an empty hub until /auth/me lands.
    workspaces: u.workspaces,
    // B-417 — dropping this here silently strips the owner's Ops Room key
    // authority on the next profile edit (the exact rot this fn exists for).
    owns_agency: u.owns_agency,
    cpo_needs_onboarding: u.cpo_needs_onboarding,
    auto_dispatch_enabled: u.auto_dispatch_enabled,
  };
}

function toUser(
  u: ApiUser,
  kind?: {
    account_kind?: AccountKind;
    is_org_manager?: boolean;
    // Owner-granted dashboard modules — null for anyone but a promoted
    // manager (owner/plain CPO/enterprise individual are never filtered).
    permitted_modules?: string[] | null;
    // The org a delegated manager manages — the manager discriminator.
    managed_org?: {id: string; name: string} | null;
    membership_status?: string | null;
    // Why the member is locked out — non-null only while suspended. Shown on
    // AccessEndedScreen so a suspended CPO is told the reason instead of
    // hitting a blank wall.
    suspension?: {reason: string | null; until: string | null} | null;
    org?: {id: string; name: string} | null;
    /** Scope v2 Phase 6 — owns an Enterprise workspace (server-authoritative). */
    owns_workspace?: boolean;
    /** Founder QA 2026-08-08 — the caller's org is a WORKSPACE tenant (vocabulary). */
    org_is_workspace?: boolean;
    /** Phase B — every enterable workspace affiliation (own + membership). */
    workspaces?: Array<{org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'}>;
    /** B-417 — ACTIVE agency company account (mirrors OrgManagerGuard Path 1). */
    owns_agency?: boolean;
    must_set_password?: boolean;
    cpo_needs_onboarding?: boolean;
    auto_dispatch_enabled?: boolean;
  },
): User {
  return {
    id: u.id,
    email: u.email,
    phone_e164: u.phone_e164 ?? undefined,
    full_name: u.display_name,
    role: u.role as UserRole,
    subscription_tier: u.subscription_tier,
    pro_active_until: u.pro_active_until ?? null,
    account_kind: kind?.account_kind,
    is_org_manager: kind?.is_org_manager,
    permitted_modules: kind?.permitted_modules ?? null,
    managed_org: kind?.managed_org ?? null,
    owns_workspace: kind?.owns_workspace ?? false,
    org_is_workspace: kind?.org_is_workspace ?? false,
    workspaces: kind?.workspaces,
    owns_agency: kind?.owns_agency ?? false,
    membership_status: kind?.membership_status ?? null,
    suspension: kind?.suspension ?? null,
    org: kind?.org ?? null,
    must_set_password: kind?.must_set_password ?? false,
    // Routes a managed CPO to the document-upload onboarding until ops approves them.
    cpo_needs_onboarding: kind?.cpo_needs_onboarding ?? false,
    // Bug 1: server-driven auto-dispatch flag (replaces the build-time EXPO_PUBLIC_AUTO_DISPATCH).
    // Fail-closed to legacy: defaults false until /auth/me confirms it.
    auto_dispatch_enabled: kind?.auto_dispatch_enabled ?? false,
    avatar_url: u.avatar_url ?? undefined,
  } as unknown as User;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  // True only while signOut() is tearing the session down. Drives the
  // blocking "Signing out…" overlay (RootNavigator). Kept separate from
  // isLoading so it can't be cleared by a concurrent load and so the
  // overlay text/behaviour differs from the boot "Verifying session…" one.
  isSigningOut: boolean;
  // §35A §F — set true when a managed CPO's agency access has ended
  // (membership_status != 'active', or a 401/403 on the session re-check). Survives
  // signOut() so the RootNavigator can show AccessEndedScreen instead of the login
  // form. Cleared by clearAccessEnded() ("Return to sign in").
  accessEnded: boolean;
  /**
   * Warm-start FIX-02 — this session was restored from ACCESS-TOKEN CLAIMS
   * because the server could not be reached and no boot snapshot existed. The
   * user is signed in and the app is usable, but the §35A routing fields
   * (account_kind, managed_org, permitted_modules, workspaces) are UNKNOWN, so
   * the shell may be the plain-individual one until `/auth/me` lands.
   *
   * Two consumers depend on this being honest:
   *   - the snapshot subscriber, which must NOT persist a guessed identity
   *     (that would make a wrong shell durable across boots);
   *   - the background re-verify loop, which stops once it flips false.
   */
  sessionUnverified: boolean;
  error: string | null;
  pendingUserId: string | null;     // set between register/login and OTP verify
  pendingPhone: string | null;
}

interface AuthActions {
  initialize: () => Promise<void>;
  /** Step 1 of registration — only sends OTP; user row is NOT created yet. */
  register: (p: {
    email: string; password: string; fullName: string; phoneE164: string;
    role?: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise';
  }) => Promise<{phone: string}>;
  /** Step 2 of registration — verifies OTP AND creates the user atomically. */
  verifyRegister: (p: {
    email: string; password: string; fullName: string; phoneE164: string;
    role?: 'individual' | 'corporate' | 'agent'; tier?: 'lite' | 'pro' | 'enterprise';
    code: string;
  }) => Promise<void>;
  login: (p: {email?: string; phoneE164?: string; password: string}) =>
    Promise<{userId: string | null; phone: string | null; devOtpCode?: string}>;
  verifyOtp: (userId: string, code: string) => Promise<void>;
  completeAuth: () => Promise<void>;
  /**
   * Sign in with biometric if a previous session's refresh token is
   * still on disk. Prompts device biometric; on success refreshes the
   * access token and pulls `/auth/me` without ever asking for password.
   * Returns true when the user is fully authenticated; false otherwise
   * (caller falls back to the password form).
   */
  biometricSignIn: () => Promise<boolean>;
  // `wipeAtRest` (default FALSE) — a plain "Sign out" now PRESERVES local history
  // (the SQLCipher message DB + keychain key, scoped to the stable owner key, are
  // left intact so re-login re-opens the same encrypted store and history returns).
  // Only an explicit "Remove account from this device" passes {wipeAtRest:true} to
  // run the full P0-S1 at-rest destroy. (User decision 2026-06-26 — logout must not
  // erase chat history; the secure wipe moves to a dedicated remove-account action.)
  signOut: (opts?: {wipeAtRest?: boolean}) => Promise<void>;
  /**
   * §35A §F — CPO mid-session revocation re-check. Re-fetches /auth/me; if the
   * caller is a CPO whose `membership_status != 'active'` (suspended/removed), or
   * /auth/me 401/403s (the Step-4 session guard), it ends their access:
   * best-effort `setDuty(false)`, then the full `signOut()` teardown (drops the
   * CPO from Ops Rooms / wipes at-rest), and raises `accessEnded`. Otherwise it
   * refreshes the local user (so e.g. `must_set_password` clears post-activation).
   * No-op for individual / agency accounts.
   */
  recheckMembership: () => Promise<void>;
  /** Shared revocation teardown — idempotent. Used by recheckMembership and by the
   *  AccessEndedScreen mount (covers a boot/login as an already-suspended CPO). */
  endCpoAccess: (affiliation?: {owns_workspace?: boolean; workspaces?: unknown[]}) => Promise<void>;
  /** Clear the access-ended flag ("Return to sign in" on AccessEndedScreen). */
  clearAccessEnded: () => void;
  setRole: (role: UserRole) => Promise<void>;
  /**
   * Activate Bravo Pro: debit the Pro price in BC server-side and flip the
   * local user to the 'pro' tier. Throws on `insufficient_credits` so the
   * caller (paywall) can route into the card top-up fallback, then retry.
   */
  subscribeToPro: (autoRenew?: boolean) => Promise<void>;
  subscribeToTier: (tier: 'pro' | 'enterprise', autoRenew?: boolean) => Promise<void>;
  updateProfile: (updates: Partial<User>) => Promise<void>;
  /** Set (or clear with null) the device-local profile photo. Persists per-user
   *  and reflects everywhere that renders `user.avatar_url`. */
  setAvatar: (uri: string | null) => Promise<void>;
  /** Update the device-local display name. Persists per-user and reflects
   *  everywhere that renders `user.full_name`. */
  setDisplayName: (name: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState & AuthActions>()(
  immer(set => ({
    user: null,
    isAuthenticated: false,
    isLoading: false,
    isSigningOut: false,
    accessEnded: false,
    sessionUnverified: false,
    error: null,
    pendingUserId: null,
    pendingPhone: null,

    initialize: async () => {
      set(s => { s.isLoading = true; });
      try {
        const t = await tokenStore.get();
        if (!t) {return;}
        // Set once the boot /auth/me has blown its timeout budget and the
        // degraded session has taken over. The abandoned request may still
        // resolve minutes later — by then the user may have signed out, and
        // `requireLive` cannot protect it (at call time isAuthenticated was
        // legitimately false, so the flag could not be set).
        let bootMeAbandoned = false;
        const applyMe = async (opts?: {requireLive?: boolean}): Promise<void> => {
          const {user, account_kind, is_org_manager, permitted_modules, managed_org, org, must_set_password, membership_status, suspension, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency} = await authApi.me();
          set(s => {
            // requireLive (background refresh only): a signOut can land while
            // /auth/me is in flight — applying the result then would resurrect
            // the session the user just ended (and the snapshot subscriber
            // would re-persist it). The blocking first-login path must NOT set
            // this — there isAuthenticated is legitimately still false.
            if (opts?.requireLive && (!s.isAuthenticated || s.isSigningOut)) {return;}
            if (!opts?.requireLive && bootMeAbandoned) {return;}
            s.user = toUser(user, {account_kind, is_org_manager, permitted_modules, managed_org, membership_status, suspension, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency});
            s.isAuthenticated = true;
            // Server truth has landed — whatever we guessed from claims is gone.
            s.sessionUnverified = false;
          });
        };
        // Notif-latency D1 — optimistic boot. /auth/me was a BLOCKING network
        // roundtrip between process start and the Main navigator (and with it
        // the messenger runtime, FCM tap routing — everything), and a
        // transient failure left a valid session sitting on the login screen.
        // With a snapshot on disk, authenticate from it immediately and
        // re-verify in the background: a definitive 401/403 still clears the
        // tokens and tears the session down (mirrors the LB-API1 onAuthLost
        // teardown); anything transient keeps the session, and the axios
        // refresh interceptor owns recovery from there.
        const cached = await readUserSnapshot();
        if (cached) {
          set(s => { s.user = cached; s.isAuthenticated = true; });
          void applyMe({requireLive: true}).catch(async (e: unknown) => {
            const status = axios.isAxiosError(e) ? e.response?.status : undefined;
            if (status === 401 || status === 403) {
              await tokenStore.clear();
              const st = useAuthStore.getState();
              if (!st.isSigningOut && st.isAuthenticated) {st.signOut().catch(() => { /* self-guarded */ });}
            }
          });
          return;
        }
        // Warm-start FIX-02 — the SNAPSHOT-LESS boot. Reached on the first boot
        // after upgrading to the snapshot build, after a storage write blip, or
        // when the stored snapshot failed its shape check.
        //
        // This path used to `await applyMe()` unbounded: offline it sat on
        // "Verifying session…" for the full 15s axios timeout and then dropped a
        // user with perfectly valid tokens onto the LOGIN SCREEN. Two changes:
        // cap the wait, and treat "cannot reach the server" as a degraded
        // session rather than a signed-out one.
        try {
          await withTimeout(applyMe(), BOOT_ME_TIMEOUT_MS);
        } catch (e: unknown) {
          const status = axios.isAxiosError(e) ? e.response?.status : undefined;
          // A definitive rejection is still a sign-out. Only a transient
          // failure (offline, timeout, 5xx) earns the degraded session.
          if (status === 401 || status === 403) {throw e;}
          const claims = decodeAccessTokenClaims(t);
          if (!claims) {throw e;}
          bootMeAbandoned = true;
          set(s => {
            if (s.isSigningOut) {return;}
            s.user = minimalUserFromClaims(claims);
            s.isAuthenticated = true;
            s.sessionUnverified = false;
            s.sessionUnverified = true;
          });
          console.warn('[auth] offline boot — session restored from token claims, re-verifying in background');
          revalidateUnverifiedSession(applyMe).catch(() => { /* self-guarded */ });
        }
      } catch (e: unknown) {
        // Only wipe tokens on genuine auth failure (401/403). A network
        // error during boot (auth-service cold-starting, adb reverse
        // not yet wired, Wi-Fi blip) must NOT force the user to sign
        // in again — the refresh interceptor will recover naturally.
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        if (status === 401 || status === 403) {
          await tokenStore.clear();
        }
        // Intentionally swallow transient errors; UI stays unauthenticated
        // for this session but tokens remain for the next boot.
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    register: async ({email, password, fullName, phoneE164}) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        // Why: role/tier are server-controlled (DTO audit P0-V1). They're
        // accepted in the action signature only to carry UI/navigation
        // context to the OTP screen — never sent to /auth/register, which
        // 400s on those fields under STRICT_VALIDATION.
        const res = await authApi.register({
          email, password,
          displayName: fullName,
          phoneE164,
        });
        // No user row yet — we only track the pending phone for the OTP screen.
        set(s => { s.pendingUserId = null; s.pendingPhone = res.otpSentTo; });
        return {phone: res.otpSentTo};
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Registration failed';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    verifyRegister: async ({email, password, fullName, phoneE164, code}) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        const deviceId = await getDeviceId();
        // Why: role/tier are server-defaulted (DTO audit P0-V1); sending
        // them 400s under STRICT_VALIDATION. The server creates the user
        // as 'individual'/'lite' and returns the authoritative role.
        const resp = await authApi.registerVerify({
          email, password,
          displayName: fullName,
          phoneE164,
          code, deviceId, platform: DEVICE_PLATFORM,
        });
        const mapped = toUser(resp.user);
        set(s => {
          s.user = mapped;
          s.isAuthenticated = true;
          s.sessionUnverified = false;
          s.pendingUserId = null;
          s.pendingPhone = null;
        });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Verification failed';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    login: async ({email, phoneE164, password}) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        const res = await authApi.login({email, phoneE164, password});
        set(s => { s.pendingUserId = res.userId; s.pendingPhone = res.otpSentTo; });
        return {userId: res.userId, phone: res.otpSentTo, devOtpCode: res.devOtpCode};
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Sign in failed';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    verifyOtp: async (userId, code) => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        const deviceId = await getDeviceId();
        await authApi.verify({userId, code, deviceId, platform: DEVICE_PLATFORM});
        // Tokens persisted inside authApi.verify — don't flip isAuthenticated
        // yet; let the success screen call completeAuth.
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Invalid code';
        set(s => { s.error = msg; });
        throw e;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    completeAuth: async () => {
      try {
        // org_is_workspace rides EVERY /auth/me lane (the recheckMembership
        // comment says why) — dropping it here left a member's Workspace Hub
        // tile empty until the first recheck tick (toUser defaults it false).
        const {user, account_kind, is_org_manager, permitted_modules, managed_org, org, must_set_password, membership_status, suspension, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency} = await authApi.me();
        set(s => {
          s.user = toUser(user, {account_kind, is_org_manager, permitted_modules, managed_org, membership_status, suspension, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency});
          s.isAuthenticated = true;
          s.sessionUnverified = false;
          s.pendingUserId = null;
          s.pendingPhone = null;
        });
        setObservabilityUser(user.id);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Could not load profile';
        set(s => { s.error = msg; });
      }
    },

    biometricSignIn: async () => {
      set(s => { s.isLoading = true; s.error = null; });
      try {
        // A valid refresh token must exist — biometric doesn't *create*
        // a session, it unlocks an existing one. (Fresh installs or
        // post-signout states have no refresh token to unlock.)
        const refresh = await tokenStore.getRefresh();
        if (!refresh) {return false;}

        // Device must have hardware + be enrolled, otherwise the prompt
        // would no-op or hang indefinitely.
        const [hasHw, hasCreds] = await Promise.all([
          LocalAuthentication.hasHardwareAsync(),
          LocalAuthentication.isEnrolledAsync(),
        ]);
        if (!hasHw || !hasCreds) {return false;}

        const result = await LocalAuthentication.authenticateAsync({
          promptMessage:         'Sign in to Bravo Secure',
          fallbackLabel:         'Use device PIN',
          cancelLabel:           'Cancel',
          disableDeviceFallback: false,
        });
        if (!result.success) {return false;}

        // Swap the refresh token for a fresh access token, then pull
        // the profile. Both go through the axios interceptor so a
        // truly expired refresh token raises the usual 401 path.
        await authApi.refresh();
        // org_is_workspace: same rule as completeAuth — every lane carries it.
        const {user, account_kind, is_org_manager, permitted_modules, managed_org, org, must_set_password, membership_status, suspension, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency} = await authApi.me();
        set(s => {
          s.user = toUser(user, {account_kind, is_org_manager, permitted_modules, managed_org, membership_status, suspension, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency});
          s.isAuthenticated = true;
          s.sessionUnverified = false;
          s.pendingUserId = null;
          s.pendingPhone  = null;
        });
        setObservabilityUser(user.id);
        return true;
      } catch (e) {
        // Don't wipe tokens here — network flakes shouldn't force the
        // user back to password entry on the next attempt. Surface the
        // error so the UI can tell them something went wrong.
        const msg = e instanceof Error ? e.message : 'Biometric sign-in failed';
        set(s => { s.error = msg; });
        return false;
      } finally {
        set(s => { s.isLoading = false; });
      }
    },

    signOut: async (opts) => {
      // IDN-22 — re-entrancy guard: a second tap while the teardown is in
      // flight must be a no-op, not a concurrent second teardown.
      if (useAuthStore.getState().isSigningOut) {return;}
      // Raise the blocking "Signing out…" overlay for the whole teardown.
      // Every step below is best-effort and self-guarded; the flag clears
      // in the finally so a failed sign-out can't brick the button.
      set(s => { s.isSigningOut = true; });
      try {
      // Audit Step 2.1 — drop cached TURN creds so the next account never
      // reuses this user's session credentials (they are user-scoped).
      try {
        const {invalidateIceServers} = require('@/modules/messenger/webrtc/turnCredentials') as typeof import('@/modules/messenger/webrtc/turnCredentials');
        invalidateIceServers();
      } catch { /* module unavailable — nothing cached to clear */ }
      // Phase B — a workspace context must never outlive its user (the next
      // account would inherit the previous one's dept scope).
      try {
        const {clearActiveWorkspace} = require('./activeWorkspace') as typeof import('./activeWorkspace');
        clearActiveWorkspace();
      } catch { /* store unavailable in some test rigs */ }
      // getDeviceId is the only un-guarded await in this method; a failure
      // here must not strand the overlay, so make it best-effort too.
      let deviceId = '';
      try { deviceId = await getDeviceId(); } catch { /* device id unavailable */ }
      // Audit P0-S1 — capture the per-user persistence key NOW, before
      // any of the runtime/auth/registry tear-downs run. The wipe step
      // at the end of this method needs to know which SQLCipher DB
      // filename + keychain entries to destroy; _resetMessengerRuntime
      // nulls productionConfig, so we'd lose the key otherwise.
      let ownerKeyForWipe: string | null = null;
      try {
        const {getActiveOwnerKey} = require('@/modules/messenger/runtime') as
          typeof RuntimeModule;
        ownerKeyForWipe = getActiveOwnerKey();
      } catch { /* runtime not configured — no DB to wipe */ }
      // Audit P0-N2 — revoke the messenger-service push tokens BEFORE
      // authApi.signOut() runs. Once auth invalidates the JTI, the
      // DELETE /push/register* calls would 401 against JwtHttpGuard's
      // revocation check. Without this, the previous user's FCM token
      // + iOS PushKit token stay registered server-side; when the next
      // user signs in on the same physical device they inherit those
      // tokens and receive chat/VoIP wakes meant for the prior account.
      // Best-effort with a 4s timeout each so a slow relay doesn't stall
      // the logout flow.
      try {
        const {revokeServerPushTokens} = require('@/modules/messenger/push/unregisterPush') as
          typeof UnregisterPushModule;
        await revokeServerPushTokens();
      } catch { /* push module not loaded — fine */ }
      /**
       * B-632 — ship pending backup work BEFORE the JTI dies.
       *
       * `mirrorRemoval` queues a SYNTHETIC tombstone (the SQL row is already
       * deleted, so nothing can re-derive it) and `disposeMirror` below does
       * `queue.length = 0`. A user who deleted a message — or a chat, via the
       * conversation queue — and signed out inside the 1.5s flush debounce lost
       * the deletion PERMANENTLY: `mirror_flushed` still holds that row's live
       * version, so the next boot sweep skips it by design (I1) and logging
       * back in never heals it. The server kept the message and every future
       * restore resurrected it — silently reverting B-594/B-605.
       *
       * ⚠️ POSITION IS THE FIX. This must run before `authApi.signOut`, for the
       * same reason the push-token revoke above does: once auth invalidates the
       * JTI, `putMessages` 401s, `flush()` classifies `unauthorized` as
       * RETRYABLE, the batch is requeued — and `disposeMirror` then throws it
       * away. Placed after, this code would ship nothing while every mocked
       * test passed. `authStore.signOut.test.ts` pins the ordering by source
       * scan for exactly that reason.
       *
       * Bounded, because sign-out must never hang: `Promise.race` against 2s.
       * It ABANDONS rather than cancels, which is safe — `disposeMirror` bumps
       * `mirrorSessionGen`, so an in-flight flush that lands afterwards goes
       * stale before it can write the ledger, while the pending-commit flag it
       * raised BEFORE uploading survives for the next boot to heal (I2).
       */
      let drainTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const mirror = require('@/modules/messenger/backup/messageMirror') as typeof MessageMirrorModule;
        if (mirror.isMirrorEnabled()) {
          const queued = mirror.mirrorOutboxSize();
          const startedAt = Date.now();
          let completed = false;
          await Promise.race([
            (async () => {
              // ORDER IS LOAD-BEARING: drain FIRST. `fireMerkleHookNowIfPending`
              // only fires when the debounce slot is armed, and it is the
              // drain's own flushes that arm it. Firing first would find the
              // gate false, skip the commit, then upload — leaving rows on the
              // server with the pending flag set and no covering commit, which
              // is the I2 window this whole block exists to close.
              await mirror.drainMirrorOutbox();
              // The exported form of B1's gate — a sign-out with nothing owed
              // costs no network at all.
              await mirror.fireMerkleHookNowIfPending();
              completed = true;
            // The `catch` on the IIFE is NOT redundant with the outer one: the
            // outer catch only sees a rejection that WINS the race. One that
            // arrives after the timeout already won belongs to a promise nobody
            // is awaiting any more, and RN reports it as "Possible Unhandled
            // Promise Rejection" in release — on the teardown path, of all
            // places. Both mirror calls swallow internally today, so this
            // cannot fire yet; it is one refactor away from being able to.
            })().catch(() => { /* already abandoned — nothing left to report to */ }),
            new Promise<void>(resolve => { drainTimer = setTimeout(resolve, 2000); }),
          ]);
          // Marker so this is verifiable in a post-install device log (founder
          // rule). `console.warn` survives release builds; `console.log` does
          // not. Counts + ms + an outcome enum ONLY — never a body or an id (I9).
          // Silent when there was nothing owed, so it marks the case that matters.
          if (queued > 0) {
            console.warn(
              `[bravo.backup.signout] queued=${queued} ${completed ? 'drained' : 'timeout'} ms=${Date.now() - startedAt}`,
            );
          }
        }
      } catch { /* best-effort — a failed drain must never block sign-out */ } finally {
        // Without this every sign-out leaves a live 2s handle. Harmless in
        // production (it resolves an already-settled promise) but it pads every
        // test in this file, which uses REAL timers, and trips
        // --detectOpenHandles.
        if (drainTimer) {clearTimeout(drainTimer);}
      }
      try { await authApi.signOut(deviceId); } catch { /* ignore */ }
      // Item H — incident DRAFTS can name people, places and security events;
      // they must not outlive the account on a shared device (the per-user
      // key stops cross-account READS, not persistence). Lazy require, same
      // pattern as every module below.
      try {
        const {clearAllIncidentDrafts} = require('@screens/deptchat/incidentDraft') as
          typeof import('@screens/deptchat/incidentDraft');
        await clearAllIncidentDrafts();
      } catch { /* module not loaded — fine */ }
      // Clear any pending incoming-1:1 banner left from the previous
      // session — without this, an offer that arrived seconds before
      // logout would resurrect on the login screen of the next user
      // and prompt them to accept a call meant for the prior account.
      try {

        const banner = require('@/modules/messenger/webrtc/incomingOneToOneBanner') as typeof IncomingOneToOneBannerModule;
        banner.clearPendingOneToOne();
      } catch { /* module not available — fine */ }
      // Round 2 / Architecture audit: end any active 1:1 or group call
      // BEFORE we tear the runtime down. Without this, a logout during
      // an active call left the floating overlay's subscriber pinned,
      // the controller still holding the (now-stale) CallSignalling
      // referencing the still-open socket, and the audioSessionStartedFor
      // set retaining the callId. Logging back in re-rendered the overlay
      // over the new user's home screen.
      try {

        // WI-1.1 — logout means "end whatever is live", so it reads the live
        // entry's own key. 'remote' preserves the pre-WI-1.1 default.
        const {endActiveCall, getActiveCall} = require('@/modules/messenger/runtime/callRegistry') as typeof CallRegistryModule;
        const liveDirect = getActiveCall();
        if (liveDirect) {endActiveCall({callId: liveDirect.callId, gen: liveDirect.gen}, 'ended', 'remote');}
      } catch { /* no active call — fine */ }
      try {

        // Unkeyed on purpose: logout ends whatever is live, and names no room.
        const {endActiveGroupCall} = require('@/modules/messenger/runtime/groupCallRegistry') as typeof GroupCallRegistryModule;
        await endActiveGroupCall();
      } catch { /* no active group call — fine */ }
      // Round 2 fix: stop any in-progress ringtone/ringback so it can't
      // bleed into the login screen of the next user.
      try {

        const {stopAllTones} = require('@/modules/messenger/runtime/bravoTones') as typeof BravoTonesModule;
        await stopAllTones();
      } catch { /* expo-av not available in tests — fine */ }
      // Round 8 — tear down the backup mirror BEFORE the runtime so a
      // pending flush doesn't fire under the new owner. Clears the
      // queue, dedup cache, master key handle, owner gate, AppState
      // hook. Also stops the mirrorBootstrap subscription so a stale
      // store update doesn't push messages into the post-dispose void.
      // And locks identityBackup's pinned master key so an attacker
      // who got the device after logout can't trigger a re-mirror.
      try {

        const {disposeMirror} = require('@/modules/messenger/backup/messageMirror') as typeof MessageMirrorModule;
        disposeMirror();
      } catch { /* module not loaded yet — fine */ }
      try {

        const {stopMirrorBootstrap} = require('@/modules/messenger/backup/mirrorBootstrap') as typeof MirrorBootstrapModule;
        stopMirrorBootstrap();
      } catch { /* module not loaded yet — fine */ }
      // B-655 — drop the contact-discovery session cache. Its entries are
      // keyed by the signed-in user's phone, so the next account cannot read
      // them, but they hold SERVER directory matches (userId, display name,
      // avatar url) and there is no reason to keep another account's directory
      // resident in memory after a logout.
      try {

        const {clearDiscoveredContactsCache} =
          require('@/modules/messenger/contacts/useDiscoveredContacts') as typeof DiscoveredContactsModule;
        clearDiscoveredContactsCache();
      } catch { /* module not loaded yet — fine */ }
      try {

        const {lockIdentityBackup} = require('@/modules/messenger/backup/identityBackup') as typeof IdentityBackupModule;
        lockIdentityBackup();
      } catch { /* module not loaded yet — fine */ }

      // Audit fixes #1/#9/#12/#21: tear down the messenger runtime
      // before wiping auth state. Without this:
      //   - the heartbeat interval keeps pinging an unauthorized
      //     socket (Fix #1)
      //   - ExpirySweeper keeps firing against a soon-to-be-stale DB
      //     (Fix #9)
      //   - call/transport registries hold stale refs (Fix #12)
      //   - FCM token-refresh listener stays attached (Fix #21)
      try {

        const {disposeLiveRuntime} = require('@/modules/messenger/runtime/productionRuntime') as typeof ProductionRuntimeModule;
        disposeLiveRuntime();
      } catch { /* runtime not built yet — fine */ }
      try {

        const {_resetMessengerRuntime} = require('@/modules/messenger/runtime') as typeof RuntimeModule;
        _resetMessengerRuntime();
      } catch { /* ignore */ }
      // Round 8 / false-active audit — wipe cached presence on logout.
      // setOwner() also clears it on the next user-switch, but an
      // explicit signOut without a follow-up login (or before the
      // next user logs in) would otherwise leave the previous
      // session's online dots visible behind any sign-in screen
      // surface that reads from the messenger store.
      try {

        const {useMessengerStore} = require('@/modules/messenger/store/messengerStore') as typeof MessengerStoreModule;
        useMessengerStore.getState().clearAllPresence();
      } catch { /* store not loaded yet — fine */ }
      // Round 2 fix: clearLiveTransport now also closes the underlying
      // socket (see transportRegistry.ts) so the previous user's WS is
      // gone from the fd and the persisted recoveryPid is wiped.
      try {

        const {clearLiveTransport} = require('@/modules/messenger/runtime/transportRegistry') as typeof TransportRegistryModule;
        clearLiveTransport();
      } catch { /* ignore */ }
      // Round 2 / Architecture audit: every WebRTC dispatcher kept its
      // module-level Maps populated across logouts. A late-arriving
      // call.offer / sfu.new-producer / sfu.ring.incoming would route
      // into the prior user's listener closures (which themselves
      // pin unmounted screens and a torn-down mediasoup Device). Drop
      // them all so the next user's session boots from a clean slate.
      try {

        const {clearAllCallDispatchState} = require('@/modules/messenger/webrtc/callDispatcher') as typeof CallDispatcherModule;
        clearAllCallDispatchState();
      } catch { /* ignore */ }
      try {

        const {clearAllSfuHandlers} = require('@/modules/messenger/webrtc/sfuDispatcher') as typeof SfuDispatcherModule;
        clearAllSfuHandlers();
      } catch { /* ignore */ }
      try {

        const {clearAllRoomIdentities} = require('@/modules/messenger/webrtc/groupCallIdentityRegistry') as typeof GroupCallIdentityRegistryModule;
        clearAllRoomIdentities();
      } catch { /* ignore */ }
      try {
        // Audit BS-LEAK — drop any stashed minimize→restore mediasoup
        // handles so logout doesn't pin the prior user's transports.
        const {clearAllLiveSfuHandles} = require('@/modules/messenger/webrtc/useGroupCall') as typeof import('@/modules/messenger/webrtc/useGroupCall');
        clearAllLiveSfuHandles();
      } catch { /* ignore */ }
      try {

        const {clearAllGroupCallRingHandlers} = require('@/modules/messenger/webrtc/groupCallRingDispatcher') as typeof GroupCallRingDispatcherModule;
        clearAllGroupCallRingHandlers();
      } catch { /* ignore */ }
      try {

        const {clearRtt} = require('@/modules/messenger/runtime/rttRegistry') as typeof RttRegistryModule;
        clearRtt();
      } catch { /* ignore */ }
      try {

        const {stopFcmBootstrap} = require('@/modules/messenger/push/fcmBootstrap') as typeof FcmBootstrapModule;
        stopFcmBootstrap();
      } catch { /* native module missing — fine */ }
      try {
        // B-324/B-325 — a wake landing after logout must not boot the
        // runtime: drop the killed-app drain's persisted config record.
        const {clearHeadlessRuntimeConfig} =
          require('@/modules/messenger/push/headlessDrain') as
            typeof import('@/modules/messenger/push/headlessDrain');
        await clearHeadlessRuntimeConfig();
      } catch { /* record absent or storage blip — fine */ }
      try {
        // Round 5 / Security S3 — burn the per-device VoIP wake key on
        // logout. Without this, a future login on the same device would
        // inherit the previous user's key and reject every signed wake
        // (or worse, accept wakes minted under the wrong identity).

        const {clearVoipWakeKey} = require('@/modules/messenger/push/voipWakeVerify') as typeof VoipWakeVerifyModule;
        await clearVoipWakeKey();
      } catch { /* keychain missing or no key persisted — fine */ }
      // Audit P0-S1 — destroy every at-rest artifact tied to this
      // user: the SQLCipher DB file (op-sqlite native delete clears
      // .db + .db-wal + .db-shm), the per-user keychain entries
      // (SQLCipher key, group-wrap key, mirror master key), and the
      // owner's vault slice in AsyncStorage. Runs LAST in this method
      // so the runtime/registry tear-downs above have already closed
      // their handles — wipeUserAtRest re-opens the SQLCipher file
      // just to call its native `delete()`. Best-effort; the per-step
      // WipeReport is logged so telemetry can flag a stuck phone.
      //
      // GATED (2026-06-26) — only on an EXPLICIT remove-account
      // (opts.wipeAtRest). A plain "Sign out" leaves the encrypted DB +
      // key intact so re-login restores chat history; the destroy is
      // reserved for "Remove account from this device". The DB/key are
      // keyed to the STABLE owner key, so a non-wiping logout re-opens
      // the same store on the next login.
      if (ownerKeyForWipe && opts?.wipeAtRest) {
        try {
          const {wipeUserAtRest} =
            require('@/modules/messenger/runtime/wipeAtRest') as
              typeof import('@/modules/messenger/runtime/wipeAtRest');
          const report = await wipeUserAtRest(ownerKeyForWipe);
          if (report.errors.length > 0) {
            console.warn('[authStore.signOut] wipeUserAtRest partial:', report);
          }
        } catch (e) {
          // Catastrophic wipe failure (module load error, etc.) — log
          // but do not block the logout. The user's auth state is
          // gone; a subsequent login attempt will get the residual
          // wiped on its next signOut.
          console.warn('[authStore.signOut] wipeUserAtRest failed', e);
        }
      }
      // Reset the in-memory app stores so the next account that signs in on
      // this device doesn't briefly see the previous user's wallet balance
      // or bookings before the refetch. These are memory-only (no persist
      // middleware), so a process-alive logout would otherwise retain them.
      try {
        const {useWalletStore} = require('@store/walletStore') as typeof WalletStoreModule;
        useWalletStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      try {
        const {useBookingStore} = require('@store/bookingStore') as typeof BookingStoreModule;
        useBookingStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      // PDF-1 #1 — the Secure Pro APPLICATION store must reset too, or the next
      // account on this device inherits the previous user's `application`/
      // `hasLoaded`, and the tier resolver (SecureLandingScreen) decides
      // IMMEDIATELY on that stale ACTIVE row — auto-routing the new user into the
      // prior user's Pro dashboard (their plan header / credits) for the refetch
      // window. The neutral chooser used to absorb this; the tier-routed landing
      // no longer does.
      try {
        const {useSecureProStore} = require('@store/secureProStore') as typeof import('@store/secureProStore');
        useSecureProStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      // Issue 30/20 — the VAULT store is the one here that PERSISTS
      // (AsyncStorage 'bravo-vault-v1'), so it survived sign-out. The next
      // account on this device inherited the previous user's pinHash, which
      // made hasPin() true, which made openVault() route to the PIN keypad —
      // "asked for a six-digit PIN even though the user has never created one".
      // It also carried over the failed-attempt/lockout counters and the local
      // file index, so this is a data-separation fix, not just a routing one.
      //
      // B-696 (2026-08-29, founder-approved — VAULT_DURABILITY_DESIGN §3) —
      // the wipe destroyed the ONLY copy of the per-file AES keys, so a plain
      // sign-out/sign-in permanently orphaned the user's own vault while chat
      // history (gated wipe above) survived. Isolation now comes from OWNER
      // SCOPING: the flat slice is stashed under this owner and CLEARED, so
      // the next account still sees hasPin() === false and zero files, and
      // this owner's next sign-in adopts the stash back (MainNavigator's
      // ownerKey effect). Remove-account keeps total destruction via
      // purgeOwner — the vault goes with the at-rest wipe, stash included.
      try {
        const {useVaultStore, disarmVaultIndexSync} = require('@/modules/messenger/vault') as
          typeof import('@/modules/messenger/vault');
        // B-696 Phase D — stop the index sync FIRST so the stash/clear swap
        // below cannot be misread as a content change worth publishing.
        disarmVaultIndexSync();
        if (opts?.wipeAtRest) {
          useVaultStore.getState().purgeOwner(ownerKeyForWipe);
        } else {
          useVaultStore.getState().stashAndClearOwner(ownerKeyForWipe);
        }
      } catch { /* store not loaded — fine */ }
      // B-91 M0 — forget the active product so the next account on this
      // device gets the product gate instead of the previous user's choice.
      try {
        const {useProductStore} = require('@store/productStore') as typeof import('@store/productStore');
        useProductStore.getState().reset();
      } catch { /* store not loaded — fine */ }
      // MOB-1 — the emergency call log PERSISTS (AsyncStorage
      // 'bravo-emergency-call-log') and its store contract claims it is "wiped
      // on sign-out with the rest of the local state" — but nothing wired that.
      // Left unreset, the next account on this device reads the previous user's
      // crisis-call history (dialled numbers + next-of-kin labels) in the Calls
      // Log. Clear it here AND purge the persisted copy so it cannot rehydrate.
      try {
        const {useEmergencyCallLog} = require('@store/emergencyCallLog') as typeof import('@store/emergencyCallLog');
        useEmergencyCallLog.getState().clear();
        useEmergencyCallLog.persist?.clearStorage?.();
      } catch { /* store not loaded — fine */ }
      // MOB-2 — the protection-session GPS streamer is a module singleton whose
      // only stop() caller is the ProLiveMission screen on terminal status. A
      // sign-out mid-session left a high-accuracy watch running on the login
      // screen, flushing coordinates under a cleared token (401/refresh storm)
      // and, if user B then logs in, POSTing A's sessionId under B's JWT. Stop
      // it here so logout keeps the consent promise ("stops when you end
      // protection") and no location leaves the device post-logout.
      try {
        const {protectionLocationService} = require('@services/protectionLocationService') as typeof import('@services/protectionLocationService');
        protectionLocationService.stop();
      } catch { /* service not loaded — fine */ }
      // MOB-6 — the activity-sync watermark reset + foreground listener had NO
      // prod caller, so the notification cursor leaked across accounts on this
      // device. Stop the foreground listener and purge every watermark key so the
      // next identity re-syncs its full inbox (the per-user key is the primary
      // guard; this is the cleanup half).
      try {
        const {resetActivitySyncWatermark, stopActivitySync} =
          require('@store/activitySync') as typeof import('@store/activitySync');
        stopActivitySync();
        await resetActivitySyncWatermark();
      } catch { /* store not loaded — fine */ }
      // MOB-7 — the notification feed is identity-scoped, but its wipe hinges on
      // MainNavigator's setOwner() effect firing for the NEXT user. A sign-out that
      // stops at the login screen (or any surface reading activityStore before the
      // next login's effect runs) would otherwise show the previous user's feed.
      // Same reasoning as the presence wipe above — clear it explicitly here.
      try {
        const {useActivityStore} = require('@store/activityStore') as typeof import('@store/activityStore');
        // B-706 — wipeLocal, NOT clear: `clear()` is the user's own dismiss-all and
        // records tombstones. Tombstoning on sign-out would suppress this account's
        // whole history if they simply signed back in (setOwner only drops the ledger
        // when the identity CHANGES). A privacy wipe leaves no deletion state behind.
        useActivityStore.getState().wipeLocal();
      } catch { /* store not loaded — fine */ }
      // RS-07 — clear the provider-signup bridge flag on logout. Without this a
      // user who tapped "Service Provider" but never finished POST /agents stays
      // pinned to the agency shell (resolveAuthedRoute pendingProvider fallback)
      // on the NEXT account that signs in on this device.
      try { await pendingProvider.clear(); } catch { /* storage blip — fine */ }
      cancelSessionRevalidation();
      set(s => {
        s.user = null;
        s.isAuthenticated = false;
        s.sessionUnverified = false;
        s.pendingUserId = null;
        s.pendingPhone = null;
      });
      setObservabilityUser(null);
      } finally {
        set(s => { s.isSigningOut = false; });
      }
    },

    recheckMembership: async () => {
      try {
        const {user, account_kind, is_org_manager, permitted_modules, managed_org, org, must_set_password, membership_status, suspension, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency} = await authApi.me();
        if (account_kind === 'cpo' && membership_status && membership_status !== 'active') {
          // Agency revoked/suspended this CPO — end their access, handing over
          // the affiliation we JUST fetched. Reading it back off the store here
          // would consult the snapshot this branch is about to skip writing.
          await useAuthStore.getState().endCpoAccess({owns_workspace, workspaces});
          return;
        }
        // Still active (or not a CPO) — just refresh the local user so a freshly
        // cleared must_set_password / changed org name reflects immediately.
        // org_is_workspace MUST ride along: this runs on every foreground
        // resume, and dropping it snapped every workspace surface back to
        // agency wording 30s after boot (toUser defaults it false).
        // Audit round 2 — this is a fresh /auth/me, i.e. server truth: it must
        // also clear a degraded-session flag. This lane is precisely the
        // "healer once the revalidate ladder expires" the FIX-02 comment
        // promised, but it installed the verified user WITHOUT clearing the
        // flag — so the snapshot subscriber refused to persist any snapshot
        // for the rest of the process, making the next boot snapshot-less
        // again (self-perpetuating degraded boots).
        set(s => {
          s.user = toUser(user, {account_kind, is_org_manager, permitted_modules, managed_org, membership_status, suspension, org, must_set_password, cpo_needs_onboarding, auto_dispatch_enabled, owns_workspace, org_is_workspace, workspaces, owns_agency});
          s.sessionUnverified = false;
        });
      } catch (e: unknown) {
        // A 401/403 on the re-check is a revocation signal ONLY for a managed
        // CPO — the §35A session guard fail-closes a suspended/removed CPO and
        // that shell is designed to eject on it. Since RS-06 this catch also runs
        // on foreground-resume for EVERY shell, where a 401 can equally be a
        // TRANSIENT refresh outage (e.g. auth-service mid-deploy: the interceptor
        // rejects with the original /auth/me 401 when /auth/refresh is briefly
        // unreachable). Force-logging client/agency users out on that would be a
        // false-positive logout wave, so we only tear down for CPOs; a genuinely
        // revoked client/agency user is caught by their next real API call, not by
        // a resume re-check. A transient network error (no response) is never a
        // revocation for anyone.
        const status = axios.isAxiosError(e) ? e.response?.status : undefined;
        const isCpo = useAuthStore.getState().user?.account_kind === 'cpo';
        if (isCpo && (status === 401 || status === 403)) {
          await useAuthStore.getState().endCpoAccess();
        }
      }
    },

    endCpoAccess: async (affiliation?: {owns_workspace?: boolean; workspaces?: unknown[]}) => {
      // Idempotent: once the teardown has run (flag raised) a second call is a no-op,
      // so recheckMembership and the AccessEndedScreen mount can both call it safely.
      if (useAuthStore.getState().accessEnded) {return;}

      /**
       * ── DOES THIS PERSON HAVE A LIFE OUTSIDE THE AGENCY? ─────────────────
       *
       * Scope v2 Phase 6 established that a workspace OWNER keeps their session
       * when an unrelated org revokes their CPO membership — tearing it down
       * would drop Ops Rooms, wipe at-rest and clear tokens for somebody whose
       * own Enterprise workspace is untouched. vs2 item 4 widened that to any
       * workspace affiliation: Chidi is an officer at Meridian and an EMPLOYEE
       * of workspace Acme, owns nothing, and was being signed out of Acme
       * because Meridian suspended him.
       *
       * ⚠️ THE FLAG IS NOW PART OF THE GUARD, not raised before it.
       *
       * `accessEnded` is not a mild signal — `RootNavigator` renders ONLY
       * `AccessEndedScreen` while it is true, so `resolveAuthedRoute` never
       * runs and the routing fix that sends this person to the client shell is
       * unreachable. Raising it first meant Chidi reached Acme for exactly one
       * boot, then the next foreground recheck (and, since the hub calls
       * recheckMembership on focus, every visit to the hub) threw him onto a
       * dead-end screen whose only button returns him to the same loop. The
       * screen also tells him he was signed out, which this branch specifically
       * does not do.
       *
       * @param affiliation the CALLER'S FRESH copy. recheckMembership has just
       *   fetched /auth/me and returns without storing it on this path, so the
       *   store still holds the previous snapshot — and a snapshot written by a
       *   build predating `workspaces` reads `undefined`, which fails open into
       *   a full teardown. Read the argument, fall back to the store only for
       *   callers that have no fresher answer (the AccessEndedScreen mount).
       */
      const stored = useAuthStore.getState().user;
      const ownsWs = affiliation?.owns_workspace ?? stored?.owns_workspace;
      const wsCount = (affiliation?.workspaces ?? stored?.workspaces)?.length ?? 0;
      const keepSession = ownsWs === true || wsCount > 0;

      if (!keepSession) {set(s => { s.accessEnded = true; });}
      // Best-effort either way: take the guard off duty so dispatch stops
      // ranking them. Their CPO role has ended even when the session has not.
      try { await agentApi.setDuty(false); } catch { /* offline / already revoked — fine */ }

      // The CPO shell still ejects for a kept session — resolveAuthedRoute sees
      // the revoked membership plus the workspace affiliation and routes to the
      // client shell, which is where a workspace member belongs.
      if (keepSession) {return;}

      // Full teardown — drops the CPO from Ops Rooms, tears down the runtime, wipes
      // at-rest, clears tokens. accessEnded survives this (signOut doesn't touch it).
      await useAuthStore.getState().signOut();
    },

    clearAccessEnded: () =>
      set(s => { s.accessEnded = false; }),

    setRole: async () => { /* no-op: role chosen at registration */ },

    subscribeToPro: async (autoRenew = false) => {
      await useAuthStore.getState().subscribeToTier('pro', autoRenew);
    },

    subscribeToTier: async (tier, autoRenew = false) => {
      // Server is the source of truth — it debits BC + flips the tier
      // atomically and returns the new state. We mirror it locally so the
      // UI (badges, gated screens) updates without a full /auth/me refetch.
      const {data} = await subscriptionApi.subscribeTier(tier, autoRenew);
      set(s => {
        if (s.user) {
          s.user.subscription_tier = data.subscription_tier;
          s.user.pro_active_until = data.active_until;
        }
      });
    },

    updateProfile: async updates => {
      set(s => {
        if (s.user) {Object.assign(s.user, updates);}
      });
    },

    setAvatar: async uri => {
      // Optimistic local update for instant UI, then persist server-side; the
      // server response is the source of truth and /auth/me returns it on every
      // future boot/login (so it reflects everywhere + across devices).
      set(s => { if (s.user) { s.user.avatar_url = uri ?? undefined; } });
      try {
        const {user} = await authApi.updateProfile({avatar_url: uri});
        set(s => { s.user = toUser(user, routingOf(s.user)); });
      } catch (e: unknown) {
        set(s => { s.error = e instanceof Error ? e.message : 'Could not update photo'; });
        throw e;
      }
    },

    setDisplayName: async name => {
      const trimmed = name.trim();
      if (!trimmed) {return;}
      set(s => { if (s.user) { s.user.full_name = trimmed; } });
      try {
        const {user} = await authApi.updateProfile({display_name: trimmed});
        set(s => { s.user = toUser(user, routingOf(s.user)); });
      } catch (e: unknown) {
        set(s => { s.error = e instanceof Error ? e.message : 'Could not update name'; });
        throw e;
      }
    },

    clearError: () =>
      set(s => { s.error = null; }),
  })),
);

// Notif-latency D1 — keep the boot snapshot in lockstep with the live user.
// ONE subscriber instead of a write at every mutation site (login, OTP verify,
// profile edits, /auth/me refresh, signOut): the repo's most common bug shape
// is N drifted copies of one behaviour, so the persistence lives in exactly
// one place. `user` is immer-produced, so a reference compare catches every
// change; user → null (signOut / teardown) removes the snapshot so the next
// boot cannot resurrect a signed-out session.
let lastSnapshotUser: User | null = null;
useAuthStore.subscribe(state => {
  const u = state.user;
  if (u === lastSnapshotUser) {return;}
  // Warm-start FIX-02 — never persist a claims-derived user. It carries none
  // of the §35A routing fields, so snapshotting it would turn one offline boot
  // into a permanently wrong shell: every later boot would authenticate from
  // the guess and skip the blocking /auth/me that would have corrected it.
  // Leaving the previous snapshot (or none) in place is strictly safer.
  if (u && state.sessionUnverified) {return;}
  lastSnapshotUser = u;
  if (u) {
    AsyncStorage.setItem(USER_SNAPSHOT_KEY, JSON.stringify(u)).catch(() => { /* storage blip — next change retries */ });
  } else {
    AsyncStorage.removeItem(USER_SNAPSHOT_KEY).catch(() => { /* storage blip */ });
  }
});
