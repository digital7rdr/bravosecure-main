/**
 * B-459 follow-up — the vault's biometric unlock needs an OFF switch.
 *
 * The B-459 fix built the only door: a consent prompt on the PIN flow. Once a
 * user said yes there was no way back, so the honest copy had to say so. This
 * change adds the durable off-ramp (Messenger Settings → FILE VAULT) and the
 * second on-ramp, and flips the promise to match.
 *
 * SOURCE SCAN, deliberately. MessengerSettingsScreen mounts RN + navigation +
 * an HTTP client and there is no render suite for it; the node project cannot
 * mount it at all. The behavioural halves live where they can actually run:
 *   - the pinFresh ARITHMETIC (dual-clock AND, rollback, doze, negative delta)
 *     and the W6 malformed-branch clear → vaultStore.test.ts (messenger-crypto,
 *     which owns the jest.setSystemTime harness and the real store);
 *   - the §3.3b cancel arms and the resolver forward → vaultLockShellExit.tsx.
 *
 * These files are CRLF and prose-heavy (they discuss `setBiometricEnabled`,
 * `pinFresh` and the copy in comments), so comments are stripped before every
 * assertion — otherwise the prose alone satisfies the presence checks and the
 * pin is vacuous.
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

const SETTINGS = 'src/screens/messenger/MessengerSettingsScreen.tsx';
const LOCK     = 'src/screens/messenger/VaultLockScreen.tsx';
const SETUP    = 'src/screens/messenger/VaultNewPinScreen.tsx';
const BACKUP   = 'src/screens/messenger/BackupSetupScreen.tsx';
const STORE    = 'src/modules/messenger/vault/vaultStore.ts';
const TYPES    = 'src/navigation/types.ts';

/** Every shell that mounts VaultLock / VaultNewPin. */
const SHELLS = [
  'src/navigation/MessengerNavigator.tsx',
  'src/navigation/AgentNavigator.tsx',
  'src/navigation/DepartmentalNavigator.tsx',
] as const;

/**
 * A route is REGISTERED, not merely declared, when the navigator names it AND
 * hands it a component. Matched as two facts rather than one regex because the
 * three files write `<Stack.Screen>` in three different shapes (single-line,
 * multi-line, and a `VaultStack` alias) — a shape-specific pattern would pass
 * vacuously on the two it does not describe.
 */
function registers(navSrc: string, route: string, component: string): boolean {
  return navSrc.includes(`name="${route}"`) && navSrc.includes(`component={${component}}`);
}

/** The toggle handler, sliced out so absence assertions are site-scoped. */
function toggleFn(): string {
  const src = code(SETTINGS);
  const at = src.indexOf('const toggleVaultBiometric');
  expect(at).toBeGreaterThan(-1);
  const end = src.indexOf('const unblock', at);
  expect(end).toBeGreaterThan(at);
  return src.slice(at, end);
}

/**
 * The screens that carry a door to MessengerSettings, and the file to read it
 * from. A shell is only genuinely covered if it MOUNTS one of these.
 */
const DOORS: ReadonlyArray<{component: string; file: string}> = [
  {component: 'MessengerHomeScreen', file: 'src/screens/messenger/MessengerHomeScreen.tsx'},
  {component: 'FilesScreen',         file: 'src/screens/messenger/FilesScreen.tsx'},
];

