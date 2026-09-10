/**
 * PDF-1 #8 — the refund/redemption disclaimer must be visible "near Top Up /
 * History and before a refund or redemption action is confirmed".
 *
 * First cut rendered it ONLY inside the Top Up tab. It now lives in one
 * `RefundNotice` component rendered at the bottom of ALL THREE tab scrolls
 * (Balance, Top Up, History), plus a compact one-line eligibility note inside
 * the promo-code modal — the only redemption action — above its Apply button.
 *
 * Source-scan (comments stripped, whitespace normalised because the JSX wraps
 * the sentence across lines). Each tab is located by its own `activeTab ===`
 * guard so the assertion reads THAT block, not a neighbour.
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

const NORM = strip(
  readFileSync(join('src', 'screens', 'wallet', 'CreditsScreen.tsx'), 'utf8'),
).replace(/\s+/g, ' ');

/**
 * The JSX of one tab: from its guard to the next `activeTab ===` guard. After
 * the History tab the next guard is the Top Up sticky CTA (a second `'topup'`
 * guard), which is why the lookup is "next guard after start", not "next tab".
 */
function tabBlock(tab: 'balance' | 'topup' | 'history'): string {
  const next = {balance: 'topup', topup: 'history', history: 'topup'}[tab];
  const start = NORM.indexOf(`{activeTab === '${tab}' && (`);
  expect(start).toBeGreaterThan(-1);
  const end = NORM.indexOf(`{activeTab === '${next}' && (`, start + 1);
  expect(end).toBeGreaterThan(start);
  return NORM.slice(start, end);
}

describe('CreditsScreen refund notice (PDF-1 #8)', () => {
  it('shows the approved refund disclaimer copy, once, in a RefundNotice component', () => {
    expect(NORM).toContain('Refund notice');
    expect(NORM).toContain('original payment method within 7 working days after approval');
    expect(NORM).toContain('Bravo Refund Policy');
    expect(NORM).toMatch(/function RefundNotice\(/);
    // The copy lives in ONE place — the component — not pasted per tab.
    expect(NORM.split('original payment method within 7 working days after approval').length - 1).toBe(1);
  });

  it.each(['balance', 'topup', 'history'] as const)('renders <RefundNotice /> inside the %s tab', tab => {
    expect(tabBlock(tab)).toContain('<RefundNotice />');
  });

  it('still sits after PAYMENT METHOD inside the Top Up tab', () => {
    const block = tabBlock('topup');
    expect(block.indexOf('<RefundNotice />')).toBeGreaterThan(block.indexOf('PAYMENT METHOD'));
  });

  it('the promo-code modal carries a one-line eligibility note above Apply', () => {
    const modalStart = NORM.indexOf('<Modal visible={promoOpen}');
    expect(modalStart).toBeGreaterThan(-1);
    const modal = NORM.slice(modalStart, NORM.indexOf('</Modal>', modalStart));
    const noteIdx = modal.indexOf('Promotional credits are non-refundable under the Bravo Refund Policy.');
    const applyIdx = modal.lastIndexOf('>Apply<');
    expect(noteIdx).toBeGreaterThan(-1);
    expect(applyIdx).toBeGreaterThan(-1);
    expect(noteIdx).toBeLessThan(applyIdx);
  });
});
