/**
 * Render pins for the emergency directory's pinned country card.
 *
 * The pure ladder is covered by `emergencyCountryResolution`; what CANNOT be
 * pinned there is what the user actually SEES, and when. Two properties matter:
 *
 *  1. **Nothing dialable before the signals land.** Resolving on the first
 *     render pins the LOCALE — the defect this screen exists to fix — and shows
 *     it with live chips. An Indian-locale phone in the US would offer Police
 *     100 for the width of an AsyncStorage read, on a screen opened under
 *     stress, in an app with measured multi-second JS stalls.
 *  2. **An inferred country is never dressed as a fact.** B-638: a guess hidden
 *     behind a dialable number is worse than no country at all.
 */
import React from 'react';
import {render, screen, waitFor} from '@testing-library/react-native';

const mockOpenURL = jest.fn(() => Promise.resolve(true));
let mockLocaleIso: string | null = 'GB';
let mockRadio: {network: string | null; sim: string | null} = {network: null, sim: null};
let mockCached: {iso: string | null; name: string | null; at: number | null} =
  {iso: null, name: null, at: null};
let mockFix: {lat: number; lng: number} | null = null;
const mockGeocode = jest.fn();
let mockToken: string | null = 'tok';
let mockParams: {countryIso?: string; countryName?: string} | undefined;

jest.mock('@utils/constants', () => ({API_BASE_URL: 'https://example.invalid'}));
jest.mock('../deviceCountry', () => ({getDeviceCountryIso: () => mockLocaleIso}));
jest.mock('../networkCountry', () => ({getRadioCountry: () => Promise.resolve(mockRadio)}));
jest.mock('../lastKnownCountry', () => ({
  getLastKnownCountry: () => Promise.resolve(mockCached),
  setLastKnownCountry: jest.fn(() => Promise.resolve()),
}));
jest.mock('../silentLocationFix', () => ({getSilentFix: () => Promise.resolve(mockFix)}));
jest.mock('@services/tokenVault', () => ({tokenVault: {getAccess: () => Promise.resolve(mockToken)}}));
jest.mock('@services/api', () => ({vbgApi: {geocode: (...a: unknown[]) => mockGeocode(...a)}}));
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0}),
}));
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({navigate: jest.fn(), goBack: jest.fn(), canGoBack: () => true}),
  useRoute: () => ({name: 'EmergencyServices', params: mockParams}),
}));

import {Linking} from 'react-native';
jest.spyOn(Linking, 'openURL').mockImplementation(mockOpenURL as never);

import VBGEmergencyScreen from '../VBGEmergencyScreen';
import {emergencyForName} from '../emergencyNumbers';

beforeEach(() => {
  jest.clearAllMocks();
  mockLocaleIso = 'GB';
  mockRadio = {network: null, sim: null};
  mockCached = {iso: null, name: null, at: null};
  mockFix = null;
  mockToken = 'tok';
  mockParams = undefined;
  mockGeocode.mockResolvedValue({data: {country: null, context: '', region: ''}});
});

