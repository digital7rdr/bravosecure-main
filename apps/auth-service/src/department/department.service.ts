import {BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';
import {OrgAuditService} from '../org/org-audit.service';
import type {ChannelAccess, ChannelPostMode, ChannelType} from './dto/channel.dto';

export interface ChannelSummary {
  id: string;
  name: string;
  description: string | null;
  department: string | null;
  /** Phase B — owning org, so a two-workspace member can scope the list
   *  client-side (additive; single-org clients ignore it). */
  org_id: string;
  /** Messenger group conversation id carrying the E2EE posts (null until
   *  an admin device has bootstrapped the Signal group). */
  group_conversation_id: string | null;
  unread_count: number;
  my_role: 'admin' | 'viewer';
  // Dept Chat v2 (Step 12). Channels Hub grouping + badges. Defaults
  // 'department'/'standard' on pre-v2 rows.
  channel_type: 'board' | 'department' | 'incident';
  access: 'standard' | 'read_only' | 'restricted';
  // Scope v2 Phase 1 — the four-level hierarchy (Enterprise 0 / Main 1 / Sub 2
  // / Sub-sub 3). `level` is DERIVED by a DB trigger from the parent, never
  // trusted from a caller; pre-hierarchy rows read as parent_id null / level 1
  // (Main), which is exactly how they render today.
  parent_id: string | null;
  // vs2 item 2 — the three facts that make `parent_id: null` unambiguous.
  // REQUIRED: this is the SERVER's own row type and the query always emits all
  // three. (The optional-for-old-servers rule belongs on the CLIENT DTO, which
  // has it. Marking them optional here would buy no safety — the row arrives
  // through a raw db.q<T> cast either way — while weakening the contract this
  // service publishes to its own controller.)
  /** True when this row HAS a parent the caller cannot see (parent_id masked). */
  parent_hidden: boolean;
  /** Nearest ancestor the caller is a member of; null when there is none. */
  visible_ancestor_id: string | null;
  /** Synthetic group key for a row whose parent is hidden AND which has no
   *  visible ancestor. NULL in every other shape — deliberately, since emitting
   *  it more widely would disclose the id of an ancestor the caller cannot see. */
  root_id: string | null;
  level: number;
  // Scope v2 Phase 2 — POSTING rights, deliberately separate from `access`
  // (visibility). A9: "Open Chat, Read-only, Announcement-only and Admin-only".
  post_mode: 'open' | 'read_only' | 'announcement' | 'admin_only';
  is_broadcast: boolean;
  /**
   * Item 04 — a chat channel attached to this row's parent WITHOUT consuming a
   * hierarchy tier. Drawn as a neutral card at the parent's tier, never as a
   * coloured level row.
   *
   * Its ABSENCE is meaningful to the client: an old server omits the field, and
   * the tree must then render every row structurally rather than guessing. That
   * is why the create affordance is gated on having SEEN the field, not on its
   * value — see `serverKnowsLaterals`.
   */
  is_lateral: boolean;
  /**
   * Is the ORG THIS ROW BELONGS TO a workspace (rather than an agency)?
   *
   * Per-row on purpose — see the query comment. It answers the question the
   * client actually has ("should I draw the tree for these channels?") without
   * the user-level ambiguity that produced edge A3.
   */
  workspace_tenant: boolean;
  // M8 mockup renders "N members" on every row.
  member_count: number;
  // Creator of the channel — the client uses this to gate owner-only actions
  // (re-provision an orphaned channel, delete the thread).
  created_by: string;
  // Rename attribution — lets the client synthesize a local "X renamed the
  // channel to Y" system line the first time it notices name_changed_at
  // advance past its last-seen value (see DepartmentChatScreen).
  name_changed_by: string | null;
  name_changed_at: string | null;
}

/**
 * F12 — paging for the channel lists.
 *
 * KEYSET, not OFFSET. The lists are ordered by mutable-ish keys and grow at the
 * head (a channel created mid-scroll shifts every later page under OFFSET,
 * duplicating or skipping rows), and OFFSET still scans everything it skips.
 * The cursor is the last row's sort key, so page N+1 costs the same as page 1.
 *
 * The cursor is an opaque pipe-joined tuple of the ORDER BY columns:
 *   listChannels        "<level>|<created_at>|<id>"
 *   listChannelsForOps  "<created_at>|<id>"
 * Built in SQL (so the timestamp is Postgres' own text form and round-trips
 * exactly) and stripped from the rows before they leave, so the row shape every
 * existing client parses is byte-identical.
 */
export interface ChannelPageOptions {
  /** Rows per page. Clamped to MAX_PAGE_SIZE; absent/invalid → DEFAULT_PAGE_SIZE. */
  limit?: number | null;
  /** `next_cursor` from the previous page. Absent → first page. */
  cursor?: string | null;
  /** Phase B — restrict to one workspace's channels. Absent → all (today's
   *  behaviour). Access stays membership-driven; a foreign org yields 0 rows. */
  orgId?: string | null;
}

export interface ChannelPage<T> {
  channels: T[];
  /** Cursor for the next page, or null when this was the last one. */
  next_cursor: string | null;
}

/** A row as it comes back from a paged query — the cursor column is internal. */
type WithCursor<T> = T & {_cursor?: string};

export interface OpsChannelRow {
  id: string;
  name: string;
  department: string | null;
  description: string | null;
  channel_type: 'board' | 'department' | 'incident';
  access: 'standard' | 'read_only' | 'restricted';
  parent_id: string | null;
  level: number;
  member_count: number;
  provisioned: boolean;
  created_at: string;
}

/**
 * Department Channels — Phase-1 data layer.
 *
 * E2EE: message CONTENT is NOT stored here. A channel maps to a messenger
 * Signal group (group_conversation_id); posts ride the relay as sealed-
 * sender group envelopes via the existing broadcastToGroup crypto. This
 * service owns only the non-secret metadata: the channel directory,
 * membership + role (admin posts / viewer read-only), the group linkage,
 * and unread tracking. The relay never sees channel plaintext.
 */
@Injectable()
export class DepartmentService {
  private readonly log = new Logger(DepartmentService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly audit: OrgAuditService,
  ) {}

  // ─── F12 paging primitives ────────────────────────────────────────────
  //
  // DEFAULT IS GENEROUS ON PURPOSE. Every existing caller (mobile home, the
  // channels hub, the vault shelf, the ops departments table) asks for the whole
  // list and has no cursor to send, so the default page must be larger than any
  // real tenant's channel count or paging becomes a silent truncation. The
  // largest org on staging is two orders of magnitude below this. What the limit
  // buys today is the CEILING: an unbounded query is one bad tenant away from a
  // response nobody can render.
  static readonly DEFAULT_PAGE_SIZE = 500;
  static readonly MAX_PAGE_SIZE = 1000;

  private static pageLimit(limit?: number | null): number {
    const n = Number(limit);
    if (!Number.isFinite(n) || n <= 0) {return DepartmentService.DEFAULT_PAGE_SIZE;}
    return Math.min(Math.floor(n), DepartmentService.MAX_PAGE_SIZE);
  }

  /**
   * Split a cursor into exactly `fields` non-empty parts, or 400.
   *
   * Strict rather than forgiving: a malformed cursor silently treated as "first
   * page" makes a paging client loop forever on page 1, and one silently treated
   * as a partial tuple would hand Postgres a bad timestamp and 500.
   */
  private static parseCursor(cursor: string | null | undefined, fields: number): string[] | null {
    if (cursor === null || cursor === undefined || cursor === '') {return null;}
    const parts = String(cursor).split('|');
    if (parts.length !== fields || parts.some(p => p.trim() === '')) {
      throw new BadRequestException('invalid_channel_cursor');
    }
    return parts;
  }

  /**
   * Take the rows, mint the next cursor, and REMOVE the cursor column.
   *
   * The strip is what keeps this backward-compatible: the paging key is an
   * implementation detail of the query, not a new field every existing client
   * suddenly receives.
   */
  private static takePage<T>(rows: Array<WithCursor<T>>, limit: number): ChannelPage<T> {
    // A full page means there MAY be more; a short page is provably the last.
    const next = rows.length >= limit ? (rows[rows.length - 1]?._cursor ?? null) : null;
    for (const r of rows) {delete r._cursor;}
    return {channels: rows as T[], next_cursor: next};
  }

  /** Channels the caller is a member of, with the E2EE group linkage. */
  async listChannels(userId: string, page: ChannelPageOptions = {}): Promise<ChannelPage<ChannelSummary>> {
    const limit = DepartmentService.pageLimit(page.limit);
    const cur = DepartmentService.parseCursor(page.cursor, 3);
    const rows = await this.db.q<WithCursor<ChannelSummary>>(
      `SELECT c.id,
              c.name,
              c.description,
              c.department,
              c.org_id,
              c.group_conversation_id,
              c.channel_type,
              c.access,
              -- parent_id is the ONLY field here naming a channel other than
              -- this row, so it must obey the same visibility rule as the row
              -- itself: "hidden metadata is filtered by the server, not merely
              -- hidden by the client". Without this EXISTS a member of a
              -- STANDARD sub-channel was handed the UUID of its RESTRICTED
              -- parent — proof that a channel they cannot see exists.
              --
              -- SCOPE, precisely: this withholds the IDENTIFIER, not the depth.
              -- (No backticks in this comment: it lives inside a JS template
              -- literal, so one would terminate the SQL string.)
              -- c.level below is still raw, so that member receives
              -- parent_id null with level 2, and the row renders under
              -- "Sub-channels" with no parent above it — a sub-channel of
              -- nothing, not a top-level channel. An integer implying depth is
              -- an inference, not a joinable id, so this is the actionable half.
              -- A visible-DEPTH projection (a level-3 whose level-2 parent is
              -- visible but whose level-1 grandparent is not cannot simply be
              -- renumbered) belongs to Phase 2, which owns visibility semantics.
              -- (listChannelsForOps deliberately does NOT do this: ops is a
              -- superuser view of the whole org, not a membership view.)
              -- REACHABILITY, in one place: av.v1/v2/v3 below answer "is the
              -- caller a member of this ancestor, and is that ancestor still
              -- live". Computed ONCE in a LATERAL rather than re-spelled at
              -- each site — the mask, parent_hidden and the walk's first arm are
              -- the SAME question about the SAME row, and three copies of it in
              -- one query is this repo's N-drifted-copies class at close range.
              --
              -- The archive half is NOT decoration. The row list is filtered to
              -- archived_at IS NULL, so a parent_id pointing at an archived
              -- channel names a row this caller never receives: the row would
              -- claim a visible parent, be classified as an ordinary child, and
              -- render under a parent that is not in the list — nowhere at all.
              CASE WHEN av.v1 THEN c.parent_id ELSE NULL END AS parent_id,
              -- vs2 item 2 — SURFACE the fact instead of making the client infer
              -- it. Masking parent_id above tells a client "no parent"; these
              -- three say WHICH of the two no-parent shapes this row is, which
              -- is the difference between rendering an organisation and
              -- rendering an orphan. (No backticks in this comment: it lives
              -- inside a JS template literal, so one would terminate the SQL.)
              -- Inferring it from c.level does not work: a member of a level-1
              -- Main who is not a member of its level-0 root receives parent_id
              -- null with level 1, indistinguishable from a genuine top-level
              -- channel.
              (c.parent_id IS NOT NULL AND NOT av.v1) AS parent_hidden,
              -- The nearest ancestor the CALLER IS A MEMBER OF, so an orphan can
              -- be nested under the organisation it really belongs to. No new
              -- disclosure: the caller is a member of that ancestor by
              -- construction. Bounded to 3 hops because c.level is CHECKed 0..3,
              -- so a row has at most three ancestors; this repo has no recursive
              -- CTE anywhere, and adding one for a walk whose depth is already
              -- capped would invent a precedent.
              tf.visible_ancestor_id,
              -- The topmost ancestor, EMITTED ONLY where it is consumed: the
              -- case where the parent is hidden AND no ancestor is visible, in
              -- which it is the synthetic group key that stops two orphans under
              -- two DIFFERENT hidden roots being merged under one header.
              --
              -- The gate is a DISCLOSURE BOUNDARY, not an optimisation. Emitted
              -- unconditionally it hands the id of an invisible ancestor to a
              -- caller whose parent is perfectly visible — a member of Fort
              -- Hunter and RSA, but not of the restricted root SASFA, would
              -- receive SASFA's uuid alongside parent_hidden:false. That is the
              -- exact leak the parent_id mask exists to close, reopened one hop
              -- up: proof that a channel they cannot see exists. Inside the gate
              -- the row has ALREADY been told a hidden ancestor exists, so the
              -- opaque key adds nothing it does not know.
              --
              -- Deliberately NOT archive-filtered: this is a grouping key that
              -- is never resolved to a row, and filtering it would fall through
              -- to a lower ancestor and split one group in two.
              CASE WHEN tf.visible_ancestor_id IS NULL AND c.parent_id IS NOT NULL AND NOT av.v1
                   THEN COALESCE(a4.id, a3.id, a2.id, a1.id) END AS root_id,
              c.level,
              c.post_mode,
              c.is_broadcast,
              -- Item 04 — the tree renderer draws a lateral as a neutral card at its
              -- parent tier rather than as a coloured level row.
              c.is_lateral,
              -- Item 02/03 — IS THE ORG THIS ROW BELONGS TO A WORKSPACE?
              --
              -- PER ROW, not per page, and that is the point. The client used to
              -- answer this from useIsWorkspaceTenant(), a USER-level flag that is
              -- true for anybody with any workspace affiliation — so the dual
              -- persona (an agency manager who had also joined a workspace) got
              -- workspace-shaped UI on their AGENCY's channels. That is the same
              -- edge A3 that put workspace_tenant on listOrgChannels; the member
              -- directory needed it too and never had it.
              --
              -- EXISTS, not a LEFT JOIN: org_workspaces carries no uniqueness
              -- constraint on owner_user_id (isWorkspaceTenant's own LIMIT 1
              -- concedes that), and a join on a non-unique key would MULTIPLY
              -- rows — silently, and straight through the keyset pager.
              EXISTS (SELECT 1 FROM public.org_workspaces w
                       WHERE w.owner_user_id = c.org_id) AS workspace_tenant,
              -- M8 mockup shows a member count per channel. "Search, member
              -- counts and unread indicators must be permission-aware" — this
              -- counts rows in a channel the caller is already a member of, so
              -- it never reveals anything about a channel they cannot see.
              (SELECT COUNT(*)::int FROM public.department_channel_members mc
                WHERE mc.channel_id = c.id) AS member_count,
              c.created_by,
              c.name_changed_by,
              c.name_changed_at,
              m.role AS my_role,
              -- Unread is tracked client-side off the encrypted message store
              -- now (the relay holds the ciphertext); expose 0 here so the
              -- list shape stays stable. The mobile store overlays the real
              -- per-conversation unread from messengerStore.
              0 AS unread_count,
              -- F12 — the keyset cursor, assembled from the ORDER BY columns and
              -- STRIPPED before the row is returned (takePage), so the shape
              -- every existing client parses is unchanged.
              c.level::text || '|' || c.created_at::text || '|' || c.id::text AS _cursor
         FROM public.department_channel_members m
         JOIN public.department_channels c ON c.id = m.channel_id
         -- The bounded ancestor walk feeding visible_ancestor_id / root_id.
         -- FOUR PK lookups per row (parent_id references id), which is why this
         -- is spelled out rather than recursed.
         --
         -- WHY FOUR AND NOT THREE (item 04). It used to be three, justified by
         -- "c.level is CHECKed 0..3, so a row has at most three ancestors". A
         -- LATERAL breaks that sentence: it inherits its parent level instead of
         -- incrementing, so L1(0) -> L2(1) -> L3(2) -> L4(3) -> lateral(3) puts a
         -- row FOUR hops from its root. At three hops visible_ancestor_id could
         -- not reach the organisation and root_id returned the wrong node, so a
         -- member of the lateral and the root but not the middle saw a synthetic
         -- orphan instead of their own organisation.
         --
         -- Four is sufficient and the bound is not arbitrary: roots are capped at
         -- level 0/1, every STRUCTURAL hop increments a level CHECKed <= 3, and a
         -- lateral is forced to be a LEAF by dept_channel_set_level -- so at most
         -- ONE non-incrementing hop can appear in any chain. Relax the leaf rule,
         -- allow agency laterals, or re-level the tree and this must grow again;
         -- the failure is SILENT (orphan + duplicate render), so an integration
         -- test builds the deepest legal chain and asserts root_id.
         LEFT JOIN public.department_channels a1 ON a1.id = c.parent_id
         LEFT JOIN public.department_channels a2 ON a2.id = a1.parent_id
         LEFT JOIN public.department_channels a3 ON a3.id = a2.parent_id
         LEFT JOIN public.department_channels a4 ON a4.id = a3.parent_id
         -- "Can the caller reach this ancestor" — one evaluation per hop, shared
         -- by the mask, parent_hidden, the walk and the root_id gate.
         LEFT JOIN LATERAL (
           SELECT a1.archived_at IS NULL AND EXISTS (
                    SELECT 1 FROM public.department_channel_members pm
                     WHERE pm.channel_id = a1.id AND pm.user_id = $1) AS v1,
                  a2.archived_at IS NULL AND EXISTS (
                    SELECT 1 FROM public.department_channel_members pm
                     WHERE pm.channel_id = a2.id AND pm.user_id = $1) AS v2,
                  a3.archived_at IS NULL AND EXISTS (
                    SELECT 1 FROM public.department_channel_members pm
                     WHERE pm.channel_id = a3.id AND pm.user_id = $1) AS v3,
                  a4.archived_at IS NULL AND EXISTS (
                    SELECT 1 FROM public.department_channel_members pm
                     WHERE pm.channel_id = a4.id AND pm.user_id = $1) AS v4
         ) av ON TRUE
         -- Derived from av so the projection can gate root_id on the walk's
         -- RESULT; a SELECT list cannot reference its own alias.
         LEFT JOIN LATERAL (
           SELECT CASE
                    WHEN c.parent_id IS NULL THEN NULL
                    WHEN av.v1 THEN a1.id
                    WHEN av.v2 THEN a2.id
                    WHEN av.v3 THEN a3.id
                    WHEN av.v4 THEN a4.id
                  END AS visible_ancestor_id
         ) tf ON TRUE
        WHERE m.user_id = $1 AND c.archived_at IS NULL
          -- F12 keyset predicate. NULL cursor = first page, so this whole
          -- clause is inert for every caller that does not page. The three arms
          -- walk the composite key in the SAME directions as the ORDER BY —
          -- level ASCENDING, then created_at and id DESCENDING — which is why
          -- it cannot be written as a single row-value comparison.
          AND ($2::smallint IS NULL
               OR c.level > $2::smallint
               OR (c.level = $2::smallint AND c.created_at < $3::timestamptz)
               OR (c.level = $2::smallint AND c.created_at = $3::timestamptz
                   AND c.id < $4::uuid))
          -- Phase B — optional workspace scope (see ChannelPageOptions.orgId).
          -- Inert when NULL, which is every pre-Phase-B caller.
          AND ($6::uuid IS NULL OR c.org_id = $6::uuid)
        -- Level first so a client can render the tree without re-sorting, and
        -- so a parent always precedes its children in the stream. c.id is the
        -- TIE-BREAK only: created_at is not unique, and a keyset cursor over a
        -- non-unique key silently drops or repeats the tied rows at a page
        -- boundary. It changes no order a client can already observe.
        ORDER BY c.level ASC, c.created_at DESC, c.id DESC
        LIMIT $5`,
      [userId, cur?.[0] ?? null, cur?.[1] ?? null, cur?.[2] ?? null, limit, page.orgId ?? null],
    );
    return DepartmentService.takePage(rows, limit);
  }

  /** Membership roster for a channel (for the admin device to seed the
   *  Signal group). Throws 403 if the caller isn't a member. */
  async listMembers(userId: string, channelId: string): Promise<{
    members: Array<{user_id: string; role: 'admin' | 'viewer'; role_label: string | null; display_name: string; avatar_url: string | null; manageable: boolean}>;
    my_role: 'admin' | 'viewer';
    /**
     * The channel's CURRENT posting rule, for the client's receive-side filter.
     *
     * The client used to read this from a route param frozen at navigation
     * time, so every lane that opens a thread WITHOUT setting it (a
     * notification tap, a forward, a link) left the filter switched off
     * entirely — the "we enforce at both ends" promise held only when you
     * arrived from the channel list. Serving it here costs nothing: this
     * endpoint already runs on every focus and already reads the channel row.
     * It also self-heals a mode change made while the thread is open, which a
     * route param can never do.
     */
    post_mode: 'open' | 'read_only' | 'announcement' | 'admin_only' | null;
  }> {
    const role = await this.memberRole(userId, channelId);
    const members = await this.db.q<{user_id: string; role: 'admin' | 'viewer'; role_label: string | null; display_name: string; avatar_url: string | null}>(
      `SELECT m.user_id, m.role, m.role_label, u.display_name, u.avatar_url
         FROM public.department_channel_members m
         JOIN public.users u ON u.id = m.user_id
        WHERE m.channel_id = $1
        ORDER BY (m.role = 'admin') DESC, u.display_name ASC`,
      [channelId],
    );
    // `manageable` (B-205) — can the CALLER change THIS member's access / remove
    // them? Same strict-outrank rule the mutations enforce (assertOutranks), so
    // the client can HIDE the "Make viewer"/"Allow post"/remove controls it must
    // not offer (a manager over the owner, or over a peer manager) instead of
    // showing a button that only 403s. One source of truth: the caller never
    // manages themselves, and never anyone of equal-or-higher org rank.
    const ch = await this.db.qOne<{
      org_id: string;
      post_mode: 'open' | 'read_only' | 'announcement' | 'admin_only';
    }>(
      `SELECT org_id, post_mode FROM public.department_channels WHERE id = $1`,
      [channelId],
    );
    const actorRank = ch ? await this.orgRank(ch.org_id, userId) : 1;
    const withManageable = await Promise.all(members.map(async m => ({
      ...m,
      manageable:
        ch != null &&
        m.user_id !== userId &&
        actorRank > await this.orgRank(ch.org_id, m.user_id),
    })));
    return {members: withManageable, my_role: role, post_mode: ch?.post_mode ?? null};
  }

  /**
   * Register the messenger group an admin's device created for this channel.
   * Admin-only. This is the ONLY place the channel learns its E2EE group id;
   * the group master key itself never reaches the server — it travels member-
   * to-member inside the Signal admin-create envelope.
   */
  async registerGroup(
    userId: string, channelId: string, groupConversationId: string,
  ): Promise<{ok: true; group_conversation_id: string; adopted: boolean}> {
    const role = await this.memberRole(userId, channelId);
    if (role !== 'admin') throw new ForbiddenException('only_admin_can_register_group');
    if (!groupConversationId) throw new ForbiddenException('group_id_required');
    // FIRST-WRITER-WINS (area 6 #2) — a second admin device racing provisioning
    // would otherwise OVERWRITE the first group id, splitting members across two
    // master keys (key divergence → "CPO can't see messages", B-35 class).
    // COALESCE keeps the already-registered id if present, else claims this one —
    // atomic in one UPDATE. RETURNING gives the EFFECTIVE (canonical) id; when it
    // differs from what we tried to register, a prior writer won and the caller
    // must ADOPT the returned id instead of its own freshly-minted group.
    const row = await this.db.qOne<{group_conversation_id: string | null}>(
      `UPDATE public.department_channels
          SET group_conversation_id = COALESCE(group_conversation_id, $2)
        WHERE id = $1 AND archived_at IS NULL
        RETURNING group_conversation_id`,
      [channelId, groupConversationId],
    );
    if (!row) throw new NotFoundException('channel_not_found');
    const effective = row.group_conversation_id ?? groupConversationId;
    return {ok: true, group_conversation_id: effective, adopted: effective !== groupConversationId};
  }

  /**
   * Ops oversight view — every (non-archived) channel with member + post
   * counts. Admin-only surface (the ops console AdminGuard gates the route);
   * no membership filter, no message bodies, so it's safe for oversight
   * without exposing channel content.
   */
  async listChannelsForOps(page: ChannelPageOptions = {}): Promise<ChannelPage<OpsChannelRow>> {
    const limit = DepartmentService.pageLimit(page.limit);
    const cur = DepartmentService.parseCursor(page.cursor, 2);
    const rows = await this.db.q<WithCursor<OpsChannelRow>>(
      `SELECT c.id,
              c.name,
              c.department,
              c.description,
              c.channel_type,
              c.access,
              c.parent_id,
              c.level,
              (SELECT COUNT(*)::int FROM public.department_channel_members m WHERE m.channel_id = c.id) AS member_count,
              -- Post content is E2EE on the relay, not in this DB. Surface
              -- whether the encrypted group has been bootstrapped instead.
              (c.group_conversation_id IS NOT NULL) AS provisioned,
              c.created_at,
              -- F12 — keyset cursor, stripped before the row is returned. Two
              -- fields here, not three: this list is not level-ordered (see the
              -- ORDER BY note below), so its key is (created_at, id).
              c.created_at::text || '|' || c.id::text AS _cursor
         FROM public.department_channels c
        WHERE c.archived_at IS NULL
          -- F12 keyset predicate; inert when no cursor is supplied.
          AND ($1::timestamptz IS NULL
               OR c.created_at < $1::timestamptz
               OR (c.created_at = $1::timestamptz AND c.id < $2::uuid))
        -- created_at DESC, NOT (level, created_at).
        --
        -- Phase 1 changed this to level-first alongside adding parent_id/level
        -- to the projection. But the ops departments page renders a FLAT table
        -- with no depth column, so the only visible effect was that an HQ
        -- operator's row order silently changed — a live behaviour change
        -- shipped for a consumer that does not exist yet.
        --
        -- The columns still ship, so whoever builds the hierarchy view changes
        -- this ordering together with the UI that explains it. The member-facing
        -- listChannels above orders level-first deliberately: it HAS a tree
        -- renderer that depends on a parent preceding its children.
        --
        -- c.id DESC is the keyset TIE-BREAK, not a second sort dimension: it
        -- only orders rows sharing a created_at, which had no defined order
        -- before. The recency rule above is untouched.
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT $3`,
      [cur?.[0] ?? null, cur?.[1] ?? null, limit],
    );
    return DepartmentService.takePage(rows, limit);
  }

  // ─── Org workspace seeding — a declared no-op ────────────────────────
  //
  // Client 2026-08-26: "There must never be pre made channels, even on
  // service provider channels… All Channels must be exactly the same and
  // should also start the same… no need for 2 different types."
  //
  // vs2 items 5+12 made the WORKSPACE tenant start clean; this extends the
  // same rule to the agency tenant, which used to be seeded Announcements /
  // Operations / Intel / 'CPO Roster' plus a founding level-1 #broadcast.
  // Existing orgs keep whatever rows they already have (nothing is deleted
  // here) — parity is that their owners can now archive/delete them, which
  // the archive + delete verbs below allow for every tenant.
  //
  // The method survives as a no-op because both activation paths still call
  // it (agent.service on org approval, workspace.service on create) and the
  // seam is where the next "start with X" idea will be argued about. It must
  // issue NO queries: the old idempotency probe existed to protect inserts
  // that no longer happen.
  async seedOrgWorkspace(
    _orgUserId: string,
    _tenant: 'agency' | 'workspace' = 'agency',
  ): Promise<{created: number}> {
    return {created: 0};
  }

  /**
   * Is this org a Bravo WORKSPACE (the enterprise tenant) rather than an agency?
   *
   * Since the 2026-08-26 tenant unification the CHANNEL MODEL no longer
   * branches on this (both tenants start clean, share the tree verbs, and may
   * remove broadcasts). What still reads it: the restricted-root refusals on
   * both verbs (agencies legitimately run top-level incident channels, which
   * seedsManagersOnly would otherwise 400) and the listing metadata
   * (`workspace_tenant`, mint refusals).
   *
   * SOUND ONLY BECAUSE ONE users.id CANNOT BE BOTH: `workspace.service` refuses
   * to create a workspace for a company agent. The reverse direction (minting a
   * workspace owner as a company agent) is verified by
   * `workspaceTenantExclusive.spec.ts` — if that ever becomes possible, every
   * gate keyed on this silently applies the wrong tenant's rules.
   */
  async isWorkspaceTenant(orgUserId: string): Promise<boolean> {
    const row = await this.db.qOne<{n: number}>(
      `SELECT 1 AS n FROM public.org_workspaces WHERE owner_user_id = $1 LIMIT 1`,
      [orgUserId],
    );
    return !!row;
  }

  private async activeOrgMembers(orgUserId: string): Promise<Array<{member_user_id: string; member_role: string}>> {
    return this.db.q<{member_user_id: string; member_role: string}>(
      `SELECT member_user_id, member_role FROM public.org_members
        WHERE org_user_id = $1 AND status = 'active'`,
      [orgUserId],
    );
  }

  /**
   * Seed a channel's membership from the org roster, honouring `access`:
   *   - standard / read_only → org admin + every member (managers admin, CPOs viewer).
   *   - restricted / incident → org admin + managers ONLY (CPOs are never added,
   *     so listChannels' membership JOIN never returns the row — Step-12 rule).
   * Direct INSERTs (no rekey intents): the Signal group is bootstrapped lazily by
   * an admin device over the seeded roster, exactly like seedOrgWorkspace.
   */
  /**
   * VISIBILITY — the ONLY function allowed to decide who gets a membership row.
   *
   * Phase 2 exists because `access` was doing two jobs. Keeping each question in
   * exactly one function is what stops them re-merging: a caller cannot
   * accidentally use a visibility value to answer a posting question, because
   * it never touches the column. `channelAccessInvariants.spec.ts` bans
   * branching on either column outside these two helpers.
   */
  static seedsManagersOnly(access: ChannelAccess, channelType: ChannelType): boolean {
    return access === 'restricted' || channelType === 'incident';
  }

  /**
   * MINTABILITY — the ONLY expression of "may this manager attach this channel
   * to an invite as the joiner's team".
   *
   * vs2 item 2 greys out un-mintable nodes in the invite picker, which means the
   * client now needs the answer BEFORE it submits. Two expressions in two files
   * is this repo's most-shipped bug class, so the refusal lives here once and is
   * consumed by both readers:
   *   - enterprise-join.service.ts createMemberInvite, which THROWS the code;
   *   - listOrgChannels, which projects mintable_by_me for the picker.
   * A source scan (mintableTeamSingleSource.spec.ts) bans a second copy.
   *
   * Returns the refusal code, or null when the channel is mintable. Returning
   * the code rather than a boolean is what lets the throwing caller keep its
   * exact existing error contract.
   *
   * SCOPE, precisely: this is the per-ROW refusal. It deliberately cannot
   * express scoped_manager_cannot_grant_admin, which refuses ANY manager-role
   * invite from a scoped minter regardless of which row is chosen — a per-row
   * field cannot carry a whole-request rule, and if it tried, every row would
   * read mintable while every submit 403'd. The caller greys by role separately.
   */
  static mintRefusalFor(
    // Every field is REQUIRED, deliberately. An optional `archived` would mean
    // a caller that forgets it silently gets "not archived" — a fail-OPEN
    // default on a refusal predicate. Making the shape explicit costs each
    // caller one property and cannot be forgotten.
    row: {org_id: string; access: ChannelAccess; channel_type: ChannelType;
          department: string | null; archived: boolean; is_broadcast: boolean;
          // Item 04/D-5 — REQUIRED for the same reason every other field is: an
          // optional post_mode would fail OPEN on the announcement arm below.
          post_mode: ChannelPostMode} | null,
    orgUserId: string,
    managerDepartment: string | null,
    // REQUIRED, no default. A default would silently apply one tenant's
    // permission rule to the other — see the branch comparison below.
    workspaceTenant: boolean,
  ): 'team_channel_not_found' | 'team_channel_in_other_org' | 'team_channel_is_managers_only' | 'team_channel_is_broadcast' | 'team_channel_outside_your_branch' | null {
    // Archived reads as absent because the throwing caller's SELECT filters
    // archived_at IS NULL — same answer, whichever reader asks.
    if (!row || row.archived) {return 'team_channel_not_found';}
    if (row.org_id !== orgUserId) {return 'team_channel_in_other_org';}
    // A #broadcast is announcement-only and non-deletable; seeding a joiner
    // into one as their "team" is meaningless. This used to be enforced ONLY by
    // the client's picker filter, which meant the server would happily bind an
    // invite to a broadcast for any direct API caller or older app — and it
    // made this function's claim to be the full refusal untrue. A broadcast is
    // department-NULL/board/standard, so nothing else here catches it.
    // ANNOUNCEMENT MODE, not just the flag. Item 04/D-5: a workspace's
    // announcement channel is now a LATERAL with post_mode 'announcement' (there
    // is no is_broadcast field a caller can set, and workspaces get no
    // server-minted #broadcast). Keying on the flag alone would have made the
    // NEW announcement channel bindable as a joiner's "team" — the same
    // meaningless grant this refusal exists to prevent, reached by the new door.
    // The refusal CODE is deliberately reused: the client already renders honest
    // copy for it, and "you cannot make an announcement channel someone's team"
    // is the same sentence either way.
    if (row.is_broadcast || row.post_mode === 'announcement') {return 'team_channel_is_broadcast';}
    if (DepartmentService.seedsManagersOnly(row.access, row.channel_type)) {
      return 'team_channel_is_managers_only';
    }
    // Why: a null manager department is an unscoped owner or company account,
    // for whom every branch is in scope.
    //
    // vs2 item 7 — A BRANCHLESS CHANNEL IS MINTABLE BY ANY MANAGER,
    // ON THE WORKSPACE TENANT ONLY.
    //
    // The create form stops sending `department`, so new workspace channels
    // carry NULL — exactly as they already do whenever an admin leaves that
    // optional field blank. Refusing NULL would leave scoped managers unable to
    // be given ANY new team after this ships. It is the convention the
    // join/invite file already encodes FOUR times as
    // `COALESCE(CASE WHEN c.archived_at IS NULL THEN c.department END, $2) = $2`
    // — "unrouted belongs in every manager's inbox".
    //
    // ⚠️ THE TENANT GATE IS LOAD-BEARING, not tidiness. AGENCY orgs actively use
    // typed departments for real branch scope, and a blank department field is
    // reachable in their editor TODAY — so applying the relaxation to them
    // would widen a live permission surface the client never asked to change.
    // The plan is explicit that the agency surface stays untouched.
    //
    // THE DELIBERATE WIDENING, recorded (plan §10.11/§10.12): a branch-scoped
    // manager may now mint into unscoped WORKSPACE teams. Bounded — a scoped
    // manager can already mint a TEAMLESS invite that seeds org-wide, so no
    // single grant gets wider. Two designs that would have preserved a strict
    // boundary were tried and withdrawn (move the manager side to a picker;
    // derive the channel side from its root) — plan §4 item 7 records why each
    // is unsafe. DO NOT RE-PROPOSE THEM.
    const branchless = row.department == null;
    if (managerDepartment != null && !(branchless && workspaceTenant)
        && row.department !== managerDepartment) {
      return 'team_channel_outside_your_branch';
    }
    return null;
  }

  /**
   * POSTING — the ONLY function allowed to decide a non-manager's seeded role.
   *
   * `role` is what actually gates posting ('admin' posts, 'viewer' cannot), and
   * before Phase 2 every non-manager got 'viewer' regardless of `access` — which
   * is why `standard` and `read_only` were behaviourally identical and
   * `read_only` was a badge that changed nothing. `open` is the new capability.
   *
   * ⚠️ SCOPE OF ENFORCEMENT, stated honestly: this controls the roster, and the
   * client refuses to post when its role is 'viewer'
   * (DepartmentChatScreen: `if (myRole !== 'admin') return`). The RELAY cannot
   * enforce it — channel posts are sealed-sender group envelopes and
   * messenger-service has no knowledge of department roles by design. A member
   * who already holds the group key is therefore restrained by the client and by
   * key distribution, not by the transport. Closing that would mean teaching the
   * relay about channel roles, which is an architecture decision (CLAUDE.md
   * stop-condition: group messaging / relay semantics) — do not "fix" it here.
   */
  static memberRoleFor(postMode: ChannelPostMode): 'admin' | 'viewer' {
    return postMode === 'open' ? 'admin' : 'viewer';
  }

  private async seedChannelMembers(
    orgUserId: string, channelId: string, access: ChannelAccess, channelType: ChannelType,
    members: Array<{member_user_id: string; member_role: string}>,
    postMode: ChannelPostMode = 'read_only',
  ): Promise<void> {
    // The org account is the channel admin (can post + manage membership).
    await this.db.q(
      `INSERT INTO public.department_channel_members (channel_id, user_id, role)
       VALUES ($1, $2, 'admin') ON CONFLICT DO NOTHING`,
      [channelId, orgUserId],
    );
    const managersOnly = DepartmentService.seedsManagersOnly(access, channelType);
    const memberRole = DepartmentService.memberRoleFor(postMode);
    for (const m of members) {
      const isManager = m.member_role === 'manager';
      if (managersOnly && !isManager) continue;
      await this.db.q(
        `INSERT INTO public.department_channel_members (channel_id, user_id, role, role_label)
         VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
        // A7.3 — do NOT stamp a tenant-specific staff noun here. This ran for
        // every tenant, so an ENTERPRISE workspace had 'CPO' written onto every
        // auto-seeded member, and the client renders `role_label ?? <live noun>`
        // — the stored value won and the Enterprise roster read "CPO". NULL lets
        // each client derive its own noun. (Not a "rule 7 provider" case: this
        // was the provider's label leaking into Enterprise tenants.)
        // A manager always posts. A non-manager's role now comes from POST_MODE
        // via memberRoleFor — previously hardcoded 'viewer', which is why
        // `open` could not exist and read_only was indistinguishable from
        // standard.
        [channelId, m.member_user_id, isManager ? 'admin' : memberRole, isManager ? 'Manager' : null],
      );
    }
  }

  // ─── Manager channel management (Step 18) ─────────────────────────────
  //
  // OrgManagerGuard gates these at the controller; the org account/manager
  // resolved there is passed as (orgUserId, managerUserId). NO crypto change —
  // create seeds metadata + membership rows (group bootstrapped lazily on first
  // open); tightening access rekeys CPOs out via the existing removeMember path.

  async createChannel(
    orgUserId: string, managerUserId: string,
    input: {name: string; department?: string; channel_type?: ChannelType; access?: ChannelAccess;
            parent_id?: string; post_mode?: ChannelPostMode; root?: boolean; lateral?: boolean},
  ): Promise<{id: string; name: string; channel_type: ChannelType; access: ChannelAccess;
              level: number; post_mode: ChannelPostMode; is_lateral: boolean}> {
    const channel_type: ChannelType = input.channel_type ?? 'department';
    const access: ChannelAccess = input.access ?? 'standard';
    // Default read_only = today's behaviour (managers post, members read), so an
    // omitted post_mode changes nothing for existing callers.
    const post_mode: ChannelPostMode = input.post_mode ?? 'read_only';
    /**
     * item 04 — LATERAL. Resolved once, up front, because three later decisions
     * branch on it: the depth guard (a lateral may sit at the cap), the tenant
     * gate, and the INSERT's column list.
     *
     * `&& !!input.parent_id` mirrors how `asRoot` neutralises itself: the trigger
     * refuses a parentless lateral outright, and silently dropping the flag here
     * would create a top-level channel the caller did not ask for. Better to let
     * the explicit refusal below fire.
     */
    const asLateral = input.lateral === true;
    if (asLateral && !input.parent_id) {
      throw new BadRequestException('lateral_channel_needs_parent');
    }
    // Laterals are EVERY tenant's since the 2026-08-26 unification. The old
    // agency refusal existed to protect the per-level broadcast arithmetic the
    // agency create path used to run; that producer is gone for all tenants.
    // Scope v2 Phase 1 — parent resolution. The DB trigger derives `level` and
    // is the real boundary (it also rejects a cross-org parent), but resolve the
    // parent here first so the caller gets a clean 400 instead of a raw
    // Postgres exception, and so "no fifth level" reads as a real error message.
    if (input.parent_id) {
      const parent = await this.db.qOne<{
        org_id: string; level: number; is_broadcast: boolean; is_lateral: boolean;
        parent_id: string | null; access: ChannelAccess; channel_type: ChannelType;
      }>(
        `SELECT org_id, level, is_broadcast, is_lateral, parent_id, access, channel_type
           FROM public.department_channels
          WHERE id = $1 AND archived_at IS NULL`,
        [input.parent_id],
      );
      if (!parent) throw new BadRequestException('parent_channel_not_found');
      // A #broadcast must stay a LEAF.
      //
      // The archive fix excludes broadcasts from a node's child count on the
      // grounds that a broadcast is a level-scoped object merely hanging off a
      // node. That is only true while it cannot take children — the moment it
      // can, it IS a branch node, and excluding it silently orphans its subtree:
      // P1 → B2(#broadcast) → N would let archiveChannel(P1) succeed (B2 excluded
      // from the count, then cascade-archived) leaving N active under an archived
      // parent. Keeping broadcasts childless is what makes that exclusion sound.
      if (parent.is_broadcast) throw new BadRequestException('broadcast_channel_cannot_have_children');
      // item 04 — a LATERAL must stay a leaf, for the same reason a broadcast
      // must: it does not increment `level`, so a chain of them would add real
      // depth the CHECK cannot see and the 4-hop ancestor walks would under-reach.
      // The trigger is the guarantee; this is the friendly error.
      if (parent.is_lateral) throw new BadRequestException('lateral_channel_cannot_have_children');
      // Tenancy (page 10 rule 2): never let one Enterprise parent a channel
      // under another's. Duplicated in the trigger on purpose — this is the
      // friendly error, that one is the guarantee.
      if (parent.org_id !== orgUserId) throw new BadRequestException('parent_channel_in_other_org');
      // THE DEPTH CAP DOES NOT APPLY TO A LATERAL — that is the whole feature.
      // A lateral inherits `parent.level`, so a lateral of a level-3 node is
      // level 3 and the CHECK is satisfied; only a STRUCTURAL child of a level-3
      // node would compute 4. Gating both on `parent.level >= 3` is what would
      // have made "a lateral at every level" false at exactly the deepest level.
      if (!asLateral && parent.level >= 3) throw new BadRequestException('max_channel_depth_reached');
      // vs2 item 2 — the SECOND step of the restricted-root back door.
      //
      // configureChannel now refuses to tighten a root that HAS children, but
      // that alone leaves the same end state reachable in two moves: make a
      // childless root Restricted, then hang a child off it. The child's members
      // would then have no visible path to the top and a directory with no
      // organisation in it. Only ROOTS are guarded: a restricted node in the
      // MIDDLE of a tree is ordinary and is handled by the renderer's
      // hidden-rung case.
      if (parent.parent_id === null
          && DepartmentService.seedsManagersOnly(parent.access, parent.channel_type)) {
        throw new BadRequestException('restricted_root_cannot_take_children');
      }
      // B-590 — promote a legacy Main root on its FIRST structural child.
      //
      // Every pre-hierarchy channel is a parentless level-1 row, and hanging a
      // child off one used to root the new tree one tier short of the PDF's
      // four ("I can create a sub-channel, then a sub of that, then I can't go
      // further"). 20260820120000 promotes the trees that already exist; this
      // closes the go-forward door for flat channels that grow their first
      // child tomorrow. WORKSPACE-ONLY (agency #broadcast arithmetic keys on
      // the stored level), and only while the parent has NO structural
      // children — a tree the migration skipped over a #broadcast collision
      // keeps its shape rather than being half-shifted. Best-effort: if the
      // promotion collides with a live legacy #broadcast at its new level, the
      // root stays at level 1 and the create proceeds with the old capacity.
      if (!asLateral && parent.parent_id === null && parent.level === 1
          && !parent.is_lateral && !parent.is_broadcast
      ) {
        // ARCHIVED children do not block the promotion — the migration promotes
        // on that shape and re-derives the archived subtree, and the two halves
        // must agree about what an archived child means.
        const structural = await this.db.qOne<{n: number}>(
          `SELECT 1 AS n FROM public.department_channels
            WHERE parent_id = $1 AND NOT is_lateral AND NOT is_broadcast
              AND archived_at IS NULL LIMIT 1`,
          [input.parent_id],
        );
        if (!structural) {
          try {
            // ONE transaction, deliberately. These two statements were plain
            // autocommit queries at first, and the review caught the failure
            // that shape hides: the root promotion cannot collide, so the only
            // statement that can raise unique_violation is the SECOND — by
            // which point the root was already committed at level 0 with a
            // #broadcast child stranded at its old level. A half-shifted tree,
            // irreversible (the trigger allowance is 1→0 only), and exactly
            // the state the migration's per-org rollback exists to prevent.
            await this.db.withTransaction(async tx => {
              await tx.q(
                `UPDATE public.department_channels
                    SET level = 0
                  WHERE id = $1 AND parent_id IS NULL AND level = 1
                    AND NOT is_broadcast AND NOT is_lateral`,
                [input.parent_id],
              );
              // Existing laterals/broadcasts hanging off the root re-derive
              // from it (the trigger recomputes a parented row's level on any
              // update).
              await tx.q(
                `UPDATE public.department_channels c
                    SET level = 0
                   FROM public.department_channels p
                  WHERE c.parent_id = p.id AND p.id = $1
                    AND c.level IS DISTINCT FROM p.level + (CASE WHEN c.is_lateral THEN 0 ELSE 1 END)`,
                [input.parent_id],
              );
            });
            // The promotion changes an EXISTING channel's structural level —
            // that deserves its own audit line, not a rider on the child's.
            await this.audit.log(orgUserId, managerUserId, 'channel.promote_root', {
              targetKind: 'channel', targetId: input.parent_id,
              metadata: {from_level: 1, to_level: 0},
            });
          } catch (e) {
            // unique_violation from dept_channels_one_broadcast_per_level (a
            // live legacy #broadcast at the target level) — the tx rolled back,
            // the root REALLY is still level 1, and the child below derives
            // level 2 as before. Logged, never silent: a transient failure
            // here permanently reinstates the three-tier cap for this tree
            // (the root will have a structural child afterwards), and nobody
            // would otherwise know.
            this.log.warn(`B-590 root promotion skipped for ${input.parent_id}: ${(e as Error)?.message}`);
          }
        }
      }
    }
    // vs2 item 8 — "+ Create new organisation" mints a TRUE root at level 0.
    //
    // The DTO takes a boolean, never a raw level: level is derived by a trigger
    // everywhere else, and letting a caller post an integer would hand it the
    // one column the hierarchy's depth CHECK relies on. The trigger accepts a
    // parentless level 0; a parentless row above level 1 is refused.
    //
    // Existing workspaces' organisations were level-1 roots whose trees topped
    // out one tier shallower than a fresh level-0 one — §10.6 recorded that as
    // permanent, and the founder then reported it as a bug (B-590).
    // 20260820120000 promotes the existing trees, and the block above promotes
    // a flat legacy channel the moment it takes its first structural child.
    const asRoot = input.root === true && !input.parent_id;
    // Roots are EVERY tenant's since the 2026-08-26 unification. The refusal
    // that used to sit here existed because the agency arm auto-ran a per-level
    // #broadcast and had never produced level 0; that producer no longer
    // exists for any tenant, so the refusal's rationale went with it.
    // vs2 item 8 — A ROOT MAY NOT BE MANAGERS-ONLY, at creation either.
    //
    // P2-d already refuses TIGHTENING a root that has children and refuses
    // hanging a child off a restricted root. This is the remaining door: minting
    // the root restricted in the first place. A root nobody can see gives every
    // member below it `parent_hidden` Mains with no visible ancestor — a
    // directory with zero organisations in it.
    //
    // Server-side, not client-side: the editor's ACCESS tri-state hides
    // Restricted when the parent row reads "Top level", but a client-only rule
    // is reachable by editing the root afterwards, which is why the refusal
    // lives in createChannel AND configureChannel.
    // STRUCTURAL, not flag-driven. Keying this on `input.root` made it
    // bypassable by omitting one boolean: `{name, access:'restricted'}` with no
    // parent_id still produced a parentless restricted root, and every existing
    // workspace organisation IS a parentless root — exactly the state the rule
    // forbids. Every other root rule in this file asks `parent_id IS NULL`;
    // this one now agrees with them.
    //
    // Tenant-gated, because `seedsManagersOnly` also covers channel_type
    // 'incident' and agencies legitimately create top-level incident channels.
    if (!input.parent_id
        && DepartmentService.seedsManagersOnly(access, channel_type)
        && await this.isWorkspaceTenant(orgUserId)) {
      throw new BadRequestException('restricted_root_not_allowed');
    }
    // `is_lateral` is RETURNED, not assumed. The client echoes it back against
    // what it asked for: in production `forbidNonWhitelisted` is false, so an old
    // instance behind a rolling deploy strips `lateral` and silently makes a
    // structural child — which is frozen and un-re-parentable, i.e. unfixable.
    // The echo is the only signal that survives that window.
    const ch = await this.db.qOne<{id: string; level: number; is_lateral: boolean}>(
      `INSERT INTO public.department_channels (org_id, name, department, channel_type, access, created_by, parent_id, post_mode, is_lateral${asRoot ? ', level' : ''})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${asRoot ? ', 0' : ''})
       RETURNING id, level, is_lateral`,
      [orgUserId, input.name, input.department ?? null, channel_type, access, managerUserId,
       input.parent_id ?? null, post_mode, asLateral],
    );
    if (!ch) throw new BadRequestException('channel_create_failed');
    const members = await this.activeOrgMembers(orgUserId);
    await this.seedChannelMembers(orgUserId, ch.id, access, channel_type, members, post_mode);
    // vs2 items 5+12, extended to EVERY tenant on 2026-08-26: "nothing
    // auto-added beneath a main channel" now has no tenant carve-out, so the
    // per-level auto-#broadcast producer that used to run here for agencies is
    // gone entirely (the scope-v1 A9 rule it implemented is retired with it).
    await this.audit.log(orgUserId, managerUserId, 'channel.create', {
      targetKind: 'channel', targetId: ch.id,
      metadata: {channel_type, access, parent_id: input.parent_id ?? null, level: ch.level, post_mode,
        is_lateral: ch.is_lateral},
    });
    return {id: ch.id, name: input.name, channel_type, access, level: ch.level, post_mode,
      is_lateral: ch.is_lateral};
  }

  async configureChannel(
    orgUserId: string, managerUserId: string, channelId: string,
    input: {name?: string; department?: string; channel_type?: ChannelType; access?: ChannelAccess;
            post_mode?: ChannelPostMode},
  ): Promise<{ok: true}> {
    const current = await this.assertManagesChannel(orgUserId, channelId);

    // Tightening to a managers-only channel is a MEMBERSHIP change, not a bare
    // column flip: remove each CPO viewer through removeMember so a remove+rekey
    // intent is enqueued and the admin device rotates the master key away from
    // them (else a de-scoped CPO keeps the old key — the §0.3/Step-12 seam).
    const newAccess = input.access ?? current.access;
    const newType = input.channel_type ?? current.channel_type;
    const wasManagersOnly = DepartmentService.seedsManagersOnly(current.access, current.channel_type);
    const nowManagersOnly = DepartmentService.seedsManagersOnly(newAccess, newType);
    if (!wasManagersOnly && nowManagersOnly) {
      // vs2 item 2 — A ROOT WITH CHILDREN MAY NOT BECOME MANAGERS-ONLY.
      //
      // Tightening runs removeMember for every non-manager below, so two taps
      // in the editor retroactively strip the whole workforce out of the
      // organisation root — and each of them is then left holding channels
      // whose only path to the top runs through a node they cannot see. Their
      // directory shows no organisation at all.
      //
      // Scoped to roots WITH ACTIVE CHILDREN on purpose. Every channel in every
      // pre-hierarchy workspace is parentless, so a bare `parent_id IS NULL`
      // would forbid Restricted on all of them — including tightening an
      // existing one, which is today's only route to a managers-only channel —
      // and re-parenting is refused by the trigger, so they could never become
      // managers-only again. A CHILDLESS top-level channel orphans nobody.
      if (current.parent_id === null && await this.activeChildCount(channelId) > 0) {
        throw new ConflictException('restricted_root_would_orphan_children');
      }
      // …AND the childless case, on a WORKSPACE. The carve-out above was
      // written for legacy flat level-1 channels, where "childless top-level"
      // orphans nobody. Item 8's organisation roots break that assumption: a
      // freshly created, still-childless organisation can be tightened in two
      // taps, after which it is invisible to every member AND can never take
      // children (createChannel refuses a restricted-root parent) — a directory
      // with zero organisations, permanently.
      //
      // createChannel's comment already claimed this refusal lived on both
      // verbs. It did not; this is the half that was missing.
      if (current.parent_id === null && await this.isWorkspaceTenant(orgUserId)) {
        throw new ConflictException('restricted_root_not_allowed');
      }
      // Select NON-MANAGERS, not `role = 'viewer'`.
      //
      // Phase 2 broke the old query: `role` is now a POSTING right, so in an
      // `open` channel ordinary members are seeded 'admin'. Tightening such a
      // channel would have matched nobody and left every member holding the
      // group key — the exact rekey seam this block exists to close. Who to
      // remove is a VISIBILITY question, so it must be answered from org
      // membership, never from the posting column.
      const viewers = await this.db.q<{user_id: string}>(
        `SELECT m.user_id FROM public.department_channel_members m
          WHERE m.channel_id = $1
            AND m.user_id <> $2
            AND NOT EXISTS (
              SELECT 1 FROM public.org_members om
               WHERE om.org_user_id = $2 AND om.member_user_id = m.user_id
                 AND om.member_role = 'manager' AND om.status = 'active')`,
        [channelId, orgUserId],
      );
      const failed: string[] = [];
      for (const v of viewers) {
        try {
          await this.removeMember(orgUserId, channelId, v.user_id, managerUserId);
        } catch (e) {
          // 'member_not_found' = already gone (idempotent retry) → benign. Any
          // other failure means this CPO was NOT rekeyed out.
          if (e instanceof NotFoundException) continue;
          failed.push(v.user_id);
          this.log.warn(`configure-tighten remove failed for ${v.user_id} on ${channelId}: ${(e as Error).message}`);
        }
      }
      // 🛑 Never bare-flip to managers-only while a removal failed — that would
      // leave a de-scoped CPO holding the old group master key. Abort; the
      // already-removed members keep their remove+rekey intents, and a retry
      // (members already gone → benign) converges.
      if (failed.length) throw new BadRequestException('channel_tighten_incomplete');
    } else if (wasManagersOnly && !nowManagersOnly) {
      // D7-b — loosening back to a standard channel must RE-SEED the CPO viewers the earlier
      // tighten rekeyed out, or the channel stays managers-only forever. Re-add via addMember
      // so each gets an add+rekey intent (the admin device redelivers the master key) — a bare
      // membership insert would NOT redeliver the key. Managers are already admins; skip them.
      // Read the STORED mode on a #broadcast, exactly as the post_mode re-seed
      // below already does — this was the last place that answered "who may
      // post" from the REQUEST. dept_channel_broadcast_mode pins a broadcast to
      // 'announcement', so a request carrying post_mode:'open' made every
      // addMember below ask for a posting role; F8's rule refuses that and the
      // catch swallows the refusal, so a tighten→loosen on the mandatory
      // #broadcast returned 200 with NO ordinary member re-added.
      const loosenedPostMode: ChannelPostMode = current.is_broadcast
        ? (current.post_mode ?? 'read_only')
        : (input.post_mode ?? current.post_mode ?? 'read_only');
      const members = await this.activeOrgMembers(orgUserId);
      for (const m of members) {
        if (m.member_role === 'manager') continue;
        try {
          // Role from POST_MODE, not hardcoded 'viewer' — loosening an `open`
          // channel used to leave everyone mute. And NO role_label: stamping
          // 'CPO' here re-introduced the exact A7.3 defect fixed in Phase 0
          // (the stored label wins over the tenant's live noun, so an
          // Enterprise roster read "CPO" again after any loosen).
          await this.addMember(orgUserId, channelId, m.member_user_id,
            DepartmentService.memberRoleFor(loosenedPostMode), undefined, managerUserId);
        } catch (e) {
          this.log.warn(`configure-loosen re-add failed for ${m.member_user_id} on ${channelId}: ${(e as Error).message}`);
        }
      }
    }

    // WhatsApp-style "X renamed the channel" system line — the client derives
    // it by noticing name_changed_at advance past its last-seen value, so
    // only stamp attribution on an ACTUAL rename (trimmed + different), never
    // a no-op save that happens to resend the same name.
    const renamed = typeof input.name === 'string' && input.name.trim() && input.name.trim() !== current.name;

    const updated = await this.db.qOne<{post_mode: ChannelPostMode}>(
      // D7-c — `department` uses an explicit-clear sentinel ('' clears, NULL/absent keeps) so a
      // channel's department CAN be cleared. The other columns keep COALESCE (no clear needed).
      `UPDATE public.department_channels
          SET name         = COALESCE($2, name),
              department    = CASE WHEN $3::text IS NULL THEN department
                                   WHEN $3::text = '' THEN NULL
                                   ELSE $3 END,
              channel_type  = COALESCE($4, channel_type),
              access        = COALESCE($5, access),
              post_mode     = COALESCE($9, post_mode),
              name_changed_by = CASE WHEN $7 THEN $8 ELSE name_changed_by END,
              name_changed_at = CASE WHEN $7 THEN NOW() ELSE name_changed_at END
        WHERE id = $1 AND org_id = $6
        RETURNING post_mode`,
      [channelId, input.name ?? null, input.department ?? null,
       input.channel_type ?? null, input.access ?? null, orgUserId, renamed, managerUserId,
       input.post_mode ?? null],
    );
    // Changing WHO MAY POST has to re-seed existing members' roles, or the
    // switch is cosmetic: role is what actually gates posting, and it was
    // stamped at seed time. Managers and the org account are untouched — only
    // the non-manager rows move between 'admin' (open) and 'viewer'.
    if (input.post_mode) {
      // Re-seed from the STORED post_mode, never the requested one.
      //
      // A #broadcast is pinned to 'announcement' by dept_channel_broadcast_mode,
      // so a request carrying post_mode:'open' leaves the row correct while the
      // ROLES — which are what actually gate posting — would have been promoted
      // to 'admin'. Members posting in a #broadcast is exactly what page 10
      // rule 1 forbids, and the receive-side filter would fail open too because
      // everyone would be in the poster set. The trigger guards the rule column;
      // only reading it back guards the enforcement column.
      const effective = (updated?.post_mode ?? input.post_mode) as ChannelPostMode;
      await this.db.q(
        `UPDATE public.department_channel_members m
            SET role = $3
          WHERE m.channel_id = $1
            AND m.user_id <> $2
            AND NOT EXISTS (
              SELECT 1 FROM public.org_members om
               WHERE om.org_user_id = $2 AND om.member_user_id = m.user_id
                 AND om.member_role = 'manager' AND om.status = 'active')`,
        [channelId, orgUserId, DepartmentService.memberRoleFor(effective)],
      );
    }
    await this.audit.log(orgUserId, managerUserId, 'channel.configure', {
      targetKind: 'channel', targetId: channelId,
      metadata: {channel_type: input.channel_type, access: input.access, post_mode: input.post_mode},
    });
    return {ok: true};
  }

  async archiveChannel(orgUserId: string, managerUserId: string, channelId: string): Promise<{ok: true}> {
    // The call IS the authorization; the row itself is no longer needed here
    // (the broadcast gate that read it fell with the 2026-08-26 unification).
    await this.assertManagesChannel(orgUserId, channelId);
    // 2026-08-26 unification: a legacy #broadcast is archivable by EVERY
    // tenant. The scope-v1 "non-deletable" rule protected rows the service
    // auto-created; it creates none any more, and parity for existing service
    // providers is precisely the ability to remove their seeded rows. The DB
    // delete trigger is dropped by 20260826130000 for the same reason.
    // Scope v2 Phase 1 — archiving a parent must not orphan its subtree.
    // archive flips one row, so the children stayed active: the list showed
    // sub-channels whose parent had vanished, and ManageChannels put the parent
    // under ARCHIVED while its children sat under CHANNELS.
    //
    // REFUSE rather than cascade, deliberately. Cascading would archive channels
    // the manager never selected (and unarchive would then have to guess which
    // ones to bring back). Refusing mirrors the ON DELETE RESTRICT already on
    // this FK: deal with the branch explicitly, bottom-up.
    // EXCLUDE the level's #broadcast from the child count.
    //
    // A per-LEVEL broadcast is parented to some branch node, so it counted as
    // that node's active child — and it cannot itself be archived. The two
    // guards together made the first branch root of every org PERMANENTLY
    // un-archivable and un-deletable, triggered by the first sub-channel anyone
    // creates. The broadcast is a level-scoped object that merely hangs off a
    // node; it must not pin that node's lifecycle.
    if (await this.activeChildCount(channelId) > 0) {
      throw new ConflictException('channel_has_active_sub_channels');
    }
    // A legacy broadcast goes with it — leaving an orphan broadcast under an
    // archived parent is the same dangling state the child guard exists to
    // prevent. (Nothing mints new ones since the 2026-08-26 unification; this
    // sweep only tidies rows seeded before it.)
    await this.db.q(
      `UPDATE public.department_channels SET archived_at = NOW()
        WHERE parent_id = $1 AND is_broadcast AND archived_at IS NULL`,
      [channelId],
    );
    await this.db.q(
      `UPDATE public.department_channels SET archived_at = NOW()
        WHERE id = $1 AND org_id = $2 AND archived_at IS NULL`,
      [channelId, orgUserId],
    );
    await this.audit.log(orgUserId, managerUserId, 'channel.archive', {
      targetKind: 'channel', targetId: channelId,
    });
    return {ok: true};
  }

  async unarchiveChannel(orgUserId: string, managerUserId: string, channelId: string): Promise<{ok: true}> {
    await this.assertManagesChannel(orgUserId, channelId);
    // The mirror of archiveChannel's guard, and it must exist on BOTH sides.
    // Archiving alone could not orphan a subtree, but this sequence could:
    //   archive C (leaf, allowed) → archive P (allowed, C is no longer active)
    //   → unarchive C  → an ACTIVE child under an ARCHIVED parent.
    // Exactly the state the archive guard was written to prevent, reached from
    // the unguarded side.
    const parent = await this.db.qOne<{
      archived: boolean; is_root: boolean; access: ChannelAccess; channel_type: ChannelType;
    }>(
      `SELECT (p.archived_at IS NOT NULL) AS archived,
              (p.parent_id IS NULL) AS is_root, p.access, p.channel_type
         FROM public.department_channels c
         JOIN public.department_channels p ON p.id = c.parent_id
        WHERE c.id = $1`,
      [channelId],
    );
    if (parent?.archived) throw new ConflictException('channel_parent_is_archived');
    // vs2 item 2 — THE THIRD DOOR into "restricted root with active children".
    //
    // createChannel and configureChannel both refuse that state now, and this
    // method reaches it by the same archive→archive→unarchive shape the comment
    // above already describes: archive the child (leaf, allowed) → the root is
    // now childless so tightening it passes configureChannel's guard →
    // unarchive the child. The parent is not archived, so the check above lets
    // it through, and the workforce below is stranded under a node they cannot
    // see. A rule enforced on two of its three doors is not enforced.
    if (parent && parent.is_root
        && DepartmentService.seedsManagersOnly(parent.access, parent.channel_type)) {
      throw new ConflictException('restricted_root_cannot_take_children');
    }
    // 23505 is reachable again now that archiving a parent CASCADES to its
    // level's #broadcast: archive P (broadcast goes too) → create a channel at
    // that level (a fresh broadcast is minted) → unarchive the old broadcast →
    // two active broadcasts at one level, which the partial unique index
    // rejects. Untranslated that is a 500; say what actually happened.
    try {
      await this.db.q(
        `UPDATE public.department_channels SET archived_at = NULL
          WHERE id = $1 AND org_id = $2 AND archived_at IS NOT NULL`,
        [channelId, orgUserId],
      );
    } catch (e: unknown) {
      if ((e as {code?: string})?.code === '23505') {
        throw new ConflictException('level_already_has_a_broadcast');
      }
      throw e;
    }
    await this.audit.log(orgUserId, managerUserId, 'channel.unarchive', {
      targetKind: 'channel', targetId: channelId,
    });
    return {ok: true};
  }

  /** Every channel of the manager's org (incl. archived), for the manage screen.
   *  Not membership-filtered — a manager governs the whole org.
   *
   *  ── vs2 edge A3 — WHY THE TENANT FACT RIDES ALONG ─────────────────────────
   *
   *  `workspace_tenant` describes the ORG IN THIS RESPONSE, not the caller. The
   *  client's own predicate (`isWorkspaceTenant`) is a USER-level fact — true
   *  for anybody with any workspace affiliation at all — and it is genuinely
   *  ambiguous for the dual persona: an agency company/manager who has ALSO
   *  joined an Enterprise workspace. That person opening their AGENCY's Manage
   *  Channels got the workspace-shaped UI, and the editor drops DEPARTMENT and
   *  TYPE on that shape — so new agency channels were created with
   *  `department = null`, which is the live branch-scope key for attendance,
   *  incidents and invite minting (and a null department also makes the channel
   *  mintable by every manager under the item-7 relaxation).
   *
   *  It is answered per-RESPONSE and not per-row on purpose: it is a property of
   *  the org, and a clean P3 workspace has ZERO rows — a per-row flag would have
   *  no way to say "workspace" for exactly the tenant this scope created.
   */
  async listOrgChannels(
    orgUserId: string,
    managerDepartment: string | null = null,
    /** vs2 edge A4 — WHO is asking, so each row can say whether THEY may delete
     *  it. Optional: an old caller omits it and every row reports not-deletable,
     *  which is the pre-A4 client behaviour (no Delete on the admin path). */
    managerUserId?: string,
  ): Promise<{
    workspace_tenant: boolean;
    /**
     * vs2 edge A8 — may this MINTER grant the manager role?
     *
     * A per-MINTER fact, which is why it cannot ride `mintable_by_me`: that one
     * is per-ROW, and the plan's G10 record already states it deliberately
     * cannot express this. The invite picker greyed team rows correctly and
     * still offered "Manager" to a branch-scoped manager, refusing only at
     * submit — honest, but after the work.
     *
     * Mirrors `enterprise-join.service`'s rule (`managerDepartment != null &&
     * role === 'manager'` → `scoped_manager_cannot_grant_admin`) at the one
     * place that already knows the caller's branch scope.
     */
    can_grant_manager: boolean;
    /**
     * G5 (founder, 2026-08-19) — "When adding Admins, it should be organization
     * specific only. Admins should not be able to see other organizations."
     *
     * Inside a WORKSPACE tenant an "organisation" is a root CHANNEL (SASFA,
     * GSSG), not an `org_id` — one tenant holds several. Nothing scoped a
     * delegated manager to one of them, so an admin added to SASFA opened
     * Manage Channels and administered GSSG too.
     *
     * DERIVED, NOT STORED. The obvious answer is a new `org_members` column, and
     * it is the wrong one here: this service `SELECT`s its columns literally, so
     * a client that ships before the migration lands takes `42703
     * undefined_column` — a 500 on the member directory, Manage Channels, the
     * home dashboard, the vault shelf, the ops departments table, the invite
     * picker and `createChannel`. The whole module, down. The scope is instead
     * read off membership rows that already exist: path-scoped seeding
     * (`resolveSeedScopeInTx`) already seeds an invited manager along one
     * branch, so "which organisations is this person actually in" is answered
     * data, not new data.
     *
     * `null` = UNSCOPED, which is today's behaviour exactly:
     *   - the owner / company account (it governs the whole tenant),
     *   - an AGENCY tenant (branch scope there is `department`; this must not
     *     touch a live permission surface the founder did not ask to change),
     *   - and a manager with NO seeded membership at all. Fail-OPEN on purpose:
     *     narrowing what an admin sees is safe, blanking a screen they can use
     *     today is not, and `[]` would do exactly that.
     *
     * ⚠️ THIS IS A VISIBILITY SCOPE, NOT AN AUTHORIZATION BOUNDARY. Every
     * mutation is still guarded by `assertManagesChannel` + `OrgManagerGuard`
     * as before; nothing here relaxes or replaces them. Absent on an old server
     * → the client keeps today's behaviour.
     */
    manager_scope_root_ids: string[] | null;
    channels: Array<{
    id: string; name: string; department: string | null; description: string | null;
    channel_type: ChannelType; access: ChannelAccess;
    // vs2 item 2 — the invite picker greys nodes this manager cannot mint into.
    // Absent (old server) means "not greyed", i.e. today's behaviour; the
    // post-submit 403 remains the real boundary either way.
    mintable_by_me: boolean;
    // WHY it is not mintable, null when it is. A boolean collapses five
    // distinct refusals into one bit, which left the client unable to write
    // honest copy — it told an unscoped OWNER looking at a restricted channel
    // that the team was "outside your branch" and to ask an owner to widen
    // their scope. No new disclosure: this caller is an org manager and already
    // receives every row of the org, refusals included.
    mint_refusal: string | null;
    // Emitted EXPLICITLY, not left absent, so the shared grouping helper can
    // tell "this source has no hidden parents" from "this server is too old to
    // say". Absent would send every admin row to the compat fallback, empty the
    // organisation list and dead-end the create flow on its first use.
    parent_hidden: boolean; visible_ancestor_id: string | null; root_id: string | null;
    // Scope v2 Phase 1 — frame A9 ("Show the full authorised hierarchy") reads
    // THIS query, not listChannels. It was the third read site and was missed
    // on the first pass.
    parent_id: string | null; level: number;
    // Phase 2 — the editor needs both to round-trip a channel losslessly.
    post_mode: ChannelPostMode; is_broadcast: boolean;
    // Item 04 — the renderer draws a lateral as a neutral card at its parent's
    // tier, and the editor needs it to offer the lateral-only affordances.
    is_lateral: boolean;
    member_count: number; provisioned: boolean; archived: boolean; created_at: string;
    /** vs2 edge A4 — may THIS caller delete this row? Computed from the same
     *  predicate `deleteChannel` enforces, so the button and the server can
     *  never disagree. */
    deletable: boolean;
    }>;
  }> {
    // Resolved ONCE for the whole page, not per row — the answer is a property
    // of the org, and this list can be hundreds of channels long.
    const workspaceTenant = await this.isWorkspaceTenant(orgUserId);
    const rows = await this.db.q<{
      id: string; name: string; department: string | null; description: string | null;
      channel_type: ChannelType; access: ChannelAccess; org_id: string; created_by: string;
      has_children: boolean;
      parent_id: string | null; level: number;
      post_mode: ChannelPostMode; is_broadcast: boolean; is_lateral: boolean;
      member_count: number; provisioned: boolean; archived: boolean; created_at: string;
    }>(
      `SELECT c.id, c.name, c.department, c.description, c.channel_type, c.access,
              c.org_id, c.created_by,
              -- edge A4 — matches the self-FK's RESTRICT exactly: it counts
              -- ARCHIVED children too, which the admin's tree hides.
              EXISTS (SELECT 1 FROM public.department_channels k WHERE k.parent_id = c.id) AS has_children,
              c.parent_id, c.level, c.post_mode, c.is_broadcast, c.is_lateral,
              (SELECT COUNT(*)::int FROM public.department_channel_members m WHERE m.channel_id = c.id) AS member_count,
              (c.group_conversation_id IS NOT NULL) AS provisioned,
              (c.archived_at IS NOT NULL) AS archived,
              c.created_at
         FROM public.department_channels c
        WHERE c.org_id = $1
        ORDER BY (c.archived_at IS NOT NULL), c.level ASC, c.created_at DESC`,
      [orgUserId],
    );
    // This source is not membership-filtered — a manager governs the whole org —
    // so every row's true parent_id is already present and nothing is ever
    // hidden. Stating that explicitly is what keeps the shared grouping helper
    // mode-free across its two callers.
    const scopeRootIds = await this.managerScopeRootIds(
      orgUserId, managerUserId, workspaceTenant, rows);
    return {
      // The SAME value the mint refusal below is decided with — one resolution,
      // so the UI shape and the server's own rules can never disagree about
      // which kind of org this is.
      workspace_tenant: workspaceTenant,
      // edge A8 — a branch-scoped manager cannot mint their way past their own
      // scope. Unscoped (the company account, or a manager with no department)
      // may. Same predicate as the mint-time refusal, stated up front.
      can_grant_manager: managerDepartment == null,
      manager_scope_root_ids: scopeRootIds,
      channels: rows.map(r => {
        // The ROW's org_id, not the caller's. Passing the caller's made the
        // cross-org arm unfireable from this reader — equivalent today because
        // the query filters on org_id, but it meant the shared predicate was only
        // half-exercised here, and "equivalent today" is how the two readers
        // start to drift.
        const refusal = DepartmentService.mintRefusalFor(
          {org_id: r.org_id, access: r.access, channel_type: r.channel_type,
           department: r.department, archived: r.archived, is_broadcast: r.is_broadcast,
           post_mode: r.post_mode},
          orgUserId, managerDepartment, workspaceTenant,
        );
        // `created_by` and `has_children` are DECIDING inputs, not payload:
        // they exist to compute `deletable` and must not widen the response.
        // This file already carries a disclosure-boundary test for exactly this
        // class (the `root_id` gating), so shipping them by accident would be
        // the same mistake with a new column.
        const {created_by: _createdBy, has_children: _hasChildren, ...row} = r;
        return {
          ...row,
          /**
           * edge A4 — AUTHORITY (the shared predicate, fed the ROW's org) AND
           * the two STRUCTURAL refusals the server raises separately, because a
           * button that always 409s is not a door.
           *
           *   - `has_children`: the self-FK is ON DELETE RESTRICT, and it counts
           *     ARCHIVED children too — which the admin cannot see in the tree,
           *     so without this they tap Delete on an apparent leaf and are told
           *     it "still has channels inside it" that are nowhere on screen.
           *   - agency `#broadcast`: refused by a DB trigger, and the mapped
           *     copy advises archiving, which that tenant ALSO refuses. A
           *     dead-end button offering dead-end advice.
           *
           * Absent caller → the empty id matches nothing → false → pre-A4
           * behaviour (no Delete door anywhere).
           */
          deletable: DepartmentService.canDeleteChannel(r, managerUserId ?? '')
            && !r.has_children,
          parent_hidden: false,
          visible_ancestor_id: null,
          // Emitted for the same reason as the other two: on this source, absent
          // would be indistinguishable from "server too old to say".
          root_id: null,
          mintable_by_me: refusal === null,
          mint_refusal: refusal,
        };
      }),
    };
  }

  /**
   * G5 — which ORGANISATION ROOTS is this manager actually part of?
   *
   * Returns `null` for "unscoped, show everything" and a NON-EMPTY array
   * otherwise. See the `manager_scope_root_ids` docblock on `listOrgChannels`
   * for why the answer is derived rather than stored, and why empty must read
   * as unscoped rather than as "nothing".
   *
   * The walk is done in JS over `rows`, which the caller has already loaded and
   * which contains every channel in the org including archived ones — so a
   * membership on an archived leaf still resolves to its live root instead of
   * being silently dropped. A recursive CTE would be a second copy of the same
   * parent walk (`treeOrder`, `subtreeOf` and `ancestorPathOf` are the others)
   * against a table the caller is already holding in memory.
   *
   * `MAX_HOPS` mirrors the client's four: roots are capped at level 0/1, every
   * structural hop increments a level CHECKed <= 3, and a lateral contributes at
   * most one non-incrementing hop. It is also the cycle guard — re-parenting is
   * refused by the DB, but an unbounded `while` over user-shaped data is not a
   * risk worth taking for two saved lines.
   */
  private async managerScopeRootIds(
    orgUserId: string,
    managerUserId: string | undefined,
    workspaceTenant: boolean,
    rows: ReadonlyArray<{id: string; parent_id: string | null; is_broadcast: boolean}>,
  ): Promise<string[] | null> {
    // The owner / company account governs the whole tenant. Also covers the
    // pre-A4 caller that omits managerUserId entirely.
    if (!managerUserId || managerUserId === orgUserId) {return null;}
    // AGENCIES ARE UNTOUCHED. Their branch scope is `department`, which is live
    // and typed today; layering a second, differently-derived scope on top of
    // it would widen or narrow a permission surface nobody asked to change.
    if (!workspaceTenant) {return null;}

    /**
     * `m.role = 'admin'` NARROWS this toward the question actually being asked.
     *
     * The founder asked which organisations somebody ADMINISTERS; a membership
     * row answers which they BELONG TO. There is no stored per-organisation
     * authority to read, so this is the closest honest signal — and it is safe
     * in the direction that matters: `seedChannelMembers` gives a manager
     * `'admin'` unconditionally (`isManager ? 'admin' : memberRole`), so this
     * can never drop a manager's own organisation. What it does drop is every
     * organisation where they are only a VIEWER, which is the common way a
     * SASFA manager ends up holding a GSSG row.
     *
     * ⚠️ RESIDUE, stated rather than hidden: `memberRoleFor` also returns
     * 'admin' to a plain member of an `open` channel, so a manager who is an
     * ordinary participant in another organisation's open channel still widens
     * their own scope. Closing that needs a real "manages organisation X" fact,
     * which does not exist and which a new column was deliberately refused for
     * (see the field docblock). Fail-OPEN is the safe side here.
     *
     * `c.is_broadcast` is excluded for a different reason — see the root walk.
     */
    const memberships = await this.db.q<{channel_id: string}>(
      `SELECT m.channel_id
         FROM public.department_channel_members m
         JOIN public.department_channels c ON c.id = m.channel_id
        WHERE m.user_id = $1 AND c.org_id = $2
          AND m.role = 'admin'
          AND NOT c.is_broadcast`,
      [managerUserId, orgUserId],
    );
    if (memberships.length === 0) {return null;}

    const parentOf = new Map(rows.map(r => [r.id, r.parent_id]));
    const broadcastIds = new Set(rows.filter(r => r.is_broadcast).map(r => r.id));
    const MAX_HOPS = 4;
    const roots = new Set<string>();
    for (const {channel_id} of memberships) {
      let cur = channel_id;
      // A membership row whose channel is not in `rows` cannot be placed — it
      // would have to be in another org, which the JOIN above already excludes.
      if (!parentOf.has(cur)) {continue;}
      for (let hop = 0; hop <= MAX_HOPS; hop++) {
        const parent = parentOf.get(cur) ?? null;
        if (!parent || !parentOf.has(parent)) {break;}
        cur = parent;
      }
      /**
       * A PARENTLESS #broadcast IS NOT A ROOT, and the walk can land on one.
       *
       * `seedOrgWorkspace` and the 2026-08-05 backfill's `level <= 1` arm both
       * mint parentless broadcasts, and EVERY active member is seeded into
       * them — so a walk that terminates on one emits its id as an
       * "organisation root". The client's `topLevelOf` skips broadcast rows
       * entirely, so such an id can never match anything there: the set is
       * non-empty for the wrong reason, which defeats this function's own
       * "empty means unscoped" fail-open and hands the client a scope that
       * silently fails open one layer down instead. Two fail-opens firing for a
       * reason nobody intended is how a rule quietly stops existing.
       *
       * ⚠️ DEAD TODAY, AND KEPT DELIBERATELY — say so rather than let the
       * docblock imply it is the live guard. `AND NOT c.is_broadcast` in the
       * query above already means `cur` never STARTS on a broadcast, and
       * `broadcast_channel_cannot_have_children` means one is never anyone's
       * parent, so the walk cannot currently reach one. Both of those are
       * elsewhere; this is the local, one-line statement of the same
       * invariant, and `managerOrgScope.spec` pins THIS GUARD (by feeding a
       * membership row the real SQL cannot return) rather than the behaviour.
       */
      if (broadcastIds.has(cur)) {continue;}
      roots.add(cur);
    }
    // Empty is impossible here (every membership resolved above adds a root),
    // but it is stated rather than assumed: `[]` reaching the client would
    // blank the screen, and this is the one place that can produce it.
    return roots.size > 0 ? [...roots] : null;
  }

  /**
   * Live, non-broadcast children of a node.
   *
   * ONE query, two callers: the archive guard and the restricted-root guard
   * (vs2 item 2). They ask literally the same question — "would removing this
   * node from the members' view orphan anything?" — and a second copy of the
   * predicate is this repo's most-shipped bug shape. Broadcasts are excluded
   * because a per-LEVEL broadcast merely hangs off a node and must not pin that
   * node's lifecycle.
   */
  private async activeChildCount(channelId: string): Promise<number> {
    const kids = await this.db.qOne<{n: number}>(
      `SELECT COUNT(*)::int AS n FROM public.department_channels
        WHERE parent_id = $1 AND archived_at IS NULL AND NOT is_broadcast`,
      [channelId],
    );
    return kids?.n ?? 0;
  }

  /** Tenant guard rail: load the channel and assert the manager owns its org. */
  private async assertManagesChannel(orgUserId: string, channelId: string): Promise<{org_id: string; channel_type: ChannelType; access: ChannelAccess; name: string; post_mode: ChannelPostMode; is_broadcast: boolean; parent_id: string | null}> {
    const ch = await this.db.qOne<{org_id: string; channel_type: ChannelType; access: ChannelAccess; name: string; post_mode: ChannelPostMode; is_broadcast: boolean; parent_id: string | null}>(
      // Phase 2 — post_mode + is_broadcast come back here so callers resolve a
      // role from the STORED mode instead of re-deriving or hardcoding one.
      // vs2 item 2 — parent_id too: configureChannel cannot tell a ROOT from a
      // child without it, and the restricted-root guard is a rule about roots.
      `SELECT org_id, channel_type, access, name, post_mode, is_broadcast, parent_id
         FROM public.department_channels WHERE id = $1`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (ch.org_id !== orgUserId) throw new ForbiddenException('org_scope_violation');
    return ch;
  }

  /**
   * Rank inside a channel's org: 3 = the org owner, 2 = an active manager,
   * 1 = everyone else (CPO / employee / stranger).
   *
   * `department_channels.org_id` IS the owner's `users.id` (the agency company
   * account is the org — see addMember's `memberUserId !== ch.org_id` branch).
   */
  private async orgRank(orgId: string, userId: string): Promise<number> {
    if (userId === orgId) {return 3;}
    const m = await this.db.qOne<{member_role: string}>(
      `SELECT member_role FROM public.org_members
        WHERE org_user_id = $1 AND member_user_id = $2 AND status = 'active'`,
      [orgId, userId],
    );
    return m?.member_role === 'manager' ? 2 : 1;
  }

  /**
   * A membership mutation requires the actor to STRICTLY outrank the target.
   *
   * Channel `role` is a two-value flag (admin|viewer) with no link back to
   * `org_members.member_role`, and every manager is made channel-admin on every
   * org channel — so "is a channel admin" was the ONLY gate on role changes and
   * removals. That let a manager demote the OWNER to viewer, or delete the owner
   * from the owner's own channel and enqueue a rekey that locks them out. It
   * also meant that tapping "Allow post" on a CPO (which sends role='admin')
   * silently handed that CPO the right to change anyone's access, including the
   * owner's.
   *
   * Owner (3) may act on managers and CPOs; a manager (2) may act on CPOs only;
   * a CPO (1) may act on nobody. Equal rank is refused, so peers cannot fight.
   */
  private async assertOutranks(
    channelId: string, actorUserId: string, targetUserId: string,
  ): Promise<{org_id: string; is_broadcast: boolean; post_mode: ChannelPostMode}> {
    // is_broadcast AND post_mode ride along on a read this function already makes,
    // so the announcement posting rule below costs ZERO extra queries on the
    // normal path. post_mode is needed because an announcement channel can now
    // also be a LATERAL with post_mode=announcement, not only an is_broadcast row.
    const ch = await this.db.qOne<{org_id: string; is_broadcast: boolean; post_mode: ChannelPostMode}>(
      `SELECT org_id, is_broadcast, post_mode FROM public.department_channels WHERE id = $1`,
      [channelId],
    );
    if (!ch) {throw new NotFoundException('channel_not_found');}
    // Fast path: the org owner outranks everyone, and the internal callers that
    // bulk-remove viewers (configureChannel's tighten, syncMemberToOrgChannels)
    // all act AS the org — so this also keeps them at one extra query, not three.
    if (actorUserId === ch.org_id) {return ch;}
    const [actor, target] = await Promise.all([
      this.orgRank(ch.org_id, actorUserId),
      this.orgRank(ch.org_id, targetUserId),
    ]);
    if (target >= actor) {
      throw new ForbiddenException(
        target === 3 ? 'cannot_modify_org_owner' : 'insufficient_rank_for_target',
      );
    }
    return ch;
  }

  /**
   * #broadcast POSTING — page 10 rule 1: "#broadcast exists at each level;
   * Members cannot post, reply or call in it."
   *
   * THE HOLE THIS CLOSES (F8). Posting is gated by the member row's `role`
   * ('admin' posts, 'viewer' cannot). Every seed path already resolves that from
   * post_mode, which the DB trigger pins to 'announcement' on a broadcast, so
   * members land as viewers. But `role` has two OTHER writers that take it
   * straight from the caller — `updateMemberRole` (the in-thread "Allow post"
   * control) and `addMember` (the DTO's `role`) — and neither read
   * is_broadcast. One PATCH promoted a member to 'admin' inside #broadcast and
   * their composer came back, in the one channel the rule says it must not.
   *
   * "What ELSE decides this?" — the seed sites (seedChannelMembers), the
   * post_mode re-seed in configureChannel and the join/sync paths in
   * enterprise-join.service + org-cpo.service ALL route through
   * `memberRoleFor(<stored post_mode>)`, so they are already correct. These two
   * are the complete set of role writes that bypass it, which is why the rule
   * lives here and is called from exactly those two.
   *
   * MANAGERS AND THE OWNER ARE UNAFFECTED. The rule is about MEMBERS: the seed
   * makes every manager a channel admin on the broadcast too, and someone has to
   * be able to broadcast. So the refusal is rank-based (owner 3 / manager 2 may
   * post; everyone else may not), matching `isManager ? 'admin' : memberRole` in
   * seedChannelMembers rather than inventing a second notion of "member".
   */
  private async assertBroadcastPostingAllowed(
    ch: {org_id: string; is_broadcast: boolean; post_mode?: ChannelPostMode},
    targetUserId: string, role: 'admin' | 'viewer',
  ): Promise<void> {
    /**
     * KEYED ON THE BEHAVIOUR, NOT ON THE FLAG.
     *
     * This used to test `is_broadcast` alone. Item 04+D-5 introduced a second way
     * to be an announcement channel: a workspace admin creates a LATERAL with
     * post_mode 'announcement' (there is no is_broadcast field a caller can set,
     * and workspaces no longer get server-minted #broadcast rows). Testing the
     * flag alone would have let an admin promote a plain employee to poster in
     * exactly the channel page 10 rule 1 says members cannot post in — the same
     * rule, defeated by the new door.
     *
     * `post_mode` is optional on the parameter so the two existing callers that
     * select only `{org_id, is_broadcast}` keep compiling; both are updated to
     * select it, and the `=== 'announcement'` test is false for undefined, so an
     * un-updated caller degrades to exactly today's behaviour rather than to a
     * spurious refusal.
     */
    const announces = ch.is_broadcast || ch.post_mode === 'announcement';
    if (role !== 'admin' || !announces) {return;}
    if (await this.orgRank(ch.org_id, targetUserId) < 2) {
      throw new ForbiddenException('broadcast_members_cannot_post');
    }
  }

  // ─── Membership change + E2EE rekey propagation (Phase 3) ─────────────
  //
  // The server owns ONLY the metadata row + an intent queue. It NEVER holds
  // the group master key, so it cannot rekey. addMember/removeMember write
  // the membership row and enqueue an intent; the admin device drains
  // listMembershipIntents and broadcasts planAddAndRekey / planRemoveAndRekey.
  // Until that broadcast lands the change is eventually-consistent (documented).

  async addMember(
    adminUserId: string, channelId: string, memberUserId: string,
    role: 'admin' | 'viewer' = 'viewer', roleLabel?: string,
    // The HUMAN the audit row names. Internal bulk callers must act AS the org
    // for authorization (assertOutranks' fast path is identity-based), so
    // without this the audit said "the org account did it" on every path where
    // a real manager clicked the button (I-a review M1, 2026-08-07).
    // CONTRACT: must be the authenticated principal of the request that
    // triggered this — NEVER a caller-supplied body field, or org_audit_log
    // becomes forgeable. It is audit-only by construction: no permission
    // check may ever read it. (channel_membership_intents.requested_by
    // deliberately stays the AUTHORIZATION identity instead — the intent is
    // drained by whichever admin device holds the key, not by this human.)
    auditActor?: string,
  ): Promise<{ok: true}> {
    const r = await this.memberRole(adminUserId, channelId);
    if (r !== 'admin') throw new ForbiddenException('only_admin_can_manage_members');
    // Tenant scope (security): the target must belong to THIS channel's org — the
    // org account itself, or an ACTIVE org_members row. Without this, a channel
    // admin could rekey an arbitrary cross-org / non-org user into the E2EE group,
    // bypassing DeptChatAccessGuard's org-membership entitlement (audit D4-a).
    const ch = await this.db.qOne<{org_id: string; is_broadcast: boolean; post_mode: ChannelPostMode}>(
      // is_broadcast AND post_mode ride along on the tenant read so the
      // announcement posting rule below needs no extra query (see
      // assertBroadcastPostingAllowed — an announcement channel can be a
      // post_mode='announcement' LATERAL, not only an is_broadcast row).
      `SELECT org_id, is_broadcast, post_mode FROM public.department_channels WHERE id = $1 AND archived_at IS NULL`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    // #broadcast (F8) — refuse to ADD a member with a posting role. addMember is
    // an upsert (`DO UPDATE SET role = EXCLUDED.role`), so without this it is a
    // second, quieter promotion route to exactly what updateMemberRole refuses.
    await this.assertBroadcastPostingAllowed(ch, memberUserId, role);
    if (memberUserId !== ch.org_id) {
      const member = await this.db.qOne<{ok: number}>(
        `SELECT 1 AS ok FROM public.org_members
          WHERE org_user_id = $1 AND member_user_id = $2 AND status = 'active'`,
        [ch.org_id, memberUserId],
      );
      if (!member) throw new ForbiddenException('member_not_in_org');
    }
    // ONE transaction for the three WRITES — membership + intent + audit
    // (page-10 rule 4, 2026-08-07). The intent row drives the security-critical
    // rekey, so an audit row without the intent — or a membership row without
    // either — misdescribes the E2EE state the audit exists to attest. (Write
    // atomicity only: the authorization reads above stay outside the boundary,
    // as they always did.) Membership writers and their audit coverage:
    // this method (member.channel_add — configureChannel's loosen and
    // enterprise-join seeding route through here), removeMember
    // (member.channel_remove), updateMemberRole (member.channel_role),
    // seedChannelMembers' bulk INSERTs + configureChannel's re-seed role
    // UPDATE (covered by the channel.create / channel.configure row of the
    // operation that runs them — documented exemption). Cost note: this turns
    // 2 autocommit statements into a 5-round-trip tx per member; acceptable at
    // current roster sizes, revisit before bulk loosen on very large orgs.
    await this.db.withTransaction(async tx => {
      await tx.q(
        `INSERT INTO public.department_channel_members (channel_id, user_id, role, role_label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET role = EXCLUDED.role, role_label = EXCLUDED.role_label`,
        [channelId, memberUserId, role, roleLabel ?? null],
      );
      await this.enqueueIntent(tx, channelId, memberUserId, 'add', adminUserId);
      await this.audit.log(ch.org_id, auditActor ?? adminUserId, 'member.channel_add', {
        targetKind: 'user', targetId: memberUserId,
        metadata: {channel_id: channelId, role}, tx,
      });
    });
    return {ok: true};
  }

  async removeMember(
    adminUserId: string, channelId: string, memberUserId: string,
    auditActor?: string, // same contract + same 5-RT tx cost note as addMember
  ): Promise<{ok: true}> {
    const r = await this.memberRole(adminUserId, channelId);
    if (r !== 'admin') throw new ForbiddenException('only_admin_can_manage_members');
    if (memberUserId === adminUserId) throw new ForbiddenException('cannot_remove_self');
    const ch = await this.assertOutranks(channelId, adminUserId, memberUserId);
    // Same tx rule as addMember: the intent drives the rekey (without it the
    // removed member RETAINS the master key), so the row, the intent and the
    // audit commit or roll back together.
    await this.db.withTransaction(async tx => {
      const removed = await tx.qOne<{user_id: string}>(
        `DELETE FROM public.department_channel_members
          WHERE channel_id = $1 AND user_id = $2 RETURNING user_id`,
        [channelId, memberUserId],
      );
      if (!removed) throw new NotFoundException('member_not_found');
      await this.enqueueIntent(tx, channelId, memberUserId, 'remove', adminUserId);
      await this.audit.log(ch.org_id, auditActor ?? adminUserId, 'member.channel_remove', {
        targetKind: 'user', targetId: memberUserId,
        metadata: {channel_id: channelId}, tx,
      });
    });
    return {ok: true};
  }

  private async enqueueIntent(
    q: Pick<Tx, 'q'>,
    channelId: string, memberUserId: string, action: 'add' | 'remove', requestedBy: string,
  ): Promise<void> {
    await q.q(
      `INSERT INTO public.channel_membership_intents (channel_id, member_user_id, action, requested_by)
       VALUES ($1, $2, $3, $4)`,
      [channelId, memberUserId, action, requestedBy],
    );
  }

  /** Pending membership intents for channels the caller administers — drained
   *  by the admin device, which broadcasts the corresponding rekey. */
  async listMembershipIntents(adminUserId: string): Promise<Array<{
    id: string; channel_id: string; group_conversation_id: string | null;
    member_user_id: string; action: 'add' | 'remove'; created_at: string;
  }>> {
    return this.db.q(
      `SELECT i.id, i.channel_id, c.group_conversation_id,
              i.member_user_id, i.action, i.created_at
         FROM public.channel_membership_intents i
         JOIN public.department_channels c ON c.id = i.channel_id
         JOIN public.department_channel_members m
           ON m.channel_id = i.channel_id AND m.user_id = $1 AND m.role = 'admin'
        WHERE i.state = 'pending'
        ORDER BY i.created_at ASC`,
      [adminUserId],
    );
  }

  /** Admin device acks it has broadcast the rekey for an intent. */
  async ackMembershipIntent(adminUserId: string, intentId: string): Promise<{ok: true}> {
    const row = await this.db.qOne<{id: string}>(
      `UPDATE public.channel_membership_intents i
          SET state = 'done', settled_at = NOW()
        WHERE i.id = $1 AND i.state = 'pending'
          AND EXISTS (
            SELECT 1 FROM public.department_channel_members m
             WHERE m.channel_id = i.channel_id AND m.user_id = $2 AND m.role = 'admin'
          )
        RETURNING i.id`,
      [intentId, adminUserId],
    );
    if (!row) throw new NotFoundException('intent_not_found_or_not_admin');
    return {ok: true};
  }

  /**
   * Change a member's role (viewer = read-only, admin = can post). Admin-only.
   * Metadata-only — NO rekey: the member already holds the group key; only their
   * post permission changes. (audit D-feature: in-thread access editing.)
   */
  async updateMemberRole(
    adminUserId: string, channelId: string, memberUserId: string, role: 'admin' | 'viewer',
    // Three-state (Q7/A7.3): a string OVERWRITES the stored label, `null`
    // CLEARS it (the roster then renders the live tenant noun — the only
    // label-free way a demoted manager loses their stored 'Manager'),
    // undefined keeps whatever is there.
    roleLabel?: string | null,
    auditActor?: string, // same contract + same tx cost note as addMember —
    // and demoteMemberChannels calls this once per open channel, so a demote
    // on an N-channel org is now N short transactions (I-a review F3).
  ): Promise<{ok: true}> {
    const r = await this.memberRole(adminUserId, channelId);
    if (r !== 'admin') throw new ForbiddenException('only_admin_can_manage_members');
    const ch = await this.assertOutranks(channelId, adminUserId, memberUserId);
    // #broadcast (F8) — "Allow post" must not restore a member's composer in the
    // one channel page 10 rule 1 says they cannot post in.
    await this.assertBroadcastPostingAllowed(ch, memberUserId, role);
    // Audited like its siblings (I-a review M2): this writes the same
    // privilege member.channel_add records — a role flip IS a posting grant
    // or revocation, and demoteMemberChannels routes half a demotion through
    // here. Same one-tx rule.
    await this.db.withTransaction(async tx => {
      const updated = await tx.qOne<{user_id: string}>(
        `UPDATE public.department_channel_members
            SET role = $3,
                role_label = CASE WHEN $5 THEN NULL ELSE COALESCE($4, role_label) END
          WHERE channel_id = $1 AND user_id = $2 RETURNING user_id`,
        [channelId, memberUserId, role, roleLabel ?? null, roleLabel === null],
      );
      if (!updated) throw new NotFoundException('member_not_found');
      await this.audit.log(ch.org_id, auditActor ?? adminUserId, 'member.channel_role', {
        targetKind: 'user', targetId: memberUserId,
        metadata: {channel_id: channelId, role}, tx,
      });
    });
    return {ok: true};
  }

  /**
   * May `userId` delete this channel? ONE rule, because the client renders the
   * button from it and the server enforces it — two copies would disagree and
   * the disagreement would surface as a button that 403s.
   *
   * ── vs2 edge A4 (founder decision, 2026-08-13) ────────────────────────────
   *
   * Creator-only was too narrow to satisfy the PDF's own ask: a workspace OWNER
   * could not delete a channel a delegated manager had created, so Delete was
   * refused to the one person who governs the whole org. The rule is now
   * owner-OR-creator — but on the WORKSPACE TENANT ONLY. The agency arm's
   * `created_by` rule predates this review and has its own consumers, so it is
   * left exactly as it was.
   *
   * "Owner" needs no extra query: an Enterprise workspace is keyed on its
   * owner's account (`org_workspaces.owner_user_id`), and that same id is the
   * channel's `org_id` — so `userId === org_id` IS "I am the workspace owner".
   *
   * STATIC AND PURE, deliberately — the same shape as `mintRefusalFor` above,
   * and for the same reason. The first draft of this fix had the rule TWICE:
   * once here and once inlined in `listOrgChannels`, with a comment claiming
   * they were single-sourced. They were not, and they already disagreed: the
   * inline copy keyed the owner arm on the CALLER's org while this one keys it
   * on the ROW's, so a row from another org would render a Delete button that
   * the server then 403s. Unreachable only because that query happens to filter
   * `org_id` today — which is precisely the "equivalent today is how two readers
   * start to drift" argument the mint predicate 400 lines up already makes.
   */
  static canDeleteChannel(
    row: {created_by: string; org_id: string},
    userId: string,
  ): boolean {
    // 2026-08-26 unification: the owner arm is no longer workspace-gated — a
    // service-provider owner may delete channels too (their legacy seeded set
    // being the case that matters). Creator arm unchanged.
    return row.created_by === userId || userId === row.org_id;
  }

  /**
   * Delete a channel — its creator, or the workspace owner (edge A4). Cascades
   * to members + intents via FK. Distinct from archive (manager hide). (user req.)
   */
  async deleteChannel(userId: string, channelId: string): Promise<{ok: true}> {
    const ch = await this.db.qOne<{created_by: string; org_id: string}>(
      `SELECT created_by, org_id FROM public.department_channels WHERE id = $1`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (!DepartmentService.canDeleteChannel(ch, userId)) {
      throw new ForbiddenException('only_creator_can_delete');
    }
    // Scope v2 Phase 1 — the self-FK is ON DELETE RESTRICT, so deleting a
    // channel that still has sub-channels raises Postgres 23503. Unhandled that
    // is a 500 rendered to the user as "Internal server error"; the PDF's own
    // rule ("Archive is preferred; permanent deletion is blocked when records
    // require retention") wants a clear refusal instead.
    try {
      await this.db.q(`DELETE FROM public.department_channels WHERE id = $1`, [channelId]);
    } catch (e: unknown) {
      if ((e as {code?: string})?.code === '23503') {
        throw new ConflictException('channel_has_sub_channels');
      }
      // The broadcast-delete trigger raises a bare RAISE EXCEPTION, which
      // Postgres reports as P0001. Untranslated it is a 500.
      //
      // Reachable in the DEPLOY WINDOW: if this code ships before migration
      // 20260811160000, a workspace owner tapping Delete on their #broadcast
      // hits the still-strict trigger. Translating it degrades that window to
      // an honest refusal instead of "Internal server error", and it stays
      // correct afterwards for agency orgs, where the rule genuinely holds.
      if ((e as {code?: string})?.code === 'P0001'
          && /broadcast_channel_cannot_be_deleted/.test((e as Error)?.message ?? '')) {
        throw new ConflictException('broadcast_channel_cannot_be_deleted');
      }
      throw e;
    }
    await this.audit.log(ch.org_id, userId, 'channel.delete', {targetKind: 'channel', targetId: channelId});
    return {ok: true};
  }

  /**
   * Reset the E2EE group linkage so the OWNER can re-provision a fresh group when
   * the channel is orphaned (owner lost local key state → "explicit peer address"
   * on send). Owner/creator-only. Clears group_conversation_id; the owner device
   * then mints a new group + registers it (server never holds a key). Closes the
   * irreversible-registerGroup gap (audit D4-b) and recovers orphaned channels.
   */
  async resetGroup(userId: string, channelId: string): Promise<{ok: true}> {
    const ch = await this.db.qOne<{created_by: string; org_id: string}>(
      `SELECT created_by, org_id FROM public.department_channels WHERE id = $1 AND archived_at IS NULL`,
      [channelId],
    );
    if (!ch) throw new NotFoundException('channel_not_found');
    if (ch.created_by !== userId && ch.org_id !== userId) {
      throw new ForbiddenException('only_owner_can_reset');
    }
    await this.db.q(
      `UPDATE public.department_channels SET group_conversation_id = NULL WHERE id = $1`,
      [channelId],
    );
    await this.audit.log(ch.org_id, userId, 'channel.reset_group', {targetKind: 'channel', targetId: channelId});
    return {ok: true};
  }

  private async memberRole(userId: string, channelId: string): Promise<'admin' | 'viewer'> {
    const row = await this.db.qOne<{role: 'admin' | 'viewer'}>(
      `SELECT role FROM public.department_channel_members
        WHERE channel_id = $1 AND user_id = $2`,
      [channelId, userId],
    );
    if (!row) throw new ForbiddenException('not_a_channel_member');
    return row.role;
  }
}
