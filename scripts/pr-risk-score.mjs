#!/usr/bin/env node
// Graph-powered PR risk + impact analyzer.
//
// Combines:
//   - Diff stats (size, churn, hot-paths, secrets)
//   - Coverage delta (PR vs base)
//   - Code-graph impact analysis (affected nodes, flows, downstream tests)
//
// Inputs:
//   coverage-pr/coverage-summary.json   — coverage on PR branch
//   coverage-base/coverage-summary.json — coverage on base
//   `code-review-graph detect-changes` — graph impact (when available)
//
// Outputs:
//   pr-analysis-comment.md  — sticky PR comment
//   $GITHUB_OUTPUT          — score, level

import {execSync} from 'node:child_process';
import {readFileSync, writeFileSync, existsSync, appendFileSync} from 'node:fs';

const GITHUB_OUTPUT = process.env.GITHUB_OUTPUT;

function sh(cmd) {
  try {
    return execSync(cmd, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024}).trim();
  } catch {
    return '';
  }
}

function readJSON(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

const baseSha = process.env.BASE_SHA || 'origin/main';
const headSha = process.env.HEAD_SHA || 'HEAD';
sh(`git fetch origin main --depth=200`);

// ── 1. Diff stats ──────────────────────────────────────────────────
const numstat = sh(`git diff --numstat ${baseSha}...${headSha}`);
const changedFiles = numstat
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [add, del, file] = line.split('\t');
    return {add: parseInt(add) || 0, del: parseInt(del) || 0, file};
  });

const totalAdded = changedFiles.reduce((s, f) => s + f.add, 0);
const totalDeleted = changedFiles.reduce((s, f) => s + f.del, 0);
const totalFiles = changedFiles.length;

// ── 2. Path classification ─────────────────────────────────────────
const HOT_PATHS = [
  /^src\/modules\/messenger\/crypto\//,
  /^src\/modules\/messenger\/runtime\//,
  /^src\/modules\/messenger\/transport\//,
  /^src\/modules\/messenger\/push\//,
  /^android\//,
  /^ios\//,
];
const SECRET_PATHS = [/\.env/, /credentials/, /\.pem$/, /\.key$/, /keystore/i];
const TEST_FILE = /\.(test|spec)\.[tj]sx?$|__tests__\//;

const hotFiles = changedFiles.filter((f) => HOT_PATHS.some((re) => re.test(f.file)));
const secretFiles = changedFiles.filter((f) => SECRET_PATHS.some((re) => re.test(f.file)));
const testFiles = changedFiles.filter((f) => TEST_FILE.test(f.file));
const prodFiles = changedFiles.filter((f) => !TEST_FILE.test(f.file));

// ── 3. Coverage delta ──────────────────────────────────────────────
const cov = (path) => readJSON(path)?.total ?? null;
const prCov = cov('coverage-pr/coverage-summary.json');
const baseCov = cov('coverage-base/coverage-summary.json');
const pct = (c) => (c ? c.lines.pct : null);
const prLines = pct(prCov);
const baseLines = pct(baseCov);
const covDelta =
  prLines !== null && baseLines !== null ? +(prLines - baseLines).toFixed(2) : null;

// ── 4. Graph-powered impact analysis ───────────────────────────────
let graphImpact = null;
try {
  const out = sh(`code-review-graph detect-changes --base ${baseSha} --brief`);
  if (out) {
    // detect-changes --brief prints a human summary; we capture the raw text.
    // Try richer JSON if available:
    const jsonOut = sh(`code-review-graph detect-changes --base ${baseSha}`);
    graphImpact = {
      brief: out,
      detail: jsonOut.slice(0, 4000), // cap for comment size
    };
  }
} catch {
  graphImpact = null;
}

// ── 5. Score each dimension (0-3) ──────────────────────────────────
const score = {
  size: totalFiles >= 50 ? 3 : totalFiles >= 20 ? 2 : totalFiles >= 5 ? 1 : 0,
  churn:
    totalAdded + totalDeleted >= 2000
      ? 3
      : totalAdded + totalDeleted >= 500
        ? 2
        : totalAdded + totalDeleted >= 100
          ? 1
          : 0,
  hotPaths: hotFiles.length >= 5 ? 3 : hotFiles.length >= 2 ? 2 : hotFiles.length >= 1 ? 1 : 0,
  tests:
    prodFiles.length > 0 && testFiles.length === 0
      ? 3
      : prodFiles.length > testFiles.length * 5
        ? 2
        : prodFiles.length > testFiles.length * 2
          ? 1
          : 0,
  coverage: covDelta === null ? 1 : covDelta <= -2 ? 3 : covDelta < 0 ? 2 : 0,
  secrets: secretFiles.length > 0 ? 3 : 0,
};

