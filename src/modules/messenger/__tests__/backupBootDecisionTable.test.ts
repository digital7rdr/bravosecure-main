/**
 * backupBoot — the sign-in state machine, driven end to end.
 *
 * This function decides, before `installIdentity` can run, whether the user's
 * history is recoverable. Getting a branch wrong here is not a cosmetic bug:
 *
 *   • P3-B-4 — the RESTORE gate must NEVER fall through to the runtime. Booting
 *     it writes a brand-new Signal identity over the recoverable one, after
 *     which `localKeyExists` is true forever and the gate never fires again.
 *     Both give-up paths (nav never ready, navigate throws) therefore return
 *     WITHOUT booting.
 *   • BUG-C — restore mode is armed at the BOOT DECISION, not at screen mount,
 *     because the settle window is up to 60s and a push-driven runtime boot in
 *     that gap installs a throwaway identity.
 *   • F5 — RESUME-AUTO must call `startMirrorBootstrap()` BEFORE `setMirrorKey`.
 *     `setMirrorKey` fires the disabled→enabled catch-up sweep, but only if the
 *     sweep is already wired; the reversed order left it null at flip time, so
 *     boot-window / offline-delivered messages silently never reached the
 *     backup.
 *   • A network or 5xx probe failure must NOT be read as "no backup" — that
 *     would let SUGGEST overwrite a real one.
 *   • Founder rule 2026-08-04 — for an ORG account a prior "not now" and an
 *     empty chat list no longer suppress the setup prompt.
 *
 * Only the edges are mocked (HTTP probe, keychain, runtime, navigation); the
 * owner-scoped flag store, the restore-resume markers and `restoreMode` are the
 * real modules over an in-memory AsyncStorage.
 */

const mockAsyncStore = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockAsyncStore.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockAsyncStore.set(k, v); },
    removeItem: async (k: string) => { mockAsyncStore.delete(k); },
  },
}));

jest.mock('../backup/backupClient', () => ({
  __esModule: true,
  BackupError: class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  },
  backupClient: {getIdentityHeader: jest.fn()},
}));
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  hasDbKey:            jest.fn(async () => true),
  loadMirrorMasterKey: jest.fn(async () => null),
}));
jest.mock('../store/messengerStore', () => ({
  __esModule: true,
  useMessengerStore: {getState: jest.fn(() => ({conversations: {}}))},
}));
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  setMirrorKey: jest.fn(),
}));
jest.mock('../backup/mirrorBootstrap', () => ({
  __esModule: true,
  startMirrorBootstrap: jest.fn(),
}));
jest.mock('../runtime', () => ({
  __esModule: true,
  getOwnCryptoStore: jest.fn(() => ({
    getIdentityKeyPair: async () => ({
      pubKey:  new Uint8Array(32).fill(3).buffer,
      privKey: new Uint8Array(32).fill(9).buffer,
    }),
  })),
}));
jest.mock('../backup/restoreBackground', () => ({
  __esModule: true,
  startBackgroundRestore: jest.fn(() => true),
}));

import {runBackupBoot} from '../backup/backupBoot';
import {backupClient, BackupError} from '../backup/backupClient';
import {hasDbKey, loadMirrorMasterKey} from '../runtime/keychain';
import {useMessengerStore} from '../store/messengerStore';
import {setMirrorKey} from '../backup/messageMirror';
import {startMirrorBootstrap} from '../backup/mirrorBootstrap';
import {isRestoreModeActive, setRestoreModeActive} from '../backup/restoreMode';
import {
  BACKUP_ENABLED_KEY_PREFIX, LEGACY_BACKUP_ENABLED_KEY, LEGACY_BACKUP_SKIPPED_KEY,
  setBackupEnabled, setBackupSkipped,
} from '../backup/backupFlags';

const OWNER_KEY  = 'owner@mail';
const OWNER_UUID = 'owner-uuid-1';
const RESTORE_ROUTE = ['Main', {screen: 'MessengerTab', params: {screen: 'BackupRestore'}}];
const SETUP_ROUTE   = ['Main', {screen: 'MessengerTab', params: {screen: 'BackupSetup'}}];

const header = backupClient.getIdentityHeader as jest.Mock;
const mockHasDbKey = hasDbKey as jest.Mock;
const mockLoadMirrorKey = loadMirrorMasterKey as jest.Mock;
const storeState = (useMessengerStore as unknown as {getState: jest.Mock}).getState;

