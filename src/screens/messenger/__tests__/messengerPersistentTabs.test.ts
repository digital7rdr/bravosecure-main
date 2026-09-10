/**
 * Wave 5 PDF-2 — N1: the Messenger footer bar is PERSISTENT.
 *
 * Before N1 each footer tab PUSHED a full sibling screen, so the bar unmounted
 * the instant you left Chats (founder complaint: "the bar vanishes when you tap
 * a tab"). N1 keeps MessengerHome a SINGLE screen and keeps MessengerTabBar
 * ALWAYS mounted: Chats / Calls / News are now a local `activeTab` state that
 * conditionally renders the tab BODY inline (nothing navigates, the bar never
 * unmounts). Files STAYS a push — its B-453 vault-PIN gate uses
 * `navigation.replace(...)`, which embedded would replace MessengerHome itself
 * and defeat the lock; Channels STAYS the shell-aware exit-hop.
 *
 * Client feedback 2026-08-22 ("No Nav bar?" on Files): the bar moved into its
 * own module (`MessengerTabBar.tsx`) so the pushed Files screen hosts the SAME
 * bar with Files lit — the footer never disappears inside Messenger. The pins
 * below were RE-POINTED, not deleted: bar-internal shapes are read from the bar
 * module, the host wiring from each screen.
 *
 * SOURCE SCAN, not a render test: MessengerHomeScreen.tsx cannot be imported by
 * the node Jest project (it pulls the whole native screen tree), and a state
 * swap + conditional unmount is invisible to the RN test renderer (no Yoga
 * pass). So the shapes are pinned directly.
 *
 * ⚠️ CRLF: the files are CRLF, so they are normalised to `\n` before any scan —
 * a `\n`-anchored regex on raw bytes matches nothing and passes VACUOUSLY.
 * ⚠️ Comments are STRIPPED for every absence / decision-site assertion, because
 * the docblocks in the screen quote the very tokens under test (this repo's most
 * common false pass).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');
const BAR = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerTabBar.tsx');
const FILES = join(process.cwd(), 'src', 'screens', 'messenger', 'FilesScreen.tsx');

/** Raw source, CRLF normalised. */
function rawOf(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}
function raw(): string {
  return rawOf(SCREEN);
}

/** Comment-stripped — block comments removed, whole-line `//` lines dropped. */
function codeOf(path: string): string {
  return rawOf(path)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}
function code(): string {
  return codeOf(SCREEN);
}
function codeBar(): string {
  return codeOf(BAR);
}
function codeFiles(): string {
  return codeOf(FILES);
}

/** The MSG_TABS array body (declaration → first `];`), comment-stripped. */
function tabsBlock(): string {
  const c = codeBar();
  const start = c.indexOf('MSG_TABS:');
  expect(start).toBeGreaterThan(-1);
  const end = c.indexOf('];', start);
  expect(end).toBeGreaterThan(start);
  return c.slice(start, end);
}

