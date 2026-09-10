/**
 * B-636 — "this search option should allow you to also search for conversations
 * or words in conversations that's inside the chats."
 *
 * The DECISION half. Every test here executes the real function over real data;
 * none of them assert that a line of source exists. That distinction is the
 * B-623 lesson — three realistic mutations survived a green run there because a
 * source scan can only prove a helper is CALLED, never that its answer is used.
 *
 * What must stay pinned, in order of how badly it fails:
 *   1. A hit whose conversation is not in the caller's channel map is DROPPED.
 *      That map is the second belt behind the SQL allow-list, and it is what
 *      keeps one organisation's search off another's messages (B-624).
 *   2. Hits are sectioned by organisation, never flattened.
 *   3. The snippet indexes the string that is RENDERED, so the highlight lands
 *      on the matched word and not two characters left of it.
 */
import {
  MESSAGE_SEARCH_MIN_CHARS,
  buildSnippet,
  channelMessageHits,
  groupHitsByOrg,
  shouldSearchMessages,
  type ChannelRef,
  type SearchableMessage,
} from '@screens/deptchat/channelMessageSearch';

const ORG_A = 'org-aaa';
const ORG_B = 'org-bbb';

function msg(id: string, conversationId: string, content: string, createdAt = '2026-08-20T10:00:00.000Z'): SearchableMessage {
  return {id, conversation_id: conversationId, content, created_at: createdAt};
}

function refs(entries: Array<[string, ChannelRef]>): Map<string, ChannelRef> {
  return new Map(entries);
}

const LEGAL: ChannelRef  = {channelId: 'ch-legal',  channelName: 'Legal',  orgId: ORG_A};
const BOARD: ChannelRef  = {channelId: 'ch-board',  channelName: 'Board',  orgId: ORG_A};
const RIVAL: ChannelRef  = {channelId: 'ch-rival',  channelName: 'Rival',  orgId: ORG_B};

describe('shouldSearchMessages — the body scan has a floor the name filter does not', () => {
  it('refuses a single character', () => {
    expect(shouldSearchMessages('c')).toBe(false);
    expect(shouldSearchMessages('  c  ')).toBe(false);
  });

  it('accepts exactly MESSAGE_SEARCH_MIN_CHARS', () => {
    expect('co'.length).toBe(MESSAGE_SEARCH_MIN_CHARS);
    expect(shouldSearchMessages('co')).toBe(true);
  });

  it('refuses blank and whitespace-only input', () => {
    expect(shouldSearchMessages('')).toBe(false);
    expect(shouldSearchMessages('   ')).toBe(false);
  });
});

describe('buildSnippet — the highlight must land on the matched word', () => {
  it('splits the body into before / match / after around the hit', () => {
    const snip = buildSnippet('please review the contract today', 'contract');
    expect(snip).not.toBeNull();
    expect(snip!.match).toBe('contract');
    expect(snip!.before).toBe('please review the ');
    expect(snip!.after).toBe(' today');
  });

  it('re-joins the three parts into the original text (no character is lost or duplicated)', () => {
    const body = 'please review the contract today';
    const snip = buildSnippet(body, 'contract')!;
    expect(snip.before + snip.match + snip.after).toBe(body);
  });

  it('matches case-insensitively but echoes the ORIGINAL casing', () => {
    const snip = buildSnippet('The CONTRACT is signed', 'contract')!;
    expect(snip.match).toBe('CONTRACT');
  });

  it('collapses newlines FIRST, so the offsets index the rendered line', () => {
    // Without the collapse the raw index would be 4 characters further along
    // than the flattened string the row actually draws, and the highlight would
    // sit on the wrong word.
    const snip = buildSnippet('line one\n\n   line two contract here', 'contract')!;
    expect(snip.before).not.toMatch(/\n/);
    expect(snip.match).toBe('contract');
    expect(snip.before + snip.match + snip.after).toBe('line one line two contract here');
  });

  it('ellipsises only the side it actually truncated', () => {
    const long = `${'a'.repeat(200)} needle ${'b'.repeat(200)}`;
    const snip = buildSnippet(long, 'needle', 8)!;
    expect(snip.before.startsWith('…')).toBe(true);
    expect(snip.after.endsWith('…')).toBe(true);
    expect(snip.match).toBe('needle');
    // Bounded by the radius, not by the body: this is what keeps a 4 000-word
    // message from rendering as a 4 000-word row.
    expect(snip.before.length).toBeLessThanOrEqual(9);
    expect(snip.after.length).toBeLessThanOrEqual(9);
  });

  it('does not ellipsise when the whole body already fits', () => {
    const snip = buildSnippet('hi contract', 'contract', 64)!;
    expect(snip.before).toBe('hi ');
    expect(snip.after).toBe('');
  });

  it('returns null when the term is absent — the row is then dropped, not drawn unhighlighted', () => {
    expect(buildSnippet('nothing relevant here', 'contract')).toBeNull();
  });

  it('returns null for an empty body (a media row, a blanked tombstone)', () => {
    expect(buildSnippet('', 'contract')).toBeNull();
    expect(buildSnippet('   ', 'contract')).toBeNull();
  });

  it('survives a case-fold that changes length instead of slicing at a bogus offset', () => {
    // 'İ' (U+0130) lower-cases to TWO code units, so an index taken from the
    // folded string does not address the original. The fallback is an exact
    // match: narrower, never wrong, and never a RangeError.
    const snip = buildSnippet('İstanbul contract signed', 'contract');
    expect(snip).not.toBeNull();
    expect(snip!.match).toBe('contract');
    expect(snip!.before + snip!.match + snip!.after).toBe('İstanbul contract signed');
  });
});

