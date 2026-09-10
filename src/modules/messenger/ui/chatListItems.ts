/**
 * MX-05 — pure builders for the ChatScreen message list. Free of React /
 * react-native imports so the interleave + inversion logic is
 * unit-testable in a node env (same convention as chatListLayout.ts).
 *
 * The chat FlatList is INVERTED (index 0 renders at the visual bottom =
 * newest message), which is how WhatsApp/Signal land at the bottom
 * instantly with zero scroll-to-end hacks. Items are therefore built in
 * chronological order (so day separators and the unread divider slot in
 * exactly as before) and then REVERSED for display: reversal flips
 * render order, so a separator pushed BEFORE a day's first message still
 * paints ABOVE it on screen.
 */
import type {LocalMessage} from '../store';
import {unreadDividerIndex} from './chatListLayout';
import {albumIndex} from './imageAlbums';

export type ChatListItem =
  | {
      kind: 'msg';
      key: string;
      msg: LocalMessage;
      index: number;
      /**
       * B-288 — when this photo leads an album, every photo in it (including
       * this one). The row still carries the LEADER message, so sender name,
       * timestamp, ticks, reactions and the long-press menu all keep working
       * unchanged; only the body paints a grid instead of one picture.
       */
      album?: ReadonlyArray<LocalMessage>;
    }
  | {kind: 'day'; key: string; label: string}
  | {kind: 'unread'; key: string; count: number};

/**
 * MX-07 — identity-stable rows. A single status/receipt flip replaces
 * one message object; every other row object is reused verbatim so
 * FlatList's cell memoisation (and the MessageBubble comparator) can
 * bail out on reference equality instead of re-walking props.
 */
const msgItemCache = new WeakMap<LocalMessage, Extract<ChatListItem, {kind: 'msg'}>>();
const sepItemCache = new Map<string, ChatListItem>();
// Why: day keys are date-strings shared across conversations; the cache
// can only grow by distinct days/unread anchors, but cap it anyway so a
// pathological long session can't accumulate unbounded entries.
const SEP_CACHE_MAX = 512;

/**
 * B-288 — album grouping, memoised on the message array's identity.
 *
 * `albumIndex` mints fresh arrays on every call, so without this the album a
 * leader row carries would be a new object each render, `msgItem`'s identity
 * check would never hit, and EVERY photo row would re-render on every store
 * touch — a regression in exactly the area (MX-07 identity stability) that
 * makes long threads scroll. The store hands back a referentially stable array
 * when nothing changed, which is what makes a WeakMap the right cache here: it
 * hits precisely when nothing changed and cannot leak, because the entry dies
 * with the array it describes.
 */
const albumCache = new WeakMap<
  ReadonlyArray<LocalMessage>,
  ReturnType<typeof albumIndex>
>();

function albumsFor(messages: ReadonlyArray<LocalMessage>) {
  const hit = albumCache.get(messages);
  if (hit) {return hit;}
  const built = albumIndex(messages);
  albumCache.set(messages, built);
  return built;
}

function msgItem(
  msg: LocalMessage,
  index: number,
  album?: ReadonlyArray<LocalMessage>,
): ChatListItem {
  const cached = msgItemCache.get(msg);
  // The album is part of the row's identity: a burst that is still arriving
  // grows its leader's album, and reusing the cached row on index alone would
  // freeze the grid at whatever size it had when the first photo landed.
  if (cached && cached.index === index && cached.album === album) {return cached;}
  const item = {kind: 'msg' as const, key: msg.id, msg, index, album};
  msgItemCache.set(msg, item);
  return item;
}

function sepItem(item: Extract<ChatListItem, {kind: 'day'} | {kind: 'unread'}>): ChatListItem {
  const cached = sepItemCache.get(item.key);
  if (cached) {
    if (cached.kind === 'day' && item.kind === 'day' && cached.label === item.label) {return cached;}
    if (cached.kind === 'unread' && item.kind === 'unread' && cached.count === item.count) {return cached;}
  }
  if (sepItemCache.size >= SEP_CACHE_MAX) {sepItemCache.clear();}
  sepItemCache.set(item.key, item);
  return item;
}

/**
 * Chronological interleave: one day separator per day boundary + a
 * one-shot "Unread N messages" divider at the boundary where the user
 * left off (Rank 13 semantics, unchanged from the pre-inverted list).
 */
export function buildChatListItems(
  messages: ReadonlyArray<LocalMessage>,
  initialUnread: number,
): ChatListItem[] {
  const out: ChatListItem[] = [];
  const unreadStart = unreadDividerIndex(messages, initialUnread);
  const albums = albumsFor(messages);
  let lastDayKey: string | null = null;
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const album = albums.get(msg.id);
    // B-288 — a burst of photos paints as ONE grid on its first member. The
    // followers emit no row at all rather than an empty one: a zero-height cell
    // still costs FlatList a mount and would break the unread count below.
    if (album && album.leaderId !== msg.id) {continue;}
    const d = new Date(msg.created_at);
    const dayKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    if (dayKey !== lastDayKey) {
      lastDayKey = dayKey;
      out.push(sepItem({kind: 'day', key: `day:${dayKey}`, label: formatDaySep(d)}));
    }
    if (i === unreadStart) {
      out.push(sepItem({kind: 'unread', key: `unread:${msg.id}`, count: initialUnread}));
    }
    out.push(msgItem(msg, i, album?.album));
  }
  return out;
}

/** Display order for the inverted FlatList: newest first (index 0 = visual bottom). */
export function buildInvertedChatListItems(
  messages: ReadonlyArray<LocalMessage>,
  initialUnread: number,
): ChatListItem[] {
  return buildChatListItems(messages, initialUnread).reverse();
}

export function sameDay(a: string, b: string): boolean {
  const da = new Date(a);
  const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
      && da.getMonth()    === db.getMonth()
      && da.getDate()     === db.getDate();
}

/**
 * Day-separator label. Yesterday/Today get friendly names; older dates
 * paint as "Mon, Mar 5" so the column stays narrow. Compared against
 * the actual clock at render time so the labels stay correct as the
 * day rolls over with a chat still open.
 */
export function formatDaySep(d: Date): string {
  const now = new Date();
  const sameDayAsNow = d.getFullYear() === now.getFullYear()
                    && d.getMonth()    === now.getMonth()
                    && d.getDate()     === now.getDate();
  if (sameDayAsNow) {return 'Today';}
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  const isYesterday = d.getFullYear() === yest.getFullYear()
                   && d.getMonth()    === yest.getMonth()
                   && d.getDate()     === yest.getDate();
  if (isYesterday) {return 'Yesterday';}
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, {weekday: 'short', month: 'short', day: 'numeric'});
  }
  return d.toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});
}
