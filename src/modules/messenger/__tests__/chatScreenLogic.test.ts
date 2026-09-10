import {
  resolvePeer, groupFanoutPeers, chatStatusLabel, isLoopbackMode, typingLabel,
  previewForReply,
} from '../ui/chatScreenLogic';
import type {LocalMessage} from '../store/types';

/**
 * First tests ChatScreenInner has ever had.
 *
 * The component is 1,666 lines and needs native modules to render, so these four
 * rules were unreachable by any test while they lived inside its `useMemo`
 * bodies. Lifting them out is the cheapest route to covering it at all.
 */

describe('resolvePeer', () => {
  it('prefers the conversation row peer', () => {
    expect(resolvePeer({peer: {userId: 'u1', deviceId: 2}}, 'direct:other'))
      .toEqual({userId: 'u1', deviceId: 2});
  });

  it('recovers the peer from a synthetic direct: id when no row exists yet', () => {
    // NewChat / push tap / incoming call all open a thread before any
    // conversation row exists. Without this the composer has nobody to send to
    // on exactly the entry points where a FIRST message is most likely.
    expect(resolvePeer(undefined, 'direct:bob-123')).toEqual({userId: 'bob-123', deviceId: 1});
  });

  it('slices on the prefix length, not a magic number', () => {
    // The original inlined `.slice(7)`. It happens to equal 'direct:'.length,
    // but a hard-coded 7 silently truncates the id if the prefix ever changes.
    expect(resolvePeer(undefined, 'direct:x')?.userId).toBe('x');
  });

  it('returns undefined for a group id', () => {
    expect(resolvePeer({participants: ['a', 'b']}, 'group-uuid')).toBeUndefined();
  });
});

describe('groupFanoutPeers', () => {
  it('is every participant except self', () => {
    const peers = groupFanoutPeers({participants: ['me', 'a', 'b']}, true, 'me');
    expect(peers.map(p => p.userId)).toEqual(['a', 'b']);
  });

  it("filters the literal 'self' sentinel as well as the real own id", () => {
    // Not redundant: 'self' is a sentinel that appears in participant lists from
    // some server rows. Leaking it produces a presence subscribe for a user id
    // that cannot exist.
    const peers = groupFanoutPeers({participants: ['self', 'me', 'a']}, true, 'me');
    expect(peers.map(p => p.userId)).toEqual(['a']);
  });

  it('collapses to [peer] for a 1:1', () => {
    const peers = groupFanoutPeers({peer: {userId: 'bob', deviceId: 1}}, false, 'me');
    expect(peers).toEqual([{userId: 'bob', deviceId: 1}]);
  });

  it('is empty with no conversation, and empty for a 1:1 with no peer', () => {
    expect(groupFanoutPeers(undefined, false, 'me')).toEqual([]);
    expect(groupFanoutPeers({}, false, 'me')).toEqual([]);
  });

  it('is empty for a group of one — nobody to fan out to', () => {
    expect(groupFanoutPeers({participants: ['me']}, true, 'me')).toEqual([]);
  });
});

describe('chatStatusLabel', () => {
  it('error outranks everything', () => {
    expect(chatStatusLabel({error: 'boom', ready: false, mode: 'loopback-memory'}))
      .toBe('Error: boom');
  });

  it('not-ready outranks loopback', () => {
    expect(chatStatusLabel({ready: false, mode: 'loopback-memory'}))
      .toBe('Initializing secure session…');
  });

  it('shows the loopback warning when ready in a loopback runtime', () => {
    expect(chatStatusLabel({ready: true, mode: 'loopback-sqlcipher'}))
      .toMatch(/LOOPBACK MODE/);
  });

  it('is silent in a healthy production runtime', () => {
    expect(chatStatusLabel({ready: true, mode: 'production'})).toBeNull();
  });
});

describe('isLoopbackMode', () => {
  it('covers both loopback runtimes and nothing else', () => {
    expect(isLoopbackMode('loopback-memory')).toBe(true);
    expect(isLoopbackMode('loopback-sqlcipher')).toBe(true);
    expect(isLoopbackMode('production')).toBe(false);
    expect(isLoopbackMode(undefined)).toBe(false);
  });
});

