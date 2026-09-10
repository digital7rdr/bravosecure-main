/**
 * OM-07 — the drain sweep had no wall-clock bound. `drainOutbox` ships rows
 * serially and a black-holed route makes each `relay.send` hang for the full
 * 20s transport deadline, so N queued rows held the radio for N x 20s per 60s
 * sweep — and the sweep restarted the moment it ended.
 */

import {
  shouldStopDrain,
  OUTBOX_DRAIN_BUDGET_MS,
  OUTBOX_DRAIN_UNREACHABLE_STREAK,
} from '../runtime/outboxDrainBudget';

describe('shouldStopDrain', () => {
  const now = 1_700_000_000_000;

  test('continues on a fresh sweep', () => {
    expect(shouldStopDrain({startedAtMs: now, unreachableStreak: 0}, now)).toBe('continue');
  });

  test('one flaky row does not abort a sweep that could still deliver', () => {
    expect(shouldStopDrain({startedAtMs: now, unreachableStreak: 1}, now)).toBe('continue');
  });

  test('stops once the unreachable streak proves the network is down', () => {
    expect(
      shouldStopDrain({startedAtMs: now, unreachableStreak: OUTBOX_DRAIN_UNREACHABLE_STREAK}, now),
    ).toBe('unreachable');
  });

  test('stops when the wall-clock budget is spent', () => {
    expect(
      shouldStopDrain({startedAtMs: now, unreachableStreak: 0}, now + OUTBOX_DRAIN_BUDGET_MS),
    ).toBe('budget');
    expect(
      shouldStopDrain({startedAtMs: now, unreachableStreak: 0}, now + OUTBOX_DRAIN_BUDGET_MS - 1),
    ).toBe('continue');
  });

  test('reports the actionable reason when both hold', () => {
    expect(
      shouldStopDrain(
        {startedAtMs: now, unreachableStreak: OUTBOX_DRAIN_UNREACHABLE_STREAK + 3},
        now + OUTBOX_DRAIN_BUDGET_MS * 2,
      ),
    ).toBe('unreachable');
  });

  test('the budget ends a sweep before the next 60s tick', () => {
    expect(OUTBOX_DRAIN_BUDGET_MS).toBeLessThan(60_000);
  });
});
