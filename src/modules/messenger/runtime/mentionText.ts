/**
 * The @-mention text engine: one implementation shared by the composer (which
 * detects the trigger and inserts the label) and the bubble renderer (which
 * splits the body into highlight spans).
 *
 * Why label matching and not character offsets, which is the obvious design:
 * offsets are exact at compose time and WRONG the moment the body changes. This
 * app ships message editing, so a stored `{start, end}` would point at the
 * wrong span — or past the end of the string — for every edited message. Labels
 * are re-derived from the body at render time and cannot drift from it.
 *
 * The one hazard label matching introduces is prefix collision: with members
 * "Ali" and "Alice" in the room, matching "@Ali" first would highlight three
 * letters of a five-letter mention and leave "ce" as plain text. Sorting the
 * candidate labels LONGEST FIRST removes it — the specific case is pinned in
 * mentionText.test.ts and is the reason this is a module rather than an inline
 * regex.
 *
 * Tier A: no imports at all, so the node jest project can load it and the
 * renderer, the composer and the notifier all share ONE rule.
 */

export interface Mention {
  userId: string;
  label:  string;
}

/** Anything with a userId and a display name — the roster shape callers hold. */
export interface MentionCandidate {
  userId: string;
  label:  string;
}

export const MENTION_TRIGGER = '@';

/**
 * The composer's trigger detection: is the caret sitting in an active
 * `@query` token, and if so what has been typed after the `@`?
 *
 * Returns null when there is no active mention token. The rules exist to stop
 * the picker flickering open on ordinary text:
 *   - the `@` must start the message or follow whitespace, so an email address
 *     ("a@b.com") never triggers it;
 *   - a newline between the `@` and the caret ends the token;
 *   - a query ending in whitespace is CLOSED. Labels contain spaces
 *     ("Bob Rani"), so a space cannot end the token outright — but without
 *     this rule the space `insertMention` appends leaves the just-completed
 *     "@Alice " looking like a live query, and the picker re-opens on every
 *     single insertion. The cost is that "@Bob " momentarily hides the picker
 *     mid-way through typing a two-word name; it returns on the next
 *     character. That trade is deliberate — see the tests;
 *   - the query is capped, so a paragraph typed after a stray `@` stops
 *     searching the roster on every keystroke.
 */
export function findMentionQuery(
  text: string,
  caret: number = text.length,
): {query: string; start: number} | null {
  const end = Math.max(0, Math.min(caret, text.length));
  for (let i = end - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === MENTION_TRIGGER) {
      const before = i > 0 ? text[i - 1] : '';
      if (before && !/\s/.test(before)) {return null;}
      const query = text.slice(i + 1, end);
      if (query.length > MENTION_QUERY_MAX) {return null;}
      if (/\s$/.test(query)) {return null;}
      return {query, start: i};
    }
    // A mention label may contain spaces ("Bow Rani"), so a space alone does
    // not end the token — but a newline does, and so does a second `@`.
    if (ch === '\n') {return null;}
  }
  return null;
}

/**
 * How far past the `@` the composer keeps searching. A real display name is
 * short; without a cap, every keystroke of a long message typed after a stray
 * `@` re-filters the whole roster.
 */
export const MENTION_QUERY_MAX = 32;

/** Rank roster entries against the active query. Prefix matches first. */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  query: string,
  limit = 8,
): MentionCandidate[] {
  const q = query.trim().toLowerCase();
  if (!q) {return candidates.slice(0, limit);}
  const prefix: MentionCandidate[] = [];
  const infix:  MentionCandidate[] = [];
  for (const c of candidates) {
    const l = c.label.toLowerCase();
    if (l.startsWith(q)) {prefix.push(c);}
    else if (l.includes(q)) {infix.push(c);}
  }
  return [...prefix, ...infix].slice(0, limit);
}

/**
 * Replace the active `@query` token with `@Label ` and report the new caret.
 *
 * The trailing space is load-bearing: without it the very next character types
 * straight into the label, `findMentionQuery` re-opens the picker, and the
 * user has to dismiss it by hand after every mention.
 */
export function insertMention(
  text: string,
  token: {start: number; query: string},
  candidate: MentionCandidate,
): {text: string; caret: number} {
  const head = text.slice(0, token.start);
  const tail = text.slice(token.start + 1 + token.query.length);
  const inserted = `${MENTION_TRIGGER}${candidate.label} `;
  return {
    text:  head + inserted + tail,
    caret: head.length + inserted.length,
  };
}

/**
 * Keep only the mentions whose label still appears in the body.
 *
 * Called on send and on edit. Without it, mentioning someone and then deleting
 * the text by hand would still ship them a "you were mentioned" notification
 * for a message that does not name them.
 */
