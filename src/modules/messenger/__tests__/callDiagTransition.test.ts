/**
 * WI-7.1 — the accepted-transition record + the KO-5/6/7 (B-566) client
 * wirings that ride the same review round.
 *
 * `logCallTransition` completes the [CALLSM] lane: rejected transitions have
 * long-standing pinned forms; this is the accepted-side twin, so a release
 * logcat (`grep CALLSM`) reconstructs the entire call lifecycle. IDs and
 * enums only — logAudit scans this directory.
 */
import {logCallTransition} from '../runtime/callDiag';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

function stripped(rel: string[]): string {
  return readFileSync(join(process.cwd(), ...rel), 'utf8')
    .split(/\r?\n/)
    .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n');
}

describe('WI-7.1 — logCallTransition', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('emits one single-line [CALLSM] transition record with short ids', () => {
    logCallTransition({
      callId: 'abcdef1234567890', gen: 4,
      prev: 'ringing', next: 'connecting', event: 'acceptInner', source: 'controller',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0][0]);
    expect(line).toBe('[CALLSM] transition cid=abcdef12 gen=4 prev=ringing next=connecting event=acceptInner source=controller');
    expect(line).not.toContain('\n'); // single-line, greppable
  });

  it('a missing gen renders "-" (unknown ≠ zero), a missing callId renders "-"', () => {
    logCallTransition({callId: undefined, prev: 'idle', next: 'calling', event: 'startOutgoing', source: 'controller'});
    const line = String(warn.mock.calls[0][0]);
    expect(line).toContain('cid=-');
    expect(line).toContain('gen=-');
  });
});

describe('WI-7.1 — wiring (source scans)', () => {
  it('CallController.setState records ACCEPTED transitions (rejected forms already pinned)', () => {
    const src = stripped(['src', 'modules', 'messenger', 'webrtc', 'callController.ts']);
    const legal = src.indexOf('LEGAL_TRANSITIONS[this.state].includes(next)');
    const record = src.indexOf('logCallTransition({', legal);
    const assign = src.indexOf('this.state = next;', legal);
    // The record sits between the legality gate and the state write — an
    // accepted transition, never a rejected or absorbed one.
    expect(legal).toBeGreaterThan(-1);
    expect(record).toBeGreaterThan(legal);
    expect(record).toBeLessThan(assign);
  });

  it('the accept latch and the cancel funnel report into the [CALLSM] lane', () => {
    const src = stripped(['src', 'modules', 'messenger', 'push', 'fcmBootstrap.ts']);
    expect(src).toContain("logCallSm('latch.accept'");
    expect(src).toContain("logCallSm('notif.cancel.apply'");
  });

  it('round 3 — the GROUP funnel is the hook setter, and it is the only door to setStateRaw', () => {
    // The registry patch path never carries `state` in production (milestones
    // re-register/end; reconnecting↔joined never touches the registry), so a
    // registry-side record alone is VACUOUS. The React setter wrapper is the
    // real funnel: prev tracked synchronously (lastStateRef), transition
    // logged before the write, and no call site can reach the raw setter.
    const src = stripped(['src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts']);
    expect(src).toMatch(/const \[state, setStateRaw\]\s+= useState<GroupCallState>\('idle'\);/);
    const rawUses = src.match(/setStateRaw\(/g) ?? [];
    expect(rawUses).toHaveLength(1); // exactly the wrapper's own call
    expect(src).toContain('lastStateRef.current = next;');
    const wrapperLog = src.indexOf("event:  'setState', source: 'useGroupCall',");
    const rawCall = src.indexOf('setStateRaw(next);');
    expect(wrapperLog).toBeGreaterThan(-1);
    expect(wrapperLog).toBeLessThan(rawCall); // logged before the write
  });
});

describe('KO-6 (B-566/B-567) — the client consumes sfu.host-changed (source scans)', () => {
  it('both frame handlers promote on the server host handoff, promote-only', () => {
    const src = stripped(['src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts']);
    const cases = src.match(/frame\.event === 'sfu\.host-changed'/g) ?? [];
    expect(cases).toHaveLength(2); // primary + restore-path handler (the drift pair)
    const promotes = src.match(/newHost && ownUid && newHost === ownUid && !isHostRef\.current/g) ?? [];
    expect(promotes).toHaveLength(2);
    // Promote-only: no demotion write anywhere near the handler.
    expect(src).not.toMatch(/setIsHost\(false\);\s*\n\s*patchActiveGroupCall/);
  });

  it('B-567 — the frame is actually ROUTABLE: a handler without its allowlist entry is dead code', () => {
    // Review round 1 (race agent F1): the handlers above shipped while
    // SFU_FRAME_EVENTS silently dropped the frame — the THIRD instance of
    // this class in that set (sfu.unmuted / producer-paused before it). A
    // handler-existence scan alone is vacuous; the routing set is the gate.
    const {SFU_FRAME_EVENTS} = require('../webrtc/sfuDispatcher') as typeof import('../webrtc/sfuDispatcher');
    expect(SFU_FRAME_EVENTS.has('sfu.host-changed')).toBe(true);
  });
});

describe('KO-7 (B-566) — the cancel-all covers every rung user (source scans)', () => {
  it('all three ring emits record their targets; both cancel sites union them', () => {
    const src = stripped(['src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts']);
    const captures = src.match(/rungUsersRef\.current\.add\(/g) ?? [];
    expect(captures).toHaveLength(3); // boot ring, invite, re-ring
    const unions = src.match(/\.\.\.rungUsersRef\.current,/g) ?? [];
    expect(unions).toHaveLength(2);   // leaveInternal + the boot-catch cancel
  });
});
