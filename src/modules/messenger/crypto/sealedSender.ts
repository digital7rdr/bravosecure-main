// AUDIT-2026-08-13 #7 — this file was a 494-line drifted FORK of
// packages/messenger-core/src/crypto/sealedSender.ts with ZERO production
// importers (production goes through the crypto barrel → @bravo/messenger-core),
// yet security-looking suites imported it directly and pinned DEAD code — the
// fork's strict payload key-set REJECTED fields production accepts
// (mentions/edit/deleteFor/isForwarded), so a fix here went green while
// production kept the bug. Now a pure re-export: every legacy import path
// exercises the real implementation. Do NOT add code here; edit
// messenger-core. Pinned by deadForkLock.test.ts.
export * from '@bravo/messenger-core';
