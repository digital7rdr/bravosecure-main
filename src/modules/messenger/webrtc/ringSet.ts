/**
 * B-247 — who gets RUNG for a group call, as a pure function.
 *
 * Extracted from `launchCall.ts` because that module transitively imports
 * native code (registries, MSG_BASE_URL, the API client) and cannot be
 * required under the Jest `messenger-crypto` project. The consequence was that
 * the ring rule — the thing that was twice wrong in production — could only be
 * pinned by SOURCE SCANS asserting the text of the implementation. A scan
 * cannot tell you the resulting SET is right for a given device, which is
 * exactly the question both bugs turned on. This file makes the rule
 * behaviourally testable per device shape.
 *
 * The rule is a UNION of every source that can name a member, because each one
 * is blind in a different situation:
 *
 *   participants    the local row. Narrowed to crypto membership by
 *                   resolveRosterOverwrite whenever the server sync runs.
 *   hint            supplied by callers that launch before the room is
 *                   hydrated (AgentLiveTracker right after assignCrew).
 *   rosterUserIds   snapshot of the true roster, written at create/receive.
 *                   Absent on devices that predate the fix.
 *   groupMembers    `groups[id].members` — the only LIVE source, maintained by
 *                   applyAdminAction on every add and remove.
 *   server          /conversations/mine. Empty for a mission Ops Room, which
 *                   is not a server conversation row at all.
 *
 * Ringing needs no key, so including a member we cannot yet decrypt for is
 * correct: they ring, and the call's own key exchange resolves separately.
 */

export interface RingSources {
  /** `conversations[id].participants` — may be crypto-narrowed. */
  localMembers?: string[];
  /** Caller-supplied participants for an unhydrated room. */
  hint?: string[];
  /** `conversations[id].rosterUserIds` — the create/receive snapshot. */
  roster?: string[];
  /** Keys of `groups[id].members` — live membership. */
  groupMembers?: string[];
  /** Members from `/conversations/mine` for this conversation. */
  server?: string[];
  /** The caller. Never rung. */
  ownId?: string | null;
}

/**
 * The ring set. Order is stable (first-seen wins) so callers and tests can
 * assert on it directly.
 */
export function computeRingSet(src: RingSources): string[] {
  const {ownId} = src;
  const set = new Set<string>();
  const add = (list: string[] | undefined) => {
    for (const p of list ?? []) {
      // 'self' is a legacy placeholder that appears in older participant rows;
      // ringing it would dial the caller's own userId.
      if (p && p !== 'self' && p !== ownId) {set.add(p);}
    }
  };
  add(src.localMembers);
  add(src.hint);
  add(src.roster);
  add(src.groupMembers);
  add(src.server);
  return [...set];
}
