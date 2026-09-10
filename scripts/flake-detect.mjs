#!/usr/bin/env node
// Run jest N times for a project, record which tests fail in any run.
// A test that fails in some runs but passes in others = flaky.
//
// Usage: node scripts/flake-detect.mjs <jest-project-name>

import {execSync} from 'node:child_process';
import {writeFileSync, existsSync, readFileSync, mkdirSync} from 'node:fs';

const project = process.argv[2];
if (!project) {
  console.error('usage: flake-detect.mjs <project>');
  process.exit(2);
}

const RUNS = 5;
const tally = new Map(); // testFullName -> {pass, fail}

for (let i = 1; i <= RUNS; i++) {
  console.log(`── Run ${i}/${RUNS} for ${project} ──`);
  const outFile = `.flake-tmp-${project}-${i}.json`;
  try {
    execSync(
      `npx jest --selectProjects ${project} --ci --json --outputFile=${outFile}`,
      {stdio: 'inherit'},
    );
  } catch {
    // jest exits non-zero on test failure — that's fine, results still in JSON
  }
  if (!existsSync(outFile)) continue;

  const result = JSON.parse(readFileSync(outFile, 'utf8'));
  for (const tr of result.testResults || []) {
    for (const ar of tr.assertionResults || []) {
      const key = `${tr.name} > ${ar.fullName || ar.title}`;
      if (!tally.has(key)) tally.set(key, {pass: 0, fail: 0});
      const t = tally.get(key);
      if (ar.status === 'passed') t.pass++;
      else if (ar.status === 'failed') t.fail++;
    }
  }
}

const flaky = [];
for (const [name, t] of tally) {
  if (t.pass > 0 && t.fail > 0) {
    flaky.push({name, pass: t.pass, fail: t.fail, flakeRate: t.fail / (t.pass + t.fail)});
  }
}
flaky.sort((a, b) => b.flakeRate - a.flakeRate);

const report = {
  project,
  runs: RUNS,
  totalTests: tally.size,
  flaky,
  generatedAt: new Date().toISOString(),
};

writeFileSync(`flake-report-${project}.json`, JSON.stringify(report, null, 2));
console.log(`Flaky tests in ${project}: ${flaky.length}`);
for (const f of flaky.slice(0, 10)) {
  console.log(`  ${(f.flakeRate * 100).toFixed(0)}% flake — ${f.name}`);
}
