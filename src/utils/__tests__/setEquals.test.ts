/**
 * NAV-18/19 (2026-08-26 rapid-use audit) — the equality check that lets the
 * dept-channel focus effects keep the previous Set identity when nothing
 * changed, instead of invalidating the chat/groups list memos on every focus.
 */
import {sameIdSet} from '../setEquals';

describe('sameIdSet', () => {
  it('equal contents (any insertion order) compare equal', () => {
    expect(sameIdSet(new Set(['a', 'b']), new Set(['b', 'a']))).toBe(true);
    expect(sameIdSet(new Set(), new Set())).toBe(true);
    const s = new Set(['x']);
    expect(sameIdSet(s, s)).toBe(true);
  });

  it('any difference compares unequal', () => {
    expect(sameIdSet(new Set(['a']), new Set(['a', 'b']))).toBe(false);
    expect(sameIdSet(new Set(['a', 'b']), new Set(['a']))).toBe(false);
    expect(sameIdSet(new Set(['a']), new Set(['b']))).toBe(false);
  });
});
