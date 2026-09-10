// Stub the API + native/expo chain so importing bookingStore doesn't pull
// in the expo env. updateDraft never touches the API.
jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {},
}));
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));

import {useBookingStore} from '@store/bookingStore';

// Regression: switching the booking zone must clear any pickup/dropoff carried
// over from the previous zone. Otherwise the LocationPicker centres on the stale
// pickup's country (e.g. Dubai) and scopes address search to it, so a pickup in
// the newly-chosen country (e.g. Dhaka/BD) can't be found.
describe('bookingStore.updateDraft — zone change clears stale location', () => {
  beforeEach(() => {
    useBookingStore.getState().resetDraft();
  });

  it('clears pickup + dropoff when zone_code changes', () => {
    const pin = {address: 'DIFC Gate Building 4, Dubai', lat: 25.2, lng: 55.27} as never;
    useBookingStore.getState().updateDraft({zone_code: 'AE', pickup: pin, dropoff: pin});
    expect(useBookingStore.getState().draft.pickup).not.toBeNull();

    // Switch the operating zone to Bangladesh.
    useBookingStore.getState().updateDraft({zone_code: 'BD', region: 'BD'});

    const d = useBookingStore.getState().draft;
    expect(d.zone_code).toBe('BD');
    expect(d.pickup).toBeNull();
    expect(d.dropoff).toBeNull();
  });

  it('keeps pickup when the same zone is re-applied (no spurious clear)', () => {
    const pin = {address: 'Gulshan, Dhaka', lat: 23.79, lng: 90.41} as never;
    useBookingStore.getState().updateDraft({zone_code: 'BD', region: 'BD'});
    useBookingStore.getState().updateDraft({pickup: pin});
    // Re-applying the SAME zone (e.g. user revisits the zone screen) must not wipe it.
    useBookingStore.getState().updateDraft({zone_code: 'BD', zone_label: 'Bangladesh — Dhaka Division'});

    expect(useBookingStore.getState().draft.pickup).toEqual(pin);
  });

  it('does not clear pickup for non-zone updates', () => {
    const pin = {address: 'Banani, Dhaka', lat: 23.79, lng: 90.40} as never;
    useBookingStore.getState().updateDraft({zone_code: 'BD', pickup: pin});
    useBookingStore.getState().updateDraft({passengers: 3, notes: 'VIP'});

    expect(useBookingStore.getState().draft.pickup).toEqual(pin);
  });
});
