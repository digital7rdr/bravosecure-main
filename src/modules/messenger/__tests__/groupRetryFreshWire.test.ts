/**
 * B-683 F2/F4 wiring pins — source scans of productionRuntime.ts.
 *
 * No test imports productionRuntime.ts (native deps), so the F2 retry
 * wiring (fresh wire id + atomic artifact reset + old-row purge, all
 * BEFORE the fan-out) and the F4 boot-sweep artifact check are pinned by
 * scanning the source at the decision sites. A green test on the store
 * ACTION proves the guard is callable, not that the runtime calls it —
 * these scans close that gap (the "called vs obeyed" lesson).
 *
 * Scan hygiene (CLAUDE.md source-scan rules): the file is CRLF — no
 * \n-anchored regexes; //-comments are stripped line-based before any
 * absence assertion (prose mentioning the banned token is the classic
 * false result); every anchor is a CODE token inside the executing
 * branch, never a comment.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
  path.join(__dirname, '../runtime/productionRuntime.ts'),
  'utf8',
);

/** Line-based //-comment strip (leaves strings intact; repo style is //). */
function stripLineComments(s: string): string {
  return s
    .split(/\r?\n/)
    .map(l => {
      const i = l.indexOf('//');
      return i === -1 ? l : l.slice(0, i);
    })
    .join('\n');
}

/** The group send branch: from its opening guard to the 1:1 identity gate. */
function groupBranchSlice(): string {
  const start = SRC.indexOf('if (isGroup) {');
  const end = SRC.indexOf('const gatePeerId', start);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('group-branch anchors not found — re-grep the symbols');
  }
  return SRC.slice(start, end);
}

describe('B-683/F2 — the group retry lane re-ships under a fresh wire id', () => {
  const raw = groupBranchSlice();
  const code = stripLineComments(raw);

  it('mints a fresh wire id when the prior attempt was relay-accepted', () => {
    expect(code).toContain('let wireClientMsgId = clientMsgId;');
    expect(code).toContain('wireClientMsgId = makeId();');
    // The mint is gated on acceptance evidence, not on existingMsgId alone.
    expect(code).toContain('priorAccepted');
    expect(code).toMatch(/prior\?\.envelope_id/);
    expect(code).toMatch(/prior\?\.envelope_ids/);
    // Critic NIT-2 — the artifact reset must live INSIDE the priorAccepted
    // guard: an unconditional reset would wipe a never-accepted row's state.
    expect(code).toMatch(/if \(priorAccepted\) \{[\s\S]{0,900}?resetWireArtifactsForResend/);
  });

  it('resets EVERY round-1 wire artifact and purges the old outbox rows before the fan-out', () => {
    const reset = code.indexOf('resetWireArtifactsForResend(conversationId, msgId)');
    const purge = code.indexOf('deleteByClientMsgId(clientMsgId)');
    // F-2 (B-693) re-point — the flat allSettled became chunked waves; the
    // wave-loop head is the fan-out start now. Same ordering contract.
    const fanout = code.indexOf('const GROUP_FANOUT_WAVE');
    expect(reset).toBeGreaterThan(-1);
    expect(purge).toBeGreaterThan(-1);
    expect(fanout).toBeGreaterThan(-1);
    expect(reset).toBeLessThan(fanout);
    expect(purge).toBeLessThan(fanout);
  });

  it('every wire/outbox property in the branch carries the wire id, never the bubble id', () => {
    // The one legitimate bare-clientMsgId call is the OLD-row purge above.
    const scrubbed = code.replace(/deleteByClientMsgId\(clientMsgId\)/g, '')
      .replace(/let wireClientMsgId = clientMsgId;/g, '');
    expect(scrubbed).not.toMatch(/clientMsgId:\s*msgId\b/);
    expect(scrubbed).not.toMatch(/^\s*clientMsgId,\s*$/m);
    // Critic NIT-1 — also catch an inline shorthand ({outerSealed, clientMsgId}).
    expect(scrubbed).not.toMatch(/[{,]\s*clientMsgId\s*[},]/);
    expect(scrubbed).not.toMatch(/\b(?:resetFailed|markDelivered|recordAttempt)\(clientMsgId/);
    // The relay submit and the sealed payload both use the wire id.
    expect(code).toMatch(/clientMsgId:\s*wireClientMsgId/);
  });
});

describe('B-683 follow-up — the group auto-resend rides the F2 lane', () => {
  it('the resend-group branch re-sends through sendText/existingMsgId, never a bespoke fan-out', () => {
    const start = SRC.indexOf('const resendUndeliverable');
    const end = SRC.indexOf('let lastPongAt', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const closure = stripLineComments(SRC.slice(start, end));
    expect(closure).toContain("'resend-group'");
    // Rides the manual chip's exact lane (fresh wire id + atomic reset
    // + old-outbox purge all live inside sendText's F2 block).
    expect(closure).toMatch(/runtimeApi\.sendText\(gConvId, gMsg\.content \?\? '', \{\s*existingMsgId: gMsg\.id/);
    // The bubble leaves 'undelivered' BEFORE the send (retrySend parity) —
    // sendText's group lane owns every later state.
    const flip = closure.indexOf("updateMessageStatus(gConvId, gMsg.id, 'sending')");
    const send = closure.indexOf('runtimeApi.sendText(gConvId');
    expect(flip).toBeGreaterThan(-1);
    expect(flip).toBeLessThan(send);
  });
});

describe('B-683/F4 — the MSG-07 boot sweep honors acceptance artifacts', () => {
  it('an accepted-but-unflipped row boots to sent, not failed', () => {
    // B-703 MR-4 re-point: the four artifact tests were inlined here; they now
    // live in `runtime/sendAcceptance.ts` because the 1:1 HTTP-fallback catch
    // has to ask the identical question and a second copy would drift. The
    // sweep is pinned to the SHARED rule, and the rule's own cases (including
    // all four artifacts and the empty-map negatives) are pinned in
    // sendAcceptance.test.ts — strictly more coverage than the literals were.
    const at = SRC.indexOf("m.status === 'sending' && !outboxIds.has(m.id)");
    expect(at).toBeGreaterThan(-1);
    const block = stripLineComments(SRC.slice(at, at + 1200));
    expect(block).toMatch(/hasAcceptanceArtifact\(m\)\s*\?\s*'sent'\s*:\s*'failed'/);
  });

  it('the shared acceptance rule still covers every artifact the sweep relied on', () => {
    const rule = stripLineComments(
      fs.readFileSync(path.join(__dirname, '..', 'runtime', 'sendAcceptance.ts'), 'utf8'),
    );
    for (const artifact of ['m.envelope_id', 'm.retract_token', 'm.envelope_ids', 'm.retract_tokens']) {
      expect(rule).toContain(artifact);
    }
  });
});
