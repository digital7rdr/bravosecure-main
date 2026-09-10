/**
 * Founder 2026-08-08 — "please align this, it seems skew" (Step 5, Team &
 * Add-ons, TEAM COMPOSITION).
 *
 * THE BUG. `teamCols` is a row that leaves `alignItems` at its `stretch`
 * default, so the two cells are always the same HEIGHT. Their content was
 * top-aligned, and the captions are not the same height: "CPOs" is one line,
 * "VEHICLES + DRIVERS" wraps to two. The taller caption pushed its stepper down
 * a full line while the shorter one stayed put, so the two steppers sat on
 * different baselines — visible as a skew across the pair.
 *
 * A source scan, deliberately. This is pure layout: react-test-renderer runs no
 * Yoga pass, so a render test can read the STYLE but never the resulting
 * geometry — it could not tell an aligned pair from a skewed one. What can be
 * pinned is the contract that produces the alignment, so a later refactor that
 * drops it fails here instead of on the founder's phone.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join('src', 'screens', 'booking', 'CustomizeAddOnsScreen.tsx');

/** Line-based strip — the house block-comment regex eats code holding `/*`. */
function codeOnly(): string {
  const lines = readFileSync(join(process.cwd(), SCREEN), 'utf8')
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

/** The body of one style key, e.g. `teamCell: { … }`. */
function styleBlock(name: string): string {
  const src = codeOnly();
  const at = src.indexOf(`${name}: {`);
  expect(at).toBeGreaterThan(-1);
  const open = src.indexOf('{', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') {depth++;}
    else if (src[i] === '}') { depth--; if (depth === 0) {return src.slice(open, i + 1);} }
  }
  throw new Error(`unterminated style block: ${name}`);
}

describe('the scan reads real code', () => {
  it('is not vacuous', () => {
    const src = codeOnly();
    expect(src.length).toBeGreaterThan(5_000);
    expect(src).toContain('TEAM COMPOSITION');
    expect(src).not.toContain('\r');
  });
});

describe('TEAM COMPOSITION cells align', () => {
  it('the two cells still share a height — the fix depends on it', () => {
    // `stretch` is the default, so this asserts nobody has set alignItems to
    // something else on the row; with `flex-start` the cells size to their own
    // content and bottom-anchoring would align nothing.
    const cols = styleBlock('teamCols');
    expect(cols).toContain("flexDirection: 'row'");
    expect(cols).not.toMatch(/alignItems:\s*'(flex-start|flex-end|center|baseline)'/);
  });

  it('the stepper is BOTTOM-anchored, which is what survives a wrapped caption', () => {
    // The load-bearing half: however many lines a caption takes — including at
    // fontScale 1.3+, where it can reach three — the steppers share a baseline.
    expect(styleBlock('teamCell')).toContain("justifyContent: 'space-between'");
  });

  it('the caption reserves two lines, so neither cell shows a gap under it', () => {
    const cap = styleBlock('teamCellCap');
    expect(cap).toMatch(/minHeight:\s*24/);
    expect(cap).toMatch(/lineHeight:\s*12/);
    // minHeight must be exactly two lines; a mismatch reintroduces the skew in
    // the ordinary one-line-vs-two-line case this bug was reported for.
    const lh = Number(/lineHeight:\s*(\d+)/.exec(cap)![1]);
    const mh = Number(/minHeight:\s*(\d+)/.exec(cap)![1]);
    expect(mh).toBe(lh * 2);
  });

  it('a wrapped caption is centred, not ragged-left inside a centred box', () => {
    expect(styleBlock('teamCellCap')).toContain("textAlign: 'center'");
  });

  it('the Driver-Only chip matches the stepper height — the same skew one state over', () => {
    // driver_only swaps the vehicles stepper for the "Client" chip, which must
    // still line up with the CPO stepper beside it.
    const chip = styleBlock('clientVehicle');
    const btn  = styleBlock('stepBtn');
    const chipH = Number(/minHeight:\s*(\d+)/.exec(chip)![1]);
    const btnH  = Number(/height:\s*(\d+)/.exec(btn)![1]);
    expect(chipH).toBe(btnH);
  });

  it('both columns render the SAME caption style, or nothing above can hold', () => {
    // The driver_only branch writes its caption inline rather than via TeamCell.
    const src = codeOnly();
    const caps = src.match(/style=\{s\.teamCellCap\}/g) ?? [];
    expect(caps.length).toBeGreaterThanOrEqual(2);
  });
});
