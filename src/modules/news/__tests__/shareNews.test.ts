/**
 * Founder 2026-08-05 — every news link, on Bravo Intel AND My Feed, must be
 * shareable to INTERNAL Bravo contacts and groups ("to encourage a community
 * within the App"). Founder 2026-08-08 — the VBG news surfaces (OSINT threat
 * feed, GeoRisk risk articles) join the same rule.
 *
 * Deliberately not the OS share sheet — that sends people out of the app, which
 * is the opposite of the goal. The picker reuses `ForwardList`, the same
 * conversation picker the message-forward flow uses, so it inherits that
 * component's exclusion of department channels (forwarding into a broadcast
 * channel would bypass its post-role check).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
// From the PURE module, not the .tsx — ShareNewsSheet imports ForwardList from
// ChatScreen, whose native deps this project cannot parse.
import {buildShareText} from '../shareNewsText';

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Comments stripped LINE BY LINE — required before any ABSENCE assertion.
 * The first version of the `navigate('Chat')` check below matched the phrase
 * inside ShareNewsSheet's own docblock (which explains why it does NOT navigate)
 * and failed on prose. That is the exact false positive CLAUDE.md records as the
 * most common source-scan mistake. A block-comment regex is not used because the
 * house one is documented to delete real code when it meets a `/*` in a string.
 */
function codeOnly(rel: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src(rel).split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('//') || t.startsWith('*')) {continue;}
    out.push(line);
  }
  return out.join('\n');
}

describe('news sharing — the message body', () => {
  it('carries the headline and the URL so the bubble renders a link preview', () => {
    const out = buildShareText({title: 'Fuego volcano intensifies', url: 'https://ex.com/a', source: 'Reuters'});
    expect(out).toContain('Fuego volcano intensifies');
    expect(out).toContain('https://ex.com/a');
    expect(out).toContain('via Reuters');
  });

  it('strips the Bravo Intel "SOURCE:" prefix rather than repeating it', () => {
    // IntelItem.src arrives as "SOURCE: GUARDIAN"; "via SOURCE: GUARDIAN" reads badly.
    expect(buildShareText({title: 'T', url: 'u', source: 'SOURCE: GUARDIAN'})).toContain('via GUARDIAN');
  });

  it('omits the attribution line entirely when there is no source', () => {
    expect(buildShareText({title: 'T', url: 'https://x.y'})).toBe('T\nhttps://x.y');
  });
});

