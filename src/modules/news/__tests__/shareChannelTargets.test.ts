/**
 * Client ask 2026-08-22 — share a news story into a WORKSPACE CHANNEL.
 *
 * The picker shows workspace names; drilling into one lists that workspace's
 * channels. This file pins the pure half: the grouping and, above all, WHICH
 * ROWS MAY RECEIVE A POST.
 *
 * That second half is security, not layout. `ForwardList` excludes department
 * channels outright (F7) precisely because it cannot evaluate the caller's
 * channel role; this new door may only exist because every row it offers has
 * been evaluated. The predicate must therefore be exactly the one the channel
 * screen enforces — `my_role === 'admin'` — and never a re-derivation from
 * `post_mode`, which would be a second copy of a rule the server already folded
 * into the role it hands back (`memberRoleFor`).
 */
import type {DepartmentChannelDto} from '@services/api';
import {
  shareWorkspaceGroups, canPostToChannel, allowShareToChannel, treeGuides,
  LOOSE_GROUP_ID, LOOSE_GROUP_NAME,
} from '../shareChannelTargets';

/** A member-source DTO. Defaults describe an ordinary postable chat channel. */
function ch(over: Partial<DepartmentChannelDto> & {id: string; name: string}): DepartmentChannelDto {
  return {
    description: null,
    department: null,
    group_conversation_id: `g-${over.id}`,
    unread_count: 0,
    my_role: 'admin',
    parent_id: null,
    parent_hidden: false,
    visible_ancestor_id: null,
    root_id: over.id,
    ...over,
  } as DepartmentChannelDto;
}

const namesOf = (g: {channels: Array<{name: string}>}) => g.channels.map(c => c.name);

describe('canPostToChannel — the ONE predicate', () => {
  it('is admin-only, and says nothing about post_mode', () => {
    expect(canPostToChannel({my_role: 'admin'})).toBe(true);
    expect(canPostToChannel({my_role: 'viewer'})).toBe(false);
  });

  it('fails CLOSED on an absent or unknown role', () => {
    // An old server, a partial row, a hand-built response: none of these may
    // read as permission. The generic picker's whole reason for excluding
    // channels was that it could not answer this question.
    expect(canPostToChannel({})).toBe(false);
    expect(canPostToChannel(null)).toBe(false);
    expect(canPostToChannel(undefined)).toBe(false);
    expect(canPostToChannel({my_role: 'ADMIN'})).toBe(false);
  });
});

describe('allowShareToChannel — the SEND-time decision', () => {
  it('OBEYS the server: a "viewer" answer refuses even though the list said postable', () => {
    // The mutation this exists to kill (review 2026-08-22): `|| cachedPostable`
    // in the caller would leave every ordering assertion green while making the
    // round-trip a no-op. A role revoked after the sheet opened must refuse.
    expect(allowShareToChannel({cachedPostable: true, server: {my_role: 'viewer'}})).toBe(false);
  });

  it('obeys the server the OTHER way too — a fresh "admin" beats a stale false', () => {
    expect(allowShareToChannel({cachedPostable: false, server: {my_role: 'admin'}})).toBe(true);
  });

  it('falls back to the cached role ONLY when the server could not be asked', () => {
    // `server: null` means a transport failure, not an answer — the same
    // fallback DepartmentChatScreen.send() makes rather than blocking a
    // legitimate post with no network.
    expect(allowShareToChannel({cachedPostable: true, server: null})).toBe(true);
    expect(allowShareToChannel({cachedPostable: false, server: null})).toBe(false);
  });

  it('an ANSWER with no role in it is still an answer, and refuses', () => {
    expect(allowShareToChannel({cachedPostable: true, server: {}})).toBe(false);
  });
});

