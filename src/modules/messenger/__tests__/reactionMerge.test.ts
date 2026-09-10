/**
 * SYNC-7 — the one-emoji-per-reactor merge rule, pinned so the receive path
 * and the pending-reaction drain can never diverge.
 */

import {mergeReaction} from '../runtime/reactionMerge';

describe('SYNC-7 — mergeReaction', () => {
  it('adds a reactor to an empty/undefined map', () => {
    expect(mergeReaction(undefined, 'u1', '👍', false)).toEqual({u1: '👍'});
  });

  it('replaces the same reactor (one emoji per reactor)', () => {
    expect(mergeReaction({u1: '👍'}, 'u1', '❤️', false)).toEqual({u1: '❤️'});
  });

  it('remove deletes only that reactor', () => {
    expect(mergeReaction({u1: '👍', u2: '🎉'}, 'u1', '👍', true)).toEqual({u2: '🎉'});
  });

  it('replaying the same patch is idempotent', () => {
    const once = mergeReaction({u2: '🎉'}, 'u1', '👍', false);
    const twice = mergeReaction(once, 'u1', '👍', false);
    expect(twice).toEqual(once);
    const removedOnce = mergeReaction(once, 'u1', '👍', true);
    expect(mergeReaction(removedOnce, 'u1', '👍', true)).toEqual(removedOnce);
  });

  it('never mutates the input map', () => {
    const input = {u1: '👍'};
    mergeReaction(input, 'u2', '🎉', false);
    mergeReaction(input, 'u1', 'x', true);
    expect(input).toEqual({u1: '👍'});
  });
});
