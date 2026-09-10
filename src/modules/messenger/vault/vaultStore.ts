import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {persist, createJSONStorage} from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  EMPTY_ALBUM_STATE, createAlbum, renameAlbum, deleteAlbum, moveToAlbum, pruneAssignments,
  type AlbumState, type AlbumError,
} from '../fileAlbums/fileAlbums';
import {Buffer} from '@craftzdog/react-native-buffer';

/**
 * Local vault UX state.
 *
 * Audit fixes #34–#37:
 *
 *   #34 — constant-time PIN comparison via XOR-fold.
 *   #35 — Argon2id PIN hashing + lockout schedule (5/10/15 attempts →
 *         30s / 5m / 1h windows). The counter persists in AsyncStorage
 *         so a restart can't reset the lockout.
 *   #36 — biometric unlock is opt-IN. setupPin no longer auto-enables
 *         biometric; the setup screen must call setBiometricEnabled
 *         explicitly after the user grants permission.
 *   #37 — clock-rollback resistance: the unlock check compares both
 *         Date.now() AND a monotonic source. If either reports
 *         expiry, the vault locks. Prevents a user (or attacker)
 *         from extending the unlock window by rolling back system
 *         clock.
 *
 * Design note — file-level AES-256-CBC keys are still generated per-file
 * at upload time and travel inside the sealed envelope. The PIN is a
 * local UX gate; brute-force resistance now lives in the Argon2id +
 * lockout layer instead of the previous SHA-256 (which was trivially
 * brute-forceable on a 6-digit PIN at billions of guesses per second
 * with a stolen pinHash).
 */

import argon2 from 'react-native-argon2';

export interface VaultFile {
  /** Server object key (`vault/<uuid>`) — what download-url is minted against. */
  objectKey: string;
  /**
   * B-86 — dedup handle back to the source (`msg:<messageId>` for chat
   * attachments, `local:<ts>` for direct uploads). Legacy rows minted
   * before the real pipeline used `msg:<id>` AS the objectKey, so
   * lookups match either field (see vaultOps.findVaultRow).
   */
  sourceKey?: string;
  keyB64:    string;  // AES-256 key (stays on device)
  ivB64:     string;  // AES-256 IV  (stays on device)
  name:      string;
  size:      number;
  mimeType:  string;
  createdAt: number;
}

interface VaultState {
  /**
   * Argon2id-encoded PIN hash including salt + parameters (PHC string
   * format, e.g. "$argon2id$v=19$m=65536,t=3,p=1$<salt>$<hash>"). Null
   * until the user sets a PIN. Audit fix #35 — PHC format means the
   * salt and parameters travel WITH the hash so we don't need a
   * second column to disambiguate.
   */
  pinHash: string | null;
  /**
   * Audit fix #36 — biometric unlock is opt-in. Defaults to false;
   * the setup screen must explicitly call setBiometricEnabled(true)
   * after the user grants permission.
   */
  biometricEnabled: boolean;
  /** Epoch ms until which the vault stays unlocked. `null` = locked. */
  unlockedUntil: number | null;
  /**
   * Audit fix #37 — monotonic counterpart to `unlockedUntil`. We
   * stamp `performance.now()` (or a JS uptime ms) at unlock and bump
   * the deadline accordingly; isUnlocked checks BOTH wall-clock and
   * monotonic. A clock rollback only moves wall-clock backwards;
   * monotonic keeps advancing, so the vault still locks.
   */
  unlockedUntilMonotonic: number | null;
  /**
   * Wall-clock stamp of the last time the user PROVED presence by typing the
   * PIN — `verifyPin` success, `setupPin`, `changePin`. Read only through
   * `pinFresh()`. Lives in `initialState` so `reset()` clears it, and stays
   * OUT of `partialize`: a presence proof must not outlive the process that
   * witnessed it.
   */
  lastPinProofAt: number | null;
  /**
   * Monotonic counterpart to `lastPinProofAt`, same audit-#37 reasoning as
   * `unlockedUntilMonotonic`. `pinFresh()` ANDs the two: a clock rollback
   * freshens the wall stamp alone, and doze freezes the monotonic one alone,
   * so either single reading re-opens the hole the window exists to close.
   */
  lastPinProofMonotonic: number | null;
  /** Local file index — metadata only, ciphertext lives on S3. */
  files: VaultFile[];
  /**
   * Audit fix #35 — brute-force protection counters. Persisted so
   * a restart can't reset.
   */
  failedAttempts: number;
  /** Epoch ms after which verifyPin will accept attempts again. */
  lockoutUntil: number | null;
  /**
   * Vault albums — user folders over `files`, keyed by `objectKey`.
   *
   * Lives HERE rather than in a store of its own precisely so `reset()` wipes
   * album NAMES with the file list. "Contracts" and "Licences" are as
   * disclosing as the filenames beside them, and a separate store would
   * survive a vault wipe and leave them readable. Same reason it is in
   * `partialize` next to `files`: identical lifetime, identical exposure.
   *
   * Files-tab albums are a SEPARATE space (founder 2026-08-08) and live in
   * `fileAlbums/fileAlbumStore.ts`.
   */
  albumState: AlbumState;
  /**
   * B-696 (vault durability, design doc VAULT_DURABILITY_DESIGN_2026-08-29 §3)
   * — which owner the FLAT slice above belongs to. `null` on a legacy blob
   * (pre-B-696 installs) and after `stashAndClearOwner`. The flat shape is
   * deliberately UNCHANGED so every consumer and the persisted record shape
   * (`vaultStore.test.ts` pins `state.pinHash` at `bravo-vault-v1`) stay
   * byte-compatible; owner scoping is a stash-and-swap layered on top, the
   * exact `messengerStore.setOwner` / `vaultByOwner` pattern.
   */
  vaultOwner: string | null;
  /**
   * Signed-out owners' vault slices, keyed by the SAME stable ownerKey the
   * messenger store scopes on (`msg:ownerKey:<userId>` = email ?? phone ?? id).
   * Replaces the Issue-30/20 wipe-on-signout: isolation now comes from the
   * swap (the flat slice is CLEARED at sign-out), while the data survives for
   * the owner's next sign-in. Session-only fields (unlock windows, pin-proof
   * stamps) are never stashed — a presence proof must not outlive the session
   * that witnessed it.
   */
  ownerStashes: Record<string, VaultOwnerStash>;
  /**
   * B-696 review F1 — the server-verifier sync owes a retry. TRUE when a
   * set/change could not reach the server (offline), cleared the moment a
   * reconcile confirms the server matches. Persisted per owner so the debt
   * survives restarts — the design doc's §4.2 self-heal, actually armed.
   */
  pinSyncPending: boolean;
  /**
   * B-696 review F1 — the server holds a DIFFERENT PIN than this device
   * (an offline change that never synced, or a fresh offline setup while
   * the account already had a verifier). S2 forbids silently overwriting
   * the server side, so this flag drives a ONE-SHOT recovery prompt (the
   * Forgot-PIN lane is the sanctioned overwrite door). Cleared when a
   * reconcile finds the two in agreement again.
   */
  pinServerDiverged: boolean;
}

