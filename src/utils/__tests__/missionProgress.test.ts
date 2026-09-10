/**
 * Stage boundaries for the mission progress pill (founder deck, pages 11/16/17).
 *
 * The four boundaries the deck's "verify progress across the complete mission"
 * actually turns on: before pickup, at pickup, after pickup (protection active),
 * and arrival — plus SOS, which used to be mislabelled as an approach leg.
 */
import {missionProgress, missionLeg} from '../missionProgress';

const base = {remainingM: 4200, hasRealFix: true};

describe('missionLeg — which end are we measuring to', () => {
  it('DISPATCHED and PICKUP are the approach to the pickup', () => {
    expect(missionLeg('DISPATCHED')).toBe('pickup');
    expect(missionLeg('PICKUP')).toBe('pickup');
  });

  it('LIVE is the run to the drop-off', () => {
    expect(missionLeg('LIVE')).toBe('dropoff');
  });

  it('SOS is a live drive, not an approach', () => {
    // It fell to the else branch and said "to pickup" during a live mission.
    expect(missionLeg('SOS')).toBe('dropoff');
  });

  it('a legacy booking flipped LIVE with no mission row still reads as under way', () => {
    expect(missionLeg('', 'LIVE')).toBe('dropoff');
  });

  it('is case-insensitive and safe on empty input', () => {
    expect(missionLeg('live')).toBe('dropoff');
    expect(missionLeg(null)).toBe('pickup');
    expect(missionLeg(undefined, undefined)).toBe('pickup');
  });
});

describe('missionProgress — the label at each boundary', () => {
  it('BEFORE pickup: distance to the pickup, not a dead 0%', () => {
    // The whole approach leg used to read "Awaiting live GPS" because the pill
    // was gated on the BOOKING being LIVE.
    const p = missionProgress({...base, missionStatus: 'DISPATCHED'});
    expect(p.leg).toBe('pickup');
    expect(p.label).toBe('4.2 km to pickup');
    expect(p.known).toBe(true);
  });

  it('AT pickup: still the pickup leg', () => {
    expect(missionProgress({...base, missionStatus: 'PICKUP'}).label).toBe('4.2 km to pickup');
  });

  it('AFTER pickup: the leg flips to the drop-off', () => {
    expect(missionProgress({...base, missionStatus: 'LIVE'}).label).toBe('4.2 km to drop-off');
  });

  it('ARRIVAL: a tiny remaining distance still reads honestly', () => {
    const p = missionProgress({missionStatus: 'LIVE', remainingM: 15, hasRealFix: true});
    expect(p.label).toBe('20 m to drop-off');
    expect(p.known).toBe(true);
  });

  it('SOS keeps the drop-off wording', () => {
    expect(missionProgress({...base, missionStatus: 'SOS'}).label).toBe('4.2 km to drop-off');
  });
});

describe('missionProgress — it says when it does not know', () => {
  it('no real fix says so rather than showing a false distance', () => {
    const p = missionProgress({...base, hasRealFix: false, missionStatus: 'LIVE'});
    expect(p.label).toBe('Awaiting live GPS');
    expect(p.known).toBe(false);
  });

  it('an unknown remaining distance says so too', () => {
    expect(missionProgress({missionStatus: 'LIVE', remainingM: null, hasRealFix: true}).known).toBe(false);
    expect(missionProgress({missionStatus: 'LIVE', remainingM: Number.NaN, hasRealFix: true}).known)
      .toBe(false);
  });

  it('still reports the correct leg while unknown', () => {
    // The pill may not know the distance, but the stage is never in doubt.
    expect(missionProgress({...base, hasRealFix: false, missionStatus: 'LIVE'}).leg).toBe('dropoff');
    expect(missionProgress({...base, hasRealFix: false, missionStatus: 'PICKUP'}).leg).toBe('pickup');
  });
});
