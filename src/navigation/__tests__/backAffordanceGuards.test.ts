/**
 * BB-4 / BB-5 / BB-7 / BB-9 (2026-08-15 back-button audit) — pins for the
 * non-messenger back fixes. Source scans: these screens either cannot mount
 * under the node project or the defect is a navigator option.
 *
 * Files are CRLF — normalise before matching; comments are stripped so prose
 * (including the fixes' own Why comments) can't satisfy a pin.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const read = (...p: string[]): string => readFileSync(
  join(process.cwd(), 'src', ...p), 'utf8').replace(/\r\n/g, '\n');
const strip = (src: string): string => src
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map(l => l.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

describe('BB-4 — agent/CPO onboarding gates own a working (or honestly absent) back', () => {
  it('AgentTypeSelect hides the chevron when unpoppable (it is ALWAYS the first route)', () => {
    const src = strip(read('screens', 'agent', 'AgentTypeSelectScreen.tsx'));
    expect(src).toMatch(/onBack=\{navigation\.canGoBack\(\) \? \(\) => navigation\.goBack\(\) : undefined\}/);
  });

  it('AgentVerificationStatus renders the arrow only when poppable (reset() entry = index 0)', () => {
    const src = strip(read('screens', 'agent', 'AgentVerificationStatusScreen.tsx'));
    expect(src).toMatch(/navigation\.canGoBack\(\) \? \(/);
    expect(src).toMatch(/<View style=\{styles\.backBtn\} \/>/);
  });

  it('CpoActivation has a step-back (the gate renders OUTSIDE any navigator)', () => {
    const src = strip(read('screens', 'cpo', 'CpoActivationScreen.tsx'));
    expect(src).toMatch(/\{step > 0 && \(/);
    expect(src).toMatch(/setStep\(p => Math\.max\(0, p - 1\)/);
  });
});

describe('BB-5 — the PermGate permissions page shows no dead back arrow', () => {
  it('renders the arrow only when a navigation prop exists AND can pop', () => {
    // The PermGate mount (navigation/index.tsx) passes NO navigation prop at
    // all, so the guard must be optional-chained, not just canGoBack-gated.
    const src = strip(read('screens', 'auth', 'PermissionsScreen.tsx'));
    // The guard must DIRECTLY own the arrow — an unguarded copy elsewhere
    // would re-introduce the dead control.
    expect(src).toMatch(/navigation\?\.canGoBack\?\.\(\) \? \(\s*<TouchableOpacity style=\{s\.backBtn\}/);
    expect((src.match(/<TouchableOpacity style=\{s\.backBtn\}/g) ?? []).length).toBe(1);
  });
});

describe('BB-7 — ObHeader guards the double-tap at the one shared site', () => {
  it('debounces onBack (26 deptchat screens wire it as a bare goBack)', () => {
    const src = strip(read('screens', 'deptchat', '_obsidian.tsx'));
    expect(src).toMatch(/lastBackTapRef\.current < 600/);
    expect(src).toMatch(/onPress=\{handleBack\}/);
    // The raw prop must not be wired to the touchable directly any more.
    expect(src).not.toMatch(/onPress=\{onBack\}/);
  });
});

describe('BB-9 — a paid/accepted booking cannot back into the live Confirm step', () => {
  const navSrc = strip(read('navigation', 'BookingNavigator.tsx'));
  const routeWindow = (name: string): string => {
    const at = navSrc.indexOf(`name="${name}"`);
    expect(at).toBeGreaterThan(-1);
    return navSrc.slice(at, navSrc.indexOf('/>', at));
  };

  it.each(['BookingConfirmation', 'AgencyAccepted'])('%s disables the back gesture', name => {
    expect(routeWindow(name)).toMatch(/gestureEnabled: false/);
  });

  it.each([
    ['BookingConfirmationScreen.tsx'],
    ['AgencyAcceptedScreen.tsx'],
  ])('%s converts hardware back into leave-the-flow', file => {
    const src = strip(read('screens', 'booking', file));
    const at = src.indexOf("addEventListener('hardwareBackPress'");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 220)).toMatch(/popToTop\(\)/);
  });
});
