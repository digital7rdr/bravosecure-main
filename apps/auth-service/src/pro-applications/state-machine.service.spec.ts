import {ForbiddenException} from '@nestjs/common';
import {ProApplicationStateMachine, type ProActorRole, type ProApplicationStatus} from './state-machine.service';

describe('ProApplicationStateMachine', () => {
  const fsm = new ProApplicationStateMachine();

  const ok = (from: ProApplicationStatus, to: ProApplicationStatus, actor: ProActorRole) =>
    expect(() => fsm.assert(from, to, actor)).not.toThrow();
  const no = (from: ProApplicationStatus, to: ProApplicationStatus, actor: ProActorRole) =>
    expect(() => fsm.assert(from, to, actor)).toThrow(ForbiddenException);

  it('allows the happy path submit → proposal → accept → activate', () => {
    ok('PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'OPS_HANDLER');
    ok('PROPOSAL_CREATED', 'ACCEPTED', 'CLIENT');
    ok('ACCEPTED', 'ACTIVE', 'SYSTEM');
  });

  it('allows the revision loop', () => {
    ok('PROPOSAL_CREATED', 'REVISION_REQUESTED', 'CLIENT');
    ok('REVISION_REQUESTED', 'PROPOSAL_CREATED', 'OPS_HANDLER');
  });

  it('allows ops rejection at every pre-acceptance review stage', () => {
    ok('PENDING_PROPOSAL', 'REJECTED', 'OPS_HANDLER');
    ok('PROPOSAL_CREATED', 'REJECTED', 'OPS_HANDLER');
    ok('REVISION_REQUESTED', 'REJECTED', 'OPS_HANDLER');
  });

  it('refuses actor spoofing on decision edges', () => {
    no('PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'CLIENT');   // client cannot self-propose
    no('PROPOSAL_CREATED', 'ACCEPTED', 'OPS_HANDLER');      // ops cannot accept for the client
    no('PROPOSAL_CREATED', 'ACCEPTED', 'SYSTEM');
    no('ACCEPTED', 'ACTIVE', 'CLIENT');                     // activation is the payment txn (SYSTEM)
    no('PENDING_PROPOSAL', 'REJECTED', 'CLIENT');
  });

  it('refuses skipping stages', () => {
    no('PENDING_PROPOSAL', 'ACCEPTED', 'CLIENT');
    no('PENDING_PROPOSAL', 'ACTIVE', 'SYSTEM');
    no('PROPOSAL_CREATED', 'ACTIVE', 'SYSTEM');
    no('REVISION_REQUESTED', 'ACCEPTED', 'CLIENT');         // must wait for the revised proposal
  });

  it('allows withdrawal (CANCELLED) from every pre-activation state, by client or ops', () => {
    for (const from of ['PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED', 'ACCEPTED'] as const) {
      ok(from, 'CANCELLED', 'CLIENT');
      ok(from, 'CANCELLED', 'OPS_HANDLER');
    }
  });

  it('never cancels a paid plan — ACTIVE cannot become CANCELLED', () => {
    no('ACTIVE', 'CANCELLED', 'CLIENT');
    no('ACTIVE', 'CANCELLED', 'OPS_HANDLER');
    no('ACTIVE', 'CANCELLED', 'SYSTEM');
  });

  it('ACTIVE only expires (SYSTEM); REJECTED, EXPIRED and CANCELLED are terminal', () => {
    const statuses: ProApplicationStatus[] = [
      'PENDING_PROPOSAL', 'PROPOSAL_CREATED', 'REVISION_REQUESTED', 'ACCEPTED', 'ACTIVE', 'EXPIRED', 'REJECTED', 'CANCELLED',
    ];
    const actors: ProActorRole[] = ['CLIENT', 'OPS_HANDLER', 'SYSTEM'];
    ok('ACTIVE', 'EXPIRED', 'SYSTEM');
    for (const to of statuses) {
      for (const actor of actors) {
        if (!(to === 'EXPIRED' && actor === 'SYSTEM')) {no('ACTIVE', to, actor);}
        no('REJECTED', to, actor);
        no('EXPIRED', to, actor);
        no('CANCELLED', to, actor);
      }
    }
  });
});
