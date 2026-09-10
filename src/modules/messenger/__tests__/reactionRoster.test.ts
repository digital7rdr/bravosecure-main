/**
 * B-282 — founder: "who gave emoji to a message, I mean react — we can't see who,
 * we should be able to."
 *
 * Nothing was missing from the wire or the store. `LocalMessage.reactions` is
 * `Record<reactorUserId, emoji>` (`{'u-alice': '❤️', 'u-bob': '😂'}`), so the
 * client has always known who reacted. The loss was at render: `groupReactions`
 * read `who` and threw it away, returning only `{emoji, count, mine}`. So this is
 * a display fix, not a protocol change — no sealed-sender or envelope work.
 *
 * These are real unit tests, not a source scan: both helpers are exported pure
 * functions, so the node project can import them.
 */
import {groupReactions, reactionRoster, reactionsA11yLabel} from '@screens/messenger/reactionRoster';

const REACTIONS = {
  'u-alice': '❤️',
  'u-bob':   '😂',
  'self':    '❤️',
  'u-carol': '❤️',
};

describe('B-282 — groupReactions keeps the reactors', () => {
  it('THE REGRESSION: each group carries the userIds that made it', () => {
    const hearts = groupReactions(REACTIONS).find(g => g.emoji === '❤️');
    expect(hearts).toBeDefined();
    expect(hearts!.count).toBe(3);
    expect(hearts!.who).toEqual(['u-alice', 'self', 'u-carol']);
  });

  it('still reports count and `mine` exactly as before', () => {
    // The chip UI reads these; changing them would silently restyle every chip.
    const groups = groupReactions(REACTIONS);
    expect(groups.map(g => [g.emoji, g.count, g.mine])).toEqual([
      ['❤️', 3, true],
      ['😂', 1, false],
    ]);
  });

  it('`mine` is true only when the SELF key is present', () => {
    expect(groupReactions({'u-bob': '👍'}).every(g => !g.mine)).toBe(true);
    expect(groupReactions({self: '👍'})[0].mine).toBe(true);
  });

  it('an empty map yields no groups', () => {
    expect(groupReactions({})).toEqual([]);
  });
});

describe('B-282 — reactionRoster', () => {
  const names: Record<string, string> = {'u-alice': 'Alice Rahman', 'u-bob': 'Bob'};
  const resolve = (id: string) => names[id];

  it('lists every reactor with the emoji they gave', () => {
    const rows = reactionRoster(REACTIONS, resolve);
    expect(rows).toHaveLength(4);
    expect(rows.find(r => r.userId === 'u-bob')).toMatchObject({label: 'Bob', emoji: '😂'});
  });

  it('puts YOUR reaction first and labels it "You"', () => {
    const rows = reactionRoster(REACTIONS, resolve);
    expect(rows[0].isSelf).toBe(true);
    expect(rows[0].label).toBe('You');
  });

  it('never renders undefined for an unknown reactor', () => {
    // A member who left, or a roster that has not hydrated. Showing a truncated
    // id beats "undefined" (DESIGN_REVIEW_LOOP §3.5 missing-field rule).
    const rows = reactionRoster({'u-deadbeefcafe': '🔥'}, () => undefined);
    expect(rows[0].label).not.toContain('undefined');
    expect(rows[0].label).toBe('u-deadbe…');   // slice(0, 8) + ellipsis
  });

  it('an unknown reactor is detectable so the caller can batch a name lookup', () => {
    // The screen keys its ONE directory request off the trailing ellipsis; if the
    // fallback shape changes, that batching silently stops happening.
    const rows = reactionRoster({'u-deadbeefcafe': '🔥'}, () => undefined);
    expect(rows[0].label.endsWith('…')).toBe(true);
  });

  it('a resolved name is preferred over the id fallback', () => {
    const rows = reactionRoster({'u-alice': '❤️'}, resolve);
    expect(rows[0].label).toBe('Alice Rahman');
  });

  it('is stable — same input, same order', () => {
    expect(reactionRoster(REACTIONS, resolve)).toEqual(reactionRoster(REACTIONS, resolve));
  });

  it('handles an empty map', () => {
    expect(reactionRoster({}, resolve)).toEqual([]);
  });
});

describe('B-282 — the reaction row announces itself', () => {
  it('says how many and what tapping does', () => {
    // The row is a button made of bare emoji glyphs; without a label a screen
    // reader announces nothing actionable.
    expect(reactionsA11yLabel(REACTIONS)).toBe('4 reactions. Tap to see who reacted.');
  });

  it('singular for one', () => {
    expect(reactionsA11yLabel({self: '❤️'})).toBe('1 reaction. Tap to see who reacted.');
  });
});
