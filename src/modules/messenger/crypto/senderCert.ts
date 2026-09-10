// AUDIT-2026-08-13 #7 — drifted FORK of
// packages/messenger-core/src/crypto/senderCert.ts (the fork lacked the typed
// IdentityKeyMismatchError the production rotation-recovery path depends on),
// zero production importers. Now a pure re-export. Do NOT add code here; edit
// messenger-core. Pinned by deadForkLock.test.ts.
export * from '@bravo/messenger-core';
