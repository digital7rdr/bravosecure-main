/**
 * B-05 — SFU room rejoin after a WS reconnect.
 *
 * The mid-call WS drop is the server's P0-6 revoked-socket sweep
 * (messenger.gateway.ts) — it emits `error{code:'token_revoked'}` then
 * `disconnect(true)` for sockets whose jti left the Redis allowlist. That
 * is correct, audited security and is NOT weakened here. The client
 * TransportClient already re-authenticates (single-flight refresh + reopen)
 * so the socket comes back. The bug B-05 fixes: when the socket reopens the
 * SFU room/transports were torn down server-side, so an ICE restart over
 * the fresh socket never recovers the call.
 *
 * `joinRoom` on the server mints a FRESH participantTag + a FRESH pair of
 * WebRtcTransports per call, and returns the live `existingProducers`. So
 * the correct recovery is a real re-join inside the SFU's 60s zombie-room
 * grace window (sfu.service.ts ZOMBIE_ROOM_GRACE_MS=60000): re-call
 * `sfu.join`, re-create transports, re-produce local tracks, re-consume the
 * returned producers. The group master key is unchanged (already present
 * from the original join) so the SFrame layer is reused — no key re-gate,
 * no plaintext fallback.
 *
 * This module owns the decision (gate) + the `sfu.join` round-trip + the
 * log line; the heavy mediasoup re-wire is handed back to the caller via
 * `onJoined` so the live Device/transport closures stay in the hook.
 */
import type {TransportClient} from '@bravo/messenger-core';

/**
 * Subset of GroupCallState the rejoin gate cares about. Kept local so this
 * module has no import cycle with useGroupCall.
 */
export type RejoinGateState = string;

export interface SfuRejoinResult<TJoined> {
  routerRtpCapabilities: unknown;
  sendTransport:         unknown;
  recvTransport:         unknown;
  participantTag:        string;
  isHost:                boolean;
  existingProducers:     TJoined;
}

/**
 * Gate: only attempt a rejoin when we were actually in the call (joined or
 * mid-ICE-reconnect), still have a roomId, and aren't tearing down. A call
 * in 'idle' / 'left' / 'failed' / 'kicked' / 'ended-by-host' must NOT be
 * resurrected by a stray socket reopen.
 */
export function shouldAttemptRejoin(args: {
  state:     RejoinGateState;
  roomId:    string | null;
  isLeaving: boolean;
}): boolean {
  if (args.isLeaving) {return false;}
  if (!args.roomId) {return false;}
  return args.state === 'joined' || args.state === 'reconnecting';
}

export interface AttemptSfuRejoinArgs<TJoined> {
  ws:         TransportClient;
  roomId:     string;
  roomToken?: string;
  /** Snapshot of the current call state at the moment of the reconnect. */
  state:      RejoinGateState;
  /** True while leaveInternal is running — never rejoin into a teardown. */
  isLeaving:  boolean;
  /** Emits diagnostics ([bravo.groupcall] reconnect -> rejoin etc). */
  log:        (line: string) => void;
  /** Issue a WS request with ack — injected so tests can stub it. */
  request:    <T>(ws: TransportClient, event: string, data: unknown) => Promise<T>;
  /**
   * Re-wire mediasoup against the fresh participantTag + transports the
   * server just minted. Owns Device/transport/produce/consume — lives in
   * the hook where those closures are in scope. Throwing here is a failed
   * rejoin.
   */
  onJoined:   (joined: SfuRejoinResult<TJoined>) => Promise<void>;
  /**
   * Audit F7 — re-mint the room token. A group call longer than the room
   * token's 30-min TTL that then hits a WS reconnect fails sfu.join with
   * `room_token_invalid`. When that happens we call this to fetch a fresh
   * token (POST /sfu/rooms or GET by-conversation) and retry the join ONCE.
   * Optional — omitted callers keep the prior single-attempt behaviour.
   */
  remintToken?: () => Promise<string | undefined>;
}

export type SfuRejoinOutcome = 'skipped' | 'rejoined' | 'failed';

/**
 * Drive a full SFU rejoin after a WS reopen. Returns:
 *   'skipped'  — the gate said no (not in a live call)
 *   'rejoined' — sfu.join succeeded and onJoined completed
 *   'failed'   — sfu.join or onJoined threw (caller should setState('failed'))
 *
 * Does NOT issue restartIce — the whole point is that the old transports
 * are dead server-side; we re-join instead.
 */
export async function attemptSfuRejoin<TJoined>(
  args: AttemptSfuRejoinArgs<TJoined>,
): Promise<SfuRejoinOutcome> {
  if (!shouldAttemptRejoin({state: args.state, roomId: args.roomId, isLeaving: args.isLeaving})) {
    return 'skipped';
  }
  args.log('[bravo.groupcall] reconnect -> rejoin');
  try {
    const joined = await args.request<SfuRejoinResult<TJoined>>(
      args.ws,
      'sfu.join',
      {roomId: args.roomId, roomToken: args.roomToken},
    );
    await args.onJoined(joined);
    return 'rejoined';
  } catch (e) {
    const msg = (e as Error).message ?? '';
    // Audit F7 — the room token expired mid-call (>30-min TTL). Re-mint and
    // retry the join ONCE before giving up.
    if (args.remintToken && /room_token/i.test(msg)) {
      args.log('[bravo.groupcall] rejoin token expired — re-minting');
      try {
        const fresh = await args.remintToken();
        if (fresh) {
          const joined = await args.request<SfuRejoinResult<TJoined>>(
            args.ws, 'sfu.join', {roomId: args.roomId, roomToken: fresh},
          );
          await args.onJoined(joined);
          return 'rejoined';
        }
      } catch (e2) {
        args.log(`[bravo.groupcall] rejoin after re-mint FAILED: ${(e2 as Error).message}`);
        return 'failed';
      }
    }
    args.log(`[bravo.groupcall] reconnect -> rejoin FAILED: ${msg}`);
    return 'failed';
  }
}
