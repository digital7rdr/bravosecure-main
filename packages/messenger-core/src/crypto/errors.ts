/**
 * All crypto failures surface through these error classes so upstream UI
 * can distinguish "session stale — resend handshake" from "tampered
 * ciphertext — refuse silently to the user". Never swallow a crypto error.
 *
 * Audit fix #1 — the ES2022 standard wires `Error.cause` automatically
 * when you pass `{cause}` to `super`. Declaring our own public `cause`
 * field shadowed the engine-set one and broke `instanceof` introspection
 * across the chain. We now hand the cause to the runtime through `super`
 * and read back through `this.cause` (typed by lib.es2022.error.d.ts).
 */

export class CryptoError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : {cause});
    this.name = 'CryptoError';
  }
}

export class IdentityMismatchError extends CryptoError {
  constructor(public readonly address: string, cause?: unknown) {
    super(`identity changed for ${address}`, cause);
    this.name = 'IdentityMismatchError';
  }
}

export class NoSessionError extends CryptoError {
  constructor(public readonly address: string) {
    super(`no session for ${address}`);
    this.name = 'NoSessionError';
  }
}

export class PreKeyExhaustedError extends CryptoError {
  constructor(message = 'one-time pre-key pool exhausted') {
    super(message);
    this.name = 'PreKeyExhaustedError';
  }
}

export class DecryptError extends CryptoError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'DecryptError';
  }
}

export class StoreError extends CryptoError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'StoreError';
  }
}
