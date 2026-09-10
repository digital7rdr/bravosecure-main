/**
 * The workspace bottom-navigation rule.
 *
 * ⚠️ SUPERSEDED RULE, REWRITTEN NOT DELETED. This file used to pin the vs1 PDF's
 * "Home + Messenger only" bar (stated on four separate pages, with the four
 * modules reached from the Home dashboard). The 2026-08-15 client review
 * replaces it outright — item 07: "The Bottom Nav Bar should have: Home,
 * Channels, Vault, Messenger, News" — so the assertions move to the new rule and
 * the ones that are still true (reachability, the hide marker, the shared bar's
 * honouring of it, the Messenger exit) are kept verbatim, because they were
 * never about the tab COUNT.
 *
 * WHY THIS IS STILL A SOURCE SCAN. The rule is about what the BAR RENDERS versus
 * what the navigator REGISTERS — two facts that live in the same file and are
 * easy to collapse into one. A render test would prove the bar shows five items;
 * it could not prove Attend and Incident are still *reachable*, which is the
 * half that breaks live `navigation.navigate(...)` call sites — including push
 * deep links — if someone "simplifies" this by deleting the Tab.Screen entries.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function src(...parts: string[]): string {
  return readFileSync(join(process.cwd(), 'src', ...parts), 'utf8').replace(/\r\n/g, '\n');
}

/** Strip comments before any presence/absence assertion — the prose below
 *  deliberately names every tab and marker it discusses, and would satisfy a
 *  naive scan. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const NAV = 'DepartmentalNavigator.tsx';
/** Visible in the bar, in the PDF's stated order. */
const BAR = ['Home', 'Channels', 'Vault', 'Messenger', 'News'] as const;
/** Registered and navigable, but not drawn — reached from the Home dashboard. */
const HIDDEN = ['Attend', 'Incident'] as const;

