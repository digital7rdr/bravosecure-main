import {Platform} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {open} from '@op-engineering/op-sqlite';
import {
  destroyDbKey,
  destroyGroupWrapKey,
  destroyCompartmentDbKey,
  destroyMerkleSeqHmacKey,
  clearMirrorMasterKey,
  getOrCreateDbKey,
  ALL_COMPARTMENTS,
} from './keychain';

/**
 * Audit P0-S1 — destroy every at-rest artifact tied to one user.
 *
 * The previous behaviour was: signOut tore down the runtime, cleared
 * Zustand state, and revoked tokens — but the user's SQLCipher DB file
 * stayed on disk, the keychain SQLCipher key stayed valid, the mirror
 * key stayed valid, the group-wrap key stayed valid, and the
 * AsyncStorage vault slice with conversation metadata stayed in place.
 * On a family / shared / reassigned device the next user's app boot
 * could (and did) re-open the previous account's encrypted DB with
 * the still-present keychain entry — because the DB filename is
 * scoped by `ownerKey` (email/phone) which the next account also
 * sees when typing it into the login screen during a recovery flow.
 *
 * This helper runs after `disposeLiveRuntime` has closed the live
 * handles and BEFORE the auth state is cleared, in this order:
 *
 *   1. Re-open the SQLCipher DB (cheap — the keychain key is still
 *      live and the file exists) and call its `delete()` native
 *      method. op-sqlite's delete removes the .db, .db-wal, and
 *      .db-shm files in one shot, so a process kill between the
 *      delete and the keychain wipe still leaves nothing decryptable.
 *   2. Destroy the SQLCipher encryption key in the keychain. Without
 *      this, any leftover .db file (e.g. user reinstalled mid-wipe
 *      and the OS still has a stale copy in a backup snapshot)
 *      remains decryptable.
 *   3. Destroy the per-user group-wrap key (P0-S5 second compartment).
 *   4. Destroy the mirror master key (backup-mirror Argon2id-derived),
 *      the per-compartment SQLCipher keys (id/rt/msg), and the
 *      Merkle-seq HMAC key.
 *   5. Drop the AsyncStorage vault slice for this owner so the
 *      conversation list / group state / member-name overrides don't
 *      leak into the next login session.
 *
 * Every step is best-effort: a failure in one branch does NOT skip
 * the others — we'd rather wipe partially than not at all. The caller
 * (authStore.signOut) gets a `WipeReport` with per-step status so
 * telemetry can flag stuck phones.
 */

export interface WipeReport {
  dbFileDeleted:        boolean;
  dbKeyDestroyed:       boolean;
  groupWrapDestroyed:   boolean;
  mirrorKeyDestroyed:   boolean;
  // F11 — per-compartment SQLCipher keys (id/rt/msg) + Merkle-seq HMAC key.
  compartmentKeysDestroyed: boolean;
  merkleSeqKeyDestroyed:    boolean;
  asyncStorageStripped: boolean;
  errors:               string[];
}

const STORE_KEY = 'messenger-store-v1';

