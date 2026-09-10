/**
 * Department data must survive app deletion — founder-decided 2026-08-04.
 *
 * Department channel POSTS are end-to-end encrypted and live only in the local
 * SQLCipher store; the relay holds ciphertext it cannot read. So deleting the
 * app destroys the workspace's entire conversation history, and an encrypted
 * backup is the only thing that survives it. (Channels, members, shifts, roster
 * and approvals are server-side already and were never at risk.)
 *
 * Making the posts server-readable would break the E2EE contract the
 * architecture doc locks, so the honest fix is to stop treating backup as a
 * dismissible suggestion for accounts that carry OTHER PEOPLE'S records.
 *
 * WHY A SOURCE SCAN. `backupBoot.ts` reaches the real messenger runtime,
 * navigation ref, AsyncStorage and CryptoStore on import — the node project
 * cannot mount it, which is why its siblings (`backupHardening.test.ts`) scan
 * it too. The rule here is a set of ABSENCES and an ORDERING in one branch, and
 * an absence is exactly what a behavioural test stops seeing the moment someone
 * reintroduces the thing somewhere else.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Comments explain, at length, the very suppressions this rule removes — so a
 * naive scan would match the prose instead of the code. Strip them first; that
 * is the single most common false pass in this repo. Files here are CRLF.
 */
function code(rel: string): string {
  return readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//'))
    .join('\n');
}

const BOOT = code(join('backup', 'backupBoot.ts'));

describe('backup setup is mandatory for organisation accounts', () => {
  /**
   * The flag is PASSED IN, not derived here.
   *
   * The first version imported the auth and entitlements stores directly, which
   * dragged React Native into this module and stopped the node test project
   * parsing `backupBootRestoreResume.test.ts` — a suite that imports
   * backupBoot. The total silently dropped from 96 to 93 while every remaining
   * test still passed, which is exactly how a broken suite reads as clean.
   */
  it('takes the org flag as an OPTION and imports no app store', () => {
    expect(BOOT).toMatch(/isOrgAccount\?:\s+boolean;/);
    expect(BOOT).toMatch(/const orgAccount = opts\.isOrgAccount === true;/);
    // Importing either store here re-breaks the node project.
    expect(BOOT).not.toMatch(/from '@store\/authStore'/);
    expect(BOOT).not.toMatch(/from '@store\/entitlements'/);
    // …and it is not re-derived from raw user fields either.
    expect(BOOT).not.toMatch(/account_kind === 'agency'/);
    expect(BOOT).not.toMatch(/membership_status === 'active'/);
  });

  /**
   * …and the CALLER derives it from the one shared rule, so this can never
   * become a second, drifting copy of "is this user in an organisation?".
   */
  it('the caller derives it from the ONE shared entitlements rule', () => {
    const nav = readFileSync(
      join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/).filter(l => !l.trim().startsWith('//')).join('\n');
    // The symbol must be IMPORTED, not just referenced. The first attempt
    // inserted the call and then guarded the import on "is the name already in
    // the file?" — which the call itself had just made true. MainNavigator
    // shipped a reference to an undefined symbol; only this assertion sees it.
    expect(nav).toMatch(/import \{deriveEntitlements\} from '@store\/entitlements';/);
    // `[^)]*` cannot span `useAuthStore.getState()` — a nested call in the
    // argument silently made the old form unmatchable.
    expect(nav).toMatch(/deriveEntitlements\([\s\S]{0,80}?\.isOrgAffiliated/);
    expect(nav).toMatch(/runBackupBoot\([\s\S]{0,160}isOrgAccount/);
  });

  /**
   * A one-tap "not now" otherwise persists for the life of the account. An
   * employee who dismisses it on day one silently has no recovery, ever.
   */
  it('a previous SKIP no longer suppresses the prompt for an org account', () => {
    expect(BOOT).toMatch(/!orgAccount && skippedSource !== null/);
    // The old form suppressed on skip for EVERYONE — it must not come back.
    expect(BOOT).not.toMatch(/skippedSource !== null \|\| enabledSource === 'owner'/);
  });

  /**
   * A newly approved member has zero conversations at boot. That is precisely
   * when setup should happen — before there is any history to lose.
   */
  it('having no chats yet no longer suppresses it for an org account', () => {
    expect(BOOT).toMatch(/convCount === 0 && !orgAccount/);
    expect(BOOT).not.toMatch(/if \(convCount === 0\) \{/);
  });

  /**
   * Already-configured users must still short-circuit, or every boot would
   * shove them back into setup.
   */
  it('still passes through when this owner has ALREADY enabled backup', () => {
    expect(BOOT).toMatch(/enabledSource === 'owner' \|\|/);
  });

  /**
   * THE SECURITY LINE. Encrypted backup needs a secret only the user holds:
   * enabling it for them would either be unrecoverable or not end-to-end
   * encrypted. Making the SETUP unavoidable is the strongest honest option —
   * silently minting a key or shipping plaintext is not.
   */
  it('does NOT silently enable backup or weaken the encryption', () => {
    const branch = BOOT.slice(BOOT.indexOf('const orgAccount'));
    const suggest = branch.slice(0, branch.indexOf('return;'));
    expect(suggest).not.toMatch(/writeBackupEnabled|setBackupEnabled/);
    expect(suggest).not.toMatch(/plaintext|unencrypted/i);
    // It routes to the setup screen — the user still supplies the secret.
    expect(BOOT).toMatch(/BackupSetup/);
  });
});
