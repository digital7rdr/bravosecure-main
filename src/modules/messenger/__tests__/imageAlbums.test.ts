/**
 * B-287 / B-288 — photo albums in the thread, and paging between photos.
 *
 * Founder: "when images are sent multiple like WhatsApp they are like one
 * album, they are not coming one by one" and "when one image opens, if we swipe
 * right or left we should be able to see the next or previous image."
 *
 * Both features hang off one ordering, so both are pinned here. The swipe
 * DECISION is tested rather than the gesture: `ZoomableImage` uses the classic
 * gesture-handler API against native Animated values, which no node test can
 * drive — but every rule that matters (zoomed images never page, horizontal
 * intent, distance-or-velocity) is pure and lives in `swipeIntent`.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {LocalMessage} from '../store';
import {
  ALBUM_MAX_TILES,
  ALBUM_MIN_SIZE,
  ALBUM_WINDOW_MS,
  albumHeight,
  albumIndex,
  albumLayout,
  albumTiles,
  groupAlbums,
  isVisualMessage,
  stepVisual,
  visualMessageIds,
} from '../ui/imageAlbums';
import {
  SWIPE_MIN_DISTANCE_PX,
  SWIPE_MIN_VELOCITY,
  swipeIntent,
} from '../ui/zoomMath';

const T0 = Date.UTC(2026, 6, 26, 12, 0, 0);

/** Only the fields the grouping rules actually read. */
function mk(over: {
  id: string;
  type?: string;
  sender?: string;
  atMs?: number;
  content?: string;
  name?: string;
}): LocalMessage {
  return {
    id: over.id,
    type: over.type ?? 'image',
    sender_id: over.sender ?? 'u-alice',
    created_at: new Date(over.atMs ?? T0).toISOString(),
    content: over.content ?? '',
    media_meta: over.name ? {name: over.name} : undefined,
  } as unknown as LocalMessage;
}

/** N photos from one sender, one second apart. */
function burst(n: number, sender = 'u-alice', from = T0): LocalMessage[] {
  return Array.from({length: n}, (_, i) =>
    mk({id: `img-${sender}-${i}`, sender, atMs: from + i * 1000}));
}

describe('B-288 — what counts as a picture', () => {
  it('groups photos', () => {
    expect(isVisualMessage(mk({id: 'a'}))).toBe(true);
  });

  it('leaves video, audio, files and text alone', () => {
    // Video is excluded deliberately: a play affordance and a poster frame in
    // a photo grid produce tiles that look tappable one way, behave another.
    for (const type of ['video', 'audio', 'file', 'text', 'call']) {
      expect(isVisualMessage(mk({id: 'x', type}))).toBe(false);
    }
  });
});

describe('B-288 — consecutive photos become one album', () => {
  it('groups a burst from one sender', () => {
    const albums = groupAlbums(burst(4));
    expect(albums).toHaveLength(1);
    expect(albums[0]).toHaveLength(4);
  });

  it('leaves a lone photo alone', () => {
    // A 1-cell "grid" is just a photo wearing extra chrome.
    expect(groupAlbums(burst(1))).toHaveLength(0);
    expect(ALBUM_MIN_SIZE).toBe(2);
  });

  it('splits on a different sender', () => {
    const albums = groupAlbums([...burst(2, 'u-alice'), ...burst(2, 'u-bob', T0 + 5_000)]);
    expect(albums).toHaveLength(2);
    expect(albums[0][0].sender_id).toBe('u-alice');
    expect(albums[1][0].sender_id).toBe('u-bob');
  });

  it('splits when text interrupts the run', () => {
    const albums = groupAlbums([
      ...burst(2, 'u-alice', T0),
      mk({id: 'says', type: 'text', atMs: T0 + 3_000, content: 'nice'}),
      ...burst(2, 'u-alice', T0 + 5_000),
    ]);
    expect(albums).toHaveLength(2);
  });

  it('splits when the photos are far apart in time', () => {
    const albums = groupAlbums([
      mk({id: 'a', atMs: T0}),
      mk({id: 'b', atMs: T0 + ALBUM_WINDOW_MS + 1}),
    ]);
    expect(albums).toHaveLength(0);   // neither reaches ALBUM_MIN_SIZE
  });

  it('tolerates a slow upload inside the window', () => {
    // Each photo encrypts and uploads separately, so a batch picked in one
    // gesture can dribble in over most of a minute and must still read as one.
    const albums = groupAlbums([
      mk({id: 'a', atMs: T0}),
      mk({id: 'b', atMs: T0 + ALBUM_WINDOW_MS - 1}),
    ]);
    expect(albums).toHaveLength(1);
  });

  it('never groups a captioned photo', () => {
    // A caption makes a photo a statement, and merging would hide the text.
    const albums = groupAlbums([
      mk({id: 'a', atMs: T0}),
      mk({id: 'b', atMs: T0 + 1000, content: 'look at this'}),
      mk({id: 'c', atMs: T0 + 2000}),
    ]);
    expect(albums).toHaveLength(0);
  });

  it('does NOT treat a bare filename as a caption', () => {
    // Attachments without a caption carry the filename in `content`; echoing
    // "IMG_20260726.jpg" under a tile is noise, and treating it as a caption
    // would stop ordinary photo bursts grouping at all.
    const albums = groupAlbums([
      mk({id: 'a', atMs: T0, content: 'IMG_1.jpg', name: 'IMG_1.jpg'}),
      mk({id: 'b', atMs: T0 + 1000, content: 'IMG_2.jpg', name: 'IMG_2.jpg'}),
    ]);
    expect(albums).toHaveLength(1);
    expect(albums[0]).toHaveLength(2);
  });

  it('survives a malformed timestamp instead of grouping the whole thread', () => {
    const bad = mk({id: 'bad'});
    (bad as {created_at: string}).created_at = 'not-a-date';
    expect(() => groupAlbums([mk({id: 'a'}), bad, mk({id: 'c'})])).not.toThrow();
  });

  it('handles an empty thread', () => {
    expect(groupAlbums([])).toEqual([]);
  });
});

