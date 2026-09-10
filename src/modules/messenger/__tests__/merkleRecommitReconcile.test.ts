/**
 * Round 9 / S8 self-heal — `commitMerkleRoot({rows})` must sign over the
 * EXACT rows it's handed (no server re-walk), and a re-commit over the
 * live rows must reconcile a benign `root_mismatch` whose signature was
 * already valid.
 *
 * Real-world trigger (from on-device DIAG): restoreRows == commitRowCount
 * but recomputed root != signed root, signature VALID, seq=1 — i.e. the
 * seq=1 setup commit signed an earlier byte-form of the same rows (a
 * server timestamp / base64 round-trip drifted them since). Re-signing
 * the current rows and re-verifying reconciles without weakening the gate.
 */
import {computeMerkleRoot} from '../backup/backupMerkle';

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => null,
    setItem: async () => undefined,
    removeItem: async () => undefined,
  },
}));

jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  getOrCreateMerkleSeqHmacKey: async () => Buffer.alloc(32, 7).toString('base64'),
}));

// Stateful fake server: putMerkleCommit stores the commit; getMerkleCommit
// serves it back. getMessages is unused on the rows-supplied path but
// stubbed so an accidental re-walk would be observable (it returns []).
jest.mock('../backup/backupClient', () => {
  class BackupError extends Error {
    kind: string;
    constructor(kind: string, msg: string) { super(msg); this.name = 'BackupError'; this.kind = kind; }
  }
  let stored: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string} | null = null;
  return {
    __esModule: true,
    BackupError,
    backupClient: {
      getMessages: jest.fn(async () => ({messages: []})),
      putMerkleCommit: jest.fn(async (c: {rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string}) => {
        stored = c;
        return {ok: true};
      }),
      getMerkleCommit: jest.fn(async () => stored),
      getSessions: async () => null,
    },
  };
});

// Curve: sign → fixed 64-byte sig; verify → false means "NOT invalid"
// (the verifier treats a false return as a valid signature). This lets us
// exercise the ROOT comparison branch with an always-valid signature,
// which is exactly the state that reaches root_mismatch on-device.
jest.mock('@privacyresearch/curve25519-typescript', () => ({
  __esModule: true,
  AsyncCurve25519Wrapper: class {
    async sign(): Promise<ArrayBuffer> { return new Uint8Array(64).buffer; }
    async verify(): Promise<boolean> { return false; }
  },
}));

import {commitMerkleRoot, verifyMerkleCommit} from '../backup/merkleCommit';
import {toB64} from '../backup/backupCrypto';
import type {MerkleRow} from '../backup/backupMerkle';

const ROWS: MerkleRow[] = Array.from({length: 29}, (_, i) => ({
  message_id:     `m${String(i).padStart(4, '0')}`,
  msg_created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  ciphertext:     `ct-${i}`,
}));

const PRIV = new Uint8Array(32).fill(9).buffer;
const PUB  = new Uint8Array(32).fill(3).buffer;
const USER = 'monwamoni@gmail.com';

describe('Merkle re-commit reconciliation (S8 self-heal)', () => {
  it('commitMerkleRoot({rows}) signs over exactly the supplied rows', async () => {
    const res = await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    expect(res).not.toBeNull();
    expect(res!.rowCount).toBe(29);
    // The signed root equals the root computed directly over those rows —
    // proves no server re-walk diluted/changed the set.
    expect(res!.rootB64).toBe(toB64(computeMerkleRoot(ROWS)));
  });

  it('a re-commit over the live rows makes verifyMerkleCommit pass', async () => {
    // Re-commit the current rows (what the restore self-heal does) …
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    // … then verify against those same rows. The fake server now serves
    // the just-stored commit; root matches → ok.
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(verdict.ok).toBe(true);
  });

  it('verify still FAILS root_mismatch when rows differ from the signed set', async () => {
    // Commit over the canonical rows …
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    // … but verify against a row whose ciphertext drifted (the exact
    // same-count/different-root condition seen on-device). Without a
    // re-commit this MUST stay a hard mismatch.
    const drifted = ROWS.map((r, i) => i === 5 ? {...r, ciphertext: r.ciphertext + 'X'} : r);
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: drifted});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('root_mismatch');}
  });
});