/** The per-owner durable subset — exactly the partialized fields. */
export interface VaultOwnerStash {
  pinHash:          string | null;
  biometricEnabled: boolean;
  files:            VaultFile[];
  albumState:       AlbumState;
  failedAttempts:   number;
  lockoutUntil:     number | null;
  pinSyncPending?:    boolean;
  pinServerDiverged?: boolean;
}

interface VaultActions {
  /** First-time setup. Hashes the PIN and seeds defaults. */
  setupPin: (pin: string) => Promise<void>;
  /**
   * Local PIN check. Returns a discriminated union so the UI can
   * surface lockout state and remaining attempts:
   *   {ok: true}                          — match, unlock window extended
   *   {ok: false, reason, msUntilRetry?}  — denied; reason is 'wrong'
   *                                          or 'lockout'
   */
  verifyPin: (pin: string) => Promise<VerifyResult>;
  /** Biometric path — caller is responsible for actually running LocalAuth. */
  unlockWithBiometric: () => void;
  /** Fast read for gating the lock screen. */
  isUnlocked: () => boolean;
  /**
   * True only while the user typed their PIN within `PIN_PROOF_WINDOW_MS` on
   * BOTH clocks. The consent anchor for arming biometric unlock from Settings
   * — never an unlock check.
   */
  pinFresh: () => boolean;
  /** Whether a PIN has ever been set (drives first-time-vs-returning routing). */
  hasPin: () => boolean;
  /** Manual lock — e.g. user taps "lock vault" or app goes to background. */
  lock: () => void;
  /** Change the PIN (only valid after `verifyPin(current)` passed). */
  changePin: (nextPin: string) => Promise<void>;
  /** Toggle the biometric-on-subsequent-unlock preference. */
  setBiometricEnabled: (enabled: boolean) => void;
  /** Add an uploaded file to the local index. */
  addFile: (f: VaultFile) => void;
  /** Remove from local index (server side requires a separate delete call). */
  removeFile: (objectKey: string) => void;
  /**
   * Wipe EVERYTHING — PIN, files, unlock state, album names AND every owner
   * stash. The nuclear primitive. Album names are as disclosing as the
   * filenames beside them, so leaving them behind would be a data leak past a
   * full wipe; `vaultAlbumReset.test.ts` pins that they go.
   *
   * NOT the sign-out path since B-696 — signOut calls `stashAndClearOwner()`
   * so the owner's vault survives their next sign-in. (The old docstring said
   * "Used by the Forgot PIN flow"; that was stale — the S2 fail-closed stubs
   * never called it, and the real reset flow keeps files by design.)
   */
  reset: () => void;
  /**
   * B-696 sign-out — stash the flat slice under its owner, then clear the
   * flat slice. The next account on this device sees `hasPin() === false`
   * and zero files (the Issue-30/20 isolation property, now achieved by
   * scoping instead of destruction). `fallbackOwnerKey` covers the one
   * legacy window where sign-out runs before any adoption stamped
   * `vaultOwner`; with no owner attributable at all, a non-pristine flat
   * slice is DROPPED (exactly today's behavior — fail-safe, never
   * misattribute).
   */
  stashAndClearOwner: (fallbackOwnerKey?: string | null) => void;
  /**
   * B-696 sign-in/boot — make the flat slice belong to `ownerKey`: stash the
   * current owner's slice (if any), then load `ownerKey`'s stash or start
   * empty. Legacy claim: `vaultOwner === null` with existing flat data means
   * the data belongs to the sitting user (the pre-B-696 wipe-on-signout
   * guaranteed it), so the adopt STAMPS instead of stashing-under-null.
   * Always lands locked (session fields reset).
   */
  adoptVaultOwner: (ownerKey: string) => void;
  /**
   * B-696 Phase D — merge a restored (decrypted) vault index into the flat
   * slice. Additive only: local rows always win, a key in `skipKeys`
   * (removed THIS session) is never resurrected, rows without real key
   * material are refused (the M-02 invariant, same as addFile), album ids
   * union with local names winning, and assignments are pruned to the
   * surviving file set. Returns how many file rows were added.
   */
  mergeVaultIndex: (
    incoming: {files: VaultFile[]; albumState: AlbumState},
    skipKeys?: ReadonlySet<string>,
  ) => number;
  /**
   * B-696 — the remove-account lane (`opts.wipeAtRest`): drop `ownerKey`'s
   * stash AND clear the flat slice unconditionally. Total by intent — an
   * explicit "remove account from this device" must leave no vault residue,
   * matching the SQLCipher/keychain wipe it rides with. Other owners'
   * stashes are untouched.
   */
  purgeOwner: (ownerKey: string | null) => void;
  /**
   * B-696 review F1 — record the server-verifier sync state. `pending` =
   * a set/change still owes the server a push (offline); `diverged` = the
   * server provably holds a DIFFERENT PIN. Either field may be omitted to
   * leave it unchanged.
   */
  setPinSyncState: (next: {pending?: boolean; diverged?: boolean}) => void;
  /** Returns the new album id, or an error the caller renders inline. */
  createVaultAlbum: (name: string) => {id: string | null; error: AlbumError | null};
  renameVaultAlbum: (id: string, name: string) => AlbumError | null;
  /** Deletes the album and UNFILES its files. Never deletes a file. */
  deleteVaultAlbum: (id: string) => AlbumError | null;
  /** Move a multi-selection of objectKeys. `albumId: null` unfiles. */
  moveToVaultAlbum: (objectKeys: readonly string[], albumId: string | null) => AlbumError | null;
  /** Reads the lockout / attempt state for the UI. */
  getAttemptStatus: () => {failedAttempts: number; msUntilRetry: number};
}

