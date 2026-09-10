/**
 * AUDIT-2026-08-13 #7/#8 — the dead-fork mirror lock.
 *
 * src/modules/messenger/crypto/* once carried drifted FORKS of
 * @bravo/messenger-core (sealedSender had 494 diff lines; groupCrypto was
 * pure dead code) with ZERO production importers — yet security-looking
 * suites imported them directly, so a "fix" applied to a fork went green
 * while production kept the bug (the P0-G1/B-124 drift class). The transport
 * trio (client/usersClient/protocol) was the same corpse one directory over,
 * with the SERVER's protocol header telling maintainers to mirror wire
 * changes into it.
 *
 * Every one of those files is now a tombstone: nothing but comments and a
 * re-export of the real implementation. This scan keeps them that way — ANY
 * executable code (class/function/const/let/interface/enum, or an import of
 * an implementation dependency) reappearing in a locked file is a fork being
 * reborn and fails here by name.
 *
 * House scan rules: these files may be CRLF (split /\r?\n/ or pass
 * vacuously); comment SPANS are removed by a stateful per-line stripper
 * (tracking block state across lines — the regex stripper eats real code
 * when a string contains comment markers); each surviving line is
 * whitespace-collapsed and must EXACT-MATCH the allow-list, so injected
 * code either survives as a non-allowed line or leaves non-empty residue —
 * a multi-line declaration yields several non-allowed lines, failing louder,
 * not quieter.
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const MODULE_ROOT = join(__dirname, '..');

/** file → the exact export lines permitted (whitespace-collapsed). */
const LOCKED: Record<string, string[]> = {
  'crypto/sealedSender.ts':    ["export * from '@bravo/messenger-core';"],
  'crypto/identity.ts':        ["export * from '@bravo/messenger-core';"],
  'crypto/senderCert.ts':      ["export * from '@bravo/messenger-core';"],
  'crypto/groupCrypto.ts':     ["export * from '@bravo/messenger-core';"],
  'crypto/outerEcies.ts':      ["export * from '@bravo/messenger-core';"],
  'crypto/sessionManager.ts':  ["export * from '@bravo/messenger-core';"],
  'crypto/encoding.ts':        ["export * from '@bravo/messenger-core';"],
  'crypto/errors.ts':          ["export * from '@bravo/messenger-core';"],
  'crypto/types.ts':           ["export * from '@bravo/messenger-core';"],
  'crypto/inMemoryStore.ts':   ["export * from '@bravo/messenger-core';"],
  'transport/client.ts':       ["export * from '@bravo/messenger-core';"],
  'transport/usersClient.ts':  ["export * from '@bravo/messenger-core';"],
  'transport/protocol.ts':     ["export * from '@bravo/messenger-core';"],
  'transport/index.ts': [
    "export {KeysHttpClient, KeysHttpError, type KeysHttpClientOptions} from './keysClient';",
    "export {enqueueAck, flushAckQueue, disposeAckQueue} from './ackQueue';",
  ],
};

/**
 * STATEFUL comment stripper — both reviewers proved the naive line-prefix
 * filter had bypasses (`/* x *\/ export evil()`, `*\/ export evil()`: real
 * code sharing a line with block-comment syntax was dropped wholesale).
 * Tracks in-block state across lines and removes only the comment SPANS;
 * whatever text survives is code and must exact-match the allow-list.
 * Safe here because tombstones contain no string literals holding comment
 * markers — any such line would fail the allow-list anyway.
 */
function codeLines(path: string): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    let rest = raw;
    let code = '';
    while (rest.length > 0) {
      if (inBlock) {
        const close = rest.indexOf('*/');
        if (close === -1) {rest = ''; break;}
        rest = rest.slice(close + 2);
        inBlock = false;
      } else {
        const open = rest.indexOf('/*');
        const line = rest.indexOf('//');
        if (line !== -1 && (open === -1 || line < open)) {
          code += rest.slice(0, line);
          rest = '';
        } else if (open !== -1) {
          code += rest.slice(0, open);
          rest = rest.slice(open + 2);
          inBlock = true;
        } else {
          code += rest;
          rest = '';
        }
      }
    }
    const t = code.replace(/\s+/g, ' ').trim();
    if (t !== '') {out.push(t);}
  }
  return out;
}

