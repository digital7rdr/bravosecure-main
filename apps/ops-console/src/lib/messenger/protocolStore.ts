/**
 * IndexedDBProtocolStore — web counterpart of SqlCipherProtocolStore.
 *
 * Implements the same CryptoStore contract libsignal expects, but
 * persists into an IndexedDB schema (see idb.ts) where every value
 * column is wrapped with AES-GCM via the admin's vault key.
 *
 * Like the mobile store, this class does NOT cache plaintext between
 * calls — each load goes to IDB and re-decrypts. Cheap because the
 * crypto operations are all hardware-accelerated WebCrypto.
 */

import {IdentityDirection, type CryptoStore, StoreError} from '@bravo/messenger-core';
import type {MessengerDb, MessengerSchema} from './idb';
import type {WrapKey} from './crypto';
import {
  wrap, unwrap, wrapBuffer, unwrapBuffer,
  wrapNumber, unwrapNumber, wrapString, unwrapString,
} from './crypto';

export class IndexedDBProtocolStore implements CryptoStore {
  constructor(private readonly db: MessengerDb, private readonly key: WrapKey) {}

  // ── Identity (own) ─────────────────────────────────────────────

  async getIdentityKeyPair(): Promise<{pubKey: ArrayBuffer; privKey: ArrayBuffer}> {
    const row = await this.db.get('identity', 1);
    if (!row) throw new StoreError('identity not initialized');
    const [pubKey, privKey] = await Promise.all([
      unwrapBuffer(this.key, row.public_key),
      unwrapBuffer(this.key, row.private_key),
    ]);
    return {pubKey, privKey};
  }

  async getLocalRegistrationId(): Promise<number> {
    const row = await this.db.get('identity', 1);
    if (!row) throw new StoreError('identity not initialized');
    return unwrapNumber(this.key, row.registration_id);
  }

  async saveOwnIdentity(
    registrationId: number,
    pubKey: ArrayBuffer,
    privKey: ArrayBuffer,
  ): Promise<void> {
    const [reg, pub, priv] = await Promise.all([
      wrapNumber(this.key, registrationId),
      wrapBuffer(this.key, pubKey),
      wrapBuffer(this.key, privKey),
    ]);
    await this.db.put('identity', {
      registration_id: reg, public_key: pub, private_key: priv,
      created_at: Date.now(),
    }, 1);
  }

  // ── Trusted (peer) identities ──────────────────────────────────

