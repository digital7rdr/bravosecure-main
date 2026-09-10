/**
 * B-291 — one way to draw a group.
 *
 * The deliberate sibling of `UserAvatar`. That component exists because every
 * surface that needed a FACE had invented its own answer and they disagreed
 * (B-253/B-254); the same thing would happen to group pictures within a week if
 * each screen resolved its own. So: this decides picture-or-fallback, and the
 * fallback stays each surface's own, because the discs differ deliberately
 * (gradient in the chat header, flat colour in the list, different sizes/radii).
 *
 *   <GroupAvatar groupId={id} size={40} radius={20}
 *     fallback={<View style={s.disc}><Icon name="account-group" /></View>} />
 *
 * The picture is an ENCRYPTED object: group state carries only
 * {objectKey, keyB64, ivB64}, so drawing it means a download plus an AES-CBC
 * decrypt. That is why this is a component with state rather than a style prop.
 */
import React, {useEffect, useState} from 'react';
import {Image, type ImageStyle, type StyleProp} from 'react-native';
import {useMessengerStore} from '../store/messengerStore';
import type {GroupPhotoRef} from '@bravo/messenger-core';
import {writeTempBytes, statTempBytes} from '../media/mediaFiles';

/**
 * objectKey → local plaintext uri. Keyed on the objectKey, NOT the groupId: a
 * new picture mints a new object, so a stale entry can never shadow a fresh
 * one, and re-setting the same picture reuses the decrypt.
 */
const resolved = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();
/** Bounded — a long session must not accumulate one entry per picture ever seen. */
const CACHE_MAX = 64;

function remember(objectKey: string, uri: string): void {
  if (resolved.size >= CACHE_MAX) {
    const oldest = resolved.keys().next().value;
    if (oldest !== undefined) {resolved.delete(oldest);}
  }
  resolved.set(objectKey, uri);
}

async function resolveGroupPhoto(photo: GroupPhotoRef): Promise<string> {
  const memo = resolved.get(photo.objectKey);
  if (memo) {return memo;}
  const existing = inFlight.get(photo.objectKey);
  if (existing) {return existing;}

  const p = (async (): Promise<string> => {
    // A prior authenticated decrypt may already have written the file — skip
    // the round-trip and the AES pass entirely.
    const warm = await statTempBytes(photo.mimeType, `grp-${photo.objectKey}`);
    if (warm) {return warm;}
    // Lazy require for the same reason UserAvatar does it: the runtime module
    // reaches `@utils/constants`, which pulls `expo/virtual/env` — untransformed
    // in the app Jest project (B-153). Importing at module scope would drag it
    // into every screen that draws a group and break their render tests.
    const {getMessengerRuntime} = require('../runtime') as typeof import('../runtime');
    const rt = await getMessengerRuntime();
    if (!rt || typeof rt.downloadMedia !== 'function') {throw new Error('runtime_not_ready');}
    const bytes = await rt.downloadMedia({
      objectKey: photo.objectKey,
      keyB64:    photo.keyB64,
      ivB64:     photo.ivB64,
    });
    return writeTempBytes(bytes, photo.mimeType, `grp-${photo.objectKey}`);
  })();

  inFlight.set(photo.objectKey, p);
  try {
    const uri = await p;
    remember(photo.objectKey, uri);
    return uri;
  } finally {
    inFlight.delete(photo.objectKey);
  }
}

/**
 * Resolved local uri for a group's photo, or null. Extracted from GroupAvatar
 * so surfaces that need the URI itself (the full-screen AvatarViewer) share
 * the same cache + single-flight resolution as the avatar renderer.
 */
export function useGroupAvatarUri(groupId: string | null | undefined): string | null {
  const photo = useMessengerStore(s => (groupId ? s.groups[groupId]?.photo : null));
  const [uri, setUri] = useState<string | null>(
    photo ? resolved.get(photo.objectKey) ?? null : null,
  );

  useEffect(() => {
    if (!photo) { setUri(null); return; }
    // Synchronous cache hit — set it without a render of the fallback, so a
    // list row that scrolls back into view does not flash its initials.
    const memo = resolved.get(photo.objectKey);
    if (memo) { setUri(memo); return; }
    let live = true;
    setUri(null);
    resolveGroupPhoto(photo)
      .then(u => { if (live) {setUri(u);} })
      // A failed decrypt or a 404 leaves the fallback showing. Deliberately
      // silent: a group whose picture object has expired is not an error the
      // user can act on, and a broken-image tile reads worse than the disc.
      .catch(() => { if (live) {setUri(null);} });
    return () => { live = false; };
  }, [photo]);

  return uri;
}

export function GroupAvatar({groupId, size, radius, style, fallback}: {
  groupId:  string | null | undefined;
  size:     number;
  radius?:  number;
  style?:   StyleProp<ImageStyle>;
  /** REQUIRED — each surface owns its own disc. */
  fallback: React.ReactElement;
}) {
  const uri = useGroupAvatarUri(groupId);

  if (!uri) {return fallback;}
  return (
    <Image
      source={{uri}}
      style={[{width: size, height: size, borderRadius: radius ?? size / 2}, style]}
      resizeMode="cover"
    />
  );
}

/** Test seam — the caches are module state. */
export function _resetGroupAvatarCacheForTest(): void {
  resolved.clear();
  inFlight.clear();
}
