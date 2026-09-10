/**
 * Enterprise Dept Channels scope v2, frames A9 + M9 —
 * "No phone/call button appears in Department Channel chat; calls remain in
 * Messenger."
 *
 * We already comply, and this test exists to keep it that way rather than to
 * fix anything. The compliance is STRUCTURAL, not a conditional: Department
 * Channels do not use `ChatScreen` at all — they have their own
 * `DepartmentChatScreen`, which simply never had call buttons.
 *
 * That is a fragile kind of correct. `ChatScreen.tsx` renders voice + video
 * call buttons UNCONDITIONALLY in its header, so the day someone "removes the
 * duplication" by pointing the `DepartmentChat` route at `ChatScreen`, or by
 * merging the two screens, the call buttons silently reappear inside
 * Department Channel chat and the rule breaks with no test failing. Both halves
 * below are therefore load-bearing:
 *
 *   1. DepartmentChatScreen itself has no call affordance.
 *   2. The `DepartmentChat` route still points at DepartmentChatScreen.
 *
 * These screens mount RN views, so this node project cannot import them —
 * comment-stripped source scan, the same technique as iosSwipeBackParity.
 */
import {readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

/** CRLF files — normalise first or a `\n`-anchored regex matches nothing and
 *  the assertion passes VACUOUSLY. */
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');

/** Strip comments before any absence assertion — the prose above and in the
 *  target files names the very words under test. */
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const DEPT_CHAT = 'src/screens/messenger/DepartmentChatScreen.tsx';

describe('A9 / M9 — Department Channel chat has no call affordance', () => {
  it('DepartmentChatScreen never launches a call', () => {
    const src = strip(read(DEPT_CHAT));
    expect(src).not.toMatch(/launchCall/);
    expect(src).not.toMatch(/callType/);
    expect(src).not.toMatch(/navigate\(\s*['"]CallScreen['"]/);
    expect(src).not.toMatch(/navigate\(\s*['"]GroupCallScreen['"]/);
  });

  it('DepartmentChatScreen renders no phone or video icon', () => {
    const src = strip(read(DEPT_CHAT));
    // The header actions in ChatScreen use exactly these two icon names.
    expect(src).not.toMatch(/name="phone/);
    expect(src).not.toMatch(/name="video/);
    expect(src).not.toMatch(/name={'phone/);
    expect(src).not.toMatch(/name={'video/);
  });

  it('EVERY navigator registering DepartmentChat binds DepartmentChatScreen', () => {
    // Why: this is the half that catches a "de-duplication" refactor. Without
    // it, someone could route DepartmentChat at ChatScreen and every assertion
    // above would still pass — they would be scanning a file nothing renders.
    //
    // And it must sweep ALL navigators, not one. `DepartmentChat` is registered
    // TWICE — DepartmentalNavigator.tsx (the workspace shell) and
    // MessengerNavigator.tsx (reached from the DepartmentChannels entry card;
    // departmentalEntry.findNavigatorWithRoute resolves whichever is mounted).
    // Pinning a single file left the other free to be repointed at ChatScreen
    // with every test still green — the repo's duplicate-copy bug class,
    // reproduced inside the very test written to prevent it.
    const dir = join(ROOT, 'src', 'navigation');
    const registrations: Array<{file: string; component: string}> = [];
    for (const file of readdirSync(dir).filter(f => f.endsWith('.tsx'))) {
      const src = strip(readFileSync(join(dir, file), 'utf8').replace(/\r\n/g, '\n'));
      // Screen props may be attribute-per-line, so scan the whole element.
      const re = /<[A-Za-z.]*Screen\b[^>]*?name="DepartmentChat"[^>]*?>/gs;
      for (const el of src.match(re) ?? []) {
        const comp = /component={(\w+)}/.exec(el);
        registrations.push({file, component: comp?.[1] ?? '<none>'});
      }
    }
    // Both known shells must be present — if this drops to 1 the sweep silently
    // stopped covering a live route.
    expect(registrations.length).toBeGreaterThanOrEqual(2);
    for (const r of registrations) {
      expect(`${r.file}:${r.component}`).toBe(`${r.file}:DepartmentChatScreen`);
      // …and the IDENTIFIER is not the guarantee — what it RESOLVES TO is.
      // `import DepartmentChatScreen from '@screens/messenger/ChatScreen'` is a
      // one-word diff that keeps this element reading `component={DepartmentChatScreen}`
      // while rendering ChatScreen and its unconditional call buttons. Pin the
      // import SOURCE for the binding each registration actually uses.
      const src = strip(readFileSync(join(dir, r.file), 'utf8').replace(/\r\n/g, '\n'));
      const imp = new RegExp(
        `import\\s+${r.component}\\s+from\\s+'([^']+)'`).exec(src);
      expect(`${r.file}:${imp?.[1]}`).toBe(`${r.file}:@screens/messenger/DepartmentChatScreen`);
    }
  });

  it('DepartmentChatScreen imports nothing call-capable from ChatScreen', () => {
    // Why (structural, not a token denylist): DepartmentChatScreen already does
    // `import {previewForReply, ForwardList} from './ChatScreen'`. A shared
    // header/action-bar pulled through that same import would carry the call
    // buttons in and be invisible to a file-local token scan. Pin the import
    // list exactly: adding a symbol here is a deliberate act that must be
    // re-reviewed against A9/M9, not a silent one.
    const src = strip(read(DEPT_CHAT));
    const imports = [...src.matchAll(/import\s*{([^}]*)}\s*from\s*'\.\/ChatScreen'/g)]
      .flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
    expect(imports.sort()).toEqual(['ForwardList', 'previewForReply']);
  });

  it('DepartmentChatScreen imports no call/webrtc module at all', () => {
    const src = strip(read(DEPT_CHAT));
    const paths = [...src.matchAll(/from\s*'([^']+)'/g)].map(m => m[1]);
    for (const p of paths) {
      expect(p).not.toMatch(/webrtc|launchCall|callRegistry|\/call/i);
    }
  });

  it('nor does anything it pulls in ONE HOP away', () => {
    // Why one hop: a file-local scan is defeated by the most natural refactor
    // there is — "extract the shared header". A NEW sibling
    // (`./SharedChatHeader`) that imports launchCall and renders a phone icon
    // adds ONE innocuous-looking import line here and trips no file-local rule,
    // because the banned tokens all live in the sibling. Follow the local
    // imports and apply the same scan to each.
    //
    // './ChatScreen' is deliberately EXEMPT from the token scan — it genuinely
    // contains call code and is instead constrained by the exact symbol
    // allowlist in the test above. That is the stronger guarantee: what may be
    // imported from it is enumerated, so a header component cannot ride in.
    // The resolver must cover EVERY first-party import shape this repo uses, not
    // just the one a previous mutation happened to pick. An earlier version
    // followed only './x' and '@screens/messenger/x' — 2 of this file's ~26
    // first-party imports — leaving all twelve `@/modules/messenger/*` paths
    // unfollowed, which is exactly where shared chat UI lives
    // (ui/MediaPreviewTray, ui/AmbientBg, ui/LinkPreviewCard…). A header planted
    // at `@/modules/messenger/ui/SharedChatHeader` sailed straight through.
    const ALIASES: Array<[RegExp, string]> = [
      [/^@\//, 'src/'],
      [/^@screens\//, 'src/screens/'],
      [/^@components\//, 'src/components/'],
      [/^@modules\//, 'src/modules/'],
      [/^@navigation\//, 'src/navigation/'],
      [/^@hooks\//, 'src/hooks/'],
      [/^@store\//, 'src/store/'],
      [/^@services\//, 'src/services/'],
      [/^@utils\//, 'src/utils/'],
      [/^@theme\//, 'src/theme/'],
    ];
    const DEPT_DIR = 'src/screens/messenger';

    /** Repo-relative base path for a first-party import, or null for a package. */
    function toBase(spec: string): string | null {
      if (spec.startsWith('.')) {
        // Handles './x' AND '../x' — join collapses the traversal.
        return join(DEPT_DIR, spec).split(/[\\/]/).join('/');
      }
      for (const [re, rep] of ALIASES) {
        if (re.test(spec)) {return spec.replace(re, rep);}
      }
      return null; // node_modules (@expo/…, @react-navigation/…) or bare pkg
    }

    const src = strip(read(DEPT_CHAT));
    const specs = [...src.matchAll(/from\s*'([^']+)'/g)]
      .map(m => m[1])
      .filter(s => !/(^|\/)ChatScreen$/.test(s)); // symbol-allowlisted above

    const resolvedFiles: string[] = [];
    for (const spec of specs) {
      const base = toBase(spec);
      if (!base) {continue;}
      // Index-directory imports ('./header' → header/index.tsx) must resolve too,
      // or a whole folder becomes an unscanned blind spot.
      // `.ts` IS scanned. An earlier version followed only `.tsx`, reasoning
      // that a call button must be rendered — but the render site does not have
      // to contain the call token. Extracting the onPress handler into a `.ts`
      // helper (`ui/deptActions.ts` exporting `startChannelCall`, which wraps
      // launchCall) leaves the `.tsx` holding only `startChannelCall` and a
      // `headset` icon, and slips through every check. That is the repo's own
      // idiom — `webrtc/launchCall.ts` is itself a `.ts` helper ChatScreen
      // imports — so `.ts` must stay in the token scan.
      for (const cand of [`${base}.tsx`, `${base}/index.tsx`, `${base}.ts`, `${base}/index.ts`]) {
        let body: string;
        try {
          body = strip(readFileSync(join(ROOT, cand), 'utf8').replace(/\r\n/g, '\n'));
        } catch { continue; }
        resolvedFiles.push(cand);
        // THE REAL GUARANTEE. A call cannot be placed without reaching
        // launchCall, whatever the file extension or the icon.
        expect(`${cand}:launchCall`).toBe(`${cand}:${/launchCall/.test(body) ? 'FOUND' : 'launchCall'}`);
        // Decorative, NOT a boundary — do not mistake it for one. A call button
        // drawn with any other glyph (`headset`, `account-voice`, …) walks past
        // it. It is kept only because a phone/video icon in dept chat is worth
        // flagging on sight.
        expect(`${cand}:phoneIcon`).toBe(`${cand}:${/name="phone|name={'phone/.test(body) ? 'FOUND' : 'phoneIcon'}`);
        // Import-path ban is .tsx-ONLY, and deliberately so. Non-rendering
        // modules legitimately reach call code: `src/store/authStore.ts` imports
        // five `webrtc/*` paths (:18,:32,:34,:36,:38) for sign-out teardown and
        // holds no launchCall token. Applying this to `.ts` would fire on that —
        // a true false positive, and a test that cries wolf is how the next
        // person learns to weaken it.
        if (cand.endsWith('.tsx')) {
          for (const p of [...body.matchAll(/from\s*'([^']+)'/g)].map(m => m[1])) {
            expect(`${cand}:${p}`).not.toMatch(/webrtc|launchCall|callRegistry/i);
          }
        }
        break;
      }
    }
    // Anti-vacuity on RESOLVED files only. The previous guard added the raw
    // spec count, so a list where NOTHING resolved still passed.
    //
    // A bare count is weak, so assert the specific branch that was broken: the
    // `@/…` alias. Shared chat UI lives under `@/modules/messenger/ui/`, that
    // whole directory was unreachable before, and it is where a "shared header"
    // would naturally be planted. If the alias mapping regresses, these
    // disappear from the resolved set and this trips.
    expect(resolvedFiles.filter(f => f.startsWith('src/modules/messenger/ui/')).length)
      .toBeGreaterThanOrEqual(4);
    expect(resolvedFiles.length).toBeGreaterThanOrEqual(5);
  });

  it('the scan targets a real, non-empty screen (guards a vacuous pass)', () => {
    // Why: if DepartmentChatScreen is ever moved or renamed, read() would throw
    // — but if it were merely emptied, every not.toMatch above would pass on an
    // empty string. Pin that we are scanning the real thing.
    const src = strip(read(DEPT_CHAT));
    expect(src.length).toBeGreaterThan(5000);
    expect(src).toMatch(/channelId/);
  });
});
