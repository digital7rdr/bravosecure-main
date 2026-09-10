#!/usr/bin/env node
// Update .tsc-baseline.json with the *current* tsc error count.
//
// Use after fixing some pre-existing errors so the pre-push ratchet
// locks in your improvement and won't let future pushes regress past
// the new lower bound.
//
// Refuses to RAISE the baseline — that would defeat the ratchet.
// (To raise it intentionally, edit .tsc-baseline.json by hand.)

import {execSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';

console.log('Running tsc to count current errors…');
let actual = 0;
try {
  const out = execSync('npx tsc --noEmit', {encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe']});
  actual = (out.match(/error TS/g) || []).length;
} catch (e) {
  // tsc exits non-zero when errors exist — that's fine, count from stdout.
  const out = (e.stdout || '') + (e.stderr || '');
  actual = (out.match(/error TS/g) || []).length;
}

const baselinePath = '.tsc-baseline.json';
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const previous = baseline.errorCount;

if (actual > previous) {
  console.error(`Refusing to raise baseline ${previous} → ${actual}.`);
  console.error('The ratchet is down-only. Fix the new errors first, or edit .tsc-baseline.json manually if intentional.');
  process.exit(1);
}

baseline.errorCount = actual;
baseline.lastUpdated = new Date().toISOString().slice(0, 10);
writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + '\n');

if (actual === previous) {
  console.log(`Baseline unchanged at ${actual} errors.`);
} else {
  const delta = previous - actual;
  console.log(`Baseline lowered ${previous} → ${actual} (-${delta} 🎉)`);
}