describe('treeGuides — the branch lines, derived from the depth sequence', () => {
  // The shape under test (depths on the right):
  //   Org            0
  //   ├─ Ops         1
  //   │   └─ Night   2
  //   └─ Admin       1     <- last child, so column 0's rail must STOP here
  const SHAPE = [0, 1, 2, 1];

  it('gives each row one column per ancestor', () => {
    expect(treeGuides(SHAPE).map(cells => cells.length)).toEqual([0, 1, 2, 1]);
  });

  it('puts the elbow on the LAST column — the join into this row', () => {
    const guides = treeGuides(SHAPE);
    expect(guides[1]).toEqual([{elbow: true, cont: true}]);          // Ops: Admin follows
    expect(guides[3]).toEqual([{elbow: true, cont: false}]);         // Admin: nothing follows
  });

  it('continues an ancestor rail only while that ancestor has another child below', () => {
    // Night is under Ops (col 1) and Org (col 0). Org still has Admin below, so
    // column 0 keeps its rail; Ops has no further child, so column 1 stops.
    expect(treeGuides(SHAPE)[2]).toEqual([
      {elbow: false, cont: true},
      {elbow: true, cont: false},
    ]);
  });

  it('a flat list draws no lines at all', () => {
    expect(treeGuides([0, 0, 0])).toEqual([[], [], []]);
  });

  it('is total and side-effect free — one cell array per input row, empty in, empty out', () => {
    expect(treeGuides([])).toEqual([]);
    const deep = [0, 1, 2, 3, 2, 1];
    expect(treeGuides(deep)).toHaveLength(deep.length);
  });
});

describe('shareWorkspaceGroups — workspaces at level 1, their channels at level 2', () => {
  const rows = [
    ch({id: 'org', name: 'Bravo Advisors', level: 0}),
    ch({id: 'ops', name: 'Operations', parent_id: 'org', level: 1, root_id: 'org'}),
    ch({id: 'nightshift', name: 'Night Shift', parent_id: 'ops', level: 2, root_id: 'org'}),
  ];

  it('names the group after the organisation root and lists its whole subtree', () => {
    const [g] = shareWorkspaceGroups(rows);
    expect(g.name).toBe('Bravo Advisors');
    expect(g.id).toBe('org');
    // Depth-first, tree order, root included — it is a target too.
    expect(namesOf(g)).toEqual(['Bravo Advisors', 'Operations', 'Night Shift']);
    expect(g.channels.map(c => c.depth)).toEqual([0, 1, 2]);
  });

  it('reports how many rows can actually receive a share', () => {
    const mixed = [
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'a', name: 'Open', parent_id: 'org', root_id: 'org'}),
      ch({id: 'b', name: 'Broadcast', parent_id: 'org', root_id: 'org', my_role: 'viewer'}),
    ];
    const [g] = shareWorkspaceGroups(mixed);
    expect(g.channels).toHaveLength(3);
    expect(g.postableCount).toBe(2); // the root + Open; not Broadcast
  });

  it('carries the group conversation id, which is what the send actually needs', () => {
    const [g] = shareWorkspaceGroups(rows);
    expect(g.channels.find(c => c.name === 'Operations')?.groupConversationId).toBe('g-ops');
  });
});

describe('the blocked rows — shown, but never postable', () => {
  it('a viewer row is blocked as read_only', () => {
    const [g] = shareWorkspaceGroups([
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'b', name: 'Announcements', parent_id: 'org', root_id: 'org', my_role: 'viewer'}),
    ]);
    const row = g.channels.find(c => c.name === 'Announcements');
    expect(row).toMatchObject({postable: false, blockedReason: 'read_only'});
  });

  it('a channel with no Signal group yet is not_active — even for an admin', () => {
    // There is nowhere to send. Calling this "read-only" would be a reason we
    // know to be false, and the admin would think their rights were removed.
    const [g] = shareWorkspaceGroups([
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'n', name: 'Brand New', parent_id: 'org', root_id: 'org', group_conversation_id: null}),
    ]);
    const row = g.channels.find(c => c.name === 'Brand New');
    expect(row).toMatchObject({postable: false, blockedReason: 'not_active', groupConversationId: null});
  });

  it('not_active wins over read_only when both are true', () => {
    const [g] = shareWorkspaceGroups([
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'n', name: 'Neither', parent_id: 'org', root_id: 'org',
        group_conversation_id: null, my_role: 'viewer'}),
    ]);
    expect(g.channels.find(c => c.name === 'Neither')?.blockedReason).toBe('not_active');
  });

  it('every offered row is EITHER postable OR carries a reason — never silently neither', () => {
    const [g] = shareWorkspaceGroups([
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'a', name: 'A', parent_id: 'org', root_id: 'org'}),
      ch({id: 'b', name: 'B', parent_id: 'org', root_id: 'org', my_role: 'viewer'}),
      ch({id: 'c', name: 'C', parent_id: 'org', root_id: 'org', group_conversation_id: null}),
    ]);
    for (const c of g.channels) {
      expect(c.postable).toBe(c.blockedReason === null);
    }
  });
});

