/**
 * Audit P0-N2 follow-up regression — the 1:1 AAD conversationId must
 * be SYMMETRIC across sender and receiver. The original P0-N2 fix
 * stamped `conversationId` straight from the screen-supplied value
 * (which is `direct:<peer.userId>` on whichever side computed it), so
 * Alice sent `direct:bob` while Bob expected `direct:alice` and every
 * 1:1 envelope was dropped server-side with `conversation_mismatch`.
 *
 * The fix wraps the value in `directConvoAadId(a, b)` which sorts the
 * pair lexically — both sides compute the same string regardless of
 * which side they're on.
 *
 * This test exercises the helper in isolation. The integration of the
 * helper into the send/receive paths is verified by manual smoke (boot
 * two devices, send 1:1, observe receiver renders) — the crypto suite
 * is Node-only and can't stand up two co-resident runtimes.
 */
import {test, describe, expect} from '@jest/globals';

// Seam S2 — this used to MIRROR the implementation, because the helper was
// un-exported inside productionRuntime.ts (not bundleable in this Jest
// project). Its own comment said "when the helper moves to a shared module,
// replace this with a real import" — done: it now lives in runtime/aadBinding.ts
// and this suite tests the REAL function. A mirror could drift silently, and
// drift here breaks 1:1 messaging outright.
import {directConvoAadId} from '../runtime/aadBinding';

describe('directConvoAadId — audit P0-N2 follow-up symmetric 1:1 AAD', () => {
  test('Alice→Bob and Bob→Alice compute the SAME id', () => {
    const aliceComputes = directConvoAadId('alice-uuid', 'bob-uuid');
    const bobComputes   = directConvoAadId('bob-uuid', 'alice-uuid');
    expect(aliceComputes).toBe(bobComputes);
  });

  test('distinct peer pairs get distinct ids', () => {
    expect(directConvoAadId('alice', 'bob'))
      .not.toBe(directConvoAadId('alice', 'carol'));
    expect(directConvoAadId('bob', 'alice'))
      .not.toBe(directConvoAadId('bob', 'carol'));
  });

  test('format is direct:<lex-smaller>|<lex-larger>', () => {
    expect(directConvoAadId('zeta', 'alpha')).toBe('direct:alpha|zeta');
    expect(directConvoAadId('alpha', 'zeta')).toBe('direct:alpha|zeta');
  });

  test('self-paired (degenerate) still produces a single deterministic id', () => {
    // Not used in production but verifying the helper handles it
    // without throwing or producing odd output.
    expect(directConvoAadId('me', 'me')).toBe('direct:me|me');
  });

  test('uuid-shaped inputs sort deterministically', () => {
    // Real production ids are uuids.
    const a = '11111111-1111-1111-1111-111111111111';
    const b = '22222222-2222-2222-2222-222222222222';
    expect(directConvoAadId(a, b)).toBe(directConvoAadId(b, a));
    expect(directConvoAadId(a, b)).toContain(a);
    expect(directConvoAadId(a, b)).toContain(b);
  });

  test('REGRESSION — the asymmetric direct:<peer.userId> shape is NOT what we ship now', () => {
    // Document why the old shape was wrong: Alice's sender code used
    // to stamp `direct:bob` (peer-from-Alice's-view) while Bob's
    // receiver computed `direct:alice` (peer-from-Bob's-view) — these
    // two strings disagreed and verifySealedAad rejected every 1:1
    // envelope with `conversation_mismatch`.
    const aliceOldStamp = 'direct:bob';
    const bobOldExpected = 'direct:alice';
    expect(aliceOldStamp).not.toBe(bobOldExpected);
    // The new helper produces a single value both sides agree on.
    const symmetric = directConvoAadId('alice', 'bob');
    expect(symmetric).toBe('direct:alice|bob');
    expect(symmetric).not.toBe(aliceOldStamp);
    expect(symmetric).not.toBe(bobOldExpected);
  });
});
