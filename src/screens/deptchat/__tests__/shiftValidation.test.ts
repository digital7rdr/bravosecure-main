import {validateShiftDraft} from '../shiftValidation';

/**
 * Step 21 — the shift editor's Save guard. These mirror the runbook acceptance
 * (radius > 0, start < end, >= 1 member) and the server's createShift/assignCpos
 * invariants, so an invalid draft can never reach the API.
 *
 * G-ab LOW-3 — the CODE is the contract now, not the prose: the editor's
 * edit-to-zero confirm branches on `code === 'assignees'`, so these pin the
 * codes and treat messages as display-only.
 */
const base = {startMs: 1_000, endMs: 2_000, selectedCount: 1, hasCoords: false, radius: 150};

describe('validateShiftDraft (Step 21)', () => {
  it('accepts a valid draft', () => {
    expect(validateShiftDraft(base)).toBeNull();
    expect(validateShiftDraft({...base, hasCoords: true, radius: 150})).toBeNull();
  });

  it('rejects end <= start with code=time', () => {
    expect(validateShiftDraft({...base, endMs: 1_000})?.code).toBe('time');
    expect(validateShiftDraft({...base, startMs: 5_000, endMs: 2_000})?.code).toBe('time');
  });

  it('rejects zero assignees with code=assignees, using the caller’s noun', () => {
    const err = validateShiftDraft({...base, selectedCount: 0, noun: 'CPO'});
    expect(err?.code).toBe('assignees');
    expect(err?.message).toMatch(/at least one CPO/i);
    // Default noun is tenant-neutral.
    expect(validateShiftDraft({...base, selectedCount: 0})?.message).toMatch(/at least one member/i);
  });

  it('rejects a non-positive radius only when a geofence centre is set, code=radius', () => {
    expect(validateShiftDraft({...base, hasCoords: true, radius: 0})?.code).toBe('radius');
    // No coords => radius is irrelevant (server skips the radius check).
    expect(validateShiftDraft({...base, hasCoords: false, radius: 0})).toBeNull();
  });

  it('ORDER: time outranks assignees outranks radius (the edit-to-zero confirm depends on it)', () => {
    expect(validateShiftDraft({...base, endMs: 0, selectedCount: 0, hasCoords: true, radius: 0})?.code).toBe('time');
    expect(validateShiftDraft({...base, selectedCount: 0, hasCoords: true, radius: 0})?.code).toBe('assignees');
  });
});
