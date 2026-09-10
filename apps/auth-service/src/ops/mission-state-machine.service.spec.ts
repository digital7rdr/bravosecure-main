import {ForbiddenException} from '@nestjs/common';
import {MissionStateMachine, type MissionStatus, type MissionActor} from './mission-state-machine.service';

const ALL_STATES: MissionStatus[] = [
  'DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED', 'ABORTED',
];
const ALL_ACTORS: MissionActor[] = ['AGENT', 'OPS', 'ADMIN', 'SYSTEM'];

const LEGAL: Array<[MissionStatus, MissionStatus, MissionActor]> = [
  ['DISPATCHED', 'PICKUP',    'AGENT'],
  ['PICKUP',     'LIVE',      'AGENT'],
  ['LIVE',       'COMPLETED', 'AGENT'],
  // FSM-1 reconciliation — SOS is reachable from DISPATCHED too (alarm before pickup).
  ['DISPATCHED', 'SOS',       'AGENT'],
  ['PICKUP',     'SOS',       'AGENT'],
  ['LIVE',       'SOS',       'AGENT'],
  ['PICKUP',     'SOS',       'OPS'],
  ['LIVE',       'SOS',       'OPS'],
  // Client panic (sos.service) → SYSTEM, same from-states as the agent path.
  ['DISPATCHED', 'SOS',       'SYSTEM'],
  ['PICKUP',     'SOS',       'SYSTEM'],
  ['LIVE',       'SOS',       'SYSTEM'],
  ['SOS',        'LIVE',      'OPS'],
  ['SOS',        'LIVE',      'ADMIN'],
  ['SOS',        'COMPLETED', 'AGENT'],
  ['SOS',        'COMPLETED', 'OPS'],
  ['SOS',        'COMPLETED', 'ADMIN'],
  // Drift-janitor data-repair close (booking already COMPLETED) → SYSTEM.
  ['DISPATCHED', 'COMPLETED', 'SYSTEM'],
  ['PICKUP',     'COMPLETED', 'SYSTEM'],
  ['LIVE',       'COMPLETED', 'SYSTEM'],
  ['SOS',        'COMPLETED', 'SYSTEM'],
];

const ABORTABLE: MissionStatus[] = ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS'];

describe('MissionStateMachine', () => {
  const fsm = new MissionStateMachine();

  describe('happy path (DISPATCHED → COMPLETED), replayed ×3', () => {
    for (const attempt of [1, 2, 3]) {
      it(`attempt #${attempt}: walks full mission lifecycle`, () => {
        expect(() => fsm.assert('DISPATCHED', 'PICKUP',    'AGENT')).not.toThrow();
        expect(() => fsm.assert('PICKUP',     'LIVE',      'AGENT')).not.toThrow();
        expect(() => fsm.assert('LIVE',       'COMPLETED', 'AGENT')).not.toThrow();
      });
    }
  });

  describe('valid forward transitions', () => {
    test.each(LEGAL)('%s → %s by %s is allowed', (from, to, actor) => {
      expect(() => fsm.assert(from, to, actor)).not.toThrow();
    });
  });

  describe('SOS flow', () => {
    it('AGENT can raise SOS from LIVE', () => {
      expect(() => fsm.assert('LIVE', 'SOS', 'AGENT')).not.toThrow();
    });
    it('OPS can escalate LIVE → SOS from the dashboard', () => {
      expect(() => fsm.assert('LIVE', 'SOS', 'OPS')).not.toThrow();
    });
    it('OPS can resolve SOS back to LIVE (false alarm)', () => {
      expect(() => fsm.assert('SOS', 'LIVE', 'OPS')).not.toThrow();
    });
    it('AGENT cannot self-resolve SOS → LIVE (needs ops)', () => {
      expect(() => fsm.assert('SOS', 'LIVE', 'AGENT')).toThrow(ForbiddenException);
    });
  });

  describe('abort — Ops/Admin can terminate any non-terminal mission', () => {
    it.each(ABORTABLE)('OPS can abort from %s', (from) => {
      expect(() => fsm.assert(from, 'ABORTED', 'OPS')).not.toThrow();
    });
    it.each(ABORTABLE)('ADMIN can abort from %s', (from) => {
      expect(() => fsm.assert(from, 'ABORTED', 'ADMIN')).not.toThrow();
    });
    it('AGENT cannot abort — only ops/admin', () => {
      expect(() => fsm.assert('LIVE', 'ABORTED', 'AGENT')).toThrow(ForbiddenException);
    });
    it('cannot abort terminal missions', () => {
      expect(() => fsm.assert('COMPLETED', 'ABORTED', 'OPS')).toThrow(ForbiddenException);
      expect(() => fsm.assert('ABORTED',   'ABORTED', 'OPS')).toThrow(ForbiddenException);
    });
  });

  describe('specific gotchas', () => {
    it('rejects skipping PICKUP (DISPATCHED → LIVE)', () => {
      expect(() => fsm.assert('DISPATCHED', 'LIVE', 'AGENT')).toThrow(ForbiddenException);
    });
    it('rejects backwards transitions', () => {
      expect(() => fsm.assert('LIVE',      'PICKUP',     'AGENT')).toThrow(ForbiddenException);
      expect(() => fsm.assert('COMPLETED', 'LIVE',       'AGENT')).toThrow(ForbiddenException);
    });
    it('SYSTEM cannot drive the CREW-forward moves (pickup / go-live) — those are AGENT-only', () => {
      // SYSTEM may raise SOS (client panic), abort, or data-repair-complete a mission (sweeps),
      // but it can never fabricate crew progress.
      expect(() => fsm.assert('DISPATCHED', 'PICKUP', 'SYSTEM')).toThrow(ForbiddenException);
      expect(() => fsm.assert('PICKUP',     'LIVE',   'SYSTEM')).toThrow(ForbiddenException);
    });
  });

  describe('exhaustive matrix — 6 × 5 × 4 = 120 transitions, every illegal one rejected', () => {
    const legalKey = new Set(LEGAL.map(t => t.join('|')));
    const abortKey = new Set(ABORTABLE.flatMap(f => (['OPS', 'ADMIN', 'SYSTEM'] as const).map(a => `${f}|ABORTED|${a}`)));

    let legal = 0, illegal = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue;
        for (const actor of ALL_ACTORS) {
          const key = `${from}|${to}|${actor}`;
          if (legalKey.has(key) || abortKey.has(key)) {
            legal++;
            it(`ALLOW ${from} → ${to} by ${actor}`, () => {
              expect(() => fsm.assert(from, to, actor)).not.toThrow();
            });
          } else {
            illegal++;
            it(`REJECT ${from} → ${to} by ${actor}`, () => {
              expect(() => fsm.assert(from, to, actor)).toThrow(ForbiddenException);
            });
          }
        }
      }
    }

    it('matrix coverage sums to 120', () => {
      expect(legal + illegal).toBe(120);
    });
  });

  describe('nextStates helper', () => {
    it('returns forward moves plus abort for OPS on LIVE', () => {
      expect(fsm.nextStates('LIVE', 'OPS').sort()).toEqual(['ABORTED', 'SOS']);
    });
    it('returns [PICKUP, SOS] for AGENT on DISPATCHED (SOS reachable pre-pickup)', () => {
      expect(fsm.nextStates('DISPATCHED', 'AGENT')).toEqual(['PICKUP', 'SOS']);
    });
    it('returns empty for terminal states', () => {
      expect(fsm.nextStates('COMPLETED', 'OPS')).toEqual([]);
      expect(fsm.nextStates('ABORTED',   'OPS')).toEqual([]);
    });
  });
});
