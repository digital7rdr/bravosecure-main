/**
 * The emergency directory's GPS lane must be SILENT: it may read a fix that is
 * already permitted, but it must never raise a permission dialog. A modal
 * standing between a user in trouble and the number they came to dial is the
 * failure mode this file guards.
 */
import {PermissionsAndroid, Platform} from 'react-native';
import Geolocation from 'react-native-geolocation-service';
import {getSilentFix} from '../silentLocationFix';

jest.mock('react-native-geolocation-service', () => ({
  __esModule: true,
  default: {getCurrentPosition: jest.fn(), requestAuthorization: jest.fn()},
}));

const geo = Geolocation as unknown as {
  getCurrentPosition: jest.Mock;
  requestAuthorization: jest.Mock;
};

const FIX = {coords: {latitude: 25.2, longitude: 55.27}};

beforeEach(() => {
  jest.clearAllMocks();
  Platform.OS = 'android';
  geo.getCurrentPosition.mockImplementation((ok: (p: unknown) => void) => ok(FIX));
});

// `restoreMocks` is not set project-wide, so spies would otherwise leak between
// cases and make the suite order-dependent.
afterEach(() => { jest.restoreAllMocks(); });

describe('getSilentFix', () => {
  it('NEVER requests a permission — only checks one', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    const request = jest.spyOn(PermissionsAndroid, 'request');
    await getSilentFix();
    expect(request).not.toHaveBeenCalled();
  });

  it('never calls the iOS authorization prompt either', async () => {
    Platform.OS = 'ios';
    await getSilentFix();
    expect(geo.requestAuthorization).not.toHaveBeenCalled();
  });

  it('returns a fix when FINE location is already granted', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockImplementation(
      async p => p === PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
    );
    await expect(getSilentFix()).resolves.toEqual({lat: 25.2, lng: 55.27});
  });

  /**
   * Android 12+ "Approximate location" leaves FINE denied. Naming a COUNTRY
   * needs nothing better, so checking FINE alone would discard a usable fix
   * from every user who picked that option.
   */
  it('accepts COARSE-only ("Approximate location") — enough to name a country', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockImplementation(
      async p => p === PermissionsAndroid.PERMISSIONS.ACCESS_COARSE_LOCATION,
    );
    await expect(getSilentFix()).resolves.toEqual({lat: 25.2, lng: 55.27});
  });

  it('returns null — without reading a fix — when location is denied outright', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(false);
    await expect(getSilentFix()).resolves.toBeNull();
    expect(geo.getCurrentPosition).not.toHaveBeenCalled();
  });

  it('returns null when the fix errors (no signal, indoors, timeout)', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    geo.getCurrentPosition.mockImplementation((_ok: unknown, fail: () => void) => fail());
    await expect(getSilentFix()).resolves.toBeNull();
  });

  it('never throws into the emergency screen when the check itself blows up', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockRejectedValue(new Error('boom'));
    await expect(getSilentFix()).resolves.toBeNull();
  });

  it('accepts a cached fix — a country does not need the GNSS chip woken', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    await getSilentFix();
    const opts = geo.getCurrentPosition.mock.calls[0][2];
    expect(opts.enableHighAccuracy).toBe(false);
    expect(opts.maximumAge).toBeGreaterThan(0);
  });

  /**
   * THE SYSTEM-MODAL PIN.
   *
   * `showLocationDialog` DEFAULTS TO TRUE in the library
   * (`LocationOptions.java`: `!map.hasKey(k) || map.getBoolean(k)`). Omitting it
   * sends a granted-permission device whose Location master toggle is OFF down
   * `FusedLocationProvider`'s RESOLUTION_REQUIRED branch → `startResolutionForResult`
   * → the Google Play "turn on device location" modal, ON TOP OF the emergency
   * directory. The permission check cannot prevent it — it fires on the GRANTED
   * path. Passing it explicitly is the whole defence, so it is pinned explicitly.
   */
  it('disables the Google Play location-settings modal EXPLICITLY', async () => {
    jest.spyOn(PermissionsAndroid, 'check').mockResolvedValue(true);
    await getSilentFix();
    const opts = geo.getCurrentPosition.mock.calls[0][2];
    expect(opts).toHaveProperty('showLocationDialog');
    expect(opts.showLocationDialog).toBe(false);
  });
});