describe('B-288 — album lookup by id', () => {
  it('points every member at the same leader', () => {
    const msgs = burst(3);
    const idx = albumIndex(msgs);
    for (const m of msgs) {
      expect(idx.get(m.id)!.leaderId).toBe(msgs[0].id);
      expect(idx.get(m.id)!.album).toHaveLength(3);
    }
  });

  it('omits ungrouped messages', () => {
    const idx = albumIndex([mk({id: 'solo'}), mk({id: 'talk', type: 'text', atMs: T0 + 1000})]);
    expect(idx.has('solo')).toBe(false);
    expect(idx.has('talk')).toBe(false);
  });

  it('is keyed by id, not object identity', () => {
    // The store REPLACES a message object on every status/receipt flip. An
    // identity-keyed map would miss the replacement and un-group the album
    // mid-delivery, which is exactly when the user is looking at it.
    const msgs = burst(2);
    const idx = albumIndex(msgs);
    const replaced = {...msgs[1], status: 'read'} as LocalMessage;
    expect(idx.get(replaced.id)).toBeDefined();
  });
});

describe('B-288 — album tile layout', () => {
  it('draws every photo when the set is small', () => {
    expect(albumLayout(2)).toEqual({tiles: 2, overflow: 0});
    expect(albumLayout(ALBUM_MAX_TILES)).toEqual({tiles: ALBUM_MAX_TILES, overflow: 0});
  });

  it('collapses a large set into a +N overlay', () => {
    expect(albumLayout(7)).toEqual({tiles: ALBUM_MAX_TILES, overflow: 7 - ALBUM_MAX_TILES});
  });

  it('never reports more tiles than photos', () => {
    for (let n = 1; n <= 20; n++) {
      const {tiles, overflow} = albumLayout(n);
      expect(tiles).toBeLessThanOrEqual(n);
      expect(tiles + overflow).toBe(n);
    }
  });
});

describe('B-287 — the order the viewer pages through', () => {
  const thread = [
    mk({id: 'p1', atMs: T0}),
    mk({id: 'talk', type: 'text', atMs: T0 + 1000}),
    mk({id: 'p2', atMs: T0 + 2000}),
    mk({id: 'clip', type: 'video', atMs: T0 + 3000}),
    mk({id: 'p3', atMs: T0 + 4000, content: 'with a caption'}),
  ];

  it('is every photo in the thread, oldest first', () => {
    expect(visualMessageIds(thread)).toEqual(['p1', 'p2', 'p3']);
  });

  it('spans album boundaries', () => {
    // Stopping at the tapped album would be a dead end the user cannot see.
    // A captioned photo never GROUPS but must still be reachable.
    const ids = visualMessageIds(thread);
    expect(stepVisual(ids, 'p2', 1)).toBe('p3');
  });

  it('steps forward and back', () => {
    const ids = visualMessageIds(thread);
    expect(stepVisual(ids, 'p1', 1)).toBe('p2');
    expect(stepVisual(ids, 'p2', -1)).toBe('p1');
  });

  it('stops at both ends rather than wrapping', () => {
    // Wrapping makes it impossible to feel where the set ends.
    const ids = visualMessageIds(thread);
    expect(stepVisual(ids, 'p1', -1)).toBeNull();
    expect(stepVisual(ids, 'p3', 1)).toBeNull();
  });

  it('returns null for a photo that is no longer in the thread', () => {
    // The viewer stays open across a delete; paging from a removed message
    // must not throw or land on an arbitrary neighbour.
    expect(stepVisual(visualMessageIds(thread), 'gone', 1)).toBeNull();
    expect(stepVisual([], 'p1', 1)).toBeNull();
  });
});

