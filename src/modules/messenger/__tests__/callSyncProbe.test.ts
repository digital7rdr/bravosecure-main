/**
 * WI-6.6 — the 1:1 call.sync reconcile probe.
 *
 * Contract: with a LIVE 1:1 call, one `call.sync` round-trip; hard-end
 * through the KEYED registry teardown only on an explicit `ended`/`unknown`
 * verdict; keep the call on every failure (ack timeout, transport closed,
 * refusal) — a probe that cannot ask must never kill a call. The teardown is
 * re-keyed after the await (a newer call may own the slot by then).
 *
 * The productionRuntime wiring (reconnect 'connected' branch + resume
 * 'probe' branch) is pinned by source scan — no test imports the runtime.
 */
import {runCallSyncProbe, CALL_SYNC_ACK_TIMEOUT_MS} from '../runtime/callSyncProbe';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

jest.mock('../runtime/callRegistry', () => ({
  getActiveCall: jest.fn(),
  endActiveCall: jest.fn(),
}));

const reg = require('../runtime/callRegistry') as {
  getActiveCall: jest.Mock;
  endActiveCall: jest.Mock;
};

const LIVE = {callId: 'cid-sync-1', gen: 4, state: 'connected'};

beforeEach(() => {
  reg.getActiveCall.mockReset();
  reg.endActiveCall.mockReset();
});

describe('WI-6.6 — runCallSyncProbe', () => {
  it('no live call → no-call, and the server is never asked', async () => {
    reg.getActiveCall.mockReturnValue(null);
    const emit = jest.fn();
    expect(await runCallSyncProbe({emitWithAck: emit})).toBe('no-call');
    expect(emit).not.toHaveBeenCalled();
  });

  it('a terminal local call counts as no call', async () => {
    reg.getActiveCall.mockReturnValue({...LIVE, state: 'ended'});
    const emit = jest.fn();
    expect(await runCallSyncProbe({emitWithAck: emit})).toBe('no-call');
    expect(emit).not.toHaveBeenCalled();
  });

  it('asks with the live callId and the module timeout', async () => {
    reg.getActiveCall.mockReturnValue({...LIVE});
    const emit = jest.fn(async () => ({ok: true, state: 'active'}));
    await runCallSyncProbe({emitWithAck: emit});
    expect(emit).toHaveBeenCalledWith('call.sync', {callId: LIVE.callId}, CALL_SYNC_ACK_TIMEOUT_MS);
  });

  it.each(['active', 'ringing'])('server "%s" keeps the call', async (state) => {
    reg.getActiveCall.mockReturnValue({...LIVE});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true, state})})).toBe('kept');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });

  it.each(['ended', 'unknown'])('server "%s" hard-ends through the KEYED teardown', async (state) => {
    reg.getActiveCall.mockReturnValue({...LIVE});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true, state})})).toBe('ended');
    expect(reg.endActiveCall).toHaveBeenCalledWith(
      // silentWire (round 3) — the probe acts on the server's own verdict;
      // echoing call.hangup at a session the server already closed is noise,
      // and the silent form keeps the probe safe against ANY session state.
      {callId: LIVE.callId, gen: LIVE.gen}, 'ended', 'remote', {silentWire: true},
    );
  });

  it('a transport error keeps the call — could-not-ask is NOT ended', async () => {
    reg.getActiveCall.mockReturnValue({...LIVE});
    const out = await runCallSyncProbe({emitWithAck: async () => { throw new Error('ack_timeout:call.sync'); }});
    expect(out).toBe('skipped');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });

  it('an unrecognised reply shape keeps the call (fail-safe direction)', async () => {
    reg.getActiveCall.mockReturnValue({...LIVE});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true})})).toBe('kept');
    expect(await runCallSyncProbe({emitWithAck: async () => null})).toBe('kept');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });

  it('POST-AWAIT identity re-check: a newer call in the slot is never ended with a stale verdict', async () => {
    reg.getActiveCall
      .mockReturnValueOnce({...LIVE})                          // pre-await read
      .mockReturnValueOnce({...LIVE, callId: 'cid-newer', gen: 5}); // post-await: replaced
    const out = await runCallSyncProbe({emitWithAck: async () => ({ok: true, state: 'ended'})});
    expect(out).toBe('skipped');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });

  it('same id, NEWER gen is still a different call (gen is the discriminator)', async () => {
    reg.getActiveCall
      .mockReturnValueOnce({...LIVE})
      .mockReturnValueOnce({...LIVE, gen: 5});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true, state: 'unknown'})})).toBe('skipped');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });

  it('round 2 (P3-6) — an OUTBOUND unanswered ring survives `unknown` (the callee replay can still rescue it)', async () => {
    reg.getActiveCall.mockReturnValue({...LIVE, state: 'calling'});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true, state: 'unknown'})})).toBe('kept');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });

  it('round 2 (P3-6) — a positive `ended` verdict still ends an outbound ring (a tombstone is not an absence)', async () => {
    reg.getActiveCall.mockReturnValue({...LIVE, state: 'calling'});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true, state: 'ended'})})).toBe('ended');
    expect(reg.endActiveCall).toHaveBeenCalledWith(
      {callId: LIVE.callId, gen: LIVE.gen}, 'ended', 'remote', {silentWire: true},
    );
  });

  it('a call that went terminal during the await is left alone', async () => {
    reg.getActiveCall
      .mockReturnValueOnce({...LIVE})
      .mockReturnValueOnce({...LIVE, state: 'ended'});
    expect(await runCallSyncProbe({emitWithAck: async () => ({ok: true, state: 'ended'})})).toBe('no-call');
    expect(reg.endActiveCall).not.toHaveBeenCalled();
  });
});