describe('broadcast / announcement channels sit UNDER their workspace', () => {
  it('a parented #broadcast is drilled into with its workspace, not stranded elsewhere', () => {
    // Without `nestParentedBroadcasts`, `placeRow` classifies every broadcast as
    // its own kind, `subtreeOf` never emits one, and a workspace's announcements
    // channel lands in "Other channels" — so the owner taps their workspace and
    // the channel they most want to post a story into is simply not there.
    const groups = shareWorkspaceGroups([
      ch({id: 'org', name: 'Bravo Advisors', level: 0}),
      ch({id: 'ops', name: 'Operations', parent_id: 'org', root_id: 'org'}),
      ch({id: 'ann', name: 'Announcements', parent_id: 'org', root_id: 'org',
        is_broadcast: true, is_lateral: true}),
    ]);
    const advisors = groups.find(g => g.name === 'Bravo Advisors');
    expect(namesOf(advisors!)).toContain('Announcements');
    expect(groups.find(g => g.id === LOOSE_GROUP_ID)).toBeUndefined();
  });

  it('an admin of a broadcast channel may share into it; a viewer may not', () => {
    const groups = shareWorkspaceGroups([
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'a', name: 'Admin Of', parent_id: 'org', root_id: 'org', is_broadcast: true, is_lateral: true}),
      ch({id: 'v', name: 'Viewer Of', parent_id: 'org', root_id: 'org', is_broadcast: true,
        is_lateral: true, my_role: 'viewer'}),
    ]);
    const org = groups.find(g => g.name === 'Org')!;
    expect(org.channels.find(c => c.name === 'Admin Of')?.postable).toBe(true);
    expect(org.channels.find(c => c.name === 'Viewer Of')).toMatchObject({
      postable: false, blockedReason: 'read_only',
    });
  });
});

describe('totality — no channel the user has is unreachable in the picker', () => {
  it('sweeps rows that belong to no visible organisation into "Other channels"', () => {
    // A member of a hidden-rooted organisation: the server masked parent_id, so
    // this row has no visible ancestor. Dropping it would remove a channel the
    // member posts in daily from the picker, with no explanation.
    const groups = shareWorkspaceGroups([
      ch({id: 'org', name: 'Visible Org', level: 0}),
      ch({id: 'kid', name: 'Under It', parent_id: 'org', root_id: 'org'}),
      ch({id: 'orphan', name: 'Hidden Parent', parent_id: null, parent_hidden: true,
        visible_ancestor_id: null, root_id: 'unseen-root'}),
    ]);
    const loose = groups.find(g => g.id === LOOSE_GROUP_ID);
    expect(loose?.name).toBe(LOOSE_GROUP_NAME);
    expect(namesOf(loose!)).toContain('Hidden Parent');
  });

  it('every input channel appears in EXACTLY ONE group', () => {
    const input = [
      ch({id: 'org', name: 'Org', level: 0}),
      ch({id: 'a', name: 'A', parent_id: 'org', root_id: 'org'}),
      ch({id: 'b', name: 'B', parent_id: 'a', root_id: 'org'}),
      ch({id: 'orphan', name: 'Orphan', parent_hidden: true, root_id: 'gone'}),
      ch({id: 'solo', name: 'Solo Chat'}),
    ];
    const seen = shareWorkspaceGroups(input).flatMap(g => g.channels.map(c => c.channelId));
    expect(seen.sort()).toEqual(input.map(c => c.id).sort());
    expect(new Set(seen).size).toBe(seen.length); // no duplicates
  });

  it('an empty channel list yields no groups (the section simply does not render)', () => {
    expect(shareWorkspaceGroups([])).toEqual([]);
  });
});
