/**
 * UI corrections 2026-08-15 — items 03, 04, 06 (and 11b by consequence).
 *
 * ONE renderer for the colour-coded, collapsible channel hierarchy, shared by
 * the member directory (`DepartmentChannelsScreen`) and the admin dashboard
 * (`ManageChannelsScreen` stage 2). The founder's asks, and where each lands:
 *
 *   §03 "Each channel level must have a drop down option in order to avoid over
 *        populating the screen"          → the chevron, and `collapsed`
 *   §03 "Each Level should be colour coded"  → `levelTint(tier)` + the Ln pill
 *   §06 "On the left side of each level there must be a hierarchy branch line"
 *                                        → the per-row connector
 *   §04 "lateral channels … should not have a colour. They can be the current
 *        transparent card box"           → `kind === 'lateral'` renders neutral
 *
 * ── WHAT TAPPING A ROW DOES (founder decision B-609/FB-1, 2026-08-22) ──────
 *
 * ⚠️ THIS REVERSES G1 (2026-08-19, "the whole card toggles"), which itself
 * reversed F3. The founder's FB-1 screenshot ask: the card SPLITS at the `|`
 * divider — tapping anywhere LEFT of it (the L# badge, `#`, name, members)
 * OPENS the chat; only the chevron (RIGHT of the divider) expands/collapses.
 * Under G1 the sole door to the thread was a tiny inner glyph, an unintuitive
 * target — this makes the obvious big region the obvious action.
 *
 * So, on the MEMBER surface (`splitCard`): **the card left region opens the
 * chat, and only the chevron toggles the branch.** A row with nothing to expand
 * keeps whole-card-opens (no dropdown to give it, and inert would delete a
 * door). ADMIN mode is untouched — its whole card still toggles and the pencil
 * is the editor door (see `splitCard = !admin && …`).
 *
 * ── AND NO DOOR IS LOST (G2) ──────────────────────────────────────────────
 *
 * Every level row is a real channel members were seeded into, and department
 * conversations are hidden from every messenger list, so the thread must stay
 * reachable. Since B-609 the chat door IS the card's own left region, so the
 * separate `pound-box` open button G1 needed is redundant and removed:
 *
 *   - MEMBER mode: the card (left of the divider) opens; the chevron toggles.
 *   - ADMIN mode:  `onEdit`/`onOpen` both navigate to ChannelEditor, so the
 *     pencil IS the open affordance; nothing added, nothing removed.
 *
 * A split member row has TWO accessibility controls: the name area (Open) and
 * the chevron (Expand/Collapse, now EXPOSED because it is the only toggle). On
 * an admin row the chevron duplicates the whole-card toggle, so it stays
 * `accessible={false}` — announcing "Expand SASFA" twice is worse than once. It
 * keeps a testID either way so the press is still testable.
 *
 * ── THE BRANCH LINE IS A PER-ROW GUTTER, NOT A SCREEN-LEVEL OVERLAY ──────
 *
 * Founder 2026-08-20: the PDF's §03 mockups show CONTINUOUS coloured lines
 * from each level down through everything under it, and the shipped `└` glyph
 * was not that ("the line thing are not present"). The earlier note here
 * rejected a rail because an absolutely-positioned overlay drifts out of
 * alignment when rows are variable height (fontScale 1.3+). That reasoning
 * still holds — which is why the rail is built from PER-ROW gutter cells that
 * stretch with their own row: each row draws its slice of every ancestor's
 * vertical line, so the segments join into a continuous line without any
 * screen-level geometry to drift. Colour follows the PARENT level ("colour
 * identifies depth; branch lines identify parentage" — PDF §03).
 *
 * ── THE TREE SHAPE IS NOT COMPUTED HERE ──────────────────────────────────
 *
 * `buildChannelTree` / `visibleTreeNodes` own it, beside `placeRow`. A screen
 * that re-derived parentage would be a second copy of the rule, which is this
 * repo's most-shipped defect, and `organisationTreeSingleSource` bans it — this
 * file must never branch on `parent_hidden` directly, only via `needsHiddenRung`
 * (already resolved into `node.rung`).
 */
