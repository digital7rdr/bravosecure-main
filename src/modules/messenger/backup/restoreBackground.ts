/**
 * BR-1 — background restore orchestrator.
 *
 * Owns everything that used to run inline on BackupRestoreScreen AFTER
 * the identity phase (password verify + identity install + runtime
 * rebuild): the ratchet-snapshot apply, the paginated message walk, the
 * sealed-archive drain, the B-94 ledger seed, and the mirror hand-off.
 * The screen now starts this runner and navigates straight to
 * MessengerHome; restored messages hydrate batch-by-batch (see the
 * verified-flush hydrate in restoreMessages.ts) while the user can
 * already read and send. RestoreActivityBanner subscribes to the state
 * here to render progress / error / done.
 *
 * Why the identity phase stays ON the screen: it needs the password,
 * it is fast, and it disposes/rebuilds the live runtime (B-107) — none
 * of which belongs in a background task.
 *
 * Integrity posture is unchanged: the walk still defers every durable
 * write until verifyMerkleCommit passes (H-6/P2-B-2), and nothing is
 * hydrated into the UI before verification. "Batch by batch" means the
 * post-verify flush paints per batch instead of one giant hydrate.
 *
 * Ordering changes vs the old inline flow, both deliberate:
 *   • Ratchet-snapshot apply moved BEFORE the message walk. It only
 *     needs the keychain key + crypto store, and every live envelope
 *     that arrives during the (now minutes-long, backgrounded) walk
 *     decrypts against the restored chains instead of falling into the
 *     DecryptError → nudge path.
 *   • The walk auto-resumes (P2-B-6 cursor) in-process until complete,
 *     so the user no longer re-enters the password once per 20k-row
 *     window.
 *
 * Kill-safety: startBackgroundRestore arms the H-2 restore-incomplete
 * marker BEFORE its first phase, closing the pre-existing window where
 * a kill between the identity install and the first walk left a
 * restorable backup stranded (boot saw no marker → RESUME → history
 * never pulled). On the next boot, backupBoot's RESTORE-RESUME branch
 * resumes this runner silently from the keychain key — no password.
 */
import {restoreAllMessages, MerkleCommitMismatchError} from './restoreMessages';
import {markRestoreIncomplete, markArchiveReplayIncomplete} from './restoreResume';
import {humanizeBackupError} from './backupErrorCopy';
import {BackupError} from './backupClient';

// W1/B-313 — quiet auto-resume budget for network-class failures. The base
// doubles per round (10s → 20s → 40s → 80s → 120s cap); the hard banner only
// appears after the cap. Test seam below.
const NET_RESUME_MAX_ROUNDS = 5;
let netResumeBaseMs = 10_000;
let netResumeRound = 0;
export function _setNetResumeBaseMsForTest(ms: number): void { netResumeBaseMs = ms; }

export interface BackgroundRestoreParams {
  masterKey:       CryptoKey;
  /** Signal UUID (user.id) — restore/marker/ledger scope. */
  ownerUserId:     string;
  /** Canonical owner (email ?? phone ?? id) — keychain + flags scope. */
  ownerKey:        string | null;
  identityPubKey:  ArrayBuffer;
  identityPrivKey?: ArrayBuffer;
  /**
   * Boot RESTORE-RESUME sets this when ONLY the archive-replay marker
   * survived (the message walk verifiably completed): skip straight to
   * the drain instead of re-decoding the whole history.
   */
  skipMessageWalk?: boolean;
}

export type BackgroundRestoreState =
  | {kind: 'idle'}
  | {kind: 'running'; step: string; messages: number}
  | {kind: 'done'; messages: number; conversations: number; skipped: number}
  | {kind: 'error'; message: string};

// P2-B-6 windows are 20k decoded rows each; 50 rounds = a 1M-row
// ceiling, matching the walk's own page cap. The stall guard below is
// the real terminator — this is a runaway backstop only.
const MAX_WALK_ROUNDS = 50;

let state: BackgroundRestoreState = {kind: 'idle'};
const listeners = new Set<() => void>();
let running = false;
// Bumped by stop/start; the in-flight runner aborts between phases when
// its generation goes stale. Cooperative — an in-flight page fetch
// finishes, then the runner exits without touching further state.
let generation = 0;
let lastParams: BackgroundRestoreParams | null = null;
// Phase checkpoints so a retry after a late-phase error (e.g. archive
// drain network blip) does not re-decode the entire verified history.
let phaseDone = {snapshot: false, walk: false};
let lastWalkCounts = {conversations: 0, messages: 0, skipped: 0};
let lastNotifyAt = 0;

