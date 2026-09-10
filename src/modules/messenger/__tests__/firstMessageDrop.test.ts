import {DecryptError, NoSessionError} from '@bravo/messenger-core';
import {
  isRecoverableDecryptError,
  decideRecoveryDisposition,
  shouldRetry,
  note,
  clear,
  LeaveOnRelayError,
  FIRST_MSG_RETRY_CAP,
  FIRST_MSG_RETRY_MAX_AGE_MS,
  _firstMsgRetryBudgetSize,
  _resetFirstMessageRetryBudget,
} from '../runtime/firstMessageRetryBudget';

/**
 * B-30 — first inbound 1:1 message on a (re)established session was ACK-dropped
 * (hard delete on the relay) and permanently lost. The receive path now (a)
 * recognizes NoSessionError as recoverable (not just DecryptError) and (b)
 * leaves the triggering envelope on the relay for a BOUNDED number of
 * redeliveries so it can decrypt once the session is rebuilt — except for the
 * P0-1 `protected` (likely-forged) reason, which stays ACK-drop.
 *
 * The receive orchestration (handleIncoming/handleDeliver/drainRelay) is
 * module-private, so — per this codebase's convention — these tests pin the
 * exported decision logic that drives it.
 */
describe('B-30 firstMessageRetryBudget', () => {
  beforeEach(() => {
    _resetFirstMessageRetryBudget();
  });
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('isRecoverableDecryptError — classify the own.decrypt failures a rebuild can fix', () => {
    it('treats DecryptError as recoverable', () => {
      expect(isRecoverableDecryptError(new DecryptError('bad mac'))).toBe(true);
    });

    it('treats NoSessionError as recoverable (the B-30 fix — was escaping before)', () => {
      expect(isRecoverableDecryptError(new NoSessionError('user.1'))).toBe(true);
    });

    it('matches by name too, so the dual-class (package vs mobile) copy is still recovered', () => {
      expect(isRecoverableDecryptError({name: 'DecryptError'})).toBe(true);
      expect(isRecoverableDecryptError({name: 'NoSessionError'})).toBe(true);
    });

    it('does NOT classify IdentityKeyMismatchError or generic errors as recoverable', () => {
      // IdentityKeyMismatchError has its own refresh-and-retry path; it must
      // not be swallowed by the decrypt-rebuild branch.
      expect(isRecoverableDecryptError({name: 'IdentityKeyMismatchError'})).toBe(false);
      expect(isRecoverableDecryptError(new Error('disk full'))).toBe(false);
      expect(isRecoverableDecryptError(null)).toBe(false);
      expect(isRecoverableDecryptError(undefined)).toBe(false);
    });
  });

  describe('decideRecoveryDisposition — leave-on-relay vs ack-drop', () => {
    const ENV = 'env-abc-123';

    it('leaves a rebuild-path first failure on the relay (no more silent ACK-drop)', () => {
      expect(decideRecoveryDisposition('rebuild', ENV)).toBe('leave-on-relay');
    });

    it('also leaves the cooldown path on the relay (a later redelivery rebuilds)', () => {
      expect(decideRecoveryDisposition('cooldown', ENV)).toBe('leave-on-relay');
    });

    it('NEVER leaves a P0-1 "protected" (likely-forged) envelope on the relay', () => {
      // Preserves the anti-forgery posture: a forged envelope must not be
      // recirculated, and must not consume the retry budget.
      expect(decideRecoveryDisposition('protected', ENV)).toBe('ack-drop');
      expect(shouldRetry(ENV)).toBe(true); // budget untouched
      expect(_firstMsgRetryBudgetSize()).toBe(0);
    });

    it('ack-drops when there is no envelopeId (loopback path)', () => {
      expect(decideRecoveryDisposition('rebuild', undefined)).toBe('ack-drop');
    });

    it('leaves on relay exactly CAP times, then gives up (ack-drop)', () => {
      for (let i = 0; i < FIRST_MSG_RETRY_CAP; i++) {
        expect(decideRecoveryDisposition('rebuild', ENV)).toBe('leave-on-relay');
      }
      // CAP redeliveries spent → bounded give-up.
      expect(decideRecoveryDisposition('rebuild', ENV)).toBe('ack-drop');
      // ...and stays given-up on further redeliveries.
      expect(decideRecoveryDisposition('rebuild', ENV)).toBe('ack-drop');
    });

    it('enforces the wall-clock age ceiling even under the attempt cap', () => {
      const base = 1_000_000;
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      expect(decideRecoveryDisposition('rebuild', ENV)).toBe('leave-on-relay'); // attempt 1 @ t0
      // Jump past the age ceiling with attempts still well under CAP.
      nowSpy.mockReturnValue(base + FIRST_MSG_RETRY_MAX_AGE_MS + 1);
      expect(decideRecoveryDisposition('rebuild', ENV)).toBe('ack-drop');
    });

    it('clear() frees the slot so a future envelope of the same id starts fresh', () => {
      for (let i = 0; i < FIRST_MSG_RETRY_CAP; i++) {note(ENV);}
      expect(shouldRetry(ENV)).toBe(false); // exhausted
      clear(ENV);
      expect(shouldRetry(ENV)).toBe(true); // fresh again
    });
  });

  describe('bounded LRU — cannot grow without limit under churn', () => {
    it('evicts the oldest entry past the cache cap', () => {
      const CAP = 1024;
      const oldest = 'env-oldest';
      // Exhaust the oldest envelope's budget so a non-evicted entry would
      // still be "given up" (shouldRetry === false).
      for (let i = 0; i < FIRST_MSG_RETRY_CAP; i++) {note(oldest);}
      expect(shouldRetry(oldest)).toBe(false);

      // Fill the cache to exactly the cap with distinct fresh envelopes...
      for (let i = 0; i < CAP; i++) {note(`env-${i}`);}
      // ...which pushes total past the cap and evicts the oldest key.
      expect(_firstMsgRetryBudgetSize()).toBeLessThanOrEqual(CAP);
      // The evicted oldest is now treated as fresh (no lingering counter).
      expect(shouldRetry(oldest)).toBe(true);
    });
  });

  describe('LeaveOnRelayError — sentinel', () => {
    it('carries the envelopeId and is identifiable by instanceof and name', () => {
      const err = new LeaveOnRelayError('env-xyz');
      expect(err).toBeInstanceOf(LeaveOnRelayError);
      expect(err.envelopeId).toBe('env-xyz');
      expect(err.name).toBe('LeaveOnRelayError');
    });
  });
});
