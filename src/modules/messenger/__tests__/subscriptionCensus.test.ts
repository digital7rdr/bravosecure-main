/**
 * W3(b) — the store-subscription CENSUS (DEAD_PHONE_SMOOTHNESS_PLAN.md, F6).
 *
 * Why this exists: the 2026-08-24 lag regression (M1/M8 — the "perf spine"
 * commit) shipped through a fully green suite because no test could SEE a
 * new store subscription appearing in an always-mounted subtree. Every
 * `useMessengerStore(...)` hook re-runs its selector on every store commit
 * of the busiest store in the app — a subscription added to a hot surface
 * is a per-message tax that no unit test measures.
 *
 * The contract:
 *   1. Every file's `useMessengerStore(` call-site COUNT is pinned below.
 *      Adding (or removing) one anywhere fails this test until the ledger
 *      is edited — a one-line change, next to a comment, in review.
 *   2. WHOLE-MAP subscriptions (`s => s.messages` / bare
 *      `s => s.conversations`) are FROZEN, shrink-only debt: with immer,
 *      every store commit mints a new map object, so these re-render their
 *      subscriber on EVERY inbound message anywhere (see messengerRenderPerf
 *      and MESSENGER_LAG_AUDIT_2026-08-24 M2/M3). The 9 existing ones are
 *      allowlisted; a NEW one fails no matter which file it lands in.
 *      Prefer a WeakMap-cached narrow selector + useShallow (the
 *      selectCallMessages pattern) — NOT bare useShallow over the map,
 *      which still fails when a member object is replaced.
 *
 * Counting rules (must match census-seed exactly, or the ledger drifts):
 * block + line comments stripped first (the house comment-stripper rule —
 * prose mentions of the hook were 4 of the raw 91 hits); `__tests__`
 * excluded; CRLF-safe line splitting. Known limitation: a `//` inside a
 * string literal truncates that line for counting — acceptable, both the
 * seed and the assertion share the behavior.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {join, sep} from 'node:path';

const ROOT = join(process.cwd(), 'src');

function strip(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => { const i = l.indexOf('//'); return i >= 0 ? l.slice(0, i) : l; })
    .join('\n');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, {withFileTypes: true})) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') {walk(p, out);}
    } else if (/\.(ts|tsx)$/.test(e.name)) {
      out.push(p);
    }
  }
  return out;
}

const WHOLE_MAP_RE = /useMessengerStore\(\s*(?:s|state)\s*=>\s*(?:s|state)\.(?:messages|conversations)\s*\)/g;

// ─── The ledger. Edit ONLY with a reason the reviewer can read. ────────────
// Raising a count on an ALWAYS-MOUNTED surface (MessengerHomeScreen, avatars,
// tab bars, overlay hosts) needs a stronger reason than one on a pushed
// screen — that is the M1/M8 class this file exists to catch at diff time.
const SUBSCRIPTION_LEDGER: ReadonlyArray<readonly [string, number]> = [
  // B-692 S-3 — always-mounted overlay host (App.tsx), so it needs the strong
  // reason: the ONE subscription is the narrow scalar `s.activeConversationId`
  // (banner suppression/retire for the open thread). Selector cost per commit
  // is a property read; it re-renders only when the active thread changes.
  ['src/components/InAppMessageBanner.tsx', 1],
  ['src/modules/messenger/contacts/useRegisteredNames.ts', 2],
  ['src/modules/messenger/hooks/useMessenger.ts', 2],
  ['src/modules/messenger/ui/GroupAvatar.tsx', 1],
  ['src/modules/messenger/ui/UserAvatar.tsx', 1],
  ['src/modules/messenger/vault/useCompanyShelf.ts', 3],
  ['src/screens/agent/AgentLiveTrackerScreen.tsx', 4],
  ['src/screens/dashboard/DashboardScreen.tsx', 1],
  ['src/screens/deptchat/channelUnread.ts', 2],
  ['src/screens/deptchat/useDeptUnread.ts', 2],
  // B-695 (2026-08-29): 3 → 4 — the peer-name lookup split into two narrow
  // selectors (canonical convo row + resolved display name, both returning
  // store-held refs/primitives) replacing the single raw-row subscription.
  ['src/screens/messenger/CallScreen.tsx', 4],
  ['src/screens/messenger/CallsLogScreen.tsx', 2],
  ['src/screens/messenger/ChatInfoScreen.tsx', 10],
  // B-703 MR-11: 21 → 20. The `setActiveConversation` selector went with the
  // pin/clear pair into `useActiveConversation`, which reads the setter off
  // `getState()` instead of subscribing — one fewer subscription on the repo's
  // worst-measured jank path (open-a-chat).
  ['src/screens/messenger/ChatScreen.tsx', 20],
  ['src/screens/messenger/DepartmentChannelsScreen.tsx', 1],
  // B-703 MR-9: 4 → 5. The composer's group-key gate (`groupKeyPending`), the
  // same one-source rule ChatScreen uses. A BOOLEAN selector → primitive
  // equality, so it re-renders only when the key actually arrives.
  ['src/screens/messenger/DepartmentChatScreen.tsx', 5],
  ['src/screens/messenger/FilesScreen.tsx', 5],
  ['src/screens/messenger/GroupCallScreen.tsx', 4],
  ['src/screens/messenger/GroupsScreen.tsx', 2],
  ['src/screens/messenger/IncomingGroupCallScreen.tsx', 2],
  ['src/screens/messenger/LinksScreen.tsx', 1],
  ['src/screens/messenger/MessengerHomeScreen.tsx', 8],
  ['src/screens/messenger/NewChatScreen.tsx', 2],
  ['src/screens/messenger/useDeptConversationFilter.ts', 2],
];

// FROZEN whole-map debt (2026-08-29). Shrink-only: fixing one means
// DELETING its row here. Never add a row — build a narrow cached selector.
const WHOLE_MAP_DEBT: ReadonlyArray<readonly [string, number]> = [
  ['src/modules/messenger/vault/useCompanyShelf.ts', 1],
  ['src/screens/messenger/CallScreen.tsx', 1],
  ['src/screens/messenger/CallsLogScreen.tsx', 1],
  ['src/screens/messenger/ChatInfoScreen.tsx', 1],
  ['src/screens/messenger/FilesScreen.tsx', 1],
  ['src/screens/messenger/GroupCallScreen.tsx', 1],
  ['src/screens/messenger/GroupsScreen.tsx', 1],
  ['src/screens/messenger/LinksScreen.tsx', 1],
  ['src/screens/messenger/NewChatScreen.tsx', 1],
];

function scan(): {counts: Map<string, number>; whole: Map<string, number>} {
  const counts = new Map<string, number>();
  const whole = new Map<string, number>();
  for (const p of walk(ROOT)) {
    const src = strip(readFileSync(p, 'utf8'));
    const rel = p.split(sep).join('/').slice(p.split(sep).join('/').indexOf('src/'));
    const n = (src.match(/useMessengerStore\(/g) ?? []).length;
    if (n > 0) {counts.set(rel, n);}
    const w = (src.match(WHOLE_MAP_RE) ?? []).length;
    if (w > 0) {whole.set(rel, w);}
  }
  return {counts, whole};
}

describe('W3(b) — messenger store subscription census', () => {
  const {counts, whole} = scan();

  it('every useMessengerStore call site is on the ledger (M1/M8 gate)', () => {
    const ledger = new Map(SUBSCRIPTION_LEDGER);
    const drift: string[] = [];
    for (const [file, n] of counts) {
      const pinned = ledger.get(file);
      if (pinned === undefined) {drift.push(`NEW subscriber file: ${file} (${n} sites) — add to the ledger WITH a reason`);}
      else if (pinned !== n) {drift.push(`${file}: ${n} sites, ledger says ${pinned} — update the ledger WITH a reason`);}
    }
    for (const [file] of ledger) {
      if (!counts.has(file)) {drift.push(`${file}: on the ledger but has no subscriptions — remove its row`);}
    }
    expect(drift).toEqual([]);
  });

  it('whole-map subscriptions are FROZEN — shrink-only, never grow', () => {
    const debt = new Map(WHOLE_MAP_DEBT);
    const violations: string[] = [];
    for (const [file, n] of whole) {
      const allowed = debt.get(file) ?? 0;
      if (n > allowed) {
        violations.push(
          `${file}: ${n} whole-map subscription(s), allowlist permits ${allowed}. ` +
          'Do NOT add rows here — use a WeakMap-cached narrow selector (selectCallMessages pattern).',
        );
      }
    }
    for (const [file, allowed] of debt) {
      const actual = whole.get(file) ?? 0;
      if (actual < allowed) {
        violations.push(`${file}: debt shrank to ${actual} (allowlist ${allowed}) — DELETE its row to lock the win in`);
      }
    }
    expect(violations).toEqual([]);
  });
});
