/**
 * Wire-format and domain types for the Signal Protocol layer.
 * Internal libsignal types stay behind this boundary.
 */

export type Base64 = string;
// AUDIT-2026-08-13 #19 — FLAVORED (weak-brand) ids: plain strings/numbers
// still assign (zero retrofit cascade), but a value TYPED with a different
// flavor no longer does — the swap-compiles-fine class becomes a compile
// error wherever both sides are typed. Flavor tags match the mobile
// `conversationIds.ts` module so the types unify structurally across trees.
export type UserId = string & {readonly __flavor?: 'UserId'};
export type DeviceId = number & {readonly __flavor?: 'SignalDeviceId'};
export type GroupId = string & {readonly __flavor?: 'GroupId'};

/**
 * A user/device pair identifies a Signal session endpoint.
 * Matches libsignal's SignalProtocolAddress.toString() form: `${userId}.${deviceId}`.
 */
export interface SessionAddress {
  userId: UserId;
  deviceId: DeviceId;
}

/**
 * Long-lived identity key for a user. Created once at install time and
 * attested via the signed pre-key. Fingerprint shown in safety-number UI.
 */
export interface IdentityKeyPair {
  publicKey: Base64;
  privateKey: Base64;
}

/**
 * Signed pre-key: medium-lived, rotated on a schedule. Signature is made
 * by the identity key so peers can verify authenticity before X3DH.
 */
export interface SignedPreKey {
  keyId: number;
  publicKey: Base64;
  privateKey: Base64;
  signature: Base64;
  createdAt: number;
}

/**
 * One-time pre-key: consumed on first use during X3DH. The server pool
 * should be replenished when it drops below a threshold.
 */
export interface OneTimePreKey {
  keyId: number;
  publicKey: Base64;
  privateKey: Base64;
}

/**
 * Public bundle a peer fetches from the server to start a new session.
 * Never contains private material. `preKey` is optional — if the server
 * has exhausted one-time keys, X3DH falls back to signed-pre-key only.
 */
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

/**
 * libsignal distinguishes the first message in a session (carries the
 * X3DH handshake payload) from all subsequent ratchet messages.
 */
export enum CiphertextType {
  PreKeyWhisper = 3,
  Whisper = 1,
}

/**
 * Output of SessionCipher.encrypt — this is what gets wrapped in the
 * sealed-sender envelope and pushed to the relay service.
 */
export interface Ciphertext {
  type: CiphertextType;
  body: Base64;
}

/**
 * Sealed-sender envelope: the relay sees only the recipient address and
 * an opaque ciphertext. Sender identity is encrypted inside.
 * Matches the Signal Sealed Sender v2 shape we'll serialize to the gateway.
 */
export interface SealedEnvelope {
  recipient: SessionAddress;
  ciphertext: Ciphertext;
  timestamp: number;
  /** Server-assigned UUID for ACK + dwell tracking. Set by relay on ingest. */
  envelopeId?: string;
}

export enum IdentityDirection {
  Sending = 1,
  Receiving = 2,
}

/**
 * Storage contract the Signal session layer requires. Implemented by
 * SqlCipherProtocolStore (prod) and InMemoryProtocolStore (tests).
 * Keys are intentionally kept as ArrayBuffer at this boundary because
 * libsignal-protocol-typescript expects them in that form.
 */
export interface CryptoStore {
  getIdentityKeyPair(): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer }>;
  getLocalRegistrationId(): Promise<number>;

  isTrustedIdentity(
    identifier: string,
    identityKey: ArrayBuffer,
    direction: IdentityDirection
  ): Promise<boolean>;
  saveIdentity(identifier: string, identityKey: ArrayBuffer): Promise<boolean>;
  loadIdentityKey(identifier: string): Promise<ArrayBuffer | undefined>;

  loadPreKey(keyId: number): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer } | undefined>;
  storePreKey(keyId: number, keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer }): Promise<void>;
  removePreKey(keyId: number): Promise<void>;

  loadSignedPreKey(
    keyId: number
  ): Promise<{ pubKey: ArrayBuffer; privKey: ArrayBuffer; signature?: ArrayBuffer } | undefined>;
  storeSignedPreKey(
    keyId: number,
    keyPair: { pubKey: ArrayBuffer; privKey: ArrayBuffer },
    signature?: ArrayBuffer
  ): Promise<void>;
  removeSignedPreKey(keyId: number): Promise<void>;
  /**
   * Audit P0-I1 — list every stored signed pre-key as `(keyId, createdAt)`
   * tuples (no key material). Required by `shouldRotateSignedPreKey`,
   * `rotateSignedPreKey`, and `currentSignedPreKeyId` so they can decide
   * whether/where to rotate without bypassing the public store API.
   *
   * Optional in the interface for back-compat with hand-rolled test
   * stubs; production stores (SqlCipher + InMemory) implement it. The
   * rotation primitives fall back to "don't rotate, default to keyId=1"
   * when the method is absent (covered by a regression test).
   *
   * `createdAt` is unix-ms; legacy rows that predate timestamping report
   * 0 so callers can age them out organically rather than rotating the
   * whole fleet on the same boot.
   */
  listSignedPreKeys?(): Promise<Array<{keyId: number; createdAt: number}>>;

  loadSession(identifier: string): Promise<string | undefined>;
  storeSession(identifier: string, record: string): Promise<void>;
  removeSession(identifier: string): Promise<void>;
  removeAllSessions(identifier: string): Promise<void>;
  /**
   * Optional — list every (identifier, serialized record) pair so the
   * backup layer can snapshot the ratchet state. Implementations that
   * don't expose iteration (in-memory store under restricted test
   * harnesses) may leave this undefined; the backup helper falls back
   * to "no snapshot available" in that case.
   */
  listSessions?(): Promise<Array<{identifier: string; record: string}>>;
}
