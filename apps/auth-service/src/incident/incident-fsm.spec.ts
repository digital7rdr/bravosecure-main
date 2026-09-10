import {ForbiddenException} from '@nestjs/common';
import {assertIncidentTransition} from './incident-fsm';

describe('incident FSM', () => {
  it('allows the full linear lifecycle for a manager', () => {
    expect(() => assertIncidentTransition('submitted', 'received', 'manager')).not.toThrow();
    expect(() => assertIncidentTransition('received', 'under_review', 'manager')).not.toThrow();
    expect(() => assertIncidentTransition('under_review', 'action_assigned', 'manager')).not.toThrow();
    expect(() => assertIncidentTransition('action_assigned', 'resolved', 'manager')).not.toThrow();
    expect(() => assertIncidentTransition('resolved', 'closed', 'manager')).not.toThrow();
  });

  it('allows rework (resolved → under_review)', () => {
    expect(() => assertIncidentTransition('resolved', 'under_review', 'manager')).not.toThrow();
  });

  it('rejects skipping steps (submitted → resolved)', () => {
    expect(() => assertIncidentTransition('submitted', 'resolved', 'manager')).toThrow(ForbiddenException);
  });

  it('reopen (closed → under_review) is company-admin only', () => {
    expect(() => assertIncidentTransition('closed', 'under_review', 'manager')).toThrow(ForbiddenException);
    expect(() => assertIncidentTransition('closed', 'under_review', 'company_admin')).not.toThrow();
  });
});
