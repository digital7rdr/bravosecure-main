/**
 * Static source-scan regression for Issue 24 (Testing Issues V2, PDF p.29) —
 * "My Bookings Menu Item Does Not Open Booking History".
 *
 * Three separate menus offer a "My Bookings" row and all three disagreed on the
 * destination:
 *   - ProfileDrawerModal  -> SecureTab/BookingHome   (the NEW-BOOKING WIZARD)
 *   - DashboardScreen     -> SecureTab/BookingHome   (same)
 *   - ProfileScreen       -> TripHistory
 * Routing to BookingHome is a no-op when the user is already on it (the default
 * SecureTab landing), so the drawer just closed and nothing happened.
 *
 * BookingHistory is the canonical destination: it is the only screen that lists
 * every booking and maps all 11 backend BookingStatus values via describeStatus()
 * (bookingStatus.ts), and it resumes an in-flight booking via resumeTargetFor().
 *
 * These three files are RN components the node `booking` project cannot import,
 * so the rule is pinned by reading the source — same pattern as
 * liveTrackerDockSend.test.ts / assignCrewFilter.test.ts.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

/**
 * Each site names the file plus how to find the CODE that carries the
 * destination. ProfileDrawerModal and ProfileScreen put it on the menu-row
 * literal; DashboardScreen declares the row with an `action` tag and resolves
 * it in a switch further down, so its destination lives in the case block.
 */
const SITES = [
  {
    label: 'ProfileDrawerModal',
    file: join(ROOT, 'src', 'components', 'ProfileDrawerModal.tsx'),
    kind: 'row',
  },
  {
    label: 'DashboardScreen',
    file: join(ROOT, 'src', 'screens', 'dashboard', 'DashboardScreen.tsx'),
    kind: 'switch',
  },
  {
    label: 'ProfileScreen',
    file: join(ROOT, 'src', 'screens', 'settings', 'ProfileScreen.tsx'),
    kind: 'row',
  },
] as const;

/** Source with CRLF normalised — these files are CRLF, so a `\n`-anchored
 *  regex would match nothing and every assertion would pass VACUOUSLY. */
function source(file: string): string {
  return readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** Comments stripped — prose mentioning "BookingHome" must never satisfy or
 *  break an assertion about CODE. */
function code(file: string): string {
  return source(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The CODE that carries the "My Bookings" destination for a given site. */
function destinationCode(file: string, kind: 'row' | 'switch'): string {
  const src = code(file);
  if (kind === 'row') {
    const line = src.split('\n').find(l => /['"]My Bookings['"]/.test(l));
    expect(line).toBeDefined();
    return line as string;
  }
  // 'switch' — the row is tagged `action: 'bookings'` and resolved in a
  // `case 'bookings':` block. Assert BOTH halves still exist, then return the
  // case body so a renamed tag can never make this pass vacuously.
  expect(src).toMatch(/['"]My Bookings['"][\s\S]{0,120}?action:\s*'bookings'/);
  const start = src.indexOf("case 'bookings':");
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('break;', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('Issue 24 — every "My Bookings" menu row opens BookingHistory', () => {
  it.each(SITES.map(s => [s.label, s.file, s.kind] as const))(
    '%s routes My Bookings to BookingHistory',
    (_label, file, kind) => {
      expect(destinationCode(file, kind)).toContain('BookingHistory');
    },
  );

  it.each(SITES.map(s => [s.label, s.file, s.kind] as const))(
    '%s does NOT route My Bookings to the booking wizard or TripHistory',
    (_label, file, kind) => {
      const dest = destinationCode(file, kind);
      // BookingHome starts a NEW booking; TripHistory is the agent-facing
      // "Activity History". Neither is the client's booking list.
      expect(dest).not.toContain('BookingHome');
      expect(dest).not.toContain('TripHistory');
    },
  );

  it('BookingHistory is registered in BookingNavigator (the stack all three reach via SecureTab)', () => {
    const nav = code(join(ROOT, 'src', 'navigation', 'BookingNavigator.tsx'));
    expect(nav).toContain('name="BookingHistory"');
  });

  it('BookingHistoryScreen renders a status chip for every backend BookingStatus', () => {
    // Guards the acceptance check on PDF p.29: "Confirm each status group
    // displays the correct records." describeStatus() falls back to UNKNOWN for
    // anything unmapped, so a new backend status must be added there too.
    const machine = source(
      join(ROOT, 'apps', 'auth-service', 'src', 'booking', 'state-machine.service.ts'),
    );
    const union = machine.slice(
      machine.indexOf('export type BookingStatus ='),
      machine.indexOf(';', machine.indexOf('export type BookingStatus =')),
    );
    const statuses = [...union.matchAll(/'([A-Z_]+)'/g)].map(m => m[1]);
    expect(statuses.length).toBeGreaterThanOrEqual(11);

    const config = code(join(ROOT, 'src', 'screens', 'booking', 'bookingStatus.ts'));
    for (const status of statuses) {
      expect(config).toContain(`${status}:`);
    }
  });
});
