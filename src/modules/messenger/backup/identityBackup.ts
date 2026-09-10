/**
 * Wrap / unwrap the Signal identity bundle for cross-device restore.
 *
 * On setup:
 *   1. Generate a fresh 32-byte master_key
 *   2. argon2id(password, salt) → derived_key
 *   3. verifier_key = HKDF(derived_key, 'bravo-backup-verifier-v1', 32B)
 *   4. wrapped_master_key = AES-GCM(master_key, derived_key)
 *   5. wrapped_identity_bundle = AES-GCM(JSON.stringify(identity), master_key)
 *   6. POST {wrapped_master_key, salt, kdf_params, wrapped_identity_bundle, verifier_key}
 *
 * On restore (P0-1 server-enforced verify):
 *   1. GET /backup/identity/header → salt, kdf_params, single-use nonce
 *   2. argon2id(entered_password, salt) → derived_key
 *   3. proof = HMAC(HKDF(derived_key,...), 'bravo-backup-verify-v1:userId:nonce')
 *   4. POST /backup/identity/verify {nonce, proof}
 *      → wrong proof: server bumps the lockout counter, returns 401
 *      → correct: server returns a single-use verify_token
 *   5. GET /backup/identity/bundle?verifyToken=… (403 without a valid token)
 *   6. master_key = AES-GCM-decrypt(wrapped_master_key, derived_key)
 *   7. identity_json = AES-GCM-decrypt(wrapped_identity_bundle, master_key)
 *   8. Re-install identity into the local CryptoStore via reinstallIdentity()
 *
 * The bundle we ship covers EVERYTHING the local CryptoStore needs to
 * resume Signal sessions:
 *   • Long-lived identity key pair (pub + priv)
 *   • Local registration id
 *   • The signed pre-key (id, key pair, signature)
 *   • The pool of one-time pre-keys (id + key pair each)
 *
 * Sessions themselves (X3DH ratchet state per peer) are NOT included —
 * they re-establish on first message exchange post-restore. Same as
 * WhatsApp: after restore, the first inbound message kicks a session
 * rebuild and only that handshake message itself can't be decrypted.
 */
import {
  aesGcmDecrypt, aesGcmEncrypt, deriveMasterKeyAndRaw,
  deriveVerifierKey, computeVerifyProof, assertKdfParamsWithinBounds,
  DEFAULT_KDF_PARAMS, fromB64, generateMasterKey, importMasterKey, randomBytes, toB64,
  type KdfParams,
} from './backupCrypto';
import {backupClient, BackupError, type IdentityBundle} from './backupClient';
import type {CryptoStore} from '@bravo/messenger-core';

export interface SerializedIdentity {
  registrationId: number;
  identityKey: {
    pub:  string;   // base64 of ArrayBuffer
    priv: string;
  };
  signedPreKey: {
    id:        number;
    pub:       string;
    priv:      string;
    signature: string;
  };
  preKeys: Array<{
    id:   number;
    pub:  string;
    priv: string;
  }>;
}

const MAGIC = 'bravo-identity-v1';

interface SerializedIdentityEnvelope {
  v:        1;
  magic:    typeof MAGIC;
  identity: SerializedIdentity;
  // M-3 — bind the wrapped identity bundle to its owner so a server that
  // serves a different account's bundle is detectable on restore. Optional
  // for backward compatibility with bundles written before this field.
  owner?:   string;
}

/**
 * Round 8 — module-scoped reference to the unlocked master key + the
 * salt + kdf params that were used to wrap it. Set by setupBackup /
 * restoreBackup on success; cleared by `lockIdentityBackup` (called
 * from disposeMirror on logout). Used by `refreshIdentityBackup` to
 * re-upload the bundle after an OPK refill so post-setup OPK private
 * keys reach the encrypted backup.
 *
 * Holding the master key here mirrors how messageMirror holds it: it's
 * the same in-memory authority gate. Logout wipes both.
 */
let liveMasterKey: CryptoKey | null = null;
let liveWrappedMasterKeyB64: string | null = null;
let liveSalt: Uint8Array | null = null;
let liveKdfParams: KdfParams | null = null;
let liveStore: CryptoStore | null = null;
// P0-1 — the verifier key (base64) pinned alongside the wrap context so
// refreshIdentityBackup can re-upload without re-deriving from password
// (putIdentity now requires a verifier key on every upload).
let liveVerifierKeyB64: string | null = null;
// M-3 — owner pinned for refreshIdentityBackup's envelope binding.
let liveOwnerUserId: string | null = null;

