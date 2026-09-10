/**
 * Wave 5 PDF-2 — N5 (footer tabs) + N4 (conditional "Secure Services" back
 * chevron) on MessengerHomeScreen.
 *
 * SOURCE SCAN, not a render test: MessengerHomeScreen.tsx cannot be imported by
 * the node Jest project, and the layout + cross-shell nav effects here are
 * invisible to the RN test renderer anyway (no Yoga pass, a navigate that
 * bubbles to a parent navigator). So the shapes are pinned directly.
 *
 * ⚠️ CRLF: the file is CRLF, so it is normalised to `\n` before any scan — a
 * `\n`-anchored regex on raw bytes would match nothing and pass VACUOUSLY.
 * ⚠️ Comments are STRIPPED for every absence / gate assertion, because the
 * docblocks in the screen quote the very tokens under test (this repo's most
 * common false pass).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerHomeScreen.tsx');
// Client 2026-08-22 — the bar (MSG_TABS + MessengerTabBar) moved into its own
// module so the pushed Files screen can host the same bar; the footer pins read
// the bar from there, the chevron/header pins still read the screen.
const BAR = join(process.cwd(), 'src', 'screens', 'messenger', 'MessengerTabBar.tsx');

/** Raw source, CRLF normalised. */
function raw(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}

/** Comment-stripped — block comments removed, whole-line `//` lines dropped. */
function strip(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}
function code(): string {
  return strip(raw());
}
function codeBar(): string {
  return strip(readFileSync(BAR, 'utf8').replace(/\r\n/g, '\n'));
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

/** A single-line style entry from the StyleSheet. */
function styleLine(name: string): string {
  const line = code().split('\n').find(l => l.trim().startsWith(`${name}: {`));
  expect(`${name}:${line !== undefined}`).toBe(`${name}:true`);
  return line as string;
}

describe('N5 — MessengerHome footer tabs', () => {
  it('the scan is reading the real screen + bar (guards a vacuous pass)', () => {
    expect(raw().length).toBeGreaterThan(20_000);
    expect(codeBar()).toContain('MSG_TABS:');
    expect(code()).toMatch(/import\s*\{[^}]*\bMessengerTabBar\b[^}]*\}\s*from\s*'\.\/MessengerTabBar'/);
  });

  it('labels are exactly Chats / Calls / Files / News / Channels, in order', () => {
    const labels = [...tabsBlock().matchAll(/label:\s*'([^']+)'/g)].map(m => m[1]);
    expect(labels).toEqual(['Chats', 'Calls', 'Files', 'News', 'Channels']);
  });

  it('the Groups footer tab is GONE (no Groups label or bare route in MSG_TABS)', () => {
    const block = tabsBlock();
    expect(block).not.toMatch(/label:\s*'Groups'/);
    expect(block).not.toMatch(/route:\s*'Groups'/);
  });

  it('the only bare-navigate route left is Files (N1 — Calls/News now embed)', () => {
    // N1 made Chats/Calls/News LOCAL `tab:` state (the bar stays mounted). Files
    // alone keeps a `route:` push, because its B-453 vault-PIN gate uses
    // `navigation.replace(...)` and cannot embed. See messengerPersistentTabs.
    const routes = [...tabsBlock().matchAll(/route:\s*'([A-Za-z]+)'/g)].map(m => m[1]);
    expect(routes).toEqual(['Files']);
    // The local tabs carry `tab:` markers instead of a bare navigate.
    const tabs = [...tabsBlock().matchAll(/tab:\s*'([A-Za-z]+)'/g)].map(m => m[1]);
    expect(tabs).toEqual(['Chats', 'Calls', 'News']);
  });

  it('Channels is an EXIT-HOP through the shell resolver, never a bare navigate', () => {
    const c = codeBar();
    // Resolver imported the same way SecureTabNavigator / DepartmentalNavigator do.
    expect(c).toMatch(
      /import\s*\{[^}]*navigateToMessengerScreen[^}]*\}\s*from\s*'@navigation\/messengerDeepLink'/,
    );
    // The tap hops out to the cross-shell DepartmentChannels target, initial:false.
    expect(c).toMatch(
      /navigateToMessengerScreen\(\s*navigation as never,\s*'DepartmentChannels',\s*\{\},\s*\{\s*initial:\s*false\s*\}\)/,
    );
    // And NOT a bare in-stack navigate (which no-ops in shells lacking the route).
    expect(c).not.toMatch(/navigation\.navigate\(\s*'DepartmentChannels'/);
  });
});

