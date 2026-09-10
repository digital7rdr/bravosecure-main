/**
 * LAGDIAG backup probes (2026-07-27) — the instrumentation CLAUDE.md's lag
 * section names as the next step: eight candidates are MEASURED DEAD ENDS,
 * and the one untested lead is the per-send backup work (markDirty → flush →
 * merkle commit) plus the backup page's full-history walk. Founder report:
 * "messenger is laggy, low-end device (Redmi 14C) hangs from the backup page."
 *
 * These pins keep the probes alive and honest:
 *  - console.warn, NOT console.log — transform-remove-console strips log
 *    from release builds, and release is the only build worth measuring;
 *  - markDirty's probe is AGGREGATED (≤1 warn/second) — that function runs
 *    on every receipt/status-flip, and a per-call warn would BE the stall
 *    it is measuring;
 *  - metadata only (durations, counts, queue sizes) — the log-audit posture
 *    forbids anything derived from message content, and these log none.
 *
 * Timing-only guarantee: the merkle probe wraps the SERIALIZED wrapper's
 * returned promise; `commitMerkleRootUnserialized` and `verifyMerkleCommit`
 * are byte-identical in behaviour (BACKUP_LOOP §2 I3 — the verifier is
 * never weakened; nothing here touches it).
 *
 * Comment-stripped source scans (backup modules import RN natives). Files
 * are CRLF; nothing here is `\n`-anchored (a `\n` anchor matches nothing
 * and passes VACUOUSLY) — and the strip matters doubly here because these
 * probes' own comments name the tags.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function code(...rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');
}

const mirror    = () => code('src', 'modules', 'messenger', 'backup', 'messageMirror.ts');
const bootstrap = () => code('src', 'modules', 'messenger', 'backup', 'mirrorBootstrap.ts');
const merkle    = () => code('src', 'modules', 'messenger', 'backup', 'merkleCommit.ts');

describe('LAGDIAG backup probes — present, warn-level, aggregated where hot', () => {
  it('markDirty aggregates through the 1s window accumulator', () => {
    const s = mirror();
    // The hot path calls the accumulator…
    expect(s).toMatch(/lagAccumMarkDirty\(lagNow\(\) - _t0\)/);
    // …and the warn lives ONLY in the accumulator, rate-limited.
    expect(s).toMatch(/console\.warn\(`\[LAGDIAG\] \[backup\.markDirty\]/);
    expect(s).toMatch(/>= 1000/);
  });

  it.each([
    ['backup.flush',    mirror],
    ['backup.drain',    mirror],
    ['backup.bulkWalk', bootstrap],
    ['backup.merkle',   merkle],
  ] as Array<[string, () => string]>)('the %s probe exists as console.warn', (tag, src) => {
    const esc = tag.replace('.', '\\.');
    expect(src()).toMatch(new RegExp(`console\\.warn\\(\`\\[LAGDIAG\\] \\[${esc}\\]`));
  });

  it('probes log durations and counts, never content fields', () => {
    // Cheap posture check: no probe line references msg content/body/sdp.
    for (const src of [mirror(), bootstrap(), merkle()]) {
      for (const line of src.split(/\r?\n/)) {
        if (!line.includes('[LAGDIAG]')) {continue;}
        expect(line).not.toMatch(/content|body|plaintext|sdp/i);
      }
    }
  });

  it('the merkle probe wraps the serialized wrapper — the commit itself is untouched', () => {
    const s = merkle();
    const wrapperAt = s.indexOf('export function commitMerkleRoot(');
    const innerAt   = s.indexOf('async function commitMerkleRootUnserialized(');
    const probeAt   = s.indexOf('[LAGDIAG] [backup.merkle]');
    expect(wrapperAt).toBeGreaterThan(-1);
    expect(innerAt).toBeGreaterThan(wrapperAt);
    expect(probeAt).toBeGreaterThan(wrapperAt);
    expect(probeAt).toBeLessThan(innerAt);
  });
});
