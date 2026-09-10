/**
 * Bravo Feed category vocabulary + pref scoping (founder 2026-08-09).
 *
 *   1. "Bravo Intel" is renamed "Bravo Feed" everywhere.
 *   2. Its filter chips are EXACTLY the News Filter categories. They used to
 *      be ALL / CRITICAL / SECURITY / POLITICAL / FINANCE / MILITARY — a
 *      vocabulary that mixed a SEVERITY (critical) in with topics and used
 *      names the preferences screen never offered, so a user could not filter
 *      the feed by anything they had actually subscribed to.
 *   3. Selecting News Filter options must shape BOTH feeds, not just My Feed.
 *   4. Signals is parked (greyed, inert) — it still renders a hardcoded demo
 *      set, so it must not read as live intelligence.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {NEWS_CATEGORIES} from '../newsPrefs';
import {categoriesFor} from '../bravoNewsClient';
import {matchesAnyCategory, matchesCategoryText} from '../intelAggregator';
import type {WireFilter} from '../useIntelFeed';

const SCREEN = join(process.cwd(), 'src', 'screens', 'news', 'IntelFeedScreen.tsx');
const HUB    = join(process.cwd(), 'src', 'screens', 'news', 'NewsHubScreen.tsx');

function code(p: string): string {
  return readFileSync(p, 'utf8')
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('one category vocabulary across News Filter and Bravo Feed', () => {
  it('every News Filter category is a usable Bravo Feed chip', () => {
    for (const c of NEWS_CATEGORIES) {
      // Compiles only if c.id is assignable to WireFilter — the type-level
      // half of the guarantee — and maps to itself server-side.
      const f: WireFilter = c.id;
      expect(categoriesFor(f)).toBe(c.id);
    }
  });

  it('the retired vocabulary is gone from the chip strip', () => {
    const src = code(SCREEN);
    // The old hardcoded array must not survive anywhere in the screen.
    expect(src).not.toMatch(/'CRITICAL'\s*,\s*'SECURITY'\s*,\s*'POLITICAL'/);
    // Chips are rendered from the shared table, not a local literal.
    expect(src).toMatch(/NEWS_CATEGORIES/);
    expect(src).toMatch(/chips\.map\(f =>/);
  });

  it('chip labels come from the same table the News Filter renders', () => {
    expect(code(SCREEN)).toMatch(/categoryLabel\(f\)\.toUpperCase\(\)/);
  });
});

describe('a News Filter selection scopes the Bravo Feed pool', () => {
  const SECURITY_ROW = 'cyber breach at a defence contractor';
  const SPORT_ROW    = 'local cricket final ends in a draw';

  it('keeps rows matching any selected category', () => {
    expect(matchesAnyCategory(['security'], SECURITY_ROW)).toBe(true);
    expect(matchesAnyCategory(['security', 'finance'], SECURITY_ROW)).toBe(true);
  });

  it('drops rows matching none of them — the actual filtering', () => {
    expect(matchesAnyCategory(['security'], SPORT_ROW)).toBe(false);
    expect(matchesAnyCategory(['finance', 'aviation'], SPORT_ROW)).toBe(false);
  });

  it('an empty selection means NO preference, not "match nothing"', () => {
    // A user who has saved nothing must still see a feed.
    expect(matchesAnyCategory([], SPORT_ROW)).toBe(true);
  });

  it('Top Stories is unfiltered by definition', () => {
    expect(matchesAnyCategory(['top'], SPORT_ROW)).toBe(true);
    expect(matchesCategoryText('top', SPORT_ROW)).toBe(true);
  });

  it('each category actually discriminates (no pattern matches everything)', () => {
    const ids = NEWS_CATEGORIES.map(c => c.id).filter(id => id !== 'top');
    for (const id of ids) {
      // A pattern that matched this nonsense string would be a dead filter.
      expect(matchesCategoryText(id, 'zzz qqq vvv')).toBe(false);
    }
  });

  it('the screen gates the ALL pool but never blanks the feed', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/wireFilter !== 'ALL' \|\| savedCats\.length === 0/);
    expect(src).toMatch(/matchesAnyCategory\(savedCats/);
    // A heuristic keyword gate that matches nothing must fall back, not
    // present an empty screen as if there were no news.
    expect(src).toMatch(/kept\.length > 0 \? kept : items/);
  });

  it('chips reflect the saved selection, and a stale chip falls back to ALL', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/savedCats\.includes\(id\)/);
    expect(src).toMatch(/subscribed\.length \? subscribed : NEWS_CATEGORIES\.map/);
    expect(src).toMatch(/!chips\.includes\(wireFilter\)\) \{setWireFilter\('ALL'\)/);
  });
});

describe('rename + parked Signals', () => {
  it('the feed is called Bravo Feed on both surfaces', () => {
    expect(code(SCREEN)).toMatch(/BRAVO FEED/);
    expect(code(HUB)).toMatch(/title="Bravo Feed"/);
    expect(code(HUB)).toMatch(/browseLabel="OPEN BRAVO FEED"/);
  });

  it('no user-facing "Bravo Intel" remains on either screen', () => {
    expect(code(SCREEN)).not.toMatch(/BRAVO INTEL|Bravo Intel/);
    expect(code(HUB)).not.toMatch(/Bravo Intel/);
  });

  it('Signals is disabled and dimmed, not merely unselected', () => {
    const src = code(SCREEN);
    expect(src).toMatch(/id:'signals', label:'SIGNALS', disabled: true/);
    expect(src).toMatch(/if \(!tab\.disabled\) \{setActiveTab\(tab\.id\);\}/);
    expect(src).toMatch(/tabTextDisabled/);
    // Announced as unavailable, not silently inert.
    expect(src).toMatch(/disabled: !!tab\.disabled/);
  });
});