describe('WI-6.6 — productionRuntime wiring (source scan)', () => {
  // Line-based comment strip (CRLF-safe): ordering/absence claims must not
  // match prose (the stripper-eats-code lesson — conservative on purpose).
  const src = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts'), 'utf8',
  )
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');

  it('exactly two probe call sites, both riding the live transport emitWithAck', () => {
    const requires = src.match(/require\('\.\/callSyncProbe'\)/g) ?? [];
    const calls = src.match(/runCallSyncProbe\(\{/g) ?? [];
    expect(requires).toHaveLength(2);
    expect(calls).toHaveLength(2);
    const emits = src.match(/emitWithAck: \(ev, d, t\) => transport\.emitWithAck\(ev, d, t\)/g) ?? [];
    expect(emits).toHaveLength(2);
  });

  it('the reconnect site runs inside the connected branch, gated on a live call', () => {
    const connectedIdx = src.indexOf("if (state === 'connected') {");
    expect(connectedIdx).toBeGreaterThan(-1);
    const probeGate = src.indexOf('if (hasLiveCall()) {', connectedIdx);
    const firstProbe = src.indexOf("require('./callSyncProbe')", connectedIdx);
    expect(probeGate).toBeGreaterThan(connectedIdx);
    expect(firstProbe).toBeGreaterThan(probeGate);
    // ...and before the branch hands over to the receipts reconcile.
    expect(firstProbe).toBeLessThan(src.indexOf('reconcileHttpReceipts', connectedIdx));
  });

  it('the resume site lives in the probe branch, next to the ping probe', () => {
    const probeBranch = src.indexOf("resumeAction === 'probe'");
    expect(probeBranch).toBeGreaterThan(-1);
    const secondProbe = src.indexOf("require('./callSyncProbe')", probeBranch);
    expect(secondProbe).toBeGreaterThan(probeBranch);
    // Inside the branch, not somewhere later: the else-branch reconnect
    // fallthrough starts with forceReconnect.
    const elseBranch = src.indexOf('} else {', probeBranch);
    expect(secondProbe).toBeLessThan(elseBranch);
  });
});
