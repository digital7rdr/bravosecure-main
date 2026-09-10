import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {directConvoAadId, expectedAadConversationId} from '../runtime/aadBinding';

/**
 * Seam S2 — which conversation the sealed AAD must be bound to.
 *
 * The AAD binds a ciphertext to a conversation so it cannot be replayed into a
 * different thread. Getting the EXPECTED id wrong does not fail loudly — every
 * affected message simply fails AAD verification and is dropped.
 */

const ALICE = 'alice-uuid';
const BOB   = 'bob-uuid';

describe('S2 — expectedAadConversationId', () => {
  it('uses the group id when the envelope carries one', () => {
    expect(expectedAadConversationId({groupId: 'g-1', ownUserId: ALICE, peerUserId: BOB}))
      .toBe('g-1');
  });

  it('uses the SYMMETRIC pair id for a 1:1, not either side local key', () => {
    // The trap: each device stores a 1:1 under its OWN local slot
    // (`direct:<the other person>`). If the AAD used that, the two sides would
    // never agree and every 1:1 message would fail verification and be dropped.
    const fromAlice = expectedAadConversationId({ownUserId: ALICE, peerUserId: BOB});
    const fromBob   = expectedAadConversationId({ownUserId: BOB,   peerUserId: ALICE});
    expect(fromAlice).toBe(fromBob);
    expect(fromAlice).not.toBe(`direct:${BOB}`);
    expect(fromAlice).not.toBe(`direct:${ALICE}`);
  });

  it('prefers the group id even when both user ids are supplied', () => {
    expect(expectedAadConversationId({groupId: 'g-2', ownUserId: BOB, peerUserId: ALICE}))
      .toBe('g-2');
  });
});

describe('S2 — directConvoAadId', () => {
  it('is symmetric — both directions derive the same string', () => {
    expect(directConvoAadId(ALICE, BOB)).toBe(directConvoAadId(BOB, ALICE));
  });

  it('sorts lexically so the result is locale- and platform-independent', () => {
    expect(directConvoAadId('b', 'a')).toBe('direct:a|b');
    expect(directConvoAadId('a', 'b')).toBe('direct:a|b');
  });

  it('is distinct from the per-side UI slot key', () => {
    // Local UI keys stay asymmetric on purpose (changing them would need a
    // migration). Splitting "AAD identity" from "local UI key" is what lets
    // both invariants hold — so the two formats must not collide.
    expect(directConvoAadId(ALICE, BOB)).not.toBe(`direct:${BOB}`);
    expect(directConvoAadId(ALICE, BOB)).toContain('|');
  });

  it('separates the two ids so distinct pairs cannot alias', () => {
    // Without the separator, ('ab','c') and ('a','bc') would collide.
    expect(directConvoAadId('ab', 'c')).not.toBe(directConvoAadId('a', 'bc'));
  });
});

describe('S2 — the runtime does not re-inline the binding rule', () => {
  it('productionRuntime holds no second copy of directConvoAadId', () => {
    // It had one, and the test suite had a THIRD (a mirror, because the
    // original was un-exported). Both are gone; a reappearance means the rule
    // can drift again, and drift here silently drops 1:1 messages.
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/function directConvoAadId\(/);
  });
});
