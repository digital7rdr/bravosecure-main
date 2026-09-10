import {readFileSync} from 'node:fs';
import {join} from 'node:path';

/**
 * Static source-scan regression for B-124 / B-125.
 *
 * `productionRuntime.ts` is 8k lines and no test can import it (see
 * bootGroupStashDrain.test.ts:12), so the behavioural rules that live inside
 * `sendText` are unreachable by a normal unit test. Both bugs shipped with a
 * fully green suite for exactly that reason.
 *
 * This pins the two structural invariants by reading the source, in the same
 * way alert.test.ts pins the Alert import boundary and
 * groupCallVideoEncodings.test.ts pins the per-platform encoding contract:
 *
 *   M1/M2 — ONE topology predicate. `sendText` must delegate to
 *           messagingLogic.isGroupConversation, never re-inline a copy. The
 *           inline copy drifted (it lacked the `direct` veto on the GroupState
 *           clause), so a throwaway 'Call' key filed at a 1:1 id by call
 *           escalation reclassified that chat as a group forever (B-124).
 *
 *   M3     — the optimistic bubble is appended BEFORE the membership/cap
 *           guards. ChatScreen clears the composer before awaiting, so a
 *           synchronous throw above the append destroys the user's typed text
 *           with no bubble and no retry chip (B-125, CRITICAL data loss).
 *
 * If either fails, do NOT relax this test — re-read
 * docs/audits/B124_B125_CALL_ESCALATION_CHAT_CONTAMINATION_2026-07-20.md.
 */

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');
const LOGIC   = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'messagingLogic.ts');

