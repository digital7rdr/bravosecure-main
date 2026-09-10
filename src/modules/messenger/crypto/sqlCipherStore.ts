import type { CryptoStore } from '@bravo/messenger-core';
import { IdentityDirection, StoreError } from '@bravo/messenger-core';
import type { DbHandle } from './db';

/**
 * Audit P0-1 / P0-S6 — strict identity trust on receive (opt-in).
 *
 * Read at call time (NOT module load) so tests can flip the flag
 * between cases via process.env without resetting the module cache,
 * and so a runtime hot-config layer can flip the gate at app
 * foreground without a relaunch. Defaults to OFF so existing installs
 * keep the legacy TOFU-on-receive behaviour; ops flip
 * `EXPO_PUBLIC_STRICT_IDENTITY_TRUST=true` only once the Verify-
 * Safety-Number UX (markPeerVerified / clearPeerVerification on the
 * runtime) has been promoted into the GA channel.
 *
 * Only the literal string "true" enables it — defends against "1" /
 * "yes" / "TRUE" half-rollouts where someone toggled a checkbox in
 * the EAS dashboard and got a non-canonical value.
 */
function strictIdentityTrustEnabled(): boolean {
  if (typeof process === 'undefined' || !process.env) {return false;}
  // Read via computed-key indexing so `babel-preset-expo`'s
  // EXPO_PUBLIC_* inline rewrite (which turns dotted access into an
  // `expo/virtual/env.js` import) doesn't fire under jest's
  // messenger-crypto project. The Expo virtual env shim ships ES
  // export syntax that the messenger-crypto babel chain can't parse.
  // Native runtime sees the same env value either way.
  const key = 'EXPO_PUBLIC_STRICT_IDENTITY_TRUST';
  return (process.env as Record<string, string | undefined>)[key] === 'true';
}

/**
 * Production CryptoStore. Thin wrapper over SQLCipher — every call
 * translates to one parameterized SQL statement. No caching: SQLCipher
 * is fast enough and a cache would create a second surface where key
 * material could leak. Do not log row contents.
 */
export class SqlCipherProtocolStore implements CryptoStore {
  constructor(private readonly db: DbHandle) {}

  /**
   * Expose the underlying SQLCipher handle so other co-located stores
   * (the messages table owned by SqlMessageStore) can share the same
   * encryption key + connection. Do NOT use this to bypass the
   * Signal-protocol API surface — keys must continue to flow through
   * `getIdentityKeyPair()` etc.
   */
  getDb(): DbHandle { return this.db; }

  private static toAb(v: unknown): ArrayBuffer {
    if (v instanceof ArrayBuffer) {return v;}
    if (ArrayBuffer.isView(v)) {
      const view = v as ArrayBufferView;
      const out = new ArrayBuffer(view.byteLength);
      new Uint8Array(out).set(new Uint8Array(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength));
      return out;
    }
    throw new StoreError('expected BLOB, got ' + typeof v);
  }