describe('Enterprise workspace bottom navigation (item 07)', () => {
  const nav = code(src('navigation', NAV));

  it('registers every route, so none becomes unreachable', () => {
    // The scan must actually be finding Tab.Screen lines, or every assertion
    // below is vacuously true.
    const tabScreens = nav.match(/<Tab\.Screen[\s\S]*?\/>/g) ?? [];
    expect(tabScreens.length).toBeGreaterThanOrEqual(7);
    for (const tab of [...BAR, ...HIDDEN]) {
      expect(nav).toMatch(new RegExp(`<Tab\\.Screen\\s+name="${tab}"`));
    }
  });

  it('shows EXACTLY the five PDF destinations, in order', () => {
    // `\s+`, not a literal space: `Messenger` is declared multi-line, and a
    // space-anchored scan silently skipped it for the whole life of this file.
    const declared = [...nav.matchAll(/<Tab\.Screen\s+name="(\w+)"/g)].map(m => m[1]);
    const visible = declared.filter(t => {
      const line = nav.split('\n').find(l => l.includes(`name="${t}"`)) ?? '';
      return !line.includes('HIDDEN_TAB');
    });
    expect(visible).toEqual([...BAR]);
  });

  it('keeps Attend and Incident registered-but-hidden', () => {
    for (const tab of HIDDEN) {
      const line = nav.split('\n').find(l => l.includes(`name="${tab}"`)) ?? '';
      expect(`${tab}:${line.includes('HIDDEN_TAB')}`).toBe(`${tab}:true`);
    }
  });

  it('defines the hide marker ONCE, so the hidden tabs cannot drift apart', () => {
    const defs = nav.match(/const HIDDEN_TAB\s*=/g) ?? [];
    expect(defs).toHaveLength(1);
    expect(nav).toMatch(/const HIDDEN_TAB = \{tabBarButton: \(\) => null\}/);
  });

  /**
   * The bar has to HONOUR the marker. Before this mechanism existed it mapped
   * every route in `state.routes` unconditionally, so setting `tabBarButton`
   * changed nothing and the only way to shrink the bar was to unregister the
   * route — precisely the change that breaks reachability.
   */
  it('the shared tab bar honours the hide marker', () => {
    const bar = code(src('navigation', 'ObsidianTabBar.tsx'));
    expect(bar).toMatch(/if \(options\.tabBarButton\) \{\s*return null;\s*\}/);
    // …and it is inside the per-route map, not a top-level early return that
    // would blank the whole bar. Anchor on the GUARD, not the bare token: the
    // bar reads that same property ABOVE the map to pick a stand-in, so an
    // indexOf on the token finds the wrong occurrence and the ordering
    // assertion silently inverts. (It did — this test caught itself.)
    const mapAt = bar.indexOf('state.routes.map');
    const guardAt = bar.search(/if \(options\.tabBarButton\) \{\s*return null;\s*\}/);
    expect(mapAt).toBeGreaterThan(-1);
    expect(guardAt).toBeGreaterThan(mapAt);
  });

  /**
   * With a hidden tab ACTIVE, no rendered item would be focused and the bar
   * would highlight nothing — "where am I?". Attend and Incident are reached
   * FROM Home, so Home stands in while one is open. Still required after item
   * 07: the bar grew, but those two are still hidden.
   */
  it('names its stand-in tab instead of leaving it to declaration order', () => {
    expect(nav).toMatch(/standInTab="Home"/);
  });

  /**
   * ⚠️ backBehavior is still "firstRoute", DELIBERATELY and TEMPORARILY.
   *
   * Switching it to "history" was proposed and WITHDRAWN: `ObHeader` wires a
   * bare `onBack` on ~26 deptchat screens, and an unhandled GO_BACK bubbles to
   * the parent navigator — under "history" that ejects the user out of the
   * workspace entirely once tab history is exhausted, reachable from any of
   * those screens. Item 11a needs a device repro before that is touched.
   *
   * Known consequence, accepted for now: back from any tab goes to Home, which
   * is MORE visible now that Channels, Vault and News are tappable.
   */
  it('declares backBehavior rather than relying on the framework default', () => {
    expect(nav).toMatch(/backBehavior="firstRoute"/);
  });

  /**
   * Messenger is an EXIT, not a screen in the workspace. If its press were not
   * intercepted it would mount the stub and show a blank workspace tab.
   */
  it('the Messenger tab exits to the messenger stack instead of navigating', () => {
    expect(nav).toMatch(/tabPress: e => \{[\s\S]*?e\.preventDefault\(\)/);
    // Through the SHELL RESOLVER, not a bare `getParent()` hop — that hop
    // resolves in the Messenger and Agent shells and was silently dropped in the
    // CPO shell, whose root stack has no `MessengerHome` (B-414).
    expect(nav).toMatch(/navigateToMessengerScreen\([\s\S]{0,80}?'MessengerHome'/);
    expect(nav).not.toMatch(/getParent\(\)\?\.navigate\('MessengerHome'\)/);
  });

  /**
   * News is the one new destination, and it is IN-SHELL rather than an exit.
   *
   * An exit was tried and rejected: `NewsHub` is registered only inside
   * MessengerNavigator, so `messengerDeepLink`'s agency arm falls through to its
   * `MessengerHome` default and an agency user tapping News lands on the chat
   * list; the CPO shell has no such route either. Mounting it keeps all three
   * host shells identical.
   */
  it('News is mounted in-shell and unmounts on blur', () => {
    expect(nav).toMatch(/<Tab\.Screen name="News" component=\{NewsTab\}/);
    expect(nav).toMatch(/unmountOnBlur: true/);
    // freezeOnBlur would NOT run the cleanups — it suspends rendering only.
    // NAV-23 (2026-08-26) added stack-level `freezeOnBlur` to the shared
    // stackOpts (nested STACK screens), which does not affect the News TAB's
    // unmount behaviour — so the absence pin is scoped to the News
    // Tab.Screen registration, not the whole file.
    const newsAt = nav.indexOf('<Tab.Screen name="News"');
    const newsBlock = nav.slice(newsAt, nav.indexOf('/>', newsAt));
    expect(newsBlock).not.toMatch(/freezeOnBlur/);
  });

  it('every visible tab has an icon — a missing key degrades SILENTLY', () => {
    // ObsidianTabBar falls back to 'help-circle-outline' plus the raw route
    // name, so a forgotten entry ships as a question mark and nothing fails.
    for (const tab of BAR) {
      expect(nav).toMatch(new RegExp(`\\b${tab}:\\s*\\{default:`));
    }
  });

  /**
   * Attend and Incident are now reachable ONLY from the Home dashboard, so its
   * cards are load-bearing rather than a convenience. Channels and Vault have
   * their own tabs now but keep their cards too — removing them is fine, losing
   * the other two is not.
   */
  it('the Home dashboard still routes to both hidden modules', () => {
    const home = code(src('screens', 'deptchat', 'DepartmentalHomeScreen.tsx'));
    for (const tab of HIDDEN) {
      expect(home).toMatch(new RegExp(`navigate\\('${tab}'`));
    }
  });
});