function sanitiseForFilename(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function dbNameFor(ownerKey: string): string {
  const slug = sanitiseForFilename(ownerKey).slice(0, 24);
  return `messenger-${slug}-${Platform.OS}.db`;
}

/**
 * Wipe one user's at-rest state from this device. `ownerKey` is the
 * STABLE persistence key (email/phone) used to scope the keychain
 * entries and the SQLCipher filename — same value `resolveOwnStore`
 * passes to `getOrCreateDbKey` and the runtime config's `ownerKey`.
 *
 * Safe to call when no DB exists (e.g. logout immediately after a
 * boot that never opened the DB) — every step is null-safe.
 */
export async function wipeUserAtRest(ownerKey: string): Promise<WipeReport> {
  const report: WipeReport = {
    dbFileDeleted:        false,
    dbKeyDestroyed:       false,
    groupWrapDestroyed:   false,
    mirrorKeyDestroyed:   false,
    compartmentKeysDestroyed: false,
    merkleSeqKeyDestroyed:    false,
    asyncStorageStripped: false,
    errors:               [],
  };
  if (!ownerKey) {
    report.errors.push('wipeUserAtRest called with empty ownerKey');
    return report;
  }

  // Step 1 — re-open the SQLCipher DB just to delete it. The keychain
  // entry MUST still be intact at this point; we destroy it in step 2.
  try {
    const encryptionKey = await getOrCreateDbKey(ownerKey);
    const name = dbNameFor(ownerKey);
    const handle = open({name, encryptionKey, location: 'documents'});
    try {
      // op-sqlite removes .db / .db-wal / .db-shm in one native call.
      handle.delete();
      report.dbFileDeleted = true;
    } finally {
      // Some op-sqlite versions deallocate inside delete(); guard close()
      // so a double-free doesn't throw.
      try { handle.close(); } catch { /* expected after delete() */ }
    }
  } catch (e) {
    report.errors.push('db delete: ' + ((e as Error).message ?? String(e)));
  }

  // Step 2 — destroy the SQLCipher encryption key. After this, even if
  // step 1 left a stale file behind (rare op-sqlite race, OS snapshot,
  // ADB backup), the file is permanently undecryptable.
  try {
    await destroyDbKey(ownerKey);
    report.dbKeyDestroyed = true;
  } catch (e) {
    report.errors.push('db key destroy: ' + ((e as Error).message ?? String(e)));
  }

  // Step 3 — destroy the group-wrap key (P0-S5 second compartment).
  try {
    await destroyGroupWrapKey(ownerKey);
    report.groupWrapDestroyed = true;
  } catch (e) {
    report.errors.push('group wrap destroy: ' + ((e as Error).message ?? String(e)));
  }

  // Step 4 — destroy the backup-mirror master key. Without this, the
  // next user's app boot under the same ownerKey would silently
  // resume mirroring under the previous user's identity.
  try {
    await clearMirrorMasterKey(ownerKey);
    report.mirrorKeyDestroyed = true;
  } catch (e) {
    report.errors.push('mirror key clear: ' + ((e as Error).message ?? String(e)));
  }

  // Step 4b — F11: destroy the per-compartment SQLCipher keys (id/rt/msg,
  // P0-S5 residual). Post-migration installs keep the ratchet/identity/
  // message compartments under these entries, not the legacy single key,
  // so leaving them behind left the compartment files decryptable.
  {
    let allDestroyed = true;
    for (const c of ALL_COMPARTMENTS) {
      try {
        await destroyCompartmentDbKey(ownerKey, c);
      } catch (e) {
        allDestroyed = false;
        report.errors.push(`compartment key destroy (${c}): ` + ((e as Error).message ?? String(e)));
      }
    }
    report.compartmentKeysDestroyed = allDestroyed;
  }

  // Step 4c — F11: destroy the Merkle-seq HMAC key (P1-N12). Residual
  // material would let the next owner of this device mint valid seq tags
  // for the previous user's backup chain.
  try {
    await destroyMerkleSeqHmacKey(ownerKey);
    report.merkleSeqKeyDestroyed = true;
  } catch (e) {
    report.errors.push('merkle seq key destroy: ' + ((e as Error).message ?? String(e)));
  }

  // Step 5 — strip the AsyncStorage vault slice for this owner.
  // The Zustand `persist` middleware stores the entire store under
  // `messenger-store-v1`; we read it, drop the owner's slice from
  // `vaultByOwner`, and write it back. Safer than blowing away the
  // whole entry (which would also nuke any OTHER owner who's
  // logged in from this device).
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as {state?: {vaultByOwner?: Record<string, unknown>; _ownUserId?: string | null}};
        if (parsed?.state?.vaultByOwner && ownerKey in parsed.state.vaultByOwner) {
          delete parsed.state.vaultByOwner[ownerKey];
        }
        // If this was the active owner, also clear _ownUserId so the
        // next boot doesn't try to re-hydrate the slice we just dropped.
        if (parsed?.state?._ownUserId === ownerKey) {
          parsed.state._ownUserId = null;
        }
        await AsyncStorage.setItem(STORE_KEY, JSON.stringify(parsed));
        report.asyncStorageStripped = true;
      } catch (parseErr) {
        // Corrupt JSON or unexpected shape — purge the whole entry as
        // a last resort. This is safer than leaving an unparseable
        // blob that the next user's persist middleware can't read.
        await AsyncStorage.removeItem(STORE_KEY);
        report.asyncStorageStripped = true;
        report.errors.push('vault parse fallback removeItem: ' +
          ((parseErr as Error).message ?? String(parseErr)));
      }
    } else {
      // Nothing to strip — count as success.
      report.asyncStorageStripped = true;
    }
  } catch (e) {
    report.errors.push('AsyncStorage strip: ' + ((e as Error).message ?? String(e)));
  }

  return report;
}
