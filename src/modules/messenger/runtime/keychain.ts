import * as Keychain from 'react-native-keychain';

// Legacy single-compartment SQLCipher key. Pre-P0-S5-residual, this
// was the ONE key wrapping identity + ratchets + messages + group keys.
// Kept for the legacy-migration read path; new installs and post-migration
// reads route through the per-compartment helpers below.
const SERVICE_PREFIX = 'bravo.messenger.dbkey';
const MIRROR_KEY_PREFIX = 'bravo.messenger.mirrorkey';
// Audit P0-S5 — second keychain compartment used to wrap group master
// keys before they land in the SQLCipher DB. Single-key extraction of
// the SQLCipher key no longer yields plaintext group keys; an attacker
// needs BOTH this entry AND the SQLCipher entry to decrypt a group's
// history. Stored under a separate Keychain service so OS-level ACL
// boundaries (different access groups on iOS, different aliases under
// the Android Keystore) protect the two surfaces independently.
const GROUP_WRAP_KEY_PREFIX = 'bravo.messenger.groupwrap';

// Audit P0-S5 residual — three separate compartments for the SQLCipher
// data. Each compartment has its own keychain entry; a single-entry
// keystore extraction recovers AT MOST ONE compartment.
//
//   id  → identity / pre_keys / signed_pre_keys
//   rt  → sessions / trusted_identities / peer_session_health /
//         seen_envelopes / pending_group_envelopes /
//         pending_admin_actions  (the primary file — schema_version
//         also lives here)
//   msg → messages / media_blobs / outbox / group_master_keys
//
// The runtime opens the rt file first, then ATTACHes id + msg with
// their respective keys. Per-compartment GroupState master keys still
// wrap under the separate `groupWrap` key (defence in depth — even an
// attacker with all three SQLCipher entries needs the wrap key to
// unwrap group master rows).
const COMPARTMENT_KEY_PREFIXES: Record<DbCompartment, string> = {
  id:  'bravo.messenger.dbkey.id',
  rt:  'bravo.messenger.dbkey.rt',
  msg: 'bravo.messenger.dbkey.msg',
};

export type DbCompartment = 'id' | 'rt' | 'msg';
export const ALL_COMPARTMENTS: readonly DbCompartment[] = ['id', 'rt', 'msg'];

function serviceFor(userId: string): string {
  // Scoped per user — each account gets its own hardware-backed key.
  return `${SERVICE_PREFIX}.${userId}`;
}

function compartmentServiceFor(userId: string, c: DbCompartment): string {
  return `${COMPARTMENT_KEY_PREFIXES[c]}.${userId}`;
}

function mirrorServiceFor(userId: string): string {
  return `${MIRROR_KEY_PREFIX}.${userId}`;
}

function groupWrapServiceFor(userId: string): string {
  return `${GROUP_WRAP_KEY_PREFIX}.${userId}`;
}

/**
 * Audit P0-S2 — hardware-bound, this-device-only access policy.
 *
 *   - `WHEN_PASSCODE_SET_THIS_DEVICE_ONLY`: requires a passcode/biometric
 *     to be enrolled (refuses to write the key on a no-passcode device)
 *     and never participates in iCloud Keychain / device-migration —
 *     swapping the SIM into a new phone does NOT carry the SQLCipher key
 *     over.
 *   - `SECURITY_LEVEL.SECURE_HARDWARE` (Android): forces the underlying
 *     AES key into the TEE / StrongBox, where it cannot be exfiltrated
 *     even by a root-level attacker reading the keystore database.
 *     Silently downgrades to SECURE_SOFTWARE on devices without StrongBox
 *     so the call doesn't fail across the fleet.
 *
 * NOTE: we deliberately do NOT set `accessControl: BIOMETRY_*` here.
 * That would force a biometric prompt on every SQLCipher open (every
 * cold start, every FCM wake, every WS reconnect) — UX-prohibitive and
 * would break headless paths like push-data delivery. The PASSCODE_SET
 * + THIS_DEVICE_ONLY combination is the cell-phone-grade "coerced
 * unlock requires actually unlocking the device" gate without the per-
 * access biometric prompt.
 */
const STRICT_KEY_OPTS: Keychain.SetOptions = {
  accessible: Keychain.ACCESSIBLE.WHEN_PASSCODE_SET_THIS_DEVICE_ONLY,
  securityLevel: Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
};

