/**
 * News hub layout (founder 2026-08-09).
 *
 * Two requests, both about where a control lives rather than what it does:
 *   1. The "News Filter" card moved OFF the Regional feed and onto the hub,
 *      above both feed cards. The preferences it edits shape BOTH feeds, so it
 *      belongs before the choice, not one level inside one of them.
 *   2. "My Feed" and "Bravo Feed" swapped, so the personalised feed sits
 *      directly under the filter that shapes it.
 *
 * Ordering is invisible to a render-free unit test and there is no snapshot
 * here, so it is pinned by source position — the assertion is the relative
 * order of the three blocks, which is exactly what was asked for.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const HUB  = join(process.cwd(), 'src', 'screens', 'news', 'NewsHubScreen.tsx');
const FEED = join(process.cwd(), 'src', 'screens', 'news', 'NewsFeedScreen.tsx');

/** CRLF-normalised, comments stripped — both files describe the OLD placement
 *  in prose, which would otherwise satisfy an absence assertion. */
function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
function at(src: string, needle: string): number {
  const i = src.indexOf(needle);
  expect(i).toBeGreaterThan(-1);
  return i;
}

describe('news hub — filter above both feeds, My Feed first', () => {
  it('the News Filter card renders ABOVE both feed cards', () => {
    const src = code(HUB);
    const filter = at(src, 'style={styles.filterBanner}');
    expect(filter).toBeLessThan(at(src, 'title="My Feed"'));
    expect(filter).toBeLessThan(at(src, 'title="Bravo Feed"'));
  });

  it('My Feed renders BEFORE Bravo Feed', () => {
    const src = code(HUB);
    expect(at(src, 'title="My Feed"')).toBeLessThan(at(src, 'title="Bravo Feed"'));
  });

  it('both feed cards survived the reorder with their destinations intact', () => {
    // A copy/paste reorder is exactly where a card loses its onPress.
    const src = code(HUB);
    expect(src).toMatch(/title="My Feed"[\s\S]{0,240}navigation\.navigate\('NewsFeed'\)/);
    expect(src).toMatch(/title="Bravo Feed"[\s\S]{0,240}navigation\.navigate\('IntelFeed'\)/);
    expect(src).toMatch(/browseLabel="OPEN MY FEED"/);
    expect(src).toMatch(/browseLabel="OPEN BRAVO FEED"/);
    // Exactly one of each — a bad paste duplicates a card.
    expect((src.match(/title="Bravo Feed"/g) ?? []).length).toBe(1);
    expect((src.match(/title="My Feed"/g) ?? []).length).toBe(1);
  });

  it('the filter card still reaches preferences and is labelled', () => {
    const src = code(HUB);
    const i = at(src, 'style={styles.filterBanner}');
    const block = src.slice(i, i + 700);
    expect(block).toMatch(/navigation\.navigate\('NewsPreferences'\)/);
    expect(block).toMatch(/accessibilityRole="button"/);
    expect(block).toMatch(/accessibilityLabel="News filter/);
  });
});

describe('news hub — the card was MOVED, not copied', () => {
  it('the Regional feed no longer renders its own filter card', () => {
    const src = code(FEED);
    expect(src).not.toMatch(/styles\.filterBanner/);
    // …and its styles went with it (dead style objects survive typecheck).
    expect(src).not.toMatch(/^\s*filterBanner(Icon|Title|Desc)?:/m);
  });

  it('the Regional feed keeps its header shortcut to preferences', () => {
    // Removing the card must not strand the user mid-feed with no way back
    // to preferences — the small tune icon is the in-context path.
    expect(code(FEED)).toMatch(/navigation\.navigate\('NewsPreferences'\)/);
  });
});
