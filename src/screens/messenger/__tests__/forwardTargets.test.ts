/**
 * Founder 2026-08-24 — the forward/share picker reaches the whole contact
 * directory ("it's only picking up my last 2 chats") and gains a search box.
 * Pure decisions; `ForwardList` renders these answers.
 */
import {
  bucketConversations,
  contactsWithoutConversation,
  matchesForwardQuery,
} from '../forwardTargets';

const conv = (id: string, over: Record<string, unknown> = {}) =>
  ({id, type: 'direct', name: `Chat ${id}`, peer: {userId: `peer-${id}`}, ...over});

const contact = (userId: string, localName: string, displayName = localName) =>
  ({userId, localName, displayName});

describe('contactsWithoutConversation — the union half', () => {
  it('offers a contact with NO existing chat (the reported gap)', () => {
    const out = contactsWithoutConversation(
      [contact('u9', 'Aunty Nadia')],
      [conv('a'), conv('b')],           // the "last 2 chats"
      'me',
      '',
    );
    expect(out.map(c => c.userId)).toEqual(['u9']);
  });

  it('dedupes against an existing 1:1 — the conversation row wins', () => {
    const out = contactsWithoutConversation(
      [contact('peer-a', 'Already Chatting'), contact('u9', 'New Person')],
      [conv('a')],
      'me',
      '',
    );
    expect(out.map(c => c.userId)).toEqual(['u9']);
  });

  it('never offers the user themself, and a GROUP row hides nobody', () => {
    const out = contactsWithoutConversation(
      [contact('me', 'Me Myself'), contact('u1', 'Ana')],
      [conv('g1', {type: 'group', peer: {userId: 'u1'}})], // group peer must NOT count as known
      'me',
      '',
    );
    expect(out.map(c => c.userId)).toEqual(['u1']);
  });

  it('sorts by the SHOWN name — localName beats displayName', () => {
    const out = contactsWithoutConversation(
      [contact('u1', 'Zed', 'Aaron'), contact('u2', 'Bea')],
      [], 'me', '',
    );
    expect(out.map(c => c.localName)).toEqual(['Bea', 'Zed']);
  });
});

describe('the search box', () => {
  it('filters every section by name, case-folded, and empty matches all', () => {
    expect(matchesForwardQuery('Jacques BRAVO', 'jacq')).toBe(true);
    expect(matchesForwardQuery('Jacques BRAVO', 'BAINE')).toBe(false);
    expect(matchesForwardQuery('anything', '   ')).toBe(true);

    const {individuals, groups} = bucketConversations(
      [conv('a', {name: 'Jacques BRAVO'}), conv('g', {type: 'group', name: 'Advisory Group'})],
      'advis',
    );
    expect(individuals).toHaveLength(0);
    expect(groups.map(g => g.id)).toEqual(['g']);
  });

  it('a 1:1 with no name falls back to the peer id for matching', () => {
    const {individuals} = bucketConversations(
      [conv('a', {name: null, peer: {userId: 'aeb2e71e'}})],
      'aeb2',
    );
    expect(individuals.map(c => c.id)).toEqual(['a']);
  });
});
