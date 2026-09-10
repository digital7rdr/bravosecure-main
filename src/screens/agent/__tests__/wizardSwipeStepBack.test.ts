/**
 * B-369 — the agency registration wizard's internal steps are bypassed by the
 * navigator swipe-back gesture (static source scan).
 *
 * B-98a made the hardware back key mirror the header chevron: at step > 0 both
 * step BACK inside the wizard (setStep) instead of popping the screen. But
 * `BackHandler` never fires on iOS (no hardware key) and never fires for the
 * react-native-screens swipe gesture on Android either — so a swipe at step
 * 2/3/4 popped the WHOLE wizard to AgentTypeSelect, whose status auto-forward
 * bounced the user straight back in with the wizard remounted at its initial
 * step. The only cross-platform intercept is `beforeRemove`: at an internal
 * step it must prevent back-shaped removals (GO_BACK / POP) and step back
 * instead; at step 0 the pop proceeds normally (matching the chevron), and
 * programmatic removals (RESET / REPLACE, e.g. sign-out) always pass through.
 *
 * The screen mounts RN views, so this node project cannot import it —
 * comment-stripped scan. The file is CRLF: normalize first, strip comments
 * before asserting.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const WIZARD = 'src/screens/agent/AgentRegistrationWizardScreen.tsx';

function beforeRemoveBody(): string {
  const src = strip(read(WIZARD));
  const at = src.indexOf("addListener('beforeRemove'");
  expect(at).toBeGreaterThan(-1);
  return src.slice(at, at + 900);
}

describe('B-369 — wizard swipe-back steps back instead of popping the whole wizard', () => {
  it('a beforeRemove listener exists (the only intercept the gesture path can hit)', () => {
    expect(strip(read(WIZARD))).toMatch(/addListener\('beforeRemove'/);
  });

  it('at an internal step it prevents the pop and steps back', () => {
    const body = beforeRemoveBody();
    expect(body).toMatch(/preventDefault\(\)/);
    expect(body).toMatch(/setStep\(/);
  });

  it('it only intercepts back-shaped removals (GO_BACK / POP)', () => {
    const body = beforeRemoveBody();
    expect(body).toMatch(/GO_BACK/);
    expect(body).toMatch(/POP/);
  });

  it('the Android hardware-key mirror (B-98a) is retained', () => {
    expect(strip(read(WIZARD))).toMatch(/hardwareBackPress/);
  });
});
