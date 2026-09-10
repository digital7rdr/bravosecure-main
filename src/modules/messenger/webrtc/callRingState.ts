/**
 * Audit P0-C5 — ring timeout + missed-call state machine.
 *
 * Pre-fix: `call.offer` on the caller side, and `call.ringing` state on
 * the callee side, both had no upper bound. A call that nobody answered
 * (or that the callee silenced) sat in the in-progress state forever.
 * The user-visible symptom: outgoing-call screen stays on "Calling…"
 * until the caller manually taps End; the callee's CallKit / FCM ring
 * keeps re-firing on every retry. No record is written either way, so
 * the user sees no trail of an unanswered attempt.
 *
 * This module is a thin timer abstraction so the controller stays
 * focused on the WebRTC state machine and a unit test can drive every
 * branch without standing up the full call stack.
 *
 *   armOutgoing(callId)   — caller side, called after `call.offer` ships
 *   armIncoming(callId)   — callee side, called from `handleIncomingOffer`
 *   cancel(callId)        — answer / decline / hangup / connect all
 *                            cancel BY callId. A cancel for a stale
 *                            callId is a no-op (defensive).
 *   cancelAll()           — bulk cancel on end()/dispose.
 *   onExpire({callId, direction})
 *                          — caller-side: emit `call.hangup`, write
 *                            `missed_call_outgoing` row.
 *                          — callee-side: write `missed_call_incoming`
 *                            row, emit `call.hangup` so the offerer
 *                            stops ringing.
 *
 * Single-shot: after the timer fires (or cancel() runs) the state
 * returns to idle. Re-arming requires a fresh arm*() call.
 */

// WI-2.3 — imported for local use AND re-exported under its long-standing
// public name, so no consumer of `DEFAULT_RING_TIMEOUT_MS` had to change.
import {RING_TIMEOUT_MS} from './callDeadlines';
export const DEFAULT_RING_TIMEOUT_MS = RING_TIMEOUT_MS;

export type RingDirection = 'incoming' | 'outgoing';

export interface RingExpireEvent {
  callId:    string;
  direction: RingDirection;
}

export interface CallRingStateOptions {
  /** Fires once when the timer expires. Always safe to throw inside — caught. */
  onExpire:    (e: RingExpireEvent) => void;
  /** Override for tests / aggressive devices. Defaults to DEFAULT_RING_TIMEOUT_MS. */
  timeoutMs?:  number;
}

interface ArmedTimer {
  callId:    string;
  direction: RingDirection;
  handle:    ReturnType<typeof setTimeout>;
}

export class CallRingState {
  private readonly timeoutMs: number;
  private readonly onExpire: (e: RingExpireEvent) => void;
  private active: ArmedTimer | null = null;

  constructor(opts: CallRingStateOptions) {
    this.onExpire  = opts.onExpire;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_RING_TIMEOUT_MS;
  }

  /** Caller-side arm. Pass the same callId the outgoing offer carried. */
  armOutgoing(callId: string): void {
    this.arm(callId, 'outgoing');
  }

  /** Callee-side arm. Pass the offer's callId. */
  armIncoming(callId: string): void {
    this.arm(callId, 'incoming');
  }

  private arm(callId: string, direction: RingDirection): void {
    // Implicit cancel of any previously-armed timer — a controller only
    // handles one call at a time, so arming a second call means the
    // first was superseded (e.g. busy-bounce → new outgoing call).
    if (this.active) {
      clearTimeout(this.active.handle);
      this.active = null;
    }
    const handle = setTimeout(() => {
      // Snapshot before clearing — onExpire may re-enter (e.g. caller
      // emits hangup which triggers end() which calls cancelAll()).
      const evt: RingExpireEvent = {callId, direction};
      this.active = null;
      try { this.onExpire(evt); }
      catch (e) {
        // Don't propagate — a host that throws here would otherwise
        // crash the timer queue and prevent future arms from working.
        console.warn(`[bravo.callRingState] onExpire threw: ${(e as Error).message}`);
      }
    }, this.timeoutMs);
    this.active = {callId, direction, handle};
  }

  /**
   * Cancel the timer iff it's armed for `callId`. A cancel for a stale
   * callId (e.g. arrived after a different call was armed) is a no-op
   * so callers don't have to track which call is active.
   */
  cancel(callId: string): void {
    if (!this.active) {return;}
    if (this.active.callId !== callId) {return;}
    clearTimeout(this.active.handle);
    this.active = null;
  }

  /** Bulk cancel — for end() / dispose / sign-out. */
  cancelAll(): void {
    if (!this.active) {return;}
    clearTimeout(this.active.handle);
    this.active = null;
  }

  /** True iff a timer is currently armed. */
  isArmed(): boolean {
    return this.active !== null;
  }
}