describe('the pinned country card', () => {
  it('shows NO country card on first paint, even though the locale names one', () => {
    // Synchronous first render only — the offline reads have not resolved.
    render(<VBGEmergencyScreen />);
    expect(screen.queryByText('United Kingdom')).toBeNull();
    expect(screen.queryByText('Your Location')).toBeNull();
    expect(screen.queryByText('Best Guess')).toBeNull();
  });

  it('pins the MOBILE NETWORK country over the locale once signals land', async () => {
    mockRadio = {network: 'AE', sim: 'AE'};   // standing in Dubai
    mockLocaleIso = 'GB';                     // on an en_GB phone
    render(<VBGEmergencyScreen />);

    expect(await screen.findByText('United Arab Emirates')).toBeTruthy();
    expect(screen.getByText('Your Location')).toBeTruthy();
    expect(screen.getByText('Your mobile network')).toBeTruthy();
    // The wrong answer must be absent from the pinned slot entirely.
    expect(screen.queryByText('Estimated from phone settings — confirm before dialling')).toBeNull();
  });

  it('hedges a locale-only country as a GUESS, never as "Your Location"', async () => {
    mockRadio = {network: null, sim: null};   // no SIM, no service
    mockLocaleIso = 'GB';
    render(<VBGEmergencyScreen />);

    expect(await screen.findByText('Best Guess')).toBeTruthy();
    expect(screen.getByText('Estimated from phone settings — confirm before dialling')).toBeTruthy();
    expect(screen.queryByText('Your Location')).toBeNull();
  });

  it('upgrades to the GPS country when the geocode lands, name-only included', async () => {
    mockRadio = {network: null, sim: null};
    mockLocaleIso = 'GB';
    mockFix = {lat: 25.2, lng: 55.27};
    // The response shape that used to be thrown away: no ISO, usable context.
    mockGeocode.mockResolvedValue({
      data: {country: null, context: 'Deira, Dubai, United Arab Emirates', region: 'Deira'},
    });
    render(<VBGEmergencyScreen />);

    expect(await screen.findByText('United Arab Emirates')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('Your location')).toBeTruthy());
  });

  it('makes NO network call when there is no session', async () => {
    mockToken = null;
    mockFix = {lat: 25.2, lng: 55.27};
    mockRadio = {network: 'AE', sim: 'AE'};
    render(<VBGEmergencyScreen />);

    expect(await screen.findByText('United Arab Emirates')).toBeTruthy();
    await waitFor(() => expect(mockGeocode).not.toHaveBeenCalled());
  });

  it('still pins a country when the geocode fails — the directory is offline-first', async () => {
    mockRadio = {network: 'AE', sim: 'AE'};
    mockFix = {lat: 25.2, lng: 55.27};
    mockGeocode.mockRejectedValue(new Error('offline'));
    render(<VBGEmergencyScreen />);

    expect(await screen.findByText('United Arab Emirates')).toBeTruthy();
    expect(screen.getByText('Your mobile network')).toBeTruthy();
  });

  /**
   * VBG Home passes `countryName` from the geocode context on EVERY open, and
   * that context can carry a spelling the directory cannot match. Gating on the
   * param being PRESENT rather than RESOLVED let such a param skip the
   * ready-gate, miss its own rung, and land on the locale — the first-paint hole
   * again, through the one door that always passes params.
   */
  it('an UNRESOLVABLE param does not buy its way past the ready-gate', () => {
    // Self-verifying: if this name ever becomes resolvable (someone adds an
    // alias), the guard fails loudly instead of the test quietly going vacuous
    // — which is exactly what happened when 'Deutschland' was used here and an
    // alias for it landed in the same change.
    const UNRESOLVABLE = 'Republiek van Nêrgens';
    expect(emergencyForName(UNRESOLVABLE)).toBeNull();

    mockParams = {countryName: UNRESOLVABLE};
    mockLocaleIso = 'GB';
    render(<VBGEmergencyScreen />);
    expect(screen.queryByText('United Kingdom')).toBeNull();
    expect(screen.queryByText('Best Guess')).toBeNull();
  });

  it('a RESOLVABLE param pins immediately, with no wait for signals', () => {
    mockParams = {countryIso: 'AE'};
    render(<VBGEmergencyScreen />);
    // Synchronous first render — the caller already geocoded, so nothing to wait for.
    expect(screen.getByText('United Arab Emirates')).toBeTruthy();
    expect(screen.getByText('Your Location')).toBeTruthy();
  });

  it('always offers the universal number, whatever the country resolution does', () => {
    render(<VBGEmergencyScreen />);
    expect(screen.getByText('Universal Emergency')).toBeTruthy();
    // 112 appears in the intro copy and on the button; both are the point.
    expect(screen.getAllByText('112').length).toBeGreaterThan(0);
  });
});