import React from 'react';
import {View, Text, StyleSheet, TouchableOpacity, ActivityIndicator} from 'react-native';
import Icon from '@expo/vector-icons/MaterialCommunityIcons';
import {BravoFont} from '@theme/bravo';
import {scaleTextStyles} from '@utils/scaling';
import {OB, levelTint} from './_obsidian';
import {UnreadPill} from './UnreadPill';
import {useAggregateUnread} from './channelUnread';
import {HIDDEN_RUNG_LABEL, descendantIdsOf, type ChannelTreeNode} from './organisationTree';

type IconName = React.ComponentProps<typeof Icon>['name'];

/** Indent per step. 12dp base + 16 per level — ONE formula, stated once.
 *  Two different bases existed before (12+d*16 and d*16); this is the survivor. */
const INDENT_BASE = 12;
const INDENT_STEP = 16;
const indentOf = (depth: number) => INDENT_BASE + depth * INDENT_STEP;

export interface ChannelTreeRowMeta {
  /** The messenger group carrying this channel's posts, for the unread pill. */
  groupConversationId?: string | null;
  /** Right-hand status text under the name (member count, "Not yet active"…). */
  subtitle?: string;
  /** Spinner instead of the chevron while this row is being provisioned. */
  busy?: boolean;
}

export interface ChannelTreeProps {
  nodes: readonly ChannelTreeNode[];
  /** Ids whose children are hidden. */
  collapsed: ReadonlySet<string>;
  onToggle: (id: string) => void;
  /** Open this row's channel. Since B-609 it is reached from the CARD's left
   *  region (member surface — open on the left, toggle on the chevron) or from
   *  the pencil (admin). Undefined makes the row non-interactive. */
  onOpen?: (node: ChannelTreeNode) => void;
  /** Per-row extras the tree itself cannot know. */
  metaFor?: (node: ChannelTreeNode) => ChannelTreeRowMeta;
  /** True when a node has anything beneath it (drives the chevron). */
  isExpandable: (id: string) => boolean;
  /** ADMIN MODE — the per-level edit + create affordances from the PDF's §03
   *  admin mockup. Omitted entirely on the member surface. */
  admin?: {
    onEdit: (node: ChannelTreeNode) => void;
    /** Undefined hides the row — e.g. at the stored-level depth cap. */
    onAddSubLevel?: (node: ChannelTreeNode) => void;
    /** Undefined hides the row — e.g. an old server with no lateral support. */
    onAddLateral?: (node: ChannelTreeNode) => void;
    /**
     * B-590 — PER-NODE gate for "+ Add sub-level". The handler alone cannot
     * hide anything (it is one function for the whole tree), so the depth cap
     * used to render a button whose every tap silently no-opped — which is
     * exactly what the founder reported as "I can't go further". False hides
     * the row for that node; absent means every level shows it.
     */
    canAddSubLevel?: (node: ChannelTreeNode) => boolean;
  };
}

