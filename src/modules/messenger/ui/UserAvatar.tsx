/**
 * B-253 / B-254 — one way to draw a person.
 *
 * Before this, every surface that needed a face invented its own answer.
 * ChatInfoScreen fetched `/users/profiles` into a screen-local map and
 * rendered the photo; the chat list, the 1:1 call screen, the group-call
 * tiles and the calls log all drew a coloured initials disc with no avatar
 * source at all — even though the shared directory resolver was fetching
 * those very avatars on every lookup and discarding them.
 *
 * So a user with a profile picture appeared as initials everywhere except one
 * screen, and it read as "avatars are broken" rather than "one fetch drops
 * half its payload".
 *
 * Usage — the fallback is REQUIRED and stays each surface's own, because the
 * discs differ deliberately (gradient ring on a call tile, flat colour in the
 * list, sizes and radii all different). This component only decides
 * photo-or-fallback and owns the backfill:
 *
 *   <UserAvatar userId={peerId} size={46} radius={23}
 *     fallback={<View style={s.disc}><Text>{initials}</Text></View>} />
 */
import React, {useEffect} from 'react';
import {Image, type ImageStyle, type StyleProp} from 'react-native';
import {useMessengerStore} from '../store/messengerStore';

/**
 * Lazy require, deliberately. `directoryNames` reaches `@utils/constants` for
 * the API base url, which pulls in `expo/virtual/env` — an ESM module the app
 * Jest project does not transform (B-153). Importing it at module scope would
 * drag that into the import graph of EVERY screen that draws an avatar and
 * break their render tests, which is a silly price for one fire-and-forget
 * backfill call.
 */
type DirectoryModule = typeof import('../contacts/directoryNames');
// B-261 — resolved ONCE, not per avatar mount. A FlatList row mounts and
// unmounts on every scroll pass, and this used to run a `require` + try/catch
// each time. Metro caches the module, so the old cost was small — but it was
// paid on the JS thread during the exact frames the list is trying to render.
let directoryModule: DirectoryModule | null | undefined;

function backfillProfile(userId: string): void {
  if (directoryModule === undefined) {
    try {
      directoryModule = require('../contacts/directoryNames') as DirectoryModule;
    } catch {
      // No directory client in this environment (tests) — the avatar simply
      // stays unresolved and the fallback renders. Latch the miss so we do not
      // retry the failing require on every subsequent mount.
      directoryModule = null;
    }
  }
  directoryModule?.ensureDirectoryNames([userId]);
}

/**
 * The resolved photo URL for a user, or null.
 *
 * Requests a backfill for a miss. `ensureDirectoryNames` is debounced,
 * batched and once-per-session, so calling this from a list row that
 * re-renders on every keystroke is safe.
 */
export function useUserAvatar(userId: string | null | undefined): string | null {
  const url = useMessengerStore(s => (userId ? s.directoryAvatars[userId] ?? null : null));
  // B-261 — a user whose photo is already in the store needs nothing fetched,
  // so skip the call entirely. `ensureDirectoryNames` would have deduped it
  // against its `attempted` set anyway, but not before this row had crossed a
  // module boundary and allocated an array, once per mount, per row, per
  // scroll. The remaining misses still queue: `attempted` is the real
  // once-per-session guard and it is set whether or not a photo came back.
  const resolved = url !== null;
  useEffect(() => {
    if (userId && userId !== 'self' && !resolved) {
      backfillProfile(userId);
    }
  }, [userId, resolved]);
  return url;
}

export interface UserAvatarProps {
  userId: string | null | undefined;
  /** Rendered when the user has no photo, or it has not resolved yet. */
  fallback: React.ReactElement;
  size: number;
  /** Defaults to a circle. */
  radius?: number;
  style?: StyleProp<ImageStyle>;
}

export function UserAvatar({userId, fallback, size, radius, style}: UserAvatarProps): React.ReactElement {
  const uri = useUserAvatar(userId);
  if (!uri) {
    return fallback;
  }
  return (
    <Image
      source={{uri}}
      style={[{width: size, height: size, borderRadius: radius ?? size / 2}, style]}
      // Why: a broken/expired URL must degrade to the initials disc rather
      // than leaving a blank hole where a face should be. RN keeps the last
      // good frame otherwise, and on a fresh mount that is nothing at all.
      onError={() => {
        if (userId) {
          useMessengerStore.getState().setDirectoryAvatars({[userId]: null});
        }
      }}
    />
  );
}