const weights = {size: 1, churn: 1, hotPaths: 2, tests: 1.5, coverage: 1.5, secrets: 3};
const maxScore = Object.entries(weights).reduce((s, [, w]) => s + w * 3, 0);
const rawScore = Object.entries(score).reduce((s, [k, v]) => s + v * weights[k], 0);
const finalScore = Math.round((rawScore / maxScore) * 10);
const level = finalScore >= 7 ? 'HIGH' : finalScore >= 4 ? 'MEDIUM' : 'LOW';
const emoji = level === 'HIGH' ? '🔴' : level === 'MEDIUM' ? '🟡' : '🟢';

// ── 6. Build markdown comment ──────────────────────────────────────
const md = `## ${emoji} PR Analysis — Risk: **${level}** (${finalScore}/10)

### Change footprint
| Metric | Value |
|---|---|
| Files changed | ${totalFiles} |
| Lines added | +${totalAdded} |
| Lines deleted | -${totalDeleted} |
| Test files | ${testFiles.length} |
| Prod files | ${prodFiles.length} |

### Coverage
${
  covDelta === null
    ? '_Coverage data not available._'
    : `| | Base | PR | Delta |
|---|---|---|---|
| Lines | ${baseLines}% | ${prLines}% | ${covDelta >= 0 ? '+' : ''}${covDelta}% ${covDelta < 0 ? '⚠️' : '✅'} |`
}

### Risk breakdown
| Dimension | Score | Notes |
|---|---|---|
| Size | ${score.size}/3 | ${totalFiles} files |
| Churn | ${score.churn}/3 | ${totalAdded + totalDeleted} lines |
| Hot paths | ${score.hotPaths}/3 | ${hotFiles.length} hot-path files${hotFiles.length ? ' (' + hotFiles.slice(0, 3).map((f) => '`' + f.file + '`').join(', ') + (hotFiles.length > 3 ? '…' : '') + ')' : ''} |
| Test ratio | ${score.tests}/3 | ${testFiles.length === 0 && prodFiles.length > 0 ? '⚠️ No tests added/modified' : 'OK'} |
| Coverage delta | ${score.coverage}/3 | ${covDelta === null ? 'Unknown' : covDelta < 0 ? 'Coverage dropped' : 'Coverage held'} |
| Secrets/config | ${score.secrets}/3 | ${secretFiles.length > 0 ? '⚠️ Touches: ' + secretFiles.map((f) => '`' + f.file + '`').join(', ') : 'No env/secret files touched'} |

${
  graphImpact
    ? `### 🕸 Code-graph impact analysis
\`\`\`
${graphImpact.brief}
\`\`\`

<details><summary>Full impact detail</summary>

\`\`\`
${graphImpact.detail}
\`\`\`

</details>
`
    : '_Code-graph impact analysis unavailable in this run._'
}

${
  hotFiles.length > 0
    ? `### Hot-path files touched
${hotFiles.map((f) => `- \`${f.file}\` (+${f.add}/-${f.del})`).join('\n')}

These paths handle crypto, transport, runtime, or push. **Recommend extra reviewer attention.**
`
    : ''
}

${
  level === 'HIGH'
    ? `### ⚠️ High-risk PR — recommended actions
- Request review from messenger module owner
- Run E2E smoke before merge: \`npm run e2e:messenger\`
- Verify no regressions in CI matrix
- If touching crypto: verify SQLCipher migration path + run \`npm run mutation:crypto\`
`
    : ''
}

<sub>🤖 Auto-generated by \`scripts/pr-risk-score.mjs\`. Score = weighted sum of size, churn, hot-paths, test ratio, coverage delta, secret-touch + graph impact.</sub>
`;

writeFileSync('pr-analysis-comment.md', md);
console.log(md);

if (GITHUB_OUTPUT) {
  appendFileSync(GITHUB_OUTPUT, `score=${finalScore}\nlevel=${level}\n`);
}