/**
 * Fallback options for devices that genuinely have no screen-lock set
 * (rare on shipped Bravo Secure devices but possible in dev / on first-
 * boot of a wiped phone). Using PASSCODE_SET_THIS_DEVICE_ONLY against
 * such a device makes `setGenericPassword` fail outright, locking the
 * user out of the messenger before they've even set up a passcode.
 * The fallback preserves write capability but logs a warning so the
 * defence is observable in telemetry.
 */
const FALLBACK_KEY_OPTS: Keychain.SetOptions = {
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function setStrictGenericPassword(
  account: string,
  password: string,
  service: string,
): Promise<void> {
  try {
    await Keychain.setGenericPassword(account, password, { service, ...STRICT_KEY_OPTS });
  } catch (e) {
    // Most common failure mode: ErrSecAuthFailed on iOS when no passcode
    // is set, or "keystore lock screen required" on Android. Fall back
    // to WHEN_UNLOCKED_THIS_DEVICE_ONLY so the messenger still boots;
    // surface a warn so the security telemetry can flag the device.
    console.warn(
      '[keychain] strict-options write failed for service=' + service +
      ' — falling back to WHEN_UNLOCKED_THIS_DEVICE_ONLY. err=' +
      ((e as Error).message ?? String(e)),
    );
    await Keychain.setGenericPassword(account, password, { service, ...FALLBACK_KEY_OPTS });
  }
}

/**
 * B-15b — `Keychain.getGenericPassword` can transiently return `false` (Android
 * Keystore miss under load / on cold boot; MIUI/StrongBox flakiness) or throw,
 * even when a real entry exists. A single such miss inside getOrCreateDbKey /
 * getOrCreateCompartmentDbKey used to MINT a fresh SQLCipher key OVER the real
 * one, permanently orphaning the on-disk DB — i.e. "my chat history disappeared".
 *
 * Retry a falsy/throwing read a few times with linear backoff before treating it
 * as a genuine "no key". This is pure READ-hardening: storage policy, key
 * derivation, length, and the strict access options are all unchanged, and a
 * TRUE fresh install still returns `false` after every attempt so the normal
 * mint-a-new-key path proceeds. Route EVERY key read through this — never call
 * getGenericPassword directly for a key whose absence triggers a mint.
 */
async function readKeychainWithRetry(
  service: string,
  attempts = 4,
  baseDelayMs = 120,
): Promise<Awaited<ReturnType<typeof Keychain.getGenericPassword>>> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await Keychain.getGenericPassword({ service });
      if (res && res.password) {
        return res;
      }
    } catch (e) {
      if (i === attempts - 1) {
        console.warn(
          '[keychain] read failed after ' + attempts + ' attempts for service=' +
          service + ' err=' + ((e as Error).message ?? String(e)),
        );
      }
    }
    if (i < attempts - 1) {
      // Linear backoff: 120 / 240 / 360ms — gives a flaky keystore time to
      // recover before we conclude the entry truly doesn't exist.
      await new Promise(r => setTimeout(r, baseDelayMs * (i + 1)));
    }
  }
  return false;
}

/**
 * Fetch (or generate) the SQLCipher encryption key for this specific user.
 * Scoped to userId so different accounts on the same device never share a key.
 *
 * Returns a 64-hex-char string (32 bytes). Do not log.
 */
export async function getOrCreateDbKey(userId: string): Promise<string> {
  const service = serviceFor(userId);
  const existing = await readKeychainWithRetry(service);
  if (existing && existing.password.length >= 64) {
    return existing.password;
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

  await setStrictGenericPassword('messenger-db', hex, service);
  return hex;
}

/**
 * Wipe the stored key for a specific user. Destructive — the user's SQLCipher
 * DB becomes permanently unreadable. Only call on sign-out / account delete.
 */
export async function destroyDbKey(userId: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: serviceFor(userId) });
}

/**
 * Non-creating probe: returns true iff a SQLCipher key already exists for
 * this user. Used by the backup-boot path to decide whether this device
 * is a FRESH install (no key, no SQLCipher DB, no Signal identity) vs
 * an existing one. On a fresh install with a server-side backup we route
 * the user through the BackupRestore screen BEFORE the messenger runtime
 * boots — once installIdentity() runs, a brand-new identity is written
 * and we can no longer offer "restore your old chats" as the answer is
 * "what old chats?".
 *
 * Don't ever use this to gate access to the key itself — call
 * getOrCreateDbKey for that. This is a yes/no presence test only.
 *
 * Returns true if EITHER the legacy single-compartment entry exists OR
 * the per-compartment ratchet entry exists. From the caller's perspective
 * ("has this user ever set up the messenger on this device?") both states
 * answer yes — the migration path turns the former into the latter on
 * the next openCryptoDb call.
 */