describe('B-287 — when a drag pages instead of pans', () => {
  const REST = {translationY: 0, velocityX: 0, scale: 1};

  it('pages forward on a decisive left drag', () => {
    expect(swipeIntent({...REST, translationX: -SWIPE_MIN_DISTANCE_PX})).toBe(1);
  });

  it('pages back on a decisive right drag', () => {
    expect(swipeIntent({...REST, translationX: SWIPE_MIN_DISTANCE_PX})).toBe(-1);
  });

  it('NEVER pages while zoomed in', () => {
    // THE RULE THAT MATTERS. While zoomed the drag is how the user reaches the
    // edges of the photo; stealing it makes a zoomed image unreadable.
    expect(swipeIntent({...REST, translationX: -300, scale: 2.5})).toBe(0);
    expect(swipeIntent({...REST, translationX: 300, velocityX: -3000, scale: 4})).toBe(0);
  });

  it('still pages after a pinch settles a hair off exactly 1', () => {
    // A strict `> 1` test would silently disable paging forever after the
    // user's first pinch.
    expect(swipeIntent({...REST, translationX: -120, scale: 1.02})).toBe(1);
  });

  it('ignores a small nudge', () => {
    expect(swipeIntent({...REST, translationX: -10})).toBe(0);
  });

  it('accepts a fast flick that barely moved', () => {
    expect(swipeIntent({
      ...REST,
      translationX: -(SWIPE_MIN_DISTANCE_PX / 2),
      velocityX: -SWIPE_MIN_VELOCITY,
    })).toBe(1);
  });

  it('ignores a fast flick that moved essentially nowhere', () => {
    expect(swipeIntent({...REST, translationX: -2, velocityX: -4000})).toBe(0);
  });

  it('ignores a vertical drag', () => {
    // Otherwise a dismiss-style flick would page.
    expect(swipeIntent({translationX: -20, translationY: -300, velocityX: 0, scale: 1})).toBe(0);
  });

  it('ignores a diagonal fumble', () => {
    expect(swipeIntent({translationX: -80, translationY: -80, velocityX: 0, scale: 1})).toBe(0);
  });

  it('survives a non-finite gesture payload', () => {
    // Gesture CANCEL has produced NaN translations on device. Translation and
    // scale are REQUIRED — a bad scale fails closed, because we cannot tell
    // whether the user is zoomed and stealing a zoomed pan is the worse error.
    for (const bad of [NaN, Infinity]) {
      expect(swipeIntent({...REST, translationX: bad})).toBe(0);
      expect(swipeIntent({...REST, translationX: -200, scale: bad})).toBe(0);
    }
  });

  it('B-293 THE BUG: pages with NO velocity in the payload', () => {
    // This assertion previously said the OPPOSITE — it required a finite
    // velocity and treated a missing one as a reason to refuse. That made the
    // whole feature inert on device: `onHandlerStateChange` carries a state
    // transition, not a motion sample, so its native payload does not reliably
    // include a velocity, `isFinite(undefined)` was false, and every swipe was
    // rejected. Every unit test passed the whole time because they all supplied
    // a velocity explicitly.
    //
    // Velocity is only ever a BOOST for the flick path. Distance alone must be
    // enough, so an absent velocity means "unknown", not "no".
    expect(swipeIntent({translationX: -200, translationY: 0, scale: 1})).toBe(1);
    expect(swipeIntent({translationX: 200, translationY: 0, scale: 1})).toBe(-1);
  });

  it('B-293 a garbage velocity degrades to distance-only, it does not veto', () => {
    for (const bad of [NaN, Infinity, undefined]) {
      // Far enough to page on distance alone → still pages.
      expect(swipeIntent({...REST, translationX: -200, velocityX: bad as number})).toBe(1);
      // Too small for distance, and the flick path cannot rescue it without a
      // real velocity → correctly stays put.
      expect(swipeIntent({...REST, translationX: -10, velocityX: bad as number})).toBe(0);
    }
  });
});

