import {create} from 'zustand';
import {immer} from 'zustand/middleware/immer';
import {bookingApi, type BookingCreateBody} from '@services/api';
import {useWalletStore} from '@store/walletStore';
import {useAuthStore} from '@store/authStore';
import type {Booking, BookingAddOn, Location, LiveConvoy} from '@appTypes/index';
import {
  isInsufficientCreditsError,
  creditShortfallFrom,
  humanCreditMessage,
} from '@screens/booking/creditErrors';

export type ServiceKey =
  | 'secure_transfer'
  | 'executive_protection'
  | 'recon_team'
  | 'emergency_extraction';

export type BookingMode = 'now' | 'later';

interface BookingDraft {
  type: Booking['type'];
  pickup: Location | null;
  dropoff: Location | null;
  start_time: string;
  duration_hours: number;
  selected_add_ons: string[];
  payment_method: Booking['payment_method'];
  region: string;
  notes: string;
  /** Issue 28 — optional partner / preferred-provider code (attribution only). */
  referral_code: string;
  estimated_price: number | null;
  // ─── Lite booking wizard state (HTML flow) ──────────────────────
  zone_code: string;                 // e.g. 'AE', 'SA'
  zone_label: string;                // e.g. 'UAE — Dubai, Abu Dhabi, Sharjah'
  service: ServiceKey;               // current service choice
  mode: BookingMode;                 // now vs later
  passengers: number;                // excl. CPO + driver
  cpo_count: number;                 // team counter
  vehicle_count: number;             // team counter
  driver_only: boolean;              // client provides vehicle
  addon_switches: Record<string, boolean>; // {female_cpo:true, recon:true,...}
  // Step 22 — explicit, opt-in consent to share live location with the assigned
  // agency + accept the dispatch terms. Required by the server on the auto path
  // (lawful basis); the review screen gates the "Find an agency" CTA on it.
  location_consent: boolean;
  // ─── Executive Protection (service 'executive_protection') ──────────────────────────────────────────
  /** What the protection detail is for (site_protection / event_security / …). */
  task_type: string;
  /** Optional secure-transfer leg. 'none' = protection only, no vehicle moves. */
  transport_mode: 'none' | 'one_way' | 'return' | 'both_ways';
  transport_pickup: Location | null;
  transport_dropoff: Location | null;
  /** ISO time of the transfer pickup; '' = same as the booking start time. */
  transport_pickup_time: string;
}

interface BookingState {
  bookings: Booking[];
  activeBooking: Booking | null;
  liveConvoy: LiveConvoy | null;
  draft: BookingDraft;
  availableAddOns: BookingAddOn[];
  isLoading: boolean;
  error: string | null;
}

interface BookingActions {
  loadBookings: () => Promise<void>;
  // LB-ST4 / LB-API2 — resolves to whether the fetch succeeded so pollers can drive
  // backoff + a "reconnecting" state (it clears `error` on success and never throws).
  loadActiveBooking: (id: string) => Promise<boolean>;
  updateDraft: (updates: Partial<BookingDraft>) => void;
  resetDraft: () => void;
  /** Executive Protection — begin a fresh executive draft (idempotent while one is in progress). */
  startExecutiveDraft: () => void;
  estimatePrice: () => Promise<void>;
  confirmBooking: () => Promise<Booking>;
  cancelBooking: (id: string) => Promise<void>;
  loadAddOns: (region: string) => Promise<void>;
  setLiveConvoy: (convoy: LiveConvoy | null) => void;
  clearError: () => void;
  /** Wipe bookings/convoy/draft back to the empty default — called on sign-out. */
  reset: () => void;
}

const defaultDraft: BookingDraft = {
  type: 'timeslot',
  pickup: null,
  dropoff: null,
  start_time: '',
  duration_hours: 4,
  selected_add_ons: [],
  payment_method: 'card',
  region: 'AE',
  notes: '',
  referral_code: '',
  estimated_price: null,
  zone_code: 'AE',
  zone_label: 'UAE — Dubai, Abu Dhabi, Sharjah',
  service: 'secure_transfer',
  mode: 'now',
  passengers: 2,
  cpo_count: 1,
  vehicle_count: 1,
  driver_only: false,
  addon_switches: {},
  location_consent: false,
  task_type: 'site_protection',
  transport_mode: 'none',
  transport_pickup: null,
  transport_dropoff: null,
  transport_pickup_time: '',
};

