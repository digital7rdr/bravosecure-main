/**
 * AUDIT-2026-08-13 #19 — the service id flavors reject cross-flavor swaps.
 *
 * ts-jest typechecks specs, so each expect-error directive below is
 * load-bearing: if a flavor regresses to a bare alias the directive goes
 * UNUSED (TS2578) and this spec FAILS to compile. (The prose spells it
 * "expect-error" because TS treats any comment beginning with the
 * directive token as a real directive.)
 */
import type {UserId, CallId, RoomId, EnvelopeId, RetractToken} from './ids';

describe('AUDIT #19 — service id flavors', () => {
  // Never called — exists for the compiler, not the runtime.
  function _typeOnly(): void {
    const userId = 'u1' as UserId;
    const callId = 'call-1' as CallId;
    const retractToken = 'tok' as RetractToken;

    // Plain strings still assign — zero retrofit cascade.
    const plain: UserId = 'plain-string';

    // The sendVoipWake / sendCallCancel three-string shape:
    // @ts-expect-error — CallId must not accept a UserId
    const swap1: CallId = userId;
    // @ts-expect-error — UserId must not accept a CallId
    const swap2: UserId = callId;
    // The storeRetractToken(token, envelopeId) shape:
    // @ts-expect-error — EnvelopeId must not accept a RetractToken
    const swap3: EnvelopeId = retractToken;
    // The roomToken.issue(roomId, recipientUserId) shape:
    // @ts-expect-error — RoomId must not accept a UserId
    const swap4: RoomId = userId;

    void [plain, swap1, swap2, swap3, swap4];
  }
  void _typeOnly;

  it('flavors erase at runtime (the assertions above are compile-time)', () => {
    const id: UserId = 'still-a-plain-string';
    expect(typeof id).toBe('string');
  });
});
