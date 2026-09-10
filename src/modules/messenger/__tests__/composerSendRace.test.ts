import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * The composer send race — two founder-reported symptoms, ONE root cause.
 *
 * Reported 2026-07-25 on vc166:
 *   1. "i can rapidly type and send - sometime broken sentence send"
 *   2. "sometime i click on send button doesnt looks like response but when
 *       click 2nd time 2 msg send of same context"
 *
 * Both are the controlled-TextInput lag. `onChangeText` fires SYNCHRONOUSLY
 * from native, but `setText` only lands on the next render. Anything reading
 * `text` in the same tick as a keystroke therefore reads a stale value:
 *
 *   - fast type → send  ⇒ `submit` ships the body as it was one or more
 *     keystrokes ago = a truncated "broken sentence";
 *   - tap → tap        ⇒ the first tap cannot clear the state synchronously,
 *     so the second tap still sees the old body and sends it AGAIN.
 *
 * The fix is a ref written synchronously in `onChangeText` and read by
 * `submit`, cleared before any async work so it doubles as the second-tap
 * guard. This file pins that the ref stays the single source of truth — the
 * failure mode of a partial fix is that ONE writer of `text` forgets the ref
 * and re-opens the race for whichever path it owns.
 *
 * B-73 is the precedent for why the native `.clear()` also has to stay.
 *
 * Source scan because `ChatScreen.tsx` cannot be imported by the node project
 * (it pulls react-native + webrtc), same as chatScreenMutationUi.test.ts.
 * TRAP: line endings. On a CRLF checkout a bare `\n` anchor matches nothing and
 * the scan passes VACUOUSLY, so `source()` normalizes CRLF away.
 */

const CHAT = join(process.cwd(), 'src', 'screens', 'messenger', 'ChatScreen.tsx');

// Why: the scan must read identically on a CRLF and an LF checkout.
function normalizeEol(src: string): string {
  return src.replace(/\r\n/g, '\n');
}

function source(): string {
  return normalizeEol(readFileSync(CHAT, 'utf8'));
}

/** Line comments FIRST — a `//` containing `/*` otherwise eats the file. */
function code(): string {
  return source()
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Body of the ChatComposer implementation. */
function composerCode(): string {
  const c = code();
  const start = c.indexOf('function ChatComposerImpl');
  expect(start).toBeGreaterThan(-1);
  return c.slice(start);
}

describe('line endings cannot make this scan pass vacuously', () => {
  it('CRLF is normalized away, so a bare \\n anchor matches on either checkout', () => {
    expect(normalizeEol('a\r\nb')).toBe('a\nb');
    expect(source()).not.toContain('\r');
  });
});

describe('submit reads the synchronous ref, not React state', () => {
  it('the trimmed body comes from textRef.current', () => {
    const c = composerCode();
    const i = c.indexOf('const submit = ()');
    expect(i).toBeGreaterThan(-1);
    const body = c.slice(i, i + 900);
    expect(body).toContain('textRef.current.trim()');
    // The stale read that caused the truncation must not come back.
    expect(body).not.toMatch(/const\s+trimmed\s*=\s*text\.trim\(\)/);
  });

  it('the ref is CLEARED before onSend — this is the double-tap guard', () => {
    // A second tap that lands before React re-renders must find an empty ref
    // and bail at the `!trimmed` guard rather than re-ship the same body.
    const c = composerCode();
    const i = c.indexOf('const submit = ()');
    const body = c.slice(i, i + 900);
    const cleared = body.indexOf("textRef.current = ''");
    const sent = body.indexOf('onSend(');
    expect(cleared).toBeGreaterThan(-1);
    expect(sent).toBeGreaterThan(-1);
    expect(cleared).toBeLessThan(sent);
  });

  it('submit still bails on an empty body', () => {
    const c = composerCode();
    const i = c.indexOf('const submit = ()');
    expect(c.slice(i, i + 900)).toMatch(/if\s*\(!trimmed/);
  });

  it('B-73 — the NATIVE field is still cleared imperatively', () => {
    // setText('') alone must round-trip through a render before the native
    // EditText updates; a fast next keystroke lands on the uncleared field.
    const c = composerCode();
    const i = c.indexOf('const submit = ()');
    expect(c.slice(i, i + 900)).toContain('inputRef.current?.clear()');
  });
});

describe('every writer of the draft keeps the ref in step', () => {
  it('each setText call site also assigns textRef.current', () => {
    // The partial-fix failure mode: one writer forgets the ref, and the race
    // survives for whichever path it owns (emoji insert, mention insert,
    // entering edit mode...). Checked per call site, not globally.
    const c = composerCode();
    const offenders: string[] = [];
    const re = /setText\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(c)) !== null) {
      const idx = m.index;
      // The functional form `setText(prev => ...)` is the one shape that is
      // safe without a ref write, because it composes off the latest state.
      // It is NOT used any more (it cannot see the ref), so treat it as an
      // offender too if it reappears.
      const window = c.slice(Math.max(0, idx - 260), idx + 60);
      if (!window.includes('textRef.current')) {
        offenders.push(c.slice(idx, idx + 40).split('\n')[0]);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the ref is seeded from the initial draft', () => {
    // A draft handed in from another screen (the live-tracker dock) must be
    // sendable without typing first.
    expect(composerCode()).toMatch(/useRef\(initialDraft\)/);
  });

  it('onChangeText writes the ref BEFORE setState', () => {
    const c = composerCode();
    const i = c.indexOf('const onChangeText = (');
    expect(i).toBeGreaterThan(-1);
    const body = c.slice(i, i + 320);
    const ref = body.indexOf('textRef.current = next');
    const set = body.indexOf('setText(next)');
    expect(ref).toBeGreaterThan(-1);
    expect(set).toBeGreaterThan(-1);
    expect(ref).toBeLessThan(set);
  });
});