// Step 22 — consent versions stamped on the booking so a future ToS/DPA revision
// can detect who consented under which text. Bump when the consent copy changes.
const LOCATION_CONSENT_VERSION = '2026-06-22';
const TERMS_VERSION = '2026-06-22';

export const useBookingStore = create<BookingState & BookingActions>()(
  immer((set, get) => ({
    bookings: [],
    activeBooking: null,
    liveConvoy: null,
    draft: {...defaultDraft},
    availableAddOns: [],
    isLoading: false,
    error: null,

    loadBookings: async () => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await bookingApi.list();
        // Audit fix 3.2 — null-guard `data.bookings`. Some error paths
        // and older API replies return `{}` or `{bookings: null}`; the
        // previous code crashed at the next `.find()` / `.unshift()`.
        // Default to [] so callers always get an iterable.
        set(s => {s.bookings = Array.isArray(data?.bookings) ? data.bookings : [];});
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load bookings';});
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    loadActiveBooking: async (id: string) => {
      set(s => {s.isLoading = true;});
      try {
        const {data} = await bookingApi.getById(id);
        // Clear a prior transient error on success so a "reconnecting" UI can drop.
        set(s => {s.activeBooking = data; s.error = null;});
        return true;
      } catch (e: unknown) {
        set(s => {s.error = e instanceof Error ? e.message : 'Failed to load booking';});
        return false;
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    updateDraft: (updates: Partial<BookingDraft>) =>
      set(s => {
        // Why: a pickup/dropoff belongs to a specific operating zone. If the zone
        // changes, a stale pickup from the old country would pin the LocationPicker
        // to that country (it centres on the existing pickup) and mis-scope the
        // address search — making a Dhaka pickup unselectable after an AE draft.
        // Clear both so the next pick re-centres on the newly-chosen zone.
        if (updates.zone_code && updates.zone_code !== s.draft.zone_code) {
          s.draft.pickup = null;
          s.draft.dropoff = null;
        }
        Object.assign(s.draft, updates);
      }),

    resetDraft: () =>
      // Audit fix 3.2 — deep-clone defaultDraft. The shallow `{...defaultDraft}`
      // copied the reference to `addon_switches` (a nested object), which
      // meant any mutation in the wizard ended up modifying the module-level
      // `defaultDraft` constant for the rest of the app's lifetime. Use
      // structuredClone for a one-call deep copy; safe in RN 0.72+.
      set(s => {s.draft = structuredClone(defaultDraft);}),

    startExecutiveDraft: () =>
      set(s => {
        // Re-entering the executive entry screen (back-nav mid-wizard) must not wipe
        // in-progress selections — only a cross-product entry resets.
        if (s.draft.service === 'executive_protection') {return;}
        // Why: a stale Lite pickup/dropoff/notes must not leak into an executive
        // booking; the operating zone survives because the home region chip
        // owns it (same rule as confirmBooking's post-submit clear).
        const {zone_code, zone_label, region} = s.draft;
        s.draft = {
          ...structuredClone(defaultDraft),
          zone_code, zone_label, region,
          service: 'executive_protection',
          type: 'timeslot',
          // executive defaults: first fixed block; vehicles exist only when the
          // optional secure-transfer leg is added later in the wizard.
          duration_hours: 3,
          vehicle_count: 0,
        };
      }),

    estimatePrice: async () => {
      const {draft} = get();
      if (!draft.pickup) {return;}
      try {
        const {data} = await bookingApi.estimatePrice({
          type: draft.type,
          // 'executive_protection' selects the per-unit fixed-block formula server-side; the
          // Lite formula would misquote an executive draft by up to ±37%.
          service: draft.service,
          duration_hours: draft.duration_hours,
          add_ons: draft.selected_add_ons,
          region: draft.region,
          // Pass the full team context so the estimate reflects extra CPOs /
          // vehicles, the driver-only discount, and the peak-hour surcharge —
          // these all change the price server-side (pricing.service.ts) but
          // were previously dropped, so the estimate ignored them.
          cpo_count: draft.cpo_count,
          vehicle_count: draft.vehicle_count,
          driver_only: draft.driver_only,
          // Without passengers the server's seat-cap / capacity mirrors default
          // to 1 and can never fire, so "estimate mirrors create" was nominal.
          passengers: draft.passengers,
          pickup_time: draft.start_time || undefined,
        });
        set(s => {s.draft.estimated_price = data.total; s.error = null;});
      } catch (e: unknown) {
        // Audit fix 3.2 — surface estimate failures so the UI can warn
        // the user that the price might be stale. Was silently swallowed.
        const ax = e as {response?: {data?: {message?: string | string[]}}; message?: string};
        const apiMsg = ax?.response?.data?.message;
        const friendly = Array.isArray(apiMsg) ? apiMsg.join(' · ')
          : apiMsg
          ?? (e instanceof Error ? e.message : 'Estimate unavailable');
        set(s => {s.error = friendly;});
      }
    },

    confirmBooking: async () => {
      const {draft} = get();
      if (!draft.pickup) {throw new Error('Pickup location required');}
      const body: BookingCreateBody = {
        type: draft.type,
        pickup: draft.pickup,
        dropoff: draft.dropoff ?? undefined,
        start_time: draft.start_time,
        duration_hours: draft.duration_hours,
        add_ons: draft.selected_add_ons,
        payment_method: draft.payment_method,
        region: draft.region,
        region_label: draft.zone_label,
        service: draft.service,
        booking_mode: draft.mode,
        passengers: draft.passengers,
        cpo_count: draft.cpo_count,
        vehicle_count: draft.vehicle_count,
        driver_only: draft.driver_only,
        notes: draft.notes,
        referral_code: draft.referral_code.trim() || undefined,
      };
      // Executive Protection — task + optional secure-transfer leg ride the same payload.
      if (draft.service === 'executive_protection') {
        body.task_type = draft.task_type;
        if (draft.transport_mode !== 'none' && draft.transport_pickup && draft.transport_dropoff) {
          body.exec_transport = {
            mode: draft.transport_mode,
            pickup: draft.transport_pickup,
            dropoff: draft.transport_dropoff,
            pickup_time: draft.transport_pickup_time || undefined,
            passengers: draft.passengers,
          };
        }
      }
      // Bug 1: server-driven auto-dispatch flag (replaces the build-time AUTO_DISPATCH constant).
      // Read from the auth store; fail-closed to legacy when /auth/me hasn't confirmed it.
      const autoDispatch = useAuthStore.getState().user?.auto_dispatch_enabled === true;
      // Step 22 — lawful-basis consent. Only the auto path shares precise location
      // with a third-party agency, so the server requires it there; we stamp the
      // versioned consent the user gave on the review screen. (Legacy path omits it.)
      if (autoDispatch) {
        if (draft.location_consent !== true) {
          const err: Error & {code?: string} = new Error('consent_required');
          err.code = 'consent_required';
          throw err;
        }
        body.location_consent = true;
        body.terms_accepted = true;
        body.location_consent_version = LOCATION_CONSENT_VERSION;
        body.terms_accepted_version = TERMS_VERSION;
      }
      // Step 19 — auto-dispatch (DARK behind AUTO_DISPATCH). The affordability check is
      // ADVISORY: escrow only charges when an agency accepts, so a short balance is routed
      // to the paywall pre-dispatch rather than blocking. Skipped when the balance isn't
      // loaded (never block on unknown state — accept-time is the authoritative guard). The
      // typed error is thrown BEFORE the try so the screen can route it to CreditPaywall.
      if (autoDispatch) {
        const bal = useWalletStore.getState().balance;
        const estimate = draft.estimated_price ?? 0;
        if (bal && estimate > 0 && bal.bravo_credits < estimate) {
          const err: Error & {code?: string; amountDue?: number} = new Error('insufficient_credits');
          err.code = 'insufficient_credits';
          err.amountDue = Math.ceil(estimate - bal.bravo_credits);
          throw err;
        }
      }
      set(s => {s.isLoading = true; s.error = null;});
      try {
        // Auto: create + start the matchmaker server-side (→ DISPATCHING / NO_PROVIDER).
        // Legacy: create → PENDING_OPS. Auto needs a per-attempt idempotency key so a
        // network-blip retry can't create two bookings (the server one-active guard backstops).
        const {data} = autoDispatch
          ? await bookingApi.requestAuto(body, `auto-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e7).toString(36)}`)
          : await bookingApi.create(body);
        // Audit fix 3.2 — dedup by id. A retry path or an out-of-order
        // loadBookings() can race confirmBooking and leave two rows for
        // the same booking in the list; check before unshift.
        set(s => {
          if (!s.bookings.some(b => b.id === data.booking.id)) {
            s.bookings.unshift(data.booking);
          }
          // B-91 M3 R5 — the wizard's work is now server-side; clear the
          // draft so it stops reading as "unsaved booking" forever (drafts
          // previously lingered until sign-out). Zone survives: the home
          // region chip renders draft.zone_code.
          const {zone_code, zone_label, region} = s.draft;
          s.draft = {...structuredClone(defaultDraft), zone_code, zone_label, region};
        });
        return data.booking;
      } catch (e: unknown) {
        // Axios's default `error.message` is the unhelpful "Request failed
        // with status code 400" — the real reason from NestJS lives at
        // `error.response.data.message` (string or string[] depending on
        // whether the validation pipe or a manual throw produced it).
        // Surface that so the user sees "You already have an active
        // booking…" instead of a status code.
        const ax = e as {
          response?: {data?: {code?: string; message?: string | string[]; booking_id?: string}};
          message?: string;
        };
        const errBody = ax?.response?.data;
        const apiMsg = errBody?.message;
        const raw = Array.isArray(apiMsg) ? apiMsg.join(' · ')
          : apiMsg
          ?? (e instanceof Error ? e.message : 'Booking failed');
        // Issue 25 — `error` is rendered verbatim (BookingHistoryScreen,
        // AddOnsScreen), so a raw server CODE must never land in it.
        const friendly = humanCreditMessage(raw) ?? raw;
        set(s => {s.error = friendly;});
        // Issue 25 — this used to `throw new Error(friendly)`, which discarded
        // the structured body. Every caller branch that keyed off the server's
        // `code` (insufficient_credits, active_booking_exists) was therefore
        // dead, and the raw code fell through to a "Booking failed" alert.
        // Carry the fields callers actually branch on. Detection runs against
        // the ORIGINAL error, which still has the response body.
        const out: Error & {code?: string; amountDue?: number; bookingId?: string} = new Error(friendly);
        if (isInsufficientCreditsError(e)) {
          out.code = 'insufficient_credits';
          const short = creditShortfallFrom(e);
          if (short !== undefined) {out.amountDue = short;}
        } else if (errBody?.code) {
          out.code = errBody.code;
        }
        if (errBody?.booking_id) {out.bookingId = errBody.booking_id;}
        throw out;
      } finally {
        set(s => {s.isLoading = false;});
      }
    },

    cancelBooking: async (id: string) => {
      await bookingApi.cancel(id);
      set(s => {
        const booking = s.bookings.find(b => b.id === id);
        if (booking) {booking.status = 'CANCELLED';}
      });
    },

    loadAddOns: async (region: string) => {
      const {data} = await bookingApi.getAddOns(region);
      set(s => {s.availableAddOns = data;});
    },

    setLiveConvoy: (convoy: LiveConvoy | null) =>
      set(s => {s.liveConvoy = convoy;}),

    // Legacy `loadJobRequests` / `acceptJob` / `declineJob` removed.
    // They hit /agent/jobs* endpoints that the auth-service never
    // exposed. The live job-feed flow lives on `JobMarketplaceScreen`
    // calling `agentApi.getAvailableJobs` and `applyToJob` / `withdrawApplication`.

    clearError: () => set(s => {s.error = null;}),

    reset: () => set(s => {
      s.bookings = [];
      s.activeBooking = null;
      s.liveConvoy = null;
      s.draft = structuredClone(defaultDraft);
      s.availableAddOns = [];
      s.isLoading = false;
      s.error = null;
    }),
  })),
);

/**
 * B-91 M3 R5 — does the booking WIZARD hold user-entered work that a product
 * switch would silently discard? Keyed on genuinely user-entered fields (the
 * zone/service defaults the home screen itself writes don't count). An
 * IN-FLIGHT booking is deliberately NOT "dirty": the server owns it and the
 * dashboard restores it on return.
 */
export function isBookingDraftDirty(): boolean {
  const d = useBookingStore.getState().draft;
  return (
    d.pickup !== null ||
    d.dropoff !== null ||
    d.start_time !== '' ||
    d.selected_add_ons.length > 0 ||
    d.notes !== '' ||
    d.referral_code !== ''
  );
}
