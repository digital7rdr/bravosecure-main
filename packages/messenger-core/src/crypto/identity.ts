import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import type { CryptoStore, PreKeyBundle, SessionAddress } from './types';
import { toBase64 } from './encoding';
import { StoreError } from './errors';

/**
 * One-time install keying. Generates the long-lived identity key pair,
 * registration id, signed pre-key (with signature), and an initial pool
 * of one-time pre-keys. Persists everything into the supplied store.
 *
 * Idempotent: with `force: false` (default) the call no-ops if identity
 * already exists — safe to call on every app boot.
 *
 * Audit fix #8 — the original implementation could leave the store in
 * a half-installed state if the process was killed mid-loop (identity
 * + a few prekeys but no signed prekey, or N/M prekeys persisted). On
 * the next boot the partial-state check `getIdentityKeyPair()` would
 * succeed and skip the rest of the work, leaving the user unable to
 * receive PreKeyWhisperMessage envelopes ("signedPreKey not found"
 * thrown deep inside libsignal). We now:
 *
 *   1. Use signed_pre_key as the COMPLETION SENTINEL — boot considers
 *      install complete only when both identity AND signed prekey
 *      exist. Any boot finding only identity falls through to retry.
 *   2. Wrap the whole loop in a SQLCipher transaction when the store
 *      exposes a `getDb()` (production path). On failure the BEGIN
 *      block rolls back and the next boot starts cleanly. The in-
 *      memory test store has no transactional support; we no-op the
 *      BEGIN/COMMIT for it (failures there are surfaced loudly to the
 *      developer anyway).
 */
export async function installIdentity(
  store: CryptoStore,
  opts: { preKeyCount?: number; force?: boolean } = {},
): Promise<void> {
  const { preKeyCount = 100, force = false } = opts;
  if (!force) {
    try {
      await store.getIdentityKeyPair();
      // Completion sentinel: identity plus AT LEAST ONE signed prekey.
      // Audit G-01 (2026-07-02): the old sentinel checked specifically
      // for signed_pre_key id 1, but the 30-day SPK rotation prunes id 1
      // (retention window), so ~30 days after install this check would
      // fail, installIdentity would re-run, and INSERT OR REPLACE would
      // regenerate a fresh identity key — silently breaking every
      // established 1:1 and group session. Checking for ANY signed prekey
      // is the correct completion sentinel: installIdentity writes id 1
      // last, and rotation always keeps the newest SPK, so a fully
      // installed store always has >= 1 SPK regardless of rotation state.
      let hasSignedPreKey = false;
      if (store.listSignedPreKeys) {
        const spks = await store.listSignedPreKeys();
        hasSignedPreKey = spks.length > 0;
      } else {
        // Legacy / test stubs without listSignedPreKeys never rotate, so
        // id 1 remains a valid sentinel for them.
        hasSignedPreKey = !!(await store.loadSignedPreKey(1));
      }
      if (hasSignedPreKey) {return;}
      console.warn('[crypto/identity] identity present but no signed prekey — re-running install');
    } catch {
      /* fall through */
    }
  }

  // Optional transactional bracket. The production SqlCipherProtocolStore
  // exposes `getDb()` which returns the underlying op-sqlite handle; we
  // wrap the install in BEGIN / COMMIT so a crash mid-loop rolls back.
  // The InMemoryProtocolStore (used in tests) lacks transactional
  // support; we no-op there. Closure-style so the writes inside still
  // go through the public CryptoStore API and we don't have to bypass
  // the type boundary.
  type TxStore = { getDb?: () => { execute: (sql: string) => Promise<unknown> } };
  const txStore = store as unknown as TxStore;
  const db = txStore.getDb?.();
  let inTx = false;
  if (db) {
    // AUDIT F9 — deliberate raw BEGIN, budget-pinned (receiveTransaction
    // budget scan). Timing-safe: install runs before any concurrent txn
    // chain user exists, and core cannot import the mobile chain anyway.
    // Do not add raw BEGINs elsewhere — the scan fails on any new site.
    await db.execute('BEGIN');
    inTx = true;
  }

  try {
    const registrationId = KeyHelper.generateRegistrationId();
    const identity = await KeyHelper.generateIdentityKeyPair();
    const saveOwn = store as unknown as {
      saveOwnIdentity?: (r: number, pub: ArrayBuffer, priv: ArrayBuffer) => Promise<void>;
      setOwnIdentity?: (r: number, pub: ArrayBuffer, priv: ArrayBuffer) => void;
    };
    if (saveOwn.saveOwnIdentity) {
      await saveOwn.saveOwnIdentity(registrationId, identity.pubKey, identity.privKey);
    } else if (saveOwn.setOwnIdentity) {
      saveOwn.setOwnIdentity(registrationId, identity.pubKey, identity.privKey);
    } else {
      throw new StoreError('store cannot persist own identity');
    }

    // Generate prekeys BEFORE writing the signed prekey so the sentinel
    // (signed_pre_key id 1) is the LAST row to land. Any crash inside
    // the loop leaves no signed prekey, the next boot sees the missing
    // sentinel, and re-runs install end-to-end.
    for (let i = 1; i <= preKeyCount; i++) {
      const pk = await KeyHelper.generatePreKey(i);
      await store.storePreKey(pk.keyId, pk.keyPair);
    }

    const signedPreKeyId = 1;
    const signedPreKey = await KeyHelper.generateSignedPreKey(identity, signedPreKeyId);
    await store.storeSignedPreKey(signedPreKeyId, signedPreKey.keyPair, signedPreKey.signature);

    if (inTx && db) {await db.execute('COMMIT');}
  } catch (e) {
    if (inTx && db) {
      try { await db.execute('ROLLBACK'); }
      catch (rbErr) { console.warn('[crypto/identity] rollback failed', rbErr); }
    }
    throw e;
  }
}