describe('N1 — MessengerHome footer bar is persistent (state-based tabs)', () => {
  it('the scan is reading the real screen + the real bar (guards a vacuous pass)', () => {
    expect(raw().length).toBeGreaterThan(20_000);
    expect(codeBar()).toContain('MSG_TABS:');
    // ONE bar: the screen imports it from the module, it does not keep a copy.
    expect(code()).toMatch(/import\s*\{[^}]*\bMessengerTabBar\b[^}]*\}\s*from\s*'\.\/MessengerTabBar'/);
    expect(code()).not.toContain('MSG_TABS:');
  });

  it('Chats is the default tab — activeTab state seeded to Chats', () => {
    expect(code()).toMatch(/const \[activeTab, setActiveTab\] = useState<[^>]*>\('Chats'\)/);
  });

  it('Calls is a LOCAL tab (tab:), never a bare route push', () => {
    const block = tabsBlock();
    expect(block).toMatch(/label:\s*'Calls',\s*tab:\s*'Calls'/);
    // The old shape — a bare navigate — is gone (that is what unmounted the bar).
    expect(block).not.toMatch(/route:\s*'CallsLog'/);
    expect(code()).not.toMatch(/navigation\.navigate\(\s*'CallsLog'\)/);
    expect(codeBar()).not.toMatch(/navigation\.navigate\(\s*'CallsLog'\)/);
  });

  it('News is a LOCAL tab (tab:), never a bare route push', () => {
    const block = tabsBlock();
    expect(block).toMatch(/label:\s*'News',\s*tab:\s*'News'/);
    expect(block).not.toMatch(/route:\s*'NewsHub'/);
    expect(code()).not.toMatch(/navigation\.navigate\(\s*'NewsHub'\)/);
    expect(codeBar()).not.toMatch(/navigation\.navigate\(\s*'NewsHub'\)/);
  });

  it('Files STAYS a push — the B-453 vault-PIN gate cannot embed', () => {
    // Files keeps `route: 'Files'` and handlePress navigates to it. Embedding it
    // would run its `navigation.replace('VaultLock'|'VaultNewPin')` gate against
    // MessengerHome and strand the user; a full-screen push keeps the lock.
    expect(tabsBlock()).toMatch(/label:\s*'Files',\s*route:\s*'Files'/);
    expect(codeBar()).toMatch(/navigation\.navigate\(\s*'Files'\)/);
  });

  it('the footer tap SELECTS a local tab via onSelectTab (not a navigate)', () => {
    expect(codeBar()).toMatch(/onSelectTab\(\s*tab\.tab\s*\)/);
  });

  it('hardware back from a non-Chats tab returns to Chats (never ejects Messenger)', () => {
    // The tab is local state, not a stack entry, so a BackHandler must reset it
    // to Chats — else Android back falls through and kicks the user out of the
    // messenger surface (edge review 5f).
    const c = code();
    const guard = c.indexOf("activeTab === 'Chats'");
    expect(guard).toBeGreaterThan(-1);
    const region = c.slice(guard, guard + 260);
    expect(region).toMatch(/BackHandler\.addEventListener\(\s*'hardwareBackPress'/);
    expect(region).toMatch(/setActiveTab\('Chats'\)/);
  });

  it('the bar is wired to activeTab and never unmounts with the body', () => {
    const c = code();
    // The bar receives the live state — one instance, driven by activeTab.
    expect(c).toMatch(/<MessengerTabBar[\s\S]{0,160}activeTab=\{activeTab\}/);
    expect(c).toMatch(/<MessengerTabBar[\s\S]{0,160}onSelectTab=\{setActiveTab\}/);
    // The active highlight derives from what the HOST declares (a local tab on
    // MessengerHome, Files on the Files screen), NOT from the route/screen.
    expect(codeBar()).toMatch(/const active = \(tab\.tab \?\? tab\.route\) === activeTab/);
    // Structural "always mounted": the bar is rendered AFTER the tab-body
    // conditionals, as their sibling — never inside the Chats-only fragment.
    const callsBranch = c.indexOf("activeTab === 'Calls'");
    const bar = c.indexOf('<MessengerTabBar');
    expect(callsBranch).toBeGreaterThan(-1);
    expect(bar).toBeGreaterThan(callsBranch);
  });

  it('B-655 — EVERY tab body is CONDITIONAL; no display-toggled pane', () => {
    /**
     * ⚠️ THIS ASSERTION IS THE REVERSE OF WHAT IT SAID ON 2026-08-24, and the
     * reversal is the point.
     *
     * That day's "perf spine" mounted Chats and Calls permanently and toggled
     * `display`, to stop re-paying each tab's mount — and this test was written
     * to pin that shape. The founder reported the lag got WORSE, and the audit
     * (docs/audits/MESSENGER_LAG_AUDIT_2026-08-24.md) found three mechanisms:
     *
     *   1. `display` is a YOGA property — React still renders the hidden
     *      subtree, still reconciles it, and still runs every store
     *      subscription it declares. `CallsLogBody`'s subscriptions therefore
     *      fired on every commit forever, including while on Chats.
     *   2. Yoga SKIPS layout for a `display:'none'` subtree entirely
     *      (YogaLayoutableShadowNode.cpp:729-732), so flipping back to
     *      `flex:1` dirties the whole subtree at once — one full layout+draw
     *      pass on the UI THREAD at tap time (B-279's "Slow UI thread" bucket).
     *   3. Without a conditional, `setActiveTab` re-renders BOTH panes.
     *
     * The mount this conditional re-pays is cheap now because the calls log is
     * VIRTUALISED (see callsLogVirtualized.test.ts). The two are a PAIR — if a
     * future change reverts the virtualisation, do NOT "fix" the resulting lag
     * by bringing the display toggle back. It does not work.
     */
    const c = code();
    expect(c).toMatch(/activeTab === 'Calls' && <CallsLogBody embedded/);
    expect(c).toMatch(/activeTab === 'News' && <NewsHubBody embedded/);
    expect(c).toMatch(/\{activeTab === 'Chats' && \(/);
    // The display-toggled panes and the styles that served them are gone.
    expect(c).not.toMatch(/styles\.tabShown/);
    expect(c).not.toMatch(/styles\.tabHidden/);
    expect(c).not.toMatch(/display: 'none'/);
    // The embedded bodies come from the sibling screens (still push-reachable).
    expect(c).toMatch(/import\s*\{[^}]*\bCallsLogBody\b[^}]*\}\s*from\s*'\.\/CallsLogScreen'/);
    expect(c).toMatch(/import\s*\{[^}]*\bNewsHubBody\b[^}]*\}\s*from\s*'@screens\/news\/NewsHubScreen'/);
  });

  it('News UNMOUNTS when inactive — conditional render, never display:none', () => {
    const c = code();
    // Exactly one NewsHubBody JSX site, and it is the `activeTab === 'News' &&`
    // short-circuit (unmounts on tab switch → the intel fetch aborts, no leak).
    const sites = [...c.matchAll(/<NewsHubBody\b/g)];
    expect(sites.length).toBe(1);
    const idx = c.indexOf('<NewsHubBody');
    const before = c.slice(Math.max(0, idx - 40), idx);
    expect(before).toMatch(/activeTab === 'News' && $/);
  });

  it('Channels STAYS the shell-aware exit-hop (never a bare route)', () => {
    expect(codeBar()).toMatch(
      /navigateToMessengerScreen\(\s*navigation as never,\s*'DepartmentChannels',\s*\{\},\s*\{\s*initial:\s*false\s*\}\)/,
    );
    expect(tabsBlock()).not.toMatch(/route:\s*'DepartmentChannels'/);
  });

  it('…but Channels now lands on the WORKSPACE LIST first (client 2026-08-22)', () => {
    // "If I click Channels it redirects to my workspace's manage channels — it
    // should go to the workspace interface where all the workspaces are listed."
    // That hub is also what SETS the org context; entering channels without it
    // is exactly when the server returns every organisation's channels at once.
    const c = codeBar();
    const at = c.indexOf("tab.exit === 'DepartmentChannels'");
    expect(at).toBeGreaterThan(-1);
    const branch = c.slice(at, at + 420);
    // RESOLVED, not assumed — a shell without the hub must fall back, not die.
    expect(branch).toMatch(/findNavigatorWithRoute\([^)]*'WorkspaceHub'\)/);
    expect(branch).toMatch(/navigateVia\(hub, 'WorkspaceHub'\)/);
    // The hub attempt comes FIRST; the old exit-hop is the fallback beneath it.
    expect(branch.indexOf('WorkspaceHub')).toBeLessThan(branch.indexOf('navigateToMessengerScreen'));
  });
});

