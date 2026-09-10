/**
 * Round 5 / Security S3 — verify HMAC-signed VoIP wake payloads.
 *
 * The messenger-service push worker signs every VoIP wake with
 * HMAC-SHA256 using a per-device wake key minted at registerVoipToken
 * time. Without this verification, anyone who captures a single VoIP
 * push payload off the wire (network sniff, on-device log scrape via
 * a malicious sibling app, etc.) can replay it indefinitely to
 * spam-ring the user — there's no per-call freshness in plain FCM.
 *
 * Verification rejects:
 *   • bad sig         — tampered or wrong key
 *   • stale exp       — wake older than the freshness window
 *   • replayed nonce  — same nonce seen within the recent-window LRU
 *   • missing fields  — server didn't sign this one (legacy server)
 *
 * The legacy-server case is intentionally fail-OPEN today — we can't
 * tighten until 100% of fleet has rolled the signed-wake server. Once
 * that's done, flip `LEGACY_FALLBACK` to false and the unsigned wakes
 * will be dropped (an attacker can't spoof the legacy path either,
 * because the receiver has a wake key — absence of a sig is the tell).
 */
import {sha256} from '@noble/hashes/sha2.js';
import {hmac} from '@noble/hashes/hmac.js';

/**
 * Lazy require so the test environment (which runs in pure Node and
 * does not have react-native-keychain available) can avoid the import
 * cost. Production runtime always has the native module linked.
 */
type KeychainLike = typeof import('react-native-keychain');
function getKeychain(): KeychainLike | null {
  try {

    return require('react-native-keychain') as KeychainLike;
  } catch {
    return null;
  }
}

const KEYCHAIN_SERVICE = 'bravo-voip-wake-key';

/**
 * Audit S9 — fail closed by default. The previous hard-coded
 * `const LEGACY_FALLBACK = true` accepted any unsigned/unregistered
 * wake forever, defeating the whole anti-replay design.
 *
 * The flag is now driven by the EXPO_PUBLIC_VOIP_WAKE_LEGACY env var.
 * - Unset / false / anything else → unsigned wakes are REJECTED.
 * - Explicitly "true" → unsigned wakes accepted (rollout escape hatch).
 *
 * Infra MUST keep this unset in any production build. A defensive
 * console.warn fires at module load so a stray override never sneaks
 * past code review.
 */
function readLegacyFallback(): boolean {
  // Read once at module load; the value is frozen for the process
  // lifetime so flipping mid-session can't change behaviour.
  const raw = (globalThis as {process?: {env?: Record<string, string | undefined>}})
    ?.process?.env?.EXPO_PUBLIC_VOIP_WAKE_LEGACY;
  return raw === 'true';
}
const LEGACY_FALLBACK = readLegacyFallback();
if (LEGACY_FALLBACK && typeof console !== 'undefined') {

  console.warn('[voipWakeVerify] LEGACY_FALLBACK enabled — unsigned wakes accepted. This MUST be off in production.');
}

/**
 * Recent nonces — bounded LRU keyed by `<userId>:<nonce>`, value is
 * the wall-clock ms when the nonce was first seen.
 *
 * Audit P0-N? (Rank 10) — this Map is also mirrored to AsyncStorage so
 * a cold start can't clear the replay window. Without persistence, a
 * captured wake replayed during the brief window between two app
 * launches passes the in-memory check because the Map is empty after
 * process bootstrap. With persistence, the Map is hydrated from disk
 * at first verify-call after launch and any captured wake whose nonce
 * is still inside NONCE_RETAIN_MS is rejected.
 */
// N-03 — clock-skew allowance for the wake exp check (see verifyVoipWake).
const WAKE_CLOCK_SKEW_SEC = 90;

const seenNonces = new Map<string, number>();
const NONCE_LRU_CAP = 256;
const NONCE_RETAIN_MS = 5 * 60 * 1000; // 5min — covers max push delivery skew
const NONCE_STORAGE_KEY = 'bravo-voip-wake-nonces';

/**
 * One-shot hydration guard. The first `verifyVoipWake` after process
 * start awaits the load; subsequent calls fast-path on the in-memory
 * Map. We track the Promise itself (not a boolean) so concurrent calls
 * during the hydration window all await the same load instead of each
 * racing AsyncStorage independently.
 */
let hydrationPromise: Promise<void> | null = null;

type NoncePersistence = {
  load: () => Promise<Array<[string, number]> | null>;
  save: (entries: Array<[string, number]>) => Promise<void>;
};

