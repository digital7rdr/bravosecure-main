/**
 * AUDIT-2026-08-13 #19 — flavored id types + the ONE `direct:` grammar.
 *
 * Three gates in one suite:
 *  1. behavioral — the grammar module's build/parse/predicate round-trips;
 *  2. type-level — the audit's verified swap-compiles-fine signatures now
 *     REJECT cross-flavor swaps (`@ts-expect-error` pins, enforced by
 *     `npm run typecheck`: if a flavor regresses to a bare alias the
 *     directive goes unused, which IS a tsc error against the baseline);
 *  3. source scans — the inlined `direct:` parse is dead outside the
 *     grammar module, and the seam signatures keep their flavors.
 */
import {readFileSync, readdirSync, statSync} from 'node:fs';
import {join} from 'node:path';
import {
  DIRECT_PREFIX,
  directSlotId,
  isDirectPrefixed,
  isDirectAadId,
  peerFromDirectSlot,
} from '../conversationIds';
import type {
  ConversationId,
  GroupId,
  DirectSlotId,
  MessageId,
  ClientMsgId,
  EnvelopeId,
  UserId,
} from '../conversationIds';

const MOD_ROOT = join(__dirname, '..');

describe('AUDIT #19 — the grammar module', () => {
  it('builds and parses the slot grammar round-trip', () => {
    const slot = directSlotId('u-alice' as UserId);
    expect(slot).toBe('direct:u-alice');
    expect(isDirectPrefixed(slot)).toBe(true);
    expect(peerFromDirectSlot(slot)).toBe('u-alice');
  });

  it('distinguishes the two grammars sharing the prefix', () => {
    // Grammar B (`direct:<lo>|<hi>`, built by aadBinding.directConvoAadId)
    // is NOT a slot id: slicing it yields "lo|hi", not a userId. The
    // predicate is how consumers keep them apart.
    expect(isDirectAadId('direct:a|b')).toBe(true);
    expect(isDirectAadId('direct:u-alice')).toBe(false);
    expect(isDirectAadId('grp-uuid')).toBe(false);
    // The parser-on-grammar-B contract (raw pair + warn) is pinned in its
    // own guard test below.
  });

  it('the prefix constant is the only spelling', () => {
    expect(DIRECT_PREFIX).toBe('direct:');
  });
});

describe('AUDIT #19 — cross-flavor swaps are compile errors (type-level pins)', () => {
  // Never called — these exist for tsc, not the runtime. Each
  // expect-error directive below is load-bearing: if the flavors regress
  // to bare aliases it goes UNUSED, and tsc reports that as an error.
  // (TS treats ANY comment beginning with the directive token as a real
  // directive — which is why this prose spells it "expect-error".)
  function _typeOnly(): void {
    const conversationId = 'c1' as ConversationId;
    const groupId = 'g1' as GroupId;
    const slotId = 'direct:u1' as DirectSlotId;
    const messageId = 'm1' as MessageId;
    const clientMsgId = 'cm1' as ClientMsgId;
    const envelopeId = 'e1' as EnvelopeId;
    const _userId = 'u1' as UserId;
    void _userId;

    // The subtype lattice: group/slot ids ARE conversation ids…
    const asConvo1: ConversationId = groupId;
    const asConvo2: ConversationId = slotId;
    // …and plain strings assign to every flavor (zero retrofit cascade).
    const plain: ConversationId = 'anything';

    // The B-124 class — a conversation/group id where a message id goes:
    // @ts-expect-error — MessageId must not accept a ConversationId
    const swap1: MessageId = conversationId;
    // @ts-expect-error — ConversationId must not accept a MessageId
    const swap2: ConversationId = messageId;
    // The B-143 class — envelope vs client-msg ids in the outbox/ticks:
    // @ts-expect-error — EnvelopeId must not accept a ClientMsgId
    const swap3: EnvelopeId = clientMsgId;
    // @ts-expect-error — ClientMsgId must not accept an EnvelopeId
    const swap4: ClientMsgId = envelopeId;
    // The three-string PushService shape — user vs call ids:
    // @ts-expect-error — UserId must not accept a ConversationId
    const swap5: UserId = conversationId;
    // ConversationId is the supertype, so the REVERSE must fail:
    // @ts-expect-error — GroupId must not accept a ConversationId
    const swap6: GroupId = conversationId;

    void [asConvo1, asConvo2, plain, swap1, swap2, swap3, swap4, swap5, swap6];
  }
  void _typeOnly;

  it('compiles (the assertions above are tsc-time)', () => {
    expect(typeof directSlotId).toBe('function');
  });
});

