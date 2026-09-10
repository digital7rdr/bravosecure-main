/**
 * Where the session tokens actually live.
 *
 * Warm-start FIX-01. Access + refresh JWTs used to sit in plain AsyncStorage —
 * on Android that is an unencrypted SharedPreferences/SQLite file, readable by
 * any ADB backup, any root shell, and any file-level forensic tool. Every OTHER
 * secret in this app (SQLCipher DB key, group-wrap key, mirror master key,
 * VoIP wake key) is hardware-backed via react-native-keychain; the tokens that
 * authorize all of it were the exception.
 *
 * `tokenStore` in `@services/api` stays the only public accessor — the
 * architecture reference names it as the injected `getToken` seam for the
 * messenger runtime, so nothing outside this file should know the difference.
 *
 * Two properties this module has to keep:
 *   - **Readable headlessly while the screen is locked.** A data-only FCM wake
 *     drains messages with the phone in a pocket; `AFTER_FIRST_UNLOCK` is the
 *     weakest class that survives that, and `_THIS_DEVICE_ONLY` keeps the entry
 *     off iCloud Keychain and out of a device transfer.
 *   - **Cheap on the hot path.** Every authed request reads the access token,
 *     so a keystore round-trip per request is not acceptable — an in-memory
 *     cache fronts it and is invalidated by `set`/`clear`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const SERVICE = 'bravo.auth.session';
const ACCOUNT = 'bravo-session';

/**
 * react-native-keychain destructures `NativeModules.RNKeychainManager` at
 * MODULE LOAD, so a static import hard-throws anywhere that native module is
 * absent — the node jest projects, and any JS context whose `react-native`
 * shim is partial. This module is imported by the headless FCM drain, so an
 * import-time throw there would take out killed-app message delivery.
 *
 * Same rule the rest of this repo's headless-safe modules follow: lazy-require
 * the native dep, and degrade to storage when it is not there (see
 * `usable` in KeychainRead).
 */
type KeychainApi = {
  getGenericPassword(o: {service: string}): Promise<false | {username: string; password: string}>;
  setGenericPassword(u: string, p: string, o: Record<string, unknown>): Promise<unknown>;
  resetGenericPassword(o: {service: string}): Promise<unknown>;
  ACCESSIBLE: Record<string, string>;
};

let keychainMod: KeychainApi | null | undefined;

function keychain(): KeychainApi | null {
  if (keychainMod !== undefined) {return keychainMod;}
  try {
    keychainMod = require('react-native-keychain') as KeychainApi;
    if (typeof keychainMod?.getGenericPassword !== 'function') {keychainMod = null;}
  } catch {
    keychainMod = null;
  }
  if (!keychainMod) {
    console.warn('[tokenVault] keychain unavailable in this context — using storage fallback');
  }
  return keychainMod;
}

/** Pre-FIX-01 locations. Read once for migration, then deleted. */
const LEGACY_ACCESS_KEY = 'auth:access_token';
const LEGACY_REFRESH_KEY = 'auth:refresh_token';

interface SessionTokens {
  access: string | null;
  refresh: string | null;
}

const EMPTY: SessionTokens = {access: null, refresh: null};

let cache: SessionTokens | null = null;
let loading: Promise<SessionTokens> | null = null;

/**
 * B-15b class — `getGenericPassword` can transiently return false or throw
 * (Android Keystore miss under load, MIUI/StrongBox flakiness) even when an
 * entry exists. For a DB key a false miss mints a new key and orphans the
 * database; here it would silently sign the user out. Retry before believing
 * "no entry". Kept local rather than imported from the messenger keychain
 * helper so the auth bootstrap does not pull the messenger module graph in.
 */
/**
 * `usable` distinguishes "the keychain answered, and the answer is no entry"
 * from "the keychain is not available here at all". That difference decides
 * whether the result may be CACHED: an unusable keychain must fall through to
 * storage on every read, exactly like the pre-FIX-01 code, or a context
 * without a keystore would serve one stale answer forever.
 */
interface KeychainRead {
  usable: boolean;
  password: string | null;
}

