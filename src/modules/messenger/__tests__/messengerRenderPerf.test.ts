/**
 * Render-cost invariants for the messenger screens.
 *
 * `ChatScreen.tsx` needs native modules to render and cannot be imported by the
 * node `messenger-crypto` project, so these rules are pinned by comment-stripped
 * source scans — the same discipline as `messageTopologyInvariants.test.ts`.
 *
 * These files are CRLF: never anchor a regex on `\n`, and always strip comments
 * before an absence assertion (prose containing the banned token is the classic
 * false pass).
 *
 * Register: docs/audits/FIRST_BOOT_LAG_B155_2026-07-23.md §8 (L3, L4).
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const CHAT_SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

/**
 * Line-based comment stripper.
 *
 * The obvious `src.replace(/\/\*[\s\S]*?\*\//g, '')` is NOT safe on this file:
 * a `/*` or `*​/` appearing inside a string, regex or JSX literal pairs with the
 * wrong delimiter and swallows real code. Measured on `ChatScreen.tsx` it ate
 * 64KB of the 171KB source — every absence assertion downstream of that would
 * have passed VACUOUSLY, which is precisely the failure mode CLAUDE.md calls
 * out for source scans.
 *
 * So: a block comment is only recognised when `/*` is the first non-space on
 * the line (how every comment in these files is actually written), and a `//`
 * is ignored when it is part of a URL.
 */
function stripSourceComments(src: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of src.split(/\r?\n/)) {
    let line = rawLine;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) {out.push(''); continue;}
      line = line.slice(end + 2);
      inBlock = false;
    }
    line = line.replace(/\{\s*\/\*.*?\*\/\s*\}/g, '');   // one-line JSX comment
    const open = line.indexOf('/*');
    if (open !== -1 && line.slice(0, open).trim() === '') {
      const end = line.indexOf('*/', open + 2);
      if (end === -1) {inBlock = true; out.push(line.slice(0, open)); continue;}
      line = line.slice(0, open) + line.slice(end + 2);
    }
    const lc = line.indexOf('//');
    if (lc !== -1 && !/https?:$/.test(line.slice(0, lc))) {line = line.slice(0, lc);}
    out.push(line);
  }
  return out.join('\n');
}

/** Body of a top-level `function <name>(`, sliced to the next top-level declaration. */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  // Next top-level `function ` / `const ` at column 0 after the opening.
  const rest = src.slice(start + 1);
  const nextDecl = rest.search(/(?:\r?\n)(?:function |const |export |class )/);
  return nextDecl === -1 ? rest : rest.slice(0, nextDecl);
}

describe('the source scan itself is not vacuous', () => {
  it('stripping comments does not swallow real code', () => {
    // Guard for the whole file: a stripper that eats code turns every
    // `not.toMatch` below into a silent pass. A naive block-comment regex ate
    // 37% of this file; comments are ~20-30% of it, so anything under half is
    // the honest range and a collapse fails loudly here.
    const raw = readFileSync(CHAT_SCREEN, 'utf8');
    const stripped = stripSourceComments(raw);
    expect(stripped.length).toBeGreaterThan(raw.length * 0.55);
    // Sanity: code that sits directly under long comment blocks must survive.
    expect(stripped).toContain('const ChatComposer = React.memo(');
    expect(stripped).toContain('function ForwardList(');
  });
});

describe('B-158 (L4) — the forward picker does not subscribe to the whole store', () => {
  it('CONTROL: ForwardList exists and reads conversations from the store', () => {
    const body = stripSourceComments(functionBody(readFileSync(CHAT_SCREEN, 'utf8'), 'ForwardList'));
    expect(body).toContain('useMessengerStore');
    expect(body).toContain('conversationOrder');
  });

  it('selects the conversations map through useShallow', () => {
    // A bare `useMessengerStore(s => s.conversations)` re-renders the open picker
    // on EVERY store commit that produces a new map object — which, with immer,
    // is every inbound message anywhere. useShallow is the M-18 pattern the home
    // list already uses.
    const body = stripSourceComments(functionBody(readFileSync(CHAT_SCREEN, 'utf8'), 'ForwardList'));
    expect(body).toMatch(/useMessengerStore\(\s*useShallow\(\s*s\s*=>\s*s\.conversations\s*\)\s*\)/);
    expect(body).not.toMatch(/useMessengerStore\(\s*s\s*=>\s*s\.conversations\s*\)/);
  });
});

