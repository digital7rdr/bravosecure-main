/**
 * Round 5 / Security S8 — Merkle root over backup messages.
 *
 * Properties under test:
 *   • root is deterministic across insertion-order changes
 *   • root changes when ANY field of any row changes (full integrity)
 *   • root for an empty set is constant + distinct from any non-empty
 *   • leaf collision-resistance: two rows that differ only by message_id
 *     produce different roots
 *   • computeMerkleRoot tolerates odd row counts (last leaf duplicated)
 *   • canonicalCommitDigest depends on every field
 */
import {computeMerkleRoot, canonicalCommitDigest, type MerkleRow} from '../backup/backupMerkle';

function row(i: number, base = '2026-05-01T00:00:00Z'): MerkleRow {
  return {
    message_id:     `msg-${i.toString().padStart(4, '0')}`,
    msg_created_at: base,
    ciphertext:     Buffer.from(`payload-${i}`).toString('base64'),
  };
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {return false;}
  for (let i = 0; i < a.length; i++) {if (a[i] !== b[i]) {return false;}}
  return true;
}

describe('backup Merkle root (Round 5 / S8)', () => {
  it('root is deterministic under insertion-order changes (rows are sorted)', () => {
    const rs = [row(1), row(3), row(2)];
    const r1 = computeMerkleRoot(rs);
    const r2 = computeMerkleRoot([rs[2], rs[0], rs[1]]);
    expect(eqBytes(r1, r2)).toBe(true);
  });

  it('root differs when ANY message_id changes', () => {
    const rs = [row(1), row(2), row(3)];
    const r1 = computeMerkleRoot(rs);
    const tampered = [...rs];
    tampered[1] = {...rs[1], message_id: 'msg-9999'};
    const r2 = computeMerkleRoot(tampered);
    expect(eqBytes(r1, r2)).toBe(false);
  });

  it('root differs when a single ciphertext byte changes', () => {
    const rs = [row(1), row(2), row(3)];
    const r1 = computeMerkleRoot(rs);
    const ct = Buffer.from(rs[1].ciphertext, 'base64');
    ct[0] ^= 1;
    const tampered = [...rs];
    tampered[1] = {...rs[1], ciphertext: ct.toString('base64')};
    const r2 = computeMerkleRoot(tampered);
    expect(eqBytes(r1, r2)).toBe(false);
  });

  it('empty set has a constant, distinct root', () => {
    const e1 = computeMerkleRoot([]);
    const e2 = computeMerkleRoot([]);
    expect(eqBytes(e1, e2)).toBe(true);
    const r1 = computeMerkleRoot([row(1)]);
    expect(eqBytes(e1, r1)).toBe(false);
  });

  it('odd row count works (last leaf duplicated by convention)', () => {
    // 5 rows ⇒ the tree has uneven leaves. Just exercising the path
    // here — the root is whatever sha256(...) returns; we just want
    // it to NOT throw and to differ from a 4-row tree.
    const r5 = computeMerkleRoot([row(1), row(2), row(3), row(4), row(5)]);
    const r4 = computeMerkleRoot([row(1), row(2), row(3), row(4)]);
    expect(r5.length).toBe(32);
    expect(r4.length).toBe(32);
    expect(eqBytes(r5, r4)).toBe(false);
  });

  it('canonicalCommitDigest depends on every field', () => {
    const base = {rootB64: 'AAAA', rowCount: 10, seq: 1, sentAtMs: 1_700_000_000_000};
    const d0 = canonicalCommitDigest(base);
    const d1 = canonicalCommitDigest({...base, rootB64: 'BBBB'});
    const d2 = canonicalCommitDigest({...base, rowCount: 11});
    const d3 = canonicalCommitDigest({...base, seq: 2});
    const d4 = canonicalCommitDigest({...base, sentAtMs: 1_700_000_001_000});
    expect(eqBytes(d0, d1)).toBe(false);
    expect(eqBytes(d0, d2)).toBe(false);
    expect(eqBytes(d0, d3)).toBe(false);
    expect(eqBytes(d0, d4)).toBe(false);
  });

  it('rows that differ only by msg_created_at produce different roots', () => {
    // Rollback-detection scenario: server returns the same set of rows
    // but with timestamps shifted to make them look like an older
    // snapshot. The Merkle root MUST detect this since it folds the
    // timestamp into the leaf.
    const r1 = computeMerkleRoot([row(1, '2026-05-01T00:00:00Z')]);
    const r2 = computeMerkleRoot([row(1, '2026-05-02T00:00:00Z')]);
    expect(eqBytes(r1, r2)).toBe(false);
  });
});