describe('W1 — the off-ramp is REACHABLE from every shell that offers the opt-in', () => {
  it.each(SHELLS)('%s registers MessengerSettings', shell => {
    // The consent prompt fires wherever VaultLock/VaultNewPin are mounted, and
    // it now promises a Settings toggle. A shell that mounts the prompt without
    // the pane makes that promise a lie — which is the B-459 defect shape.
    const src = code(shell);
    expect(registers(src, 'VaultLock', 'VaultLockScreen')).toBe(true);
    expect(registers(src, 'MessengerSettings', 'MessengerSettingsScreen')).toBe(true);
  });

  /**
   * REGISTRATION IS NOT REACHABILITY. The workspace Vault stack registered the
   * pane and still had no way in: its `MessengerHome` route is FilesScreen, not
   * the messenger home that carries the gear. The promise was false in exactly
   * the shell where it is hardest to notice. So the pin asks the stronger
   * question — does this shell mount a screen that actually navigates there?
   */
  it.each(SHELLS)('%s mounts a screen that actually navigates to it', shell => {
    const src = code(shell);
    const mounted = DOORS.filter(d => src.includes(`component={${d.component}}`));
    expect(mounted.length).toBeGreaterThan(0);
    // A NAVIGATION, not merely a resolution: `findNavigatorWithRoute` naming
    // the route proves only that somebody looked it up. A resolver whose result
    // is never dispatched is exactly the dead tap this pin exists to catch, so
    // it must not count as a door.
    const navigating = mounted.filter(d =>
      /(?:navigation\.navigate\(|navigateVia\(\w+, )'MessengerSettings'/.test(code(d.file)));
    expect(navigating.length).toBeGreaterThan(0);
  });

  it('the Files gear is resolved and HIDDEN when unresolvable — never a dead tap', () => {
    // It is the workspace shell's only door, and FilesScreen runs in four
    // navigators, so a hard-coded navigate would be the Issues-18/19 no-op all
    // over again.
    const files = code('src/screens/messenger/FilesScreen.tsx');
    expect(files).toMatch(/const settingsNav = findNavigatorWithRoute\(navigation, 'MessengerSettings'\);/);
    expect(files).toMatch(/\{settingsNav \? \(/);
    expect(files).toMatch(/onPress=\{\(\) => navigateVia\(settingsNav, 'MessengerSettings'\)\}/);
    expect(files).toMatch(/accessibilityLabel="Messenger settings"/);
    expect(files).not.toMatch(/navigation\.navigate\('MessengerSettings'\)/);
  });

  it('the widened VaultGateParams names only routes that are really registered', () => {
    // types.ts already carries the rule (see its F-WSHUB note): a declared but
    // unregistered name lets a bare navigate compile and silently no-op. The
    // union is widened because W1 made the claim TRUE, not by narrowing it.
    expect(code(TYPES)).toMatch(
      /export type VaultGateParams = \{next\?: 'Files' \| 'MessengerHome' \| 'MessengerSettings'\} \| undefined;/,
    );
  });
});

describe('W1b — the transitive sweep: mounting the pane exposes ITS outbound taps', () => {
  it('every route MessengerSettings navigates to is registered in all three shells', () => {
    // THE SWEEP MUST KNOW EVERY NAVIGATION IDIOM THIS FILE USES. It originally
    // scanned `navigation.navigate('X')` only; the moment a call moved to the
    // resolver form the sweep would have stopped enforcing registration while
    // still passing — a scan that silently covers less than it claims is worse
    // than no scan. All three shapes are read here.
    const src = code(SETTINGS);
    const targets = [...src.matchAll(
      /(?:navigation\.navigate\(|navigateVia\(\w+, |findNavigatorWithRoute\(navigation, )'(\w+)'/g,
    )].map(m => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(3);
    // If this set grows, the sweep below has to grow with it — that is the
    // whole point of reading the targets out of the source instead of listing
    // them here.
    expect(new Set(targets)).toEqual(new Set(['BackupSetup', 'VaultLock']));
    for (const shell of SHELLS) {
      const shellSrc = code(shell);
      expect(registers(shellSrc, 'BackupSetup', 'BackupSetupScreen')).toBe(true);
      expect(registers(shellSrc, 'VaultLock', 'VaultLockScreen')).toBe(true);
    }
  });

  it('BackupSetupScreen\'s own exits resolve in the two new shells', () => {
    // The sweep does not stop at the pane: BackupSetup is now mounted in two
    // shells it was never written for, so ITS exits get swept too. They are
    // goBackOnce (shell-agnostic) and replace('MessengerHome') — and
    // 'MessengerHome' is a real route in both (the Agent stack registers it;
    // the Departmental Vault stack aliases FilesScreen under that name).
    const src = code(BACKUP);
    expect(src).toMatch(/goBackOnce\(navigation\)/);
    const replaced = new Set([...src.matchAll(/navigation\.replace\('(\w+)'/g)].map(m => m[1]));
    expect(replaced).toEqual(new Set(['MessengerHome']));
    // No other navigation verb reaches out of this screen.
    expect(src).not.toMatch(/navigation\.navigate\(/);
    expect(src).not.toMatch(/navigation\.reset\(/);
    for (const shell of SHELLS) {
      expect(code(shell)).toContain('name="MessengerHome"');
    }
  });
});

describe('W2 — the row', () => {
  it('is hidden until the vault store has hydrated AND a PIN exists', () => {
    // Rehydration is async: until it lands `pinHash` reads as initialState's
    // null, indistinguishable from "no PIN" — so answering early would hide
    // the row from exactly the users who own the flag.
    const src = code(SETTINGS);
    expect(src).toMatch(/const \[vaultReady, setVaultReady\]\s+= useState\(\(\) => vaultHydrated\(\)\)/);
    expect(src).toMatch(/\{vaultReady && vaultHasPin \? \(/);
    // Declining is only safe if something re-runs it.
    expect(src).toMatch(/return p\.onFinishHydration\(\(\) => setVaultReady\(true\)\)/);
  });

  it('is store-backed — no local mirror of the flag to drift', () => {
    // Three other writers touch this flag (setupPin, verifyPin's malformed
    // branch, sign-out's reset). A useState mirror would go stale under any of
    // them; the write is synchronous and local, so there is nothing to be
    // optimistic about either.
    const src = code(SETTINGS);
    expect(src).toMatch(/const vaultBiometricOn = useVaultStore\(s => s\.biometricEnabled\)/);
    expect(src).toMatch(/const vaultHasPin\s+= useVaultStore\(s => s\.hasPin\(\)\)/);
    expect(src).toMatch(/value=\{vaultBiometricOn\}/);
    expect(src).not.toMatch(/useState[^\n]*[Bb]iometricOn/);
  });

  /**
   * DELIBERATE COPY FLIP. The hint used to read "…with your fingerprint, face
   * or your device screen lock", which described ARMING and UNLOCKING as one
   * thing. They are no longer the same: arming demands a real biometric (the
   * capability proof passes `disableDeviceFallback: true`, and SECRET-level
   * devices read as unavailable), while VaultLock's unlock lane still accepts
   * the device credential and is deliberately untouched. The copy now states
   * both facts separately — dropping the second would UNDER-disclose a real
   * unlock path, which is the thing §3.6 exists to prevent.
   */
  it('names the app-level lock it is NOT, and separates arming from unlocking', () => {
    const src = code(SETTINGS);
    expect(src).toMatch(/This is separate from Biometric Lock in your profile, which locks the whole app\./);
    expect(src).toMatch(/Open the vault with your fingerprint or face instead of typing the PIN\./);
    // The disclosure survives the flip — it just no longer implies you can turn
    // the toggle ON with a screen lock.
    expect(src).toMatch(/Once it is on, your device screen lock can open the vault too\./);
    expect(src).not.toMatch(/fingerprint, face or your device screen lock/);
  });

  it('says nothing positive while the probe is still out (P2-5)', () => {
    // The row is DISABLED in the 'unknown' state; pairing that with copy
    // describing what it would do reads as a broken control, not a pending one.
    const src = code(SETTINGS);
    expect(src).toMatch(/vaultBioProbe === 'unknown'/);
    expect(src).toMatch(/'Checking device biometrics…'/);
  });

  it('names the weak level without guessing which modality it is (P2-9)', () => {
    // BIOMETRIC_WEAK is not necessarily face unlock — it is whatever the OEM
    // classified as weak. The old copy asserted a modality we cannot know.
    const src = code(SETTINGS);
    expect(src).toMatch(/This device's biometric is low-security\./);
    expect(src).not.toMatch(/Face unlock on this device/);
  });
});

describe('§3.1 — the hardware probe', () => {
  it('is getEnrolledLevelAsync, never the banned hasHardware+isEnrolled pair', () => {
    // On Android that pair reads lockout / HW_UNAVAILABLE / SECURITY_UPDATE
    // _REQUIRED as "no biometrics on this device" (BiometricGate's long note).
    // Here that would disable the row exactly when a user whose biometric just
    // broke wants to turn it off.
    const src = code(SETTINGS);
    expect(src).toMatch(/LocalAuthentication\.getEnrolledLevelAsync\(\)/);
    expect(src).not.toMatch(/hasHardwareAsync/);
    expect(src).not.toMatch(/isEnrolledAsync/);
  });

  it('is bounded, and a probe that never answers reads as unavailable', () => {
    const src = code(SETTINGS);
    expect(src).toMatch(/Promise\.race\(\[/);
    expect(src).toMatch(/VAULT_BIO_PROBE_TIMEOUT_MS/);
    expect(src).toMatch(/level === null\n\s+\|\| level === LocalAuthentication\.SecurityLevel\.NONE/);
    expect(src).toMatch(/\} catch \{\n\s+return 'none';/);
  });

  /**
   * P1-1 — the dead-switch half. `SECRET` means "this device holds a screen-lock
   * code but no usable biometric" — which is ALSO what Android reports during a
   * biometric LOCKOUT. Reading that as available armed a flag the keypad could
   * never serve: `biometricEnabled && bioAvailable` stays false there, so the
   * fingerprint key never appears and the switch is on for nothing.
   *
   * This deliberately DIVERGES from BiometricGate's reading of the same enum,
   * and that is correct: BiometricGate asks "is there any secret to check" and
   * will accept the passcode; this row arms a biometric affordance.
   */
  it('SECRET is unavailable here — a screen lock cannot arm a biometric', () => {
    const src = code(SETTINGS);
    expect(src).toMatch(/\|\| level === LocalAuthentication\.SecurityLevel\.SECRET\) \{return 'none';\}/);
  });

  it('re-runs on focus AND on AppState active (N2)', () => {
    // useFocusEffect does NOT fire on background→foreground, and "delete your
    // fingerprints in device settings, come back" is exactly that trip.
    const src = code(SETTINGS);
    expect(src).toMatch(/useFocusEffect\(useCallback\(\(\) => \{\n\s+refreshVaultBioProbe\(\);/);
    expect(src).toMatch(/AppState\.addEventListener\('change', st => \{/);
    expect(src).toMatch(/if \(st === 'active'\) \{refreshVaultBioProbe\(\);\}/);
  });

  it('cleans up after itself, and a late answer cannot repaint a dead screen', () => {
    // Promise.race settles the PROMISE, not the loser: the timeout kept running
    // once per focus and once per foreground. And a probe outliving its screen
    // must write nothing — both effect cleanups invalidate the in-flight token.
    const src = code(SETTINGS);
    expect(src).toMatch(/if \(timer !== undefined\) \{clearTimeout\(timer\);\}/);
    expect(src).toMatch(/const mine = \+\+bioProbeToken\.current;/);
    expect(src).toMatch(/if \(bioProbeToken\.current === mine\) \{setVaultBioProbe\(p\);\}/);
    // BOTH cleanups invalidate, named rather than counted: blur (focus effect)
    // and unmount (AppState effect). Dropping either one is the leak.
    expect(src).toMatch(/const invalidateBioProbe = useCallback\(\(\) => \{ bioProbeToken\.current\+\+; \}, \[\]\);/);
    expect(src).toMatch(/refreshVaultBioProbe\(\);\n\s+return invalidateBioProbe;/);
    expect(src).toMatch(/return \(\) => \{ sub\.remove\(\); invalidateBioProbe\(\); \};/);
  });

  it('disables the row ASYMMETRICALLY — only while the flag is OFF (P0-4)', () => {
    const src = code(SETTINGS);
    expect(src).toMatch(/const vaultBioRowDisabled = !vaultBioUsable && !vaultBiometricOn;/);
    expect(src).toMatch(/disabled=\{vaultBioRowDisabled\}/);
    // Both arms' copy, so neither can be dropped silently.
    expect(src).toMatch(/Add a fingerprint or face in your device settings first\./);
    expect(src).toMatch(/Biometric is no longer available on this device — turn this off, or re-enrol\./);
  });

  it('G4 — the two security screens keep their own fail-CLOSED probe pair', () => {
    // Deliberately out of scope: on those screens the pair fails closed (the
    // key hides, the PIN still works). Do not "fix" two security screens on the
    // way past.
    for (const rel of [LOCK, SETUP]) {
      const src = code(rel);
      expect(src).toMatch(/LocalAuthentication\.hasHardwareAsync\(\)/);
      expect(src).toMatch(/LocalAuthentication\.isEnrolledAsync\(\)/);
    }
  });
});

describe('§3.2 — turning it ON', () => {
  it('is gated on a PIN typed in the last minute, not on the unlock window', () => {
    // isUnlocked() is NOT the same anchor: `unlockWithBiometric` opens that
    // window too, and even a PIN-opened one survives handing the phone over.
    const fn = toggleFn();
    expect(fn).toMatch(/if \(!vault\.pinFresh\(\)\) \{/);
    expect(fn).not.toMatch(/isUnlocked/);
  });

  it('never awaits between the freshness read and the true write', () => {
    // An await there is a window for a relock, a burst OFF tap, or sign-out's
    // reset() to interleave — and the probe must never sit on this path (G3).
    const fn = toggleFn();
    const guard = fn.indexOf('pinFresh()');
    const write = fn.indexOf('setBiometricEnabled(true)');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(guard);
    expect(fn.slice(guard, write)).not.toMatch(/await|\.then\(/);
    expect(fn).not.toMatch(/getEnrolledLevelAsync/);
    // The whole handler is synchronous — no async keyword anywhere in it.
    expect(fn).toMatch(/const toggleVaultBiometric = \(on: boolean\) => \{/);
    expect(fn).not.toMatch(/\basync\b/);
  });

  it('a stale PIN opens the lock lane carrying its return address', () => {
    const fn = toggleFn();
    expect(fn).toMatch(/\{text: 'Cancel', style: 'cancel'/);
    expect(fn).toMatch(/navigateVia\(lockNav, 'VaultLock', \{next: 'MessengerSettings'\}\)/);
    // The switch must NOT flip on the way — the anchor is the PIN typed after
    // the round trip, not an intent carried across navigation.
    const alertAt = fn.indexOf('Confirm your vault PIN');
    const writeAt = fn.indexOf('setBiometricEnabled(true)');
    expect(alertAt).toBeLessThan(writeAt);
    expect(fn.slice(alertAt, writeAt)).toMatch(/return;/);
  });

  /**
   * The round trip has to actually SHOW a keypad, or the two-tap flow is a
   * loop. VaultLock forwards on focus whenever `isUnlocked()` — the 5-minute
   * window `pinFresh` deliberately refuses — so between 60s and 5min after a
   * PIN entry the user was bounced straight back with nothing typed, tapped
   * again, and got the same Alert. The forward is right for every other lane
   * and is arch-gated, so the guarantee lives on THIS side: lock first.
   */
  it('"Enter PIN" RESOLVES, then locks, then navigates — in that order', () => {
    const fn = toggleFn();
    const at = fn.indexOf("text: 'Enter PIN'");
    expect(at).toBeGreaterThan(-1);
    const handler = fn.slice(at, fn.indexOf('],', at));

    // 1. Resolve BEFORE locking. Locking and THEN discovering the dispatch has
    //    nowhere to go leaves a freshly locked vault with no keypad — a
    //    destructive dead tap, strictly worse than the stale window it cleared.
    expect(handler).toMatch(/const lockNav = findNavigatorWithRoute\(navigation, 'VaultLock'\);/);
    expect(handler).toMatch(/if \(!lockNav\) \{return;\}/);
    // 2. Then lock — this is what guarantees the keypad appears at all
    //    (VaultLock forwards on focus while merely unlocked).
    expect(handler).toMatch(/useVaultStore\.getState\(\)\.lock\(\);/);
    // 3. Then navigate.
    const resolveAt  = handler.indexOf('findNavigatorWithRoute');
    const bailAt     = handler.indexOf('if (!lockNav) {return;}');
    const lockAt     = handler.indexOf('.lock();');
    const navigateAt = handler.indexOf('navigateVia(lockNav');
    expect(resolveAt).toBeLessThan(bailAt);
    expect(bailAt).toBeLessThan(lockAt);
    expect(lockAt).toBeLessThan(navigateAt);
    // The copy has to warn, or the relock is a surprise mid-flow.
    expect(fn).toMatch(/Your vault will lock so you can enter it\./);
  });

  it('a pending capability proof blocks a NEW arm, before the true write (P2-4)', () => {
    // A prompt already in flight owns the decision: arming behind it writes
    // `true` for a result that will answer for the PREVIOUS tap.
    const fn = toggleFn();
    const guardAt = fn.indexOf('if (bioProofPending.current) {return;}');
    const writeAt = fn.indexOf('setBiometricEnabled(true)');
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(writeAt);
    // …and it must NOT sit in the OFF arm — turning it off is never gated.
    const off = fn.slice(fn.indexOf('if (!on) {'), fn.indexOf('if (vault.biometricEnabled)'));
    expect(off).not.toMatch(/bioProofPending/);
  });

  it('the Alert cannot double-queue, and its marker cannot stick (P2-6)', () => {
    // The alert host queues FIFO, so a burst tap stacks a second copy behind a
    // decision already made. But a marker cleared only by the buttons would
    // STICK on a back/backdrop dismiss (the host does not call button handlers
    // there) — that is the dead-switch class again. Every exit path clears it.
    const fn = toggleFn();
    expect(fn).toMatch(/if \(bioAlertPending\.current\) \{return;\}/);
    expect(fn).toMatch(/bioAlertPending\.current = true;/);
    expect(fn).toMatch(/\{text: 'Cancel', style: 'cancel', onPress: \(\) => \{ bioAlertPending\.current = false; \}\}/);
    expect(fn).toMatch(/onDismiss: \(\) => \{ bioAlertPending\.current = false; \}/);
    // Three clears: Cancel, Enter PIN, and onDismiss.
    expect(fn.match(/bioAlertPending\.current = false;/g)).toHaveLength(3);
  });

  it('the capability proof is single-flight and its revert is sequenced', () => {
    // The native module keeps ONE promise (BiometricGate's `authenticating`
    // ref), and SET-08: ON → OFF → ON with a stale user_cancel landing last
    // would otherwise revert the newer, successful ON.
    const src = code(SETTINGS);
    expect(src).toMatch(/const vaultBioSeq = useRef\(createLatestWins<'vaultBiometric'>\(\)\)\.current/);
    expect(toggleFn()).toMatch(/const isLatest = vaultBioSeq\(\['vaultBiometric'\]\);/);

    const at = src.indexOf('const proveVaultBiometricWorks');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('const toggleVaultBiometric', at));
    expect(fn).toMatch(/if \(bioProofPending\.current\) \{return;\}/);
    expect(fn).toMatch(/bioProofPending\.current = true;/);
    expect(fn).toMatch(/bioProofPending\.current = false;/);
    // EVERY write in the proof is a revert, and every revert is immediately
    // preceded by the latest-wins check.
    expect(fn).not.toMatch(/setBiometricEnabled\(true\)/);
    const guarded = fn.match(
      /if \(!isLatest\(\)\) \{return;\}\s+useVaultStore\.getState\(\)\.setBiometricEnabled\(false\);/g,
    );
    expect(guarded).toHaveLength(2);
    expect(fn.match(/setBiometricEnabled\(false\)/g)).toHaveLength(2);
  });

  /**
   * P1-1 — the works-check half. With `disableDeviceFallback: false` the proof
   * could be satisfied by typing the DEVICE PASSCODE, which says nothing about
   * whether a biometric exists — so a screen-lock-only device passed the check
   * and armed a flag the keypad can never serve.
   *
   * This STRENGTHENS a check. It is not a stop-condition: VaultLockScreen's
   * unlock lane is untouched and still passes `false`, so no unlock path
   * changes and the §3.6 arch-gated decision stays open.
   */
  it('the works-check demands a real biometric — and ONLY the works-check', () => {
    const settings = code(SETTINGS);
    const at = settings.indexOf('const res = await LocalAuthentication.authenticateAsync');
    expect(at).toBeGreaterThan(-1);
    expect(settings.slice(at, at + 400)).toMatch(/disableDeviceFallback: true,/);
    // Exactly one authenticateAsync in this file, so the line above cannot be
    // read as covering some other prompt.
    expect(settings.match(/authenticateAsync\(/g)).toHaveLength(1);

    // The UNLOCK lane keeps the device fallback — deliberately, and arch-gated.
    const lock = code(LOCK);
    expect(lock).toMatch(/disableDeviceFallback: false,/);
    expect(lock).not.toMatch(/disableDeviceFallback: true/);
  });
});

describe('§3.4 — turning it OFF', () => {
  it('is unconditional and synchronous — never gated on anything', () => {
    // OFF removes an unlock method. It can only ever weaken an attacker, so
    // gating it on a probe, a PIN or a round trip buys nothing and can strand
    // a user with a biometric they cannot revoke.
    const fn = toggleFn();
    const off = fn.slice(fn.indexOf('if (!on) {'), fn.indexOf('if (vault.biometricEnabled)'));
    expect(off).toMatch(/vault\.setBiometricEnabled\(false\);/);
    expect(off).toMatch(/return;/);
    expect(off).not.toMatch(/pinFresh|getEnrolledLevelAsync|vaultBioUsable|Alert\.alert|await/);
  });
});

describe('§4 — Settings does not become a new way into the vault', () => {
  it('holds no unlock affordance and no door into vault content', () => {
    const src = code(SETTINGS);
    expect(src).not.toMatch(/unlockWithBiometric/);
    expect(src).not.toMatch(/navigate\('VaultScreen'\)/);
    expect(src).not.toMatch(/navigate\('Files'\)/);
  });

  it('and the authenticateAsync it DOES hold cannot unlock anything', () => {
    // Asserted at the decision site rather than as a blanket token ban — the
    // capability proof legitimately needs the token; what must not exist is a
    // success arm that opens the vault.
    const src = code(SETTINGS);
    const at = src.indexOf('const res = await LocalAuthentication.authenticateAsync');
    expect(at).toBeGreaterThan(-1);
    const arm = src.slice(at, at + 600);
    expect(arm).toMatch(/if \(res\.success\) \{return;\}/);
    expect(arm).not.toMatch(/unlockedUntil|isUnlocked|unlockWithBiometric|navigation\./);
  });
});

describe('W4 — the round trip honours `next` on BOTH legs', () => {
  it('VaultLock forwards to Settings through the resolver, with a fallback', () => {
    // Never a bare hard-coded navigate from a tri-shell screen (Issues 18/19).
    // W1 makes null unreachable in practice; the fallback is what stops a deep
    // link or a restored state from stranding the user on the keypad.
    const src = code(LOCK);
    expect(src).toMatch(/else if \(returnTo === 'MessengerSettings'\) \{forwardToSettings\(\);\}/);
    const at = src.indexOf('const forwardToSettings');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('const forwardToVault', at));
    expect(fn).toMatch(/findNavigatorWithRoute\(navigation, 'MessengerSettings'\)/);
    expect(fn).toMatch(/navigateVia\(target, 'MessengerSettings'\)/);
    expect(fn).toMatch(/else \{exitToHome\(\);\}/);
    // `navigate`, not `replace`: the StackRouter pops back to the LIVE Settings
    // instance, so unsaved profile edits and its /users/me fetch survive.
    expect(fn).not.toMatch(/replace\(/);
  });

  it('the no-PIN hop keeps the address — VaultNewPin lands back on Settings', () => {
    // Reachable: a malformed legacy hash nulls pinHash mid-flow and VaultLock
    // redirects here with route.params forwarded whole.
    const src = code(SETUP);
    expect(src).toMatch(/else if \(next === 'MessengerSettings'\) \{returnToSettings\(\);\}/);
    const at = src.indexOf('const returnToSettings');
    expect(at).toBeGreaterThan(-1);
    const fn = src.slice(at, src.indexOf('const handleComplete', at));
    expect(fn).toMatch(/findNavigatorWithRoute\(navigation, 'MessengerSettings'\)/);
    expect(fn).toMatch(/navigateVia\(target, 'MessengerSettings'\)/);
  });
});

describe('W6 — the malformed-record branch is a real clean slate', () => {
  it('clears the biometric consent with the hash it was granted against', () => {
    // This was the ONE state where biometricEnabled could legally be true with
    // pinHash null: consent surviving the credential it was given for, until
    // the next setupPin. (The behaviour itself is exercised in
    // vaultStore.test.ts, which runs the real store.)
    const store = code(STORE);
    const at = store.indexOf('if (!salt) {');
    expect(at).toBeGreaterThan(-1);
    const branch = store.slice(at, at + 300);
    expect(branch).toMatch(/s\.pinHash = null;/);
    expect(branch).toMatch(/s\.biometricEnabled = false;/);
  });

  /**
   * P2-8 — a comment, pinned on the RAW file because `code()` strips it.
   *
   * `changePin` stamps the PIN proof. That is honest only while changePin
   * cannot be reached without proving the OLD pin — which is true today (its
   * one caller sits behind the lock). A future "Change PIN" entry that skips
   * that proof turns the stamp into an arming path: borrow a phone inside its
   * unlock window, set a new PIN, and pinFresh() says yes to biometric.
   */
  it('the changePin stamp carries its own future-caller warning', () => {
    const raw = readFileSync(join(ROOT, STORE), 'utf8');
    expect(raw).toContain('THIS STAMP IS ONLY HONEST WHILE `changePin` IS UNREACHABLE');
    expect(raw).toContain('MUST verify the old PIN');
    // The warning has to sit ON the stamp, not float elsewhere in the file.
    const stripped = code(STORE);
    const changePinAt = stripped.indexOf('changePin: async');
    expect(changePinAt).toBeGreaterThan(-1);
    expect(stripped.slice(changePinAt, changePinAt + 500)).toMatch(/s\.lastPinProofAt = Date\.now\(\);/);
  });

  it('every non-consent writer of the flag still forces it OFF', () => {
    const store = code(STORE);
    // setupPin, the malformed branch, and initialState (which reset() reuses).
    expect(store.match(/s\.biometricEnabled = false;/g)).toHaveLength(2);
    expect(store).toMatch(/biometricEnabled:\s*false,/);
    // The single setter is the only place `enabled` is written through.
    expect(store).toMatch(/setBiometricEnabled: \(enabled: boolean\) => set\(s => \{ s\.biometricEnabled = enabled; \}\)/);
  });
});
