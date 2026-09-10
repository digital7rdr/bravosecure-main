// AUDIT-2026-08-13 #7 — TOMBSTONE. This was a 119-line drifted fork of
// packages/messenger-core/src/crypto/groupCrypto.ts (own second keyCache, no
// LRU/dispose) with ZERO importers anywhere — pure dead code. Deletion was
// the intent; a re-export tombstone is the enforced equivalent: no code may
// live here (deadForkLock.test.ts), and any future import resolves to the
// real implementation. Edit messenger-core, never this file.
export * from '@bravo/messenger-core';
