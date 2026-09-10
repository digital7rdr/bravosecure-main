/**
 * Call-waiting decision core (B-238-CW).
 *
 * Pins the "second incoming call while already in a call" behaviour the
 * founder asked for: Accept the new call ENDS the current call then joins the
 * new one; Decline keeps the current call and tells the new caller we're
 * declined. Pure module → runs under the node messenger-crypto project (the
 * CallScreen / GroupCallScreen surfaces that consume it can't be imported).
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  acceptWaitingCall,
  declineWaitingCall,
  acceptedCallParams,
  type CallWaitingDeps,
} from '../webrtc/callWaiting';
import type {PendingOneToOne} from '../webrtc/incomingOneToOneBanner';

function makePending(over?: Partial<PendingOneToOne>): PendingOneToOne {
  return {
    callId: 'call-new-1',
    from:   {userId: 'peer-9', deviceId: 3},
    kind:   'video',
    sdp:    'v=0 fake-offer',
    ...over,
  } as PendingOneToOne;
}

function makeDeps(over?: Partial<CallWaitingDeps>): jest.Mocked<CallWaitingDeps> {
  return {
    endCurrentCall: jest.fn(() => Promise.resolve()),
    sendFrame:      jest.fn(),
    navigateToCall: jest.fn(),
    clearPending:   jest.fn(),
    ...over,
  } as jest.Mocked<CallWaitingDeps>;
}

describe('acceptedCallParams', () => {
  it('maps a pending offer to the 1:1 CallScreen params', () => {
    expect(acceptedCallParams(makePending())).toEqual({
      callType:       'video',
      isIncoming:     true,
      conversationId: 'direct:peer-9',
      callId:         'call-new-1',
      remoteUserId:   'peer-9',
      remoteDeviceId: 3,
      incomingSdp:    'v=0 fake-offer',
    });
  });
});

describe('declineWaitingCall — keep current call, reject the new one', () => {
  it('sends call.hangup{declined} to the new caller and clears the banner', () => {
    const deps = makeDeps();
    declineWaitingCall(makePending(), deps);

    expect(deps.sendFrame).toHaveBeenCalledWith({
      event: 'call.hangup',
      data:  {callId: 'call-new-1', to: {userId: 'peer-9', deviceId: 3}, reason: 'declined'},
    });
    expect(deps.clearPending).toHaveBeenCalledTimes(1);
    // The current call must NOT be touched on decline.
    expect(deps.endCurrentCall).not.toHaveBeenCalled();
    expect(deps.navigateToCall).not.toHaveBeenCalled();
  });

  it('still clears the banner if the transport send throws (dead socket)', () => {
    const deps = makeDeps({sendFrame: jest.fn(() => { throw new Error('socket dead'); })});
    expect(() => declineWaitingCall(makePending(), deps)).not.toThrow();
    expect(deps.clearPending).toHaveBeenCalledTimes(1);
  });
});

describe('acceptWaitingCall — end current call, then join the new one', () => {
  it('ends the current call BEFORE navigating to the new one', async () => {
    const order: string[] = [];
    let releaseEnd: () => void = () => {};
    const deps = makeDeps({
      endCurrentCall: jest.fn(() => new Promise<void>(res => { releaseEnd = () => { order.push('ended'); res(); }; })),
      navigateToCall: jest.fn(() => { order.push('navigated'); }),
    });

    const p = acceptWaitingCall(makePending(), deps);
    // Teardown is in flight — navigation must not have happened yet.
    expect(deps.navigateToCall).not.toHaveBeenCalled();
    releaseEnd();
    await p;

    expect(order).toEqual(['ended', 'navigated']);
    expect(deps.clearPending).toHaveBeenCalledTimes(1);
    expect(deps.navigateToCall).toHaveBeenCalledWith(acceptedCallParams(makePending()));
  });

  it('still joins the new call if the current-call teardown rejects', async () => {
    const deps = makeDeps({endCurrentCall: jest.fn(() => Promise.reject(new Error('leave crashed')))});
    await acceptWaitingCall(makePending(), deps);
    expect(deps.navigateToCall).toHaveBeenCalledWith(acceptedCallParams(makePending()));
  });

  it('clears the banner slot before the async teardown (no mid-accept re-render)', async () => {
    const deps = makeDeps();
    await acceptWaitingCall(makePending(), deps);
    expect(deps.clearPending).toHaveBeenCalledTimes(1);
    // clearPending must precede navigate so a replayed offer can't re-arm the banner.
    const clearOrder    = deps.clearPending.mock.invocationCallOrder[0];
    const navigateOrder = deps.navigateToCall.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(navigateOrder);
  });
});

describe('B-238-CW wiring — a 2nd 1:1 during a 1:1 routes into call-waiting', () => {
  // MainNavigator + CallScreen pull react-native and can't be imported here, so
  // pin the wire with raw-source scans of code tokens (never present in prose).
  const nav  = readFileSync(join(process.cwd(), 'src', 'navigation', 'MainNavigator.tsx'), 'utf8');
  const call = readFileSync(join(process.cwd(), 'src', 'screens', 'messenger', 'CallScreen.tsx'), 'utf8');

  it('MainNavigator routes the 2nd 1:1 into the banner in BOTH the group and 1:1 branches', () => {
    // Before B-238-CW only the group-call branch routed a 2nd 1:1 into the
    // banner (1 occurrence) and the 1:1 branch auto-busied the new caller. The
    // fix adds the 1:1 branch → 2 occurrences, tagged with the B-238-CW marker.
    // (A separate, legitimate data.callId busy at the restore-mode guard, B-107,
    // is intentionally untouched — so we assert the NEW routing, not the absence
    // of every busy send.)
    const occurrences = nav.split('banner.setPendingOneToOne(data)').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
    expect(nav).toContain('B-238-CW');
  });

  it('CallScreen subscribes to the banner and drives the callWaiting core', () => {
    expect(call).toContain('onPendingOneToOneChange');
    expect(call).toMatch(/acceptWaitingCall\(/);
    expect(call).toMatch(/declineWaitingCall\(/);
  });
});