function notify(): void {
  for (const l of listeners) {
    try { l(); } catch { /* listener fault — never break the runner */ }
  }
}

function setState(next: BackgroundRestoreState): void {
  state = next;
  notify();
}

// Progress ticks can arrive per verified batch; collapse to ~4/s. Step
// label changes always pass so phase boundaries never look stuck.
function setRunningThrottled(step: string, messages: number): void {
  const now = Date.now();
  const stepChanged = state.kind !== 'running' || state.step !== step;
  if (!stepChanged && now - lastNotifyAt < 250) {return;}
  lastNotifyAt = now;
  setState({kind: 'running', step, messages});
}

export function getBackgroundRestoreState(): BackgroundRestoreState {
  return state;
}

export function subscribeBackgroundRestore(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function isBackgroundRestoreActive(): boolean {
  return state.kind === 'running';
}

/** Banner dismiss for terminal states. No-op while running. */
export function dismissBackgroundRestoreResult(): void {
  if (state.kind === 'done' || state.kind === 'error') {
    setState({kind: 'idle'});
  }
}

/**
 * Cooperative cancel — used by the forget/wipe flows so a wiped server
 * mirror isn't still being walked. The H-2 marker/cursor are NOT
 * cleared here; the wipe path owns that (clearRestoreState).
 */
export function stopBackgroundRestore(): void {
  generation++;
  running = false;
  lastParams = null;
  phaseDone = {snapshot: false, walk: false};
  if (state.kind !== 'idle') {setState({kind: 'idle'});}
}

/**
 * Re-run after an error, resuming at the first incomplete phase.
 * Returns false when there is nothing to retry (no failed run held).
 */
export function retryBackgroundRestore(): boolean {
  if (running || !lastParams || state.kind !== 'error') {return false;}
  void run(lastParams);
  return true;
}

/**
 * Fire-and-forget start. Returns false (and does nothing) if a run is
 * already in flight — the caller navigated here twice, not a bug worth
 * throwing over.
 */
export function startBackgroundRestore(params: BackgroundRestoreParams): boolean {
  if (running) {return false;}
  phaseDone = {snapshot: false, walk: !!params.skipMessageWalk};
  lastWalkCounts = {conversations: 0, messages: 0, skipped: 0};
  netResumeRound = 0; // W1/B-313 — a fresh user intent resets the quiet-resume budget
  void run(params);
  return true;
}

async function run(params: BackgroundRestoreParams): Promise<void> {
  running = true;
  lastParams = params;
  const myGen = ++generation;
  const stale = (): boolean => myGen !== generation;
  const {masterKey, ownerUserId, ownerKey} = params;

  try {
    setState({kind: 'running', step: 'Preparing restore…', messages: lastWalkCounts.messages});
    // Kill-safety — arm H-2 before the first phase (idempotent; the walk
    // re-arms it). A kill from here on re-enters RESTORE-RESUME at boot.
    if (!phaseDone.walk) {await markRestoreIncomplete(ownerUserId);}
    // BUG-E (audit 2026-07-23) — arm the archive marker NOW, not when the
    // drain starts. The walk clears H-2 on completion, and a kill in the
    // seam before drainSealedArchive armed its own marker left NO marker
    // set → the sealed archive (reinstall-window messages) was never
    // drained and expired silently. Arming early is safe: the drain
    // clears it after a natural end even when the archive is empty.
    await markArchiveReplayIncomplete(ownerUserId);

    // Phase 1 — ratchet-snapshot apply (non-fatal, seq-floored).
    if (!phaseDone.snapshot) {
      setRunningThrottled('Restoring secure sessions…', lastWalkCounts.messages);
      await applySnapshotPhase(ownerUserId, ownerKey);
      phaseDone.snapshot = true;
    }
    if (stale()) {return;}

    // Phase 2 — the verified message walk, auto-resumed to completion.
    if (!phaseDone.walk) {
      const counts = await walkPhase(params, stale);
      if (stale()) {return;}
      lastWalkCounts = counts;
      phaseDone.walk = true;
    }

    // Phase 3 — sealed-archive drain (resumable via its own cursor).
    setRunningThrottled('Restoring server-side history…', lastWalkCounts.messages);
    const {getOwnCryptoStore} = require('../runtime') as typeof import('../runtime');
    if (getOwnCryptoStore()) {
      const {replayArchivedEnvelope} = require('../runtime/productionRuntime') as
        typeof import('../runtime/productionRuntime');
      const {drainSealedArchive} = require('./archiveReplay') as typeof import('./archiveReplay');
      // BUG-S — the drain reports a page-cap-hit walk as incomplete;
      // keep draining from the persisted cursor instead of leaving the
      // tail for the next boot. A TRANSIENT abort (db_closed mid-rebuild,
      // AUDIT #11) must BREAK instead: re-entering just re-fetches the
      // same page against the same broken handle — the armed marker +
      // cursor hand the tail to the next boot's resume gate.
      let totalReplayed = 0;
      let drainOutcome = 'complete';
      for (let round = 0; round < 20; round++) {
        const {replayed, incomplete, transient} = await drainSealedArchive(ownerUserId, replayArchivedEnvelope);
        totalReplayed += replayed;
        drainOutcome = transient ? 'transient-abort (resumes next boot)'
          : !incomplete ? 'complete'
          : 'page-cap (resumes next boot)';
        if (!incomplete || transient || stale()) {break;}
      }
      // Log-honesty (critic rev-6): one line served three different
      // outcomes and always read like completion.
      console.log(`[bravo.restore.bg] archive drain replayed=${totalReplayed} outcome=${drainOutcome}`);
    }
    if (stale()) {return;}

    // Fix #5 — surface the undecryptable tally alongside `skipped`.
    let undecryptable = 0;
    try {
      const {getUndecryptableCount} = require('./sessionRatchetRecovery') as
        typeof import('./sessionRatchetRecovery');
      undecryptable = getUndecryptableCount();
    } catch { /* module missing — fine */ }

    // (B-94 ledger seeding happens inside the walk itself now — BUG-B:
    // it must cover exactly the verified flushed rows, which only the
    // walk knows; the old loadAll()-based seed here also marked archive-
    // replayed and live-received rows as flushed, losing them from the
    // mirror forever.)

    // Phase 4 — mirror hand-off. M-11: the subscription starts only now,
    // seeded from the fully-restored store, so restored history is never
    // re-uploaded as "new".
    const {startMirrorBootstrap, backupNow} = require('./mirrorBootstrap') as typeof import('./mirrorBootstrap');
    const {
      isMirrorEnabled, setMirrorKey, seedMirrorDedup,
      drainMirrorOutbox, fireMerkleHookNow, fireMerkleHookNowIfPending,
    } = require('./messageMirror') as typeof import('./messageMirror');
    startMirrorBootstrap();
    if (!isMirrorEnabled()) {
      // Unlock-path hand-off (BUG-5) — the screen deferred the key so the
      // wired catch-up sweep couldn't race the walk. Enabling now (walk
      // done, ledger seeded by the walk) auto-fires that same
      // ledger-seeded sweep at a safe time.
      setMirrorKey(masterKey);
    } else {
      // Fresh-install path — the key went live in the identity phase
      // while the sweep was unwired, so no sweep ever fired. Run one
      // explicit ledger-seeded sweep: the bootstrap baselines the store
      // snapshot, so messages that arrived LIVE during the background
      // walk (plus archive-replayed rows) would otherwise not mirror
      // until the next boot. I1 holds: the walk's B-94 seed makes the
      // dedup skip all restored history.
      try {
        const {loadFlushedVersions, readMerkleCommitPending} =
          require('./mirrorLedger') as typeof import('./mirrorLedger');
        seedMirrorDedup(ownerUserId, await loadFlushedVersions(ownerUserId));
        await backupNow(ownerUserId);
        await drainMirrorOutbox();
        if (await readMerkleCommitPending(ownerUserId)) {
          await fireMerkleHookNow();
        } else {
          await fireMerkleHookNowIfPending();
        }
      } catch (e) {
        console.warn('[bravo.restore.bg] post-restore sweep failed (next boot heals):', (e as Error).message);
      }
    }
    const {setBackupEnabled} = require('./backupFlags') as typeof import('./backupFlags');
    await setBackupEnabled(ownerKey ?? ownerUserId);

    setState({
      kind:          'done',
      messages:      lastWalkCounts.messages,
      conversations: lastWalkCounts.conversations,
      skipped:       lastWalkCounts.skipped + undecryptable,
    });
    console.log(
      `[bravo.restore.bg] complete — messages=${lastWalkCounts.messages} conversations=${lastWalkCounts.conversations} skipped=${lastWalkCounts.skipped + undecryptable}`,
    );
  } catch (e) {
    if (stale()) {return;}
    // W1/B-313 — network failures auto-resume QUIETLY; the banner is the
    // LAST resort. Device evidence (2026-07-27): one timed-out fetch aborted
    // the run into the hard banner — three manual RETRYs on LTE until Wi-Fi.
    // The phases are marker-gated and the walk keeps its cursor, so a
    // re-entry resumes exactly where the blip hit. Capped so a genuinely
    // dead network still surfaces (with the walk's own per-page retries in
    // front of this, reaching the cap means minutes of sustained failure).
    const isNetClass =
      (e instanceof BackupError && e.kind === 'network') ||
      /fetch_failed/.test((e as Error)?.message ?? '');
    if (isNetClass && netResumeRound < NET_RESUME_MAX_ROUNDS) {
      netResumeRound += 1;
      const delay = Math.min(netResumeBaseMs * 2 ** (netResumeRound - 1), 120_000);
      console.warn(`[bravo.restore.bg] network failure — quiet auto-resume ${netResumeRound}/${NET_RESUME_MAX_ROUNDS} in ${Math.round(delay / 1000)}s`);
      setState({kind: 'running', step: 'Waiting for connection…', messages: lastWalkCounts.messages});
      // Cancellable pause: stop()/a newer start bumps the generation.
      const tick = Math.min(delay, 250);
      for (let waited = 0; waited < delay; waited += tick) {
        if (stale()) {return;}
        await new Promise<void>(resolve => setTimeout(resolve, tick));
      }
      if (stale()) {return;}
      if (myGen === generation) {running = false;}
      void run(params);
      return;
    }
    const msg = e instanceof MerkleCommitMismatchError
      ? `Backup integrity check failed (${e.reason}). Retry, or contact support if it keeps failing.`
      : humanizeBackupError(`Restore failed: ${(e as Error).message}`);
    console.warn('[bravo.restore.bg] failed:', (e as Error).message);
    setState({kind: 'error', message: msg});
  } finally {
    if (myGen === generation) {running = false;}
  }
}

async function applySnapshotPhase(ownerUserId: string, ownerKey: string | null): Promise<void> {
  try {
    const {getOwnCryptoStore} = require('../runtime') as typeof import('../runtime');
    const store = getOwnCryptoStore();
    const snapshotOwner = ownerKey ?? ownerUserId;
    if (!store || !snapshotOwner) {
      console.warn('[bravo.restore.bg.ratchet] store/owner unavailable — skipping snapshot');
      return;
    }
    const {loadMirrorMasterKey} = require('../runtime/keychain') as
      typeof import('../runtime/keychain');
    const rawB64 = await loadMirrorMasterKey(snapshotOwner, ownerUserId);
    if (!rawB64) {
      console.warn('[bravo.restore.bg.ratchet] snapshot key unavailable — skipping');
      return;
    }
    const {fromB64} = require('./backupCrypto') as typeof import('./backupCrypto');
    const {applyRatchetSnapshot} = require('./sessionRatchetRecovery') as
      typeof import('./sessionRatchetRecovery');
    const {readPersistedSnapshotSeq, persistAppliedSnapshotSeq} =
      require('./ratchetSnapshotScheduler') as typeof import('./ratchetSnapshotScheduler');
    const masterKeyRaw = fromB64(rawB64);
    try {
      const floor = await readPersistedSnapshotSeq(snapshotOwner);
      // BUG-U — fetchLatest now propagates transient failures instead of
      // reporting `no_snapshot`; give it a few attempts before degrading
      // (still non-fatal: the pre-Phase-2 rehandshake path remains).
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await applyRatchetSnapshot(store, masterKeyRaw, floor);
          console.log(`[bravo.restore.bg.ratchet] applied=${res.applied} seq=${res.seq ?? '-'} reason=${res.reason}`);
          if (res.reason === 'ok' && typeof res.seq === 'number') {
            await persistAppliedSnapshotSeq(snapshotOwner, res.seq);
          }
          break;
        } catch (e) {
          if (attempt === 2) {throw e;}
          console.warn(`[bravo.restore.bg.ratchet] apply attempt ${attempt + 1} failed, retrying:`, (e as Error).message);
          await new Promise<void>(r => setTimeout(r, 2_000 * (attempt + 1)));
        }
      }
    } finally {
      masterKeyRaw.fill(0);
    }
  } catch (e) {
    console.warn('[bravo.restore.bg.ratchet] snapshot apply skipped:', (e as Error).message);
  }
}

