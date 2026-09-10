import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source scan of the edit / delete-for-everyone wiring in
 * `productionRuntime.ts`.
 *
 * Why a source scan and not a unit test: no test imports `productionRuntime.ts`
 * — it transitively pulls in react-native and cannot load in the node jest
 * project. That is exactly the hole B-124/B-125 went through, and it is why
 * this repo pins unreachable rules by reading the file as TEXT
 * (messageTopologyInvariants, receivePersistenceInvariants, receivePathParity).
 *
 * The DECISIONS are tested for real elsewhere — messageMutationGate.test.ts and
 * messageMutationApply.test.ts. What can only be pinned here is that the
 * production receive and send paths are actually WIRED to them: a lane that is
 * never called is invisible to a behavioural test and green everywhere.
 *
 * TRAPS this file is written around (both have cost this repo a session):
 *  - line endings. On a CRLF checkout a `\n`-anchored regex matches nothing and
 *    the test passes VACUOUSLY, so `runtimeSource()` normalizes CRLF away and
 *    every assertion below reads the normalized text.
 *  - Prose containing a banned word is the most common false result, so every
 *    ordering/absence assertion runs on COMMENT-STRIPPED source.
 */

const RUNTIME_DIR = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime');
const RUNTIME = join(RUNTIME_DIR, 'productionRuntime.ts');

// Why: the scan must read identically on a CRLF and an LF checkout.
function normalizeEol(src: string): string {
  return src.replace(/\r\n/g, '\n');
}

