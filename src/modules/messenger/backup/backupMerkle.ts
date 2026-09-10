/**
 * Round 5 / Security S8 — Merkle root over the messages_backup rows.
 *
 * Threat model:
 *
 *   The server stores the encrypted-message backup rows. The data is
 *   opaque to the server (ciphertext + per-row subkey wraps), but the
 *   server can still REORDER, OMIT, or ROLL BACK rows. After a clean
 *   restore the user can't tell whether the rows they got back are
 *   the most recent committed state or a stale snapshot the server
 *   chose to serve. WhatsApp's encrypted backup has the same gap.
 *
 *   This module mitigates by:
 *     1. Computing a deterministic Merkle root over each committed
 *        row's `(message_id, msg_created_at, sha256(ciphertext))`.
 *     2. Signing the root + a monotonically increasing sequence
 *        number + a timestamp with the user's identity priv key.
 *     3. Uploading to the server. Server stores opaquely — it can't
 *        forge a new signed root without the priv key, and it can't
 *        substitute a fake one because the signature wouldn't verify.
 *     4. On restore, recompute the root from the returned rows, pull
 *        the stored signature, verify against the user's identity
 *        pub key (recovered from the unwrapped backup bundle), and
 *        REFUSE the restore if they diverge.
 *
 *   A compromised server can still REPLAY a previously-valid root
 *   (full snapshot rollback), which the client detects ONLY if it
 *   has a locally-cached `(seq, signedAt)` from a prior session on
 *   the same device. Fresh-device restore can't catch the rollback
 *   because we have no anchor of trust outside the server. Future
 *   work: external timestamp attestation (e.g. Roughtime) baked
 *   into the signature so an old root has a verifiably old timestamp.
 */
import {sha256} from '@noble/hashes/sha2.js';

/**
 * Domain separator for the canonical bytes that get hashed into a
 * leaf. Without a unique tag, an attacker who controls a different
 * surface (e.g. a future feature that hashes message ids) could
 * substitute one of those hashes as a fake Merkle leaf.
 */
const LEAF_TAG = 'BRAVO_BACKUP_MERKLE_LEAF_V1';
const NODE_TAG = 'BRAVO_BACKUP_MERKLE_NODE_V1';

export interface MerkleRow {
  message_id:     string;
  msg_created_at: string;
  ciphertext:     string;   // base64
}

/**
 * M-12 — a pre-hashed leaf: the 32-byte digest + the sort key. Lets the
 * restore path compute leaves incrementally per page and keep only 32
 * bytes/row instead of the full ciphertext of the entire backup in
 * memory.
 */
export interface MerkleLeaf {
  message_id:     string;
  msg_created_at: string;
  leaf:           Uint8Array;   // 32-byte sha256 (from leafHash)
}

/** Compute a single leaf (+ retain its sort key). */
export function computeLeaf(row: MerkleRow): MerkleLeaf {
  return {message_id: row.message_id, msg_created_at: row.msg_created_at, leaf: leafHash(row)};
}

/**
 * Compute the deterministic Merkle root over a list of rows. The
 * algorithm:
 *
 *   leaf_i  = sha256("BRAVO_BACKUP_MERKLE_LEAF_V1\n" || row_i_canonical)
 *   node    = sha256("BRAVO_BACKUP_MERKLE_NODE_V1\n" || left || right)
 *   root    = repeated pair-wise reduction (odd levels duplicate the last).
 *
 * Rows are sorted by `(msg_created_at, message_id)` before hashing —
 * matches the order /backup/messages returns and produces a
 * deterministic root regardless of insertion order.
 *
 * Returns the 32-byte sha256 root; caller base64-encodes for transport.
 */
export function computeMerkleRoot(rows: MerkleRow[]): Uint8Array {
  // Byte-identical to the previous implementation — now expressed via the
  // shared leaf path so commit + verify + the incremental (M-12) restore
  // path all reduce over the SAME leaves.
  return computeRootFromLeaves(rows.map(computeLeaf));
}

/**
 * B-310 — the WRITE-path root, with breathing room.
 *
 * `computeMerkleRoot` hashes every row's full ciphertext in one synchronous
 * pass. Measured on device at real history size: 1372 rows → the commit owned
 * the JS thread for seconds ([backup.merkle] tookMs=9528 co-timed with a
 * ~4.7 s [LAGDIAG] stall). That block delayed message receives AND widened
 * the flush→commit uncommitted window until kills/second-device restores
 * inside it reproduced the rows_count_mismatch class.
 *
 * This variant hashes leaves in chunks and yields a macrotask between chunks,
 * then reduces through the SAME `computeRootFromLeaves` — the root is
 * byte-identical by construction (identical computeLeaf, identical sort,
 * identical reduction; property-pinned in merkleYieldingRoot.test.ts). The
 * node reduction itself stays synchronous: it works on 32-byte digests and is
 * microseconds even at thousands of leaves.
 *
 * SCOPE: the COMMIT path only. `verifyMerkleCommit` keeps calling the
 * synchronous function untouched — the verifier is never modified (stop
 * condition), and the scan half of the test pins that.
 */
