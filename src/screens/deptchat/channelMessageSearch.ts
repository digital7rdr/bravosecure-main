/**
 * B-636 (client, 2026-08-23) — "this search option should allow you to also
 * search for conversations or words in conversations that's inside the chats."
 *
 * The Channels tab's search box filtered CHANNEL NAMES only (B-625). This
 * module is the decision half of the second answer it now gives: the messages
 * inside those channels.
 *
 * ── WHY THE LOGIC LIVES HERE AND NOT IN THE SCREEN ────────────────────────
 *
 * B-623's review caught three realistic mutations surviving a green run because
 * the only thing pinning them was a source scan, and a scan proves a helper is
 * CALLED, never that its answer is used. Everything here is a pure function
 * over plain data, so the tests execute the real decision instead of asserting
 * that a line of code exists.
 *
 * ── SCOPE IS A MAP, AND THE MAP IS THE SECOND BELT ────────────────────────
 *
 * `SqlMessageStore.searchContent` already restricts the query to an explicit
 * conversation-id allow-list. `channelMessageHits` then DROPS any row whose
 * conversation is not in the caller's channel map — so even a leaked row can
 * never be rendered, and the organisation separation the founder asked for
 * ("different organization channels must never mix") survives a bug in the
 * layer below it rather than depending on that layer being correct.
 */

/** The minimum query length that triggers a message search.
 *
 *  The NAME filter still runs from one character — that half is a cheap
 *  in-memory scan over a few dozen rows. A body scan touches every message on
 *  the device, and a single letter matches most of them, so it would spend the
 *  whole budget to return noise. */
export const MESSAGE_SEARCH_MIN_CHARS = 2;

/** How many message hits are fetched and rendered, newest-first.
 *
 *  Deliberately NOT paginated: a search box answers "where did I see that",
 *  and an answer that is 30 rows long has already failed to answer it — the
 *  user narrows the query instead. */
export const MESSAGE_SEARCH_LIMIT = 30;

/** Characters of context kept either side of the match in a preview row. */
export const SNIPPET_RADIUS = 32;

/** The identity a hit needs to render and to open. `orgId` is what keeps the
 *  hit list separated by organisation, exactly like the channel tree above it. */
export interface ChannelRef {
  channelId: string;
  channelName: string;
  orgId: string | null;
}

/** The structural subset of `LocalMessage` this module reads. Kept structural
 *  so a screen helper does not pull the messenger store's types — and so the
 *  tests can build a row without one. */
export interface SearchableMessage {
  id: string;
  conversation_id: string;
  content?: string | null;
  created_at: string;
}

/** A body split around the matched term, ready to render with the middle
 *  highlighted. */
export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export interface ChannelMessageHit extends ChannelRef {
  messageId: string;
  conversationId: string;
  createdAt: string;
  snippet: Snippet;
}

/** Is this query worth a body scan? See `MESSAGE_SEARCH_MIN_CHARS`. */
export function shouldSearchMessages(query: string): boolean {
  return query.trim().length >= MESSAGE_SEARCH_MIN_CHARS;
}

/**
 * A one-line preview centred on the match, or null when the term is not in the
 * body.
 *
 * Returning NULL rather than an un-highlighted line is load-bearing: it is the
 * client-side check that the row actually contains what was typed. SQL `LIKE`
 * is ASCII-case-insensitive and locale-blind, so it can answer differently from
 * the fold below; a row the two disagree about is dropped rather than rendered
 * with nothing highlighted, which reads as a false positive.
 *
 * ⚠️ CASE-FOLDING CAN CHANGE LENGTH (`İ`.toLowerCase() is two code units), and
 * an index taken from a folded string then points at the wrong character of the
 * original — a snippet sliced mid-word, or a RangeError at the end. When the
 * fold is not length-preserving this falls back to an exact match, which is
 * narrower but never wrong.
 */
export function buildSnippet(
  content: string,
  query: string,
  radius: number = SNIPPET_RADIUS,
): Snippet | null {
  // Newlines and runs of spaces are collapsed FIRST, so the offsets computed
  // below index the string that is actually rendered.
  const flat = content.replace(/\s+/g, ' ').trim();
  const term = query.trim();
  if (!flat || !term) {return null;}

  const hay = flat.toLocaleLowerCase();
  const needle = term.toLocaleLowerCase();
  const foldable = hay.length === flat.length && needle.length === term.length;
  const idx = foldable ? hay.indexOf(needle) : flat.indexOf(term);
  if (idx < 0) {return null;}
  const matchLen = foldable ? needle.length : term.length;

  const start = Math.max(0, idx - radius);
  const end = Math.min(flat.length, idx + matchLen + radius);
  return {
    before: (start > 0 ? '…' : '') + flat.slice(start, idx),
    match: flat.slice(idx, idx + matchLen),
    after: flat.slice(idx + matchLen, end) + (end < flat.length ? '…' : ''),
  };
}

/**
 * Message rows → renderable hits, in the order they arrived (the store returns
 * newest-first) and capped.
 *
 * A row whose conversation is absent from `channelByConversationId` is DROPPED,
 * not rendered under a placeholder name — see this module's header. So is a row
 * whose body no longer contains the term (`buildSnippet` returning null).
 */
export function channelMessageHits(
  messages: readonly SearchableMessage[],
  channelByConversationId: ReadonlyMap<string, ChannelRef>,
  query: string,
  limit: number = MESSAGE_SEARCH_LIMIT,
): ChannelMessageHit[] {
  if (limit <= 0 || !shouldSearchMessages(query)) {return [];}
  const out: ChannelMessageHit[] = [];
  for (const m of messages) {
    if (out.length >= limit) {break;}
    const ref = channelByConversationId.get(m.conversation_id);
    if (!ref) {continue;}
    const snippet = buildSnippet(m.content ?? '', query);
    if (!snippet) {continue;}
    out.push({
      ...ref,
      messageId: m.id,
      conversationId: m.conversation_id,
      createdAt: m.created_at,
      snippet,
    });
  }
  return out;
}

/**
 * Hits split by owning organisation, in the caller's organisation order.
 *
 * B-624 — "Different organization channels must never mix… It must ALWAYS be
 * separate here." The channel tree obeys that by rendering one tree per
 * organisation; a flat hit list underneath it would reintroduce exactly the
 * pile that fix removed, so the message half is sectioned the same way and by
 * the same ordering.
 *
 * An organisation the caller did not list still gets a section, appended in
 * first-seen order — dropping it would silently hide a real result, and this
 * function is presentation, never a visibility decision.
 */
export function groupHitsByOrg(
  hits: readonly ChannelMessageHit[],
  orgOrder: ReadonlyArray<string | null>,
): Array<{orgId: string | null; hits: ChannelMessageHit[]}> {
  if (hits.length === 0) {return [];}
  const byOrg = new Map<string | null, ChannelMessageHit[]>();
  const order: Array<string | null> = [];
  const seed = (key: string | null): ChannelMessageHit[] => {
    let bucket = byOrg.get(key);
    if (!bucket) {
      bucket = [];
      byOrg.set(key, bucket);
      order.push(key);
    }
    return bucket;
  };
  for (const key of orgOrder) {seed(key);}
  for (const h of hits) {seed(h.orgId).push(h);}
  return order
    .map(key => ({orgId: key, hits: byOrg.get(key) as ChannelMessageHit[]}))
    .filter(s => s.hits.length > 0);
}
