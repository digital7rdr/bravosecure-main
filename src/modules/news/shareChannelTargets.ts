/**
 * Workspace → channel targets for the news share sheet.
 *
 * Client ask (2026-08-22): "in the picker it will show the workspace name; if I
 * click the workspace then the threads show up of all from that workspace and I
 * can share any one of them."
 *
 * ── WHY THIS FILE EXISTS SEPARATELY FROM `ForwardList` ────────────────────
 *
 * `ForwardList` (ChatScreen) deliberately EXCLUDES department channels, and it
 * must keep doing so — pinned by `broadcastWriteGate.test.ts`. That exclusion is
 * fail-closed for a real reason (F7): a channel is stored as an ordinary
 * `type:'group'` row, `sendText` fans a sealed envelope to every member, and the
 * generic picker has no channel id, no roster and no role, so it cannot evaluate
 * whether the caller may post. Relaxing it would reopen exactly that hole.
 *
 * So channels get their OWN door, and this module is the half that makes the
 * door safe: it starts from the channel DTOs (which DO carry `my_role`), and it
 * marks each row postable or not BEFORE any UI sees it. The send path re-checks
 * against the server anyway — a hidden control is never the boundary (A4).
 *
 * ── THE POSTING PREDICATE IS `my_role === 'admin'`, AND ONLY THAT ─────────
 *
 * Not a combination of `post_mode` and role. The server seeds membership with
 * `memberRoleFor(postMode) = postMode === 'open' ? 'admin' : 'viewer'`
 * (department.service.ts), so "may post" is already folded into the role it
 * hands back, and `DepartmentChatScreen`'s composer, `send()` and reaction gate
 * all use that one predicate. Re-deriving it from `post_mode` here would be a
 * second, drifting copy of the rule — this repo's most-shipped bug shape.
 *
 * ── GROUPING REUSES `organisationTree`, IT DOES NOT RE-IMPLEMENT IT ──────
 *
 * `organisationTreeSingleSource.test.ts` bans a second copy of the flat-list →
 * organisation rule, and the rule is subtle (a masked `parent_id` makes "no
 * parent" ambiguous). We call `directoryBuckets`/`subtreeOf` and only lay the
 * result out for a picker.
 */
import type {DepartmentChannelDto} from '@services/api';
import {
  fromDirectory, directoryBuckets, subtreeOf, nestParentedBroadcasts, type TreeRow,
} from '@screens/deptchat/organisationTree';

/** Why a channel cannot receive a share right now. `null` = it can. */
export type ShareBlockedReason =
  /** The caller is a viewer: read-only / announcement / admin-only channel. */
  | 'read_only'
  /** No Signal group bootstrapped yet — there is literally nowhere to send. */
  | 'not_active';

export interface ShareChannelTarget {
  channelId: string;
  name: string;
  /** Null when the channel has no group yet; such a row is never postable. */
  groupConversationId: string | null;
  postable: boolean;
  blockedReason: ShareBlockedReason | null;
  /** Depth inside its workspace, for a small indent in the list. */
  depth: number;
}

/** One column of a row's branch gutter. */
export interface GuideCell {
  /** This column carries the elbow that joins the row to its parent. */
  elbow: boolean;
  /** The vertical rail continues past this row in this column. */
  cont: boolean;
}

/**
 * Branch-line guides for a depth-ordered flat list (client 2026-08-22: "in the
 * picker can you also add the hierarchy line thing that we built").
 *
 * `ChannelTree` owns the full tree rendering — level tints, expand/collapse,
 * lateral rows — and it derives its gutter from `ChannelTreeNode` (parent ids,
 * tiers). The picker has no nodes, only the depth-ordered flattening
 * `shareWorkspaceGroups` already produces, so the guides are derived from THAT
 * instead: for column `c`, the rail continues past this row iff some later row
 * is still deeper than `c` before the list returns to `c` or shallower — which
 * is exactly "this ancestor has another child below". Same visual grammar, and
 * pure, so the shape is asserted rather than eyeballed.
 */
export function treeGuides(depths: readonly number[]): GuideCell[][] {
  return depths.map((d, i) => {
    const cells: GuideCell[] = [];
    for (let col = 0; col < d; col++) {
      let cont = false;
      for (let j = i + 1; j < depths.length; j++) {
        if (depths[j] <= col) {break;}        // that ancestor's run has ended
        if (depths[j] === col + 1) {cont = true; break;}  // another child below
      }
      cells.push({elbow: col === d - 1, cont});
    }
    return cells;
  });
}

