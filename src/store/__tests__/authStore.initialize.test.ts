/**
 * Notif-latency D1 (docs/audits/NOTIF_TAP_TO_MESSAGE_LATENCY_2026-08-01.md) —
 * optimistic boot from the persisted user snapshot.
 *
 * `initialize()` used to BLOCK on /auth/me before setting `isAuthenticated`,
 * so every cold boot waited a full network roundtrip before RootNavigator
 * would mount Main — and with it the messenger runtime, FCM tap routing,
 * everything. Worse, a transient network error left a perfectly valid
 * session on the LOGIN SCREEN (tokens intact, user absent).
 *
 * The fix: when tokens AND a user snapshot exist on disk, authenticate from
 * the snapshot immediately and re-verify via /auth/me in the background. A
 * definitive 401/403 from that background check still clears tokens and
 * tears the session down (mirrors the LB-API1 onAuthLost path). We exercise
 * the REAL store logic with the API layer mocked, same harness as
 * authStore.recheckMembership.test.ts.
 */
jest.mock('@services/api', () => ({
  authApi: {me: jest.fn()},
  agentApi: {setDuty: jest.fn(() => Promise.resolve())},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  tokenStore: {get: jest.fn(), getRefresh: jest.fn(), set: jest.fn(), clear: jest.fn(() => Promise.resolve())},
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
jest.mock('expo-local-authentication', () => ({}));

const asyncStore: Record<string, string> = {};
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn(async (k: string) => asyncStore[k] ?? null),
    setItem: jest.fn(async (k: string, v: string) => { asyncStore[k] = v; }),
    removeItem: jest.fn(async (k: string) => { delete asyncStore[k]; }),
    multiSet: jest.fn(async () => {}),
    multiRemove: jest.fn(async () => {}),
  },
}));

import {useAuthStore, cancelSessionRevalidation} from '@store/authStore';
import {authApi, tokenStore} from '@services/api';

const mockMe = authApi.me as jest.Mock;
const mockTokenGet = tokenStore.get as jest.Mock;
const mockTokenClear = tokenStore.clear as jest.Mock;
const mockSignOut = jest.fn(() => Promise.resolve());

const SNAPSHOT_KEY = 'auth:user_snapshot';

const SNAPSHOT_USER = {
  id: 'u1', email: 'snap@x.io', full_name: 'Snap Shot', role: 'individual',
  subscription_tier: 'lite', must_set_password: false,
  cpo_needs_onboarding: false, auto_dispatch_enabled: false,
};

const API_USER = {
  id: 'u1', email: 'snap@x.io', display_name: 'Fresh Name', role: 'individual',
  subscription_tier: 'lite', phone_e164: '+10000000000',
};

// A real-shaped access token — auth-service signs {sub, role, device_id, jti,
// exp} (apps/auth-service/src/auth/jwt.service.ts). Only the payload segment
// matters here; the claims path never verifies the signature.
const b64url = (o: unknown): string =>
  Buffer.from(JSON.stringify(o)).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
const JWT = `hdr.${b64url({sub: 'u1', role: 'individual', device_id: 'dev-1', exp: 9999999999})}.sig`;

function axios401(status: number): Error {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    isAxiosError: true,
    response: {status},
  });
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) { await Promise.resolve(); }
  await new Promise(r => setTimeout(r, 0));
  for (let i = 0; i < 8; i++) { await Promise.resolve(); }
};

