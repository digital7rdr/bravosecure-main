/**
 * Static source-scan regression for Issue 36 (Testing Issues V2, PDF p.41) —
 * "Service Provider Registration Repeats Medical Qualification Selection".
 *
 * The capability checklist carried BOTH 'First Aid / Trauma Care' and
 * 'Medical / FREC-3' as independent booleans, with no hierarchy and no evidence
 * requirement. A provider could tick both, neither, or the wrong one, and
 * nothing distinguished a first-aider from a paramedic.
 *
 * The screen mounts RN, so the rule is pinned by reading the source. The LEGACY
 * MAPPING is the risky half — an existing provider must not silently lose their
 * qualification when the key set changes — so it is asserted explicitly.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'agent', 'AgentRegistrationWizardScreen.tsx');

function code(): string {
  const src = readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

describe('Issue 36 — medical capability is asked exactly once', () => {
  it('the capability checklist no longer carries either medical boolean', () => {
    const src = code();
    const start = src.indexOf('const CAPABILITY_DEFS');
    expect(start).toBeGreaterThan(-1);
    const defs = src.slice(start, src.indexOf('];', start));
    expect(defs).not.toMatch(/first_aid/);
    expect(defs).not.toMatch(/'medical'/);
    expect(defs).not.toMatch(/FREC/i);
    expect(defs).not.toMatch(/First Aid/i);
  });

  it('a structured level selector replaces them', () => {
    const src = code();
    expect(src).toMatch(/type MedicalLevel = 'none' \| 'first_aid' \| 'frec3' \| 'paramedic'/);
    // Ordered least -> most so the list reads as a hierarchy.
    const start = src.indexOf('const MEDICAL_LEVELS');
    const levels = src.slice(start, src.indexOf('];', start));
    expect(levels.indexOf("'none'")).toBeLessThan(levels.indexOf("'first_aid'"));
    expect(levels.indexOf("'first_aid'")).toBeLessThan(levels.indexOf("'frec3'"));
    expect(levels.indexOf("'frec3'")).toBeLessThan(levels.indexOf("'paramedic'"));
  });

  it('it is SINGLE-select — one level, never a set of ticks', () => {
    const src = code();
    expect(src).toMatch(/setMedicalLevel\(lvl\.key\)/);
    expect(src).toMatch(/accessibilityRole="radio"/);
    expect(src).toMatch(/const on = medicalLevel === lvl\.key/);
  });

  it('LEGACY data maps forward — an existing provider keeps their qualification', () => {
    const src = code();
    const start = src.indexOf('function medicalLevelFrom');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('\n}', start));
    // Old 'medical' was labelled "Medical / FREC-3".
    expect(fn).toMatch(/caps\.includes\('medical'\)\).*return 'frec3'/);
    expect(fn).toMatch(/caps\.includes\('first_aid'\)\).*return 'first_aid'/);
    // Highest wins when both legacy flags are present.
    expect(fn).toMatch(/\['paramedic', 'frec3', 'first_aid'\] as const/);
  });

  it('the level rides the SAME capabilities array the server already stores', () => {
    const src = code();
    // No new API surface — one `medical_<level>` token in the existing string[].
    expect(src).toMatch(/MEDICAL_PREFIX = 'medical_'/);
    expect(src).toMatch(/medicalLevel === 'none' \? \[\] : \[`\$\{MEDICAL_PREFIX\}\$\{medicalLevel\}`\]/);
  });

  it("selecting 'none' CLEARS a legacy value rather than leaving it stuck", () => {
    const src = code();
    // 'none' persists nothing, and the save rebuilds the array from scratch —
    // so a legacy 'medical' / 'first_aid' token is not carried forward.
    const start = src.indexOf('capabilities: [');
    const save = src.slice(start, src.indexOf('],', start));
    expect(save).not.toMatch(/\.\.\.caps/);
    expect(save).toMatch(/Object\.entries\(capabilities\)\.filter/);
  });

  it('a qualified provider is told evidence is required', () => {
    const src = code();
    expect(src).toMatch(/medicalLevel !== 'none' &&/);
    expect(src).toMatch(/issuing\s*\n?\s*body and expiry date|issuing body and expiry/);
  });

  it('the review step shows the chosen level', () => {
    expect(code()).toMatch(/k="Medical"/);
  });
});
