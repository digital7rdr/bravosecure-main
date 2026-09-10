/**
 * WI-6.6 — 1:1 call reconcile probe.
 *
 * The SFU lane has `sfu.producers` as its reconcile primitive; the 1:1 lane
 * had nothing, so a client that missed a `call.hangup` (Doze, relay deploy,
 * dropped frame) sat in a zombie call UI until its own timers gave up. This
 * probe asks the server `call.sync {callId}` for the LIVE 1:1 call and
 * hard-ends the local call through the KEYED registry teardown when the
 * server answers `ended` or `unknown` ("unknown" includes a relay restart,
 * which legitimately ends the call — the relay's own session contract).
 *
 * Failure direction: a transport error / ack timeout / server refusal says
 * nothing about the CALL — the probe keeps the call ('skipped'). Only an
 * explicit `ended`/`unknown` verdict ends it.
 *
 * Wired from productionRuntime at the two divergence points (source-scanned
 * by callSyncProbe.test.ts):
 *   - the transport 'connected' state-change (reconnect-with-live-call);
 *   - the AppState-active resume 'probe' branch (callResumeGuard).
 *
 * Registry access is lazy-require to dodge the runtime↔registry circular
 * import, same as callResumeGuard — keeps this importable in the node Jest
 * project.
 */

export const CALL_SYNC_ACK_TIMEOUT_MS = 5_000;

export type CallSyncProbeOutcome = 'no-call' | 'kept' | 'ended' | 'skipped';

interface CallSyncDeps {
  /** Transport ack request — reject means "could not ask", never "ended". */
  emitWithAck: (event: string, data: unknown, timeoutMs?: number) => Promise<unknown>;
}

export async function runCallSyncProbe(deps: CallSyncDeps): Promise<CallSyncProbeOutcome> {
  let reg: typeof import('./callRegistry');
  try {
    reg = require('./callRegistry') as typeof import('./callRegistry');
  } catch {
    return 'skipped'; // registry not loadable (stripped harness) — never end blind
  }
  const live = reg.getActiveCall();
  if (!live || live.state === 'ended' || live.state === 'failed') {
    return 'no-call';
  }
  const {callId, gen} = live;
  let resp: unknown;
  try {
    resp = await deps.emitWithAck('call.sync', {callId}, CALL_SYNC_ACK_TIMEOUT_MS);
  } catch {
    return 'skipped'; // ack timeout / not open / rate-limited — keep the call
  }
  const state = (resp as {state?: unknown} | null | undefined)?.state;
  if (state !== 'ended' && state !== 'unknown') {
    // 'ringing' / 'active' / any unrecognised reply keeps the call — the
    // probe only ever acts on an explicit terminal verdict.
    return 'kept';
  }
  // Post-await identity re-check (the Phase-5 lesson): the await may have
  // outlived this call — a newer call can hold the slot now, and the keyed
  // teardown must never be aimed at it with a stale verdict.
  const now = reg.getActiveCall();
  if (!now || now.callId !== callId || now.gen !== gen) {
    return 'skipped';
  }
  if (now.state === 'ended' || now.state === 'failed') {
    return 'no-call'; // already terminal locally — nothing to do
  }
  // Round 2 (arch P3-6) — an OUTBOUND ring not yet answered is exempt from
  // the `unknown` verdict: a relay restart mid-ring wipes the session, but
  // the CALLEE's queued-offer replay can still rescue the call (that lane is
  // invisible to this asker by design — no oracle), and the ring already has
  // its own 45 s terminal authority. A positive `ended` verdict still ends
  // it — that is a real tombstone, not an absence.
  if (state === 'unknown' && now.state === 'calling') {
    return 'kept';
  }
  // silentWire — the server just DECLARED this call ended/unknown; echoing a
  // call.hangup at it is at best a dropped frame, and the wire-silent end is
  // what keeps the probe safe to run against any session state.
  reg.endActiveCall({callId, gen}, 'ended', 'remote', {silentWire: true});
  return 'ended';
}
