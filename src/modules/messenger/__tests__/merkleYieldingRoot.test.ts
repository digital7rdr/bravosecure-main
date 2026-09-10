/**
 * B-310 — the Merkle COMMIT must not own the JS thread for seconds.
 *
 * Measured on the Pixel 6a at real history size (2026-07-27, v1.0.179 probes):
 *
 *   15:56:44.367  [LAGDIAG] JS thread blocked ~4698ms (stall #385, worst 6639ms)
 *   15:56:45.140  [LAGDIAG] [backup.merkle] tookMs=9528 rows=1372 seq=1196
 *
 * The commit hashes every server row's leaf in one synchronous pass. At 1372
 * rows that pass blocks the JS thread for seconds, which (a) delays/queues
 * message receives — the founder's "messages losing/delayed", and (b) widens
 * the flush→commit uncommitted window to ~15 s per burst, so a kill mid-commit
 * or a second device restoring inside the window reproduces the
 * rows_count_mismatch class the BACKUP_LOOP exists to keep dead ("the write
 * side kept manufacturing drift" — this time the manufacturer is commit COST
 * that grew with history until it swallowed the safety margins).
 *
 * The fix is pure scheduling on the WRITE path:
 *  - `computeMerkleRootYielding` hashes leaves in chunks and yields a
 *    macrotask between chunks — the thread breathes, receives interleave;
 *  - the commit's server-page walk yields between pages.
 *
 * NOTHING about the trust model moves: same computeLeaf, same sort, same
 * reduction ⇒ byte-identical root (pinned by property tests below), same
 * commit timing/flags, and — the stop condition — `verifyMerkleCommit` keeps
 * using the SYNCHRONOUS path untouched (pinned by the source scan).
 */
import {
  computeMerkleRoot,
  computeMerkleRootYielding,
  type MerkleRow,
} from '../backup/backupMerkle';

function row(i: number, seed = ''): MerkleRow {
  return {
    message_id:      `msg-${seed}${i}`,
    ciphertext:      Buffer.from(`ct-${seed}${i}-${'x'.repeat(64 + (i % 200))}`).toString('base64'),
    msg_created_at:  new Date(1700000000000 + i * 1000).toISOString(),
  } as unknown as MerkleRow;
}

describe('B-310 — computeMerkleRootYielding', () => {
  it.each([0, 1, 2, 3, 7, 100, 257])('is root-identical to the sync path at %d rows', async n => {
    const rows = Array.from({length: n}, (_, i) => row(i));
    const sync = Buffer.from(computeMerkleRoot(rows)).toString('base64');
    const yielded = Buffer.from(await computeMerkleRootYielding(rows, {chunkSize: 10})).toString('base64');
    expect(yielded).toBe(sync);
  });

  it('is order-independent exactly like the sync path (sortMerkleLeaves inside)', async () => {
    const rows = Array.from({length: 50}, (_, i) => row(i));
    const shuffled = [...rows].reverse();
    const a = Buffer.from(await computeMerkleRootYielding(rows, {chunkSize: 8})).toString('base64');
    const b = Buffer.from(await computeMerkleRootYielding(shuffled, {chunkSize: 8})).toString('base64');
    expect(a).toBe(b);
  });

  it('actually yields between chunks', async () => {
    const rows = Array.from({length: 95}, (_, i) => row(i));
    let yields = 0;
    await computeMerkleRootYielding(rows, {chunkSize: 10, onYield: () => { yields += 1; }});
    // 95 rows / 10 per chunk → at least 9 breathing points.
    expect(yields).toBeGreaterThanOrEqual(9);
  });

  it('a zero/negative chunkSize cannot infinite-loop or skip rows', async () => {
    const rows = Array.from({length: 5}, (_, i) => row(i));
    const sync = Buffer.from(computeMerkleRoot(rows)).toString('base64');
    for (const bad of [0, -1]) {
      const out = Buffer.from(await computeMerkleRootYielding(rows, {chunkSize: bad})).toString('base64');
      expect(out).toBe(sync);
    }
  });
});

describe('B-310 — placement: write path yields, the VERIFIER does not change', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'backup', 'merkleCommit.ts'), 'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\r\n]*/g, '');

  it('the commit walk hashes through the yielding variant', () => {
    const commitAt = src.indexOf('async function commitMerkleRootUnserialized');
    const verifyAt = src.indexOf('export async function verifyMerkleCommit');
    expect(commitAt).toBeGreaterThan(-1);
    expect(verifyAt).toBeGreaterThan(commitAt);
    const commitBody = src.slice(commitAt, verifyAt);
    // B-687 re-point (invariant unchanged): the walk hashes leaves through
    // the yielding decomposition, then reduces — never the one-shot
    // synchronous computeMerkleRoot this bug shipped as.
    expect(commitBody).toMatch(/await computeMerkleLeavesYielding\(allRows/);
    expect(commitBody).toMatch(/computeRootFromLeaves\(walkLeaves\)/);
    // The blocking call this bug shipped as must be gone from the commit body.
    expect(commitBody).not.toMatch(/[^.\w]computeMerkleRoot\(allRows\)/);
  });

  it('STOP CONDITION — verifyMerkleCommit still uses the synchronous path, untouched', () => {
    const verifyAt = src.indexOf('export async function verifyMerkleCommit');
    const verifyBody = src.slice(verifyAt, verifyAt + 4000);
    expect(verifyBody).toMatch(/computeMerkleRoot\(p\.rows\)/);
    expect(verifyBody).not.toMatch(/computeMerkleRootYielding/);
    expect(verifyBody).not.toMatch(/computeMerkleLeavesYielding/);
  });
});
