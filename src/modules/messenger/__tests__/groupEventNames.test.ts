/**
 * Group membership-event display names (B-223 / B-224).
 *
 * The founder repro: a group system line read "Corné Breytenbach UAE added
 * Member 613949" — a raw-id CODE instead of the added member's name. Two causes:
 *   B-224 — /conversations/mine returns every member's registered displayName,
 *           but the client discarded it for group members, so the session
 *           directory never learned the name (wired in MessengerHomeScreen;
 *           pinned here by a static scan since that RN screen can't be imported
 *           under the node messenger-crypto project).
 *   B-223 — resolveMemberName consulted only direct-convo names, ignoring the
 *           directory / group override / peer phone, and the "X added Y" line
 *           was BAKED once, so a name that resolved later never replaced the
 *           code. resolveMemberName now walks the full B-115 precedence and
 *           memberAddedContentFor re-derives the line at render time.
 *
 * Pure store logic — the module imports only the store + (mocked) directory
 * backfill, so it runs in the node project.
 */

const mockAsync = new Map<string, string>();
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem:    async (k: string) => mockAsync.get(k) ?? null,
    setItem:    async (k: string, v: string) => { mockAsync.set(k, v); },
    removeItem: async (k: string) => { mockAsync.delete(k); },
  },
}));

// The resolver fires a debounced directory backfill on a miss; mock it so the
// test neither hits the network nor loads the users HTTP client.
const mockEnsureDirectoryNames = jest.fn();
jest.mock('../contacts/directoryNames', () => ({
  ensureDirectoryNames: (ids: string[]) => mockEnsureDirectoryNames(ids),
}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalConversation} from '../store/types';
import {
  resolveMemberName,
  parseMemberAddedId,
  memberAddedMessageId,
  memberAddedContentFor,
  appendMemberAddedEvent,
} from '../runtime/groupEventMessage';

function directConvo(userId: string, extra?: Partial<LocalConversation>): LocalConversation {
  return {
    id:            `direct:${userId}`,
    type:          'direct',
    name:          undefined,
    participants:  [userId],
    unread_count:  0,
    is_muted:      false,
    created_at:    '2026-07-24T00:00:00.000Z',
    peer:          {userId, deviceId: 1},
    session_state: 'established',
    ...extra,
  } as LocalConversation;
}

beforeEach(() => {
  useMessengerStore.getState().reset();
  useMessengerStore.getState().setOwner('owner-1');
  mockEnsureDirectoryNames.mockClear();
});

describe('resolveMemberName precedence (B-223)', () => {
  it("returns 'You' for the self id", () => {
    expect(resolveMemberName('u-self', 'u-self')).toBe('You');
  });

  it('prefers a direct-conversation contact name', () => {
    useMessengerStore.getState().upsertConversation(directConvo('u-1', {name: 'Alice Contact'}));
    useMessengerStore.getState().setDirectoryNames({'u-1': 'Alice Directory'});
    expect(resolveMemberName('u-1')).toBe('Alice Contact');
  });

  it('uses a group-member override above the directory name', () => {
    useMessengerStore.getState().setGroupMemberName('g-1', 'u-2', 'Override Name');
    useMessengerStore.getState().setDirectoryNames({'u-2': 'Directory Name'});
    expect(resolveMemberName('u-2', undefined, 'g-1')).toBe('Override Name');
  });

  it('uses the session directory name (the B-224 source) when no local name exists', () => {
    useMessengerStore.getState().setDirectoryNames({'u-3': 'Corné Breytenbach UAE'});
    expect(resolveMemberName('u-3')).toBe('Corné Breytenbach UAE');
  });

  it('falls back to a known peer phone (E.164) before an opaque code', () => {
    useMessengerStore.getState().upsertConversation(directConvo('u-4', {phoneE164: '+15550001234'}));
    expect(resolveMemberName('u-4')).toBe('+15550001234');
  });

  it('last resort is a short id AND queues a directory backfill (never a frozen UUID)', () => {
    const name = resolveMemberName('613949abc-uuid');
    expect(name).toBe('Member 613949');
    expect(mockEnsureDirectoryNames).toHaveBeenCalledWith(['613949abc-uuid']);
  });
});

describe('parseMemberAddedId round-trips memberAddedMessageId', () => {
  it('recovers groupId, addedUserId, epoch', () => {
    const id = memberAddedMessageId('g-9', 'u-added', 4);
    expect(parseMemberAddedId(id)).toEqual({groupId: 'g-9', addedUserId: 'u-added', epoch: 4});
  });

  it('returns null for a non-add id', () => {
    expect(parseMemberAddedId('sys:remove:g:u:1')).toBeNull();
    expect(parseMemberAddedId('regular-msg-id')).toBeNull();
  });
});

describe('memberAddedContentFor re-derives a baked line (B-223 backfill)', () => {
  it('resolves a name that arrived AFTER the event was baked, replacing the code', () => {
    const id = memberAddedMessageId('g-1', 'u-late', 2);
    const msg = {id, type: 'system', sender_id: 'u-actor'};

    // At bake time neither name was known → the code would have been shown.
    expect(memberAddedContentFor(msg)).toBe('Member u-acto added Member u-late');

    // Names resolve later (e.g. the next /conversations/mine sync — B-224).
    useMessengerStore.getState().setDirectoryNames({'u-actor': 'Corné', 'u-late': 'Sam'});
    expect(memberAddedContentFor(msg)).toBe('Corné added Sam');
  });

  it("maps the self id to 'you' as the added member", () => {
    const id = memberAddedMessageId('g-1', 'u-me', 3);
    const msg = {id, type: 'system', sender_id: 'u-actor'};
    useMessengerStore.getState().setDirectoryNames({'u-actor': 'Alex'});
    expect(memberAddedContentFor(msg, 'u-me')).toBe('Alex added you');
  });

  it('returns null for a non-system or non-add message (caller keeps msg.content)', () => {
    expect(memberAddedContentFor({id: 'x', type: 'text', sender_id: 'u'})).toBeNull();
    expect(memberAddedContentFor({id: 'sys:add:g:u:1', type: 'text', sender_id: 'u'})).toBeNull();
  });
});

describe('appendMemberAddedEvent bakes with resolved names + dedups', () => {
  it('bakes "<actor> added <member>" from the current directory and queues a backfill', () => {
    useMessengerStore.getState().setDirectoryNames({'u-actor': 'Corné', 'u-new': 'Sam'});
    const msg = appendMemberAddedEvent({groupId: 'g-1', actorUserId: 'u-actor', addedUserId: 'u-new', epoch: 1});
    expect(msg?.content).toBe('Corné added Sam');
    expect(mockEnsureDirectoryNames).toHaveBeenCalledWith(['u-actor', 'u-new']);
    // Idempotent: the same (group, member, epoch) never stacks a duplicate line.
    expect(appendMemberAddedEvent({groupId: 'g-1', actorUserId: 'u-actor', addedUserId: 'u-new', epoch: 1})).toBeNull();
  });
});

describe('B-222 — the group Add/rename/edit affordances are gated on the REAL admin flag', () => {
  // ChatInfoScreen can't be imported under the node project; pin the gate by a
  // comment-stripped source scan. `isAdmin = isGroup` showed the Add UI to every
  // member (dead-ending at a NOT_ADMIN alert); it must be the real admin flag.
  it('isAdmin derives from isGroupAdmin, not from isGroup', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'ChatInfoScreen.tsx'),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).toMatch(/const isAdmin\s*=\s*isGroupAdmin\b/);
    expect(code).not.toMatch(/const isAdmin\s*=\s*isGroup\s*;/);
  });
});

