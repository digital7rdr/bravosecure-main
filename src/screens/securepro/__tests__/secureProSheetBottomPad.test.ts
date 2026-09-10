/**
 * PDF-1 #6 follow-up — "the bottom-sheet button should remain clearly visible
 * and not conflict with the phone navigation bar".
 *
 * The three Secure Pro bottom sheets (Calendar "Send Request", Members manage
 * sheet, Proposal "Request Changes") padded their card by `24 + overlap`.
 * `overlap` is the KEYBOARD overlap only — 0 while the IME is closed — and the
 * sheet is a `<Modal transparent>`, which under edge-to-edge runs under the
 * Android navigation bar, so the CTA drew under the 3-button bar (the client's
 * screenshot). The house rule (`useKeyboardLayout().bottomPad(gap)`) already
 * REPLACES the safe-area inset with the keyboard overlap while the IME is up
 * and pads by the inset otherwise — exactly the two states the sheet needs.
 *
 * Source scan: these screens mount RN natives, and the pin is on a style
 * formula. Comments are stripped first, scanning is line-based (CRLF files).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREENS = [
  'SecureProCalendarScreen.tsx',
  'SecureProMembersScreen.tsx',
  'SecureProProposalScreen.tsx',
];

/** CODE lines only — a prose mention of the banned formula must not count. */
function codeLines(rel: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(join('src', 'screens', 'securepro', rel), 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw.replace(/(^|\s)\/\/.*$/, '$1'));
  }
  return out;
}

/** The pre-fix shape: a literal gap added to the keyboard-only overlap. */
const HAND_ROLLED = /\b\d+\s*\+\s*overlap\b|\boverlap\s*\+\s*\d+\b/;
/** The rule: `bottomPad` taken from useKeyboardLayout (aliased, since useBottomInset's bottomPad is also in scope). */
const RULE_DESTRUCTURE = /const\s*\{[^}]*\bbottomPad\s*:\s*kbBottomPad\b[^}]*\}\s*=\s*useKeyboardLayout\(\)/;
const SHEET_PAD = /s\.sheetCard,\s*\{paddingBottom:\s*kbBottomPad\(\s*24\s*\)\}/;

describe('Secure Pro bottom sheets clear the navigation bar (PDF-1 #6)', () => {
  it.each(SCREENS)('%s — no hand-rolled "N + overlap" padding remains', rel => {
    const offenders = codeLines(rel).filter(l => HAND_ROLLED.test(l)).map(l => l.trim());
    expect(offenders).toEqual([]);
  });

  it.each(SCREENS)('%s — takes bottomPad from useKeyboardLayout and pads the sheet card with it', rel => {
    const code = codeLines(rel).join('\n');
    expect(code).toMatch(RULE_DESTRUCTURE);
    expect(code).toMatch(SHEET_PAD);
  });

  it('the scan is not vacuous — it catches the pre-fix shape', () => {
    expect(HAND_ROLLED.test('          <Pressable style={[s.sheetCard, {paddingBottom: 24 + overlap}]} onPress={() => {}}>')).toBe(true);
    expect(HAND_ROLLED.test('              contentContainerStyle={{paddingHorizontal: 20, paddingBottom: 40 + overlap}}')).toBe(true);
    expect(SHEET_PAD.test('          <Pressable style={[s.sheetCard, {paddingBottom: kbBottomPad(24)}]} onPress={() => {}}>')).toBe(true);
    expect(RULE_DESTRUCTURE.test('  const {bottomPad: kbBottomPad} = useKeyboardLayout();')).toBe(true);
  });
});