describe('B-293 — the page must be VISIBLE, and must never park off-screen', () => {
  // ZoomableImage drives native Animated values through the classic
  // gesture-handler API, which no node test can drive — so these two
  // properties are pinned by a comment-stripped source scan. The file is CRLF;
  // nothing here is `\n`-anchored.
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'ui', 'ZoomableImage.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');

  it('animates the outgoing image out before swapping', () => {
    // A source swap with no motion is why this read as "not working" even after
    // the gesture fired — nothing signalled that a swipe was recognised.
    const at = src.indexOf('dir !== 0 && onSwipe');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 900);
    expect(body).toMatch(/Animated\.timing\(\s*panX/);
    expect(body).toMatch(/toValue: dir === 1 \? -width : width/);
    // onSwipe fires in the animation callback, so the swap lands after the slide.
    expect(body).toMatch(/\.start\(\(\) => \{[\s\S]{0,120}onSwipe\(dir\)/);
  });

  it('ALWAYS re-centres after the slide', () => {
    // THE TRAP: at the first or last photo `onSwipe` changes nothing, so the
    // uri-effect that normally resets translation never runs. Without an
    // unconditional re-centre the image stays parked off-screen and the viewer
    // looks empty — a worse bug than the one being fixed.
    const at = src.indexOf('dir !== 0 && onSwipe');
    const body = src.slice(at, at + 1600);
    const after = body.slice(body.indexOf('onSwipe(dir)'));
    expect(after).toMatch(/Animated\.timing\(panX, \{toValue: 0, duration: 0/);
    expect(after).toMatch(/Animated\.timing\(panY, \{toValue: 0, duration: 0/);
    // And it must not be conditional on the image having changed.
    expect(after.slice(0, after.indexOf('Animated.timing(panX'))).not.toContain('if (');
  });

  it('B-295 re-centres via the ANIMATION system, never setValue/setOffset', () => {
    // This assertion previously demanded the OPPOSITE — it required
    // `panX.setValue(0)` — and that is precisely what shipped the blank viewer
    // in v1.0.174/175.
    //
    // `panX` is NATIVE-DRIVEN (the pan Animated.event and the slide both pass
    // useNativeDriver). Writing a native-driven node from JS does not reliably
    // reach the native side: the shadow node keeps the last ANIMATED value,
    // ±width, so the image stayed off-screen, the viewer went blank, and a
    // blank viewer has no gesture surface — hence "stuck on the first image".
    // A zero-duration timing takes the same path settleTranslation's spring
    // uses, which is why the settle path never had this bug.
    const at = src.indexOf('dir !== 0 && onSwipe');
    const body = src.slice(at, at + 1600);
    expect(body).not.toMatch(/panX\.setValue\(/);
    expect(body).not.toMatch(/panY\.setValue\(/);
    expect(body).not.toMatch(/panX\.setOffset\(/);
    expect(body).not.toMatch(/panY\.setOffset\(/);
  });

  it('B-295 flattens BOTH axes before sliding', () => {
    // flattenOffset folds the gesture offset into the value so the slide starts
    // from the on-screen position; skipping panY leaves a stale vertical offset
    // that the zero-duration reset then fights.
    const at = src.indexOf('dir !== 0 && onSwipe');
    const before = src.slice(at, src.indexOf('Animated.timing(panX', at));
    expect(before).toContain('panX.flattenOffset()');
    expect(before).toContain('panY.flattenOffset()');
  });

  it('a REJECTED swipe still settles back to rest', () => {
    // Otherwise a drag that does not clear the threshold leaves the photo
    // parked off-axis.
    expect(src).toMatch(/settleTranslation\(baseScaleRef\.current, totalX, totalY\)/);
  });
});

describe('B-294 — paging must never blank the viewer', () => {
  // ChatScreen mounts RN views, so this is a comment-stripped source scan. The
  // file is CRLF; nothing here is `\n`-anchored.
  const chat = readFileSync(
    join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '')
    .replace(/\/\/[^\r\n]*/g, '');

  const viewer = chat.slice(
    chat.indexOf('function ChatAttachmentViewer'),
    chat.indexOf('const MessageBubble = React.memo'),
  );

  it('the viewer really was located', () => {
    expect(viewer.length).toBeGreaterThan(400);
  });

  it('THE BUG: the loading branch cannot fire once something is shown', () => {
    // Paging to a not-yet-decrypted photo used to return a DIFFERENT <Modal>,
    // unmounting the viewer's Modal and mounting another in the same frame.
    // On Android that yields a blank window — and a blank window has no gesture
    // surface, so the next swipe did nothing and it looked stuck on the first
    // photo. Both fallback branches must be gated on having nothing to show.
    expect(viewer).toMatch(/if \(!shown && \(state === 'loading'/);
    expect(viewer).toMatch(/if \(!shown && \(state === 'error'/);
  });

  it('holds the last fully-resolved message AND uri together', () => {
    // Swapping them independently would label the visible photo with the
    // incoming photo's filename.
    expect(viewer).toMatch(/shownRef\s*=\s*useRef</);
    expect(viewer).toMatch(/if \(uri\) \{shownRef\.current = \{msg, uri\};\}/);
  });

  it('renders the SHOWN photo, never the requested one', () => {
    // The one that bites: delete must remove the photo on screen.
    expect(viewer).toMatch(/removeMessage\(shownMsg\.conversation_id, shownMsg\.id\)/);
    expect(viewer).toMatch(/id:\s*shownMsg\.id/);
    expect(viewer).toMatch(/uri:\s*shown!\.uri/);
  });
});

describe('B-288 — album mosaic geometry', () => {
  const W = 254;
  const GAP = 3;

  it('lays two photos side by side', () => {
    const tiles = albumTiles(2, W, GAP);
    expect(tiles).toHaveLength(2);
    expect(tiles[0].left).toBe(0);
    expect(tiles[1].left).toBe(tiles[0].width + GAP);
    expect(tiles[0].top).toBe(tiles[1].top);
  });

  it('lays three as one tall photo beside two stacked', () => {
    const tiles = albumTiles(3, W, GAP);
    expect(tiles).toHaveLength(3);
    // The tall one spans both rows.
    expect(tiles[0].height).toBeCloseTo(tiles[1].height + GAP + tiles[2].height, 5);
    expect(tiles[1].top).toBe(0);
    expect(tiles[2].top).toBeGreaterThan(tiles[1].top);
  });

  it('lays four as a 2x2', () => {
    const tiles = albumTiles(4, W, GAP);
    expect(tiles).toHaveLength(4);
    expect(new Set(tiles.map(t => t.width)).size).toBe(1);
    expect(new Set(tiles.map(t => t.top)).size).toBe(2);
    expect(new Set(tiles.map(t => t.left)).size).toBe(2);
  });

  it('never draws more than four tiles however many photos arrive', () => {
    // The cap is the performance contract: B-279 measured this screen's
    // bottleneck as view MOUNTING, and a 30-photo dump used to be 30 bubbles.
    for (const n of [5, 9, 30, 200]) {
      expect(albumTiles(n, W, GAP)).toHaveLength(ALBUM_MAX_TILES);
    }
  });

  it('puts the +N badge on the LAST tile and nowhere else', () => {
    const tiles = albumTiles(9, W, GAP);
    expect(tiles.slice(0, -1).every(t => t.overflow === 0)).toBe(true);
    expect(tiles[tiles.length - 1].overflow).toBe(9 - ALBUM_MAX_TILES);
  });

  it('shows no badge when every photo is visible', () => {
    for (const n of [2, 3, 4]) {
      expect(albumTiles(n, W, GAP).every(t => t.overflow === 0)).toBe(true);
    }
  });

  it('never overflows the bubble width', () => {
    // A tile wider than the bubble is clipped on device and invisible in tests.
    for (const n of [2, 3, 4, 12]) {
      for (const t of albumTiles(n, W, GAP)) {
        expect(t.left + t.width).toBeLessThanOrEqual(W + 0.001);
        expect(t.left).toBeGreaterThanOrEqual(0);
        expect(t.width).toBeGreaterThan(0);
        expect(t.height).toBeGreaterThan(0);
      }
    }
  });

  it('tiles never overlap each other', () => {
    const overlaps = (a: {left: number; top: number; width: number; height: number},
                      b: typeof a) =>
      a.left < b.left + b.width && b.left < a.left + a.width &&
      a.top < b.top + b.height && b.top < a.top + a.height;
    for (const n of [2, 3, 4, 7]) {
      const tiles = albumTiles(n, W, GAP);
      for (let i = 0; i < tiles.length; i++) {
        for (let j = i + 1; j < tiles.length; j++) {
          expect(overlaps(tiles[i], tiles[j])).toBe(false);
        }
      }
    }
  });

  it('every tile points at a distinct photo', () => {
    const idx = albumTiles(4, W, GAP).map(t => t.msgIndex);
    expect(new Set(idx).size).toBe(idx.length);
    expect(Math.max(...idx)).toBeLessThan(4);
  });

  it('reports the height the bubble must reserve', () => {
    for (const n of [2, 3, 4, 10]) {
      const tiles = albumTiles(n, W, GAP);
      const bottom = Math.max(...tiles.map(t => t.top + t.height));
      expect(albumHeight(n, W, GAP)).toBeCloseTo(bottom, 5);
    }
  });
});
