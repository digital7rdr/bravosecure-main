/**
 * Wire-format types — kept in sync with
 * `packages/messenger-core/src/crypto/types.ts` (the LIVE source; the old
 * mobile `crypto/types.ts` pointer is a tombstone re-export since
 * AUDIT-2026-08-13 #7). Web port uses the same shapes so libsignal
 * sessions are protocol-compatible across platforms.
 */

export type Base64 = string;
// AUDIT-2026-08-13 #19 — flavored ids, kept in sync with the core copy
// (same flavor tags → the types unify structurally). Plain strings still
// assign; cross-flavor swaps become compile errors where both sides are
// typed.
export type UserId = string & {readonly __flavor?: 'UserId'};
export type DeviceId = number & {readonly __flavor?: 'SignalDeviceId'};
export type GroupId = string & {readonly __flavor?: 'GroupId'};

export interface SessionAddress {
  userId: UserId;
  deviceId: DeviceId;
}

export interface PreKeyBundle {
  registrationId: number;
  address: SessionAddress;
  identityKey: Base64;
  signedPreKey: {
    keyId: number;
    publicKey: Base64;
    signature: Base64;
  };
  preKey?: {
    keyId: number;
    publicKey: Base64;
  };
}

export enum CiphertextType {
  PreKeyWhisper = 3,
  Whisper = 1,
}

export interface Ciphertext {
  type: CiphertextType;
  body: Base64;
}

export enum IdentityDirection {
  Sending = 1,
  Receiving = 2,
}

export interface CryptoStore {
  getIdentityKeyPair(): Promise<{pubKey: ArrayBuffer; privKey: ArrayBuffer}>;
  getLocalRegistrationId(): Promise<number>;

  isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction: IdentityDirection,
  ): Promise<boolean>;
  saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean>;
  loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined>;

  loadPreKey(keyId: number): Promise<{pubKey: ArrayBuffer; privKey: ArrayBuffer} | undefined>;
  storePreKey(keyId: number, keyPair: {pubKey: ArrayBuffer; privKey: ArrayBuffer}): Promise<void>;
  removePreKey(keyId: number): Promise<void>;

  loadSignedPreKey(
    keyId: number,
  ): Promise<{pubKey: ArrayBuffer; privKey: ArrayBuffer; signature?: ArrayBuffer} | undefined>;
  storeSignedPreKey(
    keyId: number,
    keyPair: {pubKey: ArrayBuffer; privKey: ArrayBuffer},
    signature?: ArrayBuffer,
  ): Promise<void>;
  removeSignedPreKey(keyId: number): Promise<void>;

  loadSession(identifier: string): Promise<string | undefined>;
  storeSession(identifier: string, record: string): Promise<void>;
  removeSession(identifier: string): Promise<void>;
  removeAllSessions(identifier: string): Promise<void>;

  saveOwnIdentity(
    registrationId: number,
    pubKey: ArrayBuffer,
    privKey: ArrayBuffer,
  ): Promise<void>;
}