export type VerifyResult =
  | {ok: true}
  | {ok: false; reason: 'wrong'; remainingAttemptsBeforeLockout: number}
  | {ok: false; reason: 'lockout'; msUntilRetry: number};

/** Vault stays unlocked for 5 min of idle — matches the action-token TTL. */
const UNLOCK_WINDOW_MS = 5 * 60 * 1000;

/**
 * How recently the user must have TYPED their PIN for `pinFresh()` to say yes.
 *
 * This is the consent anchor for arming biometric unlock from Settings, and
 * nothing else. It is deliberately NOT `UNLOCK_WINDOW_MS`: the 5-minute unlock
 * window is also opened by `unlockWithBiometric`, and even a PIN-opened one
 * permits the handoff attack (unlock for Files → hand the phone over → the
 * holder enrols their own finger and arms it). 60 s is a presence proof.
 *
 * Never reuse this for an unlock decision — `isUnlocked()` owns that.
 */
export const PIN_PROOF_WINDOW_MS = 60_000;

/**
 * Audit fix #35 — lockout schedule. Tiers picked to defeat realistic
 * brute force on a 4–8 digit PIN: even with a stolen device, an
 * attacker burns 30s / 5m / 1h between guess windows.
 */
const LOCKOUT_TIERS: Array<{atFailures: number; durationMs: number}> = [
  {atFailures: 5,  durationMs: 30_000},          // 30 s
  {atFailures: 10, durationMs: 5  * 60_000},     // 5 min
  {atFailures: 15, durationMs: 60 * 60_000},     // 1 h
];

