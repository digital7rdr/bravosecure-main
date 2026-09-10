/**
 * [CALLLAT] lane clock — audit Step 0 (docs/audits/CALL_JOIN_LATENCY_AUDIT_2026-08-20.md).
 *
 * Pins the helper every marker in the call-join path relies on: `t` is ms
 * since the lane's first (or `reset`) marker, `dt` is ms since the previous
 * one, lanes/ids are independent, a terminal `endCallLatLane` and the 5-min
 * TTL both start a fresh clock, the line is `console.warn` (release-visible),
 * and fields follow the [CALLSM] rendering rules.
 */
import {logCallLat, endCallLatLane, markJsStallOnActiveLanes, _resetCallLatForTest} from '../runtime/callDiag';

describe('[CALLLAT] lane clock (audit Step 0)', () => {
  let nowMs = 0;
  let warn: jest.SpyInstance;
  let log: jest.SpyInstance;

  beforeEach(() => {
    nowMs = 10_000;
    _resetCallLatForTest();
    jest.spyOn(performance, 'now').mockImplementation(() => nowMs);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    log  = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => { jest.restoreAllMocks(); });

  const lines = (): string[] => warn.mock.calls.map(c => String(c[0]));

  it('t is since the first marker, dt is since the previous one; the line is warn-level', () => {
    logCallLat('1to1-in', 'abcdefgh-1234', 'turn:start');
    nowMs += 250;
    logCallLat('1to1-in', 'abcdefgh-1234', 'turn:ok', {ms: 250});
    nowMs += 100;
    logCallLat('1to1-in', 'abcdefgh-1234', 'tap:accept');
    expect(lines()).toEqual([
      '[CALLLAT] lane=1to1-in cid=abcdefgh step=turn:start t=0 dt=0',
      '[CALLLAT] lane=1to1-in cid=abcdefgh step=turn:ok t=250 dt=250 ms=250',
      '[CALLLAT] lane=1to1-in cid=abcdefgh step=tap:accept t=350 dt=100',
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it('lanes and ids keep independent clocks', () => {
    logCallLat('1to1-in', 'call-a', 'a1');
    nowMs += 500;
    logCallLat('1to1-out', 'call-a', 'b1');   // other lane, same id
    logCallLat('1to1-in', 'call-b', 'c1');    // same lane, other id
    nowMs += 100;
    logCallLat('1to1-in', 'call-a', 'a2');
    logCallLat('1to1-out', 'call-a', 'b2');
    logCallLat('1to1-in', 'call-b', 'c2');
    expect(lines()).toEqual([
      '[CALLLAT] lane=1to1-in cid=call-a step=a1 t=0 dt=0',
      '[CALLLAT] lane=1to1-out cid=call-a step=b1 t=0 dt=0',
      '[CALLLAT] lane=1to1-in cid=call-b step=c1 t=0 dt=0',
      '[CALLLAT] lane=1to1-in cid=call-a step=a2 t=600 dt=600',
      '[CALLLAT] lane=1to1-out cid=call-a step=b2 t=100 dt=100',
      '[CALLLAT] lane=1to1-in cid=call-b step=c2 t=100 dt=100',
    ]);
  });

  it('reset restarts the clock for a NEW boot of the same lane/id (group rejoin, restore)', () => {
    logCallLat('grp-join', 'conv-1', 'boot', {}, {reset: true});
    nowMs += 3_000;
    logCallLat('grp-join', 'conv-1', 'join:ack');
    nowMs += 1_000;
    logCallLat('grp-join', 'conv-1', 'boot', {}, {reset: true});
    nowMs += 50;
    logCallLat('grp-join', 'conv-1', 'join:ack');
    expect(lines().map(l => l.replace(/^.*step=/, 'step='))).toEqual([
      'step=boot t=0 dt=0',
      'step=join:ack t=3000 dt=3000',
      'step=boot t=0 dt=0',
      'step=join:ack t=50 dt=50',
    ]);
  });

  it('a terminal endCallLatLane forgets the clock; the next marker starts at t=0', () => {
    logCallLat('1to1-out', 'call-x', 'launch', {}, {reset: true});
    nowMs += 2_000;
    logCallLat('1to1-out', 'call-x', 'state:ended');
    endCallLatLane('1to1-out', 'call-x');
    nowMs += 10;
    logCallLat('1to1-out', 'call-x', 'late');
    expect(lines().pop()).toBe('[CALLLAT] lane=1to1-out cid=call-x step=late t=0 dt=0');
    // idempotent
    expect(() => endCallLatLane('1to1-out', 'call-x')).not.toThrow();
  });

  it('a clock older than the 5-minute TTL is dropped (reused group roomId / replayed callId)', () => {
    logCallLat('grp-host', 'conv-2', 'boot');
    nowMs += 5 * 60_000 + 1;
    logCallLat('grp-host', 'conv-2', 'boot-again');
    expect(lines().pop()).toBe('[CALLLAT] lane=grp-host cid=conv-2 step=boot-again t=0 dt=0');
  });

  it('fields: undefined omitted, null rendered as -, scalars stringified, short id form', () => {
    logCallLat('1to1-in', 'abcdefghijklmnop', 'x', {a: undefined, b: null, c: 3, d: true, e: 'relay'});
    expect(lines()[0]).toBe('[CALLLAT] lane=1to1-in cid=abcdefgh step=x t=0 dt=0 b=- c=3 d=true e=relay');
    logCallLat('1to1-in', null, 'y');
    expect(lines()[1]).toBe('[CALLLAT] lane=1to1-in cid=- step=y t=0 dt=0');
  });

  it('falls back to Date.now when performance.now is unusable, never throws', () => {
    (performance.now as jest.Mock).mockImplementation(() => NaN);
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(50_000);
    expect(() => logCallLat('1to1-in', 'z', 'a')).not.toThrow();
    dateSpy.mockReturnValue(50_040);
    logCallLat('1to1-in', 'z', 'b');
    expect(lines().pop()).toBe('[CALLLAT] lane=1to1-in cid=z step=b t=40 dt=40');
  });

  it('a clock created on the Date axis stays on it even if performance.now becomes usable later (no mixed axes)', () => {
    (performance.now as jest.Mock).mockImplementation(() => NaN);
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(80_000);
    logCallLat('1to1-out', 'mix', 'a');            // Date-axis clock, t0=80000
    (performance.now as jest.Mock).mockImplementation(() => 5);   // perf usable now, tiny values
    dateSpy.mockReturnValue(80_300);
    logCallLat('1to1-out', 'mix', 'b');
    // If the axis had switched to perf, now-t0 would be hugely negative and clamp to 0.
    expect(lines().pop()).toBe('[CALLLAT] lane=1to1-out cid=mix step=b t=300 dt=300');
  });

  describe('freshAfterMs — "first sight of a call" rows (offer/ring received, notification tap, invitee boot)', () => {
    it('continues a YOUNG clock (the tap that follows a ring keeps the ring as t0)', () => {
      logCallLat('1to1-in', 'c1', 'offer:received', {}, {freshAfterMs: 90_000});
      nowMs += 4_000;
      logCallLat('1to1-in', 'c1', 'notif:answer-tap', {}, {freshAfterMs: 90_000});
      expect(lines().pop()).toBe('[CALLLAT] lane=1to1-in cid=c1 step=notif:answer-tap t=4000 dt=4000');
    });
    it('restarts a STALE clock (a previous call on the same id cannot be inherited)', () => {
      logCallLat('grp-join', 'conv-9', 'ring:received', {}, {freshAfterMs: 90_000});
      nowMs += 91_000;
      logCallLat('grp-join', 'conv-9', 'ring:received', {}, {freshAfterMs: 90_000});
      expect(lines().pop()).toBe('[CALLLAT] lane=grp-join cid=conv-9 step=ring:received t=0 dt=0');
    });
    it('creates the clock when none exists (the killed lane: the tap comes before any offer)', () => {
      logCallLat('1to1-in', 'cold', 'notif:answer-tap', {}, {freshAfterMs: 90_000});
      expect(lines().pop()).toBe('[CALLLAT] lane=1to1-in cid=cold step=notif:answer-tap t=0 dt=0');
    });
  });

  describe('js-stall fan-out (jsThreadWatchdog → every LIVE lane)', () => {
    it('stamps a js-stall row on lanes touched within the last minute and skips idle ones', () => {
      logCallLat('1to1-in', 'live1', 'accept:invoke');
      logCallLat('grp-join', 'live2', 'join:sent');
      logCallLat('1to1-out', 'idle', 'launch');
      nowMs += 61_000;                                   // 'idle' goes quiet…
      logCallLat('1to1-in', 'live1', 'media:ok');        // …these two are touched again
      logCallLat('grp-join', 'live2', 'join:ack');
      nowMs += 250;
      markJsStallOnActiveLanes(480);
      const stalls = lines().filter(l => l.includes('step=js-stall'));
      expect(stalls).toEqual([
        '[CALLLAT] lane=1to1-in cid=live1 step=js-stall t=61250 dt=250 driftMs=480',
        '[CALLLAT] lane=grp-join cid=live2 step=js-stall t=61250 dt=250 driftMs=480',
      ]);
    });
    it('is a no-op with no lanes and never throws', () => {
      expect(() => markJsStallOnActiveLanes(999)).not.toThrow();
      expect(lines()).toEqual([]);
    });
    it('a js-stall row does NOT count as liveness — recurring stalls cannot keep a finished lane live (Edge row 31)', () => {
      logCallLat('grp-join', 'done', 'state:joined');        // last REAL row at t=0
      nowMs += 40_000;
      markJsStallOnActiveLanes(300);                         // within 60 s of the real row → stamped
      nowMs += 40_000;                                       // 80 s after the real row, 40 s after the stall row
      markJsStallOnActiveLanes(300);                         // must NOT be stamped: liveness is the REAL row
      const stalls = lines().filter(l => l.includes('cid=done') && l.includes('step=js-stall'));
      expect(stalls).toEqual(['[CALLLAT] lane=grp-join cid=done step=js-stall t=40000 dt=40000 driftMs=300']);
      // …and the stall row still advanced `last`, so the next real row's dt is measured from it.
      nowMs += 1_000;
      logCallLat('grp-join', 'done', 'late');
      expect(lines().pop()).toBe('[CALLLAT] lane=grp-join cid=done step=late t=81000 dt=41000');
    });
  });
});