/**
 * Default persistence backend — AsyncStorage. Lazy-required so the
 * Node test environment (which doesn't ship AsyncStorage natively)
 * doesn't crash at module load. Resolves to null when the module
 * isn't linked; the verifier falls back to in-memory-only behaviour
 * (i.e. the legacy pre-Rank-10 semantics) in that case.
 */
type AsyncStorageLike = {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
};
function getAsyncStorage(): AsyncStorageLike | null {
  try {

    const mod = require('@react-native-async-storage/async-storage') as {default: AsyncStorageLike};
    return mod.default ?? null;
  } catch {
    return null;
  }
}

let noncePersistence: NoncePersistence = {
  load: async () => {
    const store = getAsyncStorage();
    if (!store) {return null;}
    try {
      const raw = await store.getItem(NONCE_STORAGE_KEY);
      if (!raw) {return null;}
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {return null;}
      // Defensive: each entry must be [string, number]. A malformed
      // file (corrupt write, version mismatch) drops the whole set —
      // the worst case is we miss replays for the rest of this
      // NONCE_RETAIN_MS window, never accept a forged wake.
      const out: Array<[string, number]> = [];
      for (const e of parsed) {
        if (Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number') {
          out.push([e[0], e[1]]);
        }
      }
      return out;
    } catch {
      return null;
    }
  },
  save: async (entries) => {
    const store = getAsyncStorage();
    if (!store) {return;}
    try {
      await store.setItem(NONCE_STORAGE_KEY, JSON.stringify(entries));
    } catch {
      /* best-effort; in-memory state is canonical */
    }
  },
};

async function hydrateNonces(nowMs: number): Promise<void> {
  if (hydrationPromise) {return hydrationPromise;}
  hydrationPromise = (async () => {
    const loaded = await noncePersistence.load();
    if (!loaded) {return;}
    for (const [k, ts] of loaded) {
      // Drop any entry that's already past the retain window — no
      // point holding it in memory just to prune on the next check.
      if (nowMs - ts > NONCE_RETAIN_MS) {continue;}
      // The in-memory Map may have entries from THIS process (e.g.
      // tests, or a verify that fired before hydration completed).
      // Don't overwrite a fresher entry with a stale one.
      const existing = seenNonces.get(k);
      if (existing === undefined || existing < ts) {
        seenNonces.set(k, ts);
      }
    }
  })();
  return hydrationPromise;
}

function persistNoncesAsync(): void {
  // Snapshot the current in-memory state and fire-and-forget the
  // write. The verifier MUST NOT await — the persistence layer is a
  // best-effort safety net, and a slow AsyncStorage write would
  // otherwise serialise behind every call's ring UI display.
  const snapshot: Array<[string, number]> = [];
  for (const [k, ts] of seenNonces) {snapshot.push([k, ts]);}
  void noncePersistence.save(snapshot);
}

export interface VoipWakeFields {
  kind:       string;
  callId:     string;
  nonce:      string;
  exp:        number;
  sig:        string;
}

export type VoipWakeResult =
  | {ok: true;  reason?: 'verified' | 'legacy_unsigned'}
  | {ok: false; reason: 'bad_sig' | 'stale' | 'replay' | 'no_key' | 'malformed'};

/**
 * Persist a freshly-minted wake key (returned by /push/register-voip)
 * into the secure keychain so it survives app restart and isn't
 * accessible to other apps. Caller is the auth/runtime bootstrap.
 */