async function walkPhase(
  params: BackgroundRestoreParams,
  stale: () => boolean,
): Promise<{conversations: number; messages: number; skipped: number}> {
  const {getOwnCryptoStore} = require('../runtime') as typeof import('../runtime');
  const totals = {conversations: 0, messages: 0, skipped: 0};
  // One B-81 repair per start — a second root_mismatch after a repair
  // that signed is a real integrity signal, not drift.
  let repairTried = false;
  for (let round = 0; round < MAX_WALK_ROUNDS; round++) {
    let counts: {conversations: number; messages: number; skipped: number; incomplete: boolean};
    try {
      counts = await restoreAllMessages(params.masterKey, params.ownerUserId, {
        cryptoStore:     getOwnCryptoStore() ?? undefined,
        identityPubKey:  params.identityPubKey,
        identityPrivKey: params.identityPrivKey,
        onProgress: p => {
          setRunningThrottled(p.label, totals.messages + (p.step === 'messages' || p.step === 'hydrate' ? (p.current ?? 0) : 0));
        },
      });
    } catch (e) {
      if (
        e instanceof MerkleCommitMismatchError &&
        e.reason === 'root_mismatch' &&
        !repairTried &&
        !stale()
      ) {
        // B-81 — owner-device drift repair, then ONE retry. repairBackupCommit
        // refuses on a fresh device (no local history / locked mirror), in
        // which case the mismatch stays a hard fail.
        setRunningThrottled('Repairing backup integrity…', totals.messages);
        const {repairBackupCommit} = require('./mirrorBootstrap') as
          typeof import('./mirrorBootstrap');
        if (await repairBackupCommit(params.ownerUserId)) {
          repairTried = true;
          continue;
        }
      }
      if (
        e instanceof MerkleCommitMismatchError &&
        (e.reason === 'rows_count_mismatch' || e.reason === 'root_mismatch') &&
        !repairTried &&
        !stale()
      ) {
        // B-463 — 'root_mismatch' (equal-count drift) joins the heal. It
        // reaches here ONLY after the B-81 branch above ran and
        // repairBackupCommit REFUSED (fresh device: no local history, no
        // unlocked mirror) — a refused repair spends no budget, so
        // repairTried is still false. Device-proven shape (founder Pixel
        // 6a, 2026-08-16): v236's final session re-encrypted rows inside
        // the flush→commit kill window, the app never booted again (no
        // pending-flag heal), and the uninstall destroyed the local
        // history B-81 needs — every path refused and 1674 intact,
        // decryptable rows were permanently unrestorable. Equal-count
        // drift is STRICTLY less attacker freedom than the count-grew
        // case already healed here, and the same posture argument holds
        // verbatim: signing needs the identity PRIVATE key only the owner
        // holds; every row must still pass AES-GCM auth at decrypt
        // (substitutions are skipped + surfaced, never accepted); the
        // verifier is byte-untouched and must pass over the newly signed
        // set on the single retry.
        // B-311 — the restore↔commit DEADLOCK breaker. Device-proven shape
        // (Pixel 6a 20:02, capture): server grew past the signed root
        // (rows=1406 committed=1403) and the additive-prefix check refused,
        // because the prefix assumption ("post-commit uploads always sort
        // after the committed tail") is FALSE for the re-upload path — a
        // receipt/reaction re-encrypts an OLD row in place: same sort
        // position, new leaf. The device's OWN legitimate writes read as
        // substitution.
        //
        // The rightful healer is this device's I2 pending commit — the SAME
        // unconditional commit the boot catch-up sweep fires whenever the
        // flag is set. That sweep lives in the mirror bootstrap, which only
        // starts on restore SUCCESS: verify blocked restore, restore blocked
        // the heal, RETRY looped forever.
        //
        // Same flag, same heal, zero new trust exposure — run here, at the
        // moment that unblocks the loop, then ONE retry (shared budget with
        // B-81: a second mismatch after a signed heal is a real integrity
        // signal). WITHOUT the flag the hard fail stands untouched: a server
        // that grew rows this device never wrote must never be co-signed.
        // B-311/B-312 round 2 — heal with the RESUME'S OWN CREDENTIALS.
        //
        // The first implementations failed ON DEVICE while green in tests:
        // both `commitMerkleRootNow` (B-311) and `repairBackupCommit` (B-312)
        // reach for `getOwnCryptoStore()`, which is populated ONLY by the
        // runtime boot — and B-107 blocks the runtime boot for as long as
        // restore mode holds. In the resume context the store is null, the
        // repair's countLocalMessages() fell back to an unhydrated memory
        // store (0 rows) and refused WITHOUT A LOG LINE. The test mocks had
        // encoded the assumption (`getOwnCryptoStore → {}`), not the device.
        //
        // `commitMerkleRoot({identityPrivKey, userId})` needs NEITHER: it
        // walks the SERVER and signs with the identity key the resume already
        // loaded from the keychain (params.identityPrivKey). Same signature
        // the boot-sweep heal would produce.
        //
        // POSTURE (explicit, changed from round 1): the heal runs on BOTH the
        // flag-set (kill-window) and flag-absent (orphan-writer) cases. Round
        // 1 refused the orphan case as "no laundering" — which left the
        // device-proven state (writer's storage died with an uninstall) as a
        // PERMANENT dead-end. Signing the walk does not launder tamper:
        //   • signing requires the identity PRIVATE key, which no server or
        //     attacker holds — only the owner can produce this commit;
        //   • every row is AES-GCM-authenticated under the user's master key
        //     at decrypt — a substituted/garbage row FAILS auth, is skipped,
        //     counted, and SURFACED in the restore result (`skipped`), not
        //     silently accepted;
        //   • the verifier itself is byte-identical-untouched; it re-runs on
        //     the retry and must pass over the newly signed set.
        // A recoverable backup with surfaced anomalies beats an unrecoverable
        // one. The flag now only labels the log line.
        const identityPrivKey = params.identityPrivKey;
        if (!identityPrivKey) {
          // No identity key in this launch context (should not happen on the
          // resume path, which loads it from the keychain) — surface rather
          // than sign nothing silently. Round 1's silence cost a build cycle.
          console.warn('[bravo.restore.bg] heal skipped — no identityPrivKey in params');
          throw e;
        }
        const {readMerkleCommitPending} = require('./mirrorLedger') as
          typeof import('./mirrorLedger');
        const hadPendingFlag = await readMerkleCommitPending(params.ownerUserId);
        setRunningThrottled('Repairing backup integrity…', totals.messages);
        const {commitMerkleRoot} = require('./merkleCommit') as
          typeof import('./merkleCommit');
        repairTried = true;
        try {
          const signed = await commitMerkleRoot({
            identityPrivKey,
            userId: params.ownerUserId,
          });
          const healCase = e.reason === 'root_mismatch'
            ? 'B-463 equal-count-drift'
            : hadPendingFlag ? 'B-311 pending-writes' : 'B-312 orphan-writer';
          console.warn(
            `[bravo.restore.bg] ${healCase} heal signed` +
            ` rows=${signed?.rowCount ?? -1} seq=${signed?.seq ?? -1} — retrying verify once`,
          );
          continue;
        } catch (healErr) {
          console.warn('[bravo.restore.bg] heal commit failed:', (healErr as Error).message);
          // Fall through to the ordinary error surface below.
        }
      }
      throw e;
    }
    totals.conversations = Math.max(totals.conversations, counts.conversations);
    totals.messages += counts.messages;
    totals.skipped  += counts.skipped;
    if (!counts.incomplete) {return totals;}
    if (stale()) {return totals;}
    // Stall guard — an incomplete round that decoded nothing new would
    // loop forever (cursor not advancing); surface it instead.
    if (counts.messages === 0 && counts.skipped === 0) {
      throw new Error('restore stalled — no progress on resume');
    }
    console.log(`[bravo.restore.bg] walk round ${round + 1} incomplete at ${totals.messages} — resuming`);
    // Yield a beat between rounds so UI/bridge work interleaves.
    await new Promise<void>(r => setTimeout(r, 50));
  }
  throw new Error('restore exceeded the resume-round ceiling');
}

