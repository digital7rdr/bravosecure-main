/**
 * sqa.md bug register — this suite pins: B-166, B-170, B-181.
 *
 * BUG-8/BUG-E both markers armed before the first walk = B-166 · BUG-5 unlock hand-off after the walk = B-170 · BUG-S incomplete drain keeps its cursor = B-181.
 * Source of the mapping: docs/audits/BACKUP_AUDIT_2026-07-24.md (§2 table + §5
 * suite map). The cases below carry the audit-internal BUG-x ids; this block is
 * the crosswalk so an sqa.md bug id greps to its regression test.
 */
/**
 * BR-1 — background restore orchestrator (restoreBackground.ts).
 *
 * The runner owns everything after the identity phase: snapshot apply →
 * auto-resumed message walk → sealed-archive drain → mirror hand-off.
 * These tests pin:
 *   • phase order + kill-safety markers armed BEFORE the first walk
 *     (BUG-8 / BUG-E — a kill in any seam re-enters RESTORE-RESUME);
 *   • the P2-B-6 auto-resume loop (no more password-per-20k-rows) with
 *     a stall guard so a non-advancing cursor can't spin forever;
 *   • the B-81 repair-and-retry living in the runner (once per start);
 *   • retry resumes at the first INCOMPLETE phase (a drain blip does
 *     not re-decode the whole verified history);
 *   • stop() is a cooperative cancel — a stale run may not touch state;
 *   • the mirror hand-off: unlock path (mirror disabled at hand-off)
 *     flips the key AFTER the walk (BUG-5 sweep-vs-walk race), the
 *     fresh-install path runs one explicit ledger-seeded sweep.
 */

jest.mock('../backup/restoreMessages', () => {
  class MerkleCommitMismatchError extends Error {
    reason: string;
    constructor(reason: string) {
      super(`backup.merkle_mismatch:${reason}`);
      this.name = 'MerkleCommitMismatchError';
      this.reason = reason;
    }
  }
  return {__esModule: true, MerkleCommitMismatchError, restoreAllMessages: jest.fn()};
});
jest.mock('../backup/restoreResume', () => ({
  __esModule: true,
  markRestoreIncomplete: jest.fn(async () => undefined),
  markArchiveReplayIncomplete: jest.fn(async () => undefined),
}));
jest.mock('../runtime', () => ({
  __esModule: true,
  getOwnCryptoStore: jest.fn(() => ({})),
}));
jest.mock('../runtime/productionRuntime', () => ({
  __esModule: true,
  replayArchivedEnvelope: jest.fn(async () => true),
}));
jest.mock('../backup/archiveReplay', () => ({
  __esModule: true,
  drainSealedArchive: jest.fn(async () => ({replayed: 0, incomplete: false})),
}));
// Keychain returns null → the snapshot phase skips (its own retry loop is
// covered by the transport tests; here we isolate the orchestration).
jest.mock('../runtime/keychain', () => ({
  __esModule: true,
  loadMirrorMasterKey: jest.fn(async () => null),
}));
jest.mock('../backup/mirrorBootstrap', () => ({
  __esModule: true,
  startMirrorBootstrap: jest.fn(),
  backupNow: jest.fn(async () => ({messages: 0, conversations: 0})),
  repairBackupCommit: jest.fn(async () => false),
  commitMerkleRootNow: jest.fn(async () => undefined),
}));
jest.mock('../backup/messageMirror', () => ({
  __esModule: true,
  isMirrorEnabled: jest.fn(() => true),
  setMirrorKey: jest.fn(),
  seedMirrorDedup: jest.fn(),
  drainMirrorOutbox: jest.fn(async () => undefined),
  fireMerkleHookNow: jest.fn(async () => undefined),
  fireMerkleHookNowIfPending: jest.fn(async () => undefined),
}));
jest.mock('../backup/mirrorLedger', () => ({
  __esModule: true,
  loadFlushedVersions: jest.fn(async () => new Map()),
  readMerkleCommitPending: jest.fn(async () => false),
}));
jest.mock('../backup/merkleCommit', () => ({
  __esModule: true,
  commitMerkleRoot: jest.fn(async () => ({rootB64: 'root', seq: 9, rowCount: 1406})),
}));
jest.mock('../backup/backupFlags', () => ({
  __esModule: true,
  setBackupEnabled: jest.fn(async () => undefined),
}));
jest.mock('../backup/sessionRatchetRecovery', () => ({
  __esModule: true,
  getUndecryptableCount: jest.fn(() => 0),
  applyRatchetSnapshot: jest.fn(async () => ({applied: 0, reason: 'no_snapshot'})),
}));

