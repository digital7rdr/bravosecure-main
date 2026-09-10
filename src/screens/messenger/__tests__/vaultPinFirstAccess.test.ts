/**
 * Static source-scan regression for Issue 20 (Testing Issues V2, PDF p.25) —
 * "New Department Chat Account Is Asked for an Uncreated Vault PIN". SECURITY.
 *
 * The routing was never wrong: openVault() branches on hasPin() and sends a
 * first-time user to VaultNewPin. The STATE was wrong.
 *
 * vaultStore is the one app store that PERSISTS (zustand/persist ->
 * AsyncStorage 'bravo-vault-v1'). authStore.signOut() resets wallet, booking and
 * product — all memory-only — but never reset the vault. So the previous
 * account's `pinHash` survived sign-out on a shared device, hasPin() returned
 * true for the NEXT account, and openVault() sent a brand-new Department Chat
 * user to the PIN keypad for a code they had never created.
 *
 * That is a data-separation defect, not a UX one: the failed-attempt counter,
 * the lockout deadline and the local vault file index carried over too.
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

describe('Issue 20 — vault state never crosses accounts', () => {
  /**
   * RE-POINTED 2026-08-29 (B-696, VAULT_DURABILITY_DESIGN §3): signOut no
   * longer calls `reset()` — that destroyed the ONLY copy of the per-file
   * AES keys and permanently orphaned the owner's own vault. It now calls
   * `stashAndClearOwner()` (plain sign-out: stash under the owner, CLEAR the
   * flat slice) or `purgeOwner()` (remove-account: total wipe, stash
   * included). The Issue-20 isolation property is unchanged — the next
   * account still sees an empty flat slice — and is pinned functionally by
   * vaultOwnerStash.test.ts on top of this source scan.
   */
  it('signOut clears the flat vault slice on BOTH lanes (stash on plain sign-out, purge on remove-account)', () => {
    const src = code('src/store/authStore.ts');
    const signOut = src.slice(src.indexOf('signOut: async'));
    expect(signOut).toMatch(/useVaultStore\.getState\(\)\.stashAndClearOwner\(ownerKeyForWipe\)/);
    expect(signOut).toMatch(/useVaultStore\.getState\(\)\.purgeOwner\(ownerKeyForWipe\)/);
    // The purge lane must be the wipeAtRest one — a plain sign-out that
    // purges reintroduces the B-696 data loss.
    expect(signOut).toMatch(/if \(opts\?\.wipeAtRest\) \{[\s\S]{0,120}purgeOwner/);
  });

  it('the memory-only per-account stores are still reset inside the teardown', () => {
    const src = code('src/store/authStore.ts');
    const signOut = src.slice(src.indexOf('signOut: async'));
    for (const store of ['useWalletStore', 'useBookingStore', 'useProductStore']) {
      expect(signOut).toContain(`${store}.getState().reset()`);
    }
    // The vault is handled by the owner-scoped lanes above — a bare reset()
    // creeping back into signOut would be the B-696 regression.
    expect(signOut).not.toMatch(/useVaultStore\.getState\(\)\.reset\(\)/);
  });

  it('the vault store still HAS a reset that clears the PIN hash', () => {
    const src = code('src/modules/messenger/vault/vaultStore.ts');
    expect(src).toMatch(/reset: \(\) => set\(\(\) => \(\{\.\.\.initialState\}\)\)/);
    // initialState must start with no PIN, or reset would preserve one.
    expect(src).toMatch(/pinHash:\s*null/);
  });

  it('the vault store is genuinely PERSISTED — which is why this leaked', () => {
    const src = code('src/modules/messenger/vault/vaultStore.ts');
    expect(src).toMatch(/name: 'bravo-vault-v1'/);
  });
});