const initialState: VaultState = {
  pinHash:                null,
  biometricEnabled:       false,    // Audit fix #36 — opt-in
  unlockedUntil:          null,
  unlockedUntilMonotonic: null,
  lastPinProofAt:         null,
  lastPinProofMonotonic:  null,
  files:                  [],
  failedAttempts:         0,
  lockoutUntil:           null,
  albumState:             EMPTY_ALBUM_STATE,
  vaultOwner:             null,
  ownerStashes:           {},
  pinSyncPending:         false,
  pinServerDiverged:      false,
};

/** The flat per-owner fields, reset to their empty values (session fields
 *  too). A FACTORY, not a constant: a shared `[]`/album object across owners
 *  would alias two owners' slices onto one reference and defeat every
 *  ref-equality change signal downstream (the sameIdSet class). */
function emptyOwnerFlat() {
  return {
    pinHash:                null as string | null,
    biometricEnabled:       false,
    unlockedUntil:          null as number | null,
    unlockedUntilMonotonic: null as number | null,
    lastPinProofAt:         null as number | null,
    lastPinProofMonotonic:  null as number | null,
    files:                  [] as VaultFile[],
    failedAttempts:         0,
    lockoutUntil:           null as number | null,
    albumState:             {albums: [], assignments: {}} as AlbumState,
    pinSyncPending:         false,
    pinServerDiverged:      false,
  };
}

/** Anything worth stashing? A pristine slice (no PIN, no files) stashes as nothing. */
function flatIsPristine(s: {pinHash: string | null; files: VaultFile[]}): boolean {
  return s.pinHash === null && s.files.length === 0;
}

/** Plain (non-draft) snapshot of the flat durable fields — audit-fix-#15 rule:
 *  never stuff live immer drafts into an owner map, or later flat mutations
 *  keep mutating the stashed copy through the shared proxies. Manual plain
 *  copies rather than immer `current()` so the helper is draft-agnostic. */
function snapshotFlat(s: VaultState): VaultOwnerStash {
  return {
    pinHash:          s.pinHash,
    biometricEnabled: s.biometricEnabled,
    files:            s.files.map(f => ({...f})),
    albumState: {
      albums:      s.albumState.albums.map(a => ({...a})),
      assignments: {...s.albumState.assignments},
    },
    failedAttempts:   s.failedAttempts,
    lockoutUntil:     s.lockoutUntil,
    pinSyncPending:    s.pinSyncPending,
    pinServerDiverged: s.pinServerDiverged,
  };
}

/**
 * Audit fix #35 — Argon2id is now the PIN hash. Parameters chosen for
 * mobile: 64 MiB memory, 3 iterations, 1 thread. Tunable per device
 * if we hit perf issues; ~300 ms on a mid-range Android.
 */
async function hashPin(pin: string, saltHex?: string): Promise<string> {
  // B-456(b) — THE SALT IS BYTES, NOT TEXT. We generate 16 bytes of entropy at
  // setup and hand them over as hex WITH `saltEncoding: 'hex'`, so the native
  // side decodes them back to those exact 16 bytes
  // (RNArgon2Module.java:66-68 / RNArgon2.swift:21-33) instead of hashing the
  // 32 ASCII characters of the hex string. That matters because the PHC output
  // carries base64 of the SALT BYTES — see saltHexFromPhc for the other half.
  const useSalt = saltHex ?? bufToHex(randomBytes(16));
  const result = await argon2(pin, useSalt, {
    iterations:   3,
    memory:       64 * 1024,   // 64 MiB
    parallelism:  1,
    hashLength:   32,
    mode:         'argon2id',
    saltEncoding: 'hex',
  });
  // B-456(a) — the native module resolves `{rawHash, encodedHash}`
  // (RNArgon2Module.java:89-92, RNArgon2.swift:50-54, index.d.ts:11-15).
  // This used to read `.encoded`, which is not a field the module ever
  // returns: pinHash was `undefined`, JSON persistence dropped it, and every
  // unlock attempt failed. Do not "simplify" this back to a cast.
  return result.encodedHash;
}

/**
 * Audit fix #34 — constant-time string comparison via XOR-fold.
 * The previous `===` short-circuited on the first byte difference,
 * leaking PIN-prefix info via timing. The fold compares EVERY byte
 * even after a mismatch, then checks whether the accumulator stayed
 * zero.
 */