export function lockIdentityBackup(): void {
  liveMasterKey = null;
  liveWrappedMasterKeyB64 = null;
  liveSalt = null;
  liveKdfParams = null;
  liveStore = null;
  liveVerifierKeyB64 = null;
  liveOwnerUserId = null;
}

// ─── Capture from a live CryptoStore ──────────────────────────────────

interface IdentityCapableStore extends CryptoStore {
  /** Optional internal accessor to enumerate stored pre-keys. */
  enumeratePreKeys?: () => Promise<Array<{id: number; pub: ArrayBuffer; priv: ArrayBuffer}>>;
  /** Optional: stored signed pre-key with both halves of the keypair. */
  loadSignedPreKeyPriv?: (id: number) => Promise<ArrayBuffer | null>;
  loadPreKeyPriv?: (id: number) => Promise<ArrayBuffer | null>;
}

export async function captureIdentity(store: CryptoStore): Promise<SerializedIdentity> {
  const s = store as IdentityCapableStore;
  const identity = await store.getIdentityKeyPair();
  const registrationId = await store.getLocalRegistrationId();

  // Signed pre-key id is fixed at 1 (matches installIdentity in
  // crypto/identity.ts). If the store stops baking that assumption in
  // we'll need a registry; for now a single signed pre-key is the only
  // shape this app produces.
  const signedPreKeyId = 1;
  const spk = await store.loadSignedPreKey(signedPreKeyId);
  if (!spk) {throw new Error('signed_pre_key_missing');}
  if (!spk.signature) {throw new Error('signed_pre_key_signature_missing');}
  const spkPriv = s.loadSignedPreKeyPriv
    ? await s.loadSignedPreKeyPriv(signedPreKeyId)
    : (spk as unknown as {privKey?: ArrayBuffer}).privKey ?? null;
  if (!spkPriv) {throw new Error('signed_pre_key_priv_missing');}

  const preKeys: SerializedIdentity['preKeys'] = [];
  if (s.enumeratePreKeys) {
    const enumerated = await s.enumeratePreKeys();
    for (const pk of enumerated) {
      preKeys.push({id: pk.id, pub: bufToB64(pk.pub), priv: bufToB64(pk.priv)});
    }
  } else {
    // Round 8 — widened scan to ids 1..10_000. The previous 1..200 cap
    // silently dropped every OPK above id 200, which a power user
    // would hit after ~3 refills (~150 sessions). Peers using one of
    // the dropped OPKs could not be decrypted after restore. The scan
    // is allocate-only on `loadPreKey` (a SQLCipher PK lookup) — empty
    // probes are cheap; we exit early via the gap-counter once we've
    // seen a long contiguous gap, so the worst-case cost is bounded
    // by the highest OPK id the user has actually generated.
    const SCAN_HARD_CAP = 10_000;
    const GAP_TOLERANCE = 200;
    let gap = 0;
    for (let id = 1; id <= SCAN_HARD_CAP; id++) {
      const pk = await store.loadPreKey(id);
      if (!pk) {
        gap += 1;
        if (gap >= GAP_TOLERANCE) {break;}
        continue;
      }
      gap = 0;
      const priv = s.loadPreKeyPriv
        ? await s.loadPreKeyPriv(id)
        : (pk as unknown as {privKey?: ArrayBuffer}).privKey ?? null;
      if (!priv) {continue;}
      preKeys.push({id, pub: bufToB64(pk.pubKey), priv: bufToB64(priv)});
    }
  }

  return {
    registrationId,
    identityKey: {pub: bufToB64(identity.pubKey), priv: bufToB64(identity.privKey)},
    signedPreKey: {
      id:        signedPreKeyId,
      pub:       bufToB64(spk.pubKey),
      priv:      bufToB64(spkPriv),
      signature: bufToB64(spk.signature),
    },
    preKeys,
  };
}

// ─── Reinstall into a fresh CryptoStore ───────────────────────────────

interface ReinstallableStore extends CryptoStore {
  saveOwnIdentity?: (regId: number, pub: ArrayBuffer, priv: ArrayBuffer) => Promise<void>;
  setOwnIdentity?:  (regId: number, pub: ArrayBuffer, priv: ArrayBuffer) => void;
}

