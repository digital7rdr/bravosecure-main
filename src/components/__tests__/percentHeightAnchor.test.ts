/**
 * B-682 — orphaned percentage-height contract.
 *
 * A child's `height:'100%'` is a DEPENDENCY on its parent's definite height.
 * The B-680 sweep converted `tickerWrap` (IntelFeed) and `field` (Register)
 * from `height:` to `minHeight:` without checking for percentage children —
 * the orphaned `tickerTag` blew up to screen height and crushed the Bravo
 * Feed to two cards (founder screenshot, 2026-08-27). The class rule this
 * scan enforces on every converted/latent site from the audit sweep
 * (docs/audits/FEED_TICKER_FALSE_RETRY_AUDIT_2026-08-27.md §1.5):
 *
 *   fill-the-row children use `alignSelf:'stretch'`, never `height:'100%'` —
 *   stretch needs no anchor, so a later fixed→minHeight conversion on the
 *   parent cannot orphan it.
 *
 * Source scan (RN screens the node project cannot mount). Files are CRLF —
 * the block extractor brace-counts instead of anchoring on newlines
 * (badgeGeometry.test.ts is the house shape this copies).
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.join(__dirname, '../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

/** Extract `key: { ... }` with balanced braces (styles nest shadowOffset). */
function styleBlock(src: string, key: string): string {
  const at = src.indexOf(`${key}: {`);
  if (at === -1) {throw new Error(`style '${key}' not found`);}
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') {depth++;}
    if (src[i] === '}' && --depth === 0) {return src.slice(at, i + 1);}
  }
  throw new Error(`style '${key}' unbalanced`);
}

function expectStretchNotPercentHeight(rel: string, key: string) {
  const block = styleBlock(read(rel), key);
  const body = block
    .slice(block.indexOf('{') + 1, -1)
    .replace(/\{[^{}]*\}/g, '{}');
  expect(body).toMatch(/\balignSelf:\s*'stretch'/);
  expect(body).not.toMatch(/(?<![a-zA-Z])height:/);
}

describe('B-682 fill-the-row children stretch instead of percentage height', () => {
  it.each([
    ['screens/news/IntelFeedScreen.tsx', 'tickerTag'],
    ['screens/auth/RegisterScreen.tsx', 'fieldInputWrap'],
    ['screens/auth/LoginScreen.tsx', 'fieldInputWrap'],
    ['screens/auth/ProfileCompletionScreen.tsx', 'dialCode'],
  ])('%s · %s', (rel, key) => {
    expectStretchNotPercentHeight(rel, key);
  });

  it('IntelFeed tickerWrap keeps the FS-61 minHeight (never a bare height again)', () => {
    const block = styleBlock(read('screens/news/IntelFeedScreen.tsx'), 'tickerWrap');
    const body = block
      .slice(block.indexOf('{') + 1, -1)
      .replace(/\{[^{}]*\}/g, '{}');
    expect(body).toMatch(/\bminHeight:/);
    expect(body).not.toMatch(/(?<![a-zA-Z])height:/);
  });
});
