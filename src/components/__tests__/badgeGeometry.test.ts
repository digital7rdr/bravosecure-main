/**
 * B-680 (FS-03/35/40/41/47/50/51) — count-badge geometry contract.
 *
 * The client screenshot's "red 29 over the status pill" was ActivityBell's
 * badge: a `position:'absolute'` box with a FIXED `height:` and an uncapped
 * count. The class rule this scan enforces on every known count badge:
 *
 *   1. the badge style uses `minHeight`, never a bare `height:` — a fixed
 *      height clips grown digits vertically (fontScale ≤ 1.3 is now globally
 *      capped by the B-680 RN patch, but 1.3 on top of scaleFont's 1.2 still
 *      exceeds a 16dp box);
 *   2. the rendered count is CLAMPED ('99+' / '9+') — an unclamped 3-4 digit
 *      count widens the pill across its neighbours regardless of fontScale.
 *
 * Source scan (these are RN screens the node project cannot mount). Files are
 * CRLF — the block extractor brace-counts instead of anchoring on newlines.
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

function expectMinHeightNotHeight(rel: string, key: string) {
  const block = styleBlock(read(rel), key);
  // Drop the outer braces, then blank NESTED objects (shadowOffset carries a
  // legitimate `height:`), leaving only the style's own properties.
  const body = block
    .slice(block.indexOf('{') + 1, -1)
    .replace(/\{[^{}]*\}/g, '{}');
  expect(body).toMatch(/\bminHeight:/);
  expect(body).not.toMatch(/(?<![a-zA-Z])height:/);
}

describe('B-680 badge geometry — minHeight, never fixed height', () => {
  it.each([
    ['components/ActivityBell.tsx', 'badge'],
    ['navigation/ObsidianTabBar.tsx', 'badge'],
    ['screens/messenger/MessengerHomeScreen.tsx', 'badge'],
    ['screens/messenger/GroupsScreen.tsx', 'unreadBadge'],
    ['screens/deptchat/UnreadPill.tsx', 'pill'],
    ['screens/messenger/GroupCallScreen.tsx', 'dockBadge'],
    ['screens/messenger/ChatScreen.tsx', 'scrollFabBadge'],
  ])('%s · %s', (rel, key) => {
    expectMinHeightNotHeight(rel, key);
  });

  it('ActivityBell badge is bounded so it cannot escape the 42dp button over a neighbour', () => {
    const block = styleBlock(read('components/ActivityBell.tsx'), 'badge');
    expect(block).toMatch(/\bmaxWidth:/);
  });
});

describe('B-680 badge counts are clamped', () => {
  it('ActivityBell clamps at 99+', () => {
    expect(read('components/ActivityBell.tsx')).toContain("'99+'");
  });
  it('MessengerHome chat-list badge clamps at 99+', () => {
    expect(read('screens/messenger/MessengerHomeScreen.tsx')).toContain("'99+'");
  });
  it('Groups badge clamps at 99+', () => {
    expect(read('screens/messenger/GroupsScreen.tsx')).toContain("'99+'");
  });
  it('UnreadPill keeps its 99+ clamp', () => {
    expect(read('screens/deptchat/UnreadPill.tsx')).toContain('99');
  });
  it('GroupCall dock badge keeps its 9+ clamp', () => {
    expect(read('screens/messenger/GroupCallScreen.tsx')).toContain("'9+'");
  });
  it('ChatScreen scroll-FAB badge keeps its 99+ clamp', () => {
    expect(read('screens/messenger/ChatScreen.tsx')).toContain("'99+'");
  });
});