function makeNav(opts: {ready?: boolean; navigate?: jest.Mock} = {}): {
  isReady: () => boolean; navigate: jest.Mock;
} {
  return {isReady: () => opts.ready ?? true, navigate: opts.navigate ?? jest.fn()};
}

function boot(nav: ReturnType<typeof makeNav>, over: Record<string, unknown> = {}): Promise<void> {
  return runBackupBoot(nav as never, {
    ownerKey:            OWNER_KEY,
    legacyOwnerId:       OWNER_UUID,
    getMessengerRuntime: jest.fn(async () => ({})),
    ...over,
  } as never);
}

const key32B64 = Buffer.alloc(32, 5).toString('base64');
const settle = (ms = 900): Promise<void> => new Promise(r => setTimeout(r, ms));

beforeEach(() => {
  jest.clearAllMocks();
  mockAsyncStore.clear();
  setRestoreModeActive(false);
  mockHasDbKey.mockResolvedValue(true);
  mockLoadMirrorKey.mockResolvedValue(null);
  storeState.mockReturnValue({conversations: {}});
  header.mockResolvedValue({userId: OWNER_UUID});
});
afterEach(() => { setRestoreModeActive(false); jest.useRealTimers(); });

describe('backupBoot — RESTORE gate (fresh install with a recoverable backup)', () => {
  it('routes to the nested BackupRestore screen and does NOT boot the runtime', async () => {
    mockHasDbKey.mockResolvedValue(false);
    const nav = makeNav();
    const getRuntime = jest.fn(async () => ({}));

    await boot(nav, {getMessengerRuntime: getRuntime});

    // Booting here would run installIdentity and permanently disarm the gate.
    expect(getRuntime).not.toHaveBeenCalled();
    expect(nav.navigate).toHaveBeenCalledWith(...RESTORE_ROUTE);
    // BUG-C — armed at the decision, not at screen mount.
    expect(isRestoreModeActive()).toBe(true);
  });

  it('P3-B-4 — HOLDS the gate (runtime NOT booted) when navigation never readies', async () => {
    mockHasDbKey.mockResolvedValue(false);
    const nav = makeNav({ready: false});
    const getRuntime = jest.fn(async () => ({}));

    jest.useFakeTimers();
    const done = boot(nav, {getMessengerRuntime: getRuntime});
    // The readiness ceiling is a generous 60s precisely so we never give up
    // early and fall through.
    await jest.advanceTimersByTimeAsync(61_000);
    await done;

    expect(getRuntime).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
    // Nothing was armed, and no local key was written, so the gate re-arms on
    // the next boot instead of being lost.
    expect(isRestoreModeActive()).toBe(false);
  });

  it('P3-B-4 — retries the navigate 3× and still refuses to boot the runtime', async () => {
    mockHasDbKey.mockResolvedValue(false);
    const navigate = jest.fn(() => { throw new Error('navigator not mounted'); });
    const nav = makeNav({navigate});
    const getRuntime = jest.fn(async () => ({}));

    jest.useFakeTimers();
    const done = boot(nav, {getMessengerRuntime: getRuntime});
    await jest.advanceTimersByTimeAsync(3_000);
    await done;

    expect(navigate).toHaveBeenCalledTimes(3);
    expect(getRuntime).not.toHaveBeenCalled();
    // The in-memory flag is cleared on the give-up path so a crash can never
    // leave the user permanently unreachable.
    expect(isRestoreModeActive()).toBe(false);
  });
});

describe('backupBoot — server probe classification', () => {
  it('a NETWORK failure is not "no backup": nothing is suggested and nothing is overwritten', async () => {
    header.mockRejectedValue(new Error('ETIMEDOUT'));
    storeState.mockReturnValue({conversations: {c1: {}}});
    const nav = makeNav();
    const getRuntime = jest.fn(async () => ({}));

    await boot(nav, {getMessengerRuntime: getRuntime});
    await settle();

    expect(getRuntime).toHaveBeenCalled();       // the app keeps working
    expect(nav.navigate).not.toHaveBeenCalled(); // …but SUGGEST must not fire
    expect(startMirrorBootstrap).not.toHaveBeenCalled();
  });

  it('service_disabled degrades to PASSTHROUGH — the app boots without backup', async () => {
    header.mockRejectedValue(new BackupError('service_disabled', 'no supabase creds'));
    mockHasDbKey.mockResolvedValue(false); // would be RESTORE if the probe counted
    const nav = makeNav();
    const getRuntime = jest.fn(async () => ({}));

    await boot(nav, {getMessengerRuntime: getRuntime});
    await settle();

    expect(getRuntime).toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
    expect(isRestoreModeActive()).toBe(false);
  });

  it('a runtime init failure returns quietly without any secondary action', async () => {
    header.mockRejectedValue(new BackupError('no_backup', '404'));
    storeState.mockReturnValue({conversations: {c1: {}}});
    const nav = makeNav();

    await boot(nav, {getMessengerRuntime: jest.fn(async () => { throw new Error('sqlcipher_locked'); })});
    await settle();

    expect(nav.navigate).not.toHaveBeenCalled();
    expect(startMirrorBootstrap).not.toHaveBeenCalled();
  });
});