  async isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction: IdentityDirection,
  ): Promise<boolean> {
    // Audit P0-W7 — receive-side hard gate. The previous behaviour was
    // `return true` unconditionally on Receiving so an offline-rotated
    // peer could recover their session without admin friction. That
    // gave a malicious keys-service free rein: substitute any peer's
    // identity end-to-end and the receiver silently re-trusted it.
    //
    // New policy (mirrors mobile P0-S6):
    //   - first-seen (no row)                → TOFU-true
    //   - existing row matches identityKey   → true
    //   - existing row differs (ROTATION)    → false; the recovery path
    //                                          in runtime.handleEnvelope
    //                                          must surface a re-verify
    //                                          banner before the new
    //                                          identity is committed.
    //
    // `saveIdentity` is the only path that overwrites the stored
    // identity row, and it always writes a rotation log entry first.
    const row = await this.db.get('trusted_identities', identifier);
    if (!row) return true; // TOFU on first-seen
    const existing = await unwrapBuffer(this.key, row.identity_key);
    if (constantTimeEq(existing, identityKey)) return true;
    // Direction-aware behaviour: outbound `Sending` MUST be strict, or
    // we'd encrypt to whatever the keys-service hands us with no
    // safety-number prompt. Inbound `Receiving` is also strict now —
    // the receive loop catches the false and routes to recovery UX.
    void direction;
    return false;
  }

  async saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean> {
    const existingRow = await this.db.get('trusted_identities', identifier);
    const wrapped = await wrapBuffer(this.key, identityKey);
    if (!existingRow) {
      await this.db.put('trusted_identities', {
        address: identifier, identity_key: wrapped, first_seen: Date.now(),
        verified_at_ms: null, verified_safety_number: null,
      });
      return false;
    }
    const existing = await unwrapBuffer(this.key, existingRow.identity_key);
    if (constantTimeEq(existing, identityKey)) return false;
    // Audit P0-W7 — append a rotation event BEFORE overwriting the
    // stored identity so the forensic trail can never be erased by a
    // subsequent benign rotation. Stored wrapped so a stolen IDB
    // doesn't trivially leak the prior identity bytes.
    const prevWrapped = await wrapBuffer(this.key, existing);
    await this.db.add('identity_rotations', {
      // rotation_id is autoIncrement; idb still wants us to omit the key
      // when adding to an autoIncrement store, so we cast through `as any`.
      address:        identifier,
      prev_key:       prevWrapped,
      new_key:        wrapped,
      detected_at_ms: Date.now(),
    } as unknown as MessengerSchema['identity_rotations']['value']);
    await this.db.put('trusted_identities', {
      address: identifier, identity_key: wrapped, first_seen: Date.now(),
      // Clear verification — operator must re-run safety-number on the
      // new key.
      verified_at_ms: null, verified_safety_number: null,
    });
    return true;
  }

  /**
   * Audit P0-W7 — record operator confirmation that the displayed
   * safety number matches out-of-band proof. Stores the hash of the
   * displayed string so a stolen IDB doesn't reveal the literal
   * safety-number text; subsequent rotations clear this in
   * `saveIdentity`.
   */
  async markPeerVerified(
    identifier:         string,
    safetyNumberHash:   string,
  ): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(safetyNumberHash)) {
      throw new StoreError('safety_number_hash_invalid');
    }
    const row = await this.db.get('trusted_identities', identifier);
    if (!row) throw new StoreError('peer_unknown');
    await this.db.put('trusted_identities', {
      ...row,
      verified_at_ms:         Date.now(),
      verified_safety_number: safetyNumberHash,
    });
  }

  /**
   * Audit P0-W7 — read the rotation log for a peer (newest first).
   * Used by ChatInfo's "Safety number changed N times" surface.
   */
  async listIdentityRotations(identifier: string): Promise<Array<{
    rotationId:   number;
    detectedAtMs: number;
  }>> {
    const all = await this.db.getAll('identity_rotations');
    return all
      .filter(r => r.address === identifier)
      .sort((a, b) => b.detected_at_ms - a.detected_at_ms)
      .map(r => ({rotationId: r.rotation_id, detectedAtMs: r.detected_at_ms}));
  }

  async loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined> {
    const row = await this.db.get('trusted_identities', identifier);
    if (!row) return undefined;
    return unwrapBuffer(this.key, row.identity_key);
  }

  // ── Pre-keys (one-time) ────────────────────────────────────────

  async loadPreKey(keyId: number) {
    const row = await this.db.get('pre_keys', keyId);
    if (!row) return undefined;
    const [pubKey, privKey] = await Promise.all([
      unwrapBuffer(this.key, row.public_key),
      unwrapBuffer(this.key, row.private_key),
    ]);
    return {pubKey, privKey};
  }

  async storePreKey(keyId: number, kp: {pubKey: ArrayBuffer; privKey: ArrayBuffer}) {
    const [pub, priv] = await Promise.all([
      wrapBuffer(this.key, kp.pubKey),
      wrapBuffer(this.key, kp.privKey),
    ]);
    await this.db.put('pre_keys', {key_id: keyId, public_key: pub, private_key: priv});
  }

  async removePreKey(keyId: number): Promise<void> {
    await this.db.delete('pre_keys', keyId);
  }

  // ── Signed pre-keys ────────────────────────────────────────────

  async loadSignedPreKey(keyId: number) {
    const row = await this.db.get('signed_pre_keys', keyId);
    if (!row) return undefined;
    const [pubKey, privKey, sig] = await Promise.all([
      unwrapBuffer(this.key, row.public_key),
      unwrapBuffer(this.key, row.private_key),
      row.signature.byteLength ? unwrapBuffer(this.key, row.signature) : Promise.resolve(undefined),
    ]);
    return {pubKey, privKey, signature: sig};
  }

  async storeSignedPreKey(
    keyId: number,
    kp: {pubKey: ArrayBuffer; privKey: ArrayBuffer},
    signature?: ArrayBuffer,
  ): Promise<void> {
    const [pub, priv, sig] = await Promise.all([
      wrapBuffer(this.key, kp.pubKey),
      wrapBuffer(this.key, kp.privKey),
      signature ? wrapBuffer(this.key, signature) : Promise.resolve(new Uint8Array(0)),
    ]);
    await this.db.put('signed_pre_keys', {
      key_id: keyId, public_key: pub, private_key: priv,
      signature: sig, created_at: Date.now(),
    });
  }

  async removeSignedPreKey(keyId: number): Promise<void> {
    await this.db.delete('signed_pre_keys', keyId);
  }

  // ── Sessions ───────────────────────────────────────────────────

  async loadSession(identifier: string): Promise<string | undefined> {
    const row = await this.db.get('sessions', identifier);
    if (!row) return undefined;
    return unwrapString(this.key, row.record);
  }

  async storeSession(identifier: string, record: string): Promise<void> {
    const wrapped = await wrapString(this.key, record);
    await this.db.put('sessions', {address: identifier, record: wrapped, updated_at: Date.now()});
  }

  async removeSession(identifier: string): Promise<void> {
    await this.db.delete('sessions', identifier);
  }

  async removeAllSessions(prefix: string): Promise<void> {
    const all = await this.db.getAllKeys('sessions');
    const target = prefix + '.';
    for (const k of all) {
      if (typeof k === 'string' && k.startsWith(target)) {
        await this.db.delete('sessions', k);
      }
    }
  }

  // ── Meta (envelope cursor) — exposed for the relay puller ──────

  async getMeta(name: string): Promise<string | undefined> {
    const row = await this.db.get('meta', name);
    if (!row) return undefined;
    const pt = await unwrap(this.key, Uint8Array.from(atob(row.value), c => c.charCodeAt(0)));
    return new TextDecoder().decode(pt);
  }

  async setMeta(name: string, value: string): Promise<void> {
    const ct = await wrap(this.key, new TextEncoder().encode(value));
    const b64 = btoa(String.fromCharCode(...ct));
    await this.db.put('meta', {key: name, value: b64});
  }
}

function constantTimeEq(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}