// B-45 round 3 — the row-count gate must distinguish direction. FEWER
// fetched rows than signed = omission/rollback (the attack the Merkle
// layer exists for) → hard 'rows_count_mismatch'. MORE fetched rows than
// signed = the mirror kept uploading after the last commit (30s-debounce
// lag, background kill) → distinct 'rows_count_grew' so the restore can
// self-heal by re-signing over the grown set it fetched. Live staging
// evidence 2026-07-05: committed=3 vs server=14 on a healthy account.
describe('B-45 R3 — row-count direction asymmetry', () => {
  it('fetched > committed → rows_count_grew (benign post-commit mirror lag)', async () => {
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS.slice(0, 20)});
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('rows_count_grew');}
  });

  it('fetched < committed → rows_count_mismatch (omission — stays a hard fail)', async () => {
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS.slice(0, 20)});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('rows_count_mismatch');}
  });

  it('re-commit over the grown set reconciles (the restore self-heal path)', async () => {
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS.slice(0, 20)});
    // What recommitAndReverify does on rows_count_grew: re-sign over the
    // exact rows the restore fetched, then re-verify.
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(verdict.ok).toBe(true);
  });
});

// P2-B-1 — two verifier gates the audit found soft:
//   1. `getMerkleCommit` THROWING used to `.catch(() => null)` into the
//      no_commit soft-pass — a server could skip S8 wholesale by erroring
//      the endpoint. It must now surface as a hard 'commit_fetch_failed'.
//   2. `rows_count_grew` used to fire on ANY grown count, letting a
//      server substitute rows AND pad the count, then ride the self-heal
//      re-sign. Growth must now be VERIFIABLY ADDITIVE: the sorted prefix
//      at the committed count must reproduce the signed root; otherwise
//      the hard 'rows_count_mismatch' fires.
describe('P2-B-1 — no_commit hard-fail + additive-growth gate', () => {
  it('getMerkleCommit throwing → commit_fetch_failed (NOT the no_commit soft-pass)', async () => {
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS});
    const {backupClient} = require('../backup/backupClient') as {backupClient: {getMerkleCommit: jest.Mock}};
    backupClient.getMerkleCommit.mockImplementationOnce(async () => {
      throw new Error('HTTP 500');
    });
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('commit_fetch_failed');}
  });

  it('a genuinely-absent commit (clean null) still reports no_commit', async () => {
    const {backupClient} = require('../backup/backupClient') as {backupClient: {getMerkleCommit: jest.Mock}};
    backupClient.getMerkleCommit.mockImplementationOnce(async () => null);
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('no_commit');}
  });

  it('grown set with a SUBSTITUTED committed row → hard rows_count_mismatch (no self-heal)', async () => {
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS.slice(0, 20)});
    // Server serves MORE rows than committed (29 > 20) but also swapped
    // the ciphertext of a row INSIDE the committed prefix — the classic
    // substitute-then-pad. The prefix root no longer matches, so this
    // must NOT unlock the rows_count_grew self-heal.
    const substituted = ROWS.map((r, i) => (i === 5 ? {...r, ciphertext: r.ciphertext + 'TAMPER'} : r));
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: substituted});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('rows_count_mismatch');}
  });

  it('grown set that IS an additive superset still reports rows_count_grew', async () => {
    await commitMerkleRoot({identityPrivKey: PRIV, userId: USER, rows: ROWS.slice(0, 20)});
    const verdict = await verifyMerkleCommit({identityPubKey: PUB, userId: USER, rows: ROWS});
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {expect(verdict.reason).toBe('rows_count_grew');}
  });
});
