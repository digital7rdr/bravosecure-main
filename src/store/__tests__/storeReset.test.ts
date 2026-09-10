// Stub the API layer so importing the stores doesn't pull in the
// expo/native env chain. reset() never touches the API, so empty stubs
// are enough.
jest.mock('@services/api', () => ({
  walletApi: {},
  bookingApi: {},
}));

// bookingStore imports @store/authStore (for the server-driven auto-dispatch flag) and,
// transitively, @utils/constants — both pull native/expo ESM that Jest can't transform.
// reset() never reads either, so stub them.
jest.mock('@utils/constants', () => ({AUTO_DISPATCH: false}));
jest.mock('@store/authStore', () => ({useAuthStore: {getState: () => ({user: null})}}));

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {useWalletStore} from '@store/walletStore';
import {useBookingStore} from '@store/bookingStore';
import {useSecureProStore} from '@store/secureProStore';

// signOut() calls these reset() actions so the next account to sign in on
// the same device never sees the previous user's wallet/bookings. The
// stores are memory-only (no persist middleware), so a process-alive
// logout would otherwise retain them.
describe('store reset on sign-out', () => {
  it('walletStore.reset() restores the empty default state', () => {
    useWalletStore.setState({
      balance: {credits: 999, currency: 'AED'} as never,
      creditBatches: [{id: 'b1'} as never],
      transactions: [{id: 't1'} as never],
      vaultUsedMb: 321,
      vaultTotalMb: 5000,
      error: 'stale error',
    });

    useWalletStore.getState().reset();

    const s = useWalletStore.getState();
    expect(s.balance).toBeNull();
    expect(s.creditBatches).toEqual([]);
    expect(s.transactions).toEqual([]);
    expect(s.vaultUsedMb).toBe(0);
    expect(s.vaultTotalMb).toBe(100);
    expect(s.isLoading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('bookingStore.reset() clears bookings/convoy and restores a fresh draft', () => {
    useBookingStore.setState({
      bookings: [{id: 'bk1'} as never],
      activeBooking: {id: 'bk1'} as never,
      liveConvoy: {id: 'cv1'} as never,
      availableAddOns: [{code: 'x'} as never],
      error: 'stale error',
    });
    useBookingStore.getState().updateDraft({passengers: 9, notes: 'leftover'});

    useBookingStore.getState().reset();

    const s = useBookingStore.getState();
    expect(s.bookings).toEqual([]);
    expect(s.activeBooking).toBeNull();
    expect(s.liveConvoy).toBeNull();
    expect(s.availableAddOns).toEqual([]);
    expect(s.error).toBeNull();
    // Draft is back to the module default (a fresh deep clone, not the
    // mutated object), so the next user starts the wizard from scratch.
    expect(s.draft.passengers).toBe(2);
    expect(s.draft.notes).toBe('');
  });

  it('secureProStore.reset() clears the tier application + hasLoaded', () => {
    useSecureProStore.setState({
      application: {status: 'ACTIVE'} as never,
      history: [{id: 'h1'} as never],
      hasLoaded: true,
      error: 'stale',
    });
    useSecureProStore.getState().reset();
    const s = useSecureProStore.getState();
    expect(s.application).toBeNull();
    expect(s.hasLoaded).toBe(false); // the tier resolver must re-wait, not decide on stale
    expect(s.history).toEqual([]);
    expect(s.error).toBeNull();
  });

  // PDF-1 #1 — signOut MUST reset secureProStore, or the tier-routed Secure
  // landing (SecureLandingScreen) decides on the previous user's stale ACTIVE
  // application and auto-routes the next account into their Pro dashboard.
  // Source-scan (signOut has too many native deps to invoke here): the reset is
  // wired alongside the other memory-store resets.
  it('signOut wires the secureProStore reset (not just wallet/booking/product)', () => {
    const src = readFileSync(join(process.cwd(), 'src', 'store', 'authStore.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .filter(l => !/^\s*\/\//.test(l))
      .join('\n');
    expect(src).toMatch(/useSecureProStore.*\}\s*=\s*require\(\s*['"]@store\/secureProStore['"]/);
    expect(src).toMatch(/useSecureProStore\.getState\(\)\.reset\(\)/);
  });
});