describe('Issue 20 — a PIN keypad is never shown without a PIN', () => {
  it('openVault sends a first-time user to setup', () => {
    const src = code('src/modules/messenger/vault/navigation.ts');
    expect(src).toMatch(/if \(!state\.hasPin\(\)\) \{[\s\S]{0,80}VaultNewPin/);
  });

  /**
   * DELIBERATE FLIP of this pin's literal. It required a one-shot
   * `useVaultStore.getState().hasPin()` read on mount.
   *
   * That is the same predicate, but read ONCE. `verifyPin` NULLS `pinHash` when
   * it meets a malformed record (a pre-Argon2 bare SHA-256 — see vaultStore's
   * B-456 note), which happens MID-SESSION, after this effect has already run:
   * the user is left on a keypad that can never accept anything, with no route
   * to setup. The check is now subscribed to `pinHash`, so it fires the moment
   * the hash goes away.
   */
  it('VaultLockScreen redirects to setup if it is reached directly', () => {
    // It is a registered route in four navigators, so a deep link or a restored
    // navigation state can land on it without passing through openVault().
    const src = code('src/screens/messenger/VaultLockScreen.tsx');
    expect(src).toMatch(/if \(pinHash === null\) \{[\s\S]{0,120}replace\('VaultNewPin', route\.params\)/);
    // Subscribed, not sampled — the whole point of the flip.
    expect(src).toMatch(/const pinHash\s+= useVaultStore\(s => s\.pinHash\)/);
    expect(src).toMatch(/\}, \[navigation, pinHash, route\.params\]\);/);
  });

  it('the redirect CARRIES the caller\'s destination', () => {
    // B-453 — the gate now fronts the on-device Files browser too. Dropping
    // `route.params` here sends a Files-gated user who turns out to have no PIN
    // into the Cloud Vault after setup, not back to the browser they tapped —
    // and on a Lite account that is a paywall.
    const src = code('src/screens/messenger/VaultLockScreen.tsx');
    expect(src).toMatch(/replace\('VaultNewPin', route\.params\)/);
    expect(src).not.toMatch(/replace\('VaultNewPin'\)/);
  });

  it('an already-unlocked vault does not strand the user on the keypad', () => {
    // Inside the Departmental Vault tab this screen stays warm in the stack, so
    // an unlock that happened ELSEWHERE (the personal stack's lock, a biometric
    // prompt) left a keypad in front of an open vault. Forward on focus — and
    // honour `next`, or the forward lands somewhere the caller did not ask for.
    const src = code('src/screens/messenger/VaultLockScreen.tsx');
    expect(src).toMatch(/if \(useVaultStore\.getState\(\)\.isUnlocked\(\)\) \{forwardToVault\(\);\}/);
    // forwardToVault is the ONE place `next` is honoured — pinned so this
    // forward can never grow its own hard-coded destination.
    expect(src).toMatch(/const forwardToVault = useCallback\(\(\) => \{/);
    const fwd = src.slice(src.indexOf('const forwardToVault'), src.indexOf('const forwardToVault') + 400);
    expect(fwd).toMatch(/returnTo === 'Files'/);
    expect(fwd).toMatch(/returnTo === 'MessengerHome'/);
  });
});

/**
 * The lock GATE on the two screens it fronts. One behaviour, two copies — so
 * every rule below is asserted against BOTH, or the copies drift and only one
 * carries the next fix (the repo's duplicate-copy bug class).
 */
describe('the vault gate reacts to the lock on every screen that runs it', () => {
  const GATED = [
    'src/screens/messenger/FilesScreen.tsx',
    'src/screens/messenger/VaultScreen.tsx',
  ];

  it.each(GATED)('%s declines to answer before the store has hydrated', rel => {
    // Rehydration is async; until it lands `pinHash` reads as initialState's
    // null, which is indistinguishable from "no PIN". Answering there routes a
    // real-PIN user into setup, where setupPin CLOBBERS the hash.
    const src = code(rel);
    const at = src.indexOf('const guardLock = useCallback');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);
    expect(body).toMatch(/if \(!vaultHydrated\(\)\) \{return;\}/);
    // …and it is the FIRST thing the guard does, before any lock read.
    expect(body.indexOf('vaultHydrated()')).toBeLessThan(body.indexOf('isUnlocked()'));
    // Declining is only safe if something re-runs it later.
    expect(src).toMatch(/p\.onFinishHydration\(\(\) => \{ if \(navigation\.isFocused\(\)\) \{guardLock\(\);\} \}\)/);
  });

  it.each(GATED)('%s re-gates when the lock deadline moves or expires', rel => {
    // Focus + AppState alone cannot see a `lock()` fired under a focused screen
    // (BiometricGate relocks after an await, a later tick than the background
    // transition), nor the 5-minute window simply running out.
    const src = code(rel);
    expect(src).toMatch(/const unlockedUntil = useVaultStore\(s => s\.unlockedUntil\)/);
    const at = src.indexOf('const ms = unlockedUntil - Date.now();');
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at - 200, at + 300);
    expect(block).toMatch(/guardLock\(\);/);
    expect(block).toMatch(/setTimeout\(\(\) => \{ if \(navigation\.isFocused\(\)\) \{guardLock\(\);\} \}, ms \+ 50\)/);
    expect(block).toMatch(/return \(\) => clearTimeout\(t\);/);
  });

  it.each(GATED)('%s routes at most once per lock episode', rel => {
    // Focus, AppState and the deadline effect can all answer in one commit;
    // two `navigation.replace` calls stack two transitions.
    const src = code(rel);
    expect(src).toMatch(/const gateRoutedRef = useRef\(false\)/);
    expect(src).toMatch(/if \(gateRoutedRef\.current\) \{return;\}/);
    expect(src).toMatch(/gateRoutedRef\.current = false;/);
  });

  it('no default PIN is assigned or implied anywhere', () => {
    // The PDF is explicit: "Do not assign or imply a default PIN."
    const store = code('src/modules/messenger/vault/vaultStore.ts');
    expect(store).not.toMatch(/DEFAULT_PIN|'000000'|'123456'/);
    expect(code('src/screens/messenger/VaultLockScreen.tsx')).not.toMatch(/'000000'|'123456'/);
  });
});
