/**
 * NAV-06 (2026-08-26 back/rapid-use audit) — `NavHeader` never received the
 * BB-7 double-tap guard its deptchat twin `ObHeader` got, so the agent-shell
 * back chevron still double-fired: the second GO_BACK carried the popped
 * screen's key, bubbled to the parent navigator, and popped a screen the user
 * never asked to leave (the B-261 class), across the nine screens that wire
 * `onBack` raw.
 *
 * The component mounts RN views, so this node project cannot import it —
 * comment-stripped source scan, anchored at the decision site (house rules:
 * CRLF-normalize first; strip comments so prose can never satisfy a match).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();
const read = (p: string) =>
  readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n');
const strip = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

const SHARED = 'src/screens/agent/_shared.tsx';

describe('NAV-06 — NavHeader back chevron fires once per gesture', () => {
  it('the guard exists: a leading-edge timestamp ref inside NavHeader', () => {
    const src = strip(read(SHARED));
    const at = src.indexOf('function NavHeader');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 1600);
    expect(body).toMatch(/lastBackTapRef = React\.useRef\(0\)/);
    // The window check + re-arm, in that order — the ObHeader idiom. The
    // window is a prop (default 600) so wizard STEP-backs — instant state
    // changes, not pops — can opt out and keep B-98a chevron/hardware parity.
    expect(body).toMatch(/backGuardMs = 600/);
    expect(body).toMatch(/if \(backGuardMs > 0 && now - lastBackTapRef\.current < backGuardMs\) \{return;\}/);
    expect(body).toMatch(/lastBackTapRef\.current = now;/);
  });

  it('the wizard disables the guard at internal steps only (step-back ≠ pop)', () => {
    const src = strip(read('src/screens/agent/AgentRegistrationWizardScreen.tsx'));
    expect(src).toMatch(/backGuardMs=\{stepIndex > 0 \? 0 : 600\}/);
  });

  it('the chevron presses the GUARDED handler, never the raw onBack prop', () => {
    const src = strip(read(SHARED));
    const at = src.indexOf('function NavHeader');
    const body = src.slice(at, src.indexOf('export function ProgressRail'));
    expect(body).toMatch(/onPress=\{handleBack\}/);
    expect(body).not.toMatch(/onPress=\{onBack\}/);
  });

  it('B-98 kept: no handler still renders the spacer, never a dead chevron', () => {
    const src = strip(read(SHARED));
    expect(src).toMatch(/\{onBack \? \(/);
    expect(src).toMatch(/<View style=\{nav\.backSpacer\} \/>/);
  });
});