describe('AUDIT #19 — the inlined direct: parse is dead outside the grammar module', () => {
  function productionFiles(dir: string, acc: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) {
        if (name === '__tests__' || name === '__stubs__' || name === 'node_modules') {continue;}
        productionFiles(p, acc);
      } else if (/\.tsx?$/.test(name)) {
        acc.push(p);
      }
    }
    return acc;
  }

  const stripComments = (src: string): string =>
    src.split(/\r?\n/)
      .filter(l => {
        const t = l.trim();
        return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
      })
      .join('\n');

  it('no production file under src/ re-inlines a direct: parse in ANY spelling', () => {
    // Widened per two review rounds: rooted at src/ (screens/navigation
    // carry direct: predicates, making them the likeliest site of the
    // next re-inline), all three slice-family METHODS, all three QUOTE
    // spellings, the regex-replace form, and the magic-number .slice(7)
    // gated on the file naming the prefix in ANY form (a file importing
    // DIRECT_PREFIX and writing .slice(7) was invisible to the
    // literal-gated version — edge-proven survivor).
    //
    // The boundary is CHOSEN, not overlooked: computed-prefix forms
    // (`split(':')[1]`, `indexOf(':') + 1`, `'dir' + 'ect:'`) name no
    // token a scan can anchor on without unusable false positives.
    // Someone writing those is evading a rule they know about — that is
    // a review problem, not a scan problem.
    const SRC_ROOT = join(MOD_ROOT, '..', '..');
    const QUOTE_PREFIX = /["'`]direct:["'`]/;
    const offenders: string[] = [];
    for (const f of productionFiles(SRC_ROOT)) {
      if (f.endsWith('conversationIds.ts')) {continue;}
      const code = stripComments(readFileSync(f, 'utf8'));
      const namesPrefix = QUOTE_PREFIX.test(code) || /\bDIRECT_PREFIX\b/.test(code);
      const inlined =
        /\.(slice|substring|substr)\(["'`]direct:["'`]\.length\)/.test(code) ||
        /\.(slice|substring|substr)\(DIRECT_PREFIX\.length\)/.test(code) ||
        /\.replace\(["'`]direct:["'`]/.test(code) ||
        /\.replace\(\/\^?direct:/.test(code) ||
        /\.split\(["'`]direct:["'`]/.test(code) ||
        (namesPrefix && /\.(slice|substring|substr)\(7\)/.test(code));
      if (inlined) {offenders.push(f);}
    }
    expect(offenders).toEqual([]);
  });

  it('the grammar-B hazard is guarded at the single site that can produce it', () => {
    // A DirectAadId (`direct:lo|hi`) flowing as a plain ConversationId
    // type-checks into peerFromDirectSlot by design (the supertype union
    // is intentional for AAD-position use). The parse then yields
    // "lo|hi" — a garbage userId. No live path does this today, so the
    // guard is a release-visible warn, not a behavior change.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // Plain strings still assign (the weak-brand contract)…
      const out = peerFromDirectSlot('direct:a|b');
      expect(out).toBe('a|b'); // behavior-preserving contract holds
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('grammar-B');
      warn.mockClear();
      peerFromDirectSlot('direct:u-alice');
      expect(warn).not.toHaveBeenCalled(); // grammar A stays silent
    } finally {
      warn.mockRestore();
    }
  });

  it('a TYPED aad id cannot reach the slot parser at all (edge — compile-time layer)', () => {
    // The runtime warn above is the second layer; the first is the
    // parameter type: DirectSlotId only, so DirectAadId and the
    // ConversationId union that could be carrying one both reject.
    function _typeOnly(): void {
      const aadId = 'direct:a|b' as import('../conversationIds').DirectAadId;
      const convoId = 'c1' as ConversationId;
      // @ts-expect-error — peerFromDirectSlot must reject a DirectAadId
      peerFromDirectSlot(aadId);
      // @ts-expect-error — and a ConversationId, which could be carrying one
      peerFromDirectSlot(convoId);
    }
    void _typeOnly;
    expect(typeof peerFromDirectSlot).toBe('function');
  });

  it('the canonical predicate delegates to the grammar module (no drifted copy)', () => {
    const src = readFileSync(join(MOD_ROOT, 'runtime', 'messagingLogic.ts'), 'utf8');
    const lines = src.split(/\r?\n/).map(l => l.trim());
    expect(lines.some(l => l.startsWith('return isDirectPrefixed(conversationId);'))).toBe(true);
  });
});

describe('AUDIT #19 — the seam signatures keep their flavors (source pins)', () => {
  const pin = (rel: string[], anchors: string[]): void => {
    const src = readFileSync(join(MOD_ROOT, ...rel), 'utf8');
    const lines = src.split(/\r?\n/).map(l => l.trim());
    for (const a of anchors) {
      expect(lines.some(l => l.startsWith(a))).toBe(true);
    }
  };

  it('updateMessageStatus / Bulk demand ConversationId + MessageId', () => {
    pin(['store', 'messengerStore.ts'], [
      'updateMessageStatus: (conversationId: ConversationId, messageId: MessageId, status: MessageStatus) => void;',
      'updateMessageStatusBulk: (conversationId: ConversationId, messageIds: readonly MessageId[], status: MessageStatus) => void;',
    ]);
  });

  it('markDelivered demands ClientMsgId + UserId + SignalDeviceId', () => {
    pin(['store', 'sqlOutboxStore.ts'], [
      'clientMsgId: ClientMsgId,',
      'peerUserId: UserId,',
      'peerDeviceId: SignalDeviceId,',
    ]);
  });

  it('setCallKeyMapping demands ConversationId origin + GroupId key (the B-106/B-124 seam)', () => {
    pin(['runtime', 'callKeyRegistry.ts'], [
      'export function setCallKeyMapping(originId: ConversationId, keyGroupId: GroupId): string | undefined {',
    ]);
  });

  it('processIncoming demands ConversationId (both the interface and the impl)', () => {
    const src = readFileSync(join(MOD_ROOT, 'runtime', 'runtime.ts'), 'utf8');
    const hits = src.split(/\r?\n/).map(l => l.trim())
      .filter(l => l.startsWith('conversationId: ConversationId,')).length;
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});
