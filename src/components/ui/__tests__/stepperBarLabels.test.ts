/**
 * The six-step mission tracker must never clip a stage name (founder deck,
 * August 2026, pages 5 / 20 / 21 / 22 — his red circles around "Prote ction
 * act…", "Team disp atched", "Complete d").
 *
 * Cause: StepperBar put each label under its dot in a FIXED `cell: {width: 52}`.
 * `scaleTextStyles` rewrites fontSize/lineHeight/letterSpacing only, so the cell
 * stayed 52dp at every screen width and every fontScale while the glyphs grew.
 * Six non-shrinking cells are an incompressible 312dp — wider than a 320dp
 * screen before any padding — and the only elastic child (`conn: {flex: 1}`)
 * collapsed to zero and then the row overflowed its host. At fontScale >= 1.15
 * the labels also character-wrapped inside 52dp, which is the mid-word breakage
 * in the screenshots.
 *
 * Six readable labels do not fit across a phone at any font size, so the words
 * moved to a full-width caption that cannot truncate, and each dot carries its
 * own accessibility label. The six STEP_LABELS strings are deliberately
 * UNCHANGED — agentAcceptance.test.ts pins them and their order (Issue 41: the
 * client must not read "dispatched" before an officer accepts).
 *
 * Source scan: react-test-renderer runs no Yoga pass, so a render test cannot
 * observe geometry. This asserts the declared arithmetic instead.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(rel: string[]): string {
  const src = readFileSync(join(process.cwd(), ...rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) {
      if (t.includes('*/')) {inBlock = false;}
      continue;
    }
    if (t.startsWith('/*') || t.startsWith('{/*')) {
      if (!t.includes('*/')) {inBlock = true;}
      continue;
    }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const BAR = code(['src', 'components', 'ui', 'StepperBar.tsx']);
const STEPPER = code(['src', 'components', 'mission', 'MissionStepper.tsx']);
const JOURNEY = code(['src', 'screens', 'booking', 'missionJourney.ts']);

/** The narrowest host that renders the rail (the CPO on-duty card at 320dp). */
const NARROWEST_HOST_DP = 242;
const STEPS = 6;

describe('the rail fits the narrowest screen that renders it', () => {
  it('the per-step cell is no wider than the dot it holds', () => {
    const m = /cell: \{width: (\d+)/.exec(BAR);
    expect(m).not.toBeNull();
    const cell = Number(m![1]);
    // The dot itself is 26dp; anything much beyond that is label space that no
    // longer exists.
    expect(cell).toBeLessThanOrEqual(32);
  });

  it('six cells plus connectors leave room inside the narrowest host', () => {
    const cell = Number(/cell: \{width: (\d+)/.exec(BAR)![1]);
    const MIN_CONNECTOR = 8;
    const required = STEPS * cell + (STEPS - 1) * MIN_CONNECTOR;
    expect(required).toBeLessThanOrEqual(NARROWEST_HOST_DP);
  });

  it('the connector is still the elastic child', () => {
    expect(BAR).toMatch(/conn: \{flex: 1/);
  });
});

describe('no stage name can be clipped', () => {
  it('there is no per-cell label Text left to truncate', () => {
    // The exact shape that produced "Prote ction act…".
    expect(BAR).not.toMatch(/numberOfLines=\{2\} style=\{\[s\.label/);
    expect(BAR).not.toMatch(/\bs\.label\b/);
  });

  it('the words live in a full-width caption instead', () => {
    expect(BAR).toContain('caption');
    expect(BAR).toMatch(/caption: \{/);
    // A caption that itself truncated would just move the bug.
    expect(BAR).not.toMatch(/style=\{s\.caption\}[^>]*numberOfLines/);
  });

  it('the caption names the stage and the position in the sequence', () => {
    expect(STEPPER).toMatch(/caption=\{j\.index > 0 \? `Step \$\{j\.index\} of \$\{TOTAL_STEPS\} · \$\{j\.label\}` : j\.label\}/);
  });

  it('every dot still announces its own stage to a screen reader', () => {
    expect(BAR).toMatch(/accessibilityLabel=\{`Step \$\{n\} of \$\{steps\.length\}, \$\{steps\[stepIdx\]\}/);
  });
});

describe('all six stages are visible when the text can fit', () => {
  it('renders a one-word form under each dot at normal text size', () => {
    expect(BAR).toContain('shortSteps');
    expect(BAR).toMatch(/railLabels\?\.\[stepIdx\]/);
    expect(STEPPER).toContain('shortSteps={SHORT_STEPS}');
    expect(STEPPER).toMatch(/const SHORT_STEPS = \['Searching', 'Accepted', 'Dispatch', 'En route', 'Active', 'Done'\]/);
  });

  it('falls back to dots + caption rather than clipping at large text', () => {
    // The whole point: never re-create "Prote ction act…". Above the threshold
    // the rail labels are simply not rendered.
    expect(BAR).toMatch(/const RAIL_LABEL_MAX_FONT_SCALE = 1\.2;/);
    expect(BAR).toMatch(/PixelRatio\.getFontScale\(\) < RAIL_LABEL_MAX_FONT_SCALE/);
    expect(BAR).toMatch(/numberOfLines=\{1\}/);
  });

  it('the one-word forms are short enough to fit the cell pitch', () => {
    const m = /const SHORT_STEPS = \[([^\]]+)\]/.exec(STEPPER);
    expect(m).not.toBeNull();
    const words = m![1].split(',').map(w => w.trim().replace(/^'|'$/g, ''));
    expect(words).toHaveLength(6);
    for (const w of words) {
      expect(w.length).toBeLessThanOrEqual(9);
    }
  });
});

describe('the shared stage strings are untouched', () => {
  it('all six labels keep their exact wording and order', () => {
    // Changing these would rewrite client, agency and CPO copy at once and
    // break the agentAcceptance ordering pin.
    expect(JOURNEY).toContain("'Searching for your detail',");
    expect(JOURNEY).toContain("'Accepted · assigning team',");
    expect(JOURNEY).toContain("'Team dispatched',");
    expect(JOURNEY).toContain("'En route to pickup',");
    expect(JOURNEY).toContain("'Protection active',");
    expect(JOURNEY).toContain("'Completed',");
  });
});