export async function storeVoipWakeKey(userId: string, deviceId: string | number, wakeKeyB64: string): Promise<void> {
  const Keychain = getKeychain();
  if (!Keychain) {return;} // Node test env or unlinked module — caller already absorbs.
  const account = `${userId}:${deviceId}`;
  // Audit P1-N11 — drop `AFTER_FIRST_UNLOCK`. That policy made the wake
  // key readable by any process running on a booted-but-locked device,
  // which on rooted phones / hostile sibling apps means an attacker can
  // both READ the key (to forge signed wakes for the user) and re-emit
  // them via PushKit. `WHEN_UNLOCKED_THIS_DEVICE_ONLY` constrains reads
  // to active-unlock windows AND prevents iCloud Keychain participation
  // (the key never leaves this physical device). Trade-off: VoIP wake
  // verification needs the device to be at least once-unlocked-and-
  // currently-not-just-rebooted; on a cold-boot-and-receive-call path
  // the key fetch waits for the user's first unlock. That matches the
  // SQLCipher-key policy already in runtime/keychain.ts (P0-S2).
  await Keychain.setGenericPassword(account, wakeKeyB64, {
    service:     KEYCHAIN_SERVICE,
    accessible:  Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

/**
 * Drop the stored wake key. Called at logout — without this, a future
 * user on the same device would inherit the previous user's key and
 * fail all wake-verifications until next register.
 */
export async function clearVoipWakeKey(): Promise<void> {
  const Keychain = getKeychain();
  if (!Keychain) {return;}
  try {
    await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
  } catch {
    /* noop — keychain entry may not exist */
  }
}

/**
 * Round 5 / Security S3 — overrideable wake-key loader for tests.
 * In production this hits the Keychain; tests can stub via
 * `_setVoipWakeKeyLoaderForTests` so they don't need to mock the
 * native module. Reset back to null after the test to restore the
 * Keychain-backed default.
 */
let voipWakeKeyLoader: () => Promise<string | null> = async () => {
  const Keychain = getKeychain();
  if (!Keychain) {return null;}
  try {
    const cred = await Keychain.getGenericPassword({service: KEYCHAIN_SERVICE});
    // Keychain.getGenericPassword returns `false | UserCredentials`.
    // Narrow with a duck-type check rather than identity-equality so
    // TS's strict union narrowing doesn't reject the comparison.
    if (!cred || typeof cred !== 'object' || !('password' in cred)) {return null;}
    return cred.password;
  } catch {
    return null;
  }
};

async function loadVoipWakeKey(): Promise<string | null> {
  return voipWakeKeyLoader();
}

/**
 * Verify an inbound VoIP wake. Returns `{ok: true}` when:
 *   - sig validates against the stored wake key, AND
 *   - exp is in the future, AND
 *   - nonce hasn't been seen in the recent-LRU.
 *
 * Caller MUST drop the wake (no notifee display, no ring) when this
 * returns `{ok: false, ...}`. The reason is logged for the security
 * audit trail; do NOT surface it to the UI (it would let a tampering
 * attacker probe which leg of the check is failing).
 *
 * `selfUserId` is used to key the nonce LRU per-user so a logout-
 * login doesn't carry over a stale-replay false positive across users.
 */
export async function verifyVoipWake(p: {
  selfUserId: string;
  fields:     Partial<VoipWakeFields>;
  now?:       number;
}): Promise<VoipWakeResult> {
  const f = p.fields;
  // Server didn't include signature fields — treat as legacy. While
  // LEGACY_FALLBACK is true, accept; flip-the-switch later disables it.
  if (!f.sig || !f.nonce || !f.exp) {
    return LEGACY_FALLBACK
      ? {ok: true,  reason: 'legacy_unsigned'}
      : {ok: false, reason: 'malformed'};
  }
  if (typeof f.callId !== 'string') {
    return {ok: false, reason: 'malformed'};
  }
  const expNum = typeof f.exp === 'string' ? Number(f.exp) : f.exp;
  if (!Number.isFinite(expNum)) {return {ok: false, reason: 'malformed'};}

  const wakeKeyB64 = await loadVoipWakeKey();
  if (!wakeKeyB64) {
    // No key stored — first-run before /push/register-voip resolved.
    // Accept under LEGACY_FALLBACK so the very first call after boot
    // doesn't drop; once registered, subsequent wakes verify properly.
    return LEGACY_FALLBACK
      ? {ok: true,  reason: 'legacy_unsigned'}
      : {ok: false, reason: 'no_key'};
  }

  // N-03 — the exp is server_now+30s but is checked against the DEVICE clock.
  // A device clock a few seconds-to-minutes fast (a real, previously-observed
  // field failure: the "1:1 stale" clock-drift incident) made expNum < now for
  // EVERY killed-app wake on that device — silent, no ring, no fallback. Allow
  // a bounded skew so a plausibly-live wake still rings; the HMAC sig + nonce
  // LRU remain the real anti-replay gate, and truly-old wakes still fail
  // 'stale' so the caller can degrade to a Missed-call notification instead of
  // silence. Kept bounded (90s) so it can't widen the after-call ghost-ring
  // window materially — that window is now also closed by the server-side
  // call-cancel push (N-02).
  const now = Math.floor((p.now ?? Date.now()) / 1000);
  if (expNum + WAKE_CLOCK_SKEW_SEC < now) {return {ok: false, reason: 'stale'};}

  const expected = computeVoipSig(wakeKeyB64, {
    kind:     'voip-wake',
    callId:   f.callId,
    nonce:    String(f.nonce),
    exp:      expNum,
  });
  if (!constantTimeEq(expected, String(f.sig))) {
    return {ok: false, reason: 'bad_sig'};
  }

  // Replay check — drop wakes whose nonce we've seen recently. Rank
  // 10 — hydrate the persisted LRU from AsyncStorage on the first
  // verify after cold start so a wake captured during the previous
  // process lifetime can't replay through the fresh-Map check.
  const nowMs = p.now ?? Date.now();
  await hydrateNonces(nowMs);
  const nonceKey = `${p.selfUserId}:${f.nonce}`;
  pruneNonces(nowMs);
  if (seenNonces.has(nonceKey)) {return {ok: false, reason: 'replay'};}
  seenNonces.set(nonceKey, nowMs);
  if (seenNonces.size > NONCE_LRU_CAP) {
    // Drop oldest — Map preserves insertion order.
    const first = seenNonces.keys().next().value;
    if (first) {seenNonces.delete(first);}
  }
  // Mirror the latest state to AsyncStorage so a process restart
  // doesn't reopen the replay window. Fire-and-forget — the in-memory
  // Map is canonical for the duration of this process.
  persistNoncesAsync();
  return {ok: true, reason: 'verified'};
}

function pruneNonces(nowMs: number): void {
  for (const [k, ts] of seenNonces) {
    if (nowMs - ts > NONCE_RETAIN_MS) {seenNonces.delete(k);}
  }
}

/**
 * Mirror of the server-side `voipSign`. Same canonical form so a wake
 * signed on the server validates here.
 */
export function computeVoipSig(wakeKeyB64: string, fields: {
  kind:     'voip-wake';
  callId:   string;
  nonce:    string;
  exp:      number;
}): string {
  const key = base64ToBytes(wakeKeyB64);
  const msg = `${fields.kind}|${fields.callId}|${fields.nonce}|${fields.exp}`;
  const enc = new TextEncoder().encode(msg);
  const tag = hmac(sha256, key, enc);
  return bytesToBase64(tag);
}

function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) {return false;}
  let diff = 0;
  for (let i = 0; i < a.length; i++) {diff |= a.charCodeAt(i) ^ b.charCodeAt(i);}
  return diff === 0;
}

function base64ToBytes(b64: string): Uint8Array {
  // Use the same Buffer polyfill the rest of the messenger uses.

  const {Buffer} = require('@craftzdog/react-native-buffer') as typeof import('@craftzdog/react-native-buffer');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

function bytesToBase64(bytes: Uint8Array): string {

  const {Buffer} = require('@craftzdog/react-native-buffer') as typeof import('@craftzdog/react-native-buffer');
  return Buffer.from(bytes).toString('base64');
}

/** Test-only — drop the in-memory nonce LRU (NOT the keychain key). */
export function _resetNonceLruForTests(): void {
  seenNonces.clear();
  // Force the next verify call to re-hydrate. Without this, a test
  // that pre-populates the persistence layer AFTER the first verify
  // would never see the data because hydrationPromise is already
  // resolved. The hydration is gated by the same Promise so concurrent
  // verifies during a real cold-start still share one load.
  hydrationPromise = null;
}

/**
 * Test-only — override the persistence layer (load + save) so tests
 * can simulate a populated cold-start LRU without relying on
 * AsyncStorage. Pass `null` to restore the AsyncStorage-backed default.
 */
export function _setVoipNoncePersistenceForTests(p: NoncePersistence | null): void {
  if (p === null) {
    noncePersistence = {
      load: async () => {
        const store = getAsyncStorage();
        if (!store) {return null;}
        try {
          const raw = await store.getItem(NONCE_STORAGE_KEY);
          if (!raw) {return null;}
          const parsed = JSON.parse(raw) as unknown;
          if (!Array.isArray(parsed)) {return null;}
          const out: Array<[string, number]> = [];
          for (const e of parsed) {
            if (Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && typeof e[1] === 'number') {
              out.push([e[0], e[1]]);
            }
          }
          return out;
        } catch {
          return null;
        }
      },
      save: async (entries) => {
        const store = getAsyncStorage();
        if (!store) {return;}
        try {
          await store.setItem(NONCE_STORAGE_KEY, JSON.stringify(entries));
        } catch { /* ignore */ }
      },
    };
  } else {
    noncePersistence = p;
  }
}

/**
 * Test-only — override the wake-key loader. Pass `null` to restore
 * the Keychain-backed default. Necessary because the messenger-crypto
 * Jest project runs in Node, where react-native-keychain isn't
 * available.
 */
export function _setVoipWakeKeyLoaderForTests(loader: (() => Promise<string | null>) | null): void {
  if (loader === null) {
    voipWakeKeyLoader = async () => {
      const Keychain = getKeychain();
      if (!Keychain) {return null;}
      try {
        const cred = await Keychain.getGenericPassword({service: KEYCHAIN_SERVICE});
        if (!cred || typeof cred !== 'object' || !('password' in cred)) {return null;}
        return cred.password;
      } catch {
        return null;
      }
    };
  } else {
    voipWakeKeyLoader = loader;
  }
}
