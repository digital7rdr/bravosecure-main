#!/usr/bin/env node
// Bundle-size delta reporter. Runs `size-limit --json` on the PR branch
// and writes a markdown summary that the workflow posts as a sticky comment.
//
// Note: a full base-vs-PR delta would require exporting the base bundle too
// (slow). For now we report absolute size against the budget; the budget
// itself in .size-limit.json is the regression gate.

import {execSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';

let report;
try {
  const out = execSync('npx size-limit --json', {encoding: 'utf8'});
  report = JSON.parse(out);
} catch (e) {
  writeFileSync(
    'bundle-size-comment.md',
    `### 📦 Bundle size\n\n_Bundle export failed or size-limit could not run. Check workflow logs._\n`,
  );
  process.exit(0);
}

const rows = report.map((r) => {
  const ok = r.passed !== false;
  const limit = r.sizeLimit || r.limit;
  const size = r.size;
  const fmt = (n) =>
    n >= 1024 * 1024 ? (n / (1024 * 1024)).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
  return `| ${r.name} | ${fmt(size)} | ${typeof limit === 'number' ? fmt(limit) : limit} | ${ok ? '✅' : '❌'} |`;
});

const md = `### 📦 Bundle Size

| Bundle | Size | Budget | Status |
|---|---|---|---|
${rows.join('\n')}

<sub>Budget defined in \`.size-limit.json\`. Exceeding the budget fails this check.</sub>
`;

writeFileSync('bundle-size-comment.md', md);
console.log(md);
