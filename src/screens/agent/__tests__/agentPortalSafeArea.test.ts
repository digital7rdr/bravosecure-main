/**
 * Static source-scan regression for Issue 45 (Testing Issues V2, PDF p.50) —
 * "Android System Navigation Bar Overlaps App Controls Across Modules".
 *
 * The screenshot (p50A) is AgentTypeSelectScreen: "CONTINUE AS ENTERPRISE" with
 * the three-button navigation bar drawn straight over it. The control is not
 * that screen's — it is the shared CTAButton in agent/_shared.tsx, whose
 * wrapper had a flat `paddingBottom: 12`. On gesture navigation insets.bottom is
 * ~24dp and on three-button ~48dp, so the bar overlapped on three-button and
 * looked fine on gesture — which is why it reproduced on some devices only.
 *
 * One component, nine Agent Portal screens.
 *
 * This suite ALSO sweeps every fixed footer in the app, so a new one cannot ship
 * without a safe-area term.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(abs: string): string {
  const src = readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
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

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__' || name === 'node_modules') {continue;}
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {walk(p, acc);}
    else if (name.endsWith('.tsx')) {acc.push(p);}
  }
  return acc;
}

describe('Issue 45 — the shared Agent Portal CTA clears the navigation bar', () => {
  const SHARED = join(ROOT, 'src', 'screens', 'agent', '_shared.tsx');

  it('CTAButton pads by the safe-area rule at render', () => {
    // UPDATED for B-245. This asserted the literal `insets.bottom + 12`, which
    // was the right intent (never ship this bar with a flat pad) expressed as a
    // formula that over-corrected: nine Agent Portal screens route their CTA
    // through here, and the ones that sit under the root tab bar were then
    // reserving the system nav bar TWICE — ~48dp of dead gap on 3-button nav.
    //
    // bottomPad keeps the original guarantee and adds the missing half: it
    // INCLUDES the inset when nothing below owns it, and drops it when the tab
    // bar does. The bar is still never flat-padded.
    const src = code(SHARED);
    expect(src).toMatch(/useBottomInset/);
    expect(src).toMatch(/cta\.wrap, \{paddingBottom: bottomPad\(12\)\}/);
    expect(src).not.toMatch(/paddingBottom: insets\.bottom \+ 12/);
  });

  it('the static style no longer hard-codes a bottom pad', () => {
    const src = code(SHARED);
    const start = src.indexOf('  wrap: {');
    expect(start).toBeGreaterThan(-1);
    const wrap = src.slice(start, src.indexOf('\n  },', start));
    expect(wrap).not.toMatch(/paddingBottom/);
  });

  it('the Agent Portal screens really do route their CTA through it', () => {
    // If a screen ever hand-rolls its own bar this fix silently stops covering it.
    const users = walk(join(ROOT, 'src', 'screens', 'agent'))
      .filter(f => code(f).includes('<CTAButton'));
    expect(users.length).toBeGreaterThanOrEqual(8);
  });
});

describe('Issue 45 — no fixed footer anywhere ships without a safe-area term', () => {
  /** Style keys that name a bottom-anchored bar. */
  const FOOTER_KEY = /^\s*(footer|ctaWrap|bottomBar|footerWrap|actionBar)\w*:\s*\{/;

  /**
   * Documented exceptions. A footer belongs here ONLY when it is already inside
   * a safe area by construction — never because adding the inset was awkward.
   *
   * PermissionsScreen wraps its whole tree in <SafeAreaView>, which applies the
   * inset as PADDING. An absolutely-positioned child with `bottom: 0` resolves
   * against the parent's padding box, so it already sits above the navigation
   * bar; adding insets.bottom again would double-count it.
   */
  const EXEMPT: ReadonlyArray<[file: string, reason: string]> = [
    ['screens/auth/PermissionsScreen.tsx', 'inside <SafeAreaView> — inset already applied as padding'],
  ];

  it('every exemption is still genuinely inside a SafeAreaView', () => {
    for (const [rel] of EXEMPT) {
      const src = code(join(ROOT, 'src', ...rel.split('/')));
      expect(src).toMatch(/<SafeAreaView/);
    }
  });

  it('sweeps src/screens', () => {
    const offenders: string[] = [];
    const exemptFiles = EXEMPT.map(([rel]) => join('src', ...rel.split('/')));
    for (const file of walk(join(ROOT, 'src', 'screens'))) {
      if (exemptFiles.some(ex => file.endsWith(ex))) {continue;}
      const src = code(file);
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        const m = FOOTER_KEY.exec(line);
        if (!m) {return;}
        const block = lines.slice(i, i + 6).join('\n');
        if (!/position:\s*'absolute'/.test(block) || !/bottom:\s*0/.test(block)) {return;}
        const key = line.split(':')[0].trim();
        // Every render reference to this style, with trailing context.
        const refs = [...src.matchAll(new RegExp(`\\b(?:s|styles)\\.${key}\\b`, 'g'))]
          .map(mm => src.slice(mm.index ?? 0, (mm.index ?? 0) + 200));
        if (refs.length === 0) {return;}
        const safe = refs.some(r =>
          r.includes('insets.bottom') || r.includes('bottomPad') || r.includes('safeBottom'));
        if (!safe) {offenders.push(`${file.replace(ROOT, '')}:${i + 1} (${key})`);}
      });
    }
    expect(offenders).toEqual([]);
  });
});