export async function hasDbKey(userId: string): Promise<boolean> {
  const legacy = await readKeychainWithRetry(serviceFor(userId));
  if (legacy && legacy.password.length >= 64) {
    return true;
  }
  const rt = await readKeychainWithRetry(compartmentServiceFor(userId, 'rt'));
  return !!(rt && rt.password.length >= 64);
}

/**
 * Audit P0-S5 residual — fetch (or generate) the per-user SQLCipher key
 * for ONE compartment. Returns a 64-hex-char string (32 bytes); do not
 * log. Each compartment lives in its own keychain service so a one-shot
 * keystore exploit recovers at most one compartment.
 */
export async function getOrCreateCompartmentDbKey(
  userId: string, compartment: DbCompartment,
): Promise<string> {
  if (!userId) {throw new Error('compartment key requires a userId');}
  const service = compartmentServiceFor(userId, compartment);
  const existing = await readKeychainWithRetry(service);
  if (existing && existing.password.length >= 64) {return existing.password;}

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  await setStrictGenericPassword(`messenger-db-${compartment}`, hex, service);
  return hex;
}

/**
 * Read-only probe for ONE compartment. Used by the legacy-migration
 * path in openCryptoDb to detect "compartments already provisioned" vs
 * "need to migrate from the legacy single DB" vs "fresh install".
 */
export async function loadCompartmentDbKey(
  userId: string, compartment: DbCompartment,
): Promise<string | null> {
  if (!userId) {return null;}
  const existing = await readKeychainWithRetry(compartmentServiceFor(userId, compartment));
  if (!existing || existing.password.length < 64) {return null;}
  return existing.password;
}

/**
 * Read the LEGACY single-compartment SQLCipher key without creating one.
 * Used by openCryptoDb's migration path to attach the old single-file DB
 * as `legacy.` and copy rows into the per-compartment files. Returns null
 * if no legacy key was ever written (fresh install on a post-S5-residual
 * version of the app).
 */
export async function loadLegacyDbKey(userId: string): Promise<string | null> {
  if (!userId) {return null;}
  const existing = await readKeychainWithRetry(serviceFor(userId));
  if (!existing || existing.password.length < 64) {return null;}
  return existing.password;
}

/**
 * Destroy the per-compartment key. Called by wipeUserAtRest for each of
 * the three compartments after the corresponding SQLCipher file has been
 * deleted (or attempted to be).
 */
export async function destroyCompartmentDbKey(
  userId: string, compartment: DbCompartment,
): Promise<void> {
  if (!userId) {return;}
  await Keychain.resetGenericPassword({
    service: compartmentServiceFor(userId, compartment),
  });
}

/**
 * Persist the BACKUP MIRROR MASTER KEY in the OS keychain.
 *
 * The mirror key is derived from the user's backup password (Argon2id).
 * Holding it ONLY in module memory meant every cold start (process kill,
 * Doze wake, OS reboot) left the live mirror dead — the user's session
 * SQLCipher kept storing messages locally but the backup mirror silently
 * no-op'd until they re-entered the password from Settings → Chat
 * Backup. Result: on reinstall the server-side backup contained only
 * the slice of history sent during the same session as setup, and the
 * user thought "most of my chat is gone".
 *
 * Storing the raw key bytes here is safe in the same threat model the
 * SQLCipher DB key already lives under: hardware-backed keystore, only
 * accessible while the device is unlocked, scoped per-userId, wiped on
 * sign-out via clearMirrorMasterKey. The key is base64-encoded for
 * Keychain (it's a string-only API).
 */
export async function saveMirrorMasterKey(userId: string, rawKeyB64: string): Promise<void> {
  if (!userId || !rawKeyB64) {return;}
  await setStrictGenericPassword('messenger-mirror', rawKeyB64, mirrorServiceFor(userId));
}

export async function loadMirrorMasterKey(
  userId: string,
  legacyOwnerId?: string | null,
): Promise<string | null> {
  if (!userId) {return null;}
  const existing = await readKeychainWithRetry(mirrorServiceFor(userId));
  if (existing && existing.password) {return existing.password;}
  // Migration — builds <=1.0.36 saved the mirror key under the Signal
  // UUID (user.id) while every reader looks it up under ownerKey
  // (email ?? phone). If the canonical lookup misses but a legacy
  // UUID-keyed entry exists, adopt it: re-save under the canonical
  // owner and drop the stale entry so this one-shot never repeats.
  if (legacyOwnerId && legacyOwnerId !== userId) {
    const legacy = await readKeychainWithRetry(mirrorServiceFor(legacyOwnerId));
    if (legacy && legacy.password) {
      try {
        await saveMirrorMasterKey(userId, legacy.password);
        await Keychain.resetGenericPassword({service: mirrorServiceFor(legacyOwnerId)});
        console.log('[keychain] migrated mirror key legacy→owner');
      } catch (e) {
        console.warn('[keychain] mirror key migration failed:', (e as Error).message);
      }
      return legacy.password;
    }
  }
  return null;
}