function constantTimeEqStr(a: string, b: string): boolean {
  if (a.length !== b.length) {return false;}
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bufToHex(u: Uint8Array): string {
  let out = '';
  for (let i = 0; i < u.length; i++) {out += u[i].toString(16).padStart(2, '0');}
  return out;
}

/**
 * Extract the salt from a PHC-encoded argon2 string, returned as the HEX
 * string `hashPin` feeds back to the native module.
 *
 * B-456(b) — the salt does NOT survive a text round-trip. The argon2 reference
 * encoder writes *unpadded base64 of the salt BYTES* into the PHC string, so
 * the `<salt>` field is not the text we passed in. Handing that base64 text
 * straight back as a salt hashes against completely different bytes and verify
 * can never match, no matter how correct the rest of the flow is. Decode it to
 * bytes and re-hex it so create and verify use byte-identical salts.
 *
 * Returns null when the stored string is not a PHC hash we produced — today
 * that means the legacy pre-Argon2 SHA-256 hex (no `$` separators at all), and
 * the caller turns that into a forced fresh setup rather than a stuck vault.
 */
function saltHexFromPhc(encoded: string): string | null {
  // $argon2id$v=19$m=65536,t=3,p=1$<base64 salt>$<base64 hash>
  const parts = encoded.split('$');
  if (parts.length < 6) {return null;}
  const b64 = parts[4];
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) {return null;}
  const bytes = new Uint8Array(Buffer.from(b64, 'base64'));
  if (bytes.length === 0) {return null;}
  return bufToHex(bytes);
}

/**
 * Audit fix #37 — monotonic time source. `performance.now()` is
 * monotonic per spec; on RN it falls back to Date.now() when the
 * Performance API isn't installed, in which case we degrade
 * gracefully (the wall-clock check is the safety net).
 */
function monotonicNow(): number {
  const p = (globalThis as unknown as {performance?: {now?: () => number}}).performance;
  return typeof p?.now === 'function' ? p.now() : Date.now();
}

/**
 * Audit fix #35 — compute the lockout duration that applies after
 * `failures` failed attempts. Returns 0 below the first tier.
 */
function lockoutDurationFor(failures: number): number {
  let dur = 0;
  for (const tier of LOCKOUT_TIERS) {
    if (failures >= tier.atFailures) {dur = tier.durationMs;}
  }
  return dur;
}

/**
 * The persist API zustand attaches to the store. Typed locally because the
 * `create()(...)` chain does not surface it on the hook's type, and read
 * defensively because a store built without the middleware (tests) has none.
 */
type VaultPersistApi = {
  hasHydrated?: () => boolean;
  onFinishHydration?: (cb: () => void) => () => void;
};

export function vaultPersistApi(): VaultPersistApi | undefined {
  return (useVaultStore as unknown as {persist?: VaultPersistApi}).persist;
}

/**
 * Whether the AsyncStorage record has actually landed.
 *
 * LOAD-BEARING for the lock gate: rehydration is async, so before it completes
 * `pinHash` is still initialState's `null` — indistinguishable from "this user
 * has no PIN". A gate that answers in that window routes a real-PIN user into
 * PIN SETUP, where a fresh `setupPin` overwrites the hash they cannot recover.
 * Callers must decline to decide until this returns true.
 *
 * Defaults to true when the middleware is absent so a non-persisted test store
 * behaves exactly as it did before this existed.
 */
export function vaultHydrated(): boolean {
  const p = vaultPersistApi();
  return typeof p?.hasHydrated === 'function' ? p.hasHydrated() : true;
}

/**
 * B-696 — adopt `ownerKey` once the persisted record has actually landed.
 *
 * Adoption before rehydration would swap against initialState (an empty flat
 * slice + empty stashes), then the rehydrate would overwrite the swap — the
 * same async-window class `vaultHydrated()` exists for. Runs immediately when
 * already hydrated (and in middleware-less test stores), otherwise once on
 * hydration finish.
 */
export function adoptVaultOwnerWhenReady(ownerKey: string): void {
  if (!ownerKey) {return;}
  if (vaultHydrated()) {
    useVaultStore.getState().adoptVaultOwner(ownerKey);
    return;
  }
  const p = vaultPersistApi();
  if (typeof p?.onFinishHydration !== 'function') {
    useVaultStore.getState().adoptVaultOwner(ownerKey);
    return;
  }
  const unsub = p.onFinishHydration(() => {
    unsub();
    useVaultStore.getState().adoptVaultOwner(ownerKey);
  });
}