/**
 * Build the public bundle uploaded to the server so peers can start
 * sessions with us. Reads the stored signature — we do NOT re-sign here
 * (the library's low-level signer is not public API). Pops one pre-key
 * from the pool if `preKeyId` is supplied.
 */
export async function buildOwnPreKeyBundle(
  store: CryptoStore,
  address: SessionAddress,
  signedPreKeyId = 1,
  preKeyId?: number,
): Promise<PreKeyBundle> {
  const identity = await store.getIdentityKeyPair();
  const registrationId = await store.getLocalRegistrationId();
  const spk = await store.loadSignedPreKey(signedPreKeyId);
  if (!spk) {throw new StoreError(`signed pre-key ${signedPreKeyId} missing`);}
  if (!spk.signature) {
    throw new StoreError(`signed pre-key ${signedPreKeyId} has no stored signature`);
  }

  const bundle: PreKeyBundle = {
    registrationId,
    address,
    identityKey: toBase64(identity.pubKey),
    signedPreKey: {
      keyId: signedPreKeyId,
      publicKey: toBase64(spk.pubKey),
      signature: toBase64(spk.signature),
    },
  };

  if (preKeyId !== null && preKeyId !== undefined) {
    const pk = await store.loadPreKey(preKeyId);
    if (pk) {
      bundle.preKey = { keyId: preKeyId, publicKey: toBase64(pk.pubKey) };
    }
  }
  return bundle;
}

