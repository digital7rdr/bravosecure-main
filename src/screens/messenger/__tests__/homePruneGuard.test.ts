/**
 * B-703 MR-14 — the Home-focus prune must not eat a newborn server room.
 *
 * Every UUID-keyed local conversation missing from ONE `/conversations/mine`
 * response was removed with its messages, its media blobs and its group key,
 * and the id was tombstoned durably. The envelopes had already been acked, so
 * there is nothing left to redeliver: it is permanent data loss, triggered by a
 * single stale list response.
 *
 * The exposed population is exactly the server-minted rooms — mission Ops
 * Rooms, system channels — because client-minted groups are dashless 32-hex and
 * can never match `UUID_RE`. Those are also the rooms that arrive by fan-out
 * rather than by this list, so a snapshot taken before the server committed the
 * room and landing after its fan-out describes a room the server has and the
 * response does not.
 *
 * `MessengerHomeScreen` mounts RN views and pulls the whole messenger runtime,
 * so this is a source scan — comment-stripped LINE BY LINE (never with a
 * `/*...*​/` regex: these screens carry `/*` inside string and regex literals,
 * and the block stripper swallows real code from there to the next terminator)
 * and CRLF-safe.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SRC = readFileSync(
  join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx'), 'utf8',
);

const CODE = SRC
  .split(/\r?\n/)
  .filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l))
  .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
  .join('\n');

describe('B-703 MR-14 — the prune has an age guard', () => {
  it('still prunes, and still only UUID-shaped server ids', () => {
    expect(CODE).toContain('const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;');
    expect(CODE).toMatch(/if \(UUID_RE\.test\(localId\) && !serverIds\.has\(localId\)\)/);
    expect(CODE).toContain('st.removeConversation(localId);');
  });

  it('the age check sits BETWEEN the match and the destructive calls', () => {
    // Order is the whole property: a guard placed after removeGroupState has
    // already destroyed the key it was meant to protect.
    const match  = CODE.indexOf('if (UUID_RE.test(localId) && !serverIds.has(localId))');
    const guard  = CODE.indexOf('if (ageMs < PRUNE_MIN_AGE_MS) {continue;}', match);
    const evict  = CODE.indexOf('st.removeGroupState(localId);', match);
    const remove = CODE.indexOf('st.removeConversation(localId);', match);
    expect(match).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(match);
    expect(evict).toBeGreaterThan(guard);
    expect(remove).toBeGreaterThan(guard);
  });

  it('an unparseable or absent creation time counts as NEW, never as prunable', () => {
    // Absent evidence must not authorise an irreversible write. `Date.parse`
    // of undefined is NaN, so the age must fall back to 0 (brand new), not to
    // Date.now() (infinitely old).
    expect(CODE).toMatch(/const ageMs = Number\.isFinite\(createdAt\) \? Date\.now\(\) - createdAt : 0;/);
  });

  it('the grace comfortably outlasts the race it exists for', () => {
    const declared = /const PRUNE_MIN_AGE_MS = (\d+) \* 60_000;/.exec(CODE)?.[1];
    expect(declared).toBeDefined();
    expect(Number(declared)).toBeGreaterThanOrEqual(10);
  });
});
