import {acceptGpsFix, MAX_ACCURACY_M} from '../gpsPlausibility';

const at = (sec: number) => new Date(1752600000000 + sec * 1000).toISOString();

describe('acceptGpsFix — B-89 MG-13 plausibility gate', () => {
  it('accepts the first fix (nothing to compare against)', () => {
    expect(acceptGpsFix(null, {lat: 25.1, lng: 55.2, recordedAt: at(0)})).toBe(true);
  });

  it('rejects null island and out-of-range coords (MG-12)', () => {
    expect(acceptGpsFix(null, {lat: 0, lng: 0})).toBe(false);
    expect(acceptGpsFix(null, {lat: 91, lng: 55})).toBe(false);
    expect(acceptGpsFix(null, {lat: NaN, lng: 55})).toBe(false);
  });

  it('rejects fixes with hopeless reported accuracy', () => {
    expect(acceptGpsFix(null, {lat: 25.1, lng: 55.2, accuracyM: MAX_ACCURACY_M + 1})).toBe(false);
    expect(acceptGpsFix(null, {lat: 25.1, lng: 55.2, accuracyM: 30})).toBe(true);
  });

  it('rejects a teleport (implied speed > 70 m/s)', () => {
    const prev = {lat: 25.1000, lng: 55.2000, recordedAt: at(0)};
    // ~11 km in 10 s ≈ 1100 m/s.
    expect(acceptGpsFix(prev, {lat: 25.2000, lng: 55.2000, recordedAt: at(10)})).toBe(false);
  });

  it('accepts normal vehicle motion', () => {
    const prev = {lat: 25.1000, lng: 55.2000, recordedAt: at(0)};
    // ~550 m in 30 s ≈ 18 m/s.
    expect(acceptGpsFix(prev, {lat: 25.1050, lng: 55.2000, recordedAt: at(30)})).toBe(true);
  });

  it('passes when timestamps are absent or non-monotonic (cannot compute speed)', () => {
    const prev = {lat: 25.1, lng: 55.2, recordedAt: at(10)};
    expect(acceptGpsFix(prev, {lat: 26.0, lng: 55.2})).toBe(true);
    expect(acceptGpsFix(prev, {lat: 26.0, lng: 55.2, recordedAt: at(5)})).toBe(true);
  });
});
