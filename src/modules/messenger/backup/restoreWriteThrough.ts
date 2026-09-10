/**
 * M-13 — tiny dependency-free flag toggled around the restore's final
 * `hydrateMessages` call.
 *
 * The runtime's store→SQLCipher write-through subscriber
 * (productionRuntime) re-`upsert`s every message it sees as new. During a
 * restore, `restoreAllMessages` has ALREADY written every row durably via
 * `SqlMessageStore.upsertBatch`; the subsequent `hydrateMessages` (which
 * paints the UI) would make the subscriber re-issue one autocommit
 * INSERT-OR-REPLACE per restored row — thousands of redundant fsyncs
 * immediately after restore. This flag lets the subscriber skip that
 * redundant re-write while restore is hydrating.
 *
 * It lives in its own module (no imports) so both the restore path and
 * the runtime can read it without a circular dependency.
 */
let suppressed = false;

export function setRestoreWriteThroughSuppressed(v: boolean): void {
  suppressed = v;
}

export function isRestoreWriteThroughSuppressed(): boolean {
  return suppressed;
}
