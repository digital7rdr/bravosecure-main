/**
 * B-655 — the Calls log must stay VIRTUALISED and its row MEMOISED.
 *
 * ── WHY THIS PIN EXISTS ──────────────────────────────────────────────────
 * On 2026-08-24 a "perf spine" tried to cure the founder's messenger lag by
 * keeping the Chats and Calls tab bodies permanently mounted and toggling
 * `display:'none'`, instead of unmounting them. It made the lag worse, because
 * what it pinned in place was this screen — and this screen rendered EVERY row
 * of the entire call history inside a plain `ScrollView`:
 *
 *     <ScrollView>{visible.map(row => ( …~15 elements… ))}</ScrollView>
 *
 * That was survivable while the body was conditionally mounted (you paid it
 * only while looking at Calls). Permanently mounted, it re-reconciled every row
 * on every store commit, and its mount moved onto MessengerHome's mount.
 *
 * The fix is a PAIR:
 *   1. `MessengerHomeScreen` renders the tab bodies conditionally again
 *      (pinned by `messengerPersistentTabs.test.ts`), and
 *   2. this screen virtualises, so the mount that conditional re-pays is cheap.
 *
 * **Neither half works alone.** Reverting (2) and keeping (1) reinstates the
 * founder's ORIGINAL "switch then back is laggy" complaint — which is exactly
 * what the perf spine was reaching for when it reached for the wrong tool.
 *
 * Register: docs/audits/MESSENGER_LAG_AUDIT_2026-08-24.md
 *
 * ⚠️ SOURCE SCAN. `CallsLogScreen.tsx` is CRLF, so it is normalised to `\n`
 * before any scan — a `\n`-anchored regex on raw bytes matches nothing and
 * passes VACUOUSLY. Comments are stripped before every absence assertion,
 * because the docblocks above quote the very tokens under test (`ScrollView`,
 * `visible.map`) — this repo's most common false pass.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'CallsLogScreen.tsx');

function rawSource(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}

/**
 * Line-based comment stripper.
 *
 * The obvious `src.replace(/\/\*[\s\S]*?\*\//g, '')` is NOT safe on these
 * files: a `/*` inside a string, regex or JSX literal pairs with the wrong
 * delimiter and swallows real code — measured at 37% of `ChatScreen.tsx`, which
 * would make every absence assertion below pass vacuously. So a block comment
 * is recognised only when the opener is the first non-space on its line.
 */
function strippedSource(): string {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of rawSource().split('\n')) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {
        out.push('');
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ''); // one-line JSX comment
    const open = line.indexOf('/*');
    // A MULTI-LINE JSX comment opens `{/**`, so the first non-space character is
    // `{`, not `/`. Requiring `/*` to be first missed it entirely — and this
    // file's own FlatList docblock quotes `visible.map(...)`, so the absence
    // assertion below read that prose as code and failed. Allow a leading `{`.
    if (open !== -1 && /^\{?$/.test(line.slice(0, open).trim())) {
      const end = line.indexOf('*/', open + 2);
      if (end === -1) {
        inBlock = true;
        out.push(line.slice(0, open));
        continue;
      }
      line = line.slice(0, open) + line.slice(end + 2);
    }
    const lc = line.indexOf('//');
    if (lc !== -1 && !/https?:$/.test(line.slice(0, lc))) {
      line = line.slice(0, lc);
    }
    out.push(line);
  }
  return out.join('\n');
}

describe('the scan itself is not vacuous', () => {
  it('reads the real screen and the stripper does not swallow it', () => {
    const raw = rawSource();
    const code = strippedSource();
    expect(raw.length).toBeGreaterThan(20_000);
    // Comments are ~25-35% of this file; a stripper that ate code would collapse
    // it far below this and silently turn every `not.toMatch` into a pass.
    expect(code.length).toBeGreaterThan(raw.length * 0.5);
    // Anchors that sit directly under long docblocks must survive the strip.
    expect(code).toContain('export function CallsLogBody(');
    expect(code).toContain('const CallLogRow = React.memo(');
  });
});

describe('B-655 — the calls list is virtualised', () => {
  it('renders through a FlatList, never a ScrollView', () => {
    const code = strippedSource();
    expect(code).toMatch(/<FlatList/);
    // The regression: a plain ScrollView mounts every row in the history.
    expect(code).not.toMatch(/<ScrollView/);
    expect(code).not.toMatch(/\bScrollView\b.*from 'react-native'/);
  });

  it('does not map the whole row set into JSX', () => {
    // `visible.map(...)` in the render body is the un-virtualised shape,
    // regardless of which container it sits in.
    expect(strippedSource()).not.toMatch(/visible\.map\(/);
  });

  it('the row is a memoised component, not inline JSX', () => {
    const code = strippedSource();
    expect(code).toMatch(/const CallLogRow = React\.memo\(/);
    expect(code).toMatch(/<CallLogRow\b/);
  });
});

describe('B-655 — the FlatList can actually bail out', () => {
  /**
   * `FlatList` is a `PureComponent`. A prop whose identity changes every render
   * defeats its shallow compare, and then `VirtualizedList` re-renders (and
   * recomputes its cell window) on every render of the body — which is most of
   * what virtualising was supposed to buy. So the three identity-bearing props
   * must all be stable references, not literals written at the JSX site.
   */
  it('keyExtractor is a module-level function, not an inline arrow', () => {
    const code = strippedSource();
    expect(code).toMatch(/^const callRowKey = /m);
    expect(code).toMatch(/keyExtractor=\{callRowKey\}/);
    expect(code).not.toMatch(/keyExtractor=\{\s*(?:\(|\w+\s*=>)/);
  });

  it('renderItem is a useCallback, not an inline arrow', () => {
    const code = strippedSource();
    expect(code).toMatch(/const renderRow = useCallback\(/);
    expect(code).toMatch(/renderItem=\{renderRow\}/);
    expect(code).not.toMatch(/renderItem=\{\s*\(/);
  });

  it('contentContainerStyle is memoised, not an inline object literal', () => {
    const code = strippedSource();
    expect(code).toMatch(/const listContentStyle = useMemo\(/);
    expect(code).toMatch(/contentContainerStyle=\{listContentStyle\}/);
    // The regression: `contentContainerStyle={{paddingBottom: …}}` — a fresh
    // object every render, which alone is enough to defeat the PureComponent.
    expect(code).not.toMatch(/contentContainerStyle=\{\{/);
  });
});
