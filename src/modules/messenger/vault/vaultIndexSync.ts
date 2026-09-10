/**
 * B-696 Phase D (VAULT_DURABILITY_DESIGN_2026-08-29 §6) — the E2E-encrypted
 * vault index blob. This is what makes the vault's FILES survive a reinstall:
 * the per-file AES keys + album names ride to the server as one opaque blob
 * the server can never read, and come back after the backup restore
 * re-establishes the master key.
 *
 * CRYPTO (reuses backupCrypto primitives — nothing new):
 *   masterKeyRaw (keychain, loadMirrorMasterKey)
 *     ─HKDF-SHA256(info='bravo-vault-index-v1')─▶ vaultIndexKey (32B)
 *     ─AES-256-GCM + AAD backupAad('vault-index', <auth userId>)─▶ blob
 * No mirror key ⇒ the lane is silently OFF (counts-only log) — the same
 * durability contract as message history: Secure Backup is what carries it.
 *
 * TRANSPORT: POST/GET /vault-index on messenger-service. JWT-only by design
 * (the /vault MfaGuard's single-use proofs cannot be paid per background
 * push; the blob's protection is the E2E crypto, the exact
 * backup_session_snapshots precedent). 409 stale_seq adopts currentSeq+1 and
 * retries ONCE (the I6 adopt-never-hammer rule).
 *
 * DELIBERATELY NOT part of the Merkle mirror: no ledger interaction, no
 * commits, no leaf set — see design doc §6.1 and BACKUP_LOOP.md.
 *
 * NEVER log blob contents, file names, or key material — counts and seqs only.
 */
import {useVaultStore, type VaultFile} from './vaultStore';
import type {AlbumState} from '../fileAlbums/fileAlbums';
import {hkdf} from '@noble/hashes/hkdf.js';
import {sha256} from '@noble/hashes/sha2.js';

const HKDF_INFO = 'bravo-vault-index-v1';
const AAD_PURPOSE = 'vault-index';
const PUSH_DEBOUNCE_MS = 5_000;

type WirePayload = {v: 1; files: VaultFile[]; albumState: AlbumState};

// Armed once per session by MainNavigator's owner effect (the same place the
// messenger store adopts its owner). Module-scoped, reset on re-arm.
let armedOwnerKey: string | null = null;
let armedUserId: string | null = null;
let lastKnownSeq: number | null = null;
let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pushInFlight = false;
let pushAgainAfter = false;
let unsubscribe: (() => void) | null = null;
/** objectKeys removed THIS session — a pull must never resurrect them. */
const removedThisSession = new Set<string>();

async function deriveIndexKey(): Promise<CryptoKey | null> {
  if (!armedOwnerKey) {return null;}
  try {
    const {loadMirrorMasterKey} = require('../runtime/keychain') as typeof import('../runtime/keychain');
    const rawB64 = await loadMirrorMasterKey(armedOwnerKey, armedUserId);
    if (!rawB64) {return null;}
    const {fromB64, importSubkey} = require('../backup/backupCrypto') as typeof import('../backup/backupCrypto');
    const master = fromB64(rawB64);
    const derived = hkdf(sha256, master, undefined, new TextEncoder().encode(HKDF_INFO), 32);
    master.fill(0);
    const key = await importSubkey(derived);
    derived.fill(0);
    return key;
  } catch {
    return null;
  }
}

function indexAad(): Uint8Array {
  const {backupAad} = require('../backup/backupCrypto') as typeof import('../backup/backupCrypto');
  return backupAad(AAD_PURPOSE, armedUserId ?? '');
}

async function fetchIndex(): Promise<{blob: string; seq: number} | null> {
  const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
  const {MSG_BASE_URL} = require('@utils/constants') as typeof import('@utils/constants');
  const res = await fetchWithRefresh(`${MSG_BASE_URL}/vault-index`, {
    headers: {'X-Signal-Device-Id': '1'},
  });
  if (!res.ok) {throw new Error(`vault-index get ${res.status}`);}
  const body = await res.json() as {blob: string; seq: number} | null;
  return body?.blob ? body : null;
}

