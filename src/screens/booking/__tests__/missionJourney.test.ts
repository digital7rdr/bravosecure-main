import {journeyStep, clampJourney, STEP_LABELS} from '../missionJourney';
import {describeStatus, resumeTargetFor, findResumableBooking} from '../bookingStatus';

describe('journeyStep — shared mission progress (Step 18)', () => {
  const b = (status: string) => ({status});
  const m = (status: string) => ({status});

  it('maps the 6 on-path steps to the right index + advance actor', () => {
    expect(journeyStep(b('DISPATCHING'))).toMatchObject({index: 1, canAdvanceBy: 'system', sos: false});
    expect(journeyStep(b('CONFIRMED'))).toMatchObject({index: 2, canAdvanceBy: 'agency'});
    expect(journeyStep(b('CONFIRMED'), m('DISPATCHED'))).toMatchObject({index: 3, canAdvanceBy: 'lead'});
    expect(journeyStep(b('CONFIRMED'), m('PICKUP'))).toMatchObject({index: 4, canAdvanceBy: 'lead'});
    expect(journeyStep(b('CONFIRMED'), m('LIVE'))).toMatchObject({index: 5, canAdvanceBy: 'lead'});
    expect(journeyStep(b('CONFIRMED'), m('COMPLETED'))).toMatchObject({index: 6, canAdvanceBy: 'none'});
    expect(journeyStep(b('COMPLETED'))).toMatchObject({index: 6, canAdvanceBy: 'none'});
  });

  it('labels each step from the shared STEP_LABELS', () => {
    expect(journeyStep(b('DISPATCHING')).label).toBe(STEP_LABELS[0]);
    expect(journeyStep(b('CONFIRMED'), m('LIVE')).label).toBe(STEP_LABELS[4]);
  });

  it('SOS overlays the active step without becoming a 7th step', () => {
    const j = journeyStep(b('CONFIRMED'), m('SOS'));
    expect(j.sos).toBe(true);
    expect(j.index).toBe(5);
    expect(j.sideState).toBeUndefined();
  });

  it('produces terminal side-states for CANCELLED / NO_PROVIDER / ABORTED', () => {
    expect(journeyStep(b('CANCELLED')).sideState).toBe('CANCELLED');
    expect(journeyStep(b('NO_PROVIDER')).sideState).toBe('NO_PROVIDER');
    expect(journeyStep(b('CONFIRMED'), m('ABORTED')).sideState).toBe('ABORTED');
  });

  it('a booking terminal outranks any mission state', () => {
    // A cancelled booking that still carries a stale DISPATCHED mission reads as cancelled.
    expect(journeyStep(b('CANCELLED'), m('DISPATCHED')).sideState).toBe('CANCELLED');
    expect(journeyStep(b('COMPLETED'), m('LIVE')).index).toBe(6);
  });

  it('is defensive about empty / unknown / legacy statuses', () => {
    expect(journeyStep(b('')).index).toBe(0);
    expect(journeyStep(b('PENDING_OPS')).index).toBe(1);
    expect(journeyStep({status: null as never})).toMatchObject({index: 0});
  });
});

describe('clampJourney — monotonic, no backwards regression (§34)', () => {
  it('returns the forward step when index advances', () => {
    const prev = journeyStep({status: 'CONFIRMED'}, {status: 'PICKUP'}); // 4
    const next = journeyStep({status: 'CONFIRMED'}, {status: 'LIVE'});   // 5
    expect(clampJourney(prev, next).index).toBe(5);
  });

  it('never regresses on a stale poll (keeps the higher index)', () => {
    const prev = journeyStep({status: 'CONFIRMED'}, {status: 'LIVE'});       // 5
    const stale = journeyStep({status: 'CONFIRMED'}, {status: 'DISPATCHED'}); // 3
    expect(clampJourney(prev, stale).index).toBe(5);
  });

  it('lets a terminal side-state through even if its index is lower', () => {
    const prev = journeyStep({status: 'CONFIRMED'}, {status: 'LIVE'});  // 5
    const cancelled = journeyStep({status: 'CANCELLED'});               // side-state, index 0
    expect(clampJourney(prev, cancelled).sideState).toBe('CANCELLED');
  });

  it('a freshly-raised SOS ribbon is never suppressed by the clamp', () => {
    const prev = journeyStep({status: 'CONFIRMED'}, {status: 'LIVE'});     // 5, no sos
    const sos = journeyStep({status: 'CONFIRMED'}, {status: 'SOS'});        // 5, sos
    expect(clampJourney(prev, sos).sos).toBe(true);
  });

  it('returns next verbatim when there is no prior step', () => {
    const next = journeyStep({status: 'DISPATCHING'});
    expect(clampJourney(null, next)).toBe(next);
  });
});

describe('bookingStatus — auto-dispatch statuses (Step 18)', () => {
  it('describes DISPATCHING as an active search', () => {
    const d = describeStatus('DISPATCHING');
    expect(d.label).toBe('SEARCHING');
    expect(d.isActive).toBe(true);
  });

  it('describes NO_PROVIDER as terminal-but-attention (never an active slot)', () => {
    const d = describeStatus('NO_PROVIDER');
    expect(d.isActive).toBe(false);
    expect(d.needsAttention).toBe(true);
  });

  it('resumes DISPATCHING → FindingDetail and NO_PROVIDER → NoDetail', () => {
    expect(resumeTargetFor('b1', 'DISPATCHING')).toEqual({screen: 'FindingDetail', bookingId: 'b1'});
    expect(resumeTargetFor('b1', 'NO_PROVIDER')).toEqual({screen: 'NoDetail', bookingId: 'b1'});
  });

  it('findResumableBooking treats DISPATCHING as active (resumable) but NO_PROVIDER as terminal', () => {
    // A live search must resume; a failed search must NOT occupy the one-mission slot (LB17).
    const rows = [
      {id: 'np', status: 'NO_PROVIDER'},
      {id: 'd1', status: 'DISPATCHING'},
    ];
    expect(findResumableBooking(rows)?.id).toBe('d1');
    // With only a NO_PROVIDER row, nothing is resumable → the client can request again.
    expect(findResumableBooking([{id: 'np', status: 'NO_PROVIDER'}])).toBeUndefined();
    // CANCELLED / COMPLETED stay terminal too.
    expect(findResumableBooking([{id: 'c', status: 'CANCELLED'}, {id: 'k', status: 'COMPLETED'}])).toBeUndefined();
  });
});
