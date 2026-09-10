#!/usr/bin/env node
// Open or update a single GitHub issue tracking flaky tests for a project.
// One issue per project, kept current by editing the body each run.
//
// Usage: node scripts/flake-issue.mjs <project>
// Requires: gh CLI authenticated via GH_TOKEN env var (set in workflow)

import {execSync} from 'node:child_process';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';

const project = process.argv[2];
if (!project) process.exit(0);

const reportFile = `flake-report-${project}.json`;
if (!existsSync(reportFile)) {
  console.log('No flake report — skipping issue update.');
  process.exit(0);
}

const report = JSON.parse(readFileSync(reportFile, 'utf8'));
const title = `Flake watch — ${project}`;

const body = `## Flaky tests detected — \`${project}\`

Auto-updated daily by \`.github/workflows/flake-watch.yml\`.

**Last run:** ${report.generatedAt}
**Runs per test:** ${report.runs}
**Total tests:** ${report.totalTests}
**Flaky count:** ${report.flaky.length}

${
  report.flaky.length === 0
    ? '✅ No flaky tests detected in the last run.'
    : `### Flaky tests (sorted by flake rate)

| Flake rate | Pass | Fail | Test |
|---|---|---|---|
${report.flaky
  .slice(0, 50)
  .map(
    (f) =>
      `| ${(f.flakeRate * 100).toFixed(0)}% | ${f.pass} | ${f.fail} | \`${f.name.replace(/\|/g, '\\|')}\` |`,
  )
  .join('\n')}

**Action items:**
- Tests with >20% flake rate should be quarantined or fixed within a week.
- Tests with 100% fail rate are not flaky — they're broken (separate issue).
`
}

<sub>🤖 This issue is auto-updated. Do not close manually unless the project is removed.</sub>
`;

function sh(cmd) {
  return execSync(cmd, {encoding: 'utf8'}).trim();
}

let existing;
try {
  const list = sh(
    `gh issue list --search "${title} in:title" --state open --json number,title --limit 5`,
  );
  const issues = JSON.parse(list);
  existing = issues.find((i) => i.title === title);
} catch (e) {
  console.error('Failed to list issues:', e.message);
}

const tmpFile = `.flake-issue-body-${project}.md`;
writeFileSync(tmpFile, body);

if (existing) {
  console.log(`Updating issue #${existing.number}`);
  sh(`gh issue edit ${existing.number} --body-file ${tmpFile}`);
} else {
  console.log('Opening new flake issue');
  sh(`gh issue create --title "${title}" --body-file ${tmpFile} --label flake-watch`);
}
