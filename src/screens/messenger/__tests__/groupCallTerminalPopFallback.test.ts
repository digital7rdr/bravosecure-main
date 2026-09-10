/**
 * B-213 — GroupCallScreen's terminal-pop effect (BS-GC1) called a blind
 * `navigation.goBack()` when the call ended. Founder screenshot: the
 * client answered a group call from a killed-app notification and, after
 * the host ended it, was stuck forever on the "Call ended by host" card
 * with no way back into the app — `goBack()` is a silent no-op when
 * there's no screen underneath (the exact stack-seeding gap
 * MessengerNavigator's own B-85 comment already documents for a
 * different symptom).
 *
 * This screen can't be imported by the node `messenger-crypto` project
 * (WebView/mediasoup/navigation), so the fix is pinned by reading the
 * source — same pattern as GroupCallScreen.autopop.test.tsx / the other
 * static scans in this suite.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const SCREEN = join(process.cwd(), 'src', 'screens', 'messenger', 'GroupCallScreen.tsx');

function source(): string {
  return readFileSync(SCREEN, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
/** The body of the terminal-pop effect (BS-GC1), CODE only. */
function terminalPopEffectBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('const terminalPoppedRef = useRef(false);');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('}, [call.state, navigation]);', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-213 — GroupCallScreen terminal-pop no longer strands the user (static source scan)', () => {
  it('checks canGoBack() before calling goBack()', () => {
    const body = terminalPopEffectBody();
    expect(body).toMatch(/navigation\.canGoBack\(\)/);
  });

  it('falls back to the shell resolver when there is no back-stack', () => {
    // Ops-Room call fix (2026-08-09): the fallback's target changed from the
    // hard-coded MessengerTab hop (client-shell-only — CPO/agency users were
    // stranded on the dead "Call ended" card) to the shell-aware resolver.
    const body = terminalPopEffectBody();
    expect(body).toMatch(/navigateToMessengerScreen\(navigationRef as never, 'MessengerHome'/);
    expect(body).not.toMatch(/MessengerTab/);
  });

  it('imports navigationRef', () => {
    expect(stripComments(source())).toMatch(/import\s*\{navigationRef\}\s*from\s*'@navigation\/navigationRef'/);
  });
});
