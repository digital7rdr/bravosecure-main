import {
  assertTransition, canTransition, isLive, LIVE_STATUS_SQL, LIVE_STATUSES,
  type ProtectionSessionStatus,
} from './protection-session.fsm';

describe('protection-session FSM', () => {
  it('LIVE_STATUSES is exactly the three non-terminal states', () => {
    expect([...LIVE_STATUSES]).toEqual(['REQUESTED', 'ACTIVE', 'ENDING']);
  });

  it('isLive is true only for live states', () => {
    expect(isLive('REQUESTED')).toBe(true);
    expect(isLive('ACTIVE')).toBe(true);
    expect(isLive('ENDING')).toBe(true);
    expect(isLive('COMPLETED')).toBe(false);
    expect(isLive('ABORTED')).toBe(false);
    expect(isLive('nonsense')).toBe(false);
  });

  it('LIVE_STATUS_SQL renders the quoted IN-list used by the queries + the DB index', () => {
    expect(LIVE_STATUS_SQL).toBe(`'REQUESTED','ACTIVE','ENDING'`);
  });

  it('allows only the spec §3 transitions', () => {
    const good: Array<[ProtectionSessionStatus, ProtectionSessionStatus]> = [
      ['REQUESTED', 'ACTIVE'],
      ['REQUESTED', 'ABORTED'],
      ['REQUESTED', 'ENDING'],
      ['REQUESTED', 'COMPLETED'],
      ['ACTIVE', 'ENDING'],
      ['ACTIVE', 'COMPLETED'],
      ['ENDING', 'COMPLETED'],
    ];
    for (const [from, to] of good) {expect(canTransition(from, to)).toBe(true);}
  });

  it('rejects transitions out of terminal states and backwards moves', () => {
    const bad: Array<[ProtectionSessionStatus, ProtectionSessionStatus]> = [
      ['COMPLETED', 'ACTIVE'],
      ['ABORTED', 'ACTIVE'],
      ['ACTIVE', 'REQUESTED'],
      ['ACTIVE', 'ABORTED'],       // ABORT is only from REQUESTED (failed activation)
      ['ENDING', 'ACTIVE'],
      ['COMPLETED', 'ENDING'],
    ];
    for (const [from, to] of bad) {expect(canTransition(from, to)).toBe(false);}
  });

  it('assertTransition throws a typed error on an illegal move', () => {
    expect(() => assertTransition('COMPLETED', 'ACTIVE')).toThrow('protection_session_bad_transition:COMPLETED->ACTIVE');
    expect(() => assertTransition('REQUESTED', 'ACTIVE')).not.toThrow();
  });
});
