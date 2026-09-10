// AUDIT-2026-08-13 #8 — TOMBSTONE. This was the STALE wire-protocol mirror
// (missing 12 wire types vs the live protocol) that the server header at
// apps/messenger-service/src/gateway/protocol.ts told maintainers to keep in
// sync — mirroring into a corpse. The LIVE client protocol is
// packages/messenger-core/src/transport/protocol.ts; the server header now
// points there. No code may live here (deadForkLock.test.ts).
export * from '@bravo/messenger-core';