describe('client 2026-08-22 — the pushed Files screen hosts the SAME bar (no bar-less screen inside Messenger)', () => {
  it('FilesScreen renders MessengerTabBar with Files lit', () => {
    const f = codeFiles();
    expect(f).toMatch(/import\s*\{[^}]*\bMessengerTabBar\b[^}]*\}\s*from\s*'\.\/MessengerTabBar'/);
    expect(f).toMatch(/<MessengerTabBar[\s\S]{0,200}activeTab="Files"/);
  });

  it('a Chats/Calls/News press from Files pops back to MessengerHome carrying the tab', () => {
    expect(codeFiles()).toMatch(/onSelectTab=\{next => navigation\.navigate\('MessengerHome', \{tab: next\}\)\}/);
  });

  it('…and MessengerHome consumes that param ONCE and clears it (B-95 stale-param class)', () => {
    const c = code();
    expect(c).toMatch(/const requestedTab = route\.params\?\.tab;/);
    expect(c).toMatch(/setActiveTab\(requestedTab\);[\s\S]{0,80}?navigation\.setParams\(\{tab: undefined\}\)/);
  });

  it('NOT inside the Departmental workspace shell (its own 5-tab bar is already beneath)', () => {
    // FilesScreen is the Vault tab ROOT of DepartmentalNavigator; a second footer
    // there would stack two bars. `scopeToCompany` is that shell's existing
    // predicate (useInDepartmentalShell) — the same gate the file scope uses.
    expect(codeFiles()).toMatch(/\{!scopeToCompany && !selectionMode \? \(\s*<MessengerTabBar/);
  });

  it('a re-press of Files while Files hosts the bar is a no-op (never a second push)', () => {
    expect(codeBar()).toMatch(/if \(activeTab !== 'Files'\) \{navigation\.navigate\('Files'\);\}/);
  });
});