describe('channelMessageHits — the channel map is a SCOPE, not a decoration', () => {
  it('drops a message whose conversation is not in the map', () => {
    // The SQL layer already restricts by id. This is the second belt: even a
    // leaked row cannot reach the screen, so the organisation separation does
    // not depend on the layer below being correct.
    const out = channelMessageHits(
      [msg('m1', 'conv-legal', 'the contract'), msg('m2', 'conv-foreign', 'the contract')],
      refs([['conv-legal', LEGAL]]),
      'contract',
    );
    expect(out.map(h => h.messageId)).toEqual(['m1']);
  });

  it('returns nothing at all when the map is empty', () => {
    const out = channelMessageHits([msg('m1', 'conv-legal', 'the contract')], refs([]), 'contract');
    expect(out).toEqual([]);
  });

  it('drops a row whose body no longer contains the term', () => {
    // SQL LIKE is ASCII-case-insensitive and locale-blind, so it can answer
    // differently from the client fold. A row the two disagree about is a false
    // positive and must not render.
    const out = channelMessageHits(
      [msg('m1', 'conv-legal', 'unrelated body')],
      refs([['conv-legal', LEGAL]]),
      'contract',
    );
    expect(out).toEqual([]);
  });

  it('carries the channel identity every hit needs to render and to open', () => {
    const [hit] = channelMessageHits(
      [msg('m1', 'conv-legal', 'sign the contract')],
      refs([['conv-legal', LEGAL]]),
      'contract',
    );
    expect(hit.channelId).toBe('ch-legal');
    expect(hit.channelName).toBe('Legal');
    expect(hit.orgId).toBe(ORG_A);
    expect(hit.conversationId).toBe('conv-legal');
    expect(hit.snippet.match).toBe('contract');
  });

  it('respects the cap and keeps the order it was given (the store returns newest-first)', () => {
    const many = Array.from({length: 10}, (_, i) => msg(`m${i}`, 'conv-legal', `contract ${i}`));
    const out = channelMessageHits(many, refs([['conv-legal', LEGAL]]), 'contract', 3);
    expect(out.map(h => h.messageId)).toEqual(['m0', 'm1', 'm2']);
  });

  it('returns nothing below the query floor, even when rows were handed to it', () => {
    const out = channelMessageHits(
      [msg('m1', 'conv-legal', 'c is for contract')],
      refs([['conv-legal', LEGAL]]),
      'c',
    );
    expect(out).toEqual([]);
  });

  it('returns nothing for a non-positive cap', () => {
    expect(channelMessageHits([msg('m1', 'conv-legal', 'contract')], refs([['conv-legal', LEGAL]]), 'contract', 0))
      .toEqual([]);
  });
});

describe('groupHitsByOrg — B-624: organisations must never mix', () => {
  const hits = channelMessageHits(
    [
      msg('m1', 'conv-legal', 'the contract'),
      msg('m2', 'conv-rival', 'their contract'),
      msg('m3', 'conv-board', 'board contract'),
    ],
    refs([['conv-legal', LEGAL], ['conv-rival', RIVAL], ['conv-board', BOARD]]),
    'contract',
  );

  it('splits two organisations into two sections, never one pile', () => {
    const sections = groupHitsByOrg(hits, [ORG_A, ORG_B]);
    expect(sections.map(s => s.orgId)).toEqual([ORG_A, ORG_B]);
    expect(sections[0].hits.map(h => h.messageId)).toEqual(['m1', 'm3']);
    expect(sections[1].hits.map(h => h.messageId)).toEqual(['m2']);
  });

  it('follows the caller-supplied organisation order, not first-seen order', () => {
    const sections = groupHitsByOrg(hits, [ORG_B, ORG_A]);
    expect(sections.map(s => s.orgId)).toEqual([ORG_B, ORG_A]);
  });

  it('never emits an empty section — an org heading with nothing under it reads as broken', () => {
    const sections = groupHitsByOrg(hits, [ORG_A, 'org-with-no-hits', ORG_B]);
    expect(sections.map(s => s.orgId)).toEqual([ORG_A, ORG_B]);
  });

  it('still shows an organisation the caller did not list, rather than hiding a real result', () => {
    const sections = groupHitsByOrg(hits, [ORG_A]);
    expect(sections.map(s => s.orgId)).toEqual([ORG_A, ORG_B]);
  });

  it('keeps unattributed rows (org_id absent on an old server) in their own null section', () => {
    const legacy = channelMessageHits(
      [msg('m9', 'conv-old', 'legacy contract')],
      refs([['conv-old', {channelId: 'ch-old', channelName: 'Old', orgId: null}]]),
      'contract',
    );
    const sections = groupHitsByOrg(legacy, [ORG_A, null]);
    expect(sections).toHaveLength(1);
    expect(sections[0].orgId).toBeNull();
  });

  it('is empty for no hits', () => {
    expect(groupHitsByOrg([], [ORG_A, ORG_B])).toEqual([]);
  });
});