describe('B-224 wiring — MessengerHomeScreen folds member displayNames into the directory', () => {
  // The RN screen can't be imported under the node project, so pin the wire by a
  // comment-stripped, CRLF-safe source scan: the /conversations/mine sync must
  // harvest c.members[].displayName and call setDirectoryNames.
  it('the sync harvests member displayNames and calls setDirectoryNames', () => {
    const src = readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx'),
      'utf8',
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => l.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(code).toMatch(/for\s*\(const m of c\.members\)/);
    expect(code).toContain('m.displayName');
    expect(code).toContain('setDirectoryNames(memberNames)');
  });
});

describe('B-226 wiring — IncomingGroupCallScreen shows the host NAME, not a raw id', () => {
  // The founder's screenshot showed "From 79d63649…" on the incoming group-call
  // ring. The screen can't be imported under the node project (expo-av ringtone +
  // useGroupCall), so pin the wire by a comment-stripped, CRLF-safe source scan:
  // the caller sub-line must resolve the host id through resolveMemberName and
  // must NOT render a raw-id fragment (the old shortId(fromUserId)).
  const src = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'IncomingGroupCallScreen.tsx'),
    'utf8',
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('resolves the host id through resolveMemberName', () => {
    expect(code).toMatch(/resolveMemberName\(\s*fromUserId/);
  });

  it('renders the resolved hostName in the caller sub-line', () => {
    expect(code).toMatch(/From \$\{hostName\}/);
  });

  it('no longer renders a raw-id fragment for the caller (the B-226 bug)', () => {
    expect(code).not.toContain('shortId(fromUserId)');
    expect(code).not.toMatch(/function shortId\b/);
  });
});