describe('B-159 (L3) — a keystroke does not re-render the whole ChatScreen', () => {
  it('CONTROL: the composer component exists and owns a draft', () => {
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    expect(src).toContain('function ChatComposerImpl');
    expect(src).toMatch(/const \[text, setText\] = useState\(initialDraft\)/);
  });

  it('ChatScreenInner holds no per-keystroke draft state', () => {
    // The regression: `const [text, setText] = useState(...)` at the screen
    // root. Every keystroke then re-runs every hook and selector in a
    // ~2,700-line component. React.memo cannot save a component that
    // re-renders ITSELF — the state has to live in the composer.
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    const inner = src.slice(
      src.indexOf('function ChatScreenInner'),
      src.indexOf('const ChatComposer = React.memo'),
    );
    expect(inner.length).toBeGreaterThan(1000); // slice anchors still valid
    expect(inner).not.toMatch(/useState\(draft/);
    expect(inner).not.toMatch(/\bsetText\b/);
  });

  it('the composer is memoised', () => {
    // Without the memo the composer re-renders on every screen render, and the
    // extraction buys nothing in the other direction.
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    expect(src).toMatch(/const ChatComposer = React\.memo\(/);
  });

  it('the typing signal reaches the screen without a render', () => {
    // The old typing effect was keyed on `text`, which is WHY the draft lived
    // in the screen. Its replacement must be driven by the composer callback
    // and touch refs only — a setState here would re-render the screen per
    // keystroke and undo the whole fix.
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    expect(src).toContain('onDraftActivity');
    expect(src).toMatch(/hasDraftRef\.current = hasText/);
    const emit = src.slice(src.indexOf('const emitTyping ='), src.indexOf('const emitTypingRef'));
    expect(emit).not.toMatch(/\bsetState\b|\buseState\b/);
  });

  it('every composer prop is referentially stable', () => {
    // A closure recreated per render defeats the memo. `send` and
    // `enqueueMediaAssets` are redefined each render, so they must be reached
    // through a latest-ref, not captured directly.
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    // Whitespace-tolerant: prettier re-aligns these declarations.
    for (const name of [
      'onComposerSend', 'onVoiceComplete', 'openAttachSheet',
      'openEmojiSheet', 'openTimerSheet', 'onDraftActivity',
    ]) {
      expect(src).toMatch(new RegExp(`const\\s+${name}\\s*=\\s*useCallback\\(`));
    }
    expect(src).toMatch(/sendRef\.current = send/);
  });

  it('B-73 preserved: the native field is cleared imperatively on send', () => {
    // Clearing React state alone needs a render round-trip; a fast next
    // keystroke lands on the uncleared EditText and onChangeText reports the
    // concatenation. The imperative clear must survive the extraction.
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    const submit = src.slice(src.indexOf('const submit = ()'), src.indexOf('const hasText ='));
    expect(submit).toMatch(/setText\(''\)/);
    expect(submit).toMatch(/inputRef\.current\?\.clear\(\)/);
    // ...and the body must be trimmed before it leaves the composer.
    //
    // This used to pin the literal `const trimmed = text.trim()`. That phrasing
    // was itself the bug: `setText` is async, so reading `text` in the same
    // tick as a keystroke ships a TRUNCATED body (founder report, vc166), and
    // it cannot be cleared synchronously so a double-tap re-sends it. `submit`
    // now reads a ref that `onChangeText` writes synchronously. The PROPERTY
    // this test exists for — trimmed before it leaves — is unchanged; only the
    // source is. The race itself is pinned in composerSendRace.test.ts.
    expect(submit).toMatch(/const trimmed = textRef\.current\.trim\(\)/);
  });

  it('a send clears the screen-side draft flag', () => {
    // The composer clears itself, so the screen's ref must clear too — else a
    // later emitTyping() sees a stale "has draft" and emits `start` for an
    // empty composer, stranding the peer on a permanent "typing…".
    const src = stripSourceComments(readFileSync(CHAT_SCREEN, 'utf8'));
    expect(src).toMatch(/hasDraftRef\.current = false/);
  });
});