export async function reinstallIdentity(store: CryptoStore, identity: SerializedIdentity): Promise<void> {
  const s = store as ReinstallableStore;
  const idPub  = b64ToBuf(identity.identityKey.pub);
  const idPriv = b64ToBuf(identity.identityKey.priv);

  // M-18 — wrap the whole reinstall in a SQLCipher transaction (same
  // optional-bracket pattern as crypto/identity.installIdentity) so a
  // throw mid-loop rolls back instead of leaving a half-written identity
  // (identity present, some OPK private halves missing) that no boot
  // detects. The in-memory test store has no getDb() and no-ops the
  // bracket. OPKs are written first and the signed prekey LAST so it
  // stays the completion sentinel installIdentity relies on.
  type TxStore = {getDb?: () => {execute: (sql: string) => Promise<unknown>}};
  const db = (store as unknown as TxStore).getDb?.();
  let inTx = false;
  if (db) {
    // AUDIT F9 — deliberate raw BEGIN, budget-pinned (receiveTransaction
    // budget scan). HONEST rationale (critic rev-3): this is NOT boot-only
    // — reinstallIdentity is reachable from the Settings → Chat Backup
    // UNLOCK path (BackupSetupScreen), which by its own header does NOT
    // gate the runtime. A raw BEGIN here on the shared SQLCipher
    // connection CAN interleave with a live receive frame's BEGIN
    // IMMEDIATE — the P0-1 doctrine class. That exposure is pre-existing
    // and unchanged by F9; the audit register tracks the proper fix
    // (serialize this bracket through the receive txn chain). The budget
    // scan exists so no NEW raw BEGIN lands without re-justifying itself.
    await db.execute('BEGIN');
    inTx = true;
  }
  try {
    if (s.saveOwnIdentity) {
      await s.saveOwnIdentity(identity.registrationId, idPub, idPriv);
    } else if (s.setOwnIdentity) {
      s.setOwnIdentity(identity.registrationId, idPub, idPriv);
    } else {
      throw new Error('store_cannot_persist_own_identity');
    }
    for (const pk of identity.preKeys) {
      await store.storePreKey(pk.id, {pubKey: b64ToBuf(pk.pub), privKey: b64ToBuf(pk.priv)});
    }
    await store.storeSignedPreKey(
      identity.signedPreKey.id,
      {pubKey: b64ToBuf(identity.signedPreKey.pub), privKey: b64ToBuf(identity.signedPreKey.priv)},
      b64ToBuf(identity.signedPreKey.signature),
    );
    if (inTx && db) {await db.execute('COMMIT');}
  } catch (e) {
    if (inTx && db) {
      try { await db.execute('ROLLBACK'); }
      catch (rb) { console.warn('[identityBackup] reinstall rollback failed:', (rb as Error).message); }
    }
    throw e;
  }
}

// ─── End-to-end backup operations ─────────────────────────────────────

/**
 * Capture the local identity, generate a fresh master key, wrap it
 * with the password, wrap the identity with the master key, and ship
 * everything to the server. Caller (the Setup screen) is responsible
 * for confirming the password with the user before invoking us.
 *
 * Returns the in-memory master key — keep it alive in module-scope
 * memory so subsequent message-mirror calls can wrap message payloads
 * without re-deriving from password.
 */