function runtimeSource(): string {
  return normalizeEol(readFileSync(RUNTIME, 'utf8'));
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function runtimeCode(): string {
  return stripComments(runtimeSource());
}

/** Body of `doHandleIncoming`, sliced by its neighbouring top-level function. */
function doHandleIncomingCode(): string {
  const src = runtimeSource();
  const start = src.indexOf('async function doHandleIncoming(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nfunction applyReaction(', start);
  expect(end).toBeGreaterThan(start);
  return stripComments(src.slice(start, end));
}

/** Body of the shared `runMutationEnvelope` receive lane. */
function mutationLaneCode(): string {
  const src = runtimeSource();
  const start = src.indexOf('async function runMutationEnvelope(');
  expect(start).toBeGreaterThan(-1);
  // Next top-level declaration after it.
  const end = src.indexOf('\n/**', start + 10);
  expect(end).toBeGreaterThan(start);
  return stripComments(src.slice(start, end));
}

describe('line endings cannot make this scan pass vacuously', () => {
  it('CRLF is normalized away, so a bare \\n anchor matches on either checkout', () => {
    expect(normalizeEol('a\r\nb')).toBe('a\nb');
    expect(runtimeSource()).not.toContain('\r');
  });
});

describe('receive — BOTH lanes are wired, and both go through ONE entry point', () => {
  it('doHandleIncoming calls runMutationEnvelope exactly twice', () => {
    // Once for the group-stamped directive, once for the 1:1. Two is the
    // correct number: a third would mean a lane was copied rather than routed,
    // which is precisely the M5 divergence class.
    const calls = doHandleIncomingCode().match(/runMutationEnvelope\(/g) ?? [];
    expect(calls).toHaveLength(2);
  });

  it('the GROUP directive is handled ABOVE the group-parse path', () => {
    // An edit/delete is a pairwise CONTROL envelope with an EMPTY body carrying
    // only a group routing hint. If it reached `parseGroupMessage` below, the
    // empty body would be fed to the group decoder and dropped — the exact
    // MSG-02 bug that made group reactions invisible to everyone but the
    // reactor.
    //
    // Anchored on the CALL, not on the literal text of the `if` condition. An
    // earlier version of this test pinned the condition string and went red the
    // moment the condition was hoisted into a named boolean — a refactor that
    // changed nothing about the ordering rule. Pin the property, not the
    // phrasing (MESSAGE_LOOP §11 trap 5).
    const code  = doHandleIncomingCode();
    const lane  = code.indexOf('runMutationEnvelope(');
    const parse = code.indexOf('parseGroupMessage(');
    expect(lane).toBeGreaterThan(-1);
    expect(parse).toBeGreaterThan(-1);
    expect(lane).toBeLessThan(parse);
  });

  it('the group lane passes groupState so the membership gate can run', () => {
    // Omitting it silently fails OPEN — a non-member could edit or delete into
    // any group whose id they knew. This is verbatim the B-128 hole.
    const code = doHandleIncomingCode();
    const idx = code.indexOf('runMutationEnvelope(');
    const groupCall = code.slice(idx, idx + 400);
    expect(groupCall).toContain('groupState:');
    expect(groupCall).toContain('.groups[unwrapped.group.groupId]');
  });

  it('the 1:1 lane deliberately passes NO groupState', () => {
    const code = doHandleIncomingCode();
    const last = code.lastIndexOf('runMutationEnvelope(');
    const directCall = code.slice(last, last + 200);
    expect(directCall).not.toContain('groupState');
  });
});

describe('runMutationEnvelope — the ack + persistence contract', () => {
  it('delegates the DECISION to applyMessageMutation rather than re-implementing it', () => {
    // The gate lives in a Tier-A module with real tests. A hand-rolled check in
    // here would be invisible to them.
    expect(mutationLaneCode()).toContain('applyMessageMutation(');
  });

  it('never calls decideMessageMutation directly — the gate is reached through the applier', () => {
    // Two entry points into the gate means two places to forget the stash tier.
    expect(mutationLaneCode()).not.toContain('decideMessageMutation(');
  });

  it('M9 — persists the committed row with an AWAITED upsert inside the txn', () => {
    // Un-awaited, the write lands after COMMIT and after the relay ack, so a
    // crash loses an edit the sender was already told had been delivered.
    expect(mutationLaneCode()).toMatch(/await\s+sqlMessages\.upsert\(/);
  });

  it('M9 — does NOT use upsertCoalesced on the receive path', () => {
    // The coalesced write is the deferred 50 ms subscriber. That is precisely
    // what W9 had to remove from the reaction lane.
    expect(mutationLaneCode()).not.toContain('upsertCoalesced');
  });

  it('W11 — a DROPPED directive notes the envelope so the sender is acked discarded', () => {
    const code = mutationLaneCode();
    expect(code).toContain('noteDestroyedEnvelope(');
    // ...and only for drops. An applied or stashed directive is a real success
    // and must keep its ✓✓.
    const noteIdx = code.indexOf('noteDestroyedEnvelope(');
    const guard = code.slice(Math.max(0, noteIdx - 120), noteIdx);
    expect(guard).toContain("outcome.kind === 'dropped'");
  });

  it('M10 — the lane never acks the relay itself; acking is the caller\'s job', () => {
    expect(mutationLaneCode()).not.toContain('relay.ack(');
  });
});

describe('the stash drain is wired at EVERY point a message row lands', () => {
  it('drainPendingMutationsFor is called as often as drainPendingReactionsFor', () => {
    // Both stashes exist for the same reason and are drained by the same event
    // (an inbound row being persisted). If one is called at four sites and the
    // other at three, a lane silently never replays — which for a delete means
    // retracted content stays on screen forever.
    const code = runtimeCode();
    const reactions = code.match(/drainPendingReactionsFor\(/g) ?? [];
    const mutations = code.match(/drainPendingMutationsFor\(/g) ?? [];
    expect(mutations.length).toBe(reactions.length);
    expect(mutations.length).toBeGreaterThanOrEqual(4);
  });

  it('the stash store is installed AND nulled on dispose', () => {
    // Without the disposer a logout→login rebuild writes into the previous
    // user's DB — the reason setPendingReactionStore(null) exists.
    const code = runtimeCode();
    expect(code).toContain('setPendingMutationStore(mutationStash)');
    expect(code).toMatch(/liveDisposers\.push\(\(\) => setPendingMutationStore\(null\)\)/);
  });

  it('a boot sweep runs for mutations, like it does for reactions', () => {
    expect(runtimeCode()).toContain('sweepPendingMutations(');
  });
});

describe('send — the window and authorship are re-checked in the runtime', () => {
  it('sendMessageEdit gates on canEditOwnMessage', () => {
    // The action sheet also checks, but a sheet left open past the deadline
    // must not be able to ship a directive every recipient would refuse.
    const code = runtimeCode();
    const idx = code.indexOf('sendMessageEdit:');
    expect(idx).toBeGreaterThan(-1);
    expect(code.slice(idx, idx + 700)).toContain('canEditOwnMessage(');
  });

  it('sendDeleteForEveryone gates on canDeleteForEveryone', () => {
    const code = runtimeCode();
    const idx = code.indexOf('sendDeleteForEveryone:');
    expect(idx).toBeGreaterThan(-1);
    expect(code.slice(idx, idx + 700)).toContain('canDeleteForEveryone(');
  });

  it('delete-for-everyone retracts the relay copy and purges the media blob', () => {
    // The retract is the only leg that reaches a recipient who has not drained
    // yet — they never receive the original, so they never need the directive.
    // The blob purge is A10 parity with the expiry sweeper: without it a
    // retracted photo stays re-downloadable with the in-band key for the whole
    // 30-day grant window.
    const code = runtimeCode();
    const idx = code.indexOf('sendDeleteForEveryone:');
    const body = code.slice(idx, idx + 2200);
    expect(body).toContain('relay.retract(');
    expect(body).toContain('mediaCache.remove(');
    expect(body).toContain('mediaClient.purge(');
  });

  it('both send paths share ONE fan-out helper', () => {
    // Two copies of the fan-out is how the reaction lane and the text lane
    // drifted. Exactly one definition, exactly two callers.
    const code = runtimeCode();
    expect(code.match(/const sendMutationDirective\s*=/g) ?? []).toHaveLength(1);
    expect(code.match(/await sendMutationDirective\(/g) ?? []).toHaveLength(2);
  });

  it('the directive envelope is non-urgent — it renders no banner (P2-11)', () => {
    const code = runtimeCode();
    const idx = code.indexOf('const sendMutationDirective');
    const body = code.slice(idx, idx + 3500);
    expect(body).toContain('urgent: false');
  });

  it('the directive writes a durable outbox row (MSG-08)', () => {
    const code = runtimeCode();
    const idx = code.indexOf('const sendMutationDirective');
    expect(code.slice(idx, idx + 3500)).toContain('buildMutationSealedOutboxPayload(');
  });

  it('the directive AAD is the bare {to, ts} stamp — widening it is a stop-condition', () => {
    const code = runtimeCode();
    const idx = code.indexOf('const sendMutationDirective');
    const body = code.slice(idx, idx + 3500);
    expect(body).toMatch(/aad:\s*\{to,\s*ts:\s*Date\.now\(\)\}/);
    // Belt and braces: no conversation/group binding smuggled in. Changing the
    // AAD shape changes what the RECEIVER must expect, and that is a
    // CLAUDE.md stop-condition needing sign-off (B-128 part 2).
    const aadIdx = body.indexOf('aad: {to,');
    expect(body.slice(aadIdx, aadIdx + 80)).not.toContain('conversationId');
  });
});

describe('mentions ride every send site (the B-144 lesson)', () => {
  /**
   * The argument text of every `sealPayload(...)` call — i.e. everything that
   * actually reaches the WIRE. Paren-matched rather than a fixed window,
   * because these calls vary from 6 to 20 lines.
   *
   * Local outbox rows and optimistic store rows also carry a `mentions:` key
   * and MUST keep it (that is where the author's own highlight comes from), so
   * a file-wide grep cannot answer this question — it was the first thing I got
   * wrong here. Only sealPayload bodies are the wire.
   */
  function sealPayloadBodies(): string[] {
    const code = runtimeCode();
    const out: string[] = [];
    let i = code.indexOf('sealPayload(');
    while (i !== -1) {
      let depth = 0;
      let j = i + 'sealPayload'.length;
      for (; j < code.length; j++) {
        if (code[j] === '(') {depth++;}
        else if (code[j] === ')') { depth--; if (depth === 0) {break;} }
      }
      out.push(code.slice(i, j + 1));
      i = code.indexOf('sealPayload(', j);
    }
    return out;
  }

  /** The same body with every `group: { … }` sub-object removed. */
  function withoutGroupCarrier(body: string): string {
    const g = body.indexOf('group:');
    if (g === -1) {return body;}
    const open = body.indexOf('{', g);
    if (open === -1) {return body;}
    let depth = 0;
    let k = open;
    for (; k < body.length; k++) {
      if (body[k] === '{') {depth++;}
      else if (body[k] === '}') { depth--; if (depth === 0) {break;} }
    }
    return withoutGroupCarrier(body.slice(0, g) + body.slice(k + 1));
  }

  it('NO wire site emits a top-level `mentions` key', () => {
    // THE WIRE-COMPAT RULE. `isSealedPayload` rejects unknown TOP-LEVEL keys,
    // so a client built before `mentions` existed destroys any envelope that
    // carries one — field-confirmed: a mention-bearing group message reached
    // nobody on the old build, while the same text without one arrived.
    // Mentions therefore ride inside `group`, which the guard type-checks but
    // never key-iterates. See SealedGroup and wireBackCompat.test.ts.
    //
    // This assertion replaced one that counted top-level `mentions:` sites and
    // required them to PAIR with `replyTo:` — i.e. it pinned the broken
    // arrangement in place. Counting the wrong thing is not a weaker test; it
    // is a test that defends the bug.
    const offenders = sealPayloadBodies()
      .map(withoutGroupCarrier)
      .filter(b => /\bmentions:/.test(b));
    expect(offenders).toEqual([]);
  });

  it('...and the same holds for the edit / deleteFor directives in a group', () => {
    // A group directive rides in the carrier too. The 1:1 case legitimately has
    // no carrier and stays top-level — pinned as a documented gap in
    // wireBackCompat.test.ts, not silently allowed here.
    const groupDirectiveCarrier = sealPayloadBodies().filter(
      b => /group:\s*\{[\s\S]*?(edit|deleteFor):/.test(b),
    );
    expect(groupDirectiveCarrier.length).toBeGreaterThanOrEqual(2); // live send + reseal
  });

  it('the group send + group reseal both carry mentions INSIDE the group stamp', () => {
    // Still the B-144 lesson: the drain re-seals from the stored row, so a
    // branch that drops the field ships a stripped envelope and nothing fails.
    // Only the carrier changed, not the requirement.
    const withMentions = sealPayloadBodies().filter(b => /group:\s*\{[\s\S]*?mentions:/.test(b));
    expect(withMentions).toHaveLength(2);
  });

  it('the optimistic LOCAL row still carries mentions', () => {
    // Local storage is not the wire — the author's own bubble must render the
    // highlight immediately, not only after a restart rehydrates it from
    // SQLite. That "author sees something different from everyone else" shape
    // is what let B-144 survive manual testing.
    //
    // B-450 RECLASSIFIED — scope narrowed from the whole file to `sendText`.
    // A THIRD row matching this shape now exists (`sendMedia`'s optimistic
    // bubble, which B-450 taught to carry a quote), and it is deliberately
    // mentions-free — see the case below. The count is still 2 because the rule
    // is about sendText's TWO branches, which is what it always meant; a
    // file-wide match just happened to be exact at the time it was written.
    const code = runtimeCode();
    const send = code.slice(code.indexOf('sendText: async'), code.indexOf('sendMedia: async'));
    expect(send.length).toBeGreaterThan(1_000);
    const localRows = send.match(/reply_to_preview:\s+replyMeta\?\.preview,[\s\S]{0,80}/g) ?? [];
    expect(localRows).toHaveLength(2);
    for (const m of localRows) {
      expect(m).toContain('mentions:');
    }
  });

  it('B-450: sendMedia\'s bubble carries the quote and, for now, no mentions', () => {
    // Not an oversight and not an exemption. A media bubble's body is
    // `mediaOpts.caption`, and NO caller supplies one today (neither
    // ChatScreen's nor DepartmentChatScreen's `sendPickedMedia` passes
    // `caption`), so there is no text for a mention to span. Shipping an empty
    // `mentions: []` would be dead state that a later reader mistakes for
    // support.
    //
    // WHEN A CAPTION COMPOSER LANDS: this must become the same pair rule as
    // sendText above — the bubble takes `mentions`, and `sendMedia` forwards
    // them to `sendText` beside `replyTo`. Both halves, or the author's own
    // bubble renders a caption the recipients see highlighted and they do not.
    const code = runtimeCode();
    const media = code.slice(code.indexOf('sendMedia: async'), code.indexOf('downloadMedia: async'));
    const rows = media.match(/reply_to_preview:\s+replyMeta\?\.preview,[\s\S]{0,80}/g) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toContain('mentions:');
    // The premise the exemption rests on. If a caller starts passing a caption,
    // this flips and forces the pair rule above to be applied here too.
    for (const screen of ['ChatScreen.tsx', 'DepartmentChatScreen.tsx']) {
      const src = normalizeEol(readFileSync(
        join(process.cwd(), 'src', 'screens', 'messenger', screen), 'utf8'));
      expect(stripComments(src)).not.toMatch(/caption:/);
    }
  });

  it('the receive path reads the carrier FIRST, then the legacy top level', () => {
    // Accepting both keeps a peer mid-rollout working; only the EMIT side is
    // one-way.
    const code = runtimeCode();
    expect(code).toMatch(/unwrapped\.group\?\.edit\s*\?\?\s*unwrapped\.edit/);
    expect(code).toMatch(/unwrapped\.group\?\.deleteFor\s*\?\?\s*unwrapped\.deleteFor/);
  });

  it('the reseal knows the mutation kind', () => {
    expect(runtimeCode()).toContain("payload.resealKind === 'mutation'");
  });
});
