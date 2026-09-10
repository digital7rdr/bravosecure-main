/**
 * PDF-1 #4 — a no-CPO-available outcome is NOT a failure: the server already
 * notified Ops, so the Pro "Start Protection" flow must confirm the request
 * ("Protection Requested"), not scold ("Couldn't start protection"). The
 * generic error branch MUST stay a real, retryable failure.
 *
 * Source-scan (the screen pulls native modules): comments stripped first (a
 * CRLF file), then the branch keyed on `no_cpo_assigned` is isolated up to its
 * `else` so the assertion reads THAT site, not the neighbouring alert.
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

const SRC = strip(
  readFileSync(join('src', 'screens', 'pro', 'ProLiveMissionScreen.tsx'), 'utf8'),
);

describe('ProLiveMission no-CPO copy (PDF-1 #4)', () => {
  it('confirms positively on no_cpo_assigned and never titles it a failure', () => {
    const idx = SRC.indexOf("'no_cpo_assigned'");
    expect(idx).toBeGreaterThan(-1);
    const elseIdx = SRC.indexOf('else', idx);
    const branch = SRC.slice(idx, elseIdx > idx ? elseIdx : idx + 200);
    expect(branch).toContain('Protection Requested');
    expect(branch).not.toMatch(/Couldn/);
  });

  it('keeps the generic branch a real retryable error', () => {
    expect(SRC).toMatch(/Couldn.{0,3}t start protection/);
    expect(SRC).toContain('Please try again.');
  });
});