describe('authStore.initialize — optimistic boot from the user snapshot (D1)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Object.keys(asyncStore).forEach(k => { delete asyncStore[k]; });
    useAuthStore.setState({
      user: null, isAuthenticated: false, isLoading: false,
      isSigningOut: false, accessEnded: false, sessionUnverified: false,
      signOut: mockSignOut,
    });
  });

  // The degraded path arms a re-verify ladder on real timers. Left running it
  // would poll /auth/me across the rest of the file (and hold the run open).
  afterEach(() => { cancelSessionRevalidation(); jest.useRealTimers(); });

  it('token + snapshot → authenticated from disk even when /auth/me is unreachable', async () => {
    mockTokenGet.mockResolvedValue('tok');
    asyncStore[SNAPSHOT_KEY] = JSON.stringify(SNAPSHOT_USER);
    mockMe.mockRejectedValue(new Error('Network Error'));

    await useAuthStore.getState().initialize();
    await flush();

    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.user?.id).toBe('u1');
    expect(st.isLoading).toBe(false);
    // Transient failure must not destroy the session.
    expect(mockTokenClear).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
  });

  it('the background /auth/me refresh overwrites the snapshot user with server truth', async () => {
    mockTokenGet.mockResolvedValue('tok');
    asyncStore[SNAPSHOT_KEY] = JSON.stringify(SNAPSHOT_USER);
    mockMe.mockResolvedValue({user: API_USER});

    await useAuthStore.getState().initialize();
    await flush();

    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.user?.full_name).toBe('Fresh Name');
  });

  it('a definitive 401 from the background refresh clears tokens and signs out', async () => {
    mockTokenGet.mockResolvedValue('tok');
    asyncStore[SNAPSHOT_KEY] = JSON.stringify(SNAPSHOT_USER);
    mockMe.mockRejectedValue(axios401(401));

    await useAuthStore.getState().initialize();
    await flush();

    expect(mockTokenClear).toHaveBeenCalled();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('no snapshot → the blocking path is unchanged (me() success authenticates)', async () => {
    mockTokenGet.mockResolvedValue('tok');
    mockMe.mockResolvedValue({user: API_USER});

    await useAuthStore.getState().initialize();

    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.user?.full_name).toBe('Fresh Name');
  });

  // ── Warm-start FIX-02 — the snapshot-less offline boot ────────────────────
  // Previously: "unauthenticated but tokens KEPT". That rule dropped a user
  // with perfectly valid tokens onto the LOGIN SCREEN whenever the server was
  // unreachable and no snapshot existed (first boot after the snapshot build
  // shipped, a storage write blip, or a shape-rejected snapshot).

  it('no snapshot + transient me() failure → DEGRADED session from token claims, tokens KEPT', async () => {
    mockTokenGet.mockResolvedValue(JWT);
    mockMe.mockRejectedValue(new Error('Network Error'));

    await useAuthStore.getState().initialize();

    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.sessionUnverified).toBe(true);
    expect(st.user?.id).toBe('u1');
    expect(st.user?.role).toBe('individual');
    expect(mockTokenClear).not.toHaveBeenCalled();
  });

  it('the degraded user is NEVER persisted as a boot snapshot', async () => {
    mockTokenGet.mockResolvedValue(JWT);
    mockMe.mockRejectedValue(new Error('Network Error'));

    await useAuthStore.getState().initialize();
    await flush();

    // A guessed identity carries no §35A routing fields — snapshotting it
    // would make a wrong shell durable across every later boot.
    expect(asyncStore[SNAPSHOT_KEY]).toBeUndefined();
  });

  it('no snapshot + a definitive 401 still clears tokens (no degraded session)', async () => {
    mockTokenGet.mockResolvedValue(JWT);
    mockMe.mockRejectedValue(axios401(401));

    await useAuthStore.getState().initialize();

    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(false);
    expect(st.sessionUnverified).toBe(false);
    expect(mockTokenClear).toHaveBeenCalled();
  });

  it('no snapshot + an UNDECODABLE token → stays unauthenticated (cannot guess a shell)', async () => {
    mockTokenGet.mockResolvedValue('not-a-jwt');
    mockMe.mockRejectedValue(new Error('Network Error'));

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().sessionUnverified).toBe(false);
    expect(mockTokenClear).not.toHaveBeenCalled();
  });

  // Real timers on purpose. Driving this with fake timers means advancing them
  // from inside a promise chain that has not reached `withTimeout` yet — the
  // await then never settles, jest kills the test with the fakes still
  // installed, and every later test in the file hangs on setTimeout.
  it('a hung /auth/me does not hold the boot open — the timeout degrades instead', async () => {
    mockTokenGet.mockResolvedValue(JWT);
    mockMe.mockReturnValue(new Promise(() => { /* never settles */ }));

    const startedAt = Date.now();
    await useAuthStore.getState().initialize();
    const elapsed = Date.now() - startedAt;

    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.sessionUnverified).toBe(true);
    expect(st.isLoading).toBe(false);
    // Bounded by BOOT_ME_TIMEOUT_MS, nowhere near the 15s axios timeout that
    // used to hold "Verifying session…" on screen.
    expect(elapsed).toBeLessThan(8_000);
  }, 20_000);

  it('recheckMembership heals a degraded session: flag cleared, snapshot persisted (audit round 2)', async () => {
    // Offline longer than the revalidate ladder, then network returns and the
    // foreground re-check succeeds. This lane is the promised healer — it must
    // clear sessionUnverified, or the snapshot subscriber refuses to persist
    // for the rest of the process and every next boot is degraded again.
    mockTokenGet.mockResolvedValue(JWT);
    mockMe.mockRejectedValue(new Error('Network Error'));
    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().sessionUnverified).toBe(true);

    mockMe.mockResolvedValue({user: API_USER});
    await useAuthStore.getState().recheckMembership();
    await flush();

    expect(useAuthStore.getState().sessionUnverified).toBe(false);
    expect(asyncStore[SNAPSHOT_KEY]).toBeTruthy();
    expect((JSON.parse(asyncStore[SNAPSHOT_KEY]) as {full_name: string}).full_name).toBe('Fresh Name');
  });

  it('a snapshot missing `role` cannot drive the role-gated navigator — falls back to the claims path', async () => {
    mockTokenGet.mockResolvedValue(JWT);
    asyncStore[SNAPSHOT_KEY] = JSON.stringify({...SNAPSHOT_USER, role: undefined});
    mockMe.mockRejectedValue(new Error('Network Error'));

    await useAuthStore.getState().initialize();
    await flush();

    // The unusable snapshot is ignored; the claims fallback keeps the user in.
    const st = useAuthStore.getState();
    expect(st.isAuthenticated).toBe(true);
    expect(st.sessionUnverified).toBe(true);
  });

  it('no token → never authenticates, snapshot or not', async () => {
    mockTokenGet.mockResolvedValue(null);
    asyncStore[SNAPSHOT_KEY] = JSON.stringify(SNAPSHOT_USER);

    await useAuthStore.getState().initialize();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(mockMe).not.toHaveBeenCalled();
  });

  it('a background refresh that resolves AFTER a sign-out must not resurrect the session', async () => {
    mockTokenGet.mockResolvedValue('tok');
    asyncStore[SNAPSHOT_KEY] = JSON.stringify(SNAPSHOT_USER);
    let resolveMe: (v: unknown) => void = () => {};
    mockMe.mockReturnValue(new Promise(r => { resolveMe = r; }));

    await useAuthStore.getState().initialize();
    expect(useAuthStore.getState().isAuthenticated).toBe(true);

    // The user signs out while /auth/me is still in flight.
    useAuthStore.setState({user: null, isAuthenticated: false});
    resolveMe({user: API_USER});
    await flush();

    expect(useAuthStore.getState().isAuthenticated).toBe(false);
    expect(useAuthStore.getState().user).toBeNull();
    // And the snapshot must stay cleared — not re-persisted by the late refresh.
    expect(asyncStore[SNAPSHOT_KEY]).toBeUndefined();
  });

  it('the store subscriber persists the user on change and clears it when the user goes null', async () => {
    useAuthStore.setState({user: SNAPSHOT_USER as never, isAuthenticated: true});
    await flush();
    expect(asyncStore[SNAPSHOT_KEY]).toBeTruthy();
    expect((JSON.parse(asyncStore[SNAPSHOT_KEY]) as {id: string}).id).toBe('u1');

    useAuthStore.setState({user: null, isAuthenticated: false});
    await flush();
    expect(asyncStore[SNAPSHOT_KEY]).toBeUndefined();
  });
});
