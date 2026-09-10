/**
 * Enterprise Dept Channels scope v2 — Phase 1, the M8 client half.
 *
 * Frame M8: "Group channels clearly across four levels: Enterprise, Main, Sub
 * and Sub-sub." Page 1 LOCKED RULES: "Exactly four organisational levels are
 * supported; no fifth level is permitted."
 *
 * DepartmentChannelsScreen mounts RN views, so this node project cannot import
 * it — comment-stripped source scan, same technique as bottomChrome.test.ts.
 *
 * The non-obvious rule pinned here is PROGRESSIVE DISCLOSURE. Until an org
 * actually builds a hierarchy, every channel is level 1, so switching to level
 * sections would collapse the entire list into one "Main channels" block and
 * destroy the existing Board / Department / Incident separation for every
 * current org — a real regression traded for a feature they are not using yet.
 * So the type grouping MUST survive as the no-hierarchy path. If someone later
 * deletes it to "simplify", that is a silent UX regression no other test sees.
 */
import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx');

/** CRLF file — normalise, or a `\n`-anchored pattern matches nothing and the
 *  assertion passes vacuously. */
function read(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
/**
 * LINE-ANCHORED, not greedy.
 *
 * The greedy `/\/\*[\s\S]*?\*\//g` form believes a `/*` inside a string
 * literal. Measured on this repo: it deletes **63 real code lines** from
 * `DepartmentChatScreen.tsx` (705→821), opened by
 * `DocumentPicker.getDocumentAsync({type: '*` — and `sourceScanSafety.test.ts`
 * lists that file as a KNOWN HAZARD for exactly this reason.
 *
 * It matters more now than it did: the postMode scan below was widened to walk
 * `.ts` as well as `.tsx` across both screen directories, and it also reads
 * `DepartmentChatScreen.tsx` directly for the exemption's compensating control.
 * A navigate site landing inside a swallowed span would be invisible, which
 * would make the test's own promise — "a fourth site added tomorrow is covered
 * without editing this test" — false.
 */
function strip(s: string): string {
  return s
    .replace(/^[ \t]*\/\*[\s\S]*?\*\/[ \t]*$/gm, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

describe('M8 — four-level channel grouping', () => {
  it('declares exactly four levels, and no fifth', () => {
    const src = strip(read());
    const block = src.slice(src.indexOf('const LEVELS'), src.indexOf('] as const', src.indexOf('const LEVELS')));
    // PDF checklist line 9 — LEVELS is now the bare stored-level keys. It used
    // to be `{level, label}` pairs whose labels were a fourth, upper-cased,
    // off-by-one copy of the tier vocabulary; the words are admin-chosen now
    // and are resolved at render. The DEPTH rule is unchanged and is what this
    // case is actually about.
    // Word-anchored: a bare /4/ would also match the 4 inside another number,
    // which would make the ABSENCE assertion below unfalsifiable.
    expect(block).toMatch(/\b0\b/);
    expect(block).toMatch(/\b1\b/);
    expect(block).toMatch(/\b2\b/);
    expect(block).toMatch(/\b3\b/);
    // The rule is a maximum, so the guard that matters is the ABSENCE of a 4.
    expect(block).not.toMatch(/\b4\b/);
    // Exactly four keys — was `level: \d` when LEVELS held {level,label} pairs.
    expect((block.match(/\b\d\b/g) ?? []).length).toBe(4);
  });

  it('defaults a missing level to 1 (Main) in ONE place, and nothing bypasses it', () => {
    const src = strip(read());
    expect(src).toMatch(/const levelOf = \(c: DepartmentChannelDto\): number => c\.level \?\? 1;/);
    // The repo's duplicate-copy bug class: if the `?? 1` default is inlined at
    // call sites too, one copy drifts and pre-hierarchy rows vanish from the
    // list. Every consumer must go through levelOf.
    //
    // Banning only a DUPLICATED `?? 1` was not enough: swapping a call site to a
    // bare `c.level === level` adds no inline default at all, so the old
    // assertion stayed green while every row with no level silently vanished
    // from the list. Ban raw `c.level` reads outside the helper instead.
    const outsideHelper = src.replace(/const levelOf =[^;]+;/, '');
    expect(outsideHelper).not.toMatch(/\bc\.level\b/);
  });

  it('renders level sections ALWAYS, in the mockup\'s header FORM', () => {
    // FOUNDER RULE: "the UI should be like the way shown in the PDF."
    // This replaced an earlier progressive-disclosure design (type sections
    // until a hierarchy existed). The M8 mockup shows level sections
    // unconditionally, headed "LEVEL 1 — BOARD" … "LEVEL 4 — TEAM /
    // SUB-CHANNELS", so the conditional is gone deliberately — do not
    // reintroduce it as a "no channels yet" optimisation.
    const src = strip(read());
    expect(src).toMatch(/LEVELS\.map/);
    expect(src).not.toMatch(/channels\.some\(c => levelOf\(c\) !== 1\)/);
    /**
     * PDF checklist line 9 — THE HEADER FORM IS PINNED, NOT THE WORDS.
     *
     * These used to assert the literals 'LEVEL 1 — ENTERPRISE' and
     * 'LEVEL 4 — TEAM / SUB-CHANNELS'. Admins choose the tier names now, so a
     * literal assertion would pin a DEFAULT and fail the moment anyone renamed
     * a tier — while proving nothing about the header actually rendering.
     *
     * What still matters, and is asserted: the mockup's shape ("LEVEL n — NAME",
     * numbered 1-4 for humans while the DB stores 0-3) and that the name comes
     * from the shared resolver rather than a fifth inline copy.
     */
    // Plain substrings, not regexes: the thing being asserted IS a template
    // literal full of `${`, `(`, `)` and `.`, and escaping it as a pattern is
    // how a scan ends up matching nothing and passing vacuously.
    expect(src).toContain('LEVEL ${level + 1} — ${nameForTier(level + 1, levelNames).toUpperCase()}');
    expect(src).toContain("from '@screens/deptchat/levelNames'");
  });

  it('shows a member count per row, as the mockup does', () => {
    const src = strip(read());
    expect(src).toMatch(/member_count/);
    expect(src).toMatch(/member\$\{c\.member_count === 1 \? '' : 's'\}/);
  });

  it('keeps the channel TYPE readable once level sections replace type sections', () => {
    // Level grouping removes the Board/Department/Incident headings, so the type
    // signal has to survive on the row — otherwise the switch silently loses
    // information the user relies on.
    const src = strip(read());
    expect(src).toMatch(/const iconForType =/);
    expect(src).toMatch(/icon={iconForType\(c\.channel_type\)}/);
  });

  it('a PRODUCER exists — the editor can actually send parent_id', () => {
    // Without this the whole feature is unreachable: every channel stays level
    // 1, the level-section arm can never render, and the assertions above pin
    // code that cannot execute on device. The first pass shipped exactly that.
    const editor = strip(
      readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', 'ChannelEditorScreen.tsx'), 'utf8')
        .replace(/\r\n/g, '\n'));
    expect(editor).toMatch(/parent_id: parentId/);
    // Create-only: re-parenting is refused by the DB, so the edit path must not
    // offer it (a picker that always 400s is worse than no picker).
    expect(editor).toMatch(/!editing && parents\.length > 0/);
    // Never offer a level-3 parent — the CHECK would reject the child anyway.
    expect(editor).toMatch(/\(c\.level \?\? 1\) < 3/);
  });

  it('A9 Manage Channels is level-aware, and its indentation is TRUTHFUL', () => {
    const manage = strip(
      readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', 'ManageChannelsScreen.tsx'), 'utf8')
        .replace(/\r\n/g, '\n'));
    expect(manage).toMatch(/manageLevelOf/);
    // Depth has to be VISIBLE, not merely fetched.
    expect(manage).toMatch(/marginLeft: depth \* 16/);
    // …and indentation without depth-first order is a LIE. The server returns
    // all level-1s then all level-2s, so indenting that stream draws every
    // sub-channel under whichever main happens to be last — worse than the flat
    // list it replaced, because indentation is the signal for "child of the row
    // above". The list must be tree-ordered before it is indented.
    expect(manage).toMatch(/export function treeOrder/);

    // STRUCTURAL, not a roll-call. Naming `active` and `archived` here would
    // rebuild the exact narrowing this pin exists to stop — `active` was
    // ordered, `archived` was not, and a test listing today's two lists would
    // not notice a third. Assert the COUPLING instead:
    //   1. Row cannot compute depth itself — it must be handed one.
    //   2. Row is only ever rendered from a treeOrder destructure.
    // A caller that skips treeOrder then has no depth to pass and cannot
    // render an indented row at all.
    // The prop LIST is not pinned — only that `depth` is one of them.
    // Pinning the exact destructure made this fail when `tierNoun` was added
    // for the admin-chosen tier names (PDF checklist line 9), which is a
    // false positive: the coupling being protected is `depth`, and an
    // over-tight pattern that fails on unrelated props gets loosened by
    // whoever hits it next — usually by deleting it.
    expect(manage).toMatch(/function Row\(\{[^}]*\bdepth\b[^}]*\}/);

    // `depth` is a PROP, not a local — Row must never ASSIGN to it.
    // Banning one spelling of the derivation (`manageLevelOf(c) - 1`) left
    // `depth = (c.level ?? 1) - 1;` wide open: signature untouched, indent
    // expression untouched, guarantee discarded in one statement. Banning
    // assignment closes every spelling at once. (`depth: number` in the
    // annotation and `depth * 16` in the body do not match.)
    const rowBody = manage.slice(manage.indexOf('function Row('));
    expect(rowBody).not.toMatch(/\bdepth\s*=[^=]/);

    // Every Row render site passes a depth that came from the walk. Split on
    // the tag rather than regexing `<Row[^>]*>` — that truncates at the `>` in
    // `onPress={() =>` and would fire a FALSE red merely for reordering props.
    const renders = manage.split('<Row').slice(1).map(s => s.slice(0, s.indexOf('/>')));
    expect(renders.length).toBeGreaterThanOrEqual(2);
    for (const r of renders) {expect(r).toMatch(/depth=\{depth\}/);}

    // …and every list feeding those renders is tree-ordered. Tolerant of field
    // order and extra fields, so a legitimate refactor does not cry wolf — the
    // repo's documented way of teaching people to weaken a test.
    const maps = [...manage.matchAll(/\{(\w+)\.map\(\(\s*\{[^}]*\bdepth\b[^}]*\}\s*\)/g)];
    expect(maps.length).toBe(renders.length);
    /**
     * Every indented list must come from a REAL depth-first walk, never from a
     * locally derived depth. Two such walks now exist and both are legitimate:
     *
     *   - `treeOrder` — this screen's own, which walks from every root and
     *     appends orphans at depth 0;
     *   - `subtreeOf` — the SHARED helper's, which walks one organisation.
     *     vs2 item 8 scopes this screen per organisation, so the whole-list
     *     walk cannot express it.
     *
     * The set is closed on purpose: adding a third name here should require
     * thinking about whether it is really a walk, which is the entire point of
     * this assertion. And `subtreeOf` must be the IMPORTED shared symbol — a
     * local function of the same name would defeat it silently.
     */
    for (const m of maps) {
      const name = m[1];
      const walked = new RegExp(`const ${name} = (treeOrder|useMemo)\\(`).test(manage)
        && new RegExp(`const ${name} =[\\s\\S]{0,200}?(treeOrder|subtreeOf)\\(`).test(manage);
      expect(`${name}:${walked}`).toBe(`${name}:true`);
    }
    expect(manage).toMatch(/import \{[^}]*\bsubtreeOf\b[^}]*\} from '\.\/organisationTree'/);
  });

  it('EVERY DepartmentChat navigate site passes postMode', () => {
    /**
     * Receive-side enforcement of read-only / #broadcast is switched on by
     * `route.params.postMode`. A navigate site that omits it silently sets
     * enforcePosters=false — the rule is simply off for anyone arriving that
     * way, with nothing failing. Three sites existed and one (the Announcements
     * card on Departmental Home — the deep link into the read-only channel,
     * where the rule matters most) had no postMode at all.
     *
     * Structural, not a roll-call: it globs the screens, finds every navigation
     * to DepartmentChat, and requires postMode in each param block. A fourth
     * site added tomorrow is covered without editing this test.
     */
    const dirs = [
      join(process.cwd(), 'src', 'screens', 'messenger'),
      join(process.cwd(), 'src', 'screens', 'deptchat'),
    ];
    let sites = 0;
    const perFile: Record<string, number> = {};
    for (const dir of dirs) {
      // `.ts` AS WELL AS `.tsx`. The sites moved into `openDepartmentChannel.ts`
      // when the two doors were merged onto one opener, and a .tsx-only glob
      // stopped seeing them: this scan went from 3 sites to ZERO and only the
      // anti-vacuity floor below caught it. A screens directory holds
      // navigating logic in both extensions.
      for (const f of readdirSync(dir).filter(n => n.endsWith('.tsx') || n.endsWith('.ts'))) {
        const src = strip(readFileSync(join(dir, f), 'utf8').replace(/\r\n/g, '\n'));
        // Both shapes in use: navigate('DepartmentChat', {…}) and the nested
        // navigate('Main', {screen: 'DepartmentChat', params: {…}}) form.
        for (const m of src.matchAll(/['"]DepartmentChat['"]\s*,?/g)) {
          // Take the param object that follows this occurrence.
          const after = src.slice(m.index ?? 0, (m.index ?? 0) + 700);
          if (!/channelId/.test(after)) {continue;}   // a type/route decl, not a navigate
          // ONE named exemption, with a compensating control asserted below.
          //
          // `openConversation` opens a thread from a conversation LIST, where
          // the only thing it has is a store pointer row (`{channelId}`) — it
          // never sees the channel DTO, so there is no post_mode for it to
          // pass. Every site WITHIN THIS GLOB that starts from the DTO has no
          // excuse.
          //
          // It is not the only DTO-less door: `fcmBootstrap.ts`'s
          // `navigateToThread` is the notification lane's equivalent and passes
          // neither postMode nor myRole. It sits outside these directories, so
          // this scan cannot speak for it — do not read the assertion below as
          // covering the whole app. Both are safe for the same reason.
          //
          // This surfaced only when the glob widened to `.ts`; it had been
          // uncovered the whole time. It is safe because the SCREEN fails
          // closed on an absent param (asserted below) and re-reads the mode
          // from the server on focus — not because the site is unimportant.
          if (f === 'openConversation.ts') {continue;}
          sites++;
          perFile[f] = (perFile[f] ?? 0) + 1;
          // `\bpostMode\s*:` not a bare `postMode` substring — the loose form
          // matched `postModeREMOVED:` and stayed green through a mutation that
          // had genuinely deleted the param.
          expect(`${f}:${/\bpostMode\s*:/.test(after)}`).toBe(`${f}:true`);
        }
      }
    }
    // Anti-vacuity: if the navigate shape changes and the matcher stops
    // finding anything, this trips instead of passing on an empty sweep.
    //
    // Floor lowered 3 -> 2 by client review vs2 item 10, which DELETED the
    // Announcements card on Departmental Home (broadcasts belong inside
    // Channels, not on the operational dashboard). That card was the third
    // site. The rule itself is unchanged and still applies to every surviving
    // site and to any added later — only the count moved.
    expect(sites).toBeGreaterThanOrEqual(2);
    // …and the floor alone is not enough. The shared opener is where BOTH doors
    // now navigate from; if it is renamed or its sites are inlined back into a
    // screen, the count could still be met while the one file that must be
    // covered no longer is. Name it.
    expect(`openDepartmentChannel.ts:${(perFile['openDepartmentChannel.ts'] ?? 0) > 0}`)
      .toBe('openDepartmentChannel.ts:true');

    // THE COMPENSATING CONTROL for the one exempted site. An absent postMode
    // must ENFORCE, never open. If this flips back to `postMode === 'read_only'`
    // or similar, the exemption above stops being safe and this fails.
    const chat = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChatScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n'));
    expect(chat).toMatch(/const enforcePosters = postMode !== 'open';/);
  });

  it('post_mode round-trips through the editor — no silent privilege escalation', () => {
    /**
     * The ACCESS table is NON-INJECTIVE: Standard and Read only both store
     * access='standard' and differ only in post_mode. So if the editor cannot
     * READ post_mode, selecting the option by `access` alone always returns the
     * first match (Standard → 'open'). Every pre-Phase-2 channel is
     * access='standard' + post_mode='read_only', so opening one and pressing
     * Save — a rename, anything — re-sent post_mode:'open' and the server
     * re-seeded every non-manager as a poster. Silent mass escalation from an
     * innocuous edit, and "Read only" became unrepresentable on read.
     */
    const manage = strip(
      readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', 'ManageChannelsScreen.tsx'), 'utf8')
        .replace(/\r\n/g, '\n'));
    // The param builder must carry it…
    expect(manage).toMatch(/post_mode: c\.post_mode/);

    const editor = strip(
      readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', 'ChannelEditorScreen.tsx'), 'utf8')
        .replace(/\r\n/g, '\n'));
    // …and the editor must resolve the option from the PAIR, not `access` alone.
    expect(editor).toMatch(/editing\?\.post_mode/);
    expect(editor).toMatch(/pm === 'open' \? 'standard' : 'read_only'/);
    // A #broadcast must never have post_mode re-sent (the server pins it).
    expect(editor).toMatch(/editing\?\.is_broadcast \? \{\} : \{post_mode/);
  });

  it('the CLIENT never answers a posting question from `access`', () => {
    /**
     * The same visibility/posting re-merge the server had, on the surface the
     * server-side invariant scan cannot reach.
     *
     * `channelStateMeta` derived its "Read only" badge from
     * `access === 'read_only'`. Phase 2 then made that value UNWRITABLE —
     * Standard and Read only both store `access: 'standard'` and differ only in
     * post_mode — so the badge went dead in the very phase built to make
     * read-only real, and a legacy row lost its badge the first time anyone
     * pressed Save. Same for the Departmental Home announcement fallback.
     *
     * Rule: a posting statement must consult post_mode. `access === 'read_only'`
     * may still appear ONLY as a legacy fallback alongside a post_mode test.
     */
    // Assert the DECISION EXPRESSION, not the file.
    //
    // A first version asked only "does post_mode appear somewhere in this
    // file?" — and it does, in an unrelated type signature and in
    // `postMode: announce.post_mode`. So reverting the badge to access-only
    // passed green. The condition itself has to be pinned.
    const obsidian = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', '_obsidian.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(obsidian).toMatch(/input\.post_mode && input\.post_mode !== 'open'/);
    expect(obsidian).toMatch(/input\.post_mode === 'announcement'/);

    // Departmental Home no longer makes a posting decision at all: client
    // review vs2 item 10 removed the Announcements card and its channel picker.
    // The RULE still binds this file, so the assertion flips from "the
    // post_mode test is present" to a flat ABSENCE.
    //
    // Deliberately NOT `if (has access-only) expect(post_mode present)`: that
    // is the file-level presence check this test's own header condemns, and it
    // is vacuous while the array is empty. A bare absence cannot be satisfied
    // by an unrelated `post_mode` mention elsewhere in the file.
    const home = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', 'DepartmentalHomeScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    expect(home).not.toMatch(/access === 'read_only'/);
    // And both call sites must actually FEED post_mode in, or the helper's new
    // branch is unreachable — the exact shape of the bug being fixed.
    for (const f of ['ManageChannelsScreen.tsx']) {
      const src = strip(readFileSync(join(process.cwd(), 'src', 'screens', 'deptchat', f), 'utf8').replace(/\r\n/g, '\n'));
      const call = src.slice(src.indexOf('channelStateMeta({'));
      expect(`${f}:${/post_mode:/.test(call.slice(0, 200))}`).toBe(`${f}:true`);
    }
    const hub = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'messenger', 'DepartmentChannelsScreen.tsx'), 'utf8').replace(/\r\n/g, '\n'));
    const hubCall = hub.slice(hub.indexOf('channelStateMeta({'));
    expect(/post_mode:/.test(hubCall.slice(0, 200))).toBe(true);
  });

  it('the scan is reading the real screen (guards a vacuous pass)', () => {
    const src = strip(read());
    expect(src.length).toBeGreaterThan(5000);
    expect(src).toMatch(/DepartmentChannelsScreen/);
  });
});