describe('N4 — conditional "Secure Services" back chevron', () => {
  it('renders gated on activeProduct === secure (client-shell only by construction)', () => {
    expect(code()).toMatch(
      /useProductStore\(\s*s\s*=>\s*s\.activeProduct\s*===\s*'secure'\s*\)/,
    );
  });

  it('the chevron navigates back to the Secure product tab (SecureTab)', () => {
    // NAV-10 (2026-08-26) — the press now routes through navigateOnce (same
    // destination, guarded against a mash). Still a SecureTab hop.
    expect(code()).toMatch(/navigateOnce\(navigation,\s*'SecureTab'/);
  });

  it('the chevron never eats the title shrink (its own style is flexShrink:0)', () => {
    expect(styleLine('headerBackBtn')).toMatch(/flexShrink:\s*0/);
  });

  it('the header-fit pins survive — headerLeft AND headerTitleCol still shrink', () => {
    expect(styleLine('headerLeft')).toMatch(/flex:\s*1/);
    expect(styleLine('headerLeft')).toMatch(/minWidth:\s*0/);
    expect(styleLine('headerTitleCol')).toMatch(/flex:\s*1/);
    expect(styleLine('headerTitleCol')).toMatch(/minWidth:\s*0/);
  });
});

// ───────── B-661 — Channels is gated to non-LITE (founder, 2026-08-25) ────────

describe('B-661 — the Channels tab is not shown to a LITE account', () => {
  const read = (...p: string[]) =>
    readFileSync(join(process.cwd(), ...p), 'utf8').replace(/\r\n/g, '\n');
  /** Comments carry the words we assert on, so they are stripped before any
   *  presence/absence check (the house trap: prose reading as code). */
  const stripSrc = (src: string) =>
    src
      .split('\n')
      .filter(l => {
        const t = l.trim();
        return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
      })
      .join('\n');

  const BAR_CODE   = stripSrc(read('src', 'screens', 'messenger', 'MessengerTabBar.tsx'));
  const RULE  = stripSrc(read('src', 'screens', 'messenger', 'channelsAccess.ts'));
  const HOME  = stripSrc(read('src', 'screens', 'messenger', 'MessengerHomeScreen.tsx'));
  const FILES = stripSrc(read('src', 'screens', 'messenger', 'FilesScreen.tsx'));

  it('states the rule ONCE, in channelsAccess — never inline at a call site', () => {
    /**
     * The tier test is written in exactly one place. Two hosts render this bar
     * (MessengerHome and the pushed FilesScreen); a condition re-typed at each
     * is the duplicate-copy class — one behaviour, N drifted copies — and it is
     * precisely how one surface keeps a door the other closed.
     */
    expect(RULE.match(/\.isEnterprise \|\| \w+\.effective !== 'lite'/g)?.length).toBe(1);
    // Reads the MESSENGER entitlement, not the Secure plan — a different ladder
    // that merely shares the lite/pro vocabulary (SP-01).
    expect(RULE).toMatch(/deriveEntitlements/);
    // And no host may restate it.
    for (const host of [HOME, FILES, BAR_CODE]) {
      expect(host).not.toMatch(/effective !== 'lite'/);
    }
  });

  it('both entry points funnel through the single predicate', () => {
    // canSeeChannels(user) is for a host holding the raw user; canSeeChannelsFor
    // (entitlements) is for one that already derived them. The second must
    // DELEGATE, not re-derive, or there are two answers again.
    expect(RULE).toMatch(
      /export function canSeeChannelsFor\(ent: Entitlements\): boolean \{\n\s*return ent\.isEnterprise/,
    );
    expect(RULE).toMatch(
      /export function canSeeChannels\(user: EntitledUser\): boolean \{\n\s*return canSeeChannelsFor\(deriveEntitlements\(user\)\);/,
    );
  });

  it('BOTH hosts pass the answer — a wired bar and an unwired one is the bug', () => {
    // FilesScreen was the one left behind on the first pass: because the prop
    // defaults TRUE, a LITE user still saw Channels there while it was gone
    // from MessengerHome. Same account, same session, two answers.
    expect(HOME).toMatch(/showChannels=\{canSeeChannels\(user\)\}/);
    expect(FILES).toMatch(/showChannels=\{canSeeChannelsFor\(entitlements\)\}/);
  });

  it('the bar takes the decision as a PROP and does not read the auth store', () => {
    /**
     * A hook inside the bar was tried first and backed out: reaching into the
     * auth store gave a presentational footer a transitive dependency on
     * expo-local-authentication and @react-native-firebase/crashlytics, which
     * killed four unrelated suites. A footer that cannot render without
     * Crashlytics is the wrong shape. This pin keeps it from coming back.
     */
    expect(BAR_CODE).toMatch(/showChannels\?: boolean;/);
    expect(BAR_CODE).not.toMatch(/@store\/authStore/);
    expect(BAR_CODE).not.toMatch(/@store\/entitlements/);
    expect(BAR_CODE).not.toMatch(/useShowChannels/);
  });

  it('omitting the prop KEEPS the tab — losing a door silently is the worse failure', () => {
    // Default TRUE, deliberately. A third host added later without the prop
    // shows Channels to everyone (visible, reportable) rather than hiding it
    // from everyone (invisible, and indistinguishable from "not built yet").
    expect(BAR_CODE).toMatch(/showChannels = true,/);
  });

  it('the bar filters its own list, and the render loop reads the FILTERED one', () => {
    expect(BAR_CODE).toMatch(/const visibleTabs = React\.useMemo\(/);
    expect(BAR_CODE).toMatch(/t\.exit !== 'DepartmentChannels'/);
    expect(BAR_CODE).toMatch(/\{visibleTabs\.map\(tab => \{/);
    expect(BAR_CODE).not.toMatch(/\{MSG_TABS\.map\(tab => \{/);
  });

  it('MSG_TABS still DECLARES Channels — the gate is visibility, not deletion', () => {
    // Deleting the entry would break every non-LITE user and lose the exit-hop
    // wiring (B-414's shell-aware resolve). The tab exists; it is filtered.
    expect(BAR_CODE).toMatch(/label: 'Channels', exit: 'DepartmentChannels'/);
  });
});