  async getIdentityKeyPair(): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer }> {
    const res = await this.db.execute('SELECT public_key, private_key FROM identity WHERE id = 1');
    const rows = res.rows ?? [];
    if (!rows.length) {throw new StoreError('identity not initialized');}
    const r = rows[0] as { public_key: unknown; private_key: unknown };
    return {
      pubKey: SqlCipherProtocolStore.toAb(r.public_key),
      privKey: SqlCipherProtocolStore.toAb(r.private_key),
    };
  }

  async getLocalRegistrationId(): Promise<number> {
    const res = await this.db.execute('SELECT registration_id FROM identity WHERE id = 1');
    const rows = res.rows ?? [];
    if (!rows.length) {throw new StoreError('identity not initialized');}
    return (rows[0] as { registration_id: number }).registration_id;
  }

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction: IdentityDirection,
  ): Promise<boolean> {
    // Audit P0-1 / P0-S6 — receive-path hard gate, opt-in via
    // EXPO_PUBLIC_STRICT_IDENTITY_TRUST. When the flag is OFF (default)
    // we preserve the historical TOFU-on-receive behaviour: the sender
    // cert (verified separately in handleIncoming + cross-checked
    // against the authority-signed bundle by P0-8) is the real trust
    // anchor, and refusing rotations here would deadlock the recovery
    // loop after a peer reinstall (their nudge can't decrypt →
    // recovery fires → another nudge can't decrypt → …).
    //
    // When the flag is ON we treat receive-side identity flips as
    // untrusted: cold contact (no stored row) is still TOFU-true so the
    // first message can land, but a flip against an existing row
    // returns false and the inbound is rejected. The Verify-Safety-
    // Number UX (markPeerVerified / clearPeerVerification on the
    // runtime) gives the user the path to re-trust the new identity
    // once they've compared the safety number out-of-band.
    //
    // Sending always uses strict equality regardless of the flag —
    // initOutgoingSession's bundle-fetch path calls saveIdentity
    // explicitly to update the trust record before we encrypt to a
    // rotated peer.
    if (direction === IdentityDirection.Receiving && !strictIdentityTrustEnabled()) {
      return true;
    }
    const res = await this.db.execute(
      'SELECT identity_key FROM trusted_identities WHERE address = ?',
      [identifier],
    );
    const rows = res.rows ?? [];
    if (!rows.length) {return true;}
    const existing = SqlCipherProtocolStore.toAb((rows[0] as { identity_key: unknown }).identity_key);
    return constantTimeEq(existing, identityKey);
  }

  /**
   * Audit fix #9 — replace read-then-write with a single UPSERT.
   * The original implementation had a TOCTOU window between the SELECT
   * and the INSERT/UPDATE: two concurrent X3DH session-builds for the
   * same peer could both read "no row", then both INSERT, leaving the
   * second to crash with PRIMARY KEY conflict. WAL mode hides the
   * symptom for serial writers, but `applyAdminAction(create)` and
   * inbound `envelope.deliver` for the same peer can land in parallel
   * via promise chains and produce the race for real.
   *
   * Approach:
   *   - One SELECT (read existing key snapshot, may be empty).
   *   - One INSERT … ON CONFLICT … DO UPDATE that always lands the
   *     incoming key. We compute the "did it change" decision against
   *     the snapshot we read; even if a concurrent writer slipped in
   *     between, the UPSERT itself is still atomic and the worst case
   *     is a stale `changed` boolean (UI may briefly say "no change"
   *     when in fact the key flipped twice). Crucially we never crash
   *     and never leave the row missing.
   *
   * The return value semantics are preserved:
   *   true  — identity changed (peer rotated keys; trust UI may want
   *           to surface "safety number changed")
   *   false — identity unchanged or first-seen insert
   *
   * `first_seen` only updates when the key actually changes — re-
   * asserting an unchanged identity preserves the original first-seen
   * timestamp (matters for safety-number diff UI).
   */
  async saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
    const key = new Uint8Array(identityKey);
    const now = Date.now();
    // Audit P0-S6 — wrap the snapshot + UPSERT + rotation-log INSERT
    // in a single transaction so a crash mid-write can't leave the
    // rotation log out of sync with `trusted_identities`. Either the
    // peer's new key is durably installed AND the rotation row exists,
    // or neither does.
    //
    // saveIdentity runs in one of THREE connection contexts; each needs a
    // different transaction discipline on the single op-sqlite connection.
    //
    // (1) Inside a receive txn (decrypt → storeSession → saveIdentity):
    //     runWithRatchetTxn already holds BEGIN IMMEDIATE. A second BEGIN
    //     throws "cannot start a transaction within a transaction", so we
    //     run the body RAW — the outer block commits/rolls back the whole
    //     receive atomically, preserving the P0-S6 guarantee.
    //
    // (2) B-75 (2026-07-11) — chain-resident recovery work (runOnTxnChain →
    //     libsignal closeSession/initOutgoingSession → saveIdentity). We
    //     already hold the chain EXCLUSIVELY but no BEGIN is open. We must
    //     NOT re-queue on runWithRatchetTxn: that appends behind the very
    //     chain frame awaiting us → permanent deadlock (frozen txnChain →
    //     inbound persistence, coalesced flush, backup and restore all stall
    //     — the reported "backup got very slow / no longer accurate"). Open
    //     our OWN BEGIN inline (runRatchetTxnInline) — the chain guarantees
    //     exclusive access so it can't collide, and it keeps the UPSERT +
    //     identity_rotations INSERT atomic (preserves the P0-S6 guarantee;
    //     raw autocommit here would desync the rotation forensic log).
    //
    // (3) B-72 (2026-07-11) — fully off-chain (send path: X3DH processPreKey
    //     → saveIdentity). The previous raw BEGIN IMMEDIATE here raced the
    //     CHAINED coalesced flush (SqlMessageStore.upsertBatch, 50ms timer)
    //     and threw "cannot start a transaction within a transaction" on
    //     rapid-send bursts. Per the P0-1 doctrine (receiveTransaction.ts):
    //     every explicit BEGIN on this connection goes through the one
    //     per-connection runner — so queue our own txn on the chain.
    const {isInsideRatchetTxn, isOnTxnChain, runWithRatchetTxn, runRatchetTxnInline} =
      require('../runtime/receiveTransaction') as typeof import('../runtime/receiveTransaction');
    // AUDIT #12 — `frame` is provided only on path (3): the checkpoint
    // stops a force-advanced saveIdentity frame from writing into a later
    // frame's transaction. Paths (1)/(2) pass nothing (raw / inline).
    const body = async (frame?: import('../runtime/receiveTransaction').RatchetTxnFrame): Promise<boolean> => {
      // Snapshot — may be empty on first-seen.
      const before = await this.db.execute(
        'SELECT identity_key FROM trusted_identities WHERE address = ?',
        [identifier],
      );
      const beforeRows = before.rows ?? [];
      const hadRow = beforeRows.length > 0;
      const oldKeyAb = hadRow
        ? SqlCipherProtocolStore.toAb((beforeRows[0] as { identity_key: unknown }).identity_key)
        : null;
      const changed = oldKeyAb !== null && !constantTimeEq(oldKeyAb, identityKey);

      await this.db.execute(
        `INSERT INTO trusted_identities (address, identity_key, first_seen)
           VALUES (?, ?, ?)
           ON CONFLICT(address) DO UPDATE SET
             identity_key = excluded.identity_key,
             first_seen   = CASE
               WHEN trusted_identities.identity_key = excluded.identity_key
                 THEN trusted_identities.first_seen
               ELSE excluded.first_seen
             END,
             -- Audit P0-I3 — auto-clear the verification record on a
             -- key flip. The user has to re-verify against the NEW
             -- safety number before the green checkmark returns.
             -- Re-asserting the same bytes preserves the record.
             verified_at_ms = CASE
               WHEN trusted_identities.identity_key = excluded.identity_key
                 THEN trusted_identities.verified_at_ms
               ELSE NULL
             END,
             verified_safety_number_sha256 = CASE
               WHEN trusted_identities.identity_key = excluded.identity_key
                 THEN trusted_identities.verified_safety_number_sha256
               ELSE NULL
             END`,
        [identifier, key, now],
      );

      // Audit P0-S6 — record the rotation forensic trail row. Only on
      // a true flip (changed === true); first-seen and re-assertion of
      // the same key do NOT write here. We hash both the old and new
      // keys (NOT the raw bytes) so a forensic dump of this table can
      // identify WHO rotated and WHEN but cannot harvest pubkeys for
      // pre-computing X3DH bundles. The hash + insert run INSIDE the
      // same transaction as the trusted_identities upsert so the log
      // and the trust record never disagree.
      if (changed && oldKeyAb) {
        const oldHash = await sha256Hex(oldKeyAb);
        const newHash = await sha256Hex(identityKey);
        frame?.assertLive(); // #12 — an await sits above; don't write past a disown
        await this.db.execute(
          `INSERT INTO identity_rotations
             (address, old_key_sha256, new_key_sha256, observed_at_ms)
             VALUES (?, ?, ?, ?)`,
          [identifier, oldHash, newHash, now],
        );
      }

      return changed;
    };
    // (1) inside a receive txn → run raw; the outer BEGIN commits us.
    if (isInsideRatchetTxn()) {return body();}
    // (2) chain-resident recovery, no BEGIN open → open our own atomic inline
    //     BEGIN (exclusive access guaranteed by the chain; no deadlock, keeps
    //     the two writes atomic). Guarded by isInsideRatchetTxn() first, so a
    //     writer that already sees an open BEGIN never reaches here.
    if (isOnTxnChain()) {return runRatchetTxnInline(this.db, body);}
    // (3) fully off-chain → queue on the chain to serialize with the flush.
    return runWithRatchetTxn(this.db, body, 'saveIdentity');
  }

  /**
   * Audit P0-S6 — return the rotation forensic trail for a peer,
   * newest-first. Defaults to `limit=50`; the Chat Info screen renders
   * the most recent N entries and asks "Verify Safety Number" if any
   * are missing a verified_at marker.
   *
   * Returns an empty array for never-rotated peers (the common case).
   * The shape is the camelCase JS form; the SQL column names are
   * snake_case to stay idiomatic for SQLCipher dump tools.
   */
  async listIdentityRotations(
    identifier: string,
    limit = 50,
  ): Promise<Array<{oldKeySha256: string; newKeySha256: string; observedAtMs: number}>> {
    const res = await this.db.execute(
      `SELECT old_key_sha256, new_key_sha256, observed_at_ms
         FROM identity_rotations
         WHERE address = ?
         ORDER BY observed_at_ms DESC
         LIMIT ?`,
      [identifier, limit],
    );
    const rows = res.rows ?? [];
    return rows.map(r => {
      const row = r as {old_key_sha256: string; new_key_sha256: string; observed_at_ms: number};
      return {
        oldKeySha256: row.old_key_sha256,
        newKeySha256: row.new_key_sha256,
        observedAtMs: row.observed_at_ms,
      };
    });
  }

  /**
   * Audit P0-I3 — fetch the explicit verification record for a peer.
   * Returns `null` for peers with no trust row OR for TOFU-trusted
   * peers that have never been verified through the safety-number UX.
   * The ChatInfo screen calls this to decide between the "Verify
   * safety number" CTA (null) and the green "Verified <date>" badge.
   */
  async getPeerVerification(
    identifier: string,
  ): Promise<{verifiedAtMs: number; safetyNumberSha256: string} | null> {
    const res = await this.db.execute(
      `SELECT verified_at_ms, verified_safety_number_sha256
         FROM trusted_identities
         WHERE address = ?`,
      [identifier],
    );
    const rows = res.rows ?? [];
    if (!rows.length) {return null;}
    const row = rows[0] as {verified_at_ms: number | null; verified_safety_number_sha256: string | null};
    if (row.verified_at_ms === null || row.verified_safety_number_sha256 === null) {return null;}
    return {
      verifiedAtMs:       row.verified_at_ms,
      safetyNumberSha256: row.verified_safety_number_sha256,
    };
  }

  /**
   * Audit P0-I3 — record an explicit safety-number ack from the user.
   * `hashSha256Hex` MUST be the lowercase-hex SHA-256 of the safety-
   * number string the user confirmed (NOT the raw safety number — we
   * never store that). `verifiedAtMs` defaults to `Date.now()`.
   *
   * Returns `true` when the UPDATE found a trust row to update,
   * `false` when no row exists for this address (the caller should
   * call saveIdentity first to establish TOFU).
   *
   * Hash format is enforced at the call site so a buggy UX path
   * can't write garbage into the forensic table.
   */
  async markPeerVerified(
    identifier:    string,
    hashSha256Hex: string,
    verifiedAtMs:  number = Date.now(),
  ): Promise<boolean> {
    if (!/^[0-9a-f]{64}$/.test(hashSha256Hex)) {
      throw new Error('hash must be 64-char lowercase hex SHA-256');
    }
    const res = await this.db.execute(
      `UPDATE trusted_identities SET verified_at_ms = ?, verified_safety_number_sha256 = ?
         WHERE address = ?`,
      [verifiedAtMs, hashSha256Hex, identifier],
    );
    return (res.rowsAffected ?? 0) > 0;
  }

  /**
   * Audit P0-I3 — clear the verification record (user pressed
   * "Unverify" or re-launched the safety-number flow without
   * confirming). Idempotent: no-op when there's no row OR no
   * verification.
   */
  async clearPeerVerification(identifier: string): Promise<void> {
    await this.db.execute(
      `UPDATE trusted_identities SET verified_at_ms = NULL, verified_safety_number_sha256 = NULL
         WHERE address = ?`,
      [identifier],
    );
  }

  async loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined> {
    const res = await this.db.execute(
      'SELECT identity_key FROM trusted_identities WHERE address = ?',
      [identifier],
    );
    const rows = res.rows ?? [];
    if (!rows.length) {return undefined;}
    return SqlCipherProtocolStore.toAb((rows[0] as { identity_key: unknown }).identity_key);
  }

  async loadPreKey(keyId: number) {
    const res = await this.db.execute(
      'SELECT public_key, private_key FROM pre_keys WHERE key_id = ?',
      [keyId],
    );
    const rows = res.rows ?? [];
    if (!rows.length) {return undefined;}
    const r = rows[0] as { public_key: unknown; private_key: unknown };
    return {
      pubKey: SqlCipherProtocolStore.toAb(r.public_key),
      privKey: SqlCipherProtocolStore.toAb(r.private_key),
    };
  }

  async storePreKey(keyId: number, keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }) {
    await this.db.execute(
      'INSERT OR REPLACE INTO pre_keys (key_id, public_key, private_key) VALUES (?, ?, ?)',
      [keyId, new Uint8Array(keyPair.pubKey), new Uint8Array(keyPair.privKey)],
    );
  }

  async removePreKey(keyId: number) {
    await this.db.execute('DELETE FROM pre_keys WHERE key_id = ?', [keyId]);
  }

  async loadSignedPreKey(keyId: number) {
    const res = await this.db.execute(
      'SELECT public_key, private_key, signature FROM signed_pre_keys WHERE key_id = ?',
      [keyId],
    );
    const rows = res.rows ?? [];
    if (!rows.length) {return undefined;}
    const r = rows[0] as { public_key: unknown; private_key: unknown; signature: unknown };
    const sig = SqlCipherProtocolStore.toAb(r.signature);
    return {
      pubKey: SqlCipherProtocolStore.toAb(r.public_key),
      privKey: SqlCipherProtocolStore.toAb(r.private_key),
      signature: sig.byteLength ? sig : undefined,
    };
  }

  async storeSignedPreKey(
    keyId: number,
    keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer },
    signature?: ArrayBuffer,
  ) {
    await this.db.execute(
      `INSERT OR REPLACE INTO signed_pre_keys
         (key_id, public_key, private_key, signature, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        keyId,
        new Uint8Array(keyPair.pubKey),
        new Uint8Array(keyPair.privKey),
        new Uint8Array(signature ?? new ArrayBuffer(0)),
        Date.now(),
      ],
    );
  }

  async removeSignedPreKey(keyId: number) {
    await this.db.execute('DELETE FROM signed_pre_keys WHERE key_id = ?', [keyId]);
  }

  /**
   * Audit P0-I1 — list every stored SPK as `(keyId, createdAt)` so the
   * rotation primitives in `@bravo/messenger-core/crypto/identity.ts`
   * can decide whether to rotate, which keyId is current, and which
   * old SPKs are past the retention window. Returns no key material.
   *
   * `createdAt` is unix-ms. Pre-rotation installs that wrote `created_at`
   * via `storeSignedPreKey` always have a non-zero value; the 0 fallback
   * referenced in the rotation-primitive comments applies to hypothetical
   * back-fill paths that haven't been needed in practice for this store.
   */
  async listSignedPreKeys(): Promise<Array<{keyId: number; createdAt: number}>> {
    const res = await this.db.execute(
      'SELECT key_id, created_at FROM signed_pre_keys',
    );
    const rows = res.rows ?? [];
    return rows.map(r => {
      const row = r as {key_id: number; created_at: number};
      return {keyId: row.key_id, createdAt: row.created_at};
    });
  }

  async loadSession(identifier: string): Promise<string | undefined> {
    const res = await this.db.execute('SELECT record FROM sessions WHERE address = ?', [identifier]);
    const rows = res.rows ?? [];
    if (!rows.length) {return undefined;}
    return (rows[0] as { record: string }).record;
  }

  async storeSession(identifier: string, record: string): Promise<void> {
    await this.db.execute(
      'INSERT OR REPLACE INTO sessions (address, record, updated_at) VALUES (?, ?, ?)',
      [identifier, record, Date.now()],
    );
  }

  async removeSession(identifier: string): Promise<void> {
    await this.db.execute('DELETE FROM sessions WHERE address = ?', [identifier]);
  }

  async removeAllSessions(addressPrefix: string): Promise<void> {
    await this.db.execute('DELETE FROM sessions WHERE address LIKE ?', [addressPrefix + '.%']);
  }

  /**
   * P1 / ratchet-snapshot backup — return every (address, record)
   * pair so the backup helper can serialize + encrypt the live
   * ratchet state. Reads are fast (sessions table is keyed on
   * address); the backup caller is responsible for rate-limiting how
   * often a snapshot is generated.
   */
  async listSessions(): Promise<Array<{identifier: string; record: string}>> {
    const res = await this.db.execute('SELECT address, record FROM sessions');
    const rows = res.rows ?? [];
    const out: Array<{identifier: string; record: string}> = [];
    for (const row of rows) {
      const r = row as {address: unknown; record: unknown};
      if (typeof r.address === 'string' && typeof r.record === 'string') {
        out.push({identifier: r.address, record: r.record});
      }
    }
    return out;
  }

  async saveOwnIdentity(
    registrationId: number,
    pubKey: ArrayBuffer,
    privKey: ArrayBuffer,
  ): Promise<void> {
    await this.db.execute(
      `INSERT OR REPLACE INTO identity (id, registration_id, public_key, private_key, created_at)
       VALUES (1, ?, ?, ?, ?)`,
      [registrationId, new Uint8Array(pubKey), new Uint8Array(privKey), Date.now()],
    );
  }
}

function constantTimeEq(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) {return false;}
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) {diff |= x[i] ^ y[i];}
  return diff === 0;
}

/**
 * Lowercase-hex SHA-256 of an ArrayBuffer. Used by P0-S6 to record
 * hashed pubkeys in `identity_rotations` so the forensic table reveals
 * rotation timing + who rotated without leaking raw pubkey bytes to
 * an attacker who manages to read the SQLCipher file.
 *
 * Prefers `crypto.subtle.digest` (available in modern RN via
 * `react-native-quick-crypto` polyfill AND in Node 18+ test env);
 * falls back to nothing because there's no path-of-no-return that
 * makes sense here — if subtle.digest is unavailable we let it throw.
 */
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', buf);
  let hex = '';
  for (const b of new Uint8Array(hash)) {hex += b.toString(16).padStart(2, '0');}
  return hex;
}
