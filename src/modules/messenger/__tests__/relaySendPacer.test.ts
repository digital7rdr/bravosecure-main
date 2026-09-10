/**
 * GF-1 — the relay caps `POST /envelopes` per authenticated user and a group
 * fan-out issues one submit PER MEMBER in parallel, so an unpaced fan-out 429s
 * its own tail. The pacer is the client half: a shared fixed-window budget
 * sized below the server cap, plus a Retry-After-driven cooldown.
 */

import {
  RELAY_SEND_WINDOW_MS,
  RELAY_SEND_BUDGET_PER_WINDOW,
  RETRY_AFTER_MIN_MS,
  RETRY_AFTER_MAX_MS,
  createRelaySendBucket,
  reserveSendSlot,
  noteThrottled,
  clampRetryAfterMs,
  isRateLimitError,
  retryAfterMsOf,
  withRelaySendSlot,
  resetRelaySendPacer,
} from '../runtime/relaySendPacer';

const T0 = 1_700_000_000_000;

describe('relaySendPacer — budget sizing', () => {
  test('stays below the relay cap RELAY-1 ships (300 per 60s)', () => {
    expect(RELAY_SEND_WINDOW_MS).toBe(60_000);
    expect(RELAY_SEND_BUDGET_PER_WINDOW).toBeLessThan(300);
    // A full MAX_GROUP_FANOUT (250) post must still fit in one window.
    expect(RELAY_SEND_BUDGET_PER_WINDOW).toBeGreaterThanOrEqual(250 - 10);
  });
});

describe('reserveSendSlot', () => {
  test('the whole first window is issued without delay', () => {
    const b = createRelaySendBucket(T0);
    for (let i = 0; i < RELAY_SEND_BUDGET_PER_WINDOW; i++) {
      expect(reserveSendSlot(b, T0)).toBe(0);
    }
  });

  test('the tail is PACED, not rejected', () => {
    const b = createRelaySendBucket(T0);
    for (let i = 0; i < RELAY_SEND_BUDGET_PER_WINDOW; i++) {reserveSendSlot(b, T0);}
    expect(reserveSendSlot(b, T0)).toBe(RELAY_SEND_WINDOW_MS);
  });

  test('windows chain instead of piling onto one', () => {
    const b = createRelaySendBucket(T0);
    for (let i = 0; i < 2 * RELAY_SEND_BUDGET_PER_WINDOW; i++) {reserveSendSlot(b, T0);}
    expect(reserveSendSlot(b, T0)).toBe(2 * RELAY_SEND_WINDOW_MS);
  });

  test('a fresh window refills the budget', () => {
    const b = createRelaySendBucket(T0);
    for (let i = 0; i < RELAY_SEND_BUDGET_PER_WINDOW; i++) {reserveSendSlot(b, T0);}
    expect(reserveSendSlot(b, T0 + RELAY_SEND_WINDOW_MS)).toBe(0);
  });
});

describe('noteThrottled', () => {
  test('honours the server Retry-After exactly', () => {
    const b = createRelaySendBucket(T0);
    noteThrottled(b, 7_000, T0);
    expect(reserveSendSlot(b, T0)).toBe(7_000);
  });

  test('resumes precisely when the cooldown lifts', () => {
    const b = createRelaySendBucket(T0);
    noteThrottled(b, 7_000, T0);
    expect(reserveSendSlot(b, T0 + 7_000)).toBe(0);
  });

  test('falls back to a full window when the relay sent no Retry-After', () => {
    const b = createRelaySendBucket(T0);
    noteThrottled(b, undefined, T0);
    expect(reserveSendSlot(b, T0)).toBe(RELAY_SEND_WINDOW_MS);
  });
});

describe('clampRetryAfterMs', () => {
  test('a hostile or buggy header cannot park or hot-loop the client', () => {
    expect(clampRetryAfterMs(1)).toBe(RETRY_AFTER_MIN_MS);
    expect(clampRetryAfterMs(600_000)).toBe(RETRY_AFTER_MAX_MS);
    expect(clampRetryAfterMs(undefined)).toBe(RELAY_SEND_WINDOW_MS);
    expect(clampRetryAfterMs(7_000)).toBe(7_000);
  });
});

describe('error shape helpers', () => {
  test('isRateLimitError matches only a 429', () => {
    expect(isRateLimitError({status: 429})).toBe(true);
    expect(isRateLimitError({status: 500})).toBe(false);
    expect(isRateLimitError({status: 403})).toBe(false);
    expect(isRateLimitError(new Error('nope'))).toBe(false);
    expect(isRateLimitError(null)).toBe(false);
    expect(isRateLimitError(undefined)).toBe(false);
  });

  test('retryAfterMsOf only trusts a positive finite number', () => {
    expect(retryAfterMsOf({retryAfterMs: 5_000})).toBe(5_000);
    expect(retryAfterMsOf({retryAfterMs: 0})).toBeUndefined();
    expect(retryAfterMsOf({retryAfterMs: -1})).toBeUndefined();
    expect(retryAfterMsOf({retryAfterMs: NaN})).toBeUndefined();
    expect(retryAfterMsOf({retryAfterMs: '5000'})).toBeUndefined();
    expect(retryAfterMsOf(new Error('x'))).toBeUndefined();
    expect(retryAfterMsOf(null)).toBeUndefined();
  });
});

describe('withRelaySendSlot', () => {
  afterEach(() => {
    jest.useRealTimers();
    resetRelaySendPacer(Date.now());
  });

  test('passes the result through when the bucket has tokens', async () => {
    resetRelaySendPacer(Date.now());
    await expect(withRelaySendSlot(async () => 'ok')).resolves.toBe('ok');
  });

  test('rethrows and arms the cooldown on a 429', async () => {
    resetRelaySendPacer(Date.now());
    const err = Object.assign(new Error('Too Many Requests'), {status: 429, retryAfterMs: 5_000});
    await expect(withRelaySendSlot(async () => {throw err;})).rejects.toBe(err);

    jest.useFakeTimers();
    const fn = jest.fn(async () => 'late');
    const pending = withRelaySendSlot(fn);
    await Promise.resolve();
    expect(fn).not.toHaveBeenCalled();

    jest.advanceTimersByTime(5_000);
    await expect(pending).resolves.toBe('late');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('resetRelaySendPacer drops an accumulated cooldown', async () => {
    resetRelaySendPacer(Date.now());
    const err = Object.assign(new Error('Too Many Requests'), {status: 429, retryAfterMs: 30_000});
    await expect(withRelaySendSlot(async () => {throw err;})).rejects.toBe(err);

    resetRelaySendPacer(Date.now());
    const fn = jest.fn(async () => 'now');
    await expect(withRelaySendSlot(fn)).resolves.toBe('now');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
