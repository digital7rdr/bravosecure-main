/**
 * sqa.md bug register — this suite pins: B-259.
 *
 * B-259 (no profile photo on the avatar INSIDE an open chat, while the conversation list
 * and the group-call tiles already showed one) is this suite's root cause: the directory
 * resolver threw the avatar away, and skipped the lookup entirely whenever the NAME was
 * already known — which it always is by the time a chat is open. Pinned by "keeps avatarUrl
 * from the SAME response it already reads the name from" and "no longer skips a lookup just
 * because the NAME is already known".
 */
/**
 * B-253 / B-254 — "if someone has a profile picture it should show in the
 * messenger chat list, and anywhere else an avatar is needed".
 *
 * ROOT CAUSE, and it is a one-liner: `/users/profiles` has always returned
 * `avatarUrl` next to `displayName`, and the shared directory resolver read
 * the name and DROPPED the avatar. ChatInfoScreen was the only screen that
 * ever showed a photo, and only because it ran its own private copy of the
 * very same fetch. Everywhere else — chat list, 1:1 call, group-call tiles,
 * calls log — had no avatar source at all and drew initials.
 *
 * A second, quieter half: the fetch queue skipped any id whose display NAME
 * was already known. Names arrive from places that carry no photo (group
 * metadata, the address book, manual overrides), so the users we know best
 * were exactly the ones whose avatar could never resolve.
 */
import {useMessengerStore} from '../store/messengerStore';

const readFileSync = require('node:fs').readFileSync as typeof import('node:fs').readFileSync;
const join = require('node:path').join as typeof import('node:path').join;

/** CRLF-safe, comment-stripped source. */
function code(rel: string): string {
  const raw = readFileSync(join(process.cwd(), rel), 'utf8');
  const out: string[] = [];
  let inBlock = false;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line);
  }
  return out.join('\n');
}

beforeEach(() => {
  useMessengerStore.setState({directoryAvatars: {}} as never);
});

describe('the store keeps resolved avatars', () => {
  it('merges entries by userId', () => {
    useMessengerStore.getState().setDirectoryAvatars({u1: 'https://cdn/a.jpg'});
    useMessengerStore.getState().setDirectoryAvatars({u2: 'https://cdn/b.jpg'});
    expect(useMessengerStore.getState().directoryAvatars).toEqual({
      u1: 'https://cdn/a.jpg', u2: 'https://cdn/b.jpg',
    });
  });

  it('a null or blank url means "no photo" and stores NOTHING', () => {
    // Consumers treat any present value as renderable, so an empty string
    // would paint a broken image where initials belong.
    useMessengerStore.getState().setDirectoryAvatars({u1: null, u2: '   ', u3: ''});
    expect(useMessengerStore.getState().directoryAvatars).toEqual({});
  });

  it('a later null CLEARS a previously known photo', () => {
    // A user who deletes their picture, and the onError path that reports a
    // dead url, both arrive this way.
    useMessengerStore.getState().setDirectoryAvatars({u1: 'https://cdn/a.jpg'});
    useMessengerStore.getState().setDirectoryAvatars({u1: null});
    expect(useMessengerStore.getState().directoryAvatars.u1).toBeUndefined();
  });

  it('trims, so a padded url is still a usable uri', () => {
    useMessengerStore.getState().setDirectoryAvatars({u1: '  https://cdn/a.jpg  '});
    expect(useMessengerStore.getState().directoryAvatars.u1).toBe('https://cdn/a.jpg');
  });

  it('ignores a blank userId key', () => {
    useMessengerStore.getState().setDirectoryAvatars({'': 'https://cdn/a.jpg'});
    expect(useMessengerStore.getState().directoryAvatars).toEqual({});
  });
});

describe('the resolver stops throwing the avatar away', () => {
  const RESOLVER = 'src/modules/messenger/contacts/directoryNames.ts';

  it('keeps avatarUrl from the SAME response it already reads the name from', () => {
    const src = code(RESOLVER);
    expect(src).toMatch(/avatars\[p\.userId\] = p\.avatarUrl;/);
    expect(src).toMatch(/setDirectoryAvatars\(avatars\)/);
  });

  it('no longer skips a lookup just because the NAME is already known', () => {
    // `directoryNames[id]` as a skip condition is what starved the avatar for
    // every user whose name came from somewhere photo-less.
    const src = code(RESOLVER);
    // F7 2026-08-14: the skip set gained `inFlight` (ids on the wire) —
    // still no NAME-based condition, which is what this pin guards.
    expect(src).toMatch(/if \(attempted\.has\(id\) \|\| pending\.has\(id\) \|\| inFlight\.has\(id\)\) \{continue;\}/);
    expect(src).not.toMatch(/if \(known\[id\] \|\| attempted\.has\(id\)/);
    expect(src).not.toMatch(/directoryNames\[id\]\s*(\|\||&&|\))/);
  });

  it('still dedupes once per session, so this cannot loop', () => {
    // `attempted` is filled for every id in a flush whether or not the profile
    // resolved — that is the real guard, and it must survive.
    const src = code(RESOLVER);
    expect(src).toMatch(/for \(const id of ids\) \{attempted\.add\(id\);\}/);
  });
});