import {
  startBackgroundRestore, stopBackgroundRestore, retryBackgroundRestore,
  getBackgroundRestoreState, isBackgroundRestoreActive, subscribeBackgroundRestore,
} from '../backup/restoreBackground';
import {restoreAllMessages, MerkleCommitMismatchError} from '../backup/restoreMessages';
import {markRestoreIncomplete, markArchiveReplayIncomplete} from '../backup/restoreResume';
import {startMirrorBootstrap, backupNow, repairBackupCommit} from '../backup/mirrorBootstrap';
import {isMirrorEnabled, setMirrorKey, drainMirrorOutbox} from '../backup/messageMirror';
import {setBackupEnabled} from '../backup/backupFlags';
import {drainSealedArchive} from '../backup/archiveReplay';

const walk = restoreAllMessages as jest.Mock;
const drain = drainSealedArchive as jest.Mock;
const repair = repairBackupCommit as jest.Mock;
const mirrorEnabled = isMirrorEnabled as jest.Mock;

const MASTER = {} as CryptoKey;
const PARAMS = {
  masterKey: MASTER,
  ownerUserId: 'owner-uuid',
  ownerKey: 'owner@mail',
  identityPubKey: new Uint8Array(32).buffer,
  identityPrivKey: new Uint8Array(32).buffer,
};

function counts(messages: number, incomplete: boolean): {
  conversations: number; messages: number; skipped: number; incomplete: boolean;
} {
  return {conversations: 2, messages, skipped: 0, incomplete};
}

