/**
 * B-459 — the vault's biometric opt-in was dead code.
 *
 * Audit fix #36 made biometric unlock opt-IN: `setupPin` stopped auto-enabling
 * it and the store comment named the setup screen as the place that must call
 * `setBiometricEnabled(true)` after explicit consent. That call was never
 * written. With ZERO call sites the flag stayed false for every user forever,
 * so the lock screen's auto-prompt could not fire and the whole feature was
 * unreachable — the classic shape where an audit "fix" removes a behaviour and
 * nothing replaces it.
 *
 * Source scan because VaultNewPinScreen mounts RN + expo-local-authentication.
 * File is CRLF (normalised) and its own comments discuss `setBiometricEnabled`
 * in prose, so comments are stripped before every assertion — otherwise the
 * prose alone would satisfy the presence checks and the pin would be vacuous.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const ROOT = process.cwd();

function code(rel: string): string {
  const src = readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
  const out: string[] = [];
  let inBlock = false;
  for (const line of src.split('\n')) {
    const t = line.trim();
    if (inBlock) { if (t.includes('*/')) {inBlock = false;} continue; }
    if (t.startsWith('/*') || t.startsWith('{/*')) { if (!t.includes('*/')) {inBlock = true;} continue; }
    if (t.startsWith('*') || t.startsWith('//')) {continue;}
    out.push(line.replace(/([^:'"`])\/\/.*$/, '$1'));
  }
  return out.join('\n');
}

const SETUP = 'src/screens/messenger/VaultNewPinScreen.tsx';
const STORE = 'src/modules/messenger/vault/vaultStore.ts';
const LOCK  = 'src/screens/messenger/VaultLockScreen.tsx';

describe('B-459 — the opt-in has a real caller', () => {
  it('the stripper is working, so presence assertions read code not prose', () => {
    const stripped = code(SETUP);
    // The doc comment above the prompt mentions the symbol; that must NOT be
    // what satisfies the assertions below.
    expect(readFileSync(join(ROOT, SETUP), 'utf8')).toContain('`setBiometricEnabled` had ZERO call sites');
    expect(stripped).not.toContain('had ZERO call sites');
  });

  it('the setup screen reads the setter off the store', () => {
    expect(code(SETUP)).toMatch(/useVaultStore\(s => s\.setBiometricEnabled\)/);
  });

  it('and actually enables the flag', () => {
    expect(code(SETUP)).toMatch(/setBiometricEnabled\(true\)/);
  });

  it('only ever from an explicit user consent tap — never automatically', () => {
    const src = code(SETUP);
    // Audit fix #36's whole point: it is opt-IN. The only enable site must sit
    // inside the confirmation dialog's button handler.
    expect(src).toMatch(/Alert\.alert\([\s\S]{0,1200}onPress: \(\) => setBiometricEnabled\(true\)/);
    expect(src.match(/setBiometricEnabled\(true\)/g)).toHaveLength(1);
    expect(src).not.toMatch(/setBiometricEnabled\(false\)/);
  });

  it('is gated on the device actually having an enrolled biometric', () => {
    const src = code(SETUP);
    // Offering it on a device with no sensor, or with no fingerprint/face
    // registered, would arm a switch that silently does nothing at unlock time.
    expect(src).toMatch(/LocalAuthentication\.hasHardwareAsync\(\)/);
    expect(src).toMatch(/LocalAuthentication\.isEnrolledAsync\(\)/);
    expect(src).toMatch(/if \(!hasHardware \|\| !isEnrolled\) \{return;\}/);
  });

  /**
   * DELIBERATE FLIP of the original pin, which required `if (!hasPin)`.
   *
   * This screen is the ONLY door to the flag — there is no settings toggle
   * anywhere in the app — and gating the prompt on first creation bricked it:
   * a user who tapped "Not now" once could never enable biometric again. The
   * trigger is now "the flow completed and it is still off", PIN change
   * included; somebody who already enabled it is never re-asked.
   */
  /**
   * DELIBERATE FLIP of the render-time read.
   *
   * This gate fires AFTER an awaited Argon2 hash (~300ms), and there is now a
   * second writer of the flag (the Settings toggle) on another surface. A
   * value captured at render can therefore be stale by the time it is
   * consulted, and the stale value re-offers consent for something the user
   * already turned on. Read it from the store at CALL time; the render-time
   * subscription is gone because nothing else on this screen used it.
   */
  it('is offered whenever the flow completes and biometric is still OFF', () => {
    const src = code(SETUP);
    expect(src).toMatch(
      /if \(!useVaultStore\.getState\(\)\.biometricEnabled\) \{void offerBiometricUnlock\(\);\}/,
    );
    // The old first-creation gate must be gone, not merely joined by the new
    // one — an && of the two is the same dead end.
    expect(src).not.toMatch(/if \(!hasPin\) \{void offerBiometricUnlock/);
    // …and the stale render-time capture must not come back.
    expect(src).not.toMatch(/useVaultStore\(s => s\.biometricEnabled\)/);
  });

  /**
   * DELIBERATE FLIP #2, and the reason it is safe this time.
   *
   * The original prompt promised "you can turn this off later" against an app
   * with no off switch at all. B-459 replaced that with "enable this later by
   * changing your PIN" — true only while this flow was the sole door. There is
   * now a real toggle (Messenger Settings → FILE VAULT), so the honest copy
   * points at it.
   *
   * The promise pin and the toggle-existence scan are ONE test on purpose:
   * flipping a promise pin without enforcing the new promise is precisely the
   * defect B-459 was. Deleting either half to make a run green re-opens it.
   */
  it('the consent copy promises an off switch that provably exists', () => {
    const src = code(SETUP);
    expect(src).toMatch(/You can turn this off any time in Settings\./);
    expect(src).not.toMatch(/enable this later by changing your PIN/);

    // …and here is the switch it is promising.
    const settings = code('src/screens/messenger/MessengerSettingsScreen.tsx');
    expect(settings).toMatch(/const vaultBiometricOn = useVaultStore\(s => s\.biometricEnabled\)/);
    expect(settings).toMatch(/value=\{vaultBiometricOn\}/);
    expect(settings).toMatch(/onValueChange=\{toggleVaultBiometric\}/);
    // The OFF direction specifically — an on-only control is the old dead end
    // wearing a Switch.
    expect(settings).toMatch(/vault\.setBiometricEnabled\(false\);/);
  });

  it('never blocks entry to the vault if the probe fails', () => {
    const src = code(SETUP);
    const fn = src.slice(src.indexOf('const offerBiometricUnlock'), src.indexOf('const handleComplete'));
    // A throwing/hanging LocalAuthentication call must not strand the user on
    // the keypad after their PIN has already been saved.
    expect(fn).toMatch(/try \{/);
    expect(fn).toMatch(/\} catch \{/);
    // Fire-and-forget at the call site — the navigation timer is not awaited on it.
    expect(src).toMatch(/void offerBiometricUnlock\(\)/);
  });

  it('the store still exposes the setter it calls, and still defaults OFF', () => {
    const store = code(STORE);
    expect(store).toMatch(/setBiometricEnabled: \(enabled: boolean\) => set/);
    expect(store).toMatch(/biometricEnabled:\s*false/);
    // Audit fix #36 — setupPin must not re-enable it behind the user's back.
    const setup = store.slice(store.indexOf('setupPin: async'), store.indexOf('verifyPin: async'));
    expect(setup).toMatch(/s\.biometricEnabled = false;/);
    expect(setup).not.toMatch(/s\.biometricEnabled = true;/);
  });
});

/**
 * SECURITY — the opt-in has to hold at the LOCK screen too, or it is decorative.
 *
 * The keypad's fingerprint key was rendered always and merely dimmed when the
 * hardware probe failed. It ignored `biometricEnabled` entirely, so a user who
 * declined the consent prompt was still shown a biometric unlock affordance,
 * and tapping it fired the OS prompt — which on a shared device with a
 * co-worker's fingerprint enrolled is somebody else's finger opening the vault.
 */
describe('B-459 — biometric unlock is HARD opt-in at the keypad', () => {
  it('the fingerprint key is rendered only with consent AND hardware', () => {
    const src = code(LOCK);
    expect(src).toMatch(/\{biometricEnabled && bioAvailable \? \(/);
    // The key must be ABSENT, not present-and-disabled: a dimmed key still
    // advertises a path the user declined, and `disabled` has been removed
    // exactly once before by someone "fixing" a greyed-out control.
    expect(src).not.toMatch(/disabled=\{!bioAvailable\}/);
    expect(src).not.toMatch(/!bioAvailable && \{opacity/);
  });

  it('the branch really wraps the tryBiometric key, not some other control', () => {
    const src = code(LOCK);
    const at = src.indexOf('{biometricEnabled && bioAvailable ? (');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf(') : (', at));
    expect(block).toMatch(/onPress=\{\(\) => \{ void tryBiometric\(\); \}\}/);
    expect(block).toMatch(/name="fingerprint"/);
  });

  it('hiding it does not shift the 0 key off centre', () => {
    // A three-column keypad with two children re-centres; the spacer is what
    // keeps 0 under the 2/5/8 column.
    const src = code(LOCK);
    expect(src).toMatch(/<View style=\{styles\.keyBtnSpacer\} \/>/);
    expect(src).toMatch(/keyBtnSpacer: \{width: 58, height: 58\}/);
  });
});
