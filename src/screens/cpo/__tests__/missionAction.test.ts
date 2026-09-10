import {missionAction, missionActionView} from '../missionAction';

describe('missionAction — lead-only context-aware mission control (Step 21)', () => {
  it('maps each lead state to its single next transition', () => {
    expect(missionAction('DISPATCHED', true)).toBe('start');
    expect(missionAction('PICKUP', true)).toBe('go-live');
    expect(missionAction('LIVE', true)).toBe('finish');
  });

  it('gives a non-lead NO advance action in any state (read-only ride-along)', () => {
    for (const st of ['DISPATCHED', 'PICKUP', 'LIVE', 'SOS', 'COMPLETED']) {
      expect(missionAction(st, false)).toBe('none');
    }
  });

  it('gives the lead no advance from SOS / terminal / unknown states', () => {
    expect(missionAction('SOS', true)).toBe('none');
    expect(missionAction('COMPLETED', true)).toBe('none');
    expect(missionAction('ABORTED', true)).toBe('none');
    expect(missionAction('', true)).toBe('none');
    expect(missionAction(null, true)).toBe('none');
  });

  it('is case-insensitive', () => {
    expect(missionAction('live', true)).toBe('finish');
  });

  it('view: the labels name the EVENT the driver is confirming, not the FSM', () => {
    // Founder's August 2026 device-feedback deck: the stages are Arrived at pickup /
    // Client Picked Up / Client Dropped Off. "Go live" described the state machine.
    expect(missionActionView('DISPATCHED', true)).toMatchObject({label: 'Arrived at pickup'});
    expect(missionActionView('PICKUP', true)).toMatchObject({label: 'Client Picked Up'});
    expect(missionActionView('LIVE', true)).toMatchObject({label: 'Client Dropped Off'});
    expect(missionActionView('LIVE', false).action).toBe('none');
  });

  it('view: confirming a person is aboard is a deliberate, confirmed act', () => {
    // PICKUP→LIVE stamps live_at, which drives the proof gate, the pre-LIVE
    // full-refund boundary and the executive check-in schedule. It used to fire
    // on one unconfirmed tap.
    expect(missionActionView('PICKUP', true).confirm).toBe(true);
    expect(missionActionView('LIVE', true).confirm).toBe(true);
    // Arriving at the pickup point commits nothing irreversible — no dialog.
    expect(missionActionView('DISPATCHED', true).confirm).toBe(false);
  });
});
