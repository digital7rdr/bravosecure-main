/**
 * PDF-1 #3 — the Zone-select country dropdowns must read "Countries on Demand"
 * (was "Active Countries") and "Countries on Request" (was "Countries Coming
 * Soon"), with the visible "COMING SOON" row badges / a11y reworded to match
 * the same concept.
 *
 * Source-scan (the screen can't be imported cheaply, and the copy is what
 * matters): comments are stripped first so the prose that still says "Coming
 * Soon" in the file's design notes never satisfies OR defeats an assertion, and
 * the file is CRLF so the stripper is \r?\n-aware.
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
  readFileSync(join('src', 'screens', 'booking', 'ZoneMapScreen.tsx'), 'utf8'),
);

describe('ZoneMapScreen country-label copy (PDF-1 #3)', () => {
  it('renames the two dropdown titles to the new wording', () => {
    expect(SRC).toContain('title="Countries on Demand"');
    expect(SRC).toContain('title="Countries on Request"');
  });

  it('drops the old dropdown titles entirely', () => {
    expect(SRC).not.toContain('Active Countries');
    expect(SRC).not.toContain('Countries Coming Soon');
  });

  it('reworded every visible "coming soon" string to the "on request" concept', () => {
    // No user-visible or a11y "coming soon" remains outside comments (stripped).
    // `statusSoon` / `soonCount` style + state identifiers stay — the phrase, not
    // the substring, is what changes, so this cannot false-match those.
    expect(SRC).not.toMatch(/coming soon/i);
    expect(SRC).toContain('ON REQUEST');
  });
});