/** The body of `sendText`, sliced out by its neighbouring runtime methods. */
function sendTextBody(): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf('sendText: async');
  const end = src.indexOf('sendMedia:', start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('B-124/B-125 — message topology invariants (static source scan)', () => {
  it('M2: sendText delegates to messagingLogic.isGroupConversation', () => {
    // W6 — this used to match the local alias `isGroupConvo(`, which the lazy
    // `require` destructure introduced. With the static import the real exported
    // name is called directly, so pin THAT: an alias could be re-pointed at a
    // different function while this test stayed green.
    expect(sendTextBody()).toMatch(/isGroupConversation\(/);
  });

  it('M2: productionRuntime imports messagingLogic STATICALLY, not lazily', () => {
    // W6/W7 — a `require()` inside a function body creates no module-graph edge,
    // so `jest --changedSince` (the pre-push hook) cannot see that
    // productionRuntime depends on messagingLogic. The laziness bought nothing:
    // messagingLogic has zero imports, so it cannot participate in a cycle.
    const src = readFileSync(RUNTIME, 'utf8');
    expect(src).toMatch(/^import \{[\s\S]*?\} from '\.\/messagingLogic';$/m);
    // Strip comments first — the import's own `// Why:` block explains what it
    // replaced and therefore contains the banned string. Scanning raw source
    // here would fail on prose, which is a trap this repo has hit repeatedly.
    expect(stripComments(src)).not.toMatch(/require\(['"]\.\/messagingLogic['"]\)/);
  });

  it('M2: sendText does NOT re-inline a GroupState-presence topology test', () => {
    const body = sendTextBody();
    // `!!groupState` (or any bare groups[...] presence test) used as a
    // conversation-TYPE signal is the B-124 seam. Key material is a crypto
    // fact; ask messagingLogic for the topology instead.
    expect(body).not.toMatch(/!!\s*groupState/);
    expect(body).not.toMatch(/const\s+isGroup\s*=[\s\S]{0,400}?groups\[/);
  });

  it('M1: the GroupState clause in messagingLogic carries a `direct` veto', () => {
    const logic = readFileSync(LOGIC, 'utf8');
    const fnStart = logic.indexOf('export function isGroupConversation');
    expect(fnStart).toBeGreaterThan(-1);
    const body = stripComments(logic.slice(fnStart, logic.indexOf('\n}', fnStart)));

    // BEHAVIOUR, not naming. The previous version of this assertion pinned the
    // local variable names (`hasGroupState && !isDirectRow`) and went red when a
    // legitimate refactor renamed them to `groupStateCounts` — while the veto
    // was actually still there AND had been strengthened with a 'Call'-carrier
    // clause. A drift guard that pins identifiers cries wolf; pin what the code
    // DOES. The real behavioural coverage for this rule lives in
    // messagingLogic.test.ts, which imports and calls the function for every
    // B-124/B-125 shape.
    expect(body).toMatch(/state\.groups\[/);          // it does read key material
    expect(body).toMatch(/!==\s*'direct'/);           // ...gated on the row type
    // ...and never as a bare presence disjunct, which is the B-124 seam.
    expect(body).not.toMatch(/^\s*!!\s*\w+(\?\.\w+)*\s*\|\|\s*$/m);
    expect(body).not.toMatch(/^\s*hasGroupState\s*\|\|\s*$/m);
  });

  it('M3: the optimistic bubble is appended BEFORE the membership guard', () => {
    const body = sendTextBody();
    const append = body.indexOf('appendMessage(conversationId, msg)');
    const guard  = body.indexOf('participants.length === 0');
    expect(append).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(append).toBeLessThan(guard);
  });

  it('M3: the optimistic bubble is appended BEFORE the fan-out cap guard', () => {
    const body = sendTextBody();
    const append = body.indexOf('appendMessage(conversationId, msg)');
    const cap    = body.indexOf('MAX_GROUP_FANOUT');
    expect(cap).toBeGreaterThan(-1);
    expect(append).toBeLessThan(cap);
  });

  it('M3: both group guards flip the bubble to `failed` before throwing', () => {
    const body = sendTextBody();
    // retrySend (ChatScreen.tsx:741) sets 'sending' and its catch only shows a
    // banner — without this flip the message is stranded in 'sending' with a
    // dead retry chip.
    expect(body).toMatch(/failGroupSend\s*=\s*\([\s\S]{0,200}?updateMessageStatus\([^)]*'failed'\)/);
    expect(body).toMatch(/participants\.length === 0\)\s*\{\s*\n\s*failGroupSend\(/);
    expect(body).toMatch(/MAX_GROUP_FANOUT\)\s*\{\s*\n\s*failGroupSend\(/);
  });

  /** Strip `//` line and block comments so a scan sees CODE, not prose. */
  function stripComments(src: string): string {
    return src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
  }

  /** The 1:1 branch CODE (comments removed), from its header to sendText end. */
  function directBranchBody(): string {
    const body = sendTextBody();
    const start = body.indexOf('── 1:1 path');
    expect(start).toBeGreaterThan(-1);
    return stripComments(body.slice(start));
  }

  it('M3: the 1:1 optimistic bubble is appended BEFORE the peer-address guard', () => {
    // W26 — this guard used to THROW above the append, so a send with an
    // unresolved peer destroyed the typed text exactly like B-125 on the group
    // path. The append must come first.
    const body = directBranchBody();
    const append = body.indexOf('appendMessage(conversationId, msg)');
    const guard  = body.indexOf('if (!target.userId)');
    expect(append).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(append).toBeLessThan(guard);
  });

  it('M3: the 1:1 peer-address guard flips the bubble to `failed` before throwing', () => {
    const body = directBranchBody();
    expect(body).toMatch(/failDirectSend\s*=\s*\([\s\S]{0,200}?updateMessageStatus\([^)]*'failed'\)/);
    expect(body).toMatch(/if \(!target\.userId\)\s*\{\s*failDirectSend\(/);
  });

  it('M3: the TOFU send-gate sits BELOW the append and flips the bubble', () => {
    // This gate used to sit above BOTH branches' appends, with a comment
    // claiming that kept a blocked send from orphaning a 'sending' row. It did
    // the opposite: the composer is already cleared, so its silent `return`
    // destroyed the typed text and left only a banner — a latent B-125 that
    // would fire the moment EXPO_PUBLIC_STRICT_IDENTITY_SEND_GATE is enabled.
    const body = stripComments(sendTextBody());
    const gate = body.indexOf('isIdentitySendGateEnabled()');
    const append = body.indexOf('appendMessage(conversationId, msg)');
    expect(gate).toBeGreaterThan(-1);
    expect(append).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(append);
    // And it must fail the bubble rather than returning silently.
    expect(body).toMatch(/hasPendingIdentityAck\([\s\S]{0,400}?failDirectSend\(/);
  });

  it('M3: no `return;` sits above the FIRST optimistic append in sendText', () => {
    // The general form of the rule: any early exit before a bubble exists
    // destroys the user's typed text, because ChatScreen clears the composer
    // before awaiting. Guards belong below the append, behind a `failed` flip.
    const body = stripComments(sendTextBody());
    const append = body.indexOf('appendMessage(conversationId, msg)');
    expect(append).toBeGreaterThan(-1);
    expect(body.slice(0, append)).not.toMatch(/^\s*return;\s*$/m);
  });

  it('M3: the 1:1 branch has no bare `throw` above its append', () => {
    // Any throw between the "1:1 path" header and the append is a B-125 seam.
    const body = directBranchBody();
    const append = body.indexOf('appendMessage(conversationId, msg)');
    const preAppend = body.slice(0, append);
    expect(preAppend).not.toMatch(/\bthrow\b/);
  });
});
