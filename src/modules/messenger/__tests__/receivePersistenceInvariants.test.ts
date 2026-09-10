/**
 * sqa.md bug register — this suite pins: B-135, B-136, B-137, B-139.
 *
 * B-135 (a reaction acked before it was persisted) = "applyReaction returns the patched
 * row" + "the reaction lane upserts before returning" · B-136 (a removed group member got a
 * false OK-OK) = the non-member group-text and sealed drops note the envelope as destroyed
 * · B-137 (a keys-service blip PERMANENTLY destroyed a group-key envelope) = "a transient
 * owner-identity lookup failure leaves the create ON the relay" · B-139 (a two-minute clock
 * error destroyed the message) = the M6 AAD clock-skew cases.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * M9 — every store mutation made inside the receive transaction must be mirrored
 * by an awaited `sqlMessages.upsert` before the transaction returns, so the row
 * is durable atomically with the relay ack. `productionRuntime.ts` is 8k lines
 * and cannot be imported in jest, so this pins the property by reading the
 * source, in the same way messageTopologyInvariants.test.ts pins the send-path
 * rules. See docs/runbooks/MESSAGE_LOOP.md M9.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

/** Body of `doHandleIncoming`, sliced by its neighbouring top-level functions. */
function doHandleIncomingBody(): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf('async function doHandleIncoming(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nfunction applyReaction(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

/**
 * Receive lanes that have been EXTRACTED out of `doHandleIncoming` (seam S5).
 * Add every new lane module here as it lands.
 *
 * Why this list exists: these invariants are about the receive PATH, not about
 * one file. When the group-text lane moved to `applyGroupText.ts`, six scans in
 * this file and `inboundBuilderParity` went red — not because behaviour changed,
 * but because they were looking at a filename. Deleting the assertions would
 * have been the easy fix and would have silently retired M8/M10/M12 for the
 * lane. Following the code keeps the invariant alive across the seam, which is
 * the whole discipline S5 has to preserve.
 */
const EXTRACTED_LANES = ['applyGroupText.ts', 'applyDirectText.ts', 'applyReactionLane.ts', 'applyGroupAdmin.ts'];

function extractedLaneSource(): string {
  const dir = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime');
  return EXTRACTED_LANES.map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
}

/** `doHandleIncoming` PLUS every lane extracted out of it. */
function receivePathBody(): string {
  return doHandleIncomingBody() + '\n' + extractedLaneSource();
}

function stripSourceComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Comment-stripped source of `doHandleIncoming` AND its extracted lanes. */
function receivePathCode(): string {
  return stripSourceComments(receivePathBody());
}

describe('M9 — reaction lanes persist inside the receive txn (W9)', () => {
  it('applyReaction returns the patched row, not void', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    const sig = src.slice(src.indexOf('function applyReaction('), src.indexOf('{', src.indexOf('function applyReaction(')));
    // A `): void` here is the regression: the reaction would reach SQLite only
    // via the deferred write-through subscriber, after COMMIT and after the ack.
    expect(sig).not.toMatch(/\):\s*void/);
    expect(sig).toMatch(/\):\s*LocalMessage\s*\|\s*null/);
  });

  it('the reaction lane upserts the patched row before returning', () => {
    // Was "BOTH reaction lanes" and counted 2. At S5 the group and 1:1 lanes
    // were MERGED into runtime/applyReactionLane.ts — they were identical apart
    // from the membership gate, and that difference was drift, not design (the
    // group lane only got the gate at B-128, as a P1 security fix). So the
    // correct count is now 1, and that is a strictly stronger property: there is
    // no longer a second copy that can drift.
    const body = receivePathCode();
    const callRe = /const patched = deps\.applyReaction\([\s\S]{0,240}?\);[\s\S]{0,200}?if \(patched && deps\.upsert\) \{[\s\S]{0,80}?await deps\.upsert\(patched\);/g;
    expect((body.match(callRe) ?? []).length).toBe(1);
  });

  it('M8/M12: every lane persists the COMMITTED row, never the pre-append object', () => {
    // appendMessage can fork the id (sender-supplied ids collide) and returns
    // null when it deduped. Upserting the object we handed it stored `X` on
    // disk while memory held `X#n`, and re-persisted rows the store had
    // deliberately dropped. Each lane must capture the returned id and gate the
    // upsert on it.
    const body = receivePathCode();
    const upserts = body.match(/(?:sqlMessages|deps)\.upsert\([^)]*\)/g) ?? [];
    expect(upserts.length).toBeGreaterThanOrEqual(3);
    for (const u of upserts) {
      // A bare `upsert(groupMsg)` / `upsert(oneToOneMsg)` is the regression;
      // the committed form spreads the row and overrides `id`.
      if (/upsert\((placeholder|patched)\)/.test(u)) {continue;} // built elsewhere, already committed
      // The S5 dependency wiring — `upsert: (m) => sqlMessages.upsert(m)` — is a
      // pass-through, not a lane write. The lane it forwards to is in this same
      // scan (EXTRACTED_LANES) and IS checked, so exempting the adapter does not
      // create a hole.
      if (/upsert\(m\)/.test(u)) {continue;}
      expect(u).toMatch(/\{\s*\.\.\..*,\s*id:\s*committed/);
    }
  });

  it('no bare applyReaction() call remains in doHandleIncoming (would skip the upsert)', () => {
    const body = doHandleIncomingBody();
    // A call NOT captured into `patched` cannot be persisted in-txn.
    const bareCalls = body.match(/(?<!const patched = )applyReaction\(/g) ?? [];
    expect(bareCalls.length).toBe(0);
  });
});