export function ChannelTree({
  nodes, collapsed, onToggle, onOpen, metaFor, isExpandable, admin,
}: ChannelTreeProps) {
  // ONE metaFor pass, reused by the rows AND by the collapsed roll-up below, so
  // a caller's metaFor is never invoked against a synthesised node.
  const metaById = React.useMemo(() => {
    const m = new Map<string, ChannelTreeRowMeta | undefined>();
    for (const n of nodes) {m.set(n.row.id, metaFor?.(n));}
    return m;
  }, [nodes, metaFor]);

  /**
   * B-590 / §03 — the branch-line geometry, one pass over the VISIBLE list.
   *
   * `cells[j]` is gutter column j for a row: the LAST column is the elbow that
   * joins the row to its parent; earlier columns carry ancestors' rails
   * through it. A rail continues below a row while the chain node that owns
   * that column still has a later visible sibling — which is exactly what
   * makes the per-row segments join into one continuous line. Colour is the
   * PARENT level's tint (PDF §03: "branch lines identify parentage").
   */
  const lineById = React.useMemo(() => {
    const byId = new Map(nodes.map(n => [n.row.id, n]));
    const lastChildOf = new Map<string | null, string>();
    const hasKids = new Set<string>();
    for (const n of nodes) {
      lastChildOf.set(n.parentId, n.row.id);
      if (n.parentId) {hasKids.add(n.parentId);}
    }
    const m = new Map<string, LineInfo>();
    for (const n of nodes) {
      const cells: GutterCell[] = [];
      let cur: ChannelTreeNode | undefined = n;
      for (let col = n.depth - 1; col >= 0 && cur?.parentId; col--) {
        const parent = byId.get(cur.parentId);
        cells[col] = {
          tint: parent && parent.kind === 'level' && parent.tier ? levelTint(parent.tier) : null,
          elbow: col === n.depth - 1,
          cont: lastChildOf.get(cur.parentId) !== cur.row.id,
        };
        cur = parent;
      }
      // A masked/orphan shape can leave leading holes; render them blank
      // rather than collapsing columns, so siblings still align.
      for (let col = 0; col < n.depth; col++) {
        if (!cells[col]) {cells[col] = {tint: null, elbow: false, cont: false};}
      }
      m.set(n.row.id, {cells, hasChildren: hasKids.has(n.row.id)});
    }
    return m;
  }, [nodes]);

  return (
    <View>
      {nodes.map(node => {
        const isCollapsed = collapsed.has(node.row.id);
        return (
          <ChannelTreeRow
            key={node.row.id}
            node={node}
            line={lineById.get(node.row.id)}
            collapsed={isCollapsed}
            expandable={isExpandable(node.row.id)}
            meta={metaById.get(node.row.id)}
            /**
             * THE COLLAPSED ROLL-UP. A collapsed level hides its children, so a
             * message inside one would otherwise be invisible everywhere — the
             * exact state the drill-in row's aggregate unread existed to fix,
             * reproduced by the feature that replaced it.
             *
             * Only when COLLAPSED: an expanded level shows its own count and its
             * children show theirs, so rolling up as well would double-count.
             */
            rolledUpIds={isCollapsed
              ? descendantIdsOf(nodes, node.row.id)
                .map(id => metaById.get(id)?.groupConversationId)
              : undefined}
            onToggle={onToggle}
            onOpen={onOpen}
            admin={admin}
          />
        );
      })}
    </View>
  );
}

/**
 * One row.
 *
 * Its own component because it SUBSCRIBES to the unread store — inlined in the
 * map, every row's subscription would live in the parent and one arriving
 * message would re-render the whole tree.
 */
/** One gutter column of a row's branch line. */
interface GutterCell {
  tint: string | null;
  /** The elbow joins this row to its parent; other cells are pass-throughs. */
  elbow: boolean;
  /** Does the vertical rail continue below this row? */
  cont: boolean;
}
interface LineInfo {cells: GutterCell[]; hasChildren: boolean}

/**
 * The branch line's gutter — one flex cell per ancestor column, each drawing
 * its slice of a vertical rail (and, for the last column, the elbow into this
 * row). Per-row and flex-sized, so it stretches with the row it belongs to and
 * cannot drift the way a screen-level overlay would.
 */
