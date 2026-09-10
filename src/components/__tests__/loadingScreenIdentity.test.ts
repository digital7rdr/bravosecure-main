/**
 * Founder 2026-08-08 — every loading screen must be THE "Bravo Secure /
 * Verifying identity…" screen (the BiometricGate lock composition): circular
 * shield badge, brand title on full screens, status line, small spinner.
 *
 * Source scans (this file cannot mount LoadingView in the node project —
 * @expo/vector-icons + react-native-svg). Comments are stripped line by line
 * before any ABSENCE assertion, per the CLAUDE.md scan rules; files are CRLF,
 * so everything is line-based.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function src(rel: string): string {
  return readFileSync(join(process.cwd(), rel), 'utf8').replace(/\r\n/g, '\n');
}

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

const LOADING = 'src/components/LoadingView.tsx';
const GATE = 'src/components/BiometricGate.tsx';

describe('loading-screen identity — one screen everywhere', () => {
  it('LoadingView is the shield-badge composition with the Bravo Secure brand title', () => {
    const s = src(LOADING);
    expect(s).toMatch(/name="shield-lock"/);
    expect(s).toMatch(/Bravo Secure/);
    expect(s).toMatch(/export function BravoShieldBadge/);
  });

  it('BiometricGate composes LoadingView for its waiting state instead of a lookalike', () => {
    const s = codeOnly(GATE);
    expect(s).toMatch(/<LoadingView fullscreen label="Verifying identity…"/);
    expect(s).toMatch(/BravoShieldBadge/);
  });

  it('the gate is on the obsidian/cobalt tokens, not the legacy navy palette', () => {
    const s = codeOnly(GATE);
    expect(s).not.toMatch(/#2563EB/i);
    expect(s).not.toMatch(/#0A0F1E/i);
  });

  it('the staged verify/signout screens still get the checklist (steps mode intact)', () => {
    const s = src(LOADING);
    expect(s).toMatch(/steps/);
    expect(s).toMatch(/StepRow/);
    // The boot overlay must still run STAGED, never degrade to a bare spinner.
    // It now picks its checklist per boot kind (see the cold-start pin below),
    // so this asserts the steps prop is wired to one of the two lists rather
    // than to a single literal.
    const nav = codeOnly('src/navigation/index.tsx');
    expect(nav).toMatch(/steps=\{isColdBoot \? COLD_START_STEPS : VERIFY_STEPS\}/);
    expect(nav).toMatch(/const VERIFY_STEPS: LoadingStep\[\]/);
    expect(nav).toMatch(/const SIGNOUT_STEPS: LoadingStep\[\]/);
    expect(nav).toMatch(/steps=\{SIGNOUT_STEPS\}/);
  });

  /**
   * Client request 2026-08-31 (Corne, relayed by the founder): the encryption
   * check returns as a ~1.5 s intro on a COLD open only. The behaviour lives in
   * useColdStartIntro and is pinned by coldStartIntro.test.tsx; what this scan
   * protects is the WIRING — that RootNavigator actually widens its boot overlay
   * with the intro and shows the staged checklist while it runs. Dropping the
   * `|| coldIntro` term leaves every hook test green and silently deletes the
   * feature on a fast boot, which is exactly how it disappeared the first time.
   */
  it('the cold-start intro is wired into the boot overlay', () => {
    const nav = codeOnly('src/navigation/index.tsx');
    expect(nav).toMatch(/useColdStartIntro/);
    expect(nav).toMatch(/\|\| coldIntro\)/);
    expect(nav).toMatch(/const COLD_START_STEPS: LoadingStep\[\]/);
    // The intro overlay must CAPTURE touches - it is opaque, so a pass-through
    // tap would land blind on the screen underneath.
    expect(nav).toMatch(/pointerEvents=\{coldIntro \? 'auto' : 'none'\}/);
  });
});