export async function computeMerkleRootYielding(
  rows: MerkleRow[],
  opts?: {chunkSize?: number; onYield?: () => void},
): Promise<Uint8Array> {
  return computeRootFromLeaves(await computeMerkleLeavesYielding(rows, opts));
}

/**
 * B-687 — the leaf-hashing half of `computeMerkleRootYielding`, exported so
 * the commit path can retain the walk's leaves (shadow compare + leaf-cache
 * rewrite) without hashing every row twice. Pure decomposition: the root
 * over these leaves is byte-identical to the pre-split function.
 */
export async function computeMerkleLeavesYielding(
  rows: MerkleRow[],
  opts?: {chunkSize?: number; onYield?: () => void},
): Promise<MerkleLeaf[]> {
  const chunk = Math.max(1, Math.floor(opts?.chunkSize ?? 100));
  const leaves: MerkleLeaf[] = [];
  for (let i = 0; i < rows.length; i += chunk) {
    const end = Math.min(i + chunk, rows.length);
    for (let j = i; j < end; j++) {
      leaves.push(computeLeaf(rows[j]));
    }
    if (end < rows.length) {
      opts?.onYield?.();
      // Macrotask, not a microtask: queued receives/renders must actually run
      // between chunks (a resolved-promise await stays inside the same tick).
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return leaves;
}

/**
 * M-12 — reduce pre-computed leaves to the root. Same sort + node
 * reduction as `computeMerkleRoot`, so a caller that hashes leaves
 * incrementally (keeping only 32 bytes/row) gets the identical root.
 */
export function computeRootFromLeaves(leaves: MerkleLeaf[]): Uint8Array {
  if (leaves.length === 0) {
    // Empty-tree convention: hash of just the leaf tag — distinct from
    // the all-zeros buffer, distinct from any single-leaf tree.
    return sha256(new TextEncoder().encode(LEAF_TAG + '\n<EMPTY>'));
  }

  const sorted = sortMerkleLeaves(leaves);

  let level = sorted.map(l => l.leaf);
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      // Duplicate the last leaf when the level is odd — common Merkle
      // tree convention.
      const right = i + 1 < level.length ? level[i + 1] : level[i];
      next.push(nodeHash(left, right));
    }
    level = next;
  }
  return level[0];
}

/**
 * P2-B-1 — the canonical `(msg_created_at, message_id)` tuple order the
 * tree reduces over. Exported so the verifier can take the sorted
 * PREFIX of a grown leaf set and check whether the committed root is a
 * verifiable subset (additive growth) before allowing a self-heal
 * re-commit.
 */
export function sortMerkleLeaves(leaves: MerkleLeaf[]): MerkleLeaf[] {
  return [...leaves].sort((a, b) => {
    if (a.msg_created_at !== b.msg_created_at) {
      return a.msg_created_at < b.msg_created_at ? -1 : 1;
    }
    return a.message_id < b.message_id ? -1 : (a.message_id > b.message_id ? 1 : 0);
  });
}

function leafHash(row: MerkleRow): Uint8Array {
  // Hash the ciphertext separately so the leaf is constant size
  // regardless of payload length.
  const ctHash = sha256(new TextEncoder().encode(row.ciphertext));
  const canonical = [
    LEAF_TAG,
    row.message_id,
    row.msg_created_at,
  ].join('\n');
  const head = new TextEncoder().encode(canonical + '\n');
  const buf = new Uint8Array(head.byteLength + ctHash.byteLength);
  buf.set(head, 0);
  buf.set(ctHash, head.byteLength);
  return sha256(buf);
}

function nodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  const head = new TextEncoder().encode(NODE_TAG + '\n');
  const buf = new Uint8Array(head.byteLength + left.byteLength + right.byteLength);
  buf.set(head, 0);
  buf.set(left, head.byteLength);
  buf.set(right, head.byteLength + left.byteLength);
  return sha256(buf);
}

/**
 * Round 5 / Security S8 — canonical bytes the user signs to commit a
 * particular Merkle root + (seq, sentAt) to the server. Same shape on
 * both sign + verify paths; a divergence would cause restore to
 * always reject.
 *
 *   sha256(
 *     "BRAVO_BACKUP_MERKLE_COMMIT_V1\n" ||
 *     base64(root) || "\n" ||
 *     rowCount || "\n" ||
 *     seq || "\n" ||
 *     sentAtMs
 *   )
 */
export function canonicalCommitDigest(p: {
  rootB64:  string;
  rowCount: number;
  seq:      number;
  sentAtMs: number;
}): Uint8Array {
  const enc = new TextEncoder();
  const canonical = [
    'BRAVO_BACKUP_MERKLE_COMMIT_V1',
    p.rootB64,
    String(p.rowCount),
    String(p.seq),
    String(p.sentAtMs),
  ].join('\n');
  return sha256(enc.encode(canonical));
}