async function putIndex(blobB64: string, seq: number): Promise<{ok: true} | {stale: number}> {
  const {fetchWithRefresh} = require('@/services/api') as typeof import('@/services/api');
  const {MSG_BASE_URL} = require('@utils/constants') as typeof import('@utils/constants');
  const res = await fetchWithRefresh(`${MSG_BASE_URL}/vault-index`, {
    method:  'POST',
    headers: {'Content-Type': 'application/json', 'X-Signal-Device-Id': '1'},
    body:    JSON.stringify({blob: blobB64, seq}),
  });
  if (res.status === 409) {
    const body = await res.json().catch(() => null) as {currentSeq?: number} | null;
    return {stale: typeof body?.currentSeq === 'number' ? body.currentSeq : seq};
  }
  if (!res.ok) {throw new Error(`vault-index put ${res.status}`);}
  return {ok: true};
}

async function encryptCurrentIndex(key: CryptoKey): Promise<string | null> {
  const s = useVaultStore.getState();
  if (!armedOwnerKey || s.vaultOwner !== armedOwnerKey) {return null;}
  const payload: WirePayload = {
    v: 1,
    files: s.files.map(f => ({...f})),
    albumState: {
      albums:      s.albumState.albums.map(a => ({...a})),
      assignments: {...s.albumState.assignments},
    },
  };
  const {aesGcmEncrypt, toB64} = require('../backup/backupCrypto') as typeof import('../backup/backupCrypto');
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sealed = await aesGcmEncrypt(key, bytes, indexAad());
  return toB64(sealed);
}

async function mergeRemote(remote: {blob: string; seq: number}, key: CryptoKey): Promise<number> {
  const {aesGcmDecrypt, fromB64} = require('../backup/backupCrypto') as typeof import('../backup/backupCrypto');
  const plain = await aesGcmDecrypt(key, fromB64(remote.blob), indexAad());
  const parsed = JSON.parse(new TextDecoder().decode(plain)) as WirePayload;
  if (parsed?.v !== 1 || !Array.isArray(parsed.files)) {
    throw new Error('vault-index payload shape');
  }
  lastKnownSeq = remote.seq;
  return useVaultStore.getState().mergeVaultIndex(
    {files: parsed.files, albumState: parsed.albumState},
    removedThisSession,
  );
}

/** One push attempt; on stale_seq: pull+merge, adopt currentSeq+1, retry ONCE. */
async function pushNow(): Promise<void> {
  if (pushInFlight) {pushAgainAfter = true; return;}
  pushInFlight = true;
  try {
    const key = await deriveIndexKey();
    if (!key) {return;}   // no backup key — lane off, by contract
    if (lastKnownSeq === null) {
      // First push this session: learn the server seq (and merge what it has)
      // so the claimed seq is a real increment, not a guess.
      try {
        const remote = await fetchIndex();
        if (remote) {await mergeRemote(remote, key);}
        else {lastKnownSeq = 0;}
      } catch { /* offline — try the optimistic push below anyway */ }
    }
    const blob = await encryptCurrentIndex(key);
    if (!blob) {return;}
    const claim = (lastKnownSeq ?? 0) + 1;
    const out = await putIndex(blob, claim);
    if ('ok' in out) {
      lastKnownSeq = claim;
      console.log(`[vault.index] pushed seq=${claim} files=${useVaultStore.getState().files.length}`);
      return;
    }
    // stale_seq — another device moved it. Adopt: pull, merge, retry once.
    const remote = await fetchIndex();
    if (remote) {await mergeRemote(remote, key);}
    lastKnownSeq = Math.max(out.stale, remote?.seq ?? out.stale);
    const blob2 = await encryptCurrentIndex(key);
    if (!blob2) {return;}
    const claim2 = lastKnownSeq + 1;
    const out2 = await putIndex(blob2, claim2);
    if ('ok' in out2) {
      lastKnownSeq = claim2;
      console.log(`[vault.index] pushed-after-adopt seq=${claim2}`);
    } else {
      // Twice stale — someone is actively writing. Never hammer (I6); the
      // next mutation reschedules naturally.
      console.warn('[vault.index] still stale after adopt — deferring to next change');
      lastKnownSeq = out2.stale;
    }
  } catch (e) {
    console.warn('[vault.index] push failed:', (e as Error).message);
  } finally {
    pushInFlight = false;
    if (pushAgainAfter) {
      pushAgainAfter = false;
      schedulePush();
    }
  }
}

