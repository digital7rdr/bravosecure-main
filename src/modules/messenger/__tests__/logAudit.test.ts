import {readdirSync, readFileSync, statSync} from 'node:fs';
import {join, extname} from 'node:path';

/**
 * Log-audit — DoD #8 closer.
 *
 * Every `.log(...)`, `.warn(...)`, `.error(...)`, `.debug(...)`, and
 * plain `console.*` call in the messenger client + messenger-service
 * must NOT reference variables that carry plaintext content, keys,
 * or decrypted blobs.
 *
 * The check is conservative by design — it matches a set of BANNED
 * IDENTIFIERS that could plausibly carry secret material. If the
 * test fails, either rename your variable (e.g. `pt` → `ptLen`) or
 * drop the log.
 *
 * Runs as a Jest test so CI fails loudly if regressed.
 */

const BANNED_IDENTIFIER_PATTERNS: ReadonlyArray<RegExp> = [
  // Direct content references
  /\bplaintext\b/,
  /\.content\b/,
  /\bmsg\.body\b/,
  /\bbody\.body\b/,
  /\bsealed\.body\b/,

  // Keys + ciphertext material
  /\bprivKey\b/,
  /\bprivateKey\b/,
  /\bkeyB64\b/,
  /\bivB64\b/,
  /\bmasterKey(?!Id)\b/,  // masterKeyId is fine; masterKey / masterKeyB64 is not
  /\bsignature\b/,
  /\bsenderIdentityKey\b/,

  // Decrypted bytes
  /\bdecrypt(ed)?\b/,
  /\bunsealed\b/,
];

/** Files we DO want to scan — source + specs (but not these audit tests). */
const CLIENT_ROOT = join(process.cwd(), 'src', 'modules', 'messenger');
const SERVER_ROOT = join(process.cwd(), 'apps', 'messenger-service', 'src');
// Why: messenger-core holds the sealed-sender/group crypto and was NOT scanned
// until now, so CLAUDE.md's security section named an enforcement this file did
// not actually provide (it also cited a path that never existed). It is clean
// today, so adding it is a pure ratchet — see MESSAGE_LOOP.md M7 / W2.
const CORE_ROOT = join(process.cwd(), 'packages', 'messenger-core', 'src');
// B-133 — ops-console leaked decrypted group plaintext through a shared
// try/catch, and it survived precisely because this scanner did not look here.
// Widened once the leak was fixed (b75a307) and the remaining hits were
// REWORDED rather than the ban list weakened: they were prose false positives
// ("dropping before decrypt", "signature check unavailable") where the banned
// word was in the message TEXT, never in a logged value.
const OPS_ROOT  = join(process.cwd(), 'apps', 'ops-console', 'src');
const AUTH_ROOT = join(process.cwd(), 'apps', 'auth-service', 'src');
// B-632 — `src/store/authStore.ts` now emits a BACKUP-domain log line
// (`[bravo.backup.signout] queued=… drained|timeout ms=…`), and this scanner did
// not look here, so its green run said nothing about that line. Same shape as
// the B-133 ops-console gap: the leak survived because the scanner's roots did
// not cover the file. Verified clean across all of src/store before adding, so
// this is a pure ratchet — the CORE_ROOT precedent above.
const STORE_ROOT = join(process.cwd(), 'src', 'store');

function* walkTs(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules' || name === 'dist' || name === '__tests__') {continue;}
      yield* walkTs(full);
    } else if (st.isFile()) {
      const ext = extname(name);
      if (ext === '.ts' || ext === '.tsx') {yield full;}
    }
  }
}

interface Offense {
  file: string;
  line: number;
  snippet: string;
  match: string;
}

function findOffensesIn(file: string): Offense[] {
  const src = readFileSync(file, 'utf8');
  const lines = src.split(/\r?\n/);
  const out: Offense[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only inspect lines that look like a logging call.
    const isLogCall = /\b(log|warn|error|debug|info)\s*\(/.test(line)
                   || /\bconsole\.(log|warn|error|debug|info)\s*\(/.test(line);
    if (!isLogCall) {continue;}
    for (const pattern of BANNED_IDENTIFIER_PATTERNS) {
      const m = pattern.exec(line);
      if (m) {
        out.push({file, line: i + 1, snippet: line.trim(), match: m[0]});
      }
    }
  }
  return out;
}

function expectClean(root: string): void {
  const all: Offense[] = [];
  for (const f of walkTs(root)) {
    // Skip the audit test itself — it legitimately mentions banned names.
    if (f.endsWith('logAudit.test.ts')) {continue;}
    all.push(...findOffensesIn(f));
  }
  if (all.length > 0) {
    const report = all.map(o => `  ${o.file}:${o.line}: matched /${o.match}/ in "${o.snippet}"`).join('\n');
    throw new Error(`Found ${all.length} forbidden log reference(s):\n${report}`);
  }
  expect(all).toEqual([]);
}

describe('Log audit — no plaintext content / keys / decrypted blobs in any log call', () => {
  it('messenger client code path has zero offenses', () => {
    expectClean(CLIENT_ROOT);
  });

  it('messenger-service code path has zero offenses', () => {
    expectClean(SERVER_ROOT);
  });

  it('messenger-core code path has zero offenses', () => {
    expectClean(CORE_ROOT);
  });

  it('ops-console code path has zero offenses', () => {
    // This is the root B-133 escaped through: `groupDecrypt` and `JSON.parse`
    // shared one try, so a parse failure put a V8 SyntaxError carrying
    // DECRYPTED GROUP PLAINTEXT into console.warn.
    expectClean(OPS_ROOT);
  });

  it('auth-service code path has zero offenses', () => {
    expectClean(AUTH_ROOT);
  });

  it('app store code path has zero offenses', () => {
    // B-632 widened the scan here: `authStore.signOut` drains the backup mirror
    // and logs the outcome, so a backup-domain log line now lives outside
    // `src/modules/messenger`. Without this root, that line — and any future one
    // in a store — is unguarded.
    expectClean(STORE_ROOT);
  });
});
