// AUDIT-2026-08-13 #8 — TOMBSTONE. This was the ORPHANED mobile
// TransportClient fork: zero importers; the LIVE client production runs is
// packages/messenger-core/src/transport/client.ts (productionRuntime imports
// it from @bravo/messenger-core). Keeping a drifted socket client under the
// legacy path invited the next B-152. No code may live here
// (deadForkLock.test.ts); any future import resolves to the real client.
export * from '@bravo/messenger-core';
