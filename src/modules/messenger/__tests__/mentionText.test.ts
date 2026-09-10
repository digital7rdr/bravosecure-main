import {
  findMentionQuery,
  filterMentionCandidates,
  insertMention,
  reconcileMentions,
  segmentMentions,
  mentionsUser,
  MENTION_QUERY_MAX,
} from '../runtime/mentionText';

/**
 * The @-mention text engine — ONE rule shared by the composer, the bubble
 * renderer and the notifier.
 *
 * The prefix-collision case ("Ali" vs "Alice") is the reason this is a module
 * and not an inline regex; it is pinned below and must never regress.
 */

const ROSTER = [
  {userId: 'u-alice', label: 'Alice'},
  {userId: 'u-ali',   label: 'Ali'},
  {userId: 'u-bob',   label: 'Bob Rani'},
  {userId: 'u-carol', label: 'Carol'},
];

describe('findMentionQuery — composer trigger', () => {
  it('detects a bare @ at the start', () => {
    expect(findMentionQuery('@')).toEqual({query: '', start: 0});
  });

  it('detects a partial query', () => {
    expect(findMentionQuery('hey @al')).toEqual({query: 'al', start: 4});
  });

  it('does NOT trigger on an email address', () => {
    // The @ must start the message or follow whitespace.
    expect(findMentionQuery('mail me at bob@example.com')).toBeNull();
  });

  it('triggers after a newline (whitespace)', () => {
    expect(findMentionQuery('line one\n@al')).toEqual({query: 'al', start: 9});
  });

  it('a newline between the @ and the caret ends the token', () => {
    expect(findMentionQuery('@alice\nnext line')).toBeNull();
  });

  it('allows spaces inside the query — display names have them', () => {
    expect(findMentionQuery('hi @Bob R')).toEqual({query: 'Bob R', start: 3});
  });

  it('a query ending in whitespace is CLOSED', () => {
    // Without this the space insertMention appends makes the just-completed
    // "@Alice " look live and the picker re-opens on every insertion.
    expect(findMentionQuery('@Alice ')).toBeNull();
  });

  it('DOCUMENTS THE TRADE: a half-typed two-word name hides the picker for one keystroke', () => {
    // "@Bob " closes; the very next character brings it back with the right
    // filter. Accepted deliberately — the alternative is a picker that never
    // closes after an insertion.
    expect(findMentionQuery('@Bob ')).toBeNull();
    expect(findMentionQuery('@Bob R')).toEqual({query: 'Bob R', start: 0});
  });

  it('stops searching past the cap so a long paragraph does not re-filter the roster', () => {
    const long = '@' + 'x'.repeat(MENTION_QUERY_MAX + 1);
    expect(findMentionQuery(long)).toBeNull();
    expect(findMentionQuery('@' + 'x'.repeat(MENTION_QUERY_MAX))).not.toBeNull();
  });

  it('honours an explicit caret rather than always using the end', () => {
    // Caret parked right after "@al" in "@al world".
    expect(findMentionQuery('@al world', 3)).toEqual({query: 'al', start: 0});
  });

  it('returns null for text with no @ at all', () => {
    expect(findMentionQuery('nothing here')).toBeNull();
  });

  it('picks the NEAREST @ when there are two', () => {
    expect(findMentionQuery('@alice hi @bo')).toEqual({query: 'bo', start: 10});
  });
});

describe('filterMentionCandidates', () => {
  it('returns everything for an empty query', () => {
    expect(filterMentionCandidates(ROSTER, '')).toHaveLength(4);
  });

  it('ranks prefix matches above infix matches', () => {
    const out = filterMentionCandidates(ROSTER, 'ra');
    // "Bob Rani" contains "ra"; nothing starts with it.
    expect(out.map(c => c.userId)).toEqual(['u-bob']);
  });

  it('is case-insensitive', () => {
    expect(filterMentionCandidates(ROSTER, 'ALI').map(c => c.userId))
      .toEqual(['u-alice', 'u-ali']);
  });

  it('respects the limit', () => {
    expect(filterMentionCandidates(ROSTER, '', 2)).toHaveLength(2);
  });
});

describe('insertMention', () => {
  it('replaces the token and appends a trailing space', () => {
    const out = insertMention('hey @al', {start: 4, query: 'al'}, ROSTER[0]);
    expect(out.text).toBe('hey @Alice ');
    expect(out.caret).toBe(11);
  });

  it('preserves text AFTER the token', () => {
    const out = insertMention('hey @al how are you', {start: 4, query: 'al'}, ROSTER[0]);
    expect(out.text).toBe('hey @Alice  how are you');
  });

  it('the trailing space stops the picker immediately re-opening', () => {
    const out = insertMention('@al', {start: 0, query: 'al'}, ROSTER[0]);
    expect(findMentionQuery(out.text, out.caret)).toBeNull();
  });
});