function Gutter({cells, id}: {cells: readonly GutterCell[]; id: string}) {
  if (cells.length === 0) {
    // Depth 0 keeps the 12dp inset the old `marginLeft: indentOf(0)` gave the
    // card. Without this every root row — and every row of a FLAT workspace,
    // which is the common shape — shifts to x=0 and misaligns with its own
    // subtree and add-rows.
    return <View testID={`channel-tree-indent-${id}`} style={{width: INDENT_BASE}} />;
  }
  return (
    <View
      pointerEvents="none"
      style={[s.gutter, {width: indentOf(cells.length) - INDENT_BASE, marginLeft: INDENT_BASE}]}>
      {cells.map((c, j) => {
        const colr = c.tint ?? OB.hair2;
        return (
          <View key={j} style={s.gutterCell}>
            {c.elbow ? (
              <>
                <View testID={`channel-tree-elbow-${id}`} style={[s.railTop, {backgroundColor: colr}]} />
                <View style={[s.railArm, {backgroundColor: colr}]} />
                {c.cont && (
                  <View testID={`channel-tree-elbowcont-${id}`} style={[s.railBottom, {backgroundColor: colr}]} />
                )}
              </>
            ) : c.cont ? (
              <View testID={`channel-tree-rail-${id}-${j}`} style={[s.railFull, {backgroundColor: colr}]} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function ChannelTreeRow({
  node, line, collapsed, expandable, meta, rolledUpIds, onToggle, onOpen, admin,
}: {
  node: ChannelTreeNode;
  line?: LineInfo;
  collapsed: boolean;
  expandable: boolean;
  meta?: ChannelTreeRowMeta;
  rolledUpIds?: (string | null | undefined)[];
  onToggle: (id: string) => void;
  onOpen?: (node: ChannelTreeNode) => void;
  admin?: ChannelTreeProps['admin'];
}) {
  // ONE hook either way — a conditional useChannelUnread/useAggregateUnread pair
  // would violate the rules of hooks the first time a level was expanded.
  const unreadIds = React.useMemo(
    () => [meta?.groupConversationId, ...(rolledUpIds ?? [])],
    [meta?.groupConversationId, rolledUpIds]);
  const unread = useAggregateUnread(unreadIds);
  const isLevel = node.kind === 'level';
  const tint = isLevel && node.tier ? levelTint(node.tier) : null;
  const name = node.row.name;

  /**
   * G1/G2 — who owns the card press.
   *
   * `expandable`, not `isLevel && expandable`: the DB forces a lateral to be a
   * leaf (`dept_channel_set_level`), but a fixture or a masked-ancestry shape
   * can still hand one a child, and a card that opened a chat while hiding
   * children behind an untappable chevron is the door-loss this whole block
   * exists to prevent. Toggling is the answer for anything with a subtree; the
   * open button below then restores the chat door uniformly.
   */
  const canToggle = expandable && !meta?.busy;
  const canOpen = !!onOpen && !meta?.busy;
  const cardOpens = !canToggle && canOpen;
  /**
   * B-609 (FB-1, founder 2026-08-22) — THE MEMBER CARD SPLITS AT THE DIVIDER.
   *
   * ⚠️ This REVERSES G1 (2026-08-19, "the whole card toggles") for the member
   * directory. The founder's screenshot ask: tapping anywhere LEFT of the `|`
   * divider — the L# badge, the `#`, the name, the members line — OPENS the
   * chat; only the chevron (RIGHT of the divider) expands/collapses the branch.
   * Under G1 the sole door to the thread was a tiny inner glyph, which read as a
   * wrong/near-invisible target.
   *
   * A split needs BOTH a branch to toggle AND a chat to open. ADMIN mode is
   * deliberately left on the pre-B-609 whole-card-toggles rule (its pencil is
   * the editor door), so `splitCard` is false whenever `admin` is set — nothing
   * on the ManageChannels surface changes.
   */
  const splitCard = !admin && canToggle && canOpen;
  // Stated once. The tier is part of every label on a level row, because
  // colour is the only other thing carrying it.
  const tierSuffix = isLevel && node.tier ? `, level ${node.tier}` : '';
  // ONE press handler, shared by the card and by the name area that voices it.
  // Two copies of "which action does this row perform?" is exactly how the
  // visible affordance and the announced one drift apart. On a split card (and
  // on a leaf) the card OPENS; otherwise the pre-B-609 rule stands — toggle when
  // there is a branch, else open.
  const cardPress = React.useCallback(() => {
    if (splitCard || cardOpens) { onOpen?.(node); }
    else if (canToggle) { onToggle(node.row.id); }
  }, [splitCard, cardOpens, canToggle, onOpen, onToggle, node]);

  return (
    <View>
      <View style={s.rowWrap}>
        <Gutter cells={line?.cells ?? []} id={node.row.id} />
        <View style={s.rowBody}>
      {/* The masked-ancestor placeholder. Neutral wording is deliberate — the
          commonest cause is a rung this member was simply never seeded into,
          so naming a reason would leak one and be wrong most of the time. */}
      {node.rung && (
        <Text style={s.rung}>{HIDDEN_RUNG_LABEL}</Text>
      )}

      {/**
        * G1 — THE WHOLE CARD. Toggles when there is something to expand,
        * otherwise opens. `disabled` when it can do neither, so a decorative
        * row does not report itself as a button.
        *
        * ⚠️ `accessible={false}` IS LOAD-BEARING, not tidiness. A Touchable
        * defaults to `accessible` and iOS then GROUPS its whole subtree into a
        * single element — which would swallow the pencil, the open button and
        * the chevron, i.e. every admin action on the row, for VoiceOver users.
        * The a11y control for this press is the name area below, which carries
        * the same label and the same action.
        */}
      <TouchableOpacity
        // The ONLY handle on this element: it is `accessible={false}`, so no
        // label query can reach it and a test that presses "the row" actually
        // presses the inner name area. Mutation-checked 2026-08-19: without
        // this testID, replacing the whole card with a plain `View` left every
        // suite green — G1, the founder's actual ask, was pinned by nothing.
        testID={`channel-tree-card-${node.row.id}`}
        accessible={false}
        activeOpacity={0.75}
        disabled={!canToggle && !cardOpens}
        onPress={cardPress}
        style={[
          s.row,
          isLevel && tint
            ? {backgroundColor: tint + '14', borderColor: tint + '4D'}
            : s.lateralRow,
        ]}>
        {/* The Ln pill. Carries the tier for anyone who cannot use the colour. */}
        {isLevel && node.tier ? (
          // levelTint re-read rather than reusing `tint`: TS cannot narrow the
          // outer `string | null` through this JSX guard, and widening the style
          // types to accept null would weaken every other colour in the file.
          <TierPill tier={node.tier} tint={levelTint(node.tier)} />
        ) : null}

        {/* `announcement` as well as `is_broadcast`: G4's re-placement clears
            the flag so the row can enter the tree as an ordinary lateral, and
            keying the glyph on the flag alone would silently turn every
            announcement channel into a plain chat the moment it was nested. */}
        <Icon
          name={(node.row.is_broadcast || node.row.announcement
            ? 'bullhorn-variant-outline' : 'pound') as IconName}
          size={15}
          color={tint ?? OB.textMute}
        />

        {/* NAME — the card press expressed as ONE accessibility control.
            Same action as the card (`cardPress`), so touch and screen reader
            can never disagree about what tapping the row does. Since B-609 a
            split (member) card announces "Open"; the pre-B-609 path still voices
            Expand/Collapse. */}
        <TouchableOpacity
          style={s.nameWrap}
          activeOpacity={0.75}
          disabled={!canToggle && !cardOpens}
          accessibilityRole="button"
          // B-609 — on a split card the name area OPENS (the chevron owns the
          // toggle), so it announces "Open" and carries no expanded state. Only
          // the pre-B-609 whole-card-toggles path (admin, or a non-split row)
          // voices Expand/Collapse here.
          accessibilityState={!splitCard && canToggle ? {expanded: !collapsed} : undefined}
          accessibilityLabel={!splitCard && canToggle
            ? `${collapsed ? 'Expand' : 'Collapse'} ${name}${tierSuffix}`
            : `Open ${name}${tierSuffix}`}
          onPress={cardPress}>
          <Text style={[s.name, isLevel ? {color: tint ?? OB.text, fontFamily: BravoFont.bold} : null]}
            numberOfLines={1}>{name}</Text>
          {meta?.subtitle ? (
            <Text style={s.sub} numberOfLines={1}>{meta.subtitle}</Text>
          ) : null}
        </TouchableOpacity>

        <UnreadPill count={unread} />

        {/* B-609 — the G2 chat door for an expandable member level is now the
            CARD's own left region (it opens; the chevron toggles), so the
            separate `pound-box` open button G1 added is redundant and is gone.
            No door is lost: the whole left-of-divider card opens the thread, and
            admin's pencil still navigates to the editor. */}

        {admin && (
          <TouchableOpacity
            style={s.iconBtn}
            hitSlop={{top: 8, bottom: 8, left: 8, right: 8}}
            accessibilityRole="button"
            accessibilityLabel={`Edit ${name}`}
            onPress={() => admin.onEdit(node)}>
            <Icon name="pencil-outline" size={16} color={OB.textMute} />
          </TouchableOpacity>
        )}

        {/* B-609 — THE DIVIDER: the founder's visual tap-zone boundary. Left of
            it opens the chat, the chevron to its right toggles the branch. Drawn
            only on a split card — a leaf or an admin row has ONE action for the
            whole card, so there is nothing to divide. Decorative: never a touch
            target (pointerEvents none), so it can never eat either zone's press. */}
        {splitCard && <View pointerEvents="none" style={s.divider} />}

        {/* THE DROPDOWN (§03) — its own ≥44dp target.

            Since B-609 the chevron is the ONLY toggle on a member (split) card,
            so there it is EXPOSED to accessibility: a labelled Expand/Collapse
            button carrying the expanded state. On the ADMIN card it still
            duplicates the whole-card toggle, so it stays hidden — announcing
            "Expand SASFA" twice per row is worse than once.

            A leaf shows a static chevron rather than a dead button. */}
        {meta?.busy ? (
          <ActivityIndicator size="small" color={OB.accentSoft} />
        ) : canToggle ? (
          <TouchableOpacity
            testID={`channel-tree-chevron-${node.row.id}`}
            // Member split card → a real, labelled toggle a screen reader can
            // reach and voice. Admin card → hidden duplicate of the card press.
            accessible={splitCard ? undefined : false}
            accessibilityRole={splitCard ? 'button' : undefined}
            accessibilityState={splitCard ? {expanded: !collapsed} : undefined}
            accessibilityLabel={splitCard
              ? `${collapsed ? 'Expand' : 'Collapse'} ${name}${tierSuffix}`
              : undefined}
            // BOTH, because they are per-platform: `importantForAccessibility`
            // is Android-only and `accessibilityElementsHidden` is iOS-only.
            // With only the first, iOS kept exposing the inner icon `Text` — a
            // private-use-area glyph with no label — so a labelled control had
            // been replaced by an unlabelled one on exactly one platform.
            importantForAccessibility={splitCard ? undefined : 'no-hide-descendants'}
            accessibilityElementsHidden={splitCard ? undefined : true}
            style={s.iconBtn}
            // LEFT slop is 8, matching `s.row.gap` exactly — NOT 10.
            // At 10 it reached 2 dp past the gap into the neighbouring control,
            // and both platforms award an overlap to the LATER sibling.
            hitSlop={{top: 10, bottom: 10, left: 8, right: 10}}
            onPress={() => onToggle(node.row.id)}>
            <Icon
              name={collapsed ? 'chevron-right' : 'chevron-down'}
              size={20}
              color={tint ?? OB.textMute}
            />
          </TouchableOpacity>
        ) : (
          <Icon name="chevron-right" size={16} color={OB.textMute} />
        )}
      </TouchableOpacity>
        </View>
      </View>

      {/* §04 admin mockup — "+ Add lateral channel" / "+ Add sub-level", inside
          the level they belong to. Hidden while collapsed: the point of the
          dropdown is to stop the screen overflowing, and two extra rows per
          level would defeat it. The rows sit BETWEEN a level and its children,
          so they carry the branch line too — otherwise the founder's continuous
          line would visibly break for the height of two admin rows. */}
      {admin && isLevel && !collapsed && (() => {
        const showSub = !!admin.onAddSubLevel && (admin.canAddSubLevel?.(node) ?? true);
        const base = (line?.cells ?? []).map(c => ({tint: c.tint, elbow: false, cont: c.cont}));
        // Each add-row's rail continues while ANYTHING renders below it in this
        // level's slice — the sibling add-row or the children. One shared cont
        // was the review's finding #6: on a childless level (the admin default
        // is EXPANDED, so every freshly created level shows both rows) the
        // line gapped for half a row between "Add lateral" and "Add sub-level".
        const lateralCells: GutterCell[] = [
          ...base, {tint, elbow: true, cont: showSub || !!line?.hasChildren},
        ];
        const subCells: GutterCell[] = [
          ...base, {tint, elbow: true, cont: !!line?.hasChildren},
        ];
        return (
          <View>
            {admin.onAddLateral && (
              <View style={s.rowWrap}>
                <Gutter cells={lateralCells} id={`${node.row.id}-add-lateral`} />
                <TouchableOpacity
                  style={[s.addRow, s.rowBody]}
                  accessibilityRole="button"
                  accessibilityLabel={`Add lateral channel in ${name}`}
                  onPress={() => admin.onAddLateral?.(node)}>
                  <Icon name="plus" size={13} color={OB.accentSoft} />
                  <Text style={s.addText} numberOfLines={1}>Add lateral channel</Text>
                </TouchableOpacity>
              </View>
            )}
            {showSub && (
              <View style={s.rowWrap}>
                <Gutter cells={subCells} id={`${node.row.id}-add-sublevel`} />
                <TouchableOpacity
                  style={[s.addRow, s.rowBody]}
                  accessibilityRole="button"
                  accessibilityLabel={`Add sub-level in ${name}`}
                  onPress={() => admin.onAddSubLevel?.(node)}>
                  <Icon name="plus" size={13} color={OB.accentSoft} />
                  <Text style={s.addText} numberOfLines={1}>Add sub-level</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        );
      })()}
    </View>
  );
}

/** The "Ln" badge. Its own component so the tint is a plain non-null string. */
function TierPill({tier, tint}: {tier: number; tint: string}) {
  return (
    <View style={[s.tierPill, {borderColor: tint + '66', backgroundColor: tint + '1F'}]}>
      <Text style={[s.tierPillText, {color: tint}]}>{`L${tier}`}</Text>
    </View>
  );
}

const s = StyleSheet.create(scaleTextStyles({
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    minHeight: 48, paddingVertical: 8, paddingHorizontal: 10, marginBottom: 6,
    borderRadius: 12, borderWidth: 1,
  },
  // B-590/§03 — the branch-line gutter. The wrapper stretches the gutter to the
  // row's full height INCLUDING the card's bottom margin, which is what joins
  // one row's rail to the next with no gap.
  rowWrap: {flexDirection: 'row', alignItems: 'stretch'},
  rowBody: {flex: 1, minWidth: 0},
  gutter: {flexDirection: 'row'},
  gutterCell: {flex: 1},
  railTop: {position: 'absolute', top: 0, height: '50%', left: '50%', width: 1.5, marginLeft: -0.75},
  railBottom: {position: 'absolute', top: '50%', bottom: 0, left: '50%', width: 1.5, marginLeft: -0.75},
  railFull: {position: 'absolute', top: 0, bottom: 0, left: '50%', width: 1.5, marginLeft: -0.75},
  railArm: {position: 'absolute', top: '50%', left: '50%', right: 2, height: 1.5, marginTop: -0.75},
  // §04 — "they should not have a colour. They can be the current transparent
  // card box as currently displayed."
  lateralRow: {backgroundColor: 'rgba(255,255,255,0.03)', borderColor: OB.hair2},
  nameWrap: {flex: 1, minWidth: 0, justifyContent: 'center', minHeight: 32},
  iconBtn: {width: 32, height: 32, alignItems: 'center', justifyContent: 'center'},
  // B-609 — the tap-zone boundary between the open (left) and toggle (chevron)
  // regions of a member card. A 1dp obsidian hairline, matching the card border.
  divider: {width: 1, height: 26, backgroundColor: OB.hair2, marginHorizontal: 2},
  tierPill: {paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, borderWidth: 1, flexShrink: 0},
  addRow: {flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 40, paddingVertical: 6},
  ...scaleTextStyles({
    name: {color: OB.text, fontFamily: BravoFont.regular, fontSize: 14},
    sub: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 2},
    tierPillText: {fontFamily: BravoFont.mono, fontSize: 8.5, fontWeight: '800', letterSpacing: 0.6},
    rung: {color: OB.textMute, fontFamily: BravoFont.regular, fontSize: 11, marginTop: 4, marginBottom: 2},
    addText: {color: OB.accentSoft, fontFamily: BravoFont.regular, fontSize: 12},
  }),
}));
