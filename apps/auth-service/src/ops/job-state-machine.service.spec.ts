import {ForbiddenException} from '@nestjs/common';
import {JobStateMachine, type JobStatus, type JobActor} from './job-state-machine.service';

const ALL_STATES: JobStatus[] = ['PUBLISHED', 'REVIEW', 'ASSIGNED', 'DISPATCHED', 'CANCELLED'];
const ALL_ACTORS: JobActor[]  = ['OPS', 'ADMIN', 'SYSTEM'];

const LEGAL: Array<[JobStatus, JobStatus, JobActor]> = [
  ['PUBLISHED', 'REVIEW',     'OPS'],
  ['REVIEW',    'ASSIGNED',   'OPS'],
  ['REVIEW',    'ASSIGNED',   'ADMIN'],
  ['ASSIGNED',  'DISPATCHED', 'SYSTEM'],
  ['ASSIGNED',  'DISPATCHED', 'OPS'],
];
const CANCELLABLE: JobStatus[] = ['PUBLISHED', 'REVIEW', 'ASSIGNED'];

describe('JobStateMachine', () => {
  const fsm = new JobStateMachine();

  describe('happy path (PUBLISHED → DISPATCHED), replayed ×3', () => {
    for (const attempt of [1, 2, 3]) {
      it(`attempt #${attempt}: full job lifecycle`, () => {
        expect(() => fsm.assert('PUBLISHED', 'REVIEW',     'OPS')).not.toThrow();
        expect(() => fsm.assert('REVIEW',    'ASSIGNED',   'OPS')).not.toThrow();
        expect(() => fsm.assert('ASSIGNED',  'DISPATCHED', 'OPS')).not.toThrow();
      });
    }
  });

  describe('cancel — OPS/ADMIN can cancel any pre-dispatch job', () => {
    it.each(CANCELLABLE)('OPS cancels from %s', (from) => {
      expect(() => fsm.assert(from, 'CANCELLED', 'OPS')).not.toThrow();
    });
    it.each(CANCELLABLE)('ADMIN cancels from %s', (from) => {
      expect(() => fsm.assert(from, 'CANCELLED', 'ADMIN')).not.toThrow();
    });
    it('SYSTEM cannot cancel', () => {
      expect(() => fsm.assert('PUBLISHED', 'CANCELLED', 'SYSTEM')).toThrow(ForbiddenException);
    });
    it('cannot cancel DISPATCHED or CANCELLED', () => {
      expect(() => fsm.assert('DISPATCHED', 'CANCELLED', 'OPS')).toThrow(ForbiddenException);
      expect(() => fsm.assert('CANCELLED',  'CANCELLED', 'OPS')).toThrow(ForbiddenException);
    });
  });

  describe('rejects illegal transitions', () => {
    it('cannot skip REVIEW', () => {
      expect(() => fsm.assert('PUBLISHED', 'ASSIGNED',   'OPS')).toThrow(ForbiddenException);
      expect(() => fsm.assert('PUBLISHED', 'DISPATCHED', 'OPS')).toThrow(ForbiddenException);
    });
    it('cannot revert DISPATCHED → ASSIGNED', () => {
      expect(() => fsm.assert('DISPATCHED', 'ASSIGNED', 'OPS')).toThrow(ForbiddenException);
    });
  });

  describe('exhaustive matrix — 5 × 4 × 3 = 60 transitions', () => {
    const legalKey = new Set(LEGAL.map(t => t.join('|')));
    const cancelKey = new Set(
      CANCELLABLE.flatMap(f => (['OPS', 'ADMIN'] as const).map(a => `${f}|CANCELLED|${a}`)),
    );
    let legal = 0, illegal = 0;
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue;
        for (const actor of ALL_ACTORS) {
          const key = `${from}|${to}|${actor}`;
          if (legalKey.has(key) || cancelKey.has(key)) {
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
    it('matrix coverage sums to 60', () => {
      expect(legal + illegal).toBe(60);
    });
  });
});