export function reconcileMentions(text: string, mentions: readonly Mention[]): Mention[] {
  const seen = new Set<string>();
  const out: Mention[] = [];
  for (const m of mentions) {
    if (!m.label) {continue;}
    if (seen.has(m.userId)) {continue;}
    if (!text.includes(MENTION_TRIGGER + m.label)) {continue;}
    seen.add(m.userId);
    out.push(m);
  }
  return out;
}

export type MentionSegment =
  | {kind: 'text'; text: string}
  | {kind: 'mention'; text: string; userId: string; isSelf: boolean};

/**
 * Split a body into plain and mention segments for the renderer.
 *
 * Longest label first — see the module header. Returns a single text segment
 * when there is nothing to highlight, so the common case allocates one object
 * and the renderer can skip its map entirely.
 */
export function segmentMentions(
  body: string,
  mentions: readonly Mention[] | undefined,
  selfUserId?: string | null,
): MentionSegment[] {
  if (!body) {return [];}
  if (!mentions?.length) {return [{kind: 'text', text: body}];}

  const byLabel = [...mentions]
    .filter(m => m.label)
    .sort((a, b) => b.label.length - a.label.length);
  if (!byLabel.length) {return [{kind: 'text', text: body}];}

  const out: MentionSegment[] = [];
  let cursor = 0;
  let plainFrom = 0;

  while (cursor < body.length) {
    // `find` over the longest-first list is what resolves a prefix collision:
    // with both "Ali" and "Alice" present, "@Alice" matches the longer label
    // and "ce" is never orphaned into a text segment.
    const hit = body[cursor] === MENTION_TRIGGER
      ? byLabel.find(m => body.startsWith(MENTION_TRIGGER + m.label, cursor))
      : undefined;
    if (!hit) {
      cursor++;
      continue;
    }
    const token = MENTION_TRIGGER + hit.label;
    if (cursor > plainFrom) {
      out.push({kind: 'text', text: body.slice(plainFrom, cursor)});
    }
    out.push({
      kind:   'mention',
      text:   token,
      userId: hit.userId,
      isSelf: !!selfUserId && hit.userId === selfUserId,
    });
    cursor += token.length;
    plainFrom = cursor;
  }
  if (plainFrom < body.length) {
    out.push({kind: 'text', text: body.slice(plainFrom)});
  }
  return out;
}

/** Does this message mention me? Drives the notification title and the badge. */
export function mentionsUser(
  mentions: readonly Mention[] | undefined,
  userId: string | null | undefined,
): boolean {
  if (!mentions?.length || !userId) {return false;}
  return mentions.some(m => m.userId === userId);
}

/**
 * B-271 — `@all`.
 *
 * A group-wide mention is a SYNTHETIC roster entry, not a real user. It carries
 * a sentinel userId so nothing downstream can mistake it for a person: the
 * notification fan-out, the "you were mentioned" check and the bubble
 * highlighter all key off userId, and a sentinel that happened to collide with
 * a real id would ping the wrong person forever.
 *
 * The sentinel is deliberately not a plausible id shape. Real ids here are
 * UUIDs or `direct:`-prefixed slots; nothing legitimate contains a `*`.
 */
export const MENTION_ALL_ID = '*all*';
export const MENTION_ALL_LABEL = 'all';

/** The synthetic candidate to offer at the top of a GROUP roster. */
export function mentionAllCandidate(): MentionCandidate {
  return {userId: MENTION_ALL_ID, label: MENTION_ALL_LABEL};
}

/**
 * Expand a picked `@all` into one mention per member, on the way out.
 *
 * Done at SEND time rather than at pick time so the composer keeps showing the
 * single "@all" chip the user typed instead of exploding into thirty labels the
 * moment they select it. The wire and the receiver therefore never see the
 * sentinel — they see the same per-member mention list any manual selection
 * would have produced, so every downstream consumer (notification fan-out,
 * mention highlight, reconcile-on-edit) works unchanged with no @all awareness.
 *
 * `memberIds` must EXCLUDE self: mentioning yourself would notify you about
 * your own message. Duplicates are collapsed so `@all` plus an explicit
 * `@Alice` does not ping Alice twice.
 */
export function expandAllMentions(
  mentions: readonly Mention[],
  memberIds: readonly string[],
  labelFor: (userId: string) => string,
): Mention[] {
  if (!mentions.some(m => m.userId === MENTION_ALL_ID)) {
    return mentions.slice();
  }
  const out: Mention[] = [];
  const seen = new Set<string>();
  for (const m of mentions) {
    if (m.userId === MENTION_ALL_ID) {
      for (const uid of memberIds) {
        if (!uid || seen.has(uid)) {continue;}
        seen.add(uid);
        out.push({userId: uid, label: labelFor(uid)});
      }
      continue;
    }
    if (seen.has(m.userId)) {continue;}
    seen.add(m.userId);
    out.push(m);
  }
  return out;
}