/**
 * UI corrections 2026-08-15 items 03/04/06 — the NEW renderer joins this scan.
 *
 * ⚠️ WHY IT HAD TO. Every guard in this file names a FILE. Move render code into
 * a new one and the guards do not fail — they simply stop applying, silently,
 * while the assertions that remain go red "for the right reason" and get
 * updated. That is the vacuous-pin class, and moving the tree into
 * `ChannelTree.tsx` is exactly the move that triggers it.
 */
describe('items 03/04/06 — the shared ChannelTree renderer', () => {
  const treeSrc = () => readFileSync(
    join(process.cwd(), 'src', 'screens', 'deptchat', 'ChannelTree.tsx'), 'utf8')
    .replace(/\r\n/g, '\n');

  const treeCode = () => strip(treeSrc());

  it('the scan is reading a real file (guards a vacuous pass)', () => {
    expect(treeSrc().length).toBeGreaterThan(4000);
    expect(treeCode()).toContain('export function ChannelTree');
  });

  it('DISPLAY tier comes from the node, never from the level column', () => {
    /**
     * §2.1 of the plan, and the reason it is pinned: two root shapes exist in
     * production permanently (legacy level-1 roots and new level-0 ones), so
     * labelling by `level` shows two identical organisations as L1 and L2.
     * The renderer must take the tier the walk computed and nothing else.
     */
    const c = treeCode();
    expect(c).toMatch(/node\.tier/);
    // No raw level arithmetic anywhere in the renderer.
    expect(c).not.toMatch(/\.level\s*\+\s*1/);
    expect(c).not.toMatch(/row\.level/);
  });

  it('CAPABILITY still reads the STORED level — and does so in the admin screen', () => {
    /**
     * The mirror image of the rule above, and the one that produces a dead
     * button rather than a wrong label: the server refuses a child of a level-3
     * node, and a legacy level-1-rooted workspace reaches level 3 at display
     * tier 3. Gating "+ Add sub-level" on the tier would 400 on exactly the
     * oldest workspaces.
     */
    const manage = strip(readFileSync(
      join(process.cwd(), 'src', 'screens', 'deptchat', 'ManageChannelsScreen.tsx'), 'utf8')
      .replace(/\r\n/g, '\n'));
    expect(manage).toMatch(/manageLevelOf\(c\) >= 3/);
    // …and NOT on the rendered tier.
    expect(manage).not.toMatch(/node\.tier\s*>=\s*[34]/);
  });

  it('a LATERAL is drawn neutral — it never takes a level colour', () => {
    // §04: "they should not have a colour. They can be the current transparent
    // card box as currently displayed."
    const c = treeCode();
    expect(c).toMatch(/lateralRow/);
    // The tint is only ever computed for a LEVEL row.
    expect(c).toMatch(/isLevel && node\.tier \? levelTint\(node\.tier\) : null/);
  });

  it('resolves the hidden rung through the helper, never the raw field', () => {
    // organisationTreeSingleSource bans a screen from branching on
    // parent_hidden; the renderer reads the already-resolved node.rung.
    const c = treeCode();
    expect(c).toMatch(/node\.rung/);
    expect(c).not.toMatch(/parent_hidden/);
    expect(c).not.toMatch(/visible_ancestor_id/);
  });

  it('B-609 — the card opens on a split, the chevron owns the toggle', () => {
    /**
     * ⚠️ REVERSED ON 2026-08-22 (B-609 / FB-1). It used to pin G1's "whole card
     * toggles". The founder overrode it: on the MEMBER surface the card LEFT of
     * the `|` divider OPENS the chat, and only the chevron toggles. ADMIN mode
     * keeps whole-card-toggles, which is why the split is `!admin && …`.
     *
     * Behavioural proof of both zones, and that they never cross-fire, lives in
     * `channelTreeInteraction.test.tsx`; this scan only pins the wiring exists,
     * because a source scan cannot press anything.
     */
    const c = treeCode();
    // The split fires only when there is BOTH a branch and a chat, never in admin.
    expect(c).toMatch(/const splitCard = !admin && canToggle && canOpen;/);
    // The card decides in ONE place: a split (or a leaf) opens; else it toggles.
    expect(c).toMatch(/const cardPress = React\.useCallback/);
    expect(c).toMatch(/if \(splitCard \|\| cardOpens\) \{ onOpen\?\.\(node\); \}/);
    expect(c).toMatch(/else if \(canToggle\) \{ onToggle\(node\.row\.id\); \}/);
    // The chevron survives as its own target, and it is what toggles.
    expect(c).toMatch(/testID=\{`channel-tree-chevron-\$\{node\.row\.id\}`\}/);
    expect(c).toMatch(/onPress=\{\(\) => onToggle\(node\.row\.id\)\}/);
  });

  it('ONE indent formula, stated once', () => {
    // Two different bases existed before this (12 + d*16 and d*16), which is how
    // the same tree drew differently on two screens.
    const c = treeCode();
    expect((c.match(/const indentOf =/g) ?? []).length).toBe(1);
    expect(c).toMatch(/INDENT_BASE \+ depth \* INDENT_STEP/);
  });
});