export interface ShareWorkspaceGroup {
  /** The organisation root's channel id — or `LOOSE_GROUP_ID` for the sweep. */
  id: string;
  name: string;
  channels: ShareChannelTarget[];
  /** How many of `channels` can actually receive a share. */
  postableCount: number;
}

/**
 * Bucket for channels that belong to no organisation the caller can see.
 *
 * TOTALITY IS THE POINT — the same lesson `directoryBuckets` learned the hard
 * way. A member of a hidden-rooted organisation has channels with no visible
 * ancestor; dropping them would make a channel the user posts in every day
 * simply absent from this picker, with no explanation.
 */
export const LOOSE_GROUP_ID = '__loose__';
export const LOOSE_GROUP_NAME = 'Other channels';

/**
 * May the caller post into this channel?
 *
 * Exported because the SEND path re-asserts it against a freshly fetched role —
 * one predicate, one place to change it.
 */
export function canPostToChannel(row: {my_role?: string} | null | undefined): boolean {
  return row?.my_role === 'admin';
}

/**
 * THE SEND-TIME DECISION, as a pure function so it can be tested by BEHAVIOUR.
 *
 * A source scan can only prove the re-check is *called* in the right order; it
 * cannot see that its answer is *obeyed*. (Reviewed 2026-08-22: an `|| cached`
 * slipped into the caller would make the round-trip a no-op and every ordering
 * assertion would still pass.) So the rule lives here and is asserted directly.
 *
 * `server === null` means the lookup could not be made at all — a transport
 * failure, not an answer. Only then does the role the picker was built from
 * stand in, which is the same fallback `DepartmentChatScreen.send()` makes.
 * A server that ANSWERS always wins, in both directions.
 */
export function allowShareToChannel(args: {
  cachedPostable: boolean;
  server: {my_role?: string} | null;
}): boolean {
  if (args.server) {return canPostToChannel(args.server);}
  return args.cachedPostable;
}

function targetOf(row: TreeRow, dto: DepartmentChannelDto | undefined, depth: number): ShareChannelTarget {
  const groupConversationId = dto?.group_conversation_id ?? null;
  // Order matters: an un-provisioned channel is "not active" even for an admin —
  // saying "read-only" there would be a reason we know to be false.
  const blockedReason: ShareBlockedReason | null =
    !groupConversationId ? 'not_active'
    : !canPostToChannel(dto) ? 'read_only'
    : null;
  return {
    channelId: row.id,
    name: row.name,
    groupConversationId,
    postable: blockedReason === null,
    blockedReason,
    depth,
  };
}

/**
 * Group the caller's channels into workspaces for the two-level picker.
 *
 * Level 1 = the returned groups (workspace/organisation names).
 * Level 2 = each group's `channels`, already flattened depth-first so the list
 * reads in tree order with an indent, which is how the member directory shows
 * them too.
 *
 * Broadcast/announcement channels are NOT filtered out. A member who is an admin
 * of one may legitimately post a story there, and a viewer sees it disabled with
 * a reason — which is more honest than a channel that silently is not listed.
 * They reach their workspace via `nestParentedBroadcasts`, exactly as the member
 * directory does: without it `placeRow` classifies every broadcast as its own
 * kind, `subtreeOf` never emits one, and a workspace's #announcements channel
 * would sit in "Other channels" instead of under the workspace it belongs to.
 */
export function shareWorkspaceGroups(
  channels: readonly DepartmentChannelDto[],
): ShareWorkspaceGroup[] {
  const rows = nestParentedBroadcasts(fromDirectory(channels));
  const byId = new Map(channels.map(c => [c.id, c]));
  // collapseChildless: a lone parentless chat is a chat, not a one-item
  // "workspace" — the member-surface rule, and this is a member surface.
  const {organisations} = directoryBuckets(rows, {collapseChildless: true});

  const groups: ShareWorkspaceGroup[] = [];
  const covered = new Set<string>();

  for (const org of organisations) {
    const targets: ShareChannelTarget[] = [];
    for (const {row, depth} of subtreeOf(rows, org.id)) {
      covered.add(row.id);
      targets.push(targetOf(row, byId.get(row.id), depth));
    }
    groups.push({
      id: org.id,
      name: org.name,
      channels: targets,
      postableCount: targets.filter(t => t.postable).length,
    });
  }

  // The sweep: everything the organisations did not cover, flat.
  const loose = rows
    .filter(r => !covered.has(r.id))
    .map(r => targetOf(r, byId.get(r.id), 0));
  if (loose.length > 0) {
    groups.push({
      id: LOOSE_GROUP_ID,
      name: LOOSE_GROUP_NAME,
      channels: loose,
      postableCount: loose.filter(t => t.postable).length,
    });
  }

  return groups;
}
