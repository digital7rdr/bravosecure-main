/**
 * G1/G2/G3 — WHAT A ROW DOES WHEN YOU TAP IT.
 *
 * ⚠️ CURRENT RULE IS B-609 / FB-1 (founder, 2026-08-22): the MEMBER card SPLITS
 * at the `|` divider — tapping anywhere LEFT of it (badge / # / name / members)
 * OPENS the chat; only the chevron (RIGHT of it) expands/collapses the branch.
 * This REVERSES the 2026-08-19 G1 ("the whole card toggles"), which had reversed
 * F3 ("chevron expands, name opens"). `channelHierarchyGrouping` carries the
 * matching source scan; behaviour is pinned HERE, because a scan cannot press.
 *
 * The risk in this change is the DOOR, not the split: every level row is a real
 * channel members were seeded into, and department conversations are hidden from
 * every messenger list, so the thread must stay reachable. Since B-609 the chat
 * door IS the card's own left region, so G1's separate open button is redundant
 * and removed. ADMIN mode is untouched — its whole card still toggles and its
 * pencil is the door. Both G2 doors are asserted below.
 */
import React from 'react';
import {render, fireEvent} from '@testing-library/react-native';

jest.mock('expo-linear-gradient', () => ({LinearGradient: 'LinearGradient'}));
jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('@op-engineering/op-sqlite', () => ({open: jest.fn()}));
// The row SUBSCRIBES to the encrypted messenger store for its unread pill.
// Mocked to a constant selector result so no store has to be booted here.
jest.mock('@/modules/messenger/store/messengerStore', () => ({
  useMessengerStore: (sel: (s: unknown) => unknown) => sel({conversations: {}}),
}));

import {ChannelTree} from '../ChannelTree';
import {
  buildChannelTree, visibleTreeNodes, hasExpandableChildren,
  type TreeRow, type ChannelTreeNode,
} from '../organisationTree';

const row = (id: string, parent_id: string | null, over: Partial<TreeRow> = {}): TreeRow => ({
  id, name: id.toUpperCase(), parent_id,
  parent_hidden: false, visible_ancestor_id: null, root_id: null,
  is_broadcast: false, is_lateral: false, archived: false, ...over,
});

/** An organisation with one structural child and one lateral hanging off it. */
const ROWS: TreeRow[] = [
  row('sasfa', null, {level: 0}),
  row('rsa', 'sasfa', {level: 1}),
  row('general', 'sasfa', {level: 0, is_lateral: true}),
];
/** A workspace whose only row is a childless organisation — nothing to expand. */
const LEAF_ONLY: TreeRow[] = [row('solo', null, {level: 0})];

function mount(rows: TreeRow[], opts: {
  admin?: boolean; collapsed?: Set<string>; onOpen?: (id: string) => void;
  onToggle?: (id: string) => void; onEdit?: (id: string) => void;
  onAddSubLevel?: (id: string) => void;
  onAddLateral?: (id: string) => void;
  canAddSubLevel?: (node: ChannelTreeNode) => boolean;
} = {}) {
  const nodes = buildChannelTree(rows, {collapseChildless: false});
  const collapsed = opts.collapsed ?? new Set<string>();
  const u = render(
    <ChannelTree
      nodes={visibleTreeNodes(nodes, collapsed)}
      collapsed={collapsed}
      onToggle={id => opts.onToggle?.(id)}
      onOpen={opts.onOpen ? node => opts.onOpen?.(node.row.id) : undefined}
      isExpandable={id => hasExpandableChildren(nodes, id)}
      admin={opts.admin
        ? {
          onEdit: node => opts.onEdit?.(node.row.id),
          onAddSubLevel: opts.onAddSubLevel
            ? node => opts.onAddSubLevel?.(node.row.id)
            : undefined,
          onAddLateral: opts.onAddLateral
            ? node => opts.onAddLateral?.(node.row.id)
            : undefined,
          canAddSubLevel: opts.canAddSubLevel,
        }
        : undefined}
    />,
  );
  return u;
}

