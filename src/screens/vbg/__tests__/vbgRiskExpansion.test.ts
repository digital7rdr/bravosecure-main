/**
 * B-410 — every risk card can be open at once (founder, 2026-08-09:
 * "ensure that all the cards of the assessment can remain open at the same
 * time, and not only one at a time").
 *
 * The GeoRisk "Potential Risks" list was a single-select accordion:
 * `expandedRisk: string | null`, toggled with `setExpandedRisk(open ? null :
 * r.name)`. Opening "Robbery / Theft" therefore collapsed "Violent Crime",
 * so the categories could never be read side by side — which is the point of
 * a risk assessment. Behaviour now lives in a pure module (same pattern as
 * vbgGeoRiskCoords.ts), so this is a REAL behavioural test, not a scan.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {toggleExpanded, collapseAll} from '../vbgRiskExpansion';

const A = 'Violent Crime';
const B = 'Robbery / Theft';
const C = 'Civil Disruption';
const D = 'Opportunistic Crime';

describe('B-410 — multiple risk cards stay open', () => {
  it('THE BUG: opening a second category does not close the first', () => {
    let s: ReadonlySet<string> = collapseAll();
    s = toggleExpanded(s, A);
    s = toggleExpanded(s, B);
    expect(s.has(A)).toBe(true);
    expect(s.has(B)).toBe(true);
    expect(s.size).toBe(2);
  });

  it('all four of the founder\'s categories can be open simultaneously', () => {
    const all = [A, B, C, D].reduce<ReadonlySet<string>>(toggleExpanded, collapseAll());
    expect([...all].sort()).toEqual([A, B, C, D].sort());
  });

  it('tapping an open category closes only that one', () => {
    let s: ReadonlySet<string> = collapseAll();
    for (const n of [A, B, C]) { s = toggleExpanded(s, n); }
    s = toggleExpanded(s, B);
    expect(s.has(B)).toBe(false);
    expect(s.has(A)).toBe(true);
    expect(s.has(C)).toBe(true);
  });

  it('toggling the same category twice returns to collapsed', () => {
    const s = toggleExpanded(toggleExpanded(collapseAll(), A), A);
    expect(s.size).toBe(0);
  });

  it('never mutates the previous set (React state identity must change)', () => {
    const prev = collapseAll();
    const next = toggleExpanded(prev, A);
    expect(prev.size).toBe(0);      // untouched
    expect(next).not.toBe(prev);    // new reference → re-render
  });

  it('a fresh analysis collapses everything', () => {
    const open = [A, B].reduce<ReadonlySet<string>>(toggleExpanded, collapseAll());
    expect(open.size).toBe(2);
    expect(collapseAll().size).toBe(0);
  });
});

describe('B-410 — the screen actually uses it (pure module cannot drift)', () => {
  const SCREEN = readFileSync(
    join(process.cwd(), 'src', 'screens', 'vbg', 'VBGGeoRiskScreen.tsx'), 'utf8',
  ).replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  it('holds a SET of open names, not one name', () => {
    expect(SCREEN).toMatch(/useState<ReadonlySet<string>>\(collapseAll\)/);
    expect(SCREEN).toMatch(/toggleExpanded\(prev, name\)/);
    // The single-select state and its toggle must not come back.
    expect(SCREEN).not.toMatch(/expandedRisk\b(?!s)/);
    expect(SCREEN).not.toMatch(/\? null : r\.name/);
  });

  it('the row derives its open state from the set and announces it', () => {
    expect(SCREEN).toMatch(/const open = expandedRisks\.has\(r\.name\)/);
    expect(SCREEN).toMatch(/accessibilityState=\{\{expanded: open/);
  });
});