describe('news sharing — both surfaces are wired', () => {
  it('Bravo Intel offers SHARE alongside OPEN ARTICLE', () => {
    const s = src('src/screens/news/IntelFeedScreen.tsx');
    expect(s).toMatch(/SHARE/);
    expect(s).toMatch(/setShareItem\(/);
    expect(s).toMatch(/<ShareNewsSheet/);
  });

  it('My Feed offers share on EVERY article row, not just the first', () => {
    const s = src('src/screens/news/NewsFeedScreen.tsx');
    // ArticleRow is the single row component used by all three list sections,
    // so wiring it once covers region sections, category groups and the flat
    // list. Assert the prop is threaded at every call site.
    const rows = [...s.matchAll(/<ArticleRow\b[^/]*\/>/g)].map(m => m[0]);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every(r => /onShare=\{shareArticle\}/.test(r))).toBe(true);
    expect(s).toMatch(/<ShareNewsSheet/);
  });

  it('shares INTO the app — no OS share sheet on any sharing surface', () => {
    for (const f of [
      'src/screens/news/IntelFeedScreen.tsx',
      'src/screens/news/NewsFeedScreen.tsx',
      'src/screens/vbg/VBGOSINTScreen.tsx',
      'src/screens/vbg/VBGGeoRiskScreen.tsx',
    ]) {
      expect(src(f)).not.toMatch(/\bShare\.share\(/);
    }
  });

  it('VBG OSINT threat cards offer share on every card with a url', () => {
    const s = src('src/screens/vbg/VBGOSINTScreen.tsx');
    expect(s).toMatch(/setShareItem\(\{title: t\.title, url: t\.url, source: t\.source\}\)/);
    expect(s).toMatch(/<ShareNewsSheet/);
  });

  it('VBG GeoRisk risk articles offer share — in the PANEL, so the Home embed gets it too', () => {
    const s = src('src/screens/vbg/VBGGeoRiskScreen.tsx');
    // Inside GeoRiskPanel (not the screen wrapper): the panel is embedded on
    // the VBG Home dashboard as well, so state hoisted to the screen would
    // silently drop share from the embed.
    const panel = s.slice(s.indexOf('export function GeoRiskPanel'), s.indexOf('export default function VBGGeoRiskScreen'));
    expect(panel).toMatch(/setShareItem\(\{title: a\.title, url: a\.url, source: a\.source\}\)/);
    expect(panel).toMatch(/<ShareNewsSheet/);
  });

  it('reuses ForwardList for CHATS rather than introducing a second conversation picker', () => {
    // Re-pointed 2026-08-22, not relaxed. The sheet gained a second list — but
    // for a different target CLASS (workspace channels, see the describe below),
    // which ForwardList cannot serve because it deliberately excludes them.
    // Chats and groups must still come from the one shared picker.
    const s = codeOnly('src/modules/news/ShareNewsSheet.tsx');
    expect(s).toMatch(/import \{ForwardList\} from '@screens\/messenger\/ChatScreen'/);
    expect(s).toMatch(/<ForwardList currentConvId="" onPick=/);
  });

  it('does not open a new door onto ChatScreen', () => {
    // deptChatNoChatScreenDoor.test.ts sweeps for this repo-wide; keep the
    // share path sending via the runtime instead of navigating.
    const s = codeOnly('src/modules/news/ShareNewsSheet.tsx');
    expect(s).not.toMatch(/navigate\(\s*['"]Chat['"]/);
    expect(s).toMatch(/sendText\(/);
  });
});

/**
 * Client 2026-08-22 — sharing a story into a WORKSPACE CHANNEL.
 *
 * This is a NEW WRITE PATH into a department channel, which is exactly what F7
 * closed off in the generic forward picker. It may exist only because it carries
 * the role check that picker could not: the assertions below are about the GATE,
 * not the layout.
 *
 * Source scan: ShareNewsSheet pulls ChatScreen, the messenger runtime and the
 * API layer, none of which the node project can import — the same reason every
 * other invariant on these screens is pinned this way.
 */
describe('news sharing — the workspace channel door is gated', () => {
  const SHEET = () => codeOnly('src/modules/news/ShareNewsSheet.tsx');

  it('the scan is reading the real sheet (guards a vacuous pass)', () => {
    expect(SHEET().length).toBeGreaterThan(2_000);
    expect(SHEET()).toMatch(/sendToChannel/);
  });

  it('offers workspaces from the SHARED grouping helper, never a local re-derivation', () => {
    // organisationTreeSingleSource bans a second copy of the flat-list →
    // organisation rule; shareChannelTargets is the one adapter for this surface.
    const s = SHEET();
    expect(s).toMatch(/from '\.\/shareChannelTargets'/);
    expect(s).toMatch(/shareWorkspaceGroups\(/);
  });

  it('RE-CHECKS the role against the server before writing, and refuses on "no"', () => {
    // THE DECISION SITE: inside sendToChannel, the listMembers round-trip and
    // the refusal must both sit BEFORE sendText. A scan for the symbols anywhere
    // in the file would stay green with the guard deleted.
    const s = SHEET();
    const start = s.indexOf('const sendToChannel');
    expect(start).toBeGreaterThan(-1);
    const body = s.slice(start, s.indexOf('const openGroup', start));
    expect(body).toBeTruthy();
    const check = body.indexOf('departmentApi.listMembers(');
    // The refusal is the LAST one before the write — the 4xx branch above it
    // refuses too, and anchoring on the first would not prove the gate that
    // guards `sendText` itself returns.
    const write = body.indexOf('rt.sendText(');
    const refuse = body.lastIndexOf("finish('Read-only'", write);
    expect(check).toBeGreaterThan(-1);
    expect(refuse).toBeGreaterThan(check);
    expect(write).toBeGreaterThan(refuse);
    // The refusal RETURNS — it must not fall through into the send.
    expect(body.slice(refuse, write)).toMatch(/return;/);
  });

  it('delegates the decision to the pure, behaviour-tested rule', () => {
    // The ordering assertions above cannot see whether the server's answer is
    // OBEYED — `|| t.postable` would satisfy every one of them while making the
    // round-trip a no-op. So the decision lives in `allowShareToChannel`, whose
    // semantics are pinned in shareChannelTargets.test.ts, and the sheet must
    // actually call it rather than re-deciding inline.
    const s = SHEET();
    const start = s.indexOf('const sendToChannel');
    const body = s.slice(start, s.indexOf('const openGroup', start));
    expect(body).toMatch(/allowShareToChannel\(\{cachedPostable: t\.postable, server\}\)/);
    // A local `post_mode === 'open'` HERE would be the drifting second copy the
    // server already folded into my_role (memberRoleFor). Scoped to the callback:
    // a file-wide absence assertion would go red on any legitimate later use.
    expect(body).not.toMatch(/post_mode/);
  });

  it('a 4xx from the role check REFUSES — it is an answer, not an outage', () => {
    // listMembers 403s for a non-member. Treating every throw as "offline" would
    // let somebody removed from the channel seconds ago post anyway.
    const s = SHEET();
    const start = s.indexOf('const sendToChannel');
    const body = s.slice(start, s.indexOf('const openGroup', start));
    expect(body).toMatch(/status >= 400 && status < 500/);
    const at = body.indexOf('status >= 400');
    expect(body.slice(at, at + 260)).toMatch(/Read-only[\s\S]{0,200}return;/);
  });

  it('refreshes the roster from the same call, so the fan-out reaches new members', () => {
    // `sendText` fans out to the LOCAL conversation's participants. A member who
    // joined after this device last opened the channel is absent from that row,
    // so the share would silently miss them and still report "Shared".
    const s = SHEET();
    const start = s.indexOf('const sendToChannel');
    const body = s.slice(start, s.indexOf('const openGroup', start));
    expect(body).toMatch(/data\.members/);
    expect(body).toMatch(/upsertConversation\(/);
    expect(body).toMatch(/participants: memberIds/);
  });

  it('refuses a row the picker already marked unpostable, and one with no group', () => {
    // Belt and braces at the entry to the write: `postable` is the list's flag
    // and `groupConversationId` is the thing being written to.
    const s = SHEET();
    // Anchor INSIDE the callback: `setSending(true)` also appears in `send()`
    // ABOVE this one, so a slice to its first occurrence is empty and the
    // assertion passes vacuously (it did, on the first draft of this test).
    const start = s.indexOf('const sendToChannel');
    expect(start).toBeGreaterThan(-1);
    const guard = s.slice(start, s.indexOf('setSending(true)', start));
    expect(guard).toMatch(/!t\.postable/);
    expect(guard).toMatch(/!t\.groupConversationId/);
  });

  it('fans out as a GROUP send — the channel is a group, not a 1:1', () => {
    const s = SHEET();
    const body = s.slice(s.indexOf('const sendToChannel'), s.indexOf('const openGroup', s.indexOf('const sendToChannel')));
    expect(body).toMatch(/isGroup: true/);
  });
});
