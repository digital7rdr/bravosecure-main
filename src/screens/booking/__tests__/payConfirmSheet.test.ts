/**
 * Static source-scan regression for Issue 26 (Testing Issues V2, PDF p.31) —
 * "Payment Confirmation Sheet Has Severe Text and Control Overlap".
 *
 * Not a layout-maths bug: the sheet's background was
 * `rgba(255,255,255,0.045)` — 4.5% white over the backdrop, i.e. effectively
 * TRANSPARENT. The Top Up screen behind it (package tiles, the TOP UP CTA, the
 * tab bar) showed straight through the receipt rows, which is what read as
 * labels and amounts stacked on one another. Its action row also had no
 * safe-area padding, so CANCEL / PAY sat under the Android navigation bar.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const FILE = join(process.cwd(), 'src', 'screens', 'booking', 'CreditPaywallScreen.tsx');

function code(): string {
  const src = readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n');
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

/** The `sheet:` style declaration body. */
function sheetStyle(): string {
  const src = code();
  const start = src.indexOf('  sheet: {');
  expect(start).toBeGreaterThan(-1);
  return src.slice(start, src.indexOf('\n  },', start));
}

describe('Issue 26 — the payment confirmation sheet is readable', () => {
  it('the sheet is OPAQUE — nothing behind it can bleed through', () => {
    const style = sheetStyle();
    expect(style).not.toMatch(/backgroundColor:\s*'rgba\([^)]*0\.0\d+\)'/);
    expect(style).toMatch(/backgroundColor:\s*UI\.bg/);
  });

  it('the sheet has a responsive height cap so it cannot run off-screen', () => {
    const src = code();
    expect(src).toMatch(/\{height: winH\} = useWindowDimensions\(\)/);
    expect(src).toMatch(/maxHeight: winH \* 0\.85/);
  });

  it('the body scrolls internally rather than overflowing', () => {
    const src = code();
    const start = src.indexOf('Confirm payment');
    const before = src.slice(Math.max(0, start - 600), start);
    expect(before).toContain('<ScrollView');
  });

  it('the action row is a FIXED footer, outside the scroll', () => {
    const src = code();
    const scrollEnd = src.indexOf('</ScrollView>');
    const actions = src.indexOf('paySheet.actions');
    expect(scrollEnd).toBeGreaterThan(-1);
    // Footer must come AFTER the scroll closes, or it scrolls away.
    expect(actions).toBeGreaterThan(scrollEnd);
  });

  it('the footer clears the Android navigation bar', () => {
    expect(code()).toMatch(/paySheet\.actions, \{paddingBottom: Math\.max\(insets\.bottom, 12\)\}/);
  });

  it('the backdrop blocks interaction with the screen behind', () => {
    const src = code();
    // Outer Pressable dismisses; inner Pressable swallows taps so a tap on the
    // sheet cannot fall through to a package tile underneath.
    expect(src).toMatch(/Pressable style=\{paySheet\.backdrop\} onPress=\{\(\) => setConfirmOpen\(false\)\}/);
    expect(src).toMatch(/onPress=\{\(\) => \{\}\}/);
  });

  it('total, new balance, charge and payment method each appear exactly once', () => {
    const src = code();
    const start = src.indexOf('Confirm payment');
    const sheet = src.slice(start, src.indexOf('</Modal>', start));
    for (const label of ['Top-up', 'New balance', 'Charge', 'Card payment']) {
      expect(sheet.split(`>${label}<`).length - 1).toBe(1);
    }
  });
});
