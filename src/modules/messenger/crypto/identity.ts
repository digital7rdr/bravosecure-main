// AUDIT-2026-08-13 #7 — this file was a 208-line drifted FORK of
// packages/messenger-core/src/crypto/identity.ts with zero production
// importers (production goes through the crypto barrel). Now a pure
// re-export so test importers exercise the real implementation. Do NOT add
// code here; edit messenger-core. Pinned by deadForkLock.test.ts.
export * from '@bravo/messenger-core';
