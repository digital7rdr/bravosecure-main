/**
 * B-108 - mid-call ICE 'failed' must route into the reconnect machinery,
 * not instantly kill the call.
 *
 * Transition table pinned here (1:1 CallController):
 *   - never-connected + 'failed'      -> end('failed')   (B-41 fail-fast kept)
 *   - ever-connected  + 'failed'      -> 'reconnecting' + budget armed
 *   - already 'reconnecting' + failed -> stays 'reconnecting', in-flight
 *     restart latch reset, budget deadline NOT extended
 *   - budget expiry stays the only terminal authority (existing path).
 *
 * Private fields are reached via runtime casts (TS privates are
 * compile-time only) - the alternative is a full PC/ICE simulation.
 */

jest.mock('../push/callNotification', () => ({
  dismissCallNotif: jest.fn(),
  showMissedCallNotif: jest.fn(),
}));
jest.mock('../store/messengerStore', () => ({
  useMessengerStore: {getState: () => ({appendMessage: jest.fn(), conversations: {}})},
  resolveDirectConversationIdFromState: (_s: unknown, userId: string) => `direct:${userId}`,
}));
jest.mock('../push/callKitBridge', () => ({reportEnded: jest.fn()}));
jest.mock('../push/incomingCallCache', () => ({
  clearIncomingCallPayload: jest.fn(),
  getIncomingCallPayload: jest.fn(() => null),
}));
jest.mock('../push/fcmBootstrap', () => ({notifyCallEnded: jest.fn()}));

import {CallController} from '../webrtc/callController';
import {CallSignalling} from '../webrtc/signallingClient';
import type {TransportClient} from '@bravo/messenger-core';

type Priv = {
  everConnected: boolean;
  state: string;
  restartBudgetTimer: ReturnType<typeof setTimeout> | null;
  restartBudgetDeadline: number;
  restartInFlight: boolean;
  clearRestartBudget: () => void;
  clearRestartRetry: () => void;
};

function makeController(states: string[]): CallController {
  const tx = {send: jest.fn()} as unknown as TransportClient;
  return new CallController({
    signalling: new CallSignalling(tx),
    pcFactory:  jest.fn() as never,
    iceServers: [],
    onState:    s => states.push(s),
  });
}

// Every test here is fully synchronous, so fake timers change no semantics —
// they exist to make the clearAllTimers below REAL. Without useFakeTimers,
// clearAllTimers is a no-op on real timers and the restart-budget/watchdog
// handles this suite arms would outlive the file and fire into whichever
// suite the worker runs ~20s later (the B-126/B-304 moving-flake mechanism).
beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('B-108 onIceFailed transition table', () => {
  it('never-connected: fails fast (initial-connect / B-41 class)', () => {
    const states: string[] = [];
    const ctl = makeController(states);
    ctl.onIceFailed();
    expect(states).toContain('failed');
    expect((ctl as unknown as Priv).state).toBe('failed');
  });

  it('ever-connected: enters reconnecting and arms the budget, does not fail', () => {
    const states: string[] = [];
    const ctl = makeController(states);
    const priv = ctl as unknown as Priv;
    priv.everConnected = true;
    priv.state = 'connected';

    ctl.onIceFailed();

    expect(priv.state).toBe('reconnecting');
    expect(states).toContain('reconnecting');
    expect(states).not.toContain('failed');
    expect(priv.restartBudgetTimer).not.toBeNull();
    expect(priv.restartBudgetDeadline).toBeGreaterThan(Date.now());
    priv.clearRestartBudget();
    priv.clearRestartRetry();
  });

  it('already reconnecting: stays, resets the in-flight latch, does NOT extend the deadline', () => {
    const states: string[] = [];
    const ctl = makeController(states);
    const priv = ctl as unknown as Priv;
    priv.everConnected = true;
    priv.state = 'connected';
    ctl.onIceFailed();               // enter reconnecting, budget armed
    const deadline = priv.restartBudgetDeadline;
    priv.restartInFlight = true;     // a reoffer whose candidates just died

    ctl.onIceFailed();               // second hard-fail while reconnecting

    expect(priv.state).toBe('reconnecting');
    expect(states).not.toContain('failed');
    expect(priv.restartInFlight).toBe(false);
    expect(priv.restartBudgetDeadline).toBe(deadline);
    priv.clearRestartBudget();
    priv.clearRestartRetry();
  });

  it('terminal states are inert', () => {
    const states: string[] = [];
    const ctl = makeController(states);
    const priv = ctl as unknown as Priv;
    priv.state = 'ended';
    ctl.onIceFailed();
    expect(priv.state).toBe('ended');
    expect(states).toHaveLength(0);
  });
});