function schedulePush(): void {
  if (pushTimer) {clearTimeout(pushTimer);}
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void pushNow();
  }, PUSH_DEBOUNCE_MS);
}

/**
 * Arm the sync for this owner — called from MainNavigator's owner effect,
 * right after `adoptVaultOwnerWhenReady`. Subscribes to index-relevant store
 * changes (reference compare on `files`/`albumState`) and schedules a
 * debounced push per change burst; also runs one initial pull-merge when the
 * local index is empty.
 */
export function armVaultIndexSync(ownerKey: string, userId: string): void {
  if (!ownerKey || !userId) {return;}
  if (armedOwnerKey === ownerKey && unsubscribe) {return;}   // idempotent re-arm
  disarmVaultIndexSync();
  armedOwnerKey = ownerKey;
  armedUserId = userId;
  lastKnownSeq = null;
  removedThisSession.clear();
  let prevFiles = useVaultStore.getState().files;
  let prevAlbums = useVaultStore.getState().albumState;
  let prevOwner = useVaultStore.getState().vaultOwner;
  unsubscribe = useVaultStore.subscribe(s => {
    // Adoption often lands AFTER arming (adoptVaultOwnerWhenReady waits for
    // hydration) — the flip TO our owner is the moment a fresh install can
    // pull its index, so fire the restore here, not just at arm time.
    if (prevOwner !== armedOwnerKey && s.vaultOwner === armedOwnerKey) {
      void maybeRestoreVaultIndex();
    }
    prevOwner = s.vaultOwner;
    if (s.vaultOwner !== armedOwnerKey) {
      prevFiles = s.files;
      prevAlbums = s.albumState;
      return;   // a swap or sign-out is not a content change to publish
    }
    if (s.files === prevFiles && s.albumState === prevAlbums) {return;}
    // Track removals so a later pull cannot resurrect them (best-effort,
    // session-scoped — the design doc records the accepted limitation).
    if (s.files !== prevFiles) {
      const now = new Set(s.files.map(f => f.objectKey));
      for (const f of prevFiles) {
        if (!now.has(f.objectKey)) {removedThisSession.add(f.objectKey);}
      }
    }
    prevFiles = s.files;
    prevAlbums = s.albumState;
    schedulePush();
  });
  void maybeRestoreVaultIndex();
}

export function disarmVaultIndexSync(): void {
  if (unsubscribe) {unsubscribe(); unsubscribe = null;}
  if (pushTimer) {clearTimeout(pushTimer); pushTimer = null;}
  armedOwnerKey = null;
  armedUserId = null;
  lastKnownSeq = null;
  pushAgainAfter = false;
  removedThisSession.clear();
}

/**
 * Pull-and-merge when the local index is empty (fresh install / new device).
 * Safe to call any time: no-ops without an armed owner, a mirror key, or a
 * server blob. Also called by BackupRestoreScreen right after the restore
 * persists the mirror key — the moment the files become recoverable.
 */
export async function maybeRestoreVaultIndex(): Promise<void> {
  try {
    if (!armedOwnerKey) {return;}
    const s = useVaultStore.getState();
    if (s.vaultOwner !== armedOwnerKey || s.files.length > 0) {return;}
    const key = await deriveIndexKey();
    if (!key) {return;}
    const remote = await fetchIndex();
    if (!remote) {return;}
    const added = await mergeRemote(remote, key);
    if (added > 0) {
      console.log(`[vault.index] restored files=${added} seq=${remote.seq}`);
    }
  } catch (e) {
    console.warn('[vault.index] restore skipped:', (e as Error).message);
  }
}

/** Test hook — deterministic access to the module state. */
export function __vaultIndexSyncTestState() {
  return {armedOwnerKey, lastKnownSeq, removedThisSession, pushScheduled: pushTimer !== null};
}

/** Test hook — run any pending debounced push NOW and await it. */
export async function __flushVaultIndexPushForTests(): Promise<void> {
  if (pushTimer) {clearTimeout(pushTimer); pushTimer = null;}
  await pushNow();
}
