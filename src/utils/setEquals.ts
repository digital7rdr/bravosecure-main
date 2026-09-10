/**
 * NAV-18/NAV-19 (2026-08-26 rapid-use audit) — value equality for id sets.
 *
 * The dept-channel focus effects used to call `setDeptGroupIds(new Set(...))`
 * unconditionally, so every return to the chat/groups list handed React a
 * fresh Set IDENTITY even when the ids were byte-identical — invalidating the
 * list-building memos and forcing a full re-sort + FlatList re-render per
 * focus. Callers now keep the previous Set when nothing actually changed.
 */
export function sameIdSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a === b) {return true;}
  if (a.size !== b.size) {return false;}
  for (const v of a) {
    if (!b.has(v)) {return false;}
  }
  return true;
}
