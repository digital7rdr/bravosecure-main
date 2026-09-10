/**
 * B-287 / B-288 — photos in a thread, as a set rather than N loose messages.
 *
 * Founder, two requests that turn out to be one idea:
 *   "when images are sent multiple like WhatsApp they are like one album, they
 *    are not coming one by one"
 *   "when one image opens, if we swipe right or left we should see the next or
 *    previous image"
 *
 * Both need the same thing the chat never had: an ORDER over the pictures in a
 * conversation. Grouping is how it is drawn, paging is how it is browsed, and
 * they must agree — an album that shows 4 tiles the swipe cannot reach would be
 * worse than no album.
 *
 * Pure (no React, no react-native) so the node project can test it for real,
 * same convention as `chatListItems.ts` / `chatListLayout.ts` next door.
 *
 * WIRE FORMAT IS UNCHANGED. Each photo is still its own sealed-sender message
 * with its own AES key; this module only decides how existing rows are drawn
 * and traversed. A real multi-part album would change the envelope shape, which
 * is a documented stop condition — do not "improve" this by inventing one.
 */
import type {LocalMessage} from '../store';

/**
 * How far apart two photos can be and still read as one send. Generous,
 * because each photo is uploaded and encrypted separately: on a slow link a
 * five-photo batch can dribble in over most of a minute, and the user who
 * picked them in one gesture still thinks of them as one thing.
 */
export const ALBUM_WINDOW_MS = 60_000;
/** Tiles drawn before the grid collapses into a "+N" overlay on the last one. */
export const ALBUM_MAX_TILES = 4;
/** Below this it is just a photo, and a 1-cell "grid" would only add chrome. */
export const ALBUM_MIN_SIZE = 2;

/** A message that renders as a picture tile. */
export function isVisualMessage(m: LocalMessage): boolean {
  // Videos are deliberately EXCLUDED. They need a play affordance and a poster
  // frame, and mixing them into a photo grid produces tiles that look tappable
  // in one way and behave in another. Photos only, until video posters exist.
  return m.type === 'image';
}

/**
 * Can these two adjacent messages sit in one album?
 *
 * Same sender, both photos, close in time. Note what is NOT here: read state,
 * status ticks and reactions all mutate in place, and keying grouping on them
 * would re-group the thread every time a receipt landed.
 */
function groupsWith(prev: LocalMessage, next: LocalMessage): boolean {
  if (!isVisualMessage(prev) || !isVisualMessage(next)) {return false;}
  if (prev.sender_id !== next.sender_id) {return false;}
  // A caption makes a photo a statement rather than one of a set — WhatsApp
  // breaks the album there too, and merging them would hide the text.
  if (hasCaption(next) || hasCaption(prev)) {return false;}
  const a = new Date(prev.created_at).getTime();
  const b = new Date(next.created_at).getTime();
  if (!isFinite(a) || !isFinite(b)) {return false;}
  return Math.abs(b - a) <= ALBUM_WINDOW_MS;
}

function hasCaption(m: LocalMessage): boolean {
  const c = (m.content ?? '').trim();
  if (!c) {return false;}
  // The filename lands in `content` for attachments that carry no caption, and
  // echoing "IMG_20260726_113045.jpg" under a tile is noise, not a statement.
  return c !== (m.media_meta?.name ?? '');
}

/**
 * Split a chronological run of messages into albums.
 *
 * Returns, for each input index, the album it belongs to — or null when the
 * message stands alone. Callers render the FIRST member as a grid and skip the
 * rest; `albumLeaderIds` is the convenience wrapper for that.
 */
export function groupAlbums(
  messages: ReadonlyArray<LocalMessage>,
): Array<ReadonlyArray<LocalMessage>> {
  const out: Array<LocalMessage[]> = [];
  let run: LocalMessage[] = [];
  const flush = () => {
    if (run.length >= ALBUM_MIN_SIZE) {out.push(run);}
    run = [];
  };
  for (const msg of messages) {
    if (run.length === 0) {
      if (isVisualMessage(msg) && !hasCaption(msg)) {run = [msg];}
      continue;
    }
    if (groupsWith(run[run.length - 1], msg)) {
      run.push(msg);
      continue;
    }
    flush();
    if (isVisualMessage(msg) && !hasCaption(msg)) {run = [msg];}
  }
  flush();
  return out;
}

