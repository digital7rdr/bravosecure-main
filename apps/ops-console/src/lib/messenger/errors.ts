// Re-export the canonical crypto errors from the shared package and add
// the ops-console-only WrongPassphraseError used by the vault unlock flow
// (browser-side PBKDF2 — mobile uses Keychain, no passphrase failure path).
import {CryptoError} from '@bravo/messenger-core';

export {
  CryptoError,
  IdentityMismatchError,
  NoSessionError,
  PreKeyExhaustedError,
  DecryptError,
  StoreError,
} from '@bravo/messenger-core';

export class WrongPassphraseError extends CryptoError {
  constructor() {
    super('wrong passphrase');
    this.name = 'WrongPassphraseError';
  }
}