export async function setupBackup(
  store: CryptoStore,
  password: string,
  ownerUserId?: string,
): Promise<{masterKey: CryptoKey; rawB64: string}> {
  const params: KdfParams = DEFAULT_KDF_PARAMS;
  const salt = randomBytes(params.saltBytes);
  const {key: derivedKey, raw: derivedRaw} = await deriveMasterKeyAndRaw(password, salt, params);
  // P0-1 — HKDF the verifier key from the derived key (one-way; the
  // server can validate proofs but can't recover the wrap key).
  let verifierKeyB64: string;
  try {
    const verifierKey = await deriveVerifierKey(derivedRaw);
    verifierKeyB64 = toB64(verifierKey);
    verifierKey.fill(0);
  } finally {
    // Why: zero the raw derived key on the throw path too (B-45 showed
    // a deriveVerifierKey failure previously left it live in memory).
    derivedRaw.fill(0);
  }

  const {key: masterKey, raw: masterRaw} = await generateMasterKey();
  // BUG-J — zero the raw master key on the encrypt-throw path too.
  let wrappedMaster: Uint8Array;
  let rawB64: string;
  try {
    wrappedMaster = await aesGcmEncrypt(derivedKey, masterRaw);
    // Capture the raw bytes for the caller to persist into the OS keychain
    // (saveMirrorMasterKey) BEFORE we burn them. Storing here means a cold
    // start on the same device can resume the mirror without re-prompting
    // for the backup password — without that, every kill→relaunch silently
    // disabled the mirror until the user opened Settings → Chat Backup.
    rawB64 = toB64(masterRaw);
  } finally {
    masterRaw.fill(0);
  }

  const identity = await captureIdentity(store);
  const envelope: SerializedIdentityEnvelope = {v: 1, magic: MAGIC, identity, owner: ownerUserId};
  const identityBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const wrappedIdentity = await aesGcmEncrypt(masterKey, identityBytes);

  const wrappedMasterB64 = toB64(wrappedMaster);
  await backupClient.putIdentity({
    wrappedMasterKey:      wrappedMasterB64,
    salt:                  toB64(salt),
    kdfParams:             params as unknown as Record<string, unknown>,
    wrappedIdentityBundle: toB64(wrappedIdentity),
    verifierKey:           verifierKeyB64,
  });
  // Round 8 — pin the live wrap context so refreshIdentityBackup can
  // re-upload after OPK refill without re-deriving from password.
  liveMasterKey = masterKey;
  liveWrappedMasterKeyB64 = wrappedMasterB64;
  liveSalt = salt;
  liveKdfParams = params;
  liveStore = store;
  liveVerifierKeyB64 = verifierKeyB64;
  liveOwnerUserId = ownerUserId ?? null;
  return {masterKey, rawB64};
}

/**
 * P0-1 restore: prove the password to the server, receive a single-use
 * token, then pull + unwrap the bundle. The server bumps the
 * brute-force counter on every wrong proof — the client no longer
 * self-reports failures.
 */
export async function restoreBackup(
  store: CryptoStore,
  password: string,
): Promise<{masterKey: CryptoKey; identity: SerializedIdentity; rawB64: string}> {
  // Header carries salt + kdf params + a fresh single-use verify nonce.
  const header = await backupClient.getIdentityHeader();
  if (header.verifierMissing) {
    // Legacy row (pre-P0-1) — no proof can succeed; the user must
    // re-enter their password on the Setup screen to re-wrap with a
    // verifier key attached.
    throw new BackupError('verifier_missing', 'verifier_missing');
  }
  const params = header.kdfParams as unknown as KdfParams;
  // M-1 — reject out-of-range server params (OOM/DoS/tamper) with a
  // distinct error, not "wrong password".
  try {
    assertKdfParamsWithinBounds(params);
  } catch (e) {
    throw new BackupError('server', `kdf_params_invalid:${(e as Error).message}`);
  }

  const {key: derivedKey, raw: derivedRaw} = await deriveMasterKeyAndRaw(password, fromB64(header.salt), params);
  // BUG-J (audit 2026-07-23) — one finally owns the raw wrap key. The
  // old per-branch fills missed the `getIdentityBundle` await (403
  // verify-token expiry, 30s abort, 5xx all left the 32-byte
  // password-derived key live in the heap), breaking the module's own
  // B-45 zero-on-throw contract. fill(0) is idempotent, so the
  // pre-existing early fills stay where they add promptness.
  let masterRaw: Uint8Array;
  let verifierKeyB64: string;
  let bundle: IdentityBundle;
  try {
    // Prove knowledge of the password before the wrapped bundle is served.
    const verifierKey = await deriveVerifierKey(derivedRaw);
    verifierKeyB64 = toB64(verifierKey);
    const proof = await computeVerifyProof(verifierKey, header.userId, header.verifyNonce);
    verifierKey.fill(0);

    let verifyToken: string;
    try {
      const v = await backupClient.verify({nonce: header.verifyNonce, proofB64: toB64(proof)});
      verifyToken = v.verifyToken;
    } catch (e) {
      if (e instanceof BackupError && e.kind === 'unauthorized' && e.message === 'wrong_password') {
        throw new BackupError('unauthorized', 'wrong_password');
      }
      throw e; // locked / nonce_expired / verifier_missing / network bubble up
    }

    bundle = await backupClient.getIdentityBundle(verifyToken);

    try {
      masterRaw = await aesGcmDecrypt(derivedKey, fromB64(bundle.wrappedMasterKey));
    } catch {
      // The proof already established the password is correct, so an
      // unwrap failure here means a corrupted/mismatched bundle — report
      // it as such rather than "wrong password".
      throw new BackupError('server', 'master_key_unwrap_failed');
    }
  } finally {
    derivedRaw.fill(0);
  }

  const masterKey = await importMasterKey(masterRaw);
  // Capture for keychain persistence (saveMirrorMasterKey) before burn.
  const rawB64 = toB64(masterRaw);
  masterRaw.fill(0);

  let identityJson: string;
  try {
    const ptBytes = await aesGcmDecrypt(masterKey, fromB64(bundle.wrappedIdentityBundle));
    identityJson = new TextDecoder().decode(ptBytes);
  } catch {
    throw new BackupError('server', 'identity_unwrap_failed');
  }
  const envelope = JSON.parse(identityJson) as SerializedIdentityEnvelope;
  if (envelope.magic !== MAGIC || envelope.v !== 1) {
    throw new BackupError('server', `unknown_envelope:${envelope.magic}`);
  }
  // M-3 — the envelope binds itself to its owner. A mismatch means the
  // server served a different account's bundle. Warn (don't hard-fail):
  // the master-key unwrap already gated access, and legacy bundles have
  // no owner field.
  if (envelope.owner && envelope.owner !== header.userId) {
    console.warn(`[bravo.restore] identity envelope owner mismatch (${envelope.owner.slice(0, 8)} != ${header.userId.slice(0, 8)})`);
  }
  await reinstallIdentity(store, envelope.identity);

  // Round 8 — pin the live wrap context for refreshIdentityBackup.
  // Keep the wrappedMasterKey we just used to unwrap so subsequent
  // re-uploads don't overwrite it with a freshly re-wrapped version
  // (that would wipe the server-side message history per the F6
  // same-key guard in BackupService.putIdentity).
  liveMasterKey = masterKey;
  liveWrappedMasterKeyB64 = bundle.wrappedMasterKey;
  liveSalt = fromB64(bundle.salt);
  liveKdfParams = params;
  liveStore = store;
  liveVerifierKeyB64 = verifierKeyB64;
  liveOwnerUserId = header.userId;

  return {masterKey, identity: envelope.identity, rawB64};
}