export const useVaultStore = create<VaultState & VaultActions>()(
  persist(
    immer((set, get) => ({
      ...initialState,

      setupPin: async (pin: string) => {
        const pinHash = await hashPin(pin);
        const now = Date.now();
        set(s => {
          s.pinHash = pinHash;
          // Audit fix #36 — do NOT auto-enable biometric. Setup screen
          // must call setBiometricEnabled(true) after explicit consent.
          s.biometricEnabled = false;
          s.unlockedUntil = now + UNLOCK_WINDOW_MS;
          s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
          // The user just typed the PIN twice — the same presence proof
          // verifyPin stamps.
          s.lastPinProofAt = now;
          s.lastPinProofMonotonic = monotonicNow();
          s.failedAttempts = 0;
          s.lockoutUntil = null;
        });
      },

      verifyPin: async (pin: string): Promise<VerifyResult> => {
        const state = get();
        if (!state.pinHash) {return {ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 0};}

        // Audit fix #35 — lockout gate.
        if (state.lockoutUntil && state.lockoutUntil > Date.now()) {
          return {ok: false, reason: 'lockout', msUntilRetry: state.lockoutUntil - Date.now()};
        }

        // Re-hash the candidate with the stored salt so the comparison
        // is between two identically-derived hashes.
        const salt = saltHexFromPhc(state.pinHash);
        if (!salt) {
          // Stored hash is malformed (legacy SHA-256 string from a
          // pre-fix install). Force a fresh setup — the user has to
          // re-enter their PIN on the next launch.
          //
          // The biometric consent goes WITH the hash. Leaving it behind was
          // the one state where `biometricEnabled === true` could outlive
          // `pinHash === null`: consent granted against a credential that no
          // longer exists, surviving until the next setupPin. Clean slate.
          set(s => { s.pinHash = null; s.biometricEnabled = false; });
          return {ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 0};
        }

        let candidate: string;
        try {
          candidate = await hashPin(pin, salt);
        } catch {
          return {ok: false, reason: 'wrong', remainingAttemptsBeforeLockout: 0};
        }

        // Audit fix #34 — constant-time compare.
        const ok = constantTimeEqStr(state.pinHash, candidate);

        if (ok) {
          set(s => {
            s.unlockedUntil = Date.now() + UNLOCK_WINDOW_MS;
            s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
            s.lastPinProofAt = Date.now();
            s.lastPinProofMonotonic = monotonicNow();
            s.failedAttempts = 0;
            s.lockoutUntil = null;
          });
          return {ok: true};
        }

        // Increment counter; apply lockout if we just hit a tier.
        let nextFails = 0;
        let lockoutMs = 0;
        set(s => {
          s.failedAttempts += 1;
          nextFails = s.failedAttempts;
          lockoutMs = lockoutDurationFor(s.failedAttempts);
          if (lockoutMs > 0) {
            s.lockoutUntil = Date.now() + lockoutMs;
          }
        });
        if (lockoutMs > 0) {
          return {ok: false, reason: 'lockout', msUntilRetry: lockoutMs};
        }
        // Find the next tier to compute remaining attempts before lockout.
        const nextTier = LOCKOUT_TIERS.find(t => nextFails < t.atFailures);
        return {
          ok: false,
          reason: 'wrong',
          remainingAttemptsBeforeLockout: nextTier ? nextTier.atFailures - nextFails : 0,
        };
      },

      unlockWithBiometric: () => set(s => {
        s.unlockedUntil = Date.now() + UNLOCK_WINDOW_MS;
        s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
        s.failedAttempts = 0;
        s.lockoutUntil = null;
      }),

      /**
       * Audit fix #37 — locked when EITHER source says expired. Wall
       * clock alone could be rolled back to extend the window; the
       * monotonic source can't be moved backwards by the user. We
       * AND the two checks (both must report still-unlocked) to be
       * conservative.
       */
      isUnlocked: () => {
        const s = get();
        const wallOk = s.unlockedUntil !== null && s.unlockedUntil > Date.now();
        const monoOk = s.unlockedUntilMonotonic !== null
          && s.unlockedUntilMonotonic > monotonicNow();
        return wallOk && monoOk;
      },

      /**
       * Same AND as `isUnlocked` above, for the same reason, plus a
       * `delta >= 0` floor on each clock: a stamp that reads as being in the
       * FUTURE means the clock moved under us, and "0 ms old" must not be the
       * answer a rollback buys.
       */
      pinFresh: () => {
        const s = get();
        if (s.lastPinProofAt === null || s.lastPinProofMonotonic === null) {return false;}
        const wallDelta = Date.now() - s.lastPinProofAt;
        const monoDelta = monotonicNow() - s.lastPinProofMonotonic;
        const wallOk = wallDelta >= 0 && wallDelta < PIN_PROOF_WINDOW_MS;
        const monoOk = monoDelta >= 0 && monoDelta < PIN_PROOF_WINDOW_MS;
        return wallOk && monoOk;
      },

      hasPin: () => get().pinHash !== null,

      lock: () => set(s => {
        s.unlockedUntil = null;
        s.unlockedUntilMonotonic = null;
      }),

      changePin: async (nextPin: string) => {
        const pinHash = await hashPin(nextPin);
        set(s => {
          s.pinHash = pinHash;
          s.unlockedUntil = Date.now() + UNLOCK_WINDOW_MS;
          s.unlockedUntilMonotonic = monotonicNow() + UNLOCK_WINDOW_MS;
          // Reached only after typing a 6-digit PIN twice — the same presence
          // proof setupPin and verifyPin stamp. Omitting it here would make a
          // PIN change the one flow that leaves the user unable to arm
          // biometric from Settings.
          //
          // ⚠️ THIS STAMP IS ONLY HONEST WHILE `changePin` IS UNREACHABLE
          // WITHOUT THE OLD PIN. Today its single caller (VaultNewPinScreen) is
          // reached through the lock, so the NEW pin is typed by someone who
          // already proved the old one. A future "Change PIN" entry that skips
          // that proof would turn this line into an arming path: hand a phone
          // over inside its unlock window, set a new PIN, and `pinFresh()` says
          // yes to biometric enrolment. Any such door MUST verify the old PIN
          // before this runs — or this stamp has to move out of changePin.
          s.lastPinProofAt = Date.now();
          s.lastPinProofMonotonic = monotonicNow();
          s.failedAttempts = 0;
          s.lockoutUntil = null;
        });
      },

      setBiometricEnabled: (enabled: boolean) => set(s => { s.biometricEnabled = enabled; }),

      addFile: (f: VaultFile) => set(s => {
        // Audit M-02/S1 — defense in depth: a row without real key
        // material is a pretend-encrypted entry; refuse it no matter
        // which caller regressed. vaultOps validates before calling.
        if (!f.keyB64 || !f.ivB64 || !f.objectKey) {
          console.warn('[vault] addFile refused a row without key material (M-02)');
          return;
        }
        if (s.files.some(x => x.objectKey === f.objectKey
            || (f.sourceKey && (x.sourceKey === f.sourceKey || x.objectKey === f.sourceKey)))) {return;}
        s.files.unshift(f);
      }),

      removeFile: (objectKey: string) => set(s => {
        s.files = s.files.filter(f => f.objectKey !== objectKey);
        // Drop the album assignment with the file. Without this a deleted
        // vault object leaves a dead entry that persists forever and keeps
        // inflating its album's count.
        s.albumState = pruneAssignments(s.albumState, s.files.map(f => f.objectKey));
      }),

      createVaultAlbum: (name: string) => {
        const id = `valb_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const {state, error} = createAlbum(get().albumState, name, id, Date.now());
        if (error) {return {id: null, error};}
        set(s => { s.albumState = state; });
        return {id, error: null};
      },

      renameVaultAlbum: (id: string, name: string) => {
        const {state, error} = renameAlbum(get().albumState, id, name);
        if (!error) {set(s => { s.albumState = state; });}
        return error;
      },

      // Deletes the ALBUM, never the files — they return to Unfiled.
      deleteVaultAlbum: (id: string) => {
        const {state, error} = deleteAlbum(get().albumState, id);
        if (!error) {set(s => { s.albumState = state; });}
        return error;
      },

      moveToVaultAlbum: (objectKeys: readonly string[], albumId: string | null) => {
        const {state, error} = moveToAlbum(get().albumState, objectKeys, albumId);
        if (!error) {set(s => { s.albumState = state; });}
        return error;
      },

      reset: () => set(() => ({...initialState})),

      stashAndClearOwner: (fallbackOwnerKey?: string | null) => set(s => {
        const owner = s.vaultOwner ?? fallbackOwnerKey ?? null;
        if (owner && !flatIsPristine(s)) {
          s.ownerStashes[owner] = snapshotFlat(s);
        }
        // No attributable owner + real data → drop it (the pre-B-696 wipe
        // behavior). Misattributing a vault to the wrong account would be
        // strictly worse than the loss the founder already reported.
        Object.assign(s, emptyOwnerFlat());
        s.vaultOwner = null;
      }),

      adoptVaultOwner: (ownerKey: string) => set(s => {
        if (!ownerKey) {return;}
        if (s.vaultOwner === ownerKey) {return;}    // same owner — nothing to swap
        if (s.vaultOwner === null && !flatIsPristine(s)) {
          // Legacy claim (pre-B-696 blob, or a boot that beat the sign-out
          // hook): the wipe-on-signout era guaranteed flat data can only
          // belong to the sitting user — stamp it, keep it live.
          s.vaultOwner = ownerKey;
          return;
        }
        if (s.vaultOwner !== null && !flatIsPristine(s)) {
          s.ownerStashes[s.vaultOwner] = snapshotFlat(s);
        }
        const incoming = s.ownerStashes[ownerKey];
        Object.assign(s, emptyOwnerFlat());
        if (incoming) {
          s.pinHash          = incoming.pinHash;
          s.biometricEnabled = incoming.biometricEnabled;
          s.files            = incoming.files;
          s.albumState       = incoming.albumState;
          s.failedAttempts   = incoming.failedAttempts;
          s.lockoutUntil     = incoming.lockoutUntil;
          s.pinSyncPending    = incoming.pinSyncPending ?? false;
          s.pinServerDiverged = incoming.pinServerDiverged ?? false;
          delete s.ownerStashes[ownerKey];
        }
        // Always lands LOCKED: session fields were reset by emptyOwnerFlat,
        // and a stash never carried them (a presence proof must not outlive
        // the session that witnessed it).
        s.vaultOwner = ownerKey;
      }),

      mergeVaultIndex: (
        incoming: {files: VaultFile[]; albumState: AlbumState},
        skipKeys?: ReadonlySet<string>,
      ) => {
        let added = 0;
        set(s => {
          const have = new Set(s.files.map(f => f.objectKey));
          for (const f of incoming?.files ?? []) {
            // M-02 — never persist a row without real key material; and never
            // resurrect a file the user removed in this session.
            if (!f?.objectKey || !f.keyB64 || !f.ivB64) {continue;}
            if (have.has(f.objectKey) || skipKeys?.has(f.objectKey)) {continue;}
            s.files.push({...f});
            have.add(f.objectKey);
            added += 1;
          }
          const localAlbumIds = new Set(s.albumState.albums.map(a => a.id));
          const albums = [...s.albumState.albums];
          for (const a of incoming?.albumState?.albums ?? []) {
            if (a?.id && a.name && !localAlbumIds.has(a.id)) {albums.push({...a});}
          }
          // Local assignments win on conflict (spread order), then prune to
          // the files that actually exist — same rule removeFile applies.
          const assignments = {
            ...(incoming?.albumState?.assignments ?? {}),
            ...s.albumState.assignments,
          };
          s.albumState = pruneAssignments({albums, assignments}, s.files.map(f => f.objectKey));
        });
        return added;
      },

      setPinSyncState: (next: {pending?: boolean; diverged?: boolean}) => set(s => {
        if (typeof next.pending === 'boolean') {s.pinSyncPending = next.pending;}
        if (typeof next.diverged === 'boolean') {s.pinServerDiverged = next.diverged;}
      }),

      purgeOwner: (ownerKey: string | null) => set(s => {
        if (ownerKey) {delete s.ownerStashes[ownerKey];}
        // The flat slice at remove-account time can only belong to the
        // leaving user (nobody else is live mid-signOut) — clear it
        // unconditionally rather than gate on attribution.
        Object.assign(s, emptyOwnerFlat());
        s.vaultOwner = null;
      }),

      getAttemptStatus: () => {
        const s = get();
        const msUntilRetry = s.lockoutUntil ? Math.max(0, s.lockoutUntil - Date.now()) : 0;
        return {failedAttempts: s.failedAttempts, msUntilRetry};
      },
    })),
    {
      name: 'bravo-vault-v1',
      storage: createJSONStorage(() => AsyncStorage),
      // B-456 — NO MIGRATION IS NEEDED, and none should be added. Only two
      // shapes have ever reached this storage key:
      //   * pre-Argon2 builds wrote a bare 64-char SHA-256 hex. `split('$')`
      //     gives one part, saltHexFromPhc returns null, and verifyPin already
      //     clears pinHash to force a fresh setup.
      //   * every build since read the wrong result field, so pinHash was
      //     `undefined`; JSON.stringify DROPS undefined keys, so the record
      //     was written without pinHash and rehydrate falls back to
      //     initialState's null.
      // A PHC string with the old (utf8-text) salt was therefore never
      // persisted by anyone — there is no legacy hash to convert.
      partialize: s => ({
        pinHash:          s.pinHash,
        biometricEnabled: s.biometricEnabled,
        files:            s.files,
        // Same lifetime and same exposure as `files` — persisted together so
        // a wipe clears both, never one without the other.
        albumState:       s.albumState,
        // unlockedUntil / unlockedUntilMonotonic are intentionally NOT
        // persisted — app restart = relock.
        // lastPinProofAt / lastPinProofMonotonic are NOT persisted either, and
        // must never be added: a presence proof that survives a process (or a
        // reinstall, or the phone changing hands) is not a presence proof.
        // Audit fix #35 — failedAttempts + lockoutUntil ARE persisted
        // so a restart can't reset the lockout counter.
        failedAttempts:   s.failedAttempts,
        lockoutUntil:     s.lockoutUntil,
        // B-696 — owner scoping. The stashes persist (that is their entire
        // point: surviving sign-out), and vaultOwner stamps who the flat
        // slice belongs to. Stashes carry the SAME durable subset as this
        // partialize — never the session fields.
        vaultOwner:       s.vaultOwner,
        ownerStashes:     s.ownerStashes,
        // F1 — the sync debt must survive restarts or the retry never fires.
        pinSyncPending:    s.pinSyncPending,
        pinServerDiverged: s.pinServerDiverged,
      }),
    },
  ),
);