/**
 * M10 — a bare `return` inside doHandleIncoming COMMITS the txn and ACKS the
 * envelope off the relay. So every early return is a standing decision about
 * whether a message is destroyed, and an intentional DROP is only honest if it
 * calls `noteDestroyedEnvelope` first — otherwise the ack says 'delivered' and
 * the sender sees ✓✓ for a message that will never render.
 */
describe('M10 — drops are honest, transient failures are not destroys (W10/W11)', () => {
  it('the non-member group-text drop notes the envelope as destroyed', () => {
    const body = receivePathBody();
    // Both non-member drops (legacy plaintext and sealed) must report the same
    // thing to the sender. The sealed one used to return bare ⇒ false ✓✓.
    expect(body).toMatch(/reason:\s*'group-nonmember'/);
    expect(body).toMatch(/reason:\s*'group-nonmember-legacy'/);
  });

  it('the sealed non-member drop notes BEFORE it returns', () => {
    const body = receivePathBody();
    const note = body.indexOf("reason: 'group-nonmember'");
    const guard = body.indexOf('!isGroupMember(existing, peer.userId)');
    expect(guard).toBeGreaterThan(-1);
    expect(note).toBeGreaterThan(guard); // note sits inside the guard block
  });

  it('M6: an AAD clock-skew (`future`) envelope is LEFT ON THE RELAY, not destroyed', () => {
    // A `future` AAD timestamp means this device's clock disagrees, not that
    // the envelope is bad. The clean return used to COMMIT and ack `discarded`
    // — deleting a legitimate message off the relay and telling only the
    // RECEIVER, via a banner asking them to "resend" something the SENDER never
    // knew had failed. It must throw so the txn rolls back and the relay
    // redelivers.
    const body = doHandleIncomingCode();
    expect(body).toMatch(/aadCheck\.reason === 'future'[\s\S]{0,900}?throw new LeaveOnRelayError\(envelopeId\)/);
  });

  it('M6: only `future` is redeliverable — `stale` still drops', () => {
    // `stale` means older than the relay's own 30-day dwell, i.e. expired or
    // replayed. Leaving THAT on the relay would retry a dead envelope forever.
    const body = doHandleIncomingCode();
    const staleIdx = body.indexOf("aadCheck.reason === 'stale'");
    expect(staleIdx).toBeGreaterThan(-1);
    const staleBranch = body.slice(staleIdx, staleIdx + 400);
    expect(staleBranch).not.toMatch(/LeaveOnRelayError/);
  });

  it('a transient owner-identity lookup failure leaves the create ON the relay', () => {
    const body = receivePathBody();
    // Permanent (no keys client) still drops; transient (keys present but the
    // lookup threw) must throw LeaveOnRelayError so the envelope redelivers.
    // Destroying it would permanently lose an OWNER-SIGNED group-key create.
    expect(body).toMatch(/ownerIdentityLookupFailed\s*=\s*true/);
    // `keys`/`envelopeId` became `deps.keys`/`args.envelopeId` when the admin
    // lane moved to applyGroupAdmin.ts (S5). Accept either spelling: the rule is
    // about the GUARD, not about which scope the values arrive from.
    expect(body).toMatch(/if \((?:deps\.)?keys && ownerIdentityLookupFailed && (?:args\.)?envelopeId\) \{[\s\S]{0,260}?throw new LeaveOnRelayError\((?:args\.)?envelopeId\)/);
  });
});

/** Comments stripped, so a census counts CODE exits and not prose. */
function doHandleIncomingCode(): string {
  return doHandleIncomingBody()
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

/**
 * M10 / W20 — THE EXIT CENSUS.
 *
 * This is a RATCHET, not a style rule. Inside `doHandleIncoming` a bare
 * `return;` is not "skip this" — the caller's transaction COMMITS (keeping the
 * advanced Signal ratchet and the `markSeen` row) and then ACKS the envelope
 * off the relay. So every early exit is a standing decision about whether a
 * user's message is destroyed, and the only way to make a destroy honest is to
 * call `noteDestroyedEnvelope` first so the ack flips to 'discarded'.
 *
 * The counts below are measured, not aspirational. When one of them changes the
 * suite goes red ON PURPOSE: classify the new exit (destroy or accept), decide
 * whether it owes a destroyed-note, then update the constant IN THE SAME COMMIT
 * with the reasoning in the commit body. Do NOT just bump the number green.
 *
 * The whole point is that a message-destroying path can no longer be added to
 * this function silently — which is how several of the bugs in sqa.md shipped.
 */
describe('M10/W20 — the doHandleIncoming exit census is pinned', () => {
  // 25 -> 26 at B-128: the group-reaction lane gained the P1-N4 membership drop
  // it never had (a non-member could place reactions into any group whose id
  // they knew). Classified per the rule above: it DESTROYS the envelope, so it
  // calls noteDestroyedEnvelope first and the sender is acked 'discarded'
  // instead of a false ✓✓ — the same correction W11 made for the group-text
  // non-member drop. Pinned by groupReactionMembershipGate.test.ts.
  //
  // 26 -> 23 at S5: the group-TEXT lane moved to runtime/applyGroupText.ts,
  // taking its three drops (non-member, tombstoned, blocked) with it. This is
  // the ONE case where a falling census is good news: those exits are no longer
  // untyped `return;` statements whose meaning had to be inferred from a source
  // scan — they are a `GroupTextOutcome` discriminated union, asserted by real
  // behavioural tests in applyGroupText.test.ts, including which gate wins when
  // several fire at once. The census still guards everything left in the
  // function; the extracted exits did not become unguarded, they became better
  // guarded. Do not read this drop as "3 fewer decisions to worry about".
  //
  // 23 -> 21 at the next S5 lane: the 1:1 TEXT lane moved to
  // runtime/applyDirectText.ts with its M-07 blocked and M-08 tombstone drops.
  // Same reasoning — they are now a DirectTextOutcome union with real tests,
  // including one that pins the fact that the 1:1 and group lanes check these
  // two conditions in OPPOSITE order.
  //
  // 21 -> 18 at the reaction merge: BOTH reaction lanes (group and 1:1) folded
  // into runtime/applyReactionLane.ts, taking three exits with them (blocked ×2,
  // non-member ×1). 26 -> 18 across the whole S5 pass so far. The remaining 18
  // are the ones still inside doHandleIncoming — dominated by the ARCH-GATED
  // admin lane, which is precisely why the census still matters: the exits it
  // guards now are the ones nobody is allowed to refactor away.
  // 18 -> 11 and 9 -> 6 at the ADMIN lane extraction (S5, owner-signed off).
  // The 350-line admin lane took 7 bare exits and 3 typed ones with it into
  // runtime/applyGroupAdmin.ts. They are NOT unguarded now: EXTRACTED_LANES
  // above pulls that module into every scan in this file, so the destroyed-note
  // and ordering rules still cover them. What shrank is only how much of the
  // receive path is still inline in an 8k-line file nothing can import.
  // 11 -> 13 with the edit / delete-for-everyone lanes. Two new exits, one for
  // the group-stamped directive and one for the 1:1, both immediately after
  // `runMutationEnvelope`. Classified per the rule above:
  //
  //   ACCEPT  — applied (the target was patched) or stashed (the target has not
  //             landed yet; a delete or edit is a pairwise control envelope and
  //             routinely overtakes the master-key-encrypted text it points at,
  //             so this must NOT be a destroy).
  //   DESTROY — every gate rejection (blocked / non-member / not-author /
  //             own-row / tombstoned / stale-edit). `runMutationEnvelope` calls
  //             noteDestroyedEnvelope for exactly those, so the sender is acked
  //             'discarded' rather than shown a false ✓✓ for a directive that
  //             will never take effect — the same correction W11 made for the
  //             group-text non-member drop and B-128 made for group reactions.
  //
  // The DECISION is not in this file and is not a source scan: it lives in
  // runtime/messageMutationGate.ts and is pinned behaviourally by
  // messageMutationGate.test.ts + messageMutationApply.test.ts. What these two
  // exits still owe the census is the ack classification above, which
  // mutationLaneWiring.test.ts asserts by scanning both call sites.
  const EXPECTED_BARE_RETURNS = 13;
  const EXPECTED_TYPED_RETURNS = 6;

  it(`has exactly ${EXPECTED_BARE_RETURNS} bare \`return;\` exits — each one COMMITS and ACKS`, () => {
    const bare = doHandleIncomingCode().match(/^\s*return;\s*$/gm) ?? [];
    expect(bare.length).toBe(EXPECTED_BARE_RETURNS);
  });

  it(`has exactly ${EXPECTED_TYPED_RETURNS} PostTxnRequest exits (\`return {kind:\`)`, () => {
    // These defer work to AFTER the txn commits — the only sanctioned way to
    // reach the send stack from in here without doing network I/O under the
    // write lock.
    const typed = doHandleIncomingCode().match(/return \{kind:/g) ?? [];
    expect(typed.length).toBe(EXPECTED_TYPED_RETURNS);
  });

  it('every destroyed-note is followed by an exit before the next note', () => {
    // A note that never reaches an exit does not change the ack, so it is a lie
    // in the other direction: the sender is told 'discarded' for a message this
    // device actually kept. Window-free on purpose — the AAD-reject note sits
    // ~13 lines above its return (it inserts a decrypt-failure placeholder in
    // between), so any fixed character window is either too tight or meaningless.
    const code = doHandleIncomingCode();
    const notes = [...code.matchAll(/noteDestroyedEnvelope\(/g)].map(m => m.index ?? 0);
    expect(notes.length).toBeGreaterThan(0);
    notes.forEach((at, i) => {
      const until = i + 1 < notes.length ? notes[i + 1] : code.length;
      expect(code.slice(at, until)).toMatch(/\breturn\b|\bthrow\b/);
    });
  });

  it('no exit path calls relay.ack directly — acking is the CALLER\'s job', () => {
    // doHandleIncoming runs inside the receive txn. Acking from in here would
    // ack before COMMIT, which is the P0-N14 ordering bug.
    expect(doHandleIncomingCode()).not.toMatch(/relay\.ack\(/);
  });
});

// --- AUDIT-2026-08-13 #13 --- the write-through subscriber defers to the txn
describe('AUDIT #13 --- write-through suppression via the SYNC bracket (M9 dual persistence)', () => {
  const runtimeSrc = () => readFileSync(RUNTIME, 'utf8');

  it('the subscriber bails on isWriteThroughSuppressedNow() BEFORE any diff write', () => {
    // The discriminator is the SYNC bracket, NEVER module txn state:
    // isInsideRatchetTxn() is true across the txn AWAIT windows, where an
    // interleaved USER SEND would have been wrongly suppressed and its
    // bubble lost on restart. Zustand fires subscribers synchronously on
    // the mutator stack, so a depth flag around the txn own appends is
    // precise. The module-state shape is BANNED here.
    const src = runtimeSrc();
    const sub = src.indexOf('const unsubscribeStore = useMessengerStore.subscribe((s) => {');
    expect(sub).toBeGreaterThan(-1);
    const body = src.slice(sub, src.indexOf('liveDisposers.push(unsubscribeStore);', sub));
    const lines = body.split(/\r?\n/).map((l: string) => l.trim());
    expect(lines.some((l: string) => l.startsWith('if (isWriteThroughSuppressedNow()) {'))).toBe(true);
    // The banned module-state discriminator must stay dead in this body.
    expect(lines.some((l: string) => l.startsWith('if (insideRxTxn()) {'))).toBe(false);
    // Comment-stripped absence (the prose above mentions the banned symbol).
    const codeOnly = lines.filter((l: string) => !(l.startsWith('//') || l.startsWith('*') || l.startsWith('/*'))).join(String.fromCharCode(10));
    expect(codeOnly).not.toContain('isInsideRatchetTxn');
    // Ordering on the COMMENT-STRIPPED body (edge F5: indexOf on raw
    // source binds to prose — a decoy comment above the first write plus
    // the real bail moved below it passed every raw-body assertion).
    const codeBody = lines.filter((l: string) => !(l.startsWith('//') || l.startsWith('*') || l.startsWith('/*'))).join(String.fromCharCode(10));
    const bailAt = codeBody.indexOf('if (isWriteThroughSuppressedNow()) {');
    const firstWrite = codeBody.indexOf('for (const cid of Object.keys(prev))');
    expect(bailAt).toBeGreaterThan(-1);
    expect(firstWrite).toBeGreaterThan(bailAt);
    const bailBlock = codeBody.slice(bailAt, bailAt + 120);
    expect(bailBlock).toContain('prev = next;');
    expect(bailBlock).toContain('return;');
  });

  it('exactly the four receive-txn append sites are bracketed (fail-OPEN for unpaired lanes)', () => {
    // Only sites whose rows the txn persists EXPLICITLY may be bracketed.
    // An unbracketed lane keeps its write-through persistence (fail-open)
    // --- e.g. the group system-event appenders (groupEventMessage) have NO
    // SQL write of their own (critic): bracketing them would make every
    // recipient-side "X added Y" bubble memory-only, lost on restart.
    const src = runtimeSrc();
    const lines = src.split(/\r?\n/);
    const bracketed = lines.filter((l: string) => l.includes('runWriteThroughSuppressed(() =>')).length;
    expect(bracketed).toBe(4); // 2 lane-deps appendMessage + stashReplay + legacy
    // ...and "bracketed" is only HALF the premise (critic): each direct site
    // must persist the row the store COMMITTED, never the pre-append object
    // (appendMessage forks the id on collision and returns null on a
    // deliberate drop; the write-through used to mask a pre-append upsert).
    const trimmed = lines.map((l: string) => l.trim());
    expect(trimmed.some((l: string) => l.startsWith('const committedId = runWriteThroughSuppressed(() =>'))).toBe(true);
    expect(trimmed.some((l: string) => l.startsWith('if (committedId) {await sqlMessages.upsert({...groupMsg, id: committedId});}'))).toBe(true);
    expect(trimmed.some((l: string) => l.startsWith('const committedLegacyId = runWriteThroughSuppressed(() =>'))).toBe(true);
    // WHICH four, not just how many (edge F2): a maintainer bracketing a
    // send site while unbracketing a lane site keeps the count at 4 and
    // restores the B-125 shape. Every bracketed line must carry its lane
    // marker, so no bracket can exist anywhere else (sends included).
    const bracketLines = lines.filter((l: string) => l.includes('runWriteThroughSuppressed(() =>'));
    const markers = ['groupMsg));', 'legacyMsg));', 'appendMessage(cid, m))'];
    for (const bl of bracketLines) {
      expect(markers.some(mk => bl.includes(mk))).toBe(true);
    }
    expect(bracketLines.filter((l: string) => l.includes('appendMessage(cid, m))')).length).toBe(2);
    // The drains replay onto the COMMITTED id in both direct lanes
    // (critic: draining on the pre-append id under a fork targets a row
    // that does not exist; the drain-by-committed-id is the convention).
    expect(trimmed.some((l: string) => l.startsWith('await drainPendingReactionsFor(conversationId, committedId, sqlMessages);'))).toBe(true);
    expect(trimmed.some((l: string) => l.startsWith('await drainPendingReactionsFor(conversationId, committedLegacyId, sqlMessages);'))).toBe(true);
    // And the bracket is statically imported (hot-path: no per-fire require).
    expect(lines.some((l: string) => l.trim().startsWith('import {useMessengerStore') && l.includes('runWriteThroughSuppressed') && l.includes('isWriteThroughSuppressedNow'))).toBe(true);
  });

  it('the bracket helpers are the sync depth pattern (messengerStore)', () => {
    const store = readFileSync(join(process.cwd(), 'src', 'modules', 'messenger', 'store', 'messengerStore.ts'), 'utf8');
    const lines = store.split(/\r?\n/).map((l: string) => l.trim());
    expect(lines.some((l: string) => l.startsWith('export function runWriteThroughSuppressed'))).toBe(true);
    expect(lines.some((l: string) => l.startsWith('export function isWriteThroughSuppressedNow'))).toBe(true);
    // Depth (not boolean): nested brackets must not clear early.
    expect(store).toContain('writeThroughSuppressDepth += 1;');
    expect(store).toContain('writeThroughSuppressDepth -= 1;');
  });
});

// --- AUDIT-2026-08-13 #17 --- the AAD epoch binding is ENFORCED, lagged ---
describe('AUDIT #17 --- AAD epoch enforcement with the in-flight lag window', () => {
  it('the production aad site passes expectedEpoch derived with the lag (source pin)', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    const lines = src.split(/\r?\n/).map((l: string) => l.trim());
    // The site feeds the check (line-start --- decoy-proof)...
    expect(lines.some((l: string) => l.startsWith('expectedEpoch:          aadExpectedEpoch,'))).toBe(true);
    // ...and the derivation is LAGGED, never the raw local epoch: strict
    // enforcement destroys routine in-flight mail at every rekey (sender
    // sealed at E, receiver already at E+1; the aad reject path DESTROYS
    // the envelope).
    expect(lines.some((l: string) => l.startsWith('return Math.max(0, g.epoch - AAD_EPOCH_LAG);'))).toBe(true);
    expect(lines.some((l: string) => l.startsWith('const AAD_EPOCH_LAG = 2;'))).toBe(true);
  });

  it('epoch_stale is DETECTION, never destruction (edge E — routing pin)', () => {
    // Each membership op advances the epoch by TWO (op@E + rekey@E+1),
    // so lag 2 covers exactly one op — mail in flight across two quick
    // admin changes is 3+ behind and LEGITIMATE. The destroy arm would
    // permanently kill it with a placeholder; leave-on-relay would
    // redeliver-loop (the sealed epoch never changes, local only grows).
    // The advisory branch must peel epoch_stale off BEFORE the destroy
    // arm and fall through to normal processing.
    const src = readFileSync(RUNTIME, 'utf8');
    const lines = src.split(/\r?\n/).map((l: string) => l.trim());
    const advisory = lines.findIndex((l: string) =>
      l.startsWith("if (!aadCheck.ok && aadCheck.reason === 'epoch_stale') {"));
    const destroyArm = lines.findIndex((l: string) => l.startsWith('} else if (!aadCheck.ok) {'));
    expect(advisory).toBeGreaterThan(-1);
    expect(destroyArm).toBeGreaterThan(advisory);
    // The advisory branch body must not destroy, throw, or return —
    // scan the exact lines between the two branch heads.
    const body = lines.slice(advisory + 1, destroyArm)
      .filter((l: string) => !(l.startsWith('//') || l.startsWith('*') || l.startsWith('/*')));
    expect(body.some((l: string) => l.includes('noteDestroyedEnvelope'))).toBe(false);
    expect(body.some((l: string) => l.startsWith('return'))).toBe(false);
    expect(body.some((l: string) => l.startsWith('throw'))).toBe(false);
  });

  it('the core check rejects DEEP replays and tolerates in-flight epochs (behavioral matrix)', () => {
    const {verifySealedAad} = require('@bravo/messenger-core') as typeof import('@bravo/messenger-core');
    const base = {
      selfUserId: 'me', selfDeviceId: 1, requireAad: true,
      expectedGroupId: 'g1',
    };
    const mk = (epoch: number) => ({
      sealed: {aad: {ts: Date.now(), to: {userId: 'me', deviceId: 1}, groupId: 'g1', epoch}},
    });
    const localEpoch = 10;
    const lagged = localEpoch - 2; // what the runtime passes
    // In-flight tolerance: up to 2 epochs behind still lands.
    expect(verifySealedAad({...base, ...mk(10), expectedEpoch: lagged} as never).ok).toBe(true);
    expect(verifySealedAad({...base, ...mk(9),  expectedEpoch: lagged} as never).ok).toBe(true);
    expect(verifySealedAad({...base, ...mk(8),  expectedEpoch: lagged} as never).ok).toBe(true);
    // Deep replay: 3+ epochs behind is rejected BEFORE any crypto runs.
    const deep = verifySealedAad({...base, ...mk(7), expectedEpoch: lagged} as never);
    expect(deep.ok).toBe(false);
    expect((deep as {reason: string}).reason).toBe('epoch_stale');
    // Back-compat: absent on either side stays permissive (legacy senders).
    expect(verifySealedAad({...base, ...mk(0), expectedEpoch: undefined} as never).ok).toBe(true);
    const noWireEpoch = {sealed: {aad: {ts: Date.now(), to: {userId: 'me', deviceId: 1}, groupId: 'g1'}}};
    expect(verifySealedAad({...base, ...noWireEpoch, expectedEpoch: lagged} as never).ok).toBe(true);
  });
});

/**
 * B-703 MR-7 — every bracketed receive append registers its own rollback
 * compensation. M9's recorded residue is "asymmetric rollback: a ROLLBACK undoes
 * the SQL write but not the Zustand append"; the compensation is what closes it,
 * and an append added later without one silently reopens the duplicate chain.
 */
describe('B-703 MR-7 — the receive appends are rollback-symmetric', () => {
  // `runtimeSrc` above is scoped to its own describe; this block owns its read.
  const runtimeSource = (): string => readFileSync(RUNTIME, 'utf8');

  it('all four bracketed sites compensate, and only when a row was really added', () => {
    const src = runtimeSource();
    const lines = src.split(/\r?\n/);
    const bracketed = lines
      .map((l: string, i: number) => ({l, i}))
      .filter(({l}: {l: string}) => l.includes('runWriteThroughSuppressed(() =>'));
    expect(bracketed).toHaveLength(4);

    // Each bracketed append must be immediately preceded by the existence
    // sample and followed by the compensation registration — sampling AFTER
    // the append always reads "it exists" and would disarm every one of them.
    for (const {i} of bracketed) {
      const before = lines.slice(Math.max(0, i - 2), i).join('\n');
      const after = lines.slice(i + 1, i + 3).join('\n');
      expect(before).toContain('receiveRowExists(');
      expect(after).toContain('compensateReceiveAppend(');
    }
  });

  it('the compensation refuses the two cases where removing a row would be data loss', () => {
    const src = runtimeSource();
    const fn = src.slice(src.indexOf('function compensateReceiveAppend('));
    const body = fn.slice(0, fn.indexOf('\n}'));
    // A deliberate dedup drop added nothing...
    expect(body).toContain('if (!committedId) {return;}');
    // ...and an append that UPDATED a row present before the txn must leave it.
    expect(body).toContain('if (existedBefore && committedId === wireId) {return;}');
    // The removal targets the id the store COMMITTED (a content-divergent
    // collision forks it), never the wire id.
    expect(body).toMatch(/removeMessage\(conversationId, committedId\)/);
  });

  it('the compensation is registered through the txn module, not hand-rolled', () => {
    expect(runtimeSource()).toMatch(/import \{[^}]*onRollback[^}]*\} from '\.\/receiveTransaction'/);
  });
});