/**
 * Audit P0-I1 — signed pre-key rotation primitives.
 *
 * The Signal Protocol relies on the signed pre-key as the medium-lived
 * X3DH anchor. Without rotation it persists for the lifetime of the
 * install, so a one-shot SQLCipher compromise (rooted device, ADB
 * backup, lost-and-recovered handset) gives an attacker the private
 * scalar needed to passively decrypt every initial-handshake message
 * ever sent TO this user. Rotating on a cadence bounds the damage of
 * a successful key exfil to roughly the rotation interval.
 *
 * Design contract (mirrors Signal's signal-cli / libsignal-protocol-java):
 *   1. The newest SPK becomes the "current" one — published in the
 *      bundle, used to sign outgoing messages, returned by
 *      `currentSignedPreKeyId(store)`.
 *   2. The previous SPK is retained for `SIGNED_PRE_KEY_RETENTION_MS`
 *      so PreKeyWhisperMessages built against the old keyId during
 *      the cross-over window still decrypt. After retention, the old
 *      SPK is pruned from the local store.
 *   3. Rotation runs at most once per `SIGNED_PRE_KEY_ROTATION_INTERVAL_MS`,
 *      driven by a cheap boot-side `shouldRotateSignedPreKey` check.
 *      The runtime calls `rotateSignedPreKey` then re-uploads the
 *      bundle so the keys-service hands the new SPK to peers.
 *   4. Rotation errors are NON-FATAL at the runtime level — a missed
 *      rotation leaves the user on a still-valid (just older) SPK
 *      rather than breaking message receive on boot.
 */

/** 30 days in ms. The SPK is rotated when the current one is older than this. */
export const SIGNED_PRE_KEY_ROTATION_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * 60 days in ms. Old SPKs are kept for at least this long after a new one
 * rotates in, so PreKeyWhisperMessages built against the previous keyId
 * during the cross-over window still decrypt.
 *
 * Audit G-01 (2026-07-02): retention MUST be strictly greater than the
 * rotation interval. A peer can fetch our bundle with SPK id N at the
 * very end of the interval (just before we rotate to N+1) and then dwell
 * a PreKeyWhisperMessage on the relay for up to its 30-day limit. So the
 * previous SPK must survive at least (rotation interval + relay dwell) =
 * 30d + 30d = 60d, otherwise a legitimately-delayed first-contact message
 * lands after we've pruned id N and fails X3DH ("signed pre-key N missing").
 * When retention == interval (the old value) the just-rotated-out SPK was
 * pruned in the SAME rotation pass — which, combined with the id-1 sentinel
 * bug above, regenerated the identity ~30 days after install.
 */
export const SIGNED_PRE_KEY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

/**
 * Audit P0-I1 — cheap boot-side check. Returns true when the newest
 * stored SPK is older than the rotation interval.
 *
 * Returns FALSE in two important cases so the runtime doesn't stampede:
 *   - Store has no SPKs at all (installIdentity hasn't run yet). The
 *     caller should run installIdentity first.
 *   - Store doesn't implement listSignedPreKeys (legacy / test stubs).
 *     We can't safely decide without metadata; conservative answer is
 *     "no rotation needed."
 *   - Newest stored SPK reports `createdAt === 0` (legacy row written
 *     before timestamping). Treating this as "rotate now" would
 *     simultaneously rotate every legacy install on first boot under
 *     the new code, which is a noisy stampede; treat it as "unknown,
 *     don't rotate yet." The next `storeSignedPreKey` will stamp a
 *     real time and the rotation will fire normally one interval later.
 */
export async function shouldRotateSignedPreKey(
  store: CryptoStore,
  nowMs: number = Date.now(),
): Promise<boolean> {
  if (!store.listSignedPreKeys) {return false;}
  const list = await store.listSignedPreKeys();
  if (list.length === 0) {return false;}
  const newest = list.reduce(
    (acc, row) => (row.createdAt > acc.createdAt ? row : acc),
    list[0],
  );
  if (newest.createdAt <= 0) {return false;}
  return nowMs - newest.createdAt >= SIGNED_PRE_KEY_ROTATION_INTERVAL_MS;
}

/**
 * Audit P0-I1 — return the keyId of the SPK that should be published
 * in our bundle. Always the newest stored SPK. Falls back to `1` when
 * the store can't iterate (legacy stubs) or has no rows — `1` matches
 * the fixed keyId `installIdentity` writes on first install.
 */
export async function currentSignedPreKeyId(store: CryptoStore): Promise<number> {
  if (!store.listSignedPreKeys) {return 1;}
  const list = await store.listSignedPreKeys();
  if (list.length === 0) {return 1;}
  return list.reduce((max, row) => (row.keyId > max ? row.keyId : max), 0) || 1;
}

