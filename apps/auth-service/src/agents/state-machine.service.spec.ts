import {ForbiddenException} from '@nestjs/common';
import {
  AgentStateMachine, type AgentActorRole, type AgentStatus,
} from './state-machine.service';

const ALL_STATES: AgentStatus[] = [
  'DRAFT', 'PROFILE_COMPLETE', 'KYC_PENDING', 'DOCS_PENDING',
  'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'ACTIVE',
];
const ALL_ACTORS: AgentActorRole[] = ['AGENT', 'ADMIN', 'OPS', 'SYSTEM'];

const LEGAL: Array<[AgentStatus, AgentStatus, AgentActorRole]> = [
  ['DRAFT',            'PROFILE_COMPLETE', 'AGENT'],
  ['PROFILE_COMPLETE', 'KYC_PENDING',      'AGENT'],
  ['KYC_PENDING',      'DOCS_PENDING',     'SYSTEM'],
  ['DOCS_PENDING',     'SUBMITTED',        'AGENT'],
  ['SUBMITTED',        'UNDER_REVIEW',     'ADMIN'],
  ['UNDER_REVIEW',     'APPROVED',         'ADMIN'],
  ['UNDER_REVIEW',     'REJECTED',         'ADMIN'],
  ['APPROVED',         'ACTIVE',           'OPS'],
  // AgentService.decide() now performs APPROVED→ACTIVE inside its
  // transaction once the admin click lands; the FSM table allows the
  // SYSTEM actor for this auto-activation step.
  ['APPROVED',         'ACTIVE',           'SYSTEM'],
  ['REJECTED',         'DRAFT',            'AGENT'],
];

describe('AgentStateMachine', () => {
  const fsm = new AgentStateMachine();

  describe('valid transitions', () => {
    test.each(LEGAL)('%s → %s by %s is allowed', (from, to, actor) => {
      expect(() => fsm.assert(from, to, actor)).not.toThrow();
    });
  });

  describe('end-to-end happy path (DRAFT → ACTIVE), replayed ×3', () => {
    for (const attempt of [1, 2, 3]) {
      it(`attempt #${attempt}: walks the full onboarding lifecycle`, () => {
        const path: Array<[AgentStatus, AgentStatus, AgentActorRole]> = [
          ['DRAFT',            'PROFILE_COMPLETE', 'AGENT'],
          ['PROFILE_COMPLETE', 'KYC_PENDING',      'AGENT'],
          ['KYC_PENDING',      'DOCS_PENDING',     'SYSTEM'],
          ['DOCS_PENDING',     'SUBMITTED',        'AGENT'],
          ['SUBMITTED',        'UNDER_REVIEW',     'ADMIN'],
          ['UNDER_REVIEW',     'APPROVED',         'ADMIN'],
          ['APPROVED',         'ACTIVE',           'OPS'],
        ];
        for (const [from, to, actor] of path) {
          expect(() => fsm.assert(from, to, actor)).not.toThrow();
        }
      });
    }
  });

  describe('rejection + recovery loop', () => {
    it('ADMIN can reject, then AGENT can re-enter DRAFT to fix issues', () => {
      expect(() => fsm.assert('UNDER_REVIEW', 'REJECTED', 'ADMIN')).not.toThrow();
      expect(() => fsm.assert('REJECTED', 'DRAFT', 'AGENT')).not.toThrow();
    });
  });

  describe('specific gotchas', () => {
    it('AGENT cannot self-approve', () => {
      expect(() => fsm.assert('UNDER_REVIEW', 'APPROVED', 'AGENT'))
        .toThrow(ForbiddenException);
    });
    it('AGENT cannot skip PROFILE_COMPLETE', () => {
      expect(() => fsm.assert('DRAFT', 'KYC_PENDING', 'AGENT'))
        .toThrow(ForbiddenException);
    });
    it('OPS cannot activate before APPROVED', () => {
      expect(() => fsm.assert('SUBMITTED', 'ACTIVE', 'OPS'))
        .toThrow(ForbiddenException);
    });
    it('SYSTEM cannot move docs along — only AGENT submits', () => {
      expect(() => fsm.assert('DOCS_PENDING', 'SUBMITTED', 'SYSTEM'))
        .toThrow(ForbiddenException);
    });
    it('ACTIVE is terminal — no further transitions allowed', () => {
      for (const actor of ALL_ACTORS) {
        for (const to of ALL_STATES) {
          if (to === 'ACTIVE') continue;
          expect(() => fsm.assert('ACTIVE', to, actor)).toThrow(ForbiddenException);
        }
      }
    });
  });

  describe('exhaustive state × actor matrix — every illegal move rejected', () => {
    const legalSet = new Set(LEGAL.map(t => t.join('|')));
    let legalCount = 0;
    let illegalCount = 0;

    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue;
        for (const actor of ALL_ACTORS) {
          const key = `${from}|${to}|${actor}`;
          if (legalSet.has(key)) {
            legalCount++;
            it(`ALLOW ${from} → ${to} by ${actor}`, () => {
              expect(() => fsm.assert(from, to, actor)).not.toThrow();
            });
          } else {
            illegalCount++;
            it(`REJECT ${from} → ${to} by ${actor}`, () => {
              expect(() => fsm.assert(from, to, actor)).toThrow(ForbiddenException);
            });
          }
        }
      }
    }

    it('covered the full matrix (9 × 8 × 4 = 288 transitions)', () => {
      expect(legalCount + illegalCount).toBe(288);
    });
  });

  describe('nextStates helper', () => {
    it('returns every legal onward step for a given (state, actor)', () => {
      expect(fsm.nextStates('UNDER_REVIEW', 'ADMIN').sort())
        .toEqual(['APPROVED', 'REJECTED']);
      expect(fsm.nextStates('DRAFT', 'AGENT'))
        .toEqual(['PROFILE_COMPLETE']);
      expect(fsm.nextStates('DRAFT', 'OPS')).toEqual([]);
    });
  });
});
