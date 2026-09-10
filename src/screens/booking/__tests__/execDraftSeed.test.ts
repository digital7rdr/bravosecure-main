/**
 * Executive Protection — draft seeding semantics (Screen 1).
 *
 * The executive wizard shares bookingStore.draft with the Lite wizard, so the seam
 * has two hazards this suite pins:
 *   1. entering executive must give a CLEAN executive draft (a stale Lite pickup/notes
 *      must not leak into an executive booking) while preserving the operating zone;
 *   2. re-entering executive (back-nav) must NOT wipe in-progress executive selections.
 */
// Stub the API + native/expo chain so importing bookingStore doesn't pull
// in the expo env (same pattern as bookingStore.zoneChange.test.ts).
jest.mock('@services/api', () => ({walletApi: {}, bookingApi: {}}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));

import {useBookingStore} from '@store/bookingStore';
import {EXEC_DURATIONS, isExecDuration} from '../../executive/executiveProduct';

describe('bookingStore.startExecutiveDraft', () => {
  beforeEach(() => {
    useBookingStore.getState().resetDraft();
  });

  it('seeds an executive draft: service/type/first block/no vehicle', () => {
    useBookingStore.getState().startExecutiveDraft();
    const d = useBookingStore.getState().draft;
    expect(d.service).toBe('executive_protection');
    expect(d.type).toBe('timeslot');
    expect(d.duration_hours).toBe(3);
    expect(d.vehicle_count).toBe(0);
  });

  it('preserves the operating zone across the product switch', () => {
    useBookingStore.getState().updateDraft({zone_code: 'BD', zone_label: 'Bangladesh — Dhaka', region: 'BD'});
    useBookingStore.getState().startExecutiveDraft();
    const d = useBookingStore.getState().draft;
    expect(d.zone_code).toBe('BD');
    expect(d.zone_label).toBe('Bangladesh — Dhaka');
    expect(d.region).toBe('BD');
  });

  it('clears user-entered Lite work (pickup, notes) on a cross-product entry', () => {
    const pin = {address: 'DIFC Gate 4, Dubai', latitude: 25.2, longitude: 55.27} as never;
    useBookingStore.getState().updateDraft({pickup: pin, notes: 'meet at lobby'});
    useBookingStore.getState().startExecutiveDraft();
    const d = useBookingStore.getState().draft;
    expect(d.pickup).toBeNull();
    expect(d.notes).toBe('');
  });

  it('is a no-op while an executive draft is already in progress (back-nav safe)', () => {
    useBookingStore.getState().startExecutiveDraft();
    useBookingStore.getState().updateDraft({duration_hours: 9});
    useBookingStore.getState().startExecutiveDraft();
    expect(useBookingStore.getState().draft.duration_hours).toBe(9);
  });
});

describe('EXEC_DURATIONS product contract', () => {
  it('is exactly the fixed 3-hour blocks 3..24', () => {
    expect([...EXEC_DURATIONS]).toEqual([3, 6, 9, 12, 15, 18, 21, 24]);
  });

  it('isExecDuration accepts only those blocks', () => {
    for (const h of EXEC_DURATIONS) {expect(isExecDuration(h)).toBe(true);}
    for (const h of [0, 1, 2, 4, 5, 7, 25, 27, -3]) {expect(isExecDuration(h)).toBe(false);}
  });
});