async function waitFor(pred: () => boolean, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out; state=${JSON.stringify(getBackgroundRestoreState())}`);
    }
    await new Promise(r => setTimeout(r, 10));
  }
}

describe('BR-1 — background restore runner', () => {
  beforeEach(() => {
    stopBackgroundRestore();
    jest.clearAllMocks();
    mirrorEnabled.mockReturnValue(true);
    drain.mockResolvedValue({replayed: 0, incomplete: false});
  });
  afterEach(() => { stopBackgroundRestore(); });

  it('runs walk rounds to completion, then drain + mirror hand-off, and reports summed counts', async () => {
    walk
      .mockResolvedValueOnce(counts(20_000, true))
      .mockResolvedValueOnce(counts(5_000, false));

    expect(startBackgroundRestore(PARAMS)).toBe(true);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');

    const st = getBackgroundRestoreState();
    expect(st).toMatchObject({kind: 'done', messages: 25_000, conversations: 2});
    expect(walk).toHaveBeenCalledTimes(2);
    expect(drain).toHaveBeenCalledTimes(1);
    expect(startMirrorBootstrap).toHaveBeenCalledTimes(1);
    expect(setBackupEnabled).toHaveBeenCalledWith('owner@mail');
    // Fresh-install hand-off (mirror already enabled) — explicit sweep ran.
    expect(backupNow).toHaveBeenCalledWith('owner-uuid');
    expect(drainMirrorOutbox).toHaveBeenCalled();

    // BUG-8/BUG-E kill-safety — BOTH markers armed before the first walk.
    const markOrder = (markRestoreIncomplete as jest.Mock).mock.invocationCallOrder[0];
    const archOrder = (markArchiveReplayIncomplete as jest.Mock).mock.invocationCallOrder[0];
    const walkOrder = walk.mock.invocationCallOrder[0];
    expect(markOrder).toBeLessThan(walkOrder);
    expect(archOrder).toBeLessThan(walkOrder);
  });

  it('unlock hand-off — mirror disabled at hand-off time flips the key AFTER the walk (BUG-5)', async () => {
    mirrorEnabled.mockReturnValue(false);
    walk.mockResolvedValueOnce(counts(10, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');

    expect(setMirrorKey).toHaveBeenCalledWith(MASTER);
    // The key flip happens strictly after the walk finished.
    expect((setMirrorKey as jest.Mock).mock.invocationCallOrder[0])
      .toBeGreaterThan(walk.mock.invocationCallOrder[0]);
    // And the explicit sweep is NOT run (the auto-fired one owns it).
    expect(backupNow).not.toHaveBeenCalled();
  });

  it('stall guard — an incomplete round with zero progress errors out instead of spinning', async () => {
    walk.mockResolvedValue(counts(0, true));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');

    expect(getBackgroundRestoreState().kind).toBe('error');
    // Exactly one stalled round — no infinite loop.
    expect(walk.mock.calls.length).toBeLessThanOrEqual(2);
    expect(setBackupEnabled).not.toHaveBeenCalled();
  });

  it('B-81 — root_mismatch triggers ONE repair-and-retry; a second mismatch is terminal', async () => {
    repair.mockResolvedValue(true);
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('root_mismatch'))
      .mockResolvedValueOnce(counts(7, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(getBackgroundRestoreState()).toMatchObject({kind: 'done', messages: 7});

    // Second run: repair keeps "succeeding" but the mismatch persists —
    // the retry budget is one, so the run must surface the error.
    stopBackgroundRestore();
    walk.mockReset();
    repair.mockClear();
    walk.mockRejectedValue(new MerkleCommitMismatchError('root_mismatch'));
    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(repair).toHaveBeenCalledTimes(1);
    const err = getBackgroundRestoreState() as {kind: 'error'; message: string};
    expect(err.message).toContain('root_mismatch');
  });

  it('B-463 — a REFUSED repair (fresh device) falls through to the equal-count-drift heal', async () => {
    // CONTRACT FLIP (founder-approved 2026-08-16): pre-B-463 a refused
    // repair was terminal — which left a sole-device uninstall inside the
    // flush→commit kill window as a PERMANENT dead-end (1674 intact rows
    // unrestorable on the founder's own account). The refused repair now
    // falls through to the same direct-sign heal B-311/B-312 already run
    // for rows_count_mismatch; the B-81 repair (local-truth re-upload)
    // stays the preferred fix and is still consulted FIRST.
    const {commitMerkleRoot} = jest.requireMock('../backup/merkleCommit') as {commitMerkleRoot: jest.Mock};
    repair.mockResolvedValue(false);
    walk.mockReset();
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('root_mismatch'))
      .mockResolvedValueOnce(counts(9, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
    expect(commitMerkleRoot).toHaveBeenCalledWith({
      identityPrivKey: PARAMS.identityPrivKey,
      userId:          'owner-uuid',
    });
    expect(getBackgroundRestoreState()).toMatchObject({kind: 'done', messages: 9});
  });

  it('re-entrancy — a second start while running is refused', async () => {
    let release!: () => void;
    walk.mockImplementationOnce(() => new Promise(res => {
      release = () => res(counts(1, false));
    }));

    expect(startBackgroundRestore(PARAMS)).toBe(true);
    await waitFor(() => walk.mock.calls.length === 1);
    expect(isBackgroundRestoreActive()).toBe(true);
    expect(startBackgroundRestore(PARAMS)).toBe(false);
    release();
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it('retry resumes at the first incomplete phase — a drain failure never re-decodes the walk', async () => {
    walk.mockResolvedValueOnce(counts(42, false));
    drain.mockRejectedValueOnce(new Error('http_502'));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(walk).toHaveBeenCalledTimes(1);

    drain.mockResolvedValueOnce({replayed: 3, incomplete: false});
    expect(retryBackgroundRestore()).toBe(true);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    // Walk checkpoint held — not called again; counts survive the retry.
    expect(walk).toHaveBeenCalledTimes(1);
    expect(getBackgroundRestoreState()).toMatchObject({kind: 'done', messages: 42});
  });

  it('BUG-S — an incomplete drain keeps draining from the cursor in-session', async () => {
    walk.mockResolvedValueOnce(counts(1, false));
    drain
      .mockResolvedValueOnce({replayed: 500, incomplete: true})
      .mockResolvedValueOnce({replayed: 20, incomplete: false});

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('stop() cancels cooperatively — a stale run may not finish, hand off, or flip state', async () => {
    let release!: () => void;
    walk.mockImplementationOnce(() => new Promise(res => {
      release = () => res(counts(9, false));
    }));

    startBackgroundRestore(PARAMS);
    await waitFor(() => walk.mock.calls.length === 1);
    stopBackgroundRestore();
    expect(getBackgroundRestoreState().kind).toBe('idle');
    release();
    // Give the stale run a beat — it must NOT proceed to later phases.
    await new Promise(r => setTimeout(r, 100));
    expect(getBackgroundRestoreState().kind).toBe('idle');
    expect(drain).not.toHaveBeenCalled();
    expect(setBackupEnabled).not.toHaveBeenCalled();
    // And a retry after stop has nothing to resume.
    expect(retryBackgroundRestore()).toBe(false);
  });

  it('skipMessageWalk — the boot archive-only resume never re-walks messages', async () => {
    startBackgroundRestore({...PARAMS, skipMessageWalk: true});
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(walk).not.toHaveBeenCalled();
    expect(drain).toHaveBeenCalledTimes(1);
    expect(startMirrorBootstrap).toHaveBeenCalled();
  });
});

describe('B-311/B-312 round 2 — the resume heals with its OWN credentials', () => {
  // ROUND-1 POST-MORTEM (why the first two shipped heals failed ON DEVICE
  // while green here): commitMerkleRootNow and repairBackupCommit both reach
  // for getOwnCryptoStore(), which only the runtime boot populates — and
  // B-107 blocks the runtime boot while restore mode holds. On the Pixel the
  // store was null, countLocalMessages() fell back to an unhydrated memory
  // store (0 rows) and the repair refused WITHOUT logging. The mocks here had
  // encoded the assumption (getOwnCryptoStore → {}), not the device.
  //
  // Round 2: the heal is a direct commitMerkleRoot({identityPrivKey, userId})
  // — the resume params carry the keychain-loaded identity key, so there is
  // NO store dependency left to diverge from the device.
  //
  // POSTURE (explicit change from round 1): the heal runs for BOTH the
  // flag-set (kill-window) and flag-absent (orphan-writer) cases. Refusing
  // the orphan case left a device-proven PERMANENT dead-end. This is not
  // laundering: signing requires the identity private key no attacker holds,
  // and every row is GCM-authenticated at decrypt — substituted rows fail
  // auth and SURFACE in the restore result as skipped. The verifier itself
  // is untouched and re-runs on the retry.
  const {readMerkleCommitPending} = jest.requireMock('../backup/mirrorLedger') as {readMerkleCommitPending: jest.Mock};
  const {commitMerkleRoot} = jest.requireMock('../backup/merkleCommit') as {commitMerkleRoot: jest.Mock};

  beforeEach(() => {
    stopBackgroundRestore();
    jest.clearAllMocks();
    // clearAllMocks keeps implementations — re-establish defaults so a prior
    // case's mockRejectedValue can never leak forward.
    commitMerkleRoot.mockReset();
    commitMerkleRoot.mockImplementation(async () => ({rootB64: 'root', seq: 9, rowCount: 1406}));
    readMerkleCommitPending.mockResolvedValue(false);
    mirrorEnabled.mockReturnValue(false); // the deadlock state: bootstrap never ran
    drain.mockResolvedValue({replayed: 0, incomplete: false});
  });
  afterEach(() => { stopBackgroundRestore(); });

  it('heals with the PARAMS identity key — no crypto-store dependency (the on-device bug)', async () => {
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('rows_count_mismatch'))
      .mockResolvedValueOnce(counts(11, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
    expect(commitMerkleRoot).toHaveBeenCalledWith({
      identityPrivKey: PARAMS.identityPrivKey,
      userId:          'owner-uuid',
    });
    // The repair machinery that silently refused on-device must be OUT of
    // this path entirely. (setMirrorKey IS legitimately called later — the
    // BUG-5 post-walk hand-off — so the pin is placement, not absence.)
    expect(repair).not.toHaveBeenCalled();
    const keyOrders = (setMirrorKey as jest.Mock).mock.invocationCallOrder;
    if (keyOrders.length > 0) {
      expect(Math.min(...keyOrders)).toBeGreaterThan(walk.mock.invocationCallOrder[1]);
    }
    expect(getBackgroundRestoreState()).toMatchObject({kind: 'done', messages: 11});
  });

  it('the ORPHAN case (flag absent) heals too — the round-1 dead-end is gone', async () => {
    readMerkleCommitPending.mockResolvedValue(false);
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('rows_count_mismatch'))
      .mockResolvedValueOnce(counts(5, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
  });

  it('the kill-window case (flag set) heals identically', async () => {
    readMerkleCommitPending.mockResolvedValue(true);
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('rows_count_mismatch'))
      .mockResolvedValueOnce(counts(5, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
  });

  it('one heal per start — a second mismatch after signing is terminal', async () => {
    walk.mockRejectedValue(new MerkleCommitMismatchError('rows_count_mismatch'));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
  });

  it('a heal-commit failure falls through to the error banner', async () => {
    commitMerkleRoot.mockRejectedValue(new Error('network down'));
    walk.mockRejectedValue(new MerkleCommitMismatchError('rows_count_mismatch'));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
  });

  it('B-463 — root_mismatch heals here too, but only AFTER the B-81 repair refused', async () => {
    repair.mockReset();
    repair.mockResolvedValue(false);
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('root_mismatch'))
      .mockResolvedValueOnce(counts(6, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
    // Repair ran BEFORE the heal — local-truth re-upload stays preferred
    // whenever this device can perform it.
    expect(repair.mock.invocationCallOrder[0])
      .toBeLessThan(commitMerkleRoot.mock.invocationCallOrder[0]);
  });

  it('B-463 — a SUCCESSFUL B-81 repair pre-empts the heal entirely', async () => {
    repair.mockReset();
    repair.mockResolvedValue(true);
    walk
      .mockRejectedValueOnce(new MerkleCommitMismatchError('root_mismatch'))
      .mockResolvedValueOnce(counts(4, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    expect(repair).toHaveBeenCalledTimes(1);
    expect(commitMerkleRoot).not.toHaveBeenCalled();
  });

  it('B-463 — persistent root_mismatch after the heal is terminal (shared one-heal budget)', async () => {
    repair.mockReset();
    repair.mockResolvedValue(false);
    walk.mockRejectedValue(new MerkleCommitMismatchError('root_mismatch'));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(commitMerkleRoot).toHaveBeenCalledTimes(1);
    const err = getBackgroundRestoreState() as {kind: 'error'; message: string};
    expect(err.message).toContain('root_mismatch');
  });

  it('B-463 — no identityPrivKey → the refused repair stays a hard fail (no heal without the key)', async () => {
    repair.mockReset();
    repair.mockResolvedValue(false);
    walk.mockRejectedValue(new MerkleCommitMismatchError('root_mismatch'));

    startBackgroundRestore({...PARAMS, identityPrivKey: undefined});
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(commitMerkleRoot).not.toHaveBeenCalled();
  });
});

describe('W1/B-313 — network failures auto-resume quietly; the banner is the LAST resort', () => {
  // Device evidence (2026-07-27 22:36-22:37): one timed-out fetch aborted the
  // run into the hard error banner, three manual RETRYs on LTE until Wi-Fi.
  // The phases are marker-gated, so a re-entry resumes at the first
  // incomplete phase with the walk cursor intact — a network blip should
  // therefore cost a quiet pause, never a banner.
  const {BackupError} = jest.requireActual('../backup/backupClient') as typeof import('../backup/backupClient');
  const {_setNetResumeBaseMsForTest} = require('../backup/restoreBackground') as typeof import('../backup/restoreBackground');

  beforeEach(() => {
    stopBackgroundRestore();
    jest.clearAllMocks();
    // clearAllMocks clears CALLS, not implementations: the round-2 describe
    // leaves `walk` with a PERSISTENT mockRejectedValue, which outlives the
    // Once-queue here and turned this suite's failures into noise. Third time
    // this leak has bitten in one session — reset, don't clear.
    walk.mockReset();
    repair.mockReset();
    repair.mockImplementation(async () => false);
    mirrorEnabled.mockReturnValue(true);
    drain.mockResolvedValue({replayed: 0, incomplete: false});
    _setNetResumeBaseMsForTest(1);
  });
  afterEach(() => { stopBackgroundRestore(); });

  it('a network blip mid-walk pauses and resumes — never surfaces the error state', async () => {
    const states: string[] = [];
    const unsub = subscribeBackgroundRestore(() => { states.push(getBackgroundRestoreState().kind); });
    walk
      .mockRejectedValueOnce(new BackupError('network', 'fetch_failed:timeout'))
      .mockResolvedValueOnce(counts(7, false));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'done');
    unsub();
    expect(states).not.toContain('error');
    expect(walk).toHaveBeenCalledTimes(2);
    expect(getBackgroundRestoreState()).toMatchObject({kind: 'done', messages: 7});
  });

  it('sustained network failure hits the cap and THEN surfaces the banner', async () => {
    walk.mockRejectedValue(new BackupError('network', 'fetch_failed:timeout'));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error', 8_000);
    // 1 initial + 5 auto-resumes.
    expect(walk).toHaveBeenCalledTimes(6);
  });

  it('non-network failures surface immediately — no resume masking', async () => {
    walk.mockRejectedValue(new Error('restore stalled — no progress on resume'));

    startBackgroundRestore(PARAMS);
    await waitFor(() => getBackgroundRestoreState().kind === 'error');
    expect(walk).toHaveBeenCalledTimes(1);
  });

  it('stop() during the waiting pause cancels cleanly', async () => {
    walk.mockRejectedValue(new BackupError('network', 'fetch_failed:timeout'));
    _setNetResumeBaseMsForTest(60_000); // long pause so stop lands inside it

    startBackgroundRestore(PARAMS);
    await waitFor(() => walk.mock.calls.length === 1);
    await new Promise(r => setTimeout(r, 50)); // let the catch enter the pause
    stopBackgroundRestore();
    await new Promise(r => setTimeout(r, 100));
    // No further walk attempts after stop.
    expect(walk).toHaveBeenCalledTimes(1);
  });
});
