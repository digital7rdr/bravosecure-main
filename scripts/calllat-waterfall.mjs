#!/usr/bin/env node
// [CALLLAT] waterfall builder — audit Step 0 (docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md).
//
// Usage:
//   adb -s <serial> logcat -d -v threadtime > run.log
//   node scripts/calllat-waterfall.mjs run.log [more.log ...] > waterfall.md
//
// Reads every `[CALLLAT] lane=<lane> cid=<id> step=<step> t=<ms> dt=<ms> k=v…`
// line (release builds emit them on console.warn), groups by lane+cid into
// per-call waterfalls, and prints (a) every waterfall and (b) a per-lane
// per-step median/max table across the calls found. A logcat timestamp, when
// present at the start of the line, is carried for cross-device correlation.
// Pure node, no dependencies — it must keep working when node_modules is cold.

import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/calllat-waterfall.mjs <logcat.txt> [...]');
  process.exit(2);
}

const LINE = /\[CALLLAT\] lane=(\S+) cid=(\S+) step=(\S+) t=(\d+) dt=(\d+)(.*)$/;
const TS   = /^(\d\d-\d\d \d\d:\d\d:\d\d\.\d+)/;

/** @type {Map<string, {lane:string, cid:string, rows:Array<{step:string,t:number,dt:number,fields:string,ts:string|null,src:string}>}>} */
const calls = new Map();

for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const m = LINE.exec(raw);
    if (!m) continue;
    const [, lane, cid, step, t, dt, rest] = m;
    const key = `${lane}:${cid}`;
    let c = calls.get(key);
    if (!c) { c = {lane, cid, rows: []}; calls.set(key, c); }
    const ts = TS.exec(raw)?.[1] ?? null;
    c.rows.push({step, t: Number(t), dt: Number(dt), fields: rest.trim(), ts, src: f});
  }
}

// Split a lane's rows into per-CALL segments. A lane key (lane+cid) is reused
// across calls on the same group conversation, and a "first sight" row that
// lands within freshAfterMs of a previous call CONTINUES that clock (t keeps
// rising), so "t went back to 0" alone is not enough. A new segment starts on:
//   • t decreasing (the clock was reset or freshly created),
//   • a host `launch`/`boot dir=outgoing` row (always a new call),
//   • a NON-replayed `ring:received` / `offer:received` that follows another
//     origin row of the same kind in this lane (a re-ring / a re-call).
const ORIGIN_KINDS = new Set(['ring:received', 'offer:received']);
function splitSegments(rows) {
  const segs = []; let cur = []; let prevT = -1; const seenOrigins = new Set();
  for (const r of rows) {
    const isOrigin = ORIGIN_KINDS.has(r.step) && !/\breplayed=true\b/.test(r.fields) && !/\breassert=true\b/.test(r.fields);
    const hostStart = r.step === 'launch' || (r.step === 'boot' && /\bdir=outgoing\b/.test(r.fields));
    const repeatOrigin = isOrigin && seenOrigins.has(r.step);
    if (cur.length && (r.t < prevT || hostStart || repeatOrigin)) { segs.push(cur); cur = []; seenOrigins.clear(); }
    if (isOrigin) seenOrigins.add(r.step);
    cur.push(r); prevT = r.t;
  }
  if (cur.length) segs.push(cur);
  return segs;
}
const split = new Map();
for (const [key, c] of calls) {
  splitSegments(c.rows).forEach((rows, i) => split.set(`${key}#${i + 1}`, {lane: c.lane, cid: `${c.cid}#${i + 1}`, rows}));
}
calls.clear();
for (const [k, v] of split) calls.set(k, v);

if (calls.size === 0) {
  console.log('_no [CALLLAT] lines found_');
  process.exit(0);
}

const out = [];
out.push('# [CALLLAT] waterfalls');
out.push('');
out.push(`Sources: ${files.join(', ')} · calls found: ${calls.size}`);
out.push('');

// (a) per-call waterfalls — a `t` that resets to 0 mid-call marks a new boot (reset).
for (const c of [...calls.values()].sort((a, b) => a.lane.localeCompare(b.lane) || a.cid.localeCompare(b.cid))) {
  out.push(`## lane=${c.lane} cid=${c.cid}`);
  out.push('');
  out.push('| # | step | t (ms) | dt (ms) | fields | logcat ts |');
  out.push('|---|------|-------:|--------:|--------|-----------|');
  c.rows.forEach((r, i) => {
    out.push(`| ${i + 1} | ${r.step} | ${r.t} | ${r.dt} | ${r.fields.replace(/\|/g, '\\|')} | ${r.ts ?? ''} |`);
  });
  out.push('');
}

// (b) per-lane per-step medians of `t` (time since lane start) and `dt`.
const median = (xs) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};
/** @type {Map<string, Map<string, {t:number[], dt:number[]}>>} */
const byLane = new Map();
for (const c of calls.values()) {
  let steps = byLane.get(c.lane);
  if (!steps) { steps = new Map(); byLane.set(c.lane, steps); }
  // first occurrence of each step per call (re-asserts and per-producer rows
  // would otherwise skew the median; per-producer detail stays in (a)).
  const seen = new Set();
  for (const r of c.rows) {
    if (seen.has(r.step)) continue;
    seen.add(r.step);
    let acc = steps.get(r.step);
    if (!acc) { acc = {t: [], dt: []}; steps.set(r.step, acc); }
    acc.t.push(r.t); acc.dt.push(r.dt);
  }
}
out.push('# Per-lane step summary (first occurrence per call)');
out.push('');
for (const [lane, steps] of [...byLane.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const n = [...calls.values()].filter(c => c.lane === lane).length;
  out.push(`## lane=${lane} (n=${n} calls)`);
  out.push('');
  out.push('| step | median t | max t | median dt | max dt | n |');
  out.push('|------|---------:|------:|----------:|-------:|--:|');
  const rows = [...steps.entries()].sort((a, b) => median(a[1].t) - median(b[1].t));
  for (const [step, acc] of rows) {
    out.push(`| ${step} | ${median(acc.t)} | ${Math.max(...acc.t)} | ${median(acc.dt)} | ${Math.max(...acc.dt)} | ${acc.t.length} |`);
  }
  out.push('');
}

process.stdout.write(out.join('\n') + '\n');