describe('reconcileMentions', () => {
  it('keeps a mention whose label is still in the body', () => {
    expect(reconcileMentions('hi @Alice', [{userId: 'u-alice', label: 'Alice'}]))
      .toEqual([{userId: 'u-alice', label: 'Alice'}]);
  });

  it('DROPS a mention the user deleted by hand', () => {
    // Otherwise they get a "you were mentioned" push for a message that does
    // not name them.
    expect(reconcileMentions('hi there', [{userId: 'u-alice', label: 'Alice'}])).toEqual([]);
  });

  it('de-duplicates the same user mentioned twice', () => {
    const out = reconcileMentions('@Alice and @Alice', [
      {userId: 'u-alice', label: 'Alice'},
      {userId: 'u-alice', label: 'Alice'},
    ]);
    expect(out).toHaveLength(1);
  });

  it('drops an empty label', () => {
    expect(reconcileMentions('hi', [{userId: 'u-x', label: ''}])).toEqual([]);
  });
});

describe('segmentMentions — the renderer split', () => {
  const M = [{userId: 'u-alice', label: 'Alice'}];

  it('returns ONE text segment when there is nothing to highlight', () => {
    expect(segmentMentions('plain body', undefined)).toEqual([{kind: 'text', text: 'plain body'}]);
    expect(segmentMentions('plain body', [])).toEqual([{kind: 'text', text: 'plain body'}]);
  });

  it('splits leading text, the mention, and trailing text', () => {
    expect(segmentMentions('hey @Alice how are you', M)).toEqual([
      {kind: 'text', text: 'hey '},
      {kind: 'mention', text: '@Alice', userId: 'u-alice', isSelf: false},
      {kind: 'text', text: ' how are you'},
    ]);
  });

  it('handles a mention at the very start and very end', () => {
    expect(segmentMentions('@Alice', M)).toEqual([
      {kind: 'mention', text: '@Alice', userId: 'u-alice', isSelf: false},
    ]);
    expect(segmentMentions('ping @Alice', M)).toEqual([
      {kind: 'text', text: 'ping '},
      {kind: 'mention', text: '@Alice', userId: 'u-alice', isSelf: false},
    ]);
  });

  it('highlights the SAME user mentioned twice', () => {
    const segs = segmentMentions('@Alice and @Alice', M);
    expect(segs.filter(s => s.kind === 'mention')).toHaveLength(2);
  });

  it('PREFIX COLLISION: "Ali" must not swallow "@Alice"', () => {
    // The bug this module exists to prevent. Sorted longest-first, "@Alice"
    // wins and "ce" is never orphaned into a text segment.
    const both = [{userId: 'u-ali', label: 'Ali'}, {userId: 'u-alice', label: 'Alice'}];
    expect(segmentMentions('@Alice', both)).toEqual([
      {kind: 'mention', text: '@Alice', userId: 'u-alice', isSelf: false},
    ]);
  });

  it('still matches the SHORTER label when that is what the body holds', () => {
    const both = [{userId: 'u-ali', label: 'Ali'}, {userId: 'u-alice', label: 'Alice'}];
    expect(segmentMentions('@Ali', both)).toEqual([
      {kind: 'mention', text: '@Ali', userId: 'u-ali', isSelf: false},
    ]);
  });

  it('marks isSelf for the viewing user', () => {
    const segs = segmentMentions('@Alice', M, 'u-alice');
    expect(segs[0]).toMatchObject({kind: 'mention', isSelf: true});
  });

  it('ignores an @ that does not match any known label', () => {
    expect(segmentMentions('email me at a@b.com', M))
      .toEqual([{kind: 'text', text: 'email me at a@b.com'}]);
  });

  it('handles a multi-word label', () => {
    expect(segmentMentions('hi @Bob Rani ok', [{userId: 'u-bob', label: 'Bob Rani'}])).toEqual([
      {kind: 'text', text: 'hi '},
      {kind: 'mention', text: '@Bob Rani', userId: 'u-bob', isSelf: false},
      {kind: 'text', text: ' ok'},
    ]);
  });

  it('returns an empty list for an empty body', () => {
    expect(segmentMentions('', M)).toEqual([]);
  });

  it('reassembles to exactly the original body — no character is lost or duplicated', () => {
    const body = 'a @Alice b @Ali c a@b.com @Alice';
    const both = [{userId: 'u-ali', label: 'Ali'}, {userId: 'u-alice', label: 'Alice'}];
    expect(segmentMentions(body, both).map(s => s.text).join('')).toBe(body);
  });
});

describe('mentionsUser', () => {
  it('is true when the user is in the list', () => {
    expect(mentionsUser([{userId: 'u-a', label: 'A'}], 'u-a')).toBe(true);
  });

  it('is false for absent, empty, or unknown-user inputs', () => {
    expect(mentionsUser([{userId: 'u-a', label: 'A'}], 'u-b')).toBe(false);
    expect(mentionsUser(undefined, 'u-a')).toBe(false);
    expect(mentionsUser([], 'u-a')).toBe(false);
    expect(mentionsUser([{userId: 'u-a', label: 'A'}], null)).toBe(false);
  });
});