async function readKeychainWithRetry(attempts = 3, baseDelayMs = 100): Promise<KeychainRead> {
  let usable = false;
  for (let i = 0; i < attempts; i++) {
    try {
      const kc = keychain();
      if (!kc) {return {usable: false, password: null};}
      const res = await kc.getGenericPassword({service: SERVICE});
      // It answered — even `false` is an answer ("no entry").
      usable = true;
      if (res && res.password) {return {usable: true, password: res.password};}
      // A genuine empty vault is indistinguishable from a miss on the first
      // try, so only a full pass of attempts may conclude "empty".
    } catch (e) {
      // A TypeError here means the JS wrapper loaded but the NATIVE bridge is
      // absent (`NativeModules.RNKeychainManager` undefined) — permanent in
      // this context, not a flaky keystore. Retrying it just burns the retry
      // ladder's ~300ms on every single read, so disable the module instead.
      // A real Android keystore failure throws a plain Error and still retries.
      if (e instanceof TypeError) {
        keychainMod = null;
        console.warn('[tokenVault] keychain native module absent — using storage fallback');
        return {usable: false, password: null};
      }
      if (i === attempts - 1) {
        console.warn('[tokenVault] keychain read failed:', (e as Error).message);
      }
    }
    if (i < attempts - 1) {
      await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  return {usable, password: null};
}

async function clearLegacy(): Promise<void> {
  await AsyncStorage.removeItem(LEGACY_ACCESS_KEY);
  await AsyncStorage.removeItem(LEGACY_REFRESH_KEY);
}

function parse(raw: string | null): SessionTokens {
  if (!raw) {return EMPTY;}
  try {
    const o = JSON.parse(raw) as {a?: unknown; r?: unknown};
    return {
      access: typeof o.a === 'string' && o.a ? o.a : null,
      refresh: typeof o.r === 'string' && o.r ? o.r : null,
    };
  } catch { return EMPTY; }
}

async function writeKeychain(t: SessionTokens): Promise<boolean> {
  try {
    const kc = keychain();
    if (!kc) {return false;}
    await kc.setGenericPassword(ACCOUNT, JSON.stringify({a: t.access, r: t.refresh}), {
      service: SERVICE,
      accessible: kc.ACCESSIBLE.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
    });
    return true;
  } catch (e) {
    if (e instanceof TypeError) {keychainMod = null;}
    console.warn('[tokenVault] keychain write failed:', (e as Error).message);
    return false;
  }
}

/**
 * One-time move of pre-FIX-01 tokens into the keychain.
 *
 * Order matters: write, prove it reads back, and only then delete the plaintext
 * copy. The opposite order turns one keystore hiccup into a signed-out user
 * with no way back — so a failed migration deliberately LEAVES the legacy keys
 * in place and simply serves them from there until the next attempt.
 */
async function migrateFromAsyncStorage(keychainUsable: boolean): Promise<LoadResult> {
  // Why getItem twice rather than one multiGet: this runs in a dozen different
  // JS contexts (headless FCM VM, the app, three jest projects) and `getItem`
  // is the primitive every one of them actually provides. One extra read on a
  // once-per-install path is not worth a shape dependency.
  let tokens: SessionTokens;
  try {
    tokens = {
      access: await AsyncStorage.getItem(LEGACY_ACCESS_KEY),
      refresh: await AsyncStorage.getItem(LEGACY_REFRESH_KEY),
    };
  } catch { return {tokens: EMPTY, authoritative: keychainUsable}; }
  if (!tokens.access && !tokens.refresh) {
    return {tokens: EMPTY, authoritative: keychainUsable};
  }

  if (await writeKeychain(tokens)) {
    const readBack = parse((await readKeychainWithRetry()).password);
    if (readBack.access === tokens.access && readBack.refresh === tokens.refresh) {
      try {
        await clearLegacy();
        console.log('[tokenVault] migrated session tokens to the keychain');
      } catch { /* the plaintext copy outlives one attempt — retried next boot */ }
      return {tokens: readBack, authoritative: true};
    }
  }
  // Keychain unusable on this device/right now: keep working off the legacy
  // copy rather than locking the user out. NOT authoritative — the next read
  // must consult storage again instead of trusting a cached copy.
  console.warn('[tokenVault] migration deferred — serving tokens from legacy storage');
  return {tokens, authoritative: false};
}

interface LoadResult {
  tokens: SessionTokens;
  /**
   * True when the answer came from a keychain that actually works. Only an
   * authoritative answer may be cached: otherwise a context with no keystore
   * (a jest project, an OEM with a broken keystore) would freeze the first
   * answer it ever got and stop seeing writes made through AsyncStorage.
   */
  authoritative: boolean;
}

async function load(): Promise<LoadResult> {
  const read = await readKeychainWithRetry(knownEmpty ? 1 : 3);
  const fromKeychain = parse(read.password);
  // Audit round 2 — LEGACY PRESENCE WINS. The invariant: whenever the legacy
  // keys exist, they are at least as new as the keychain — migration deletes
  // them only after a VERIFIED keychain write, and set()'s fallback writes
  // them only when the keychain write FAILED (so the keychain holds the older
  // pair). Preferring the keychain here re-installed a rotated-out token pair
  // after one transient keystore write failure, and the resulting stale
  // refresh 401 force-signed the user out. Routing through the migration also
  // self-heals: the newer pair gets written into the keychain and legacy is
  // swept. Costs two AsyncStorage reads on a once-per-process cold load.
  let legacyPresent = false;
  try {
    legacyPresent =
      (await AsyncStorage.getItem(LEGACY_ACCESS_KEY)) !== null ||
      (await AsyncStorage.getItem(LEGACY_REFRESH_KEY)) !== null;
  } catch { /* storage blip — the keychain result stands */ }
  if (legacyPresent) {
    return migrateFromAsyncStorage(read.usable);
  }
  if (fromKeychain.access || fromKeychain.refresh) {
    return {tokens: fromKeychain, authoritative: true};
  }
  return {tokens: EMPTY, authoritative: read.usable};
}

/**
 * Audit fix (FIX-01 round 2) — every set()/clear() bumps this, and a load may
 * only install its result into the cache if the world has not moved since it
 * started. Without it, two stale-load races: a load in flight when signOut
 * cleared re-cached the signed-out user's tokens for the rest of the process,
 * and a load in flight when a refresh rotated tokens overwrote the FRESH pair
 * with the previous one — a guaranteed 401 storm.
 */
let epoch = 0;

/**
 * Audit round 2 (perf) — once a load has concluded "authoritatively empty",
 * later loads skip the B-15b retry ladder (1 attempt, no sleeps). While signed
 * out, EVERY pre-auth request (login POST, OTP verify) goes through the axios
 * interceptor → getAccess(), and the full 3-attempt ladder burned ~300ms of
 * sleeps per request for an answer that was honestly "no entry". The ladder
 * exists for the flaky-keystore FALSE miss on a real entry; after one whole
 * pass has said empty, treating the next miss as another lie buys nothing.
 * Reset on every set()/clear() epoch bump — a login must get the full ladder
 * again.
 */
let knownEmpty = false;

/** Read both tokens, hitting the keychain at most once per process (plus writes). */
async function get(): Promise<SessionTokens> {
  if (cache) {return cache;}
  // Single-flight: a cold boot fires several authed requests at once and each
  // would otherwise start its own keystore read + migration.
  if (!loading) {
    const startedIn = epoch;
    loading = load().then(
      r => {
        // Two gates on installing the result:
        //  - the epoch: a set()/clear() that landed mid-load owns the truth
        //    now, and this result describes a world that no longer exists
        //    (its value is still RETURNED to the callers that awaited it —
        //    they raced, they get the racy answer — it just must not stick);
        //  - authoritative + non-empty: an EMPTY result is never cached,
        //    because "signed out" is the one state that changes out of band
        //    and a signed-out app issues no authed requests anyway.
        if (epoch === startedIn) {
          if (r.authoritative && (r.tokens.access || r.tokens.refresh)) {
            cache = r.tokens;
          } else if (r.authoritative) {
            // Perf fast-path: the next load skips the retry sleeps.
            knownEmpty = true;
          }
        }
        loading = null;
        return r.tokens;
      },
      e => { loading = null; throw e; },
    );
  }
  return loading;
}

export const tokenVault = {
  getAccess: async (): Promise<string | null> => (await get()).access,
  getRefresh: async (): Promise<string | null> => (await get()).refresh,

  set: async (access: string, refresh: string): Promise<void> => {
    const next: SessionTokens = {access, refresh};
    // Cache first: a concurrent request must never see the OLD token after a
    // refresh has produced a new one (that is a guaranteed 401 + retry storm).
    epoch += 1;
    knownEmpty = false;
    cache = next;
    loading = null;
    if (!(await writeKeychain(next))) {
      // Degrade to the legacy location rather than dropping the session, and
      // drop the cache — with no working keychain, storage is the truth and a
      // cached copy would shadow a write made anywhere else.
      cache = null;
      try {
        await AsyncStorage.setItem(LEGACY_ACCESS_KEY, access);
        await AsyncStorage.setItem(LEGACY_REFRESH_KEY, refresh);
      } catch { /* nothing left to try */ }
    }
  },

  clear: async (): Promise<void> => {
    // Audit fix (FIX-01 round 2) — cache EMPTY, not null. clear() awaits the
    // keychain reset below; a get() fired by an in-flight request during that
    // window used to start a fresh load, read the NOT-YET-DELETED entry, and
    // cache the signed-out user's tokens. Caching EMPTY parks every read on
    // "signed out" instead — correct for the rest of this process, because in
    // one VM tokens can only return via set() (login / refresh), which
    // replaces the cache. The epoch bump kills any load already in flight.
    epoch += 1;
    knownEmpty = false;
    cache = EMPTY;
    loading = null;
    try { await keychain()?.resetGenericPassword({service: SERVICE}); }
    catch (e) { console.warn('[tokenVault] keychain clear failed:', (e as Error).message); }
    // Always sweep the legacy keys too — a device that never completed the
    // migration must not keep a signed-out user's tokens in plaintext.
    try { await clearLegacy(); }
    catch { /* storage blip */ }
  },

  /** Test seam — drops the in-memory cache so the next read hits storage. */
  __resetCacheForTests: (): void => { cache = null; loading = null; epoch += 1; knownEmpty = false; },
};
