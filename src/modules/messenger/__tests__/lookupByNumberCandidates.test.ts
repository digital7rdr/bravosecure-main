/**
 * B-246, client half — "search with a number to message someone says
 * no account found. I can't find that person to message."
 *
 * `startChatByNumber` sent exactly ONE candidate: the E.164 normalisation of
 * what was typed, using a calling code derived from the SEARCHER'S OWN phone.
 * That dead-ends twice:
 *
 *   1. A few accounts predate E.164 normalisation and store the number
 *      nationally. The server can rescue those, but only if it is handed the
 *      national digits to compare against.
 *   2. A searcher whose own phone is one of those rows gets no calling code
 *      back, so `normalizeBatch` returns null and a perfectly good local
 *      number was rejected before any request was made.
 *
 * NewChatScreen mounts RN + a Modal, so this is a source scan.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'NewChatScreen.tsx');

/** CODE lines only. Line-based, so CRLF cannot make an assertion vacuous. */
function code(): string {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(SCREEN, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

/** The body of startChatByNumber, so nothing elsewhere satisfies these. */
function body(): string {
  const src = code();
  const start = src.indexOf('const startChatByNumber');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\n  return (', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-246 — the by-number lookup sends more than one candidate', () => {
  it('derives the NATIONAL form as well as the E.164 one', () => {
    const b = body();
    expect(b).toMatch(/const national = numberInput\.replace\(/);
    expect(b).toMatch(/const candidates = \[/);
  });

  it('the request carries the candidate list, not a single value', () => {
    // `usersClient.lookup([e164])` is the whole bug.
    const b = body();
    expect(b).toMatch(/usersClient\.lookup\(candidates\)/);
    expect(b).not.toMatch(/usersClient\.lookup\(\[e164\]\)/);
  });

  it('a missing calling code no longer rejects the search outright', () => {
    // Previously `if (!e164) { setLookupError(...); return; }` — a hard stop
    // before any request, which is what a searcher with a legacy phone hit on
    // every single lookup.
    const b = body();
    expect(b).not.toMatch(/if \(!e164\) \{/);
    expect(b).toMatch(/if \(candidates\.length === 0\)/);
  });

  it('an exact E.164 hit is preferred over a national-format one', () => {
    // The server only falls back per-unmatched-candidate, but a batch can
    // carry both kinds and the exact one is always more trustworthy.
    expect(body()).toMatch(/hits\.find\(h => h\.phone === e164\) \?\? hits\[0\]/);
  });

  it('the own-number guard survives a null e164', () => {
    // It used to compare `e164 === currentUser?.phone_e164`, which silently
    // stops guarding once e164 can be null — so a user could open a chat with
    // themselves. Backed up by an id check on the resolved hit.
    const b = body();
    expect(b).toMatch(/e164 && e164 === currentUser\?\.phone_e164/);
    expect(b).toMatch(/hit\.userId === currentUser\?\.id/);
  });

  it('the short-number floor matches the server\'s', () => {
    // Below 8 digits the server refuses to compare nationals at all, so
    // sending them would just be noise — and the floor is what keeps a typo
    // away from the junk rows in the table.
    expect(body()).toMatch(/national\.length >= 8/);
  });

  it('the conversation is keyed off the RESOLVED hit, not the typed text', () => {
    // A legacy row's stored phone differs from what the searcher typed;
    // writing the typed value would fork the thread identity.
    const b = body();
    expect(b).toMatch(/phoneE164:\s*hit\.phone \?\? e164/);
    expect(b).not.toMatch(/phoneE164:\s*e164,/);
  });
});