describe('G1 (B-609) — the card opens, the chevron toggles', () => {
  /**
   * DOCUMENTS B-609 (FB-1, founder 2026-08-22).
   *
   * ⚠️ THIS REVERSES the 2026-08-19 G1 ("the whole card toggles"), which itself
   * reversed F3. The founder's screenshot ask: tapping anywhere LEFT of the `|`
   * divider — the L# badge, the `#`, the name, the members line — must OPEN the
   * chat; only the chevron (RIGHT of the divider) expands/collapses the branch.
   * Under the old G1 the sole door to the thread was the tiny inner glyph, an
   * unintuitive/near-invisible target.
   *
   * RED-first (the B-143+ regression contract): at HEAD the card TOGGLES and the
   * chevron is hidden, so the two headline assertions below — a CARD press fires
   * onOpen (not onToggle), and the CHEVRON is an EXPOSED toggle — both fail
   * until the fix lands. Mutation-proven by reverting ChannelTree.tsx to HEAD.
   */
  it('THE CARD ITSELF opens the chat — it no longer toggles', () => {
    /**
     * The founder's actual sentence, pinned. Pressed by testID because the card
     * is `accessible={false}` and carries no label — a label query would
     * silently resolve the inner name touchable (the G1 testID trap).
     */
    const onToggle = jest.fn();
    const onOpen = jest.fn();
    const u = mount(ROWS, {onToggle, onOpen});
    fireEvent.press(u.getByTestId('channel-tree-card-sasfa', {includeHiddenElements: true}));
    expect(onOpen).toHaveBeenCalledWith('sasfa');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the NAME area opens too, and announces "Open"', () => {
    // The a11y control for the left region. Same action as the card, so touch
    // and screen reader can never disagree about the left zone.
    const onToggle = jest.fn();
    const onOpen = jest.fn();
    const u = mount(ROWS, {onToggle, onOpen});
    fireEvent.press(u.getByLabelText('Open SASFA, level 1'));
    expect(onOpen).toHaveBeenCalledWith('sasfa');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('THE CHEVRON toggles the branch — and does NOT open the chat', () => {
    // The right-of-divider zone. The two zones cannot cross-fire: a chevron
    // press must never also open, and (asserted above) a card press must never
    // also toggle. No `includeHiddenElements` — the chevron is exposed now.
    const onToggle = jest.fn();
    const onOpen = jest.fn();
    const u = mount(ROWS, {onToggle, onOpen});
    fireEvent.press(u.getByTestId('channel-tree-chevron-sasfa'));
    expect(onToggle).toHaveBeenCalledWith('sasfa');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('the chevron is an EXPOSED, labelled toggle that carries the expanded flag', () => {
    /**
     * Since B-609 the chevron is the ONLY toggle on a member card, so — unlike
     * the admin surface, where it duplicates the whole-card toggle — it must be
     * reachable by a screen reader and voice its state. That it resolves WITHOUT
     * `includeHiddenElements` is the point: it is no longer hidden from
     * accessibility the way the pre-B-609 chevron was.
     */
    const u = mount(ROWS, {collapsed: new Set(['sasfa']), onToggle: jest.fn(), onOpen: jest.fn()});
    const chevron = u.getByTestId('channel-tree-chevron-sasfa');
    expect(chevron.props.accessibilityState).toEqual(expect.objectContaining({expanded: false}));
    // …and a label query resolves it (the toggle voices Expand/Collapse now).
    expect(u.getByLabelText('Expand SASFA, level 1')).toBeTruthy();
  });

  it('…and the card OPENS a row that has nothing to expand', () => {
    const onOpen = jest.fn();
    const u = mount(LEAF_ONLY, {onOpen, onToggle: jest.fn()});
    fireEvent.press(u.getByTestId('channel-tree-card-solo', {includeHiddenElements: true}));
    expect(onOpen).toHaveBeenCalledWith('solo');
  });
});

describe('G2 — no door was lost', () => {
  it('a MEMBER can still open the chat of a level that toggles', () => {
    /**
     * THE REGRESSION THIS FILE EXISTS FOR. Under F3 the row name opened the
     * thread. G1 gave that press to the dropdown, so without a replacement
     * every expandable level's own conversation became unreachable — dept
     * conversations are hidden from every messenger list, so there is no second
     * route to it.
     */
    const onOpen = jest.fn();
    const onToggle = jest.fn();
    const u = mount(ROWS, {onOpen, onToggle});
    fireEvent.press(u.getByLabelText('Open SASFA, level 1'));
    expect(onOpen).toHaveBeenCalledWith('sasfa');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('ADMIN mode does NOT add that button — its pencil already is the door', () => {
    // onEdit and onOpen navigate to the same editor on the admin surface, so a
    // second identical control would be clutter rather than a door.
    const onEdit = jest.fn();
    const u = mount(ROWS, {admin: true, onEdit, onOpen: jest.fn(), onToggle: jest.fn()});
    expect(u.queryByLabelText('Open SASFA, level 1')).toBeNull();
    fireEvent.press(u.getByLabelText('Edit SASFA'));
    expect(onEdit).toHaveBeenCalledWith('sasfa');
  });

  it('a level with NOTHING to expand still opens on the card', () => {
    // There is no dropdown to give it, so taking the open press away would
    // leave an inert card — a door deleted for no gain.
    const onOpen = jest.fn();
    const u = mount(LEAF_ONLY, {onOpen, onToggle: jest.fn()});
    fireEvent.press(u.getByLabelText('Open SOLO, level 1'));
    expect(onOpen).toHaveBeenCalledWith('solo');
  });
});

describe('G3 — a lateral opens on the whole card', () => {
  it('the neutral card is one press to the chat', () => {
    const onOpen = jest.fn();
    const u = mount(ROWS, {onOpen, onToggle: jest.fn()});
    // No tier suffix: a lateral has no level colour and no Ln pill.
    fireEvent.press(u.getByLabelText('Open GENERAL'));
    expect(onOpen).toHaveBeenCalledWith('general');
  });
});

describe('the states that must NOT be pressable', () => {
  it('a row being provisioned is inert — no toggle, no open', () => {
    const onOpen = jest.fn();
    const onToggle = jest.fn();
    const nodes = buildChannelTree(ROWS, {collapseChildless: false});
    const u = render(
      <ChannelTree
        nodes={nodes}
        collapsed={new Set()}
        onToggle={onToggle}
        onOpen={node => onOpen(node.row.id)}
        isExpandable={id => hasExpandableChildren(nodes, id)}
        metaFor={node => ({busy: node.row.id === 'sasfa'})}
      />,
    );
    // `busy` makes it neither toggleable nor openable, so it announces as the
    // open form and refuses the press rather than firing a half-built action.
    fireEvent.press(u.getByLabelText('Open SASFA, level 1'));
    expect(onOpen).not.toHaveBeenCalled();
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('with no onOpen at all, a leaf card does nothing rather than throwing', () => {
    const u = mount(LEAF_ONLY, {onToggle: jest.fn()});
    fireEvent.press(u.getByLabelText('Open SOLO, level 1'));
    // Reaching here without an exception IS the assertion — `onOpen?.` must
    // stay optional-chained now that the card, not the name, calls it.
    expect(u.getByText('SOLO')).toBeTruthy();
  });
});

/**
 * B-590 (founder, 2026-08-20) — the branch line and the per-node add gate.
 *
 * "see the pdf … it has long lines of connected channels … the line thing are
 * not present". PDF §03: "branch lines identify parentage" — a CONTINUOUS
 * line from a level down through everything under it, which the old per-row
 * `└` glyph was not. The line is per-row gutter cells that stretch with their
 * row; what makes the segments join is the cont/last-child distinction pinned
 * here.
 */
describe('B-590 — the branch line and the per-node add gate', () => {
  it('draws an elbow for every nested row and none at the root', () => {
    const u = mount(ROWS, {onToggle: jest.fn(), onOpen: jest.fn()});
    expect(u.getByTestId('channel-tree-elbow-rsa', {includeHiddenElements: true})).toBeTruthy();
    expect(u.getByTestId('channel-tree-elbow-general', {includeHiddenElements: true})).toBeTruthy();
    expect(u.queryByTestId('channel-tree-elbow-sasfa', {includeHiddenElements: true})).toBeNull();
  });

  it('the rail continues below a row with a later sibling and stops at the last', () => {
    // ROWS order under sasfa: rsa then general. rsa has a later sibling, so
    // its column keeps the vertical rail below it; general is last, so the
    // line ends there. This difference is what joins per-row segments into
    // ONE continuous line — remove it and every row draws an isolated `└`,
    // which is exactly the state the founder rejected.
    const u = mount(ROWS, {onToggle: jest.fn(), onOpen: jest.fn()});
    expect(u.getByTestId('channel-tree-elbowcont-rsa', {includeHiddenElements: true})).toBeTruthy();
    expect(u.queryByTestId('channel-tree-elbowcont-general', {includeHiddenElements: true})).toBeNull();
  });

  it('canAddSubLevel=false HIDES the add row instead of leaving a dead button', () => {
    /**
     * The dead button WAS the founder's "I can't go further": the wiring's
     * handler guard could only no-op, and a rendered button that silently does
     * nothing at the depth cap reads as broken. False must remove the row.
     */
    const onAddSubLevel = jest.fn();
    const u = mount(ROWS, {
      admin: true, onEdit: jest.fn(), onToggle: jest.fn(),
      onAddSubLevel, canAddSubLevel: node => node.row.id !== 'rsa',
    });
    expect(u.getByLabelText('Add sub-level in SASFA')).toBeTruthy();
    expect(u.queryByLabelText('Add sub-level in RSA')).toBeNull();
    fireEvent.press(u.getByLabelText('Add sub-level in SASFA'));
    expect(onAddSubLevel).toHaveBeenCalledWith('sasfa');
  });

  it('without the gate every level still shows the add row (back-compat)', () => {
    const u = mount(ROWS, {
      admin: true, onEdit: jest.fn(), onToggle: jest.fn(), onAddSubLevel: jest.fn(),
    });
    expect(u.getByLabelText('Add sub-level in SASFA')).toBeTruthy();
    expect(u.getByLabelText('Add sub-level in RSA')).toBeTruthy();
  });

  it('depth-0 rows keep the 12dp inset the old margin gave them', () => {
    // Review finding: Gutter returned null at depth 0, shifting every root
    // card — and every row of a FLAT workspace, the common shape — to x=0.
    const u = mount(LEAF_ONLY, {onToggle: jest.fn(), onOpen: jest.fn()});
    expect(u.getByTestId('channel-tree-indent-solo', {includeHiddenElements: true})).toBeTruthy();
  });

  it('the rail does not break between the two admin add-rows', () => {
    // A childless level still renders BOTH add-rows (admin default is
    // expanded, so every freshly created level shows them), and the first
    // one's rail must continue into the second — one shared cont flag gapped
    // the founder's continuous line for half a row exactly there.
    const u = mount(LEAF_ONLY, {
      admin: true, onEdit: jest.fn(), onToggle: jest.fn(),
      onAddLateral: jest.fn(), onAddSubLevel: jest.fn(),
    });
    expect(u.getByTestId('channel-tree-elbowcont-solo-add-lateral', {includeHiddenElements: true})).toBeTruthy();
    expect(u.queryByTestId('channel-tree-elbowcont-solo-add-sublevel', {includeHiddenElements: true})).toBeNull();
  });
});