describe('backupBoot — RESUME (device already knows this backup)', () => {
  it('F5 — RESUME-AUTO wires the sweep BEFORE flipping the key live', async () => {
    await setBackupEnabled(OWNER_KEY);
    mockLoadMirrorKey.mockResolvedValue(key32B64);
    const nav = makeNav();

    await boot(nav);

    expect(setMirrorKey).toHaveBeenCalledTimes(1);
    expect(startMirrorBootstrap).toHaveBeenCalledTimes(1);
    // setMirrorKey fires the disabled→enabled catch-up sweep, which is a NO-OP
    // unless startMirrorBootstrap already installed it. Reversed, every
    // boot-window / offline-delivered message silently missed the backup.
    expect((startMirrorBootstrap as jest.Mock).mock.invocationCallOrder[0])
      .toBeLessThan((setMirrorKey as jest.Mock).mock.invocationCallOrder[0]);
    // No password prompt when the keychain could resume us.
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('RESUME-LOCKED — no keychain key still starts the subscription, then prompts', async () => {
    await setBackupEnabled(OWNER_KEY);
    mockLoadMirrorKey.mockResolvedValue(null);
    const nav = makeNav();

    await boot(nav);
    await settle();

    expect(setMirrorKey).not.toHaveBeenCalled();
    // Started anyway, so post-unlock writes are picked up.
    expect(startMirrorBootstrap).toHaveBeenCalledTimes(1);
    expect(nav.navigate).toHaveBeenCalledWith(...SETUP_ROUTE);
  });

  it('a CORRUPT keychain entry falls back to the prompt instead of throwing', async () => {
    await setBackupEnabled(OWNER_KEY);
    // 16 bytes — importMasterKey rejects `master_key_wrong_length`.
    mockLoadMirrorKey.mockResolvedValue(Buffer.alloc(16, 2).toString('base64'));
    const nav = makeNav();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(boot(nav)).resolves.toBeUndefined();
    await settle();

    expect(setMirrorKey).not.toHaveBeenCalled();
    expect(nav.navigate).toHaveBeenCalledWith(...SETUP_ROUTE);
    warn.mockRestore();
  });

  it('adopts a LEGACY global enabled flag into owner scope (P3-B-2 migration)', async () => {
    mockAsyncStore.set(LEGACY_BACKUP_ENABLED_KEY, '1');
    mockLoadMirrorKey.mockResolvedValue(key32B64);
    const nav = makeNav();

    await boot(nav);

    // Safe here — this branch already server-confirmed a backup for THIS owner.
    expect(mockAsyncStore.get(`${BACKUP_ENABLED_KEY_PREFIX}${OWNER_KEY}`)).toBe('1');
    expect(setMirrorKey).toHaveBeenCalledTimes(1);
  });

  it('with NO enabled flag it only wires the subscription — no key, no prompt', async () => {
    mockLoadMirrorKey.mockResolvedValue(key32B64);
    const nav = makeNav();

    await boot(nav);
    await settle();

    expect(startMirrorBootstrap).toHaveBeenCalledTimes(1);
    expect(setMirrorKey).not.toHaveBeenCalled();
    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

describe('backupBoot — SUGGEST / PASSTHROUGH (no server backup yet)', () => {
  beforeEach(() => { header.mockRejectedValue(new BackupError('no_backup', '404')); });

  it('suggests setup once the user actually has chats', async () => {
    storeState.mockReturnValue({conversations: {c1: {}}});
    const nav = makeNav();

    await boot(nav);
    await settle();

    expect(nav.navigate).toHaveBeenCalledWith(...SETUP_ROUTE);
  });

  it('stays quiet with no chats, and after the user has skipped once', async () => {
    const nav = makeNav();
    await boot(nav);
    await settle();
    expect(nav.navigate).not.toHaveBeenCalled();

    await setBackupSkipped(OWNER_KEY);
    storeState.mockReturnValue({conversations: {c1: {}}});
    const nav2 = makeNav();
    await boot(nav2);
    await settle();
    expect(nav2.navigate).not.toHaveBeenCalled();
  });

  it('honours a LEGACY global skip so an upgraded app does not re-prompt forever', async () => {
    mockAsyncStore.set(LEGACY_BACKUP_SKIPPED_KEY, '1');
    storeState.mockReturnValue({conversations: {c1: {}}});
    const nav = makeNav();

    await boot(nav);
    await settle();

    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it('ORG ACCOUNT — a prior skip and an empty chat list no longer suppress setup', async () => {
    // Founder-decided 2026-08-04: department posts are E2EE and local-only, so
    // deleting the app destroys the workspace history. An employee who tapped
    // "not now" on day one otherwise had no recovery for the life of the
    // account, and a newly approved member (zero chats) is exactly WHEN setup
    // should happen — before there is any history to lose.
    await setBackupSkipped(OWNER_KEY);
    storeState.mockReturnValue({conversations: {}});
    const nav = makeNav();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await boot(nav, {isOrgAccount: true});
    await settle();

    expect(nav.navigate).toHaveBeenCalledWith(...SETUP_ROUTE);
    // The release-visible marker (console.log is stripped from release builds).
    expect(warn.mock.calls.flat().join(' ')).toContain('ORG ACCOUNT');
    warn.mockRestore();
  });

  it('ORG ACCOUNT — an owner who ALREADY enabled backup is not shoved back into setup', async () => {
    await setBackupEnabled(OWNER_KEY);
    const nav = makeNav();

    await boot(nav, {isOrgAccount: true});
    await settle();

    expect(nav.navigate).not.toHaveBeenCalled();
  });
});

/**
 * Warm-start FIX-11 — the pre-runtime probe must not hold the boot for 30s.
 *
 * `backupClient` bounds every request at 30s, and this probe runs BEFORE the
 * runtime boots. On a reachable-but-hanging network that is 30s of dead app for
 * anyone whose lane has no other runtime builder — a user who lands on
 * Secure/ProductGate rather than a messenger screen, where useMessenger() would
 * have started the build in parallel.
 *
 * The budget is gated on `localKeyExists`, and that gate IS the safety
 * argument: the destructive outcome (fall through, boot the runtime, let
 * installIdentity write a fresh identity over a recoverable one, permanently
 * disarming the RESTORE gate — P3-B-4) requires !localKeyExists. A fresh
 * install therefore keeps the full budget; it happens once, and correctness
 * there outranks startup latency.
 */
describe('FIX-11 — the boot probe budget', () => {
  it('does not wait 30s for a hanging probe when a local key already exists', async () => {
    mockHasDbKey.mockResolvedValue(true);
    header.mockImplementation(() => new Promise(() => { /* hangs like a dead network */ }));
    const runtime = jest.fn(async () => ({}));
    const nav = makeNav();

    const startedAt = Date.now();
    await boot(nav, {getMessengerRuntime: runtime});
    const elapsed = Date.now() - startedAt;

    expect(elapsed).toBeLessThan(20_000);
    // And it still reached the runtime — the whole point is that the app boots.
    expect(runtime).toHaveBeenCalled();
  }, 40_000);

  it('a timed-out probe takes the SAME conservative branch as a network failure', async () => {
    mockHasDbKey.mockResolvedValue(true);
    header.mockImplementation(() => new Promise(() => { /* hangs */ }));
    const nav = makeNav();

    await boot(nav);
    await settle();

    // Never read as "no backup" — that would let SUGGEST overwrite a real one.
    expect(nav.navigate).not.toHaveBeenCalledWith(...SETUP_ROUTE);
    expect(nav.navigate).not.toHaveBeenCalledWith(...RESTORE_ROUTE);
  }, 40_000);

  it('a FRESH INSTALL keeps the full budget — the RESTORE gate outranks latency', async () => {
    // No local key: this is exactly the state where falling through early would
    // let installIdentity clobber a recoverable identity forever.
    mockHasDbKey.mockResolvedValue(false);
    let settleProbe: (v: unknown) => void = () => {};
    header.mockImplementation(() => new Promise(r => { settleProbe = r; }));
    const runtime = jest.fn(async () => ({}));
    const nav = makeNav();

    const booting = boot(nav, {getMessengerRuntime: runtime});
    // Well past the shortened budget — a fresh install must still be waiting.
    await settle(9_000);
    expect(runtime).not.toHaveBeenCalled();

    settleProbe({});
    await booting;
    await settle();
  }, 40_000);
});
