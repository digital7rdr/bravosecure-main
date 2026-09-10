/**
 * Warm-start FIX-01 — session tokens live in the hardware keychain, and the
 * only module allowed to know where that is, is `@services/tokenVault`.
 *
 * This is a static source scan because the rule it guards is a REPO rule, not a
 * runtime one: nothing fails at runtime when someone adds
 * `AsyncStorage.getItem('auth:access_token')` back into a new push handler —
 * it just quietly re-plaintexts the credential that authorizes the whole app.
 * There were 28 such reads across 13 files before this fix.
 *
 * Scanning rules this file obeys (CLAUDE.md):
 *   - the sources are CRLF, so line-based scanning only — never a \n anchor;
 *   - comments are stripped first, because prose mentioning the banned key is
 *     the single most common false positive in this repo.
 */
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const VAULT = path.join(ROOT, 'services', 'tokenVault.ts');

const BANNED = /['"`]auth:(access|refresh)_token['"`]/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') {continue;}
      sourceFiles(full, acc);
    } else if (/\.tsx?$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Strip block and line comments. Deliberately crude — it only has to stop
 * PROSE from being read as code, and over-stripping a string that merely looks
 * like a comment can only cause a false PASS on that one line, never a false
 * failure of the build.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
    .join('\n');
}

describe('FIX-01 — session tokens are keychain-only', () => {
  it('no module outside tokenVault names the raw token storage keys', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(ROOT)) {
      if (path.resolve(file) === path.resolve(VAULT)) {continue;}
      const stripped = stripComments(fs.readFileSync(file, 'utf8'));
      stripped.split(/\r?\n/).forEach((line, i) => {
        if (BANNED.test(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('tokenVault stores under an AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY keychain entry', () => {
    const src = stripComments(fs.readFileSync(VAULT, 'utf8'));
    // Weaker than AFTER_FIRST_UNLOCK and a locked-phone push wake cannot read
    // the token; migratable (no _THIS_DEVICE_ONLY) and the session follows a
    // device transfer / iCloud restore.
    expect(src).toMatch(/ACCESSIBLE\.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY/);
    expect(src).toMatch(/\bsetGenericPassword\(/);
    expect(src).toMatch(/\bresetGenericPassword\(/);
  });

  it('requires react-native-keychain LAZILY, never at module load', () => {
    const src = stripComments(fs.readFileSync(VAULT, 'utf8'));
    // A static import hard-throws wherever RNKeychainManager is absent — the
    // node jest projects, and any JS context with a partial react-native shim.
    // tokenVault is imported by the headless FCM drain, so an import-time throw
    // there takes out killed-app message delivery.
    expect(src).not.toMatch(/^\s*import .*['"]react-native-keychain['"]/m);
    expect(src).toMatch(/require\(['"]react-native-keychain['"]\)/);
  });

  it('the migration writes and verifies BEFORE deleting the plaintext copy', () => {
    const src = stripComments(fs.readFileSync(VAULT, 'utf8'));
    const write = src.indexOf('await writeKeychain(tokens)');
    const readBack = src.indexOf('const readBack = parse(');
    const remove = src.indexOf('await clearLegacy()');
    expect(write).toBeGreaterThan(-1);
    expect(readBack).toBeGreaterThan(write);
    // Deleting first turns one keystore hiccup into a permanently signed-out
    // user with no recovery path.
    expect(remove).toBeGreaterThan(readBack);
  });

  it('clear() sweeps the legacy plaintext keys too', () => {
    const src = stripComments(fs.readFileSync(VAULT, 'utf8'));
    const clearIdx = src.indexOf('clear: async');
    expect(clearIdx).toBeGreaterThan(-1);
    // A device that never completed the migration must not keep a signed-out
    // user's tokens sitting in plaintext.
    expect(src.slice(clearIdx)).toMatch(/await clearLegacy\(\)/);
    // …and clearLegacy must actually remove BOTH keys.
    expect(src).toMatch(/removeItem\(LEGACY_ACCESS_KEY\)/);
    expect(src).toMatch(/removeItem\(LEGACY_REFRESH_KEY\)/);
  });
});
