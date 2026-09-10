/**
 * B-347 contract — the News Preferences country toggle must stay tappable ON
 * THE SWITCH ITSELF, and the country list must stay full + capped.
 *
 * The bug: `pointerEvents="none"` was set directly on <Switch>. RN's Android
 * Switch is a native SwitchCompat, not a React view group, so the prop was
 * ignored and the native control consumed the tap; with no onValueChange the
 * tap did nothing (founder screenshot: red-circled toggles dead, only the row
 * body toggled). The fix wraps the Switch in a View pointerEvents="none",
 * which genuinely blocks its subtree so the tap falls through to the row.
 *
 * The screen mounts RN navigation context the node harness can't import, so
 * this is a line-based source scan (CRLF-safe, comments stripped — per the
 * CLAUDE.md scan traps).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_NEWS_PREFS,
  MAX_SELECTED_COUNTRIES,
  NEWS_COUNTRIES,
  loadNewsPrefs,
} from '../newsPrefs';

const SCREEN = join(process.cwd(), 'src', 'screens', 'news', 'NewsPreferencesScreen.tsx');

/** CODE lines only — block/JSX/line comments stripped, line-based for CRLF. */
function codeLines(path: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const t = raw.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/') && !t.includes('*/}')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(raw);
  }
  return out;
}

describe('B-347 — the country Switch is tap-transparent via a wrapper View', () => {
  const lines = codeLines(SCREEN);

  it('every <Switch is immediately preceded by a View pointerEvents="none" wrapper', () => {
    const switchIdxs = lines.flatMap((l, i) => (l.includes('<Switch') ? [i] : []));
    expect(switchIdxs.length).toBeGreaterThan(0);
    for (const i of switchIdxs) {
      const before = lines.slice(Math.max(0, i - 3), i).join('\n');
      expect(before).toMatch(/<View pointerEvents="none"/);
    }
  });

  it('the Switch itself carries neither pointerEvents (the bug) nor onValueChange (double-toggle)', () => {
    const src = lines.join('\n');
    const switchBlocks = src.match(/<Switch[\s\S]*?\/>/g) ?? [];
    expect(switchBlocks.length).toBeGreaterThan(0);
    for (const block of switchBlocks) {
      expect(block).not.toContain('pointerEvents');
      expect(block).not.toContain('onValueChange');
    }
  });

  it('the scan is not vacuous — it catches the pre-fix shape', () => {
    const preFix = '<Switch\n  value={isOn}\n  pointerEvents="none"\n/>';
    const blocks = preFix.match(/<Switch[\s\S]*?\/>/g) ?? [];
    expect(blocks[0]).toContain('pointerEvents');
  });

  it('rows stay tappable while the country search keyboard is up', () => {
    expect(lines.join('\n')).toContain('keyboardShouldPersistTaps="handled"');
  });
});

describe('NEWS FILTER banner — the obvious entry to preferences (founder spec)', () => {
  // The banner MOVED from the Regional feed to the News hub (founder
  // 2026-08-09) so it sits above both feed cards — the preferences it edits
  // shape both. The guarantee this pin exists for is unchanged: there is a
  // large, obvious entry to preferences somewhere the user cannot miss, not
  // only the small tune icon in the header. Only its home changed, so the
  // assertions follow it rather than being deleted.
  // Placement (above both cards) is pinned by screens/news/__tests__/newsHubLayout.
  const HUB_SRC = codeLines(join(process.cwd(), 'src', 'screens', 'news', 'NewsHubScreen.tsx')).join('\n');

  it('shows the heading + description and opens NewsPreferences', () => {
    expect(HUB_SRC).toContain('News Filter');
    expect(HUB_SRC).toContain('Filter news by your preferred categories and countries, and monitor relevant signals on the Intel Map.');
    expect(HUB_SRC).toMatch(/filterBanner[\s\S]*?navigate\('NewsPreferences'\)|navigate\('NewsPreferences'\)[\s\S]*?filterBanner/);
  });
});

describe('B-348 — the feed filter-chip strip can never be flex-shrunk away', () => {
  // Founder screenshot (unfolded Fold): chips clipped mid-text with the hero
  // card drawn over them. The feed ScrollView had no flex:1, so the column
  // resolved its content-sized basis by shrinking BOTH scroll views — the
  // chip strip lost most of its height. The contract: the chip strip is
  // unshrinkable and the feed owns the remaining height.
  const FEED = join(process.cwd(), 'src', 'screens', 'news', 'NewsFeedScreen.tsx');
  const src = codeLines(FEED).join('\n');

  it('chip strip style is flexGrow:0 AND flexShrink:0', () => {
    expect(src).toMatch(/filterScroll:\s*\{[^}]*flexGrow:\s*0[^}]*flexShrink:\s*0/);
  });

  it('the feed ScrollView owns the remaining height (flex:1)', () => {
    expect(src).toMatch(/feedScroll:\s*\{[^}]*flex:\s*1/);
    expect(src).toContain('style={styles.feedScroll}');
  });

  it('the scan is not vacuous — the pre-fix shape fails it', () => {
    const preFix = 'filterScroll: {flexGrow:0},';
    expect(preFix).not.toMatch(/filterScroll:\s*\{[^}]*flexGrow:\s*0[^}]*flexShrink:\s*0/);
  });

  it('IntelFeed chip strip carries the same pin', () => {
    const intel = codeLines(join(process.cwd(), 'src', 'screens', 'news', 'IntelFeedScreen.tsx')).join('\n');
    expect(intel).toMatch(/filterChipsWrap:\s*\{[^}]*flexGrow:\s*0[^}]*flexShrink:\s*0/);
  });
});

describe('news country registry', () => {
  it('is the full list — GLOBAL first, then every country A→Z (South Africa included)', () => {
    expect(NEWS_COUNTRIES[0].code).toBe('GLOBAL');
    expect(NEWS_COUNTRIES.length).toBeGreaterThanOrEqual(190);
    const labels = NEWS_COUNTRIES.slice(1).map(c => c.label);
    expect([...labels].sort()).toEqual(labels);
    for (const code of ['ZA', 'AE', 'SA', 'US', 'BD', 'XK']) {
      expect(NEWS_COUNTRIES.some(c => c.code === code)).toBe(true);
    }
  });

  it('has no duplicate codes', () => {
    const codes = NEWS_COUNTRIES.map(c => c.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('loadNewsPrefs caps persisted selections at the server pair budget', async () => {
    await AsyncStorage.setItem(
      'bravo.news.prefs.v2',
      JSON.stringify({countries: ['AE', 'SA', 'QA', 'KW', 'BH', 'OM', 'ZA', 'US'], categories: ['top']}),
    );
    const prefs = await loadNewsPrefs();
    expect(prefs.countries).toHaveLength(MAX_SELECTED_COUNTRIES);
    expect(prefs.countries).toEqual(['AE', 'SA', 'QA', 'KW', 'BH', 'OM']);
  });

  it('falls back to defaults on unknown codes', async () => {
    await AsyncStorage.setItem(
      'bravo.news.prefs.v2',
      JSON.stringify({countries: ['ZZ'], categories: ['top']}),
    );
    const prefs = await loadNewsPrefs();
    expect(prefs.countries).toEqual(DEFAULT_NEWS_PREFS.countries);
  });
});