describe('typingLabel (B-117)', () => {
  const base = {
    isGroup: true,
    groupMemberNames: undefined,
    directoryNames: undefined,
    directThreadName: () => undefined,
  };

  it('is undefined when nobody is typing', () => {
    expect(typingLabel({...base, typingUserIds: {}})).toBeUndefined();
    expect(typingLabel({...base, typingUserIds: undefined})).toBeUndefined();
  });

  it('is undefined for a 1:1 — the header already names the peer', () => {
    expect(typingLabel({...base, isGroup: false, typingUserIds: {a: 1}})).toBeUndefined();
  });

  it('names one typist', () => {
    expect(typingLabel({
      ...base, typingUserIds: {u1: 1}, directoryNames: {u1: 'Alina'},
    })).toBe('Alina is typing');
  });

  it('joins two with "and"', () => {
    expect(typingLabel({
      ...base, typingUserIds: {u1: 1, u2: 1}, directoryNames: {u1: 'Alina', u2: 'Bo'},
    })).toBe('Alina and Bo are typing');
  });

  it('summarises three or more', () => {
    expect(typingLabel({
      ...base, typingUserIds: {u1: 1, u2: 1, u3: 1}, directoryNames: {u1: 'Alina'},
    })).toBe('Alina +2 are typing');
  });

  it('B-115 name precedence: group override > directory > direct thread > id', () => {
    const ids = {u1: 1};
    expect(typingLabel({
      ...base, typingUserIds: ids,
      groupMemberNames: {u1: 'Override'}, directoryNames: {u1: 'Directory'},
      directThreadName: () => 'Thread',
    })).toBe('Override is typing');

    expect(typingLabel({
      ...base, typingUserIds: ids,
      directoryNames: {u1: 'Directory'}, directThreadName: () => 'Thread',
    })).toBe('Directory is typing');

    expect(typingLabel({
      ...base, typingUserIds: ids, directThreadName: () => 'Thread',
    })).toBe('Thread is typing');
  });

  it('falls back to an id fragment rather than "undefined is typing"', () => {
    expect(typingLabel({...base, typingUserIds: {'abcdefgh-ijkl': 1}}))
      .toBe('abcdefgh is typing');
  });
});

describe('previewForReply', () => {
  const msg = (over: Partial<LocalMessage>): LocalMessage =>
    ({type: 'text', content: '', ...over} as LocalMessage);

  it('labels a photo and a generic attachment', () => {
    expect(previewForReply(msg({type: 'image'}))).toBe('📷 Photo');
    expect(previewForReply(msg({type: 'file'}))).toBe('📎 Attachment');
  });

  it('a voice note quotes a label, never an empty string', () => {
    // content is empty for media rows; the old text fallback yielded ''.
    // The label mirrors MessengerHomeScreen's conversation-list preview.
    expect(previewForReply(msg({type: 'audio'}))).toBe('🎤 Voice message');
  });

  it('a video quotes a label, never an empty string', () => {
    expect(previewForReply(msg({type: 'video'}))).toBe('🎬 Video');
  });

  it('a tombstone degrades to the deleted label, never stale content', () => {
    // The reply affordance is hidden for deleted_for_all rows; this is the
    // defensive backstop, and it must beat every type branch.
    expect(previewForReply(msg({content: 'secret', deleted_for_all: true})))
      .toBe('Message deleted');
    expect(previewForReply(msg({type: 'image', deleted_for_all: true})))
      .toBe('Message deleted');
  });

  it('text: collapses whitespace and caps at 200 chars', () => {
    expect(previewForReply(msg({content: 'a\n b\t\tc'}))).toBe('a b c');
    const long = previewForReply(msg({content: 'x'.repeat(300)}));
    expect(long).toHaveLength(200);
    expect(long.endsWith('…')).toBe(true);
  });
});