describe('every avatar surface goes through the one component', () => {
  const SURFACES: Array<[string, string]> = [
    ['chat list',       'src/screens/messenger/MessengerHomeScreen.tsx'],
    ['group call',      'src/screens/messenger/GroupCallScreen.tsx'],
    ['1:1 call',        'src/screens/messenger/CallScreen.tsx'],
    ['calls log',       'src/screens/messenger/CallsLogScreen.tsx'],
  ];

  it.each(SURFACES)('%s renders <UserAvatar>', (_label, rel) => {
    const src = code(rel);
    expect(src).toMatch(/<UserAvatar/);
    expect(src).toMatch(/from '@\/modules\/messenger\/ui\/UserAvatar'/);
  });

  it.each(SURFACES)('%s still supplies an initials fallback', (_label, rel) => {
    // The photo is an upgrade, never a requirement — a user with no picture,
    // or one whose profile has not resolved yet, must still get a disc.
    expect(code(rel)).toMatch(/fallback=\{/);
  });

  it('the chat list resolves a PERSON and a GROUP through their own component', () => {
    // This assertion used to read `userId={isGroup ? null : peerId}` with the
    // note "a group has no single face; its own picture is a separate feature".
    // B-291 BUILT that feature, so the old form is now wrong rather than stale:
    // passing null for a group would throw the picture away.
    //
    // The invariant it was protecting is unchanged and in fact stronger — no
    // surface draws a bare disc of its own — so it is re-anchored, not dropped:
    // a person goes through UserAvatar with the PEER id (never a group id, which
    // would query the directory for something that is not a user), and a group
    // goes through GroupAvatar.
    const src = code('src/screens/messenger/MessengerHomeScreen.tsx');
    expect(src).toMatch(/<GroupAvatar[\s\S]{0,120}groupId=\{c\.id\}/);
    expect(src).toMatch(/<UserAvatar[\s\S]{0,120}userId=\{peerId\}/);
    // And the group branch must never feed a group id to the USER directory.
    expect(src).not.toMatch(/userId=\{c\.id\}/);
  });

  it('the group-call tile resolves the participant behind the tag', () => {
    const src = code('src/screens/messenger/GroupCallScreen.tsx');
    expect(src).toMatch(/userId=\{isSelf \? ownerUserId : userIdFor\(tag\)\}/);
  });

  it('the group-call photo and its initials disc share ONE size constant', () => {
    // Two literals for one circle is how the photo ends up a different size
    // from the disc it replaces.
    const src = code('src/screens/messenger/GroupCallScreen.tsx');
    expect(src).toMatch(/const AVATAR_DISC_HERO = \d+;/);
    expect(src).toMatch(/size=\{isHero \? AVATAR_DISC_HERO : AVATAR_DISC_SMALL\}/);
    expect(src).toMatch(/avatarDiscHero:\s*\{width: AVATAR_DISC_HERO, height: AVATAR_DISC_HERO\}/);
  });

  it('ChatInfoScreen now FEEDS the shared store instead of hoarding its fetch', () => {
    // It was the only screen with photos precisely because it kept them.
    expect(code('src/screens/messenger/ChatInfoScreen.tsx'))
      .toMatch(/setDirectoryAvatars\(avatars\)/);
  });
});

describe('UserAvatar degrades safely', () => {
  const SRC = 'src/modules/messenger/ui/UserAvatar.tsx';

  it('renders the fallback when no photo is known', () => {
    expect(code(SRC)).toMatch(/if \(!uri\) \{[\s\S]{0,60}return fallback;/);
  });

  it('a broken url falls BACK to initials instead of leaving a hole', () => {
    const src = code(SRC);
    expect(src).toMatch(/onError=\{/);
    expect(src).toMatch(/setDirectoryAvatars\(\{\[userId\]: null\}\)/);
  });

  it('requests a backfill for a miss, and never for self', () => {
    const src = code(SRC);
    expect(src).toMatch(/ensureDirectoryNames\(\[userId\]\)/);
    expect(src).toMatch(/userId !== 'self'/);
  });

  // B-261 — this component mounts once per list row and remounts on every
  // scroll pass, so anything it does per mount is paid on the JS thread during
  // the frames the list is trying to render. Both of these are pure
  // work-avoidance: the behaviour above is unchanged.
  it('does not re-require the directory module on every mount', () => {
    const src = code(SRC);
    // The require must be latched at module scope, not run inside the helper
    // body on each call.
    expect(src).toMatch(/let directoryModule/);
    expect(src).toMatch(/if \(directoryModule === undefined\)/);
  });

  it('skips the backfill entirely once the photo is in the store', () => {
    const src = code(SRC);
    expect(src).toMatch(/const resolved = url !== null/);
    expect(src).toMatch(/userId !== 'self' && !resolved/);
  });
});
