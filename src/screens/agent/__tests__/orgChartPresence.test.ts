/**
 * Static source-scan regression for the Org Chart duty dot.
 *
 * `OrgHierarchyScreen.tsx` pulls in navigation, safe-area, expo-linear-gradient,
 * @expo/vector-icons and the API layer, so the `booking` project (node env, no
 * react-native preset) cannot import it. The repo already uses source scans for
 * exactly this class of rule — see rosterSuspensionInvariants.test.ts.
 *
 * History:
 *  - B-184: the dot READ `messengerStore.presence[userId]` but nothing ever
 *    SUBSCRIBED those ids, so every node painted gray forever.
 *  - B-203: the founder clarified the dot must mean ON DUTY (the availability
 *    toggle), NOT socket connectivity — an off-duty guard with the app merely
 *    open was reading green and getting jobs assigned. The dot now comes from
 *    `node.on_duty` in the /org/hierarchy payload; the socket subscription is
 *    gone entirely.
 *
 * If one of these fails: do NOT delete the assertion. Either restore the
 * guarantee or change the rule deliberately and update sqa.md B-203.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const CHART = join(process.cwd(), 'src', 'screens', 'agent', 'OrgHierarchyScreen.tsx');

/** The file is CRLF — normalise so `\n`-anchored slices cannot match vacuously. */
function source(): string {
  return readFileSync(CHART, 'utf8').replace(/\r\n/g, '\n');
}

/** Strip comments before any absence assertion (prose containing a banned word
 *  is the single most common false result in this repo's source scans). */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function region(src: string, startNeedle: string, endNeedle: string): string {
  const start = src.indexOf(startNeedle);
  const end = src.indexOf(endNeedle, start + startNeedle.length);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-203 — org chart duty dot (static source scan)', () => {
  it('D1: the dot colour is driven by the node.on_duty flag', () => {
    const tone = region(stripComments(source()), 'function dutyTone', 'function PresenceDot');
    expect(tone).toMatch(/n\.on_duty/);
    expect(tone).toMatch(/#22C55E/); // on duty  → green
    expect(tone).toMatch(/#4B5563/); // off duty → gray
  });

  it('D2: the dot does NOT read socket presence any more', () => {
    // The whole point of B-203: an off-duty but app-connected guard must NOT be
    // green. So the screen must not consult the messenger presence store.
    const src = stripComments(source());
    expect(src).not.toMatch(/messengerStore/);
    expect(src).not.toMatch(/subscribePresence/);
    expect(src).not.toMatch(/usePresenceTone/);
  });

  it('D3: every node still renders the dot', () => {
    // Always-visible so "who is on duty right now" reads at a glance.
    expect(stripComments(source())).toMatch(/<PresenceDot\s/);
  });

  it('D4: the duty state is announced to screen readers', () => {
    // Colour-only signal; without this it is invisible to TalkBack/VoiceOver.
    expect(stripComments(source())).toMatch(/accessibilityLabel=\{`[^`]*tone\.label[^`]*`\}/);
  });

  it('D5: the chart refetches on focus so a duty toggle reflects', () => {
    // Duty status is a payload field now, not a live socket push, so the only
    // way a change shows up is a re-fetch when the owner returns to the chart.
    expect(stripComments(source())).toMatch(/useFocusEffect\(useCallback\(\(\) => \{ void load\(\); \}/);
  });
});
