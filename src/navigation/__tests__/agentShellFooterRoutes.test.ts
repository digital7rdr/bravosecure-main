/**
 * N2 (LIVE BUG) — the shared MessengerHome footer's Call + News taps target
 * `CallsLog` / `NewsHub`, but the agency shell mounts MessengerHomeScreen
 * DIRECTLY (AgentNavigator), not MessengerNavigator, so those two routes were
 * never registered there and the taps silently no-op.
 *
 * This scan derives the footer's routed targets from MSG_TABS itself and
 * asserts every one is registered in AgentNavigator — so a future footer tab
 * that forgets the agency shell fails here too. Comments stripped; CRLF-aware.
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

const AGENT = strip(
  readFileSync(join('src', 'navigation', 'AgentNavigator.tsx'), 'utf8'),
);
// Client 2026-08-22 — the footer (MSG_TABS + the resolver exit-hop) lives in
// the shared MessengerTabBar module now (Files hosts the same bar), so the
// footer's routed targets are derived from THERE; MessengerHome still imports it.
const HOME = strip(
  readFileSync(join('src', 'screens', 'messenger', 'MessengerTabBar.tsx'), 'utf8'),
);
const HOME_SCREEN = strip(
  readFileSync(join('src', 'screens', 'messenger', 'MessengerHomeScreen.tsx'), 'utf8'),
);
// Guard the re-point itself: the screen must use the shared bar, or this scan
// is reading a module nothing renders.
if (!/import\s*\{[^}]*\bMessengerTabBar\b[^}]*\}\s*from\s*'\.\/MessengerTabBar'/.test(HOME_SCREEN)) {
  throw new Error('MessengerHomeScreen no longer imports ./MessengerTabBar — re-point this scan');
}

function registers(name: string): boolean {
  return new RegExp(`name="${name}"`).test(AGENT);
}

describe('agency shell footer routes (N2)', () => {
  it('registers the footer push route (Files) in AgentNavigator (N1/N2)', () => {
    const decl = HOME.indexOf('MSG_TABS:');
    expect(decl).toBeGreaterThan(-1);
    const block = HOME.slice(decl, decl + 600);
    // N1 — Chats/Calls/News are LOCAL `tab:` state now (the bar stays mounted),
    // so the footer no longer PUSHES them. Files alone keeps a `route:` push
    // (its B-453 vault-PIN gate cannot embed), and it must exist in every shell.
    const tabs = [...block.matchAll(/tab:\s*'([A-Za-z]+)'/g)].map(m => m[1]);
    expect(tabs).toEqual(expect.arrayContaining(['Chats', 'Calls', 'News']));
    const routes = [...block.matchAll(/route:\s*'([A-Za-z]+)'/g)].map(m => m[1]);
    expect(routes).toEqual(['Files']);
    for (const r of routes) {
      expect(registers(r)).toBe(true);
    }
  });

  it('registers the deep-link push routes + the embedded bodies\' outbound targets', () => {
    // CallsLog / NewsHub stay registered for the missed-call deep-link PUSH lane
    // (BB-3 serverWakeColdStackSeed) even though the footer taps now embed them
    // as local state. NewsFeed / NewsPreferences / IntelFeed are where the
    // embedded News body navigates, so the agency shell needs them all.
    //
    // ⚠️ B-638 — `EmergencyServices` ADDED. The Calls body's emergency card is
    // now the ONLY door to it, and an embedded body navigating to a route the
    // agency shell does not register is the B-257/B-258 class: a silent no-op
    // in one shell with a green suite everywhere else.
    //
    // ⚠️ `Links` is KEPT registered but is NO LONGER an outbound target — the
    // client asked for its button removed ("just remove the button"), so
    // `LinksScreen` currently has no door at all. It stays registered so
    // restoring one is a one-line change; this list no longer claims the
    // embedded Calls body navigates there.
    for (const r of ['CallsLog', 'NewsHub', 'EmergencyServices', 'NewsFeed', 'NewsArticle', 'NewsPreferences', 'IntelFeed']) {
      expect(registers(r)).toBe(true);
    }
    expect(registers('Links')).toBe(true); // registered, deliberately door-less
  });

  it('the Channels footer tap is a resolver EXIT-HOP, not a bare route (N5)', () => {
    // Channels reaches the departmental tree through the shell-aware resolver, so
    // AgentNavigator (which does NOT register the tree on its root stack) is not
    // asked for a route it lacks. The tap must therefore hop out via
    // navigateToMessengerScreen('DepartmentChannels', …), never a bare `route:`.
    expect(HOME).toMatch(
      /navigateToMessengerScreen\(\s*navigation as never,\s*'DepartmentChannels',\s*\{\},\s*\{\s*initial:\s*false\s*\}\)/,
    );
    // And DepartmentChannels must NOT appear as a bare footer route — that is the
    // exact N2 shape (a route unregistered in this shell → a silent no-op).
    const decl = HOME.indexOf('MSG_TABS:');
    const block = HOME.slice(decl, decl + 600);
    expect(block).not.toMatch(/route:\s*'DepartmentChannels'/);
  });
});
