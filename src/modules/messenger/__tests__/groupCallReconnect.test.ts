import {shouldAttemptRejoin, attemptSfuRejoin} from '@/modules/messenger/webrtc/groupCallReconnect';
import type {TransportClient} from '@bravo/messenger-core';

/**
 * B-05 — after a WS reconnect (the server's P0-6 revoked-socket sweep + the
 * TransportClient refresh/reopen), a live group call must RE-JOIN the SFU
 * room rather than restartIce over the dead socket. These tests pin the two
 * load-bearing behaviours of the rejoin driver WITHOUT mounting the full
 * useGroupCall hook (mirrors the fake-store style of groupCallKeyWait.test):
 *
 *   1. The gate: rejoin ONLY when joined/reconnecting + a roomId + not
 *      tearing down. A call in idle/left/failed must NOT be resurrected.
 *   2. The driver: on a permitted rejoin it issues `sfu.join` with the
 *      existing roomId+roomToken and hands the response to onJoined; it does
 *      NOT issue restartIce.
 *
 * SECURITY: rejoin reuses the existing group key (onJoined re-attaches the
 * SAME SFrame encryptor in the hook); nothing here weakens P0-6 or the key
 * gate — a missing key still fails closed inside onJoined.
 */

// A fake transport whose emitWithAck we can observe. Only the surface the
// rejoin driver touches is implemented.
function makeFakeWs(joinResp: unknown): {
  ws: TransportClient;
  calls: Array<{event: string; data: unknown}>;
} {
  const calls: Array<{event: string; data: unknown}> = [];
  const ws = {
    emitWithAck: jest.fn((event: string, data: unknown) => {
      calls.push({event, data});
      return Promise.resolve(joinResp);
    }),
  } as unknown as TransportClient;
  return {ws, calls};
}

const joinedResp = {
  routerRtpCapabilities: {},
  sendTransport: {},
  recvTransport: {},
  participantTag: 'tag-new',
  isHost: false,
  existingProducers: [],
};

// The hook injects this exact request shim (useGroupCall.wsRequest).
const request = <T>(ws: TransportClient, event: string, data: unknown): Promise<T> =>
  (ws as unknown as {emitWithAck: (e: string, d: unknown) => Promise<T>}).emitWithAck(event, data);

describe('shouldAttemptRejoin — B-05 gate', () => {
  it('permits rejoin when joined with a roomId', () => {
    expect(shouldAttemptRejoin({state: 'joined', roomId: 'r1', isLeaving: false})).toBe(true);
  });
  it('permits rejoin when reconnecting with a roomId', () => {
    expect(shouldAttemptRejoin({state: 'reconnecting', roomId: 'r1', isLeaving: false})).toBe(true);
  });
  it('blocks rejoin when leaving even if joined', () => {
    expect(shouldAttemptRejoin({state: 'joined', roomId: 'r1', isLeaving: true})).toBe(false);
  });
  it('blocks rejoin when there is no roomId', () => {
    expect(shouldAttemptRejoin({state: 'joined', roomId: null, isLeaving: false})).toBe(false);
  });
  it.each(['idle', 'left', 'failed', 'kicked', 'ended-by-host', 'creating', 'joining'])(
    'blocks rejoin from %s state',
    (state) => {
      expect(shouldAttemptRejoin({state, roomId: 'r1', isLeaving: false})).toBe(false);
    },
  );
});

describe('attemptSfuRejoin — B-05 driver', () => {
  it('issues sfu.join with the existing roomId+roomToken and calls onJoined', async () => {
    const {ws, calls} = makeFakeWs(joinedResp);
    const onJoined = jest.fn().mockResolvedValue(undefined);
    const log = jest.fn();

    const outcome = await attemptSfuRejoin({
      ws, roomId: 'room-42', roomToken: 'tok-42',
      state: 'joined', isLeaving: false,
      log, request, onJoined,
    });

    expect(outcome).toBe('rejoined');
    // Exactly one WS call, and it is sfu.join (never restartIce).
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe('sfu.join');
    expect(calls[0].data).toEqual({roomId: 'room-42', roomToken: 'tok-42'});
    expect(onJoined).toHaveBeenCalledWith(joinedResp);
    expect(log).toHaveBeenCalledWith('[bravo.groupcall] reconnect -> rejoin');
  });

  it('SKIPS (no sfu.join) when the call is not in a live state', async () => {
    const {ws, calls} = makeFakeWs(joinedResp);
    const onJoined = jest.fn().mockResolvedValue(undefined);

    const outcome = await attemptSfuRejoin({
      ws, roomId: 'room-42',
      state: 'left', isLeaving: false,
      log: () => undefined, request, onJoined,
    });

    expect(outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('SKIPS when tearing down (isLeaving) even if joined', async () => {
    const {ws, calls} = makeFakeWs(joinedResp);
    const onJoined = jest.fn().mockResolvedValue(undefined);

    const outcome = await attemptSfuRejoin({
      ws, roomId: 'room-42',
      state: 'joined', isLeaving: true,
      log: () => undefined, request, onJoined,
    });

    expect(outcome).toBe('skipped');
    expect(calls).toHaveLength(0);
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('reports failed (no throw) when sfu.join rejects', async () => {
    const ws = {
      emitWithAck: jest.fn().mockRejectedValue(new Error('ack_timeout:sfu.join')),
    } as unknown as TransportClient;
    const onJoined = jest.fn().mockResolvedValue(undefined);

    const outcome = await attemptSfuRejoin({
      ws, roomId: 'room-42',
      state: 'joined', isLeaving: false,
      log: () => undefined, request, onJoined,
    });

    expect(outcome).toBe('failed');
    expect(onJoined).not.toHaveBeenCalled();
  });

  it('reports failed when onJoined (the mediasoup re-wire) throws', async () => {
    const {ws} = makeFakeWs(joinedResp);
    const onJoined = jest.fn().mockRejectedValue(new Error('rejoin: device/encryption missing'));

    const outcome = await attemptSfuRejoin({
      ws, roomId: 'room-42',
      state: 'joined', isLeaving: false,
      log: () => undefined, request, onJoined,
    });

    expect(outcome).toBe('failed');
    expect(onJoined).toHaveBeenCalledTimes(1);
  });
});
