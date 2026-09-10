import type { CryptoStore } from './types';
import { IdentityDirection } from './types';
import { StoreError } from './errors';

/**
 * Non-persistent CryptoStore used by tests and for ephemeral throw-away
 * sessions (e.g. in-app previews). Production code paths must use
 * SqlCipherProtocolStore so keys land on encrypted disk, not process heap.
 */
export class InMemoryProtocolStore implements CryptoStore {
  private ownIdentity?: { pubKey: ArrayBuffer; privKey: ArrayBuffer };
  private registrationId?: number;
  private readonly preKeys = new Map<number, { pubKey: ArrayBuffer; privKey: ArrayBuffer }>();
  private readonly signedPreKeys = new Map<
    number,
    { pubKey: ArrayBuffer; privKey: ArrayBuffer; signature?: ArrayBuffer; createdAt: number }
  >();
  private readonly sessions = new Map<string, string>();
  private readonly identities = new Map<string, ArrayBuffer>();

  setOwnIdentity(
    registrationId: number,
    pubKey: ArrayBuffer,
    privKey: ArrayBuffer,
  ): void {
    this.registrationId = registrationId;
    this.ownIdentity = { pubKey, privKey };
  }

  async getIdentityKeyPair() {
    if (!this.ownIdentity) {throw new StoreError('identity not initialized');}
    return this.ownIdentity;
  }

  async getLocalRegistrationId() {
    if (this.registrationId === null || this.registrationId === undefined) {throw new StoreError('registration id not set');}
    return this.registrationId;
  }

  async isTrustedIdentity(identifier: string, identityKey: ArrayBuffer, direction: IdentityDirection) {
    // Receiving: TOFU on every inbound (sender cert is the trust anchor).
    // Strict equality on receive deadlocks identity-rotation recovery.
    if (direction === IdentityDirection.Receiving) {return true;}
    const existing = this.identities.get(identifier);
    if (!existing) {return true;}
    return eqBuf(existing, identityKey);
  }

  async saveIdentity(identifier: string, identityKey: ArrayBuffer) {
    const existing = this.identities.get(identifier);
    this.identities.set(identifier, identityKey);
    return !!existing && !eqBuf(existing, identityKey);
  }

  async loadIdentityKey(identifier: string) {
    return this.identities.get(identifier);
  }

  async loadPreKey(keyId: number) {
    return this.preKeys.get(keyId);
  }

  async storePreKey(keyId: number, keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }) {
    this.preKeys.set(keyId, keyPair);
  }

  async removePreKey(keyId: number) {
    this.preKeys.delete(keyId);
  }

  async loadSignedPreKey(keyId: number) {
    const row = this.signedPreKeys.get(keyId);
    if (!row) {return undefined;}
    // Strip the createdAt metadata before returning — the public
    // CryptoStore contract is {pubKey, privKey, signature?} only.
    return {pubKey: row.pubKey, privKey: row.privKey, signature: row.signature};
  }

  async storeSignedPreKey(
    keyId: number,
    keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer },
    signature?: ArrayBuffer,
  ) {
    // Audit P0-I1 — stamp createdAt so listSignedPreKeys can age rows.
    this.signedPreKeys.set(keyId, { ...keyPair, signature, createdAt: Date.now() });
  }

  async removeSignedPreKey(keyId: number) {
    this.signedPreKeys.delete(keyId);
  }

  async listSignedPreKeys(): Promise<Array<{keyId: number; createdAt: number}>> {
    const out: Array<{keyId: number; createdAt: number}> = [];
    for (const [keyId, row] of this.signedPreKeys.entries()) {
      out.push({keyId, createdAt: row.createdAt});
    }
    return out;
  }

  async loadSession(identifier: string) {
    return this.sessions.get(identifier);
  }

  async storeSession(identifier: string, record: string) {
    this.sessions.set(identifier, record);
  }

  async removeSession(identifier: string) {
    this.sessions.delete(identifier);
  }

  async removeAllSessions(prefix: string) {
    for (const key of this.sessions.keys()) {
      if (key.startsWith(prefix + '.')) {this.sessions.delete(key);}
    }
  }

  async listSessions(): Promise<Array<{identifier: string; record: string}>> {
    const out: Array<{identifier: string; record: string}> = [];
    for (const [identifier, record] of this.sessions.entries()) {
      out.push({identifier, record});
    }
    return out;
  }
}

function eqBuf(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) {return false;}
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) {if (x[i] !== y[i]) {return false;}}
  return true;
}
