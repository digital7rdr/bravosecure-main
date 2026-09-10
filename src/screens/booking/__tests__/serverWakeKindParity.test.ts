/**
 * B-377 escape-hatch closer — server-emitted push kinds must have CLIENT handling.
 *
 * `serverWakeTapRouting` only diffs the two CLIENT maps against each other, so a
 * kind the SERVER emits with no client meta (mission-accepted/declined sat dark
 * for weeks — R-1) was invisible to every suite. This scan reads the producer
 * (booking-push-bridge) and asserts every kind it publishes is covered by:
 *   1. the wake banner map (AGENT_WAKE_META, or the hardcoded booking-approved branch),
 *   2. the bell backfill map (activitySync KIND_META),
 *   3. the tap router (fcmBootstrap).
 *
 * Static source scan (the node project can't import RN modules). Per the repo
 * scan rules: comments are STRIPPED first and reads are CRLF-safe.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Strip /* *\/ blocks and // line tails so prose can never satisfy (or fail) a scan. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => {
      const i = line.indexOf('//');
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join('\n');
}

/**
 * Kinds the bridge publishes. Anchored on `kind:` itself rather than "any
 * hyphenated token on a kind line", so a kind can neither be missed (making the
 * scan pass vacuously — the failure mode this suite exists to prevent) nor
 * confused with the coarse eventClass literal ('booking', 'mission', …) that
 * sits on the same line.
 *
 * Handles both shapes:
 *   {kind: 'x-y', …}
 *   {kind: cond ? 'a-b' : 'c-d', …}
 */
function serverKinds(): string[] {
  const src = stripComments(read('apps/auth-service/src/ops/booking-push-bridge.service.ts'));
  const kinds = new Set<string>();
  // Direct literal. `.` included: the enterprise join-loop kinds are dotted
  // ('enterprise.join.requested') — a hyphen-only class made them invisible to
  // this whole suite, which is exactly the vacuous pass it exists to prevent.
  for (const m of src.matchAll(/\bkind:\s*'([a-z0-9.-]+)'/g)) {kinds.add(m[1]);}
  // Ternary — capture BOTH arms.
  for (const m of src.matchAll(/\bkind:\s*[^'\n?]*\?\s*'([a-z0-9.-]+)'\s*:\s*'([a-z0-9.-]+)'/g)) {
    kinds.add(m[1]);
    kinds.add(m[2]);
  }
  return [...kinds].sort();
}

/** Keys of a `{'kebab-kind': {...}}` map between `const NAME` and its closing `};`. */
function mapKeys(rel: string, mapName: string): Set<string> {
  const src = stripComments(read(rel));
  const start = src.indexOf(`const ${mapName}`);
  if (start < 0) {throw new Error(`${mapName} not found in ${rel}`);}
  const end = src.indexOf('\n};', start);
  const block = src.slice(start, end >= 0 ? end : undefined);
  const keys = new Set<string>();
  for (const m of block.matchAll(/'([a-z0-9]+(?:[-.][a-z0-9]+)+)':\s*\{/g)) {
    keys.add(m[1]);
  }
  return keys;
}

const SERVER_KINDS = serverKinds();

describe('server push kinds ⊆ client handling (producer↔consumer parity)', () => {
  it('found a plausible number of server kinds (guard against a vacuous scan)', () => {
    expect(SERVER_KINDS.length).toBeGreaterThanOrEqual(25);
    expect(SERVER_KINDS).toContain('mission-accepted');
    expect(SERVER_KINDS).toContain('mission-declined');
    expect(SERVER_KINDS).toContain('mission-cancelled');
    expect(SERVER_KINDS).toContain('family-invite');
    expect(SERVER_KINDS).toContain('family-charge-blocked');
    // The extractor must key off `kind:`, never the coarse eventClass literal
    // that shares the line — those are NOT push kinds and would fail every map.
    expect(SERVER_KINDS).not.toContain('booking');
    expect(SERVER_KINDS).not.toContain('mission');
  });

  it('every publish() call site is covered by the extractor (no silent misses)', () => {
    // One kind per publish is the contract; if a future call site hides its kind
    // behind a variable this count diverges and the scan stops being vacuous.
    const src = stripComments(read('apps/auth-service/src/ops/booking-push-bridge.service.ts'));
    const publishCalls = [...src.matchAll(/this\.publish\(/g)].length;
    // -1: the private publish() definition itself is not a call site.
    expect(SERVER_KINDS.length).toBeGreaterThanOrEqual(publishCalls - 1);
  });

  it('every server kind has a wake-banner meta (AGENT_WAKE_META or the booking-approved branch)', () => {
    const meta = mapKeys('src/modules/messenger/push/serverWakeNotifications.ts', 'AGENT_WAKE_META');
    const missing = SERVER_KINDS.filter(k => k !== 'booking-approved' && !meta.has(k));
    expect(missing).toEqual([]);
  });

  it('every server kind has a bell-backfill meta (activitySync KIND_META) — raw-string rows are banned', () => {
    const meta = mapKeys('src/store/activitySync.ts', 'KIND_META');
    const missing = SERVER_KINDS.filter(k => !meta.has(k));
    expect(missing).toEqual([]);
  });

  it('every server kind is tap-routable (appears in fcmBootstrap routing)', () => {
    const src = stripComments(read('src/modules/messenger/push/fcmBootstrap.ts'));
    const missing = SERVER_KINDS.filter(k => !src.includes(`'${k}'`));
    expect(missing).toEqual([]);
  });
});