/**
 * Round 8 — re-upload the identity backup with the CURRENT contents
 * of the local CryptoStore. Used after `maybeReplenishOwnOpks` adds
 * fresh OPK private halves so they reach the user's encrypted backup.
 *
 * Reuses the pinned wrappedMasterKey + salt + kdfParams so the F6
 * same-key guard on the server treats this as an idempotent re-setup
 * (preserves all mirrored messages) instead of a key rotation
 * (wipes the lot).
 *
 * No-op when the mirror isn't unlocked — the next setupBackup or
 * restoreBackup will overwrite with a fresh snapshot anyway.
 */
export async function refreshIdentityBackup(store: CryptoStore): Promise<void> {
  if (!liveMasterKey || !liveWrappedMasterKeyB64 || !liveSalt || !liveKdfParams || !liveStore || !liveVerifierKeyB64) {
    return; // Mirror locked — skip silently.
  }
  if (store !== liveStore) {
    return; // Stale store handle from a prior session — skip.
  }
  const identity = await captureIdentity(store);
  const envelope: SerializedIdentityEnvelope = {v: 1, magic: MAGIC, identity, owner: liveOwnerUserId ?? undefined};
  const identityBytes = new TextEncoder().encode(JSON.stringify(envelope));
  const wrappedIdentity = await aesGcmEncrypt(liveMasterKey, identityBytes);
  await backupClient.putIdentity({
    wrappedMasterKey:      liveWrappedMasterKeyB64,
    salt:                  toB64(liveSalt),
    kdfParams:             liveKdfParams as unknown as Record<string, unknown>,
    wrappedIdentityBundle: toB64(wrappedIdentity),
    // P0-1 — reuse the pinned verifier key so the same-key re-upload
    // stays idempotent and the row keeps a valid verifier.
    verifierKey:           liveVerifierKeyB64,
  });
}

// ─── helpers ──────────────────────────────────────────────────────────

function bufToB64(buf: ArrayBuffer): string {
  return toB64(new Uint8Array(buf));
}

function b64ToBuf(b64: string): ArrayBuffer {
  const bytes = fromB64(b64);
  // Return a new ArrayBuffer slice rather than .buffer (which may be
  // the underlying SharedArrayBuffer in some environments).
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return ab;
}
