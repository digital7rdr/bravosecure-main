/**
 * Channels vs2 item 17b — ALL FOUR advertising surfaces obey the rule.
 *
 * A source scan, because the alternative is four render tests across two
 * screens and three personas — and the defect this guards is not "the filter is
 * wrong", it is "somebody added a fifth surface and did not filter it". A miss
 * leaves a module hidden on Home and still offered from the directory, which is
 * worse than not hiding it: the app now disagrees with itself about what this
 * workspace does.
 *
 * Comments are stripped line-by-line first — prose naming the banned token is
 * the classic false positive, and these files are CRLF.
 */
import {readFileSync} from 'fs';
import {join} from 'path';

function codeOnly(rel: string): string {
  const lines = readFileSync(join(process.cwd(), rel), 'utf8')
    .replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inBlock = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(raw);
  }
  return out.join('\n');
}

const HOME = 'src/screens/deptchat/DepartmentalHomeScreen.tsx';
const DIRECTORY = 'src/screens/messenger/DepartmentChannelsScreen.tsx';

describe('every surface consumes the shared rule', () => {
  it.each([HOME, DIRECTORY])('%s imports the helper rather than reading the array', rel => {
    const src = codeOnly(rel);
    expect(src).toMatch(/moduleVisible/);
    // The ban: no screen re-derives visibility from the raw payload.
    expect(src).not.toMatch(/hiddenModules\.includes\(/);
  });

  it('Home gates the member card, both alert tiles and both quick actions', () => {
    const src = codeOnly(HOME);
    // The member "Today's attendance" card.
    expect(src).toMatch(/!isManager && showAttendance &&/);
    // The alert-tile section AND each tile.
    expect(src).toMatch(/isManager && \(showAttendance \|\| showIncidents\)/);
    expect(src).toMatch(/\{showAttendance && \(\s*\n\s*<AlertTile/);
    expect(src).toMatch(/\{showIncidents && \(\s*\n\s*<AlertTile/);
    // Both quick-action cards.
    const attendCard = src.indexOf("title={isManager ? 'Attendance' : 'My attendance'}");
    // item 09 — the card title stopped being role-branched (both roles now land
    // on the wizard), so this re-anchors on the new literal. The ASSERTION is
    // unchanged: the card must still sit behind a showIncidents gate.
    const incidentCard = src.indexOf('title="Report incident"');
    expect(attendCard).toBeGreaterThan(-1);
    expect(incidentCard).toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, attendCard - 200), attendCard)).toMatch(/showAttendance/);
    expect(src.slice(Math.max(0, incidentCard - 200), incidentCard)).toMatch(/showIncidents/);
  });

  it('the directory row goes only when BOTH are hidden, and narrows its copy', () => {
    const src = codeOnly(DIRECTORY);
    expect(src).toMatch(/\(showAttendance \|\| showIncidents\)/);
    // …and it must not keep the both-modules sentence hard-coded.
    expect(src).toMatch(/moduleRowSubtitle\(/);
    expect(src).not.toMatch(/'Shifts, day status, reviews and the incident queue'/);
  });

  it('HIDING IS NOT A PERMISSION — no route is unregistered and no guard reads it', () => {
    /**
     * The rule that keeps deep links and push taps working. A hidden module's
     * screens stay mounted in their navigators; only the cards that ADVERTISE
     * them go. If this ever fails, a notification already in flight when an
     * admin hides a card becomes a dead tap.
     */
    for (const rel of ['src/navigation/DepartmentalNavigator.tsx']) {
      const src = codeOnly(rel);
      expect(src).toMatch(/name="Attend"/);
      expect(src).toMatch(/name="Incident"/);
      expect(src).not.toMatch(/showAttendance|showIncidents|hiddenModules/);
    }
  });
});