/**
 * Album membership by message id: leader id + the album for every member.
 *
 * A Map keyed by id (not by object) because the store replaces a message object
 * on every status flip; an identity-keyed map would miss the replacement and
 * silently un-group the album mid-delivery.
 */
export function albumIndex(
  messages: ReadonlyArray<LocalMessage>,
): Map<string, {leaderId: string; album: ReadonlyArray<LocalMessage>}> {
  const idx = new Map<string, {leaderId: string; album: ReadonlyArray<LocalMessage>}>();
  for (const album of groupAlbums(messages)) {
    const leaderId = album[0].id;
    for (const m of album) {idx.set(m.id, {leaderId, album});}
  }
  return idx;
}

/**
 * Every photo in the thread, oldest first — the order the viewer pages through.
 *
 * Deliberately the WHOLE conversation, not just the tapped album: opening a
 * photo and swiping to the one before it is what a gallery does, and stopping
 * at an album boundary would feel like a dead end for a reason the user cannot
 * see. Captioned photos are included here even though they never group.
 */
export function visualMessageIds(
  messages: ReadonlyArray<LocalMessage>,
): string[] {
  return messages.filter(isVisualMessage).map(m => m.id);
}

/**
 * The id `direction` steps away from `currentId`, or null at the ends.
 *
 * Does NOT wrap. Wrapping from the last photo back to the first makes it
 * impossible to feel where the set ends, and the founder's ask is next and
 * previous, not a carousel.
 */
export function stepVisual(
  ids: ReadonlyArray<string>,
  currentId: string,
  direction: -1 | 1,
): string | null {
  const at = ids.indexOf(currentId);
  if (at < 0) {return null;}
  const next = at + direction;
  if (next < 0 || next >= ids.length) {return null;}
  return ids[next];
}

/** Tiles to draw, and the "+N" to overlay on the last one (0 = no overlay). */
export function albumLayout(size: number): {tiles: number; overflow: number} {
  if (size <= ALBUM_MAX_TILES) {return {tiles: size, overflow: 0};}
  return {tiles: ALBUM_MAX_TILES, overflow: size - ALBUM_MAX_TILES};
}

/** One tile's box inside an album grid, plus the "+N" it may carry. */
export type AlbumTile = {
  msgIndex: number;
  left:     number;
  top:      number;
  width:    number;
  height:   number;
  /** >0 on the last tile when photos are hidden behind it. */
  overflow: number;
};

/**
 * Mosaic geometry for an album, in points, given the bubble's inner width.
 *
 * Absolute boxes rather than flex rows because the 3-photo case is not a grid:
 * WhatsApp draws one tall photo beside two stacked ones, and expressing that in
 * nested flex containers costs two extra native views per album on a screen
 * whose measured bottleneck (B-279) is view MOUNTING, not layout maths.
 *
 *   2      3          4+
 *   [A|B]  [A|B]      [A|B]
 *          [A|C]      [C|D]  ← D carries "+N"
 */
export function albumTiles(count: number, width: number, gap = 3): AlbumTile[] {
  const {tiles, overflow} = albumLayout(count);
  const half = (width - gap) / 2;
  const box = (msgIndex: number, left: number, top: number, w: number, h: number, over = 0): AlbumTile =>
    ({msgIndex, left, top, width: w, height: h, overflow: over});

  if (tiles <= 1) {return [box(0, 0, 0, width, width, overflow)];}
  if (tiles === 2) {
    // A 4:3-ish pair reads better than two squares at bubble width.
    const h = half;
    return [box(0, 0, 0, half, h), box(1, half + gap, 0, half, h, overflow)];
  }
  if (tiles === 3) {
    const tall = half * 2 + gap;
    return [
      box(0, 0, 0, half, tall),
      box(1, half + gap, 0, half, half),
      box(2, half + gap, half + gap, half, half, overflow),
    ];
  }
  return [
    box(0, 0, 0, half, half),
    box(1, half + gap, 0, half, half),
    box(2, 0, half + gap, half, half),
    box(3, half + gap, half + gap, half, half, overflow),
  ];
}

/** Total height the mosaic occupies, so the bubble can reserve it. */
export function albumHeight(count: number, width: number, gap = 3): number {
  const tiles = albumTiles(count, width, gap);
  return tiles.reduce((max, t) => Math.max(max, t.top + t.height), 0);
}
