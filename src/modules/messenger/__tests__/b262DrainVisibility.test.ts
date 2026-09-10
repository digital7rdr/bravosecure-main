/**
 * sqa.md bug register — this suite pins: B-262.
 *
 * B-262 (P0): a 1:1/group message ACKed `delivered` (sender sees ✓✓), the relay
 * hard-deletes the envelope, and it is NEVER rendered on the recipient.
 *
 * Root cause (receive-side half — the arch-gated write-side M4 contamination and
 * the deeper "don't hard-delete the server copy" ack cure are out of scope):
 * a group-stamped message whose master key diverges on the recipient hits the
 * tamper-STASH branch of `doHandleIncoming`. That branch durably stashes the
 * ciphertext and keeps the honest `delivered` disposition (correct — it expects
 * to recover), so the relay copy is hard-deleted. But the stashed row then never
 * surfaces:
 *
 *   1. In the drain loop, a `needsKey` divergence row spends NO attempt on a
 *      boot drain (GF-3 `shouldBumpStashAttempt`), so it `continue`s on every
 *      launch and can never reach the cap-drop — invisible until prune reaps it.
 *   2. When a row DOES reach the cap (`attempts >= PENDING_GROUP_MAX_ATTEMPTS`),
 *      it was `delete`d SILENTLY — no placeholder, no visible gap.
 *
 * Net: acked delivered, server-deleted, never rendered, no trace.
 *
 * The fix is receive-side CONTAINMENT: a stash may never end in a silent delete
 * or eternal invisibility. Both drain give-up sites now leave the SAME visible,
 * recoverable "couldn't decrypt" placeholder the terminal tamper-DROP twin
 * already leaves (`surfaceUnrecoveredStash` → `insertDecryptFailurePlaceholder` +
 * `sqlMessages.upsert`), and a never-advancing key-blocked row gets an age bound
 * so it eventually surfaces one. Fail-closed (never renders ciphertext),
 * block-suppressed, idempotent, fail-open.
 *
 * `productionRuntime.ts` cannot be imported by any test project (CLAUDE.md's
 * message-pipeline rule), so this is a static SOURCE SCAN — CRLF-normalised,
 * comment-stripped, and anchored by SLICING the executing closures (never a
 * whole-file scan: a bare `indexOf` matched a sibling function and passed
 * vacuously before — MESSAGE_LOOP §11 / the audit-Step-4.1 lesson).
 *
 * RED-first: at HEAD (pre-fix) the drain area has no `surfaceUnrecoveredStash`
 * and no `insertDecryptFailurePlaceholder`, so every assertion here fails.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {useMessengerStore} from '../store/messengerStore';
import {
  insertDecryptFailurePlaceholder,
  reconcileRecoveredPlaceholder,
  placeholderMessageId,
} from '../runtime/decryptFailureSignal';
import type {LocalMessage} from '../store/types';
import type {SessionAddress} from '@bravo/messenger-core';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

function source(): string {
  return readFileSync(RUNTIME, 'utf8').replace(/\r\n/g, '\n');
}
function stripComments(src: string): string {
  // Strip block + line comments. The `(^|[^:])` guard keeps `://` in string
  // literals intact. Absence/ordering assertions below MUST run on code only —
  // this file's own B-262 comments name the very symbols we assert on.
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** The executing body of `drainPendingGroupInner`, CODE only. */
function drainClosure(): string {
  const src = stripComments(source());
  const start = src.indexOf('async function drainPendingGroupInner(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nasync function replayGroupSealedDecode(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The executing body of the shared `surfaceUnrecoveredStash` helper, CODE only. */
function helperBody(): string {
  const src = stripComments(source());
  const start = src.indexOf('async function surfaceUnrecoveredStash(');
  expect(start).toBeGreaterThan(-1); // does not exist at HEAD → RED-first
  const end = src.indexOf('\nasync function drainPendingGroupInner(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The terminal tamper-DROP branch of doHandleIncoming, CODE only. */
function tamperDropBranch(): string {
  const src = stripComments(source());
  const start = src.indexOf('[group:recv] tamper detected');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf("parseResult.reason === 'no_key'", start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/** The executing body of `replayGroupSealedDecode` (the recovery path), CODE only. */
function replayClosure(): string {
  const src = stripComments(source());
  const start = src.indexOf('async function replayGroupSealedDecode(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nasync function drainPendingAdminActions(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('DOCUMENTS B-262 — a group stash never ends in a silent delete or eternal invisibility', () => {
  it('the cap-drop inserts a visible placeholder BEFORE the delete (no more silent purge)', () => {
    const body = drainClosure();
    const capAt = body.indexOf('PENDING_GROUP_MAX_ATTEMPTS');
    expect(capAt).toBeGreaterThan(-1);
    // The delete that follows the cap check (NOT the clean-return delete at the
    // top of the loop) must be preceded by the surfacer.
    const surfaceAt = body.indexOf('surfaceUnrecoveredStash(', capAt);
    const deleteAt = body.indexOf('pendingGroupEnvelopes.delete(', capAt);
    expect(surfaceAt).toBeGreaterThan(capAt);
    expect(deleteAt).toBeGreaterThan(surfaceAt); // placeholder BEFORE the delete
  });

  it('a never-advancing key-blocked row has an age bound that surfaces a placeholder', () => {
    const body = drainClosure();
    // The exact age gate: only `needsKey` rows (not a transient-SQL hiccup),
    // compared against the give-up bound.
    expect(body).toMatch(/needsKey && Date\.now\(\) - row\.receivedAtMs >= GROUP_STASH_UNRECOVERED_MS/);
    const ageAt = body.indexOf('GROUP_STASH_UNRECOVERED_MS');
    expect(ageAt).toBeGreaterThan(-1);
    expect(body.indexOf('surfaceUnrecoveredStash(', ageAt)).toBeGreaterThan(ageAt);
  });

  it('the age path runs BEFORE the attempt-spend gate (so a `continue`-forever row is caught)', () => {
    const body = drainClosure();
    const ageSurfaceAt = body.indexOf('surfaceUnrecoveredStash('); // first = age path
    const bumpGate = body.indexOf('shouldBumpStashAttempt(');
    expect(ageSurfaceAt).toBeGreaterThan(-1);
    expect(bumpGate).toBeGreaterThan(ageSurfaceAt);
  });

  it('the age path NEVER deletes — prune owns the terminal delete at the 30-day dwell (PERMALOSS)', () => {
    // GROUP-STASH-7DAY-PRUNE-PERMALOSS: deleting a stash row before the full
    // relay dwell destroys a recoverable message (the relay copy is already
    // gone). The age path must surface a placeholder and leave the row for
    // prune. Assert no delete between the age gate and the attempt-spend gate.
    const body = drainClosure();
    const ageStart = body.indexOf('Date.now() - row.receivedAtMs');
    const bumpGate = body.indexOf('shouldBumpStashAttempt(', ageStart);
    expect(ageStart).toBeGreaterThan(-1);
    expect(bumpGate).toBeGreaterThan(ageStart);
    expect(body.slice(ageStart, bumpGate)).not.toMatch(/pendingGroupEnvelopes\.delete\(/);
  });

  it('the shared surfacer inserts a PERSISTENT, block-suppressed placeholder', () => {
    const helper = helperBody();
    expect(helper).toMatch(/insertDecryptFailurePlaceholder\(/); // visible gap
    expect(helper).toMatch(/sqlMessages\.upsert\(/);             // durable, mirrored to SQLCipher
    expect(helper).toMatch(/isPeerBlocked\(/);                   // no resurrection for a blocked sender
  });

  it('the give-up bound is under the 30-day prune window (marker lands before prune reaps)', () => {
    // Definition lives just above the drain. A bound >= the store's 30-day
    // RETENTION_MS would let prune silently delete the row first — the exact
    // invisibility this fixes.
    const src = stripComments(source());
    expect(src).toMatch(/const GROUP_STASH_UNRECOVERED_MS = 14 \* 24 \* 60 \* 60 \* 1000;/);
  });
});

describe('B-262 companion — the two tamper branches cannot silently re-diverge on visibility', () => {
  it('the terminal tamper-DROP branch still notes the envelope AND leaves a placeholder', () => {
    const drop = tamperDropBranch();
    expect(drop).toMatch(/noteDestroyedEnvelope\(/);
    expect(drop).toMatch(/insertDecryptFailurePlaceholder\(/);
  });
});

describe('DOCUMENTS B-262 — recovery RECONCILES the give-up placeholder before appending the real row', () => {
  it('replayGroupSealedDecode calls reconcileRecoveredPlaceholder BEFORE store.appendMessage', () => {
    // The age-bound placeholder owns this envelope_id; appendMessage dedups on
    // envelope_id, so the reconcile MUST precede the append or the recovered
    // message is dropped and the last stash copy is then deleted (B-262 again).
    const body = replayClosure();
    const reconcileAt = body.indexOf('reconcileRecoveredPlaceholder(');
    const appendAt = body.indexOf('store.appendMessage(');
    expect(reconcileAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(-1);
    expect(reconcileAt).toBeLessThan(appendAt);
  });
});

// Real behavioral test on the reconcile — a source scan can prove the CALL
// exists, but only this proves the recovered message actually APPENDS (not
// dropped) and the stale gap actually clears.
describe('DOCUMENTS B-262 — a recovered message wins over its give-up placeholder (behavioral)', () => {
  const CONV = 'group:jacks-room';
  const ENV = 'env-b262-abc';
  const PEER: SessionAddress = {userId: 'jack', deviceId: 1};
  const realMsg = (): LocalMessage => ({
    id:              'real-1',
    conversation_id: CONV,
    sender_id:       'jack',
    type:            'text',
    content:         'the real recovered message',
    status:          'delivered',
    is_encrypted:    true,
    created_at:      new Date('2026-08-22T10:00:00Z').toISOString(),
    peer:            PEER,
    envelope_id:     ENV, // SAME envelope_id the placeholder carries
  });

  beforeEach(() => {
    useMessengerStore.setState({messages: {}});
  });

  it('CONTROL: without the reconcile, the placeholder BLOCKS the real message (the bug)', () => {
    insertDecryptFailurePlaceholder({conversationId: CONV, peer: PEER, envelopeId: ENV, reason: 'group-key-unrecovered'});
    // appendMessage dedups on envelope_id (:903) — the real row is dropped.
    const committed = useMessengerStore.getState().appendMessage(CONV, realMsg());
    expect(committed).toBeNull();
  });

  it('with the reconcile, the placeholder is removed, the real message APPENDS, and the gap is gone', () => {
    insertDecryptFailurePlaceholder({conversationId: CONV, peer: PEER, envelopeId: ENV, reason: 'group-key-unrecovered'});
    expect(reconcileRecoveredPlaceholder(CONV, ENV)).toBe(true);

    const committed = useMessengerStore.getState().appendMessage(CONV, realMsg());
    expect(committed).toBe('real-1'); // appended, NOT null

    const list = useMessengerStore.getState().messages[CONV] ?? [];
    expect(list.some(m => m.id === placeholderMessageId(ENV))).toBe(false); // stale gap cleared
    expect(list.some(m => m.id === 'real-1')).toBe(true);                   // real message present
  });

  it('the reconcile is a no-op (returns false) when no placeholder exists — no spurious backup tombstone', () => {
    // B-169 class: removeMessage fires notifyBackupRemoved unconditionally, so
    // the helper MUST guard on actual presence before calling it.
    expect(reconcileRecoveredPlaceholder(CONV, 'never-stashed-env')).toBe(false);
  });
});