describe('AUDIT #7/#8 — dead-fork tombstones stay tombstones', () => {
  it('covers all 14 locked files (anti-vacuous guard)', () => {
    expect(Object.keys(LOCKED)).toHaveLength(14);
    for (const rel of Object.keys(LOCKED)) {
      // readFileSync throws on a missing file — a locked file being DELETED
      // outright is fine only if it also leaves this list in the same commit.
      expect(codeLines(join(MODULE_ROOT, rel)).length).toBeGreaterThan(0);
    }
  });

  it('every locked file contains ONLY its permitted export lines — no code may live there', () => {
    const violations: string[] = [];
    for (const [rel, allowed] of Object.entries(LOCKED)) {
      const lines = codeLines(join(MODULE_ROOT, rel));
      for (const line of lines) {
        if (!allowed.includes(line)) {violations.push(`${rel}: ${line.slice(0, 100)}`);}
      }
      for (const a of allowed) {
        if (!lines.includes(a)) {violations.push(`${rel}: MISSING permitted line ${a.slice(0, 60)}`);}
      }
    }
    expect(violations).toEqual([]);
  });

  // The B-152 absence scan (transportSingleSource.test.ts) and this suite
  // deliberately split ONE family of invariants two ways: B-152's trio
  // (relayClient/senderCertClient/certCache) must be ABSENT; the audit-#8
  // trio (client/usersClient/protocol) must be TOMBSTONES — absence was the
  // goal but file deletion is gated in this environment, and a tombstone
  // under this lock is enforcement-equivalent. If those files are ever truly
  // deleted, move them to transportSingleSource's it.each list and drop them
  // from LOCKED in the same commit.

  const REPO_ROOT = join(__dirname, '..', '..', '..', '..');
  /** Every file whose header once directed maintainers to mirror into a
   *  corpse (the #8 defect shape): the live mirror must be named, and the
   *  dead path may appear only in tombstone-context explanation lines. */
  /** deadCount pins the EXACT number of full dead-path mentions allowed
   *  (the known tombstone-context explanation, or zero) — a ±window search
   *  alone was defeated because an injected mention could sit within range
   *  of the file's LEGITIMATE marker (critic M2/M4, reproduced). Any new
   *  mention changes the count and fails, marker or not. */
  const MIRROR_HEADERS: Array<{file: string; live: string; dead: string; deadCount: number}> = [
    {file: 'apps/messenger-service/src/gateway/protocol.ts',   live: 'packages/messenger-core/src/transport/protocol.ts', dead: 'src/modules/messenger/transport/protocol.ts', deadCount: 1},
    {file: 'apps/ops-console/src/lib/messenger/transport.ts',  live: 'packages/messenger-core/src/transport/client.ts',   dead: 'src/modules/messenger/transport/client.ts',   deadCount: 0},
    {file: 'apps/ops-console/src/lib/messenger/types.ts',      live: 'packages/messenger-core/src/crypto/types.ts',       dead: 'src/modules/messenger/crypto/types.ts',       deadCount: 0},
    {file: 'apps/ops-console/src/lib/messenger/encoding.ts',   live: 'packages/messenger-core/src/crypto/encoding.ts',    dead: 'src/modules/messenger/crypto/encoding.ts',    deadCount: 0},
  ];

  it('the stryker crypto gate reaches the primitives (mutate glob + test roots + resolver mapper)', () => {
    // AUDIT #7 — twice this gate silently died: rev-1 moved every primitive
    // out of its mutate glob (edge catch), rev-2's glob fix was a no-op
    // because enableFindRelatedTests resolves via jest-resolve, which had no
    // @bravo mapper (critic catch, measured 0 related tests vs 152+). No
    // other gate references this config, so pin the three load-bearing
    // pieces. Runtime-behavior proof lives in the review record (replica
    // --findRelatedTests --listTests: 267/242 killers for sealedSender/
    // sessionManager).
    const cfg = readFileSync(join(REPO_ROOT, 'stryker.crypto.config.mjs'), 'utf8').replace(/\s+/g, ' ');
    expect(cfg).toContain("'packages/messenger-core/src/crypto/**/*.ts'");           // mutate reaches core
    expect(cfg).toContain('packages/messenger-core/__tests__/**/*.test.ts');         // core killers in testMatch
    expect(cfg).toContain("'^@bravo/messenger-core$'");                              // jest-resolve alias
    expect(cfg).toContain("'^expo/virtual/env$'");                                   // B-153 stub (dry-run survives)
  });

  it('no mirror header directs maintainers into a corpse (server + all three ops-console mirrors)', () => {
    // Critic rev-2 catches, both closed here:
    //  - a JSDoc-WRAPPED dead path (the 80-column default!) evaded per-line
    //    matching → FLATTEN comment continuations before scanning;
    //  - the prose whitelist ("orphaned", "old pointer") collided with the
    //    audit's own vocabulary → require the MACHINE MARKER 'AUDIT-2026-08-13'
    //    within a bounded window of every dead-path occurrence instead.
    expect(MIRROR_HEADERS).toHaveLength(4); // anti-vacuous (edge M6)
    const violations: string[] = [];
    for (const {file, live, dead, deadCount} of MIRROR_HEADERS) {
      const raw = readFileSync(join(REPO_ROOT, file), 'utf8');
      // Flatten: newline + optional JSDoc continuation (' * ') → single space,
      // then collapse whitespace around '/' — paths contain no spaces, so a
      // path WRAPPED at a segment boundary ("…messenger/\n * transport/…")
      // reassembles for matching (a space-join alone cannot rejoin it).
      const flat = raw.replace(/\r?\n[ \t]*\*?[ \t]*/g, ' ').replace(/\/\s+/g, '/').replace(/\s+\//g, '/');
      if (!flat.includes(live)) {violations.push(`${file}: live mirror ${live} not named`);}
      const occurrences: number[] = [];
      let idx = flat.indexOf(dead);
      while (idx !== -1) {occurrences.push(idx); idx = flat.indexOf(dead, idx + 1);}
      if (occurrences.length !== deadCount) {
        violations.push(`${file}: ${occurrences.length} dead-path mention(s), pinned ${deadCount} — a NEW mirror-into-the-corpse instruction (or a lost tombstone note)`);
      }
      for (const o of occurrences) {
        // Each PERMITTED mention must sit in explicit tombstone context: the
        // machine marker within the PRECEDING 150 chars (prose can't collide).
        if (!flat.slice(Math.max(0, o - 150), o).includes('AUDIT-2026-08-13')) {
          violations.push(`${file}: dead-path mention without a preceding AUDIT-2026-08-13 marker: …${flat.slice(o, o + 80)}…`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