export async function clearMirrorMasterKey(userId: string): Promise<void> {
  if (!userId) {return;}
  await Keychain.resetGenericPassword({service: mirrorServiceFor(userId)});
}

/**
 * Audit P0-S5 — fetch (or generate) the per-user GROUP-KEY-WRAP secret.
 *
 * Lives in its OWN keychain entry, separate from the SQLCipher DB key.
 * The on-disk `group_master_keys` table stores each group's master key
 * AES-GCM-encrypted under this wrap secret. To recover a group's
 * plaintext history an attacker must extract BOTH:
 *   1. the SQLCipher DB key (to read the wrapped ciphertext row), and
 *   2. this wrap secret (to unwrap it).
 *
 * Single-keychain-entry exfiltration via a one-shot keystore exploit
 * (the threat the audit calls out) therefore no longer yields plaintext
 * group keys. Identity / ratchet state remains under the SQLCipher key
 * because moving it would force a re-handshake against every peer.
 *
 * Returns a 44-char base64 string (32 bytes). Do not log.
 */
export async function getOrCreateGroupWrapKey(userId: string): Promise<string> {
  if (!userId) {throw new Error('group-wrap key requires a userId');}
  const service = groupWrapServiceFor(userId);
  const existing = await readKeychainWithRetry(service);
  if (existing && existing.password.length >= 32) {return existing.password;}

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let b64 = '';
  // Local base64 encode that works in both Node tests and React Native.
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64');
  } else if (typeof (globalThis as { btoa?: (s: string) => string }).btoa === 'function') {
    let bin = '';
    for (const b of bytes) {bin += String.fromCharCode(b);}
    b64 = (globalThis as { btoa: (s: string) => string }).btoa(bin);
  } else {
    throw new Error('no base64 encoder available');
  }
  await setStrictGenericPassword('messenger-group-wrap', b64, service);
  return b64;
}

/**
 * Wipe the group-key-wrap secret for a specific user. Destructive — any
 * wrapped group master keys still on disk become permanently undecryptable.
 * Called from the logout / account-delete path alongside destroyDbKey.
 */
export async function destroyGroupWrapKey(userId: string): Promise<void> {
  if (!userId) {return;}
  await Keychain.resetGenericPassword({service: groupWrapServiceFor(userId)});
}

/**
 * Audit P1-N12 — per-user HMAC secret for tagging the Merkle-commit
 * sequence number stored in AsyncStorage. Stored under its own
 * keychain service so an AsyncStorage-only compromise can't mint a
 * valid tag for an attacker-chosen seq, and so a single-keychain-
 * entry exploit doesn't bring down both this AND the SQLCipher key.
 *
 * Returns a 44-char base64 string (32 bytes). Do not log.
 */
const MERKLE_SEQ_HMAC_PREFIX = 'bravo.messenger.merkleseq';

export async function getOrCreateMerkleSeqHmacKey(userId: string): Promise<string> {
  if (!userId) {throw new Error('merkle-seq HMAC key requires a userId');}
  const service = `${MERKLE_SEQ_HMAC_PREFIX}.${userId}`;
  const existing = await readKeychainWithRetry(service);
  if (existing && existing.password.length >= 32) {return existing.password;}

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let b64 = '';
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(bytes).toString('base64');
  } else if (typeof (globalThis as { btoa?: (s: string) => string }).btoa === 'function') {
    let bin = '';
    for (const b of bytes) {bin += String.fromCharCode(b);}
    b64 = (globalThis as { btoa: (s: string) => string }).btoa(bin);
  } else {
    throw new Error('no base64 encoder available');
  }
  await setStrictGenericPassword('messenger-merkle-seq', b64, service);
  return b64;
}

export async function destroyMerkleSeqHmacKey(userId: string): Promise<void> {
  if (!userId) {return;}
  await Keychain.resetGenericPassword({service: `${MERKLE_SEQ_HMAC_PREFIX}.${userId}`});
}
