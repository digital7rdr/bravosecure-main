/**
 * F13 — Day Status client/server/DB contract (FLIPPED 2026-08-07: the six
 * PDF statuses landed — emergency_leave + mission added end-to-end).
 *
 * THE COPY LEDGER this test binds together, by reading each side's OWN source
 * rather than restating the list (so it fails the day a chip ships without
 * the migration, AND the day the server widens without the client following):
 *   - client chips: DayStatusScreen's DAY_STATUSES array;
 *   - server DTO: DAY_STATUSES in dto/attendance.dto.ts (the @IsIn source);
 *   - DB CHECK: 20260807100000_day_status_v2.sql (the AUTHORITATIVE
 *     constraint since the widening — the 2026-06 original is superseded);
 *   - the service's two marker IN-lists (the delete-then-insert upsert), whose
 *     ORDER must equal the DTO's (a fifth value missing there makes re-marking
 *     STACK markers instead of replacing them — a data bug, not a 400).
 * CORRECTABLE_STATUSES and the full 10-value domain are gated by roster.spec's
 * toBe(10) drift gate; the rollup's skip-list is gated HERE (last test).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function read(...parts: string[]): string {
  return readFileSync(join(process.cwd(), ...parts), 'utf8').replace(/\r\n/g, '\n');
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('--'))
    .join('\n');
}

/** The values the CLIENT offers, parsed from the screen's own array. */
function clientStatuses(): string[] {
  const src = stripComments(read('src', 'screens', 'deptchat', 'DayStatusScreen.tsx'));
  const m = /const DAY_STATUSES: DayStatus\[\] = \[([^\]]*)\]/.exec(src);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

/** The values the SERVER accepts, parsed from the DTO's own DAY_STATUSES
 *  const (the @IsIn source since the batch DTO landed). */
function serverStatuses(): string[] {
  const src = stripComments(read('apps', 'auth-service', 'src', 'attendance', 'dto', 'attendance.dto.ts'));
  const m = /export const DAY_STATUSES = \[([^\]]*)\]/.exec(src);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

/** The values the DATABASE allows, parsed from the migration's CHECK.
 *  Comment-stripped like its two siblings: the DOWN-migration comment carries
 *  the OLD 8-value list, and first-match-wins is a trap, not a guarantee. */
function dbStatuses(): string[] {
  const src = stripComments(read('supabase', 'migrations', '20260807100000_day_status_v2.sql'));
  const m = /attendance_status IN\s*\(([^)]*)\)/.exec(src);
  expect(m).not.toBeNull();
  return [...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]);
}

describe('F13 — Day Status offers only what the server can store', () => {
  it('the parsers found real lists (guards against three empty matches)', () => {
    expect(clientStatuses().length).toBeGreaterThan(0);
    expect(serverStatuses().length).toBeGreaterThan(0);
    expect(dbStatuses().length).toBeGreaterThan(0);
  });

  it('every status the client offers is accepted by the DTO', () => {
    const server = serverStatuses();
    for (const s of clientStatuses()) {
      expect(server).toContain(s);
    }
  });

  it('every status the client offers survives the database CHECK', () => {
    const db = dbStatuses();
    for (const s of clientStatuses()) {
      expect(db).toContain(s);
    }
  });

  /** F13 FLIPPED (2026-08-07): the six PDF statuses, in the PDF's order,
   *  end-to-end. Exact toEqual — a seventh chip or a dropped one fails. */
  it('the client offers exactly the six PDF statuses', () => {
    expect(clientStatuses()).toEqual(
      ['leave', 'sick_leave', 'emergency_leave', 'off_duty', 'absent', 'mission']);
    expect(serverStatuses()).toEqual(clientStatuses());
  });

  /**
   * The upsert in `setDayStatus` DELETEs the day's marker before inserting, and
   * it enumerates the statuses it may delete. That list is a SECOND place the
   * four values live, so widening the DTO alone would make re-marking STACK
   * markers instead of replacing them — the reason F13 is not a one-line change.
   */
  it('the delete-then-insert upsert enumerates the same six values, in the same order', () => {
    // Scoped to setDayStatus (a future unrelated IN-predicate elsewhere in the
    // service must not trip a gate about the MARKER lists).
    const svc = stripComments(read('apps', 'auth-service', 'src', 'attendance', 'attendance.service.ts'));
    const slice = svc.slice(svc.indexOf('async setDayStatus('), svc.indexOf('async disputeSession('));
    const lists = [...slice.matchAll(/attendance_status IN \(([^)]*)\)/g)]
      .map(m => [...m[1].matchAll(/'([a-z_]+)'/g)].map(x => x[1]));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    for (const l of lists) {
      expect(l).toEqual(serverStatuses());
    }
  });

  /**
   * THE ROLLUP IS THE FOURTH COPY, and it was gated by NOTHING (F review
   * MEDIUM-5): a widened DTO with an unwidened rollup skip-list means the
   * nightly sweep marks members ABSENT on days a manager explicitly marked —
   * the exact D6-c bug the list exists to prevent.
   */
  it('the rollup auto-absent skip-list carries the same six values', () => {
    const rollup = stripComments(read('apps', 'auth-service', 'src', 'attendance', 'attendance-rollup.service.ts'));
    const m = /attendance_status IN \(([^)]*)\)/.exec(rollup);
    expect(m).not.toBeNull();
    expect([...m![1].matchAll(/'([a-z_]+)'/g)].map(x => x[1])).toEqual(serverStatuses());
  });
});