export interface RotateSignedPreKeyResult {
  /** keyId of the newly-minted SPK that should now be published. */
  newKeyId:        number;
  /** keyId of the SPK that was current before this rotation; undefined when this is the first rotation. */
  prevKeyId?:      number;
  /** Base64 public half of the new SPK — convenience for the upload path. */
  publicKeyB64:    string;
  /** Base64 signature over the public half — convenience for the upload path. */
  signatureB64:    string;
  /** keyIds of any old SPKs swept by the retention prune. */
  prunedKeyIds:    number[];
}

/**
 * Audit P0-I1 — generate a fresh SPK at `currentMax + 1`, persist it,
 * and prune SPKs older than the retention window. The previous SPK is
 * retained (it's typically inside the retention window the moment we
 * rotate it out).
 *
 * Returns the bundle-shape fields the caller needs to re-upload via
 * `keys.uploadBundle` so peers fetching from auth-service get the new
 * SPK. The caller is responsible for the upload — this function only
 * touches the local store so it remains usable in test harnesses that
 * don't have a network.
 *
 * NOT idempotent: every call mints a new SPK and writes it. Callers
 * should gate on `shouldRotateSignedPreKey` rather than running this
 * on every boot.
 */
export async function rotateSignedPreKey(
  store: CryptoStore,
  nowMs: number = Date.now(),
): Promise<RotateSignedPreKeyResult> {
  const identity = await store.getIdentityKeyPair();
  const prevKeyId = await currentSignedPreKeyId(store);
  // Choose a fresh keyId strictly greater than every stored SPK so
  // peers with the old bundle don't accidentally match the new SPK by
  // keyId collision. If listSignedPreKeys is absent, fall back to
  // prevKeyId + 1 — the legacy stub's `1` becomes `2`, which is still
  // distinct from anything `installIdentity` wrote.
  const list = store.listSignedPreKeys ? await store.listSignedPreKeys() : [];
  const maxKeyId = list.reduce((m, r) => (r.keyId > m ? r.keyId : m), 0);
  const newKeyId = Math.max(maxKeyId, prevKeyId) + 1;

  const newSpk = await KeyHelper.generateSignedPreKey(identity, newKeyId);
  await store.storeSignedPreKey(newKeyId, newSpk.keyPair, newSpk.signature);

  // Retention sweep — drop anything older than SIGNED_PRE_KEY_RETENTION_MS.
  // The newly-stored row is at nowMs so it's never pruned; the previous
  // SPK we just rotated off is typically well inside the window and
  // survives this sweep too. Only ancient rows from past rotations get
  // dropped.
  const prunedKeyIds: number[] = [];
  for (const row of list) {
    // Defensive — never prune the newly-minted SPK even if a clock skew
    // somehow makes it look stale.
    if (row.keyId === newKeyId) {continue;}
    // Audit G-01 — never prune the SPK we just rotated OFF this pass, even
    // under clock skew. Peers who fetched the old bundle right before this
    // rotation must still be able to complete X3DH against it during the
    // cross-over window. It ages out naturally on a later rotation.
    if (row.keyId === prevKeyId) {continue;}
    // Pre-timestamp rows (createdAt = 0) are old by definition; they
    // would be pruned every rotation. Skip them — we don't want a
    // boot-time rotation to silently delete the only SPK an upgrading
    // install has on disk. They'll naturally fall away once the new
    // SPK rotates in and the retention window elapses against the
    // new row.
    if (row.createdAt <= 0) {continue;}
    if (nowMs - row.createdAt >= SIGNED_PRE_KEY_RETENTION_MS) {
      await store.removeSignedPreKey(row.keyId);
      prunedKeyIds.push(row.keyId);
    }
  }

  return {
    newKeyId,
    prevKeyId: prevKeyId === newKeyId ? undefined : prevKeyId,
    publicKeyB64: toBase64(newSpk.keyPair.pubKey),
    signatureB64: toBase64(newSpk.signature),
    prunedKeyIds,
  };
}
