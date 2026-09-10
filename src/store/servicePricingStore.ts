/**
 * Founder 2026-08-26 — fetches the ops-editable service-pricing board
 * (GET /bookings/service-pricing) and hydrates the pure mirror overrides.
 * Same posture as planCatalogStore: single-flight, fail-open, and screens
 * that render prices subscribe to `overrides` so a hydration re-renders the
 * quote with the live numbers.
 */
import {create} from 'zustand';
import {bookingApi} from '@services/api';
import {
  setServicePricingOverrides, type ServicePricingOverrides,
} from '@screens/booking/servicePricingOverrides';

interface ServicePricingState {
  overrides: ServicePricingOverrides;
  loaded: boolean;
  load: () => Promise<void>;
}

let inFlight: Promise<void> | null = null;

export const useServicePricingStore = create<ServicePricingState>((set) => ({
  overrides: {},
  loaded: false,
  load: async () => {
    if (inFlight) {return inFlight;}
    inFlight = (async () => {
      try {
        const {data} = await bookingApi.servicePricing();
        const overrides: Record<string, number> = {};
        for (const [k, v] of Object.entries(data.pricing ?? {})) {
          if (typeof v === 'number' && Number.isFinite(v) && v > 0) {overrides[k] = v;}
        }
        setServicePricingOverrides(overrides);
        set({overrides, loaded: true});
      } catch {
        // Offline / old server — compiled numbers stand; next focus retries.
        set({loaded: true});
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));
