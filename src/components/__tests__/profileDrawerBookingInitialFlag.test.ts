/**
 * N3 — ProfileDrawerModal's "My Bookings" row nests into the lazy Booking
 * stack. Without `initial: false` the stack seeds AT BookingHistory with no
 * BookingHome beneath, so back falls out of the stack. This site is invisible
 * to nestedNavigationInitialFlag.test.ts (it goes through an aliased `go`
 * helper declared ~120 lines above), so it needs its own pin.
 *
 * Source-scan: comments stripped (CRLF-aware) so a flag mentioned in prose
 * cannot satisfy the check; every stack-leaf `screen:` nesting in the file must
 * carry the flag (tab leaves are materialised regardless and are exempt).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function strip(src: string): string {
  return src
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(l => l.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

const SRC = strip(
  readFileSync(join('src', 'components', 'ProfileDrawerModal.tsx'), 'utf8'),
);

// Tab-router leaves materialise every route, so there is no child-stack root to
// re-root — these do not need the flag.
const TAB_LEAVES = new Set(['MessengerTab', 'SecureTab', 'ProfileTab']);

describe('ProfileDrawerModal nested-nav initial flag (N3)', () => {
  it('the My Bookings nav carries initial: false', () => {
    const idx = SRC.indexOf("screen: 'BookingHistory'");
    expect(idx).toBeGreaterThan(-1);
    expect(SRC.slice(idx, idx + 60)).toMatch(/initial:\s*false/);
  });

  it('every stack-leaf nesting in the drawer carries initial: false', () => {
    const sites = [...SRC.matchAll(/screen:\s*'([A-Za-z]+)'/g)];
    expect(sites.length).toBeGreaterThan(0);
    const offenders = sites
      .filter(m => !TAB_LEAVES.has(m[1]))
      .filter(m => !/initial:\s*false/.test(SRC.slice(m.index ?? 0, (m.index ?? 0) + 80)))
      .map(m => m[1]);
    expect(offenders).toEqual([]);
  });
});
