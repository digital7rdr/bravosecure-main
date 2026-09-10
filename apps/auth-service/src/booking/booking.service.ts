import {BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, Optional} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService} from '../database/database.service';
import {PricingService, resolveExecAddOns, DEFAULT_SERVICE_PRICING, type AddOnPricing} from './pricing.service';
import {BookingStateMachine, type ActorRole, type BookingStatus} from './state-machine.service';
import {MissionStateMachine, type MissionStatus} from '../ops/mission-state-machine.service';
import type {CreateBookingDto, EstimateBookingDto} from './dto/create-booking.dto';
import {CpoAssignmentService, type AssignedCpo} from './assignment/cpo-assignment.service';
import {VehiclePoolService, type AssignedVehicle} from './assignment/vehicle-pool.service';
import {REGIONS} from '../common/regions';

/**
 * Audit H5 — client-facing CPO shape: `AssignedCpo` minus the internal
 * agent user id. Used by the principal's getTeam so the officer's account
 * UUID never reaches the client.
 */
export type ClientAssignedCpo = Omit<AssignedCpo, 'id'>;
import {deriveVerifyCode} from '../dispatch/verify-code.util';
import {WalletService} from '../wallet/wallet.service';
import {FamilyService} from '../family/family.service';
import {SettlementService} from '../settlement/settlement.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {CreateDisputeDto} from './dto/dispute.dto';

// FSM defense-in-depth — client-cancel aborts the booking's live mission(s). The
// WHERE pins the from-states (DISPATCHED/PICKUP); asserting both keeps the FSM the
// single source of truth. SYSTEM actor: the server aborts on the client's behalf.
const missionFsm = new MissionStateMachine();
const MIN_LEAD_HOURS = 3;
// Team-sizing limits (mirrored client-side in src/screens/booking/pricing.ts).
// MAX_CPOS = hard ceiling per booking; a 5-seat vehicle holds 1 driver + 4
// occupants, so in driver-only mode passengers + CPOs must fit those 4 seats.
const MAX_CPOS = 4;
const SEATS_PER_VEHICLE_EX_DRIVER = 4;
/** E-12 — persist bound for geocoder address strings (truncate, never reject). */
const ADDRESS_MAX = 500;

// Executive Protection — fixed 3-hour blocks and the task-type vocabulary (mirrored
// client-side in src/screens/executive/executiveProduct.ts).
const EXEC_TASK_TYPES = [
  'site_protection', 'event_security', 'close_protection',
  'residential_watch', 'asset_protection', 'other',
] as const;
const EXEC_TRANSPORT_MODES = ['one_way', 'return', 'both_ways'] as const;

/** Persisted exec_transport JSONB shape (validated below, never trusted raw). */
interface ExecTransportPersisted {
  mode: 'one_way' | 'return' | 'both_ways';
  pickup: {address: string; latitude: number; longitude: number};
  dropoff: {address: string; latitude: number; longitude: number};
  pickup_time: string | null;
  passengers: number;
}

/**
 * Audit fix #15 — single source of truth for supported regions on the
 * auth-service side. Mobile owns its own `REGION_SEED` (with city-level
 * zone geometry) in `src/screens/booking/ZoneMapScreen.tsx` and reads
 * availability counts from `/bookings/regions/availability`; this list
 * is what that endpoint enumerates. Add a new region here AND in the
 * mobile seed when expanding coverage.
 */
export const SUPPORTED_REGIONS: ReadonlyArray<{code: string; name: string; launched: boolean}> =
  REGIONS.map(r => ({code: r.code, name: r.name, launched: r.launched}));

interface LiteBookingRow {
  id: string;
  client_id: string;
  status: BookingStatus;
  conversation_id: string | null;
  region_code: string;
  region_label: string;
  service: string;
  booking_mode: 'now' | 'later';
  pickup_time: Date;
  pickup_address: string;
  pickup_lat: string | null;
  pickup_lng: string | null;
  dropoff_address: string | null;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  rate_eur_per_hour: string;
  rate_aed_per_hour: string;
  duration_hours: number;
  total_eur: string;
  total_aed: string;
  payment_method: string;
  payment_captured: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  // Family shared credits (20260705100000) — the wallet the booking debits;
  // NULL for pre-stamp legacy rows (payer == client there).
  payer_user_id: string | null;
  // Auto-dispatch (Step 2 migration) — NULL for legacy admin-flow bookings.
  dispatch_mode: string | null;
  assigned_provider_user_id: string | null;
  dispatch_started_at: Date | null;
  dispatch_settled_at: Date | null;
  crew_deadline_at: Date | null;
  // Compliance / escrow requirements (Step 3 migration).
  armed_required: boolean;
  requirements: Record<string, unknown>;
  dispute_window_seconds: number | null;
  // Executive Protection (20260804150000) — NULL on non-executive bookings.
  task_type: string | null;
  exec_transport: ExecTransportPersisted | null;
}

interface AddOnRow {
  id: string;
  label: string;
  description: string | null;
  region_code: string;
  price_eur_per_hour: string;
  requires_ops_approval: boolean;
  active: boolean;
}

interface ClientSummary {
  bookings: ClientBooking[];
  total: number;
}

export interface ClientBooking {
  id: string;
  client_id: string;
  status: BookingStatus;
  type: 'transfer' | 'timeslot' | 'itinerary';
  region: string;
  region_label: string;
  service: string;
  pickup: {address: string; latitude: number; longitude: number};
  dropoff: {address: string; latitude: number; longitude: number} | null;
  start_time: string;
  passengers: number;
  cpo_count: number;
  vehicle_count: number;
  driver_only: boolean;
  add_ons: string[];
  estimated_price: number;
  duration_hours: number;
  total_eur: number;
  total_aed: number;
  conversation_id: string | null;
  created_at: string;
  // Executive Protection — what the detail is for + the optional secure-transfer leg;
  // null/omitted on non-executive bookings.
  task_type?: string | null;
  exec_transport?: ExecTransportPersisted | null;
  // Executive Protection — hourly "all smooth" confirmations (getById only, executive only).
  hourly_checkins?: Array<{
    hour_index: number; status: string; comment: string | null; created_at: string;
  }>;
  // Ops-gated auto dispatch — 'auto' when the booking runs the offer cascade
  // (escrow-charged at accept, never payWithCredits); null on legacy bookings.
  // The client uses it to keep an approved auto booking out of the auto-pay flow.
  dispatch_mode?: string | null;
  // C-5 — TripSummary renders these; they were persisted at create but never
  // returned, so "Payment —" showed on every trip and the client's own notes
  // vanished from their receipt.
  payment_method?: string | null;
  notes?: string | null;
  booking_mode?: 'now' | 'later' | null;
  // Step 16 — present ONLY on the NO_PROVIDER terminal path; drives the
  // "no agency available" fallback card (hotline / widen / escalate). Omitted on
  // every other status so the legacy/admin booking shape is byte-for-byte unchanged.
  no_provider_fallback?: {
    hotline_e164: string;
    can_widen: boolean;
    can_escalate: boolean;
  } | null;
  // Surfaces the assigned mission's lifecycle (DISPATCHED/PICKUP/LIVE/COMPLETED/ABORTED) so
  // the client's live-tracking stepper reflects real progress — the booking FSM stays
  // CONFIRMED while the mission advances, so booking.status alone can't tell the story.
  // Present only on getById (the single-booking live view); null when no mission exists yet.
  mission_status?: string | null;
}

/**
 * Issue 41 — what the CLIENT is told about a mission.
 *
 * assignCrew creates the mission directly as DISPATCHED, so the client's journey
 * rail jumped to step 3 "Team dispatched" the instant the PROVIDER accepted —
 * before any officer had agreed to take it. Reporting null until someone has
 * accepted lands the client on step 2, "Accepted · assigning team", which is the
 * truth: the provider accepted and the team is still being confirmed.
 *
 * `missions.status` is deliberately NOT changed — the ops console, the CPO
 * screens and the mission FSM keep reading the real state. Only this
 * client-facing projection waits.
 *
 * PICKUP / LIVE / COMPLETED / SOS pass through untouched: a mission that has
 * physically moved on is self-evidently accepted, and gating those would hide
 * real progress if an accept row were ever missed.
 */
export function clientMissionStatus(
  mission: {status: string; crew_accepted?: boolean} | null | undefined,
): string | null {
  if (!mission) return null;
  if (mission.status !== 'DISPATCHED') return mission.status;
  return mission.crew_accepted ? 'DISPATCHED' : null;
}

@Injectable()
export class BookingService {
  private readonly log = new Logger(BookingService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly pricing: PricingService,
    private readonly fsm: BookingStateMachine,
    private readonly cpoAssign: CpoAssignmentService,
    private readonly vehicles: VehiclePoolService,
    private readonly wallet: WalletService,
    private readonly family: FamilyService,
    private readonly settlement: SettlementService,
    private readonly config: ConfigService,
    // Optional so existing unit specs (which construct BookingService directly)
    // keep working; wake calls are guarded with `?.`.
    @Optional() private readonly bookingPush?: BookingPushBridge,
  ) {}

  /**
   * POST /bookings — creates a DRAFT + immediately submits (→ PENDING_OPS, legacy flow).
   *
   * Step 19 (cut-over, dark behind AUTO_DISPATCH_ENABLED): when `opts.autoDispatch` is set
   * (the client-facing ClientDispatchController passes it), the booking is persisted as an
   * auto booking (`dispatch_mode='auto'`). Ops-gated auto dispatch: the auto booking is ALSO
   * submitted to PENDING_OPS — it lands on the ops board first, and ops approval (not the
   * client request) hands it to the matchmaker (OPS_APPROVED → DISPATCHING). The legacy path
   * (no opts) is byte-for-byte unchanged.
   */
  async create(
    clientId: string, dto: CreateBookingDto, opts?: {autoDispatch?: boolean},
  ): Promise<{booking: ClientBooking}> {
    const auto = opts?.autoDispatch === true;
    // Audit fix 0.8 — Pro tier gate. AI Itinerary booking is the lead
    // Pro feature; Lite clients see it locked client-side in the
    // ProDashboard. We backstop here so a Lite user calling the API
    // directly (or a future client regression) gets a clean 403 instead
    // of a created booking. Tier is read live from `public.users` so a
    // downgrade takes effect on the next call, not after JWT expiry.
    // Other booking types (transfer/timeslot) stay Lite-accessible.
    if (dto.type === 'itinerary') {
      // RS-19 (server) — a lapsed Pro window (pro_active_until in the past) is
      // effectively Lite even before the hourly lapse-sweep flips the column,
      // so gate on the LIVE entitlement, not the raw tier string. A NULL
      // pro_active_until is a permanent/comp grant (RS-17) and stays Pro.
      const tier = await this.db.qOne<{is_pro: boolean}>(
        `SELECT (subscription_tier = 'pro'
                 AND (pro_active_until IS NULL OR pro_active_until > now())) AS is_pro
           FROM public.users
          WHERE id = $1 AND deleted_at IS NULL`,
        [clientId],
      );
      if (!tier || !tier.is_pro) {
        throw new ForbiddenException({
          code: 'tier_insufficient',
          message: 'AI Itinerary booking requires a Pro subscription.',
          required_tier: 'pro',
        });
      }
    }

    // One mission at a time per client — reject if any non-terminal booking
    // already exists. The mobile app's resume gate already routes the user
    // to the in-flight booking; this is the server-side backstop so the gate
    // can't be circumvented by retries or stale clients.
    // LB17 — terminal/failed states free the "one mission at a time" slot. NO_PROVIDER
    // (auto: nobody available) and AGENCY_NO_SHOW (auto: agency never crewed) are terminal,
    // so a client whose search failed can immediately request again (mirrors the mobile
    // RESUMABLE set). Without these here the server would trap a stranded client.
    // B-405 (founder 2026-08-09) — a PARKED FUTURE RESERVATION does not hold the
    // slot: a 'later' booking sitting PENDING_OPS (any mode) or OPS_APPROVED (AUTO
    // only) is a zero-commitment reservation (no escrow, no crew, dispatch starts
    // ~15 min before pickup), so a client with a booking two weeks out must still
    // be able to book go-now. Once the sweeper flips it DISPATCHING it counts
    // again. A LEGACY (non-auto) 'later' row that reaches OPS_APPROVED is NOT
    // parked — it owes payment now (3-agent review: exempting it let the
    // reservation die unpaid at pickup+60 via the drift janitor while the app
    // showed a green APPROVED chip), so it keeps holding the slot.
    const active = await this.db.qOne<{id: string; status: string}>(
      `SELECT id, status FROM lite_bookings
        WHERE client_id = $1
          AND status NOT IN ('COMPLETED','CANCELLED','NO_PROVIDER','AGENCY_NO_SHOW')
          AND NOT (booking_mode = 'later'
                   AND (status = 'PENDING_OPS'
                        OR (status = 'OPS_APPROVED' AND dispatch_mode = 'auto')))
        ORDER BY created_at DESC
        LIMIT 1`,
      [clientId],
    );
    if (active) {
      throw new BadRequestException({
        code: 'active_booking_exists',
        message: 'You already have an active booking. Finish or cancel it before starting another.',
        booking_id: active.id,
        booking_status: active.status,
      });
    }

    // B-405 companion cap — parked reservations are exempt from the slot, so
    // without a ceiling a client could stack unlimited future bookings (each
    // individually passing the advisory affordability check) and have the T-15
    // sweep dispatch them all. 3 parked reservations is the review-agreed cap.
    if ((dto.booking_mode ?? 'now') === 'later') {
      const parked = await this.db.qOne<{n: number}>(
        `SELECT count(*)::int AS n FROM lite_bookings
          WHERE client_id = $1 AND booking_mode = 'later'
            AND (status = 'PENDING_OPS'
                 OR (status = 'OPS_APPROVED' AND dispatch_mode = 'auto'))`,
        [clientId],
      );
      if ((parked?.n ?? 0) >= 3) {
        throw new BadRequestException({
          code: 'too_many_scheduled_bookings',
          message: 'You already have 3 scheduled bookings waiting. Cancel one or let one complete before scheduling another.',
        });
      }
    }

    // Region gate — the booking must carry a region we actually dispatch in, or it is
    // un-rankable: the dispatch ranker hard-matches `agents.region_code = booking.region_code`
    // and the job feed now scopes by region too. Normalize casing + reject early with a clear
    // error instead of silently persisting a request no provider can ever be matched to.
    const regionCode = (dto.region ?? '').trim().toUpperCase();
    if (!SUPPORTED_REGIONS.some(r => r.code === regionCode)) {
      throw new BadRequestException({
        code: 'unsupported_region',
        message: `Region "${dto.region}" is not supported. Supported regions: ${SUPPORTED_REGIONS.map(r => r.code).join(', ')}.`,
      });
    }

    const pickupTime = new Date(dto.start_time);
    if (Number.isNaN(pickupTime.getTime())) {
      throw new BadRequestException('Invalid start_time');
    }
    const now = Date.now();
    // Step 24 — on-demand exemption. An "I need a guard NOW" auto request (the headline
    // feature) is dispatched immediately, so it must skip the 3-hour scheduling lead-time
    // gate; a SCHEDULED ("later") auto request and every legacy booking still honor it.
    // Executive Protection "Book Now" writes start_time = submit-time by design, so it is exempt on
    // BOTH paths — the client fail-closes to the legacy route when auto_dispatch_enabled
    // hasn't been confirmed, and a 400 after a 7-step wizard is not acceptable there.
    const isOnDemandAuto = (auto || dto.service === 'executive_protection') && (dto.booking_mode ?? 'now') === 'now';
    if (!isOnDemandAuto && pickupTime.getTime() < now + MIN_LEAD_HOURS * 3600_000) {
      throw new BadRequestException(
        `Minimum ${MIN_LEAD_HOURS}-hour lead time required. Earliest: ${new Date(now + MIN_LEAD_HOURS * 3600_000).toISOString()}`,
      );
    }

    // Step 22 — lawful-basis consent gate (auto path only). Auto-dispatch shares the
    // client's precise pickup + live location with a third-party agency, so we require
    // an explicit location + terms consent before persisting. The legacy ops-mediated
    // path keeps its existing implicit flow (byte-for-byte unchanged); consent stamps
    // are still recorded below whenever the client supplies them.
    if (auto && (dto.location_consent !== true || dto.terms_accepted !== true)) {
      throw new BadRequestException({
        code: 'consent_required',
        message: 'Location-sharing and terms consent are required to dispatch an agency.',
      });
    }

    // ─── Executive Protection (service 'executive_protection') — fixed-block validation ──────────────
    // Fail BEFORE any pricing so a malformed executive request can never be quoted,
    // let alone escrowed, on the wrong numbers.
    const isExec = dto.service === 'executive_protection';
    let execTransport: ExecTransportPersisted | null = null;
    if (isExec) {
      const dh = dto.duration_hours ?? 0;
      if (dh < 3 || dh > 24 || dh % 3 !== 0) {
        throw new BadRequestException({
          code: 'exec_invalid_duration',
          message: 'Executive Protection is booked in fixed 3-hour blocks between 3 and 24 hours.',
        });
      }
      const taskType = dto.task_type ?? 'site_protection';
      if (!(EXEC_TASK_TYPES as readonly string[]).includes(taskType)) {
        throw new BadRequestException({
          code: 'exec_invalid_task_type',
          message: `task_type must be one of: ${EXEC_TASK_TYPES.join(', ')}.`,
        });
      }
      const t = dto.exec_transport;
      if (t) {
        const legOk = (p?: {latitude?: unknown; longitude?: unknown}) =>
          !!p && typeof p.latitude === 'number' && Number.isFinite(p.latitude)
              && typeof p.longitude === 'number' && Number.isFinite(p.longitude);
        if (!(EXEC_TRANSPORT_MODES as readonly string[]).includes(t.mode) || !legOk(t.pickup) || !legOk(t.dropoff)) {
          throw new BadRequestException({
            code: 'exec_invalid_transport',
            message: 'exec_transport needs mode (one_way/return/both_ways) and pickup + dropoff coordinates.',
          });
        }
        let transferTime: string | null = null;
        if (t.pickup_time) {
          const parsed = new Date(t.pickup_time);
          if (Number.isNaN(parsed.getTime())) {
            throw new BadRequestException({code: 'exec_invalid_transport', message: 'exec_transport.pickup_time is not a valid time.'});
          }
          // Sanity window: the transfer belongs to the protection block —
          // allow up to 2 h before the start (pre-positioning) through the
          // end of the block. A leg dated days away is a stale-client bug.
          const startMs = pickupTime.getTime();
          const endMs = startMs + dh * 3600_000;
          if (parsed.getTime() < startMs - 2 * 3600_000 || parsed.getTime() > endMs) {
            throw new BadRequestException({
              code: 'exec_transport_time_out_of_window',
              message: 'The transfer pickup time must fall within the protection block.',
            });
          }
          transferTime = parsed.toISOString();
        }
        const pax = Math.max(1, Math.min(16, Math.trunc(Number(t.passengers ?? dto.passengers ?? 1)) || 1));
        execTransport = {
          mode: t.mode,
          // E-12 — the nested DTO skips the pipe (manual validation, see class
          // comment), so bound the persisted addresses here.
          pickup:  {address: (t.pickup.address ?? '').slice(0, 500),  latitude: t.pickup.latitude,  longitude: t.pickup.longitude},
          dropoff: {address: (t.dropoff.address ?? '').slice(0, 500), latitude: t.dropoff.latitude, longitude: t.dropoff.longitude},
          pickup_time: transferTime,
          passengers: pax,
        };
      }
    }

    const requestedAddOnIds = [...new Set(dto.add_ons ?? [])];
    const pricingCfg = (await this.pricing.config?.()) ?? DEFAULT_SERVICE_PRICING;
    const addOns = isExec
      ? resolveExecAddOns(dto.add_ons ?? [], pricingCfg)
      : await this.resolveAddOns(dto.region, dto.add_ons ?? []);
    if (addOns === null) {
      throw new BadRequestException({
        code: 'exec_unknown_addon',
        message: 'One or more add-ons are not available for Executive Protection.',
      });
    }
    // B-385 — Lite mirrored exec's posture: an inactive / out-of-region / unknown
    // add-on id used to be dropped SILENTLY while the raw list persisted on the
    // booking — the row then advertised an add-on nobody was charged for and the
    // agency staffed a phantom requirement. Reject, never silently reprice.
    if (!isExec && addOns.length < requestedAddOnIds.length) {
      throw new BadRequestException({
        code: 'unknown_add_on',
        message: 'One or more selected add-ons are not available in this region. Refresh and try again.',
      });
    }

    // Industry norm — "Driver Only (Client Vehicle)": the client supplies the
    // vehicle, so Bravo dispatches a vetted security driver but NO Bravo
    // vehicle. Normalize vehicle_count to 0 here so pricing (no extra-vehicle
    // surcharge), persistence, and ops dispatch (no vehicle to assign) all
    // agree. The 0.65× driver-only discount is applied inside PricingService.
    const driverOnly = dto.driver_only ?? false;
    // Why: `?? 1` only substitutes null/undefined, not a stray 0. With the DTO now
    // admitting vehicle_count=0 (driver-only), clamp non-driver bookings back to a
    // 1-vehicle baseline so a 0 can't create a mispriced/undispatchable booking.
    // executive differs: vehicles exist ONLY with a secure-transfer leg, so 0 is the
    // legitimate floor there (protection-only detail, nothing to drive).
    const vehicleCount = isExec
      ? (driverOnly ? 0 : Math.max(0, Math.min(dto.vehicle_count ?? 0, 4)))
      : (driverOnly ? 0 : Math.max(1, dto.vehicle_count ?? 1));

    // executive: vehicles / a Bravo driver only make sense when a transfer leg
    // exists — reject instead of silently repricing what the client saw.
    if (isExec && !execTransport && (vehicleCount > 0 || driverOnly)) {
      throw new BadRequestException({
        code: 'exec_transport_required',
        message: 'Vehicles and driver-only options require a secure-transfer leg on an Executive Protection booking.',
      });
    }
    // …and the inverse: a transfer leg with nothing to drive it (no vehicle,
    // no Bravo driver) would persist legs the pricing never charged for.
    if (isExec && execTransport && vehicleCount === 0 && !driverOnly) {
      throw new BadRequestException({
        code: 'exec_vehicle_required',
        message: 'A secure-transfer leg needs at least one vehicle, or the driver-only option.',
      });
    }

    // Capacity backstop — in driver-only mode passengers + CPOs share the
    // client's car (1 driver + 4 occupants on a standard 5-seater), so cap CPOs
    // to the free seats. Mirrors maxCposForClientVehicle on the client; a stale
    // or direct API caller can't book a detail that physically can't board.
    const requestedCpos = dto.cpo_count ?? 1;
    const cpoCount = driverOnly
      ? Math.max(1, Math.min(requestedCpos, MAX_CPOS, SEATS_PER_VEHICLE_EX_DRIVER - (dto.passengers ?? 1)))
      : Math.max(1, Math.min(requestedCpos, MAX_CPOS));

    // executive: silently repricing what the client reviewed is banned — if the
    // seat clamp would change the team, reject so the client re-confirms.
    if (isExec && cpoCount !== requestedCpos) {
      throw new BadRequestException({
        code: 'exec_cpo_seat_cap',
        message: `With ${dto.passengers ?? 1} passenger(s) in a client vehicle, at most ${cpoCount} CPO(s) fit. Adjust the team and try again.`,
      });
    }

    // E-14 — capacity floor (API-only reachable; the wizard derives vehicles from
    // passengers at 3/vehicle). Without it a 12-pax / 1-vehicle booking is accepted,
    // underpriced, and physically unboardable on the ground.
    if (!isExec && !driverOnly && vehicleCount * 3 < (dto.passengers ?? 1)) {
      throw new BadRequestException({
        code: 'vehicle_capacity_insufficient',
        message: 'Not enough vehicles for the passenger count. Add vehicles and try again.',
      });
    }

    const price = this.pricing.calculate({
      cpoCount,
      vehicleCount,
      driverOnly,
      durationHours: dto.duration_hours ?? 4,
      pickupTime,
      addOns,
      regionCode,   // LM-M2 — local peak-hour window
      service: dto.service,   // 'executive_protection' → per-unit fixed-block formula
    }, pricingCfg);

    // LM-B7 — resolve the PAYER once at request time (family holder, or the client
    // themselves) and soft-check affordability BEFORE any agency is ever offered the
    // job. Two effects: (a) a short balance routes the client to the paywall now,
    // instead of surfacing `insufficient_credits` to the AGENCY at accept-time
    // (leaking the client's financial state); (b) a family member's booking charges
    // the holder's wallet at accept (holdToEscrow debits payer_user_id).
    let payerUserId: string | null = null;
    if (auto) {
      const payer = await this.family.resolvePayer(clientId);
      payerUserId = payer.payerId;
      // eur_per_bc root: the BC hold is the converted total, not raw EUR.
      const cost = price.total_bc;
      // Spec §21 — a suspended ROOT account freezes every member draw on it, no
      // matter how much quota the member still has. Checked before the cap so
      // the member is told the real reason rather than a limit message.
      if (payer.familyRowId && payer.holderSuspended) {
        throw new BadRequestException({code: 'ROOT_ACCOUNT_SUSPENDED', message: 'root_account_suspended'});
      }
      if (payer.familyRowId && payer.spendLimit !== null && payer.spent + cost > payer.spendLimit) {
        // Same additive shape as `insufficient_credits` above: `message` keeps
        // the raw code already-shipped clients match on, `code` is the spec's
        // §8 name, and the figures let the UI render the limit screen and its
        // "Request More Credit" action without a second round trip.
        throw new BadRequestException({
          code: 'SPENDING_QUOTA_EXCEEDED',
          message: 'family_spend_limit_exceeded',
          required: cost,
          allocated: payer.spendLimit,
          used: payer.spent,
          remaining: Math.max(0, payer.spendLimit - payer.spent),
        });
      }
      const bal = await this.db.qOne<{bravo_credits: number}>(
        `SELECT bravo_credits FROM wallet_balances WHERE user_id = $1`,
        [payerUserId],
      );
      const have = Number(bal?.bravo_credits ?? 0);
      if (cost > 0 && have < cost) {
        // Same shape as payWithCredits — the client routes to the top-up paywall.
        // Issue 25 — `message` stays the raw code so already-shipped clients that
        // match on it keep working; `code`/`required`/`balance` are additive and
        // let a current client show the exact shortfall.
        throw new BadRequestException({
          code: 'insufficient_credits',
          message: 'insufficient_credits',
          required: cost,
          balance: have,
        });
      }
    }

    // State transition: both paths persist (no state) → DRAFT → PENDING_OPS directly (the
    // client only ever submits a committed draft). Ops-gated auto dispatch: the auto
    // booking goes to the ops board too — ops approval later triggers the offer cascade.
    this.fsm.assert('DRAFT', 'PENDING_OPS', 'CLIENT');

    // Issue 28 — resolve the referral code BEFORE the insert so an unknown or
    // expired one is rejected up front rather than silently recorded. Blank is
    // fine; the field is optional. Deliberately NOT passed to the matchmaker:
    // the PDF requires that a code never bypass availability, licensing or
    // operator approval, so this is attribution only.
    const referral = await this.resolveReferralCode(dto.referral_code);

    const inserted = await this.db.qOne<LiteBookingRow>(
      // $25 = status, $26 = dispatch_mode appended at the end so the legacy $1–$24 bindings
      // stay byte-for-byte; legacy => ('PENDING_OPS', NULL), auto => ('PENDING_OPS', 'auto').
      `INSERT INTO lite_bookings (
        client_id, status, dispatch_mode, region_code, region_label, service,
        booking_mode, pickup_time, pickup_address, pickup_lat, pickup_lng,
        dropoff_address, dropoff_lat, dropoff_lng,
        passengers, cpo_count, vehicle_count, driver_only, add_ons,
        rate_eur_per_hour, rate_aed_per_hour, duration_hours, total_eur, total_aed,
        payment_method, notes,
        location_consent_at, location_consent_version, terms_accepted_at, terms_accepted_version,
        payer_user_id, pricing_breakdown,
        referral_code, referral_code_id,
        task_type, exec_transport
      ) VALUES (
        $1, $25, $26, $2, $3, $4,
        $5, $6, $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15, $16, $17::jsonb,
        $18, $19, $20, $21, $22,
        $23, $24,
        $27, $28, $29, $30,
        $31, $32::jsonb,
        $33, $34,
        $35, $36::jsonb
      ) RETURNING *`,
      [
        clientId,
        regionCode,
        dto.region_label ?? regionCode,
        dto.service ?? 'secure_transfer',
        dto.booking_mode ?? 'now',
        pickupTime,
        // E-12 — truncate (never reject) third-party geocoder strings.
        (dto.pickup.address ?? '').slice(0, ADDRESS_MAX),
        dto.pickup.latitude,
        dto.pickup.longitude,
        dto.dropoff?.address ? dto.dropoff.address.slice(0, ADDRESS_MAX) : null,
        dto.dropoff?.latitude ?? null,
        dto.dropoff?.longitude ?? null,
        dto.passengers ?? 1,
        cpoCount,
        vehicleCount,
        driverOnly,
        // B-385 — persist the RESOLVED set (what was actually priced+charged),
        // never the raw request list.
        JSON.stringify(addOns.map(a => a.id)),
        price.rate_eur_per_hour,
        price.rate_aed_per_hour,
        dto.duration_hours ?? 4,
        price.total_eur,
        price.total_aed,
        dto.payment_method,
        dto.notes ?? null,
        'PENDING_OPS',                   // $25 status — auto submits to the ops board too
        auto ? 'auto' : null,            // $26 dispatch_mode
        // Step 22 — consent stamps. Recorded when the client supplies them (always
        // on the auto path, where the gate above made them mandatory). $27–$30.
        dto.location_consent === true ? new Date() : null,
        dto.location_consent === true ? (dto.location_consent_version ?? null) : null,
        dto.terms_accepted === true ? new Date() : null,
        dto.terms_accepted === true ? (dto.terms_accepted_version ?? null) : null,
        payerUserId,                     // $31 LM-B7 — resolved payer (auto only)
        // $32 F1 — persist the itemised quote; the invoice must reflect the
        // lines the client saw, not a recomputation.
        JSON.stringify(price.breakdown ?? []),
        // $33/$34 Issue 28 — the code as submitted (denormalised so reporting
        // survives the code row being deactivated) plus the FK for ops joins.
        referral?.code ?? null,
        referral?.id ?? null,
        // $35/$36 Executive Protection — task + optional secure-transfer leg.
        isExec ? (dto.task_type ?? 'site_protection') : null,
        execTransport ? JSON.stringify(execTransport) : null,
      ],
    );

    if (!inserted) throw new BadRequestException('Failed to create booking');
    if (referral) {
      // Why AFTER the insert: a bump at validation time counted redemptions for
      // bookings whose INSERT then failed, skewing partner reporting. Still
      // best-effort — a failure here must never fail the booking.
      this.db
        .q(`UPDATE provider_referral_codes SET redeemed_count = redeemed_count + 1 WHERE id = $1`, [referral.id])
        .catch((e: unknown) => this.log.warn(`referral counter bump failed: ${(e as Error).message}`));
    }
    await this.audit(inserted.id, null, 'DRAFT', clientId, 'CLIENT', {reason: 'draft_created'});
    if (auto) {
      // Ops-gated auto dispatch: the auto booking waits on the ops board; approval
      // (OpsService.approveBooking) hands it to the matchmaker, not the client request.
      await this.audit(inserted.id, 'DRAFT', 'PENDING_OPS', clientId, 'CLIENT', {reason: 'submitted_for_ops'});
      this.log.log(`Booking ${inserted.id} PENDING_OPS(auto) for client ${clientId} — awaiting ops approval`);
    } else {
      await this.audit(inserted.id, 'DRAFT', 'PENDING_OPS', clientId, 'CLIENT', {reason: 'submitted'});
      this.log.log(`Booking ${inserted.id} PENDING_OPS for client ${clientId}`);
    }

    return {booking: this.toClientBooking(inserted)};
  }

  /**
   * Pay an OPS_APPROVED booking with Bravo Credits. Transitions the booking
   * OPS_APPROVED → PAYMENT_PENDING → CONFIRMED, debits the wallet, and
   * triggers CPO + vehicle assignment from the pool. Throws 400 with
   * `insufficient_credits` when the wallet is short — the client should then
   * route the user to the top-up paywall and retry.
   */
  async payWithCredits(clientId: string, bookingId: string): Promise<{booking: ClientBooking}> {
    // Run booking-status + wallet-debit + booking-flip atomically.
    //
    // Why a single transaction:
    //   - Two-device race: previously both clients could pass the status
    //     check (first flips OPS_APPROVED→PAYMENT_PENDING; second sees
    //     PAYMENT_PENDING and the old code's OR-branch let it through),
    //     then both call debit, draining the wallet twice for one booking.
    //   - Without `SELECT FOR UPDATE` on both rows, two concurrent calls
    //     each see balance ≥ cost, each insert a negative tx row, and
    //     `applyCreditDelta` decrements twice — net wallet drain of 2×.
    //
    // The transaction holds row locks on lite_bookings + wallet_balances
    // for its entire body. The second concurrent caller blocks on the
    // first's COMMIT/ROLLBACK, then runs the same checks against the
    // already-updated state and gets `Cannot pay booking in state
    // CONFIRMED` deterministically — never debits.
    //
    // Hoisted so the post-commit quota-threshold warning (spec §33/§34) can see
    // which membership row was actually charged. Set inside the txn, read only
    // after it commits — on a rollback it stays null and nothing is announced,
    // which is the point: a warning for a charge that never happened would be a
    // lie the holder acts on.
    let chargedFamilyRowId: string | null = null;
    const updated = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<LiteBookingRow>(
        `SELECT * FROM lite_bookings WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [bookingId, clientId],
      );
      if (!row) throw new NotFoundException('Booking not found');
      // Why: ops-gated auto dispatch parks auto bookings in OPS_APPROVED between the ops
      // approve and the matchmaker start. They are escrow-charged at offer-accept; letting
      // the legacy pay path run here would double-charge AND derail the offer cascade.
      if (row.dispatch_mode === 'auto') {
        throw new BadRequestException('auto_booking_pays_at_accept');
      }
      if (row.status !== 'OPS_APPROVED' && row.status !== 'PAYMENT_PENDING') {
        throw new BadRequestException(`Cannot pay booking in state ${row.status}`);
      }

      // B-405 later-payment — stored totals are EUR; convert at the LIVE
      // root rate at charge time (identical at the shipped 1.0).
      const payCfg = (await this.pricing.config?.()) ?? DEFAULT_SERVICE_PRICING;
      const cost = Math.round(Number(row.total_eur) / payCfg.eur_per_bc);
      if (cost <= 0) throw new BadRequestException('Booking has no chargeable total');

      if (row.status === 'OPS_APPROVED') {
        this.fsm.assert('OPS_APPROVED', 'PAYMENT_PENDING', 'CLIENT');
        await tx.q(`UPDATE lite_bookings SET status = 'PAYMENT_PENDING' WHERE id = $1`, [bookingId]);
      }

      // Family shared credits — if this client is an active family member,
      // the booking is charged to the HOLDER's wallet (resolvePayer returns
      // the holder; for everyone else it returns the client themselves, so
      // non-members are unaffected). The cap, if set, bounds a member's draw.
      const payer = await this.family.resolvePayer(clientId);
      const payerId = payer.payerId;
      // Spec §21 — a suspended ROOT account stops all member spending on it.
      // First, because it outranks both the quota and the balance.
      if (payer.familyRowId && payer.holderSuspended) {
        throw new BadRequestException({code: 'ROOT_ACCOUNT_SUSPENDED', message: 'root_account_suspended'});
      }
      // Cheap early-out: resolvePayer's read is unlocked (it also serves pre-flight
      // soft checks), so a clearly-over-cap member fails fast without taking a lock.
      // NOT the authoritative gate — the locked re-read below is (MON-4).
      if (payer.familyRowId && payer.spendLimit !== null && payer.spent + cost > payer.spendLimit) {
        throw new BadRequestException({
          code: 'SPENDING_QUOTA_EXCEEDED',
          message: 'family_spend_limit_exceeded',
          required: cost,
          allocated: payer.spendLimit,
          used: payer.spent,
          remaining: Math.max(0, payer.spendLimit - payer.spent),
        });
      }
      // MON-4 — authoritative cap gate: re-read the member row FOR UPDATE inside THIS
      // txn (resolvePayer read it unlocked, off a separate connection). Locking here
      // serializes concurrent charges for the same member — the second blocks until the
      // first commits its spent_credits bump, then reads the fresh total. Taken BEFORE
      // the wallet lock below to keep a single family→wallet lock order across paths.
      if (payer.familyRowId) {
        const locked = await tx.qOne<{spent_credits: number; spend_limit_credits: number | null}>(
          `SELECT spent_credits, spend_limit_credits FROM public.family_members
            WHERE id = $1 FOR UPDATE`,
          [payer.familyRowId],
        );
        const spent = Number(locked?.spent_credits ?? 0);
        const limit = locked?.spend_limit_credits;
        if (limit !== null && limit !== undefined && spent + cost > Number(limit)) {
          throw new BadRequestException({
            code: 'SPENDING_QUOTA_EXCEEDED',
            message: 'family_spend_limit_exceeded',
            required: cost,
            allocated: Number(limit),
            used: spent,
            remaining: Math.max(0, Number(limit) - spent),
          });
        }
      }

      // Lock the PAYER's wallet balance row before reading/debiting.
      const balance = await tx.qOne<{bravo_credits: number; currency: string}>(
        `SELECT bravo_credits, currency FROM wallet_balances WHERE user_id = $1 FOR UPDATE`,
        [payerId],
      );
      if (!balance) {
        // No balance row yet — auto-init at 0 inside the txn, then
        // fall through to the insufficient_credits branch below.
        await tx.q(
          `INSERT INTO wallet_balances (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
          [payerId],
        );
      }
      const have = Number(balance?.bravo_credits ?? 0);
      if (have < cost) {
        // Issue 25 — see the twin throw in requestAuto: `message` keeps the raw
        // code for already-shipped clients, the rest is additive.
        throw new BadRequestException({
          code: 'insufficient_credits',
          message: 'insufficient_credits',
          required: cost,
          balance: have,
        });
      }

      // Insert the debit ledger row + decrement balance, both locked. The
      // ledger records the actual payer; the description notes a family
      // charge so the holder can see why their balance moved.
      const desc = payer.familyRowId ? `Booking ${bookingId} (family member)` : `Booking ${bookingId}`;
      // family_row_id pins the cap bookkeeping to the CHARGE-TIME membership
      // row, so a much later refund reverses that row — not whatever active
      // row exists then (revoke → re-invite would otherwise eat fresh spend).
      const payMeta = JSON.stringify(payer.familyRowId ? {family_row_id: payer.familyRowId} : {});
      await tx.q(
        `INSERT INTO wallet_transactions (
           user_id, type, status, amount_credits, amount_fiat_cents, fiat_currency,
           description, booking_id, metadata, settled_at, actor_user_id, feature
         ) VALUES ($1, 'payment', 'succeeded', $2, 0, $3, $4, $5, $6::jsonb, NOW(), $7, 'booking')`,
        [payerId, -cost, balance?.currency ?? 'AED', desc, bookingId, payMeta, clientId],
      );
      await tx.q(
        `UPDATE wallet_balances SET bravo_credits = bravo_credits - $1 WHERE user_id = $2`,
        [cost, payerId],
      );
      // Bump the member's running family spend for the cap (best-effort —
      // outside-balance bookkeeping, the debit above is the source of truth).
      if (payer.familyRowId) {
        await tx.q(
          `UPDATE public.family_members SET spent_credits = spent_credits + $2 WHERE id = $1`,
          [payer.familyRowId, cost],
        );
        chargedFamilyRowId = payer.familyRowId;
      }

      this.fsm.assert('PAYMENT_PENDING', 'CONFIRMED', 'SYSTEM');
      // Stamp the actual payer so ops/holder views can show "under <owner>"
      // on family-charged bookings (the auto path stamps it at insert; this
      // legacy path previously left it NULL).
      // B-386 — confirmed_at anchors the legacy cancel window (the window text
      // says "of confirmation"; anchoring to created_at locked scheduled
      // bookings out before they were even payable).
      const upd = await tx.qOne<LiteBookingRow>(
        `UPDATE lite_bookings
            SET status = 'CONFIRMED', payment_captured = TRUE, payer_user_id = $2,
                confirmed_at = COALESCE(confirmed_at, NOW())
          WHERE id = $1 RETURNING *`,
        [bookingId, payerId],
      );
      if (!upd) throw new NotFoundException('Booking not found after payment');
      return upd;
    });

    // Audit rows outside the txn — best-effort; their failure shouldn't
    // unwind the wallet debit.
    await this.audit(bookingId, 'OPS_APPROVED', 'PAYMENT_PENDING', clientId, 'CLIENT', {reason: 'payment_initiated'}).catch(() => undefined);
    await this.audit(bookingId, 'PAYMENT_PENDING', 'CONFIRMED', clientId, 'SYSTEM', {reason: 'payment_captured'}).catch(() => undefined);

    // Spec §33/§34 — warn the holder if this charge pushed the member across
    // 80/90/100% of their quota. Crossing-based inside, so ten small bookings
    // inside one band produce one warning, not ten.
    //
    // try/catch rather than `.catch()`: the payment is already COMMITTED at this
    // point, so nothing here may propagate — and a `.catch()` cannot catch a
    // synchronous throw, which is precisely what an older FamilyService without
    // this method would produce.
    try {
      await this.family.notifyUsageThreshold(chargedFamilyRowId);
    } catch { /* a warning may never undo a captured payment */ }

    return {booking: this.toClientBooking(updated)};
  }

  /**
   * Read the assigned team for a booking. Powers the BookingConfirmation
   * and LiveTracking crew panels. Ownership-checked against the caller.
   *
   * Audit H5 — privacy: the internal agent USER UUID (`AssignedCpo.id`) is
   * stripped from the CLIENT-facing payload. A principal never needs the
   * agent's account id, and exposing it enabled cross-mission correlation /
   * enumeration of a specific officer. The human-facing fields the product
   * intends to surface (call sign, display name, armed/female, specialties)
   * are retained — `call_sign` is the public identifier the UI keys on. The
   * full `AssignedCpo` (with id) is still returned to OPS via its own path
   * (cpoAssign.getForBooking), which is operator-trusted.
   */
  async getTeam(clientId: string, bookingId: string): Promise<{
    cpos: ClientAssignedCpo[];
    vehicle: AssignedVehicle | null;
  }> {
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [bookingId, clientId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    // Auto-dispatch crew lives in mission_crew; legacy admin-assigned crew lives in
    // booking_cpo_assignments. Prefer the mission crew (real officers) so an auto-dispatched
    // booking's client team card shows the assigned guards instead of "assigning" forever.
    const [missionCrew, vehicle] = await Promise.all([
      this.cpoAssign.getMissionCrewForBooking(bookingId),
      this.vehicles.getForBooking(bookingId),
    ]);
    const cpos = missionCrew.length > 0
      ? missionCrew
      : await this.cpoAssign.getForBooking(bookingId);
    // Drop the internal agent id; keep the public detail card fields.
    const redacted: ClientAssignedCpo[] = cpos.map(({id: _id, ...rest}) => rest);
    return {cpos: redacted, vehicle};
  }

  async estimate(dto: EstimateBookingDto): Promise<{
    total: number; breakdown: Record<string, number>;
    rate_per_hour: number; duration_hours: number; total_aed: number;
  }> {
    // Executive Protection estimates use the fixed executive catalogue + per-unit formula so
    // the preview equals what create() will charge, to the credit.
    const isExec = dto.service === 'executive_protection';
    if (isExec) {
      // Mirror create()'s block rule — an estimate for a duration create()
      // would reject is a quote for a booking that can never exist.
      const dh = dto.duration_hours ?? 0;
      if (dh < 3 || dh > 24 || dh % 3 !== 0) {
        throw new BadRequestException({
          code: 'exec_invalid_duration',
          message: 'Executive Protection is booked in fixed 3-hour blocks between 3 and 24 hours.',
        });
      }
    }
    const pricingCfg = (await this.pricing.config?.()) ?? DEFAULT_SERVICE_PRICING;
    const addOns = isExec
      ? resolveExecAddOns(dto.add_ons ?? [], pricingCfg)
      : await this.resolveAddOns(dto.region, dto.add_ons ?? []);
    if (addOns === null) {
      throw new BadRequestException({
        code: 'exec_unknown_addon',
        message: 'One or more add-ons are not available for Executive Protection.',
      });
    }
    // B-385 parity — estimate must not quote a Lite add-on set create() will reject.
    if (!isExec && addOns.length < [...new Set(dto.add_ons ?? [])].length) {
      throw new BadRequestException({
        code: 'unknown_add_on',
        message: 'One or more selected add-ons are not available in this region. Refresh and try again.',
      });
    }
    const pickupTime = dto.pickup_time ? new Date(dto.pickup_time) : new Date();
    // Mirror create()'s clamps AND its reject rules so the preview can never
    // quote a team create() would price differently or refuse (E-9).
    const estDriverOnly = dto.driver_only ?? false;
    const estRequestedCpos = dto.cpo_count ?? 1;
    const estCpos = estDriverOnly
      ? Math.max(1, Math.min(estRequestedCpos, MAX_CPOS, SEATS_PER_VEHICLE_EX_DRIVER - (dto.passengers ?? 1)))
      : Math.max(1, Math.min(estRequestedCpos, MAX_CPOS));
    // executive: create() REJECTS when the seat clamp would change the team
    // (reject-never-reprice) — the estimate previously clamped and quoted the
    // smaller team, i.e. a price for a booking that can never exist.
    if (isExec && estCpos !== estRequestedCpos) {
      throw new BadRequestException({
        code: 'exec_cpo_seat_cap',
        message: `With ${dto.passengers ?? 1} passenger(s) in a client vehicle, at most ${estCpos} CPO(s) fit. Adjust the team and try again.`,
      });
    }
    // executive: 0 vehicles is the legitimate default (protection-only detail);
    // cap at 4 exactly like create() so preview == charge. Lite mirrors
    // create()'s min-1 (driver-only zeroes vehicles in PricingService itself).
    const estVehicles = isExec
      ? Math.max(0, Math.min(dto.vehicle_count ?? 0, 4))
      : (estDriverOnly ? 0 : Math.max(1, dto.vehicle_count ?? 1));
    // E-14 parity — don't quote a passenger/vehicle combination create() rejects.
    if (!isExec && !estDriverOnly && estVehicles * 3 < (dto.passengers ?? 1)) {
      throw new BadRequestException({
        code: 'vehicle_capacity_insufficient',
        message: 'Not enough vehicles for the passenger count. Add vehicles and try again.',
      });
    }
    const price = this.pricing.calculate({
      // Lite previously passed the RAW count while create() clamps — a
      // driver-only quote could exceed the eventual charge (E-9c).
      cpoCount: estCpos,
      vehicleCount: estVehicles,
      driverOnly: estDriverOnly,
      durationHours: dto.duration_hours ?? 4,
      pickupTime,
      addOns,
      regionCode: (dto.region ?? '').trim().toUpperCase(),   // LM-M2
      service: dto.service,
    }, pricingCfg);
    const breakdown: Record<string, number> = {};
    for (const b of price.breakdown) breakdown[b.label] = b.amount_eur;
    // LM-M1 — the wizard needs the authoritative TOTAL (and rate) up front so the
    // paywall/affordability numbers match what escrow will actually charge.
    return {
      total: price.total_eur, breakdown,
      rate_per_hour: price.rate_eur_per_hour,
      duration_hours: Math.max(1, dto.duration_hours ?? 4),
      total_aed: price.total_aed,
    };
  }

  async list(clientId: string, opts?: {status?: string; page?: number}): Promise<ClientSummary> {
    // C-6 — the mobile client has always advertised {status, page}; the server
    // ignored both (hardcoded first-50). Honor them, additively: no params =
    // byte-identical behavior. Status is allow-listed (never interpolate input).
    // These are exactly the labels of the lite_booking_status enum. Pinned by
    // enumParamCast.spec.ts: 'LIVE' was missing (so ?status=LIVE silently
    // dropped the filter and returned EVERY booking instead of the live one),
    // and 'REJECTED' is not a lite_booking_status at all — it belongs to
    // dispatch_offers/agents, and could never match a row.
    const VALID_STATUS = new Set([
      'DRAFT', 'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING',
      'CONFIRMED', 'LIVE', 'COMPLETED', 'CANCELLED', 'NO_PROVIDER', 'AGENCY_NO_SHOW',
    ]);
    const status = opts?.status && VALID_STATUS.has(opts.status) ? opts.status : null;
    // B-388b — a page number needs an UPPER bound, not just a floor. The
    // controller admits any /^\d+$/ string, and `page * 50` is bound straight to
    // a bigint OFFSET, so two 500s were one query param away for any signed-in
    // client (both reproduced against the live database):
    //   ?page=1000000000000000000  -> OFFSET 50000000000000000000
    //                                 22003 value out of range for type bigint
    //   ?page=20000000000000000000 -> node-postgres binds a JS number with
    //                                 toString(), which switches to exponent
    //                                 form at 1e21, so Postgres receives the
    //                                 literal text "5e+21"
    //                                 22P02 invalid input syntax for type bigint
    // Same family as the cast bug below: an untrusted value reaching Postgres's
    // type layer, invisible to this suite because DatabaseService is mocked.
    // 10k pages is 500k rows deep — unreachable for a real client, and no client
    // sends `page` at all today.
    const page = Math.min(10_000, Math.max(0, Math.floor(opts?.page ?? 0)));
    const rows = await this.db.q<LiteBookingRow>(
      // `status` is the ENUM lite_booking_status, and `$2::text` PINS this
      // parameter's type to text for the whole statement — so the bare
      // `status = $2` below it became `lite_booking_status = text`, an operator
      // Postgres does not have. Every call threw, so the client's bookings list
      // 500'd for everyone, with or without a status filter (the cast is
      // evaluated regardless of which side of the OR wins).
      //
      // Cast the COLUMN, not the parameter: `$2::lite_booking_status` would
      // instead raise "invalid input value for enum" on any unexpected string,
      // turning a filter typo into a 500 as well. `status::text` compares like
      // with like and matches the idiom already used at
      // dispatch.service.ts:588 (`b.status::text = $1`).
      `SELECT * FROM lite_bookings
        WHERE client_id = $1 AND ($2::text IS NULL OR status::text = $2)
        ORDER BY created_at DESC LIMIT 50 OFFSET $3`,
      [clientId, status, page * 50],
    );
    const bookings = rows.map(r => this.toClientBooking(r));
    // LB-ST1 — surface the live mission phase on the LIST too, not only getById.
    // The booking FSM stays CONFIRMED for the whole mission, so without this the
    // client dashboard shows a frozen "CONFIRMED" the entire detail and the Home
    // resume/deep-link router can't send the user to the live tracker. One batched
    // query (newest non-ABORTED mission per booking) keeps it O(1), no N+1.
    if (bookings.length > 0) {
      const ids = bookings.map(b => b.id);
      const missions = await this.db.q<{booking_id: string; status: string; crew_accepted: boolean}>(
        `SELECT DISTINCT ON (m.booking_id) m.booking_id, m.status,
                EXISTS (SELECT 1 FROM mission_crew mc
                         WHERE mc.mission_id = m.id AND mc.accepted_at IS NOT NULL) AS crew_accepted
           FROM missions m
          WHERE m.booking_id = ANY($1)
          ORDER BY m.booking_id, (m.status <> 'ABORTED') DESC, m.created_at DESC`,
        [ids],
      );
      const byBooking = new Map(missions.map(m => [m.booking_id, clientMissionStatus(m)]));
      for (const b of bookings) {b.mission_status = byBooking.get(b.id) ?? null;}
    }
    return {
      bookings,
      total: rows.length,
    };
  }

  async getById(clientId: string, id: string): Promise<ClientBooking> {
    const row = await this.db.qOne<LiteBookingRow>(
      `SELECT * FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    const booking = this.toClientBooking(row);
    // Surface the mission lifecycle so the client's live-tracking reflects DISPATCHED →
    // en route → protection active → completed. The booking FSM intentionally stays
    // CONFIRMED while the mission advances; the newest mission wins (a re-dispatch creates
    // a fresh one and supersedes any ABORTED predecessor).
    const mission = await this.db.qOne<{status: string; crew_accepted: boolean}>(
      `SELECT m.status,
              EXISTS (SELECT 1 FROM mission_crew mc
                       WHERE mc.mission_id = m.id AND mc.accepted_at IS NOT NULL) AS crew_accepted
         FROM missions m WHERE m.booking_id = $1
        ORDER BY (m.status <> 'ABORTED') DESC, m.created_at DESC LIMIT 1`,
      [id],
    );
    booking.mission_status = clientMissionStatus(mission);
    // Executive Protection — the client's hour-by-hour timeline ("Hour N confirmed —
    // all smooth"). executive missions have no waypoints; this is their progress.
    // Scoped to the SAME mission the surfaced mission_status came from — a
    // re-crewed booking keeps an ABORTED history mission whose hours must
    // not mix into (or duplicate) the live mission's timeline.
    if (row.service === 'executive_protection') {
      const checkins = await this.db.q<{hour_index: number; status: string; comment: string | null; created_at: Date}>(
        `SELECT hour_index, status, comment, created_at
           FROM mission_hourly_checkins
          WHERE mission_id = (
            SELECT m.id FROM missions m WHERE m.booking_id = $1
             ORDER BY (m.status <> 'ABORTED') DESC, m.created_at DESC LIMIT 1
          )
          ORDER BY hour_index`,
        [id],
      );
      booking.hourly_checkins = checkins.map(c => ({
        hour_index: c.hour_index, status: c.status, comment: c.comment,
        created_at: c.created_at?.toISOString?.() ?? String(c.created_at),
      }));
    }
    return booking;
  }

  /**
   * Step 24 — client rates the agency that ran a COMPLETED booking, then recompute the
   * agency's rolling average (which the Step-6 dispatch ranking consumes). Owner-scoped,
   * COMPLETED-only, and idempotent: the `AND rating IS NULL` guard makes a re-submit a
   * no-op (one rating per booking), so it's safe under the IdempotencyInterceptor + retries.
   */
  /**
   * Issue 28 — validate a preferred-provider / partner / referral code.
   *
   * Returns null for a blank code (the field is optional) and THROWS for a code
   * that is unknown, inactive or expired, so a typo is reported at submit time
   * rather than silently attributed to nobody.
   *
   * Deliberately returns attribution only. The caller must not pass any part of
   * this into dispatch: the PDF requires that a code never bypass availability,
   * licensing or operator approval.
   */
  private async resolveReferralCode(
    raw: string | undefined,
  ): Promise<{id: string; code: string} | null> {
    const code = (raw ?? '').trim().toUpperCase();
    if (!code) return null;
    const row = await this.db.qOne<{id: string; code: string}>(
      `SELECT id, code FROM provider_referral_codes
        WHERE code = $1 AND active = TRUE
          AND (expires_at IS NULL OR expires_at > NOW())`,
      [code],
    );
    if (!row) {
      throw new BadRequestException({
        code: 'referral_code_invalid',
        message: 'That provider or referral code is not recognised. Check it, or leave it blank.',
      });
    }
    return row;
  }

  async submitRating(
    clientId: string, bookingId: string,
    dto: {stars: number; tags?: string[]; tip?: number; remarks?: string},
  ): Promise<{id: string; rating: number; agency_rating: number | null}> {
    // Phase 1 — write the rating atomically (idempotent: AND rating IS NULL ⇒ one per booking).
    const written = await this.db.withTransaction(async tx => {
      const won = await tx.q<{assigned_provider_user_id: string | null}>(
        // Issue 31 — persist tags + remarks alongside the star count. `tags`
        // was accepted by the DTO but never written, so the preset feedback
        // the client picked was silently discarded.
        `UPDATE lite_bookings SET rating = $2, rating_tags = $4, rating_remarks = $5
          WHERE id = $1 AND client_id = $3 AND status = 'COMPLETED' AND rating IS NULL
          RETURNING assigned_provider_user_id`,
        [bookingId, dto.stars, clientId, dto.tags ?? null, dto.remarks?.trim() || null],
      );
      if (won.length > 0) {
        return {kind: 'written' as const, providerId: won[0].assigned_provider_user_id, rating: dto.stars};
      }
      // Disambiguate the no-row: not owner / missing, not completed, or already rated.
      const cur = await tx.qOne<{status: string; rating: number | null; client_id: string}>(
        `SELECT status, rating, client_id FROM lite_bookings WHERE id = $1`,
        [bookingId],
      );
      if (!cur || cur.client_id !== clientId) throw new NotFoundException('Booking not found');
      if (cur.status !== 'COMPLETED') throw new BadRequestException('booking_not_completed');
      // Already rated → idempotent: a rating is one-shot, so echo the STORED value (a retry
      // with a different star count does NOT overwrite it; contact ops to amend).
      return {kind: 'idempotent' as const, rating: cur.rating ?? 0};
    });

    if (written.kind === 'idempotent') {
      return {id: bookingId, rating: written.rating, agency_rating: null};
    }
    // Phase 2 — recompute the agency average AFTER the rating commit, in its own statement,
    // so it reads the committed set (incl. any concurrent rating of the same agency) rather
    // than this txn's pre-commit snapshot. A failed recompute leaves the rating saved and
    // the average is corrected by the next rating; it never double-counts or rolls back data.
    let agencyRating: number | null = null;
    if (written.providerId) {
      const r = await this.db.qOne<{rating: string | null}>(
        `UPDATE agents SET rating = (
           SELECT ROUND(AVG(rating)::numeric, 2)
             FROM lite_bookings
            WHERE assigned_provider_user_id = $1 AND rating IS NOT NULL)
         WHERE user_id = $1 RETURNING rating`,
        [written.providerId],
      );
      const rv = r?.rating;
      agencyRating = rv !== null && rv !== undefined ? Number(rv) : null;
    }
    return {id: bookingId, rating: written.rating, agency_rating: agencyRating};
  }

  async cancel(clientId: string, id: string): Promise<{id: string; status: BookingStatus; refunded_credits: number; already_ended?: boolean}> {
    // LM-B4 — every cancel decision (FSM, window, protection-active) is made UNDER the
    // booking row lock and the flip is status-guarded, so a concurrent lead go-live
    // can't interleave between an unlocked read and an unconditional UPDATE (the old
    // TOCTOU that let a client cancel a mission that had just gone LIVE).
    let refundedCredits = 0;
    const escrow = await this.db.withTransaction(async tx => {
      const row = await tx.qOne<{
        status: BookingStatus; payment_captured: boolean; created_at: Date;
        dispatch_mode: string | null; dispatch_settled_at: Date | null;
        payer_user_id: string | null; assigned_provider_user_id: string | null;
        confirmed_at: Date | null;
      }>(
        `SELECT status, payment_captured, created_at, dispatch_mode, dispatch_settled_at,
                payer_user_id, assigned_provider_user_id, confirmed_at
           FROM lite_bookings WHERE id = $1 AND client_id = $2 FOR UPDATE`,
        [id, clientId],
      );
      if (!row) throw new NotFoundException('Booking not found');
      // NO-PROVIDER CANCEL (Job-Portal QA 2026-07-10) — the client taps "cancel search"
      // just as (or after) the search dies NO_PROVIDER, or re-taps after an earlier
      // cancel, or the agency-no-show sweep already closed it. Their intent — stop the
      // booking — is already satisfied, so answer with an idempotent success instead of
      // the FSM's 403 (which surfaced as a raw error popup on the searching screen).
      // No money moves here: each of these terminal paths already refunded on its own
      // (crew-SLA for AGENCY_NO_SHOW, noProvider's R12 refund, the first cancel).
      if (row.status === 'CANCELLED' || row.status === 'NO_PROVIDER' || row.status === 'AGENCY_NO_SHOW') {
        return {kind: 'already_ended' as const, status: row.status};
      }
      this.fsm.assert(row.status, 'CANCELLED', 'CLIENT');

      // Client cancellation WINDOW (LM-B8) — nothing is committed before an agency
      // accepts (or ops approval/payment on the legacy path), so pre-commitment
      // statuses are always cancellable — a scheduled ("later") booking no longer
      // self-locks an hour after creation. Once CONFIRMED, the window is anchored to
      // the ACCEPT time for auto bookings (dispatch_settled_at) and to the actual
      // payment/confirmation time for legacy ones (B-386 — anchoring to created_at
      // locked scheduled clients out days before service while the error text said
      // "of confirmation"; confirmed_at is stamped at the CONFIRMED flip, old rows
      // fall back to created_at = the previous behavior).
      const preCommitment: readonly BookingStatus[] =
        ['DRAFT', 'DISPATCHING', 'PENDING_OPS', 'OPS_APPROVED', 'PAYMENT_PENDING'];
      if (!preCommitment.includes(row.status)) {
        const windowHours = this.config.get<number>('booking.cancelWindowHours') ?? 1;
        const anchor = row.dispatch_mode === 'auto'
          ? (row.dispatch_settled_at ?? row.created_at)
          : (row.confirmed_at ?? row.created_at);
        const ageMs = Date.now() - new Date(anchor).getTime();
        if (ageMs > windowHours * 3_600_000) {
          throw new BadRequestException({
            code: 'cancel_window_expired',
            message: `Cancellation is only allowed within ${windowHours} hour(s) of confirmation. Contact support to cancel.`,
            window_hours: windowHours,
          });
        }
      }

      // MISSION-CANCEL (#14) — no client cancel once protection is ACTIVE. Checked
      // under the mission row lock (booking→mission order, matching the sweeps) so a
      // concurrent go-live serializes behind us or wins visibly. LM-B1: ABORTED
      // history rows are skipped.
      const liveMission = await tx.qOne<{id: string; status: string}>(
        `SELECT id, status FROM missions
          WHERE booking_id = $1 AND status <> 'ABORTED'
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [id],
      );
      if (liveMission && (liveMission.status === 'LIVE' || liveMission.status === 'SOS')) {
        throw new BadRequestException({
          code: 'cancel_blocked_protection_active',
          message: 'Protection is already active. Contact support to end the mission.',
        });
      }

      // Status-guarded flip — 0 rows means the state moved after our lock read
      // (defensive; under FOR UPDATE this can't happen, but never cancel blind).
      const flipped = await tx.q(
        `UPDATE lite_bookings
            SET status = 'CANCELLED',
                dispatch_settled_at = CASE WHEN dispatch_mode = 'auto'
                                           THEN COALESCE(dispatch_settled_at, NOW())
                                           ELSE dispatch_settled_at END
          WHERE id = $1 AND status = $2 RETURNING id`,
        [id, row.status],
      );
      if (flipped.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }

      // LM-B2 — retire any live offer for this booking. Without this, a cancel while
      // DISPATCHING left the offer OFFERED, and dispatch_offers_one_live_per_provider
      // benched that agency from ALL other bookings until the expiry sweep reaped it.
      const benched = await tx.q<{provider_user_id: string}>(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED' RETURNING provider_user_id`,
        [id],
      );

      // Step 11 — escrow-aware cancel. An AUTO-dispatch booking carries a HELD escrow
      // hold; cancelling it must REVERSE that hold (not the legacy payment refund, which
      // would strand the escrow account credited and the hold orphaned — the documented
      // cut-over blocker). Reverse atomically with the CANCELLED flip:
      //   • pre-grace (no crew committed / no mission) → FULL refund (basis='refund').
      //   • post-grace (agency already committed crew → a mission exists) → PARTIAL: a
      //     cancellation fee to the agency, remainder refunded (basis='partial').
      // A LEGACY booking (no hold) keeps the existing idempotent payment refund.
      // MISSION-CANCEL (#14) — abort the mission ATOMICALLY with the booking flip
      // so a reader never sees a CANCELLED booking with a still-active mission.
      // LIVE/SOS are blocked above, so only DISPATCHED/PICKUP reach here. Keep the
      // mission_crew rows (status='off' frees capacity via mission_crew_agent_active_uq)
      // so the ABORTED mission still shows in CPO history. The escrow/refund math
      // below is untouched — these statements add nothing to the money path.
      // B-378 — capture the crew BEFORE the abort so the post-commit block can wake
      // them (a CPO already en route otherwise keeps navigating to a dead mission)
      // and the accepted agency (its board only updated on poll).
      const abortCrew = await tx.q<{mission_id: string; agent_id: string}>(
        `SELECT mc.mission_id, mc.agent_id
           FROM mission_crew mc
           JOIN missions m ON m.id = mc.mission_id
          WHERE m.booking_id = $1 AND m.status IN ('DISPATCHED','PICKUP') AND mc.status <> 'off'`,
        [id],
      );
      for (const from of ['DISPATCHED', 'PICKUP'] as const) {
        missionFsm.assert(from as MissionStatus, 'ABORTED', 'SYSTEM');
      }
      await tx.q(
        `UPDATE missions SET status = 'ABORTED', ended_at = NOW(), ended_by = $2, end_reason = 'client_cancel'
          WHERE booking_id = $1 AND status IN ('DISPATCHED','PICKUP')`,
        [id, clientId],
      );
      await tx.q(
        `UPDATE mission_crew SET status = 'off'
          WHERE mission_id IN (SELECT id FROM missions WHERE booking_id = $1)`,
        [id],
      );
      // MISSION-GROUP (area 5) — DELETE the Ops Room on cancel too, so the
      // cancelled mission's room disappears for the client AND the SP/agency.
      // Capture the conversation id BEFORE nulling the back-reference, then SET
      // NULL the back-references (lite_bookings, missions) and delete the child
      // rows that FK conversations.id, then the conversation itself. Idempotent: a
      // missing/already-deleted conversation is a no-op. Server-side metadata only
      // — no group keys touched.
      const convRow = await tx.qOne<{conversation_id: string | null}>(
        `SELECT conversation_id FROM lite_bookings WHERE id = $1`,
        [id],
      );
      if (convRow?.conversation_id) {
        const c = [convRow.conversation_id];
        await tx.q(`UPDATE public.lite_bookings SET conversation_id = NULL WHERE conversation_id = $1`, c);
        await tx.q(`UPDATE public.missions SET comms_channel_id = NULL WHERE comms_channel_id = $1`, c);
        await tx.q(`DELETE FROM public.dispatch_room_intents WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.conversation_members WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.system_broadcasts WHERE conversation_id = $1`, c);
        await tx.q(`DELETE FROM public.conversations WHERE id = $1`, c);
      }
      const hold = await tx.qOne<{gross_credits: number}>(
        `SELECT gross_credits FROM escrow_holds WHERE booking_id = $1 AND status = 'HELD' FOR UPDATE`,
        [id],
      );
      const shared = {
        benched: benched.map(b => b.provider_user_id),
        fromStatus: row.status,
        paymentCaptured: row.payment_captured,
        // Family bookings debited the HOLDER's wallet — the legacy refund below
        // must credit that same wallet, not the cancelling member (whose wallet
        // holds no debit for this booking, so the refund would silently no-op).
        payerId: row.payer_user_id ?? clientId,
        // B-378 — who must hear about the abort, post-commit.
        abortCrew,
        providerId: row.assigned_provider_user_id,
      };
      if (!hold) return {kind: 'legacy' as const, credits: 0, ...shared};
      // "Crew committed" = a LIVE (non-ABORTED) mission by the CURRENT agency — an
      // ABORTED history row from a prior no-show round must not charge the client
      // a cancel fee for crew that never showed up (LM-B1).
      const committed = await tx.qOne<{id: string}>(
        `SELECT id FROM missions WHERE booking_id = $1 AND status <> 'ABORTED'`,
        [id],
      );
      const cancelFeePct = this.config.get<number>('dispatch.cancelFeePct') ?? 0;
      if (committed && cancelFeePct > 0) {
        const fee = Math.min(hold.gross_credits, Math.max(0, Math.round((hold.gross_credits * cancelFeePct) / 100)));
        const r = await this.wallet.settleEscrowSplit(tx, id, {
          toProvider: fee,
          toClient: hold.gross_credits - fee,
          basis: 'partial',
          fromStatuses: ['HELD'],
          finalStatus: 'PARTIAL',
          reason: `Cancellation fee · booking ${id}`,
        });
        return {kind: 'escrow' as const, credits: r.toClient, ...shared};
      }
      const r = await this.wallet.refundEscrowHold(tx, id, `Refund · booking ${id} cancelled`);
      return {kind: 'escrow' as const, credits: r.credits, ...shared};
    });

    if (escrow.kind === 'already_ended') {
      // Idempotent no-op — nothing flipped, nothing to refund/audit/release.
      return {id, status: escrow.status, refunded_credits: 0, already_ended: true};
    }
    if (escrow.kind === 'legacy') {
      // Audit C2 — legacy captured-credit refund (idempotent per user+booking).
      if (escrow.paymentCaptured) {
        try {
          const r = await this.wallet.refundForBooking(escrow.payerId, id, `Refund · booking ${id} cancelled`);
          refundedCredits = r.credits;
        } catch (e) {
          this.log.error(`refund failed on cancel for booking ${id}: ${(e as Error).message}`);
        }
      }
    } else {
      refundedCredits = escrow.credits;
    }
    // LM-B2 — nudge any agency whose live offer we just superseded so its app
    // re-polls and drops the phantom offer card (same wake dispatch.cancel used).
    for (const providerUserId of escrow.benched) {
      void this.bookingPush?.dispatchOffer(providerUserId, id).catch(() => undefined);
    }
    // B-378 — a crewed cancel used to abort the mission silently: wake every crew
    // member (mission-aborted — same kind ops-abort uses, client handling exists)
    // and the accepted agency (its re-crewable slot just freed).
    const wokenCrew = new Set<string>();
    for (const t of escrow.abortCrew) {
      if (wokenCrew.has(t.agent_id)) continue;
      wokenCrew.add(t.agent_id);
      void this.bookingPush?.missionAborted(t.agent_id, t.mission_id, id).catch(() => undefined);
    }
    // The accepted agency is woken whether or not it had crewed yet: cancelling
    // inside the crew-assign SLA window is precisely when it is still working the
    // job (review finding — gating this on crew left that window dark).
    if (escrow.providerId) {
      void this.bookingPush?.missionCancelledByClient(
        escrow.providerId, escrow.abortCrew[0]?.mission_id ?? null, id,
      ).catch(() => undefined);
    }
    // Return legacy-pool CPOs + vehicle (no-op for auto bookings, whose crew capacity
    // frees implicitly when the mission is terminal).
    await Promise.allSettled([
      this.cpoAssign.release(id),
      this.vehicles.release(id),
    ]);
    await this.audit(id, escrow.fromStatus, 'CANCELLED', clientId, 'CLIENT',
      {reason: 'client_cancel', refunded_credits: refundedCredits});
    return {id, status: 'CANCELLED', refunded_credits: refundedCredits};
  }

  /**
   * Step 11 §41 — client confirms the job early, releasing the escrow to the agency
   * NOW instead of waiting for the dispute-window sweep. Only valid while the hold is
   * PENDING_RELEASE and NOT flagged for review; the client must own the booking. Runs
   * the shared SettlementService release in one txn (idempotent — a re-tap no-ops).
   */
  async confirmComplete(clientId: string, id: string): Promise<{id: string; status: 'RELEASED'; to_provider_credits: number}> {
    const res = await this.db.withTransaction(async tx => {
      const hold = await tx.qOne<{status: string; review_required: boolean; client_id: string}>(
        `SELECT eh.status, eh.review_required, b.client_id
           FROM escrow_holds eh JOIN lite_bookings b ON b.id = eh.booking_id
          WHERE eh.booking_id = $1 FOR UPDATE`,
        [id],
      );
      if (!hold || hold.client_id !== clientId) throw new NotFoundException('Booking not found');
      if (hold.review_required) throw new BadRequestException('confirm_not_allowed_review');
      if (hold.status !== 'PENDING_RELEASE') throw new BadRequestException('confirm_not_allowed');
      return this.settlement.settleEscrowRelease(tx, id, {kind: 'client', userId: clientId});
    });
    // LM-N4 — wake the agency about its payout (post-commit).
    if (res.released && res.providerUserId) {
      void this.bookingPush?.payoutSettled(res.providerUserId, id, res.toProvider).catch(() => undefined);
    }
    return {id, status: 'RELEASED', to_provider_credits: res.toProvider};
  }

  /**
   * Step 11 §41 — client raises a dispute, freezing the escrow before it releases. Only
   * valid while PENDING_RELEASE (not after RELEASED). Race-safe: the conditional
   * PENDING_RELEASE→DISPUTED flip beats a concurrent release sweep (dispute wins). The
   * partial unique index `booking_disputes_one_open` blocks a 2nd open dispute.
   */
  async openDispute(clientId: string, id: string, dto: CreateDisputeDto): Promise<{id: string; status: 'DISPUTED'; dispute_id: string}> {
    const disputeId = await this.db.withTransaction(async tx => {
      const hold = await tx.qOne<{status: string; client_id: string}>(
        `SELECT eh.status, b.client_id
           FROM escrow_holds eh JOIN lite_bookings b ON b.id = eh.booking_id
          WHERE eh.booking_id = $1 FOR UPDATE`,
        [id],
      );
      if (!hold || hold.client_id !== clientId) throw new NotFoundException('Booking not found');
      if (hold.status !== 'PENDING_RELEASE') throw new BadRequestException('dispute_not_allowed');
      const flipped = await tx.qOne<{id: string}>(
        `UPDATE escrow_holds SET status = 'DISPUTED'
          WHERE booking_id = $1 AND status = 'PENDING_RELEASE' RETURNING id`,
        [id],
      );
      if (!flipped) throw new BadRequestException('dispute_not_allowed');
      try {
        const d = await tx.qOne<{id: string}>(
          `INSERT INTO booking_disputes (booking_id, raised_by, category, reason, status)
           VALUES ($1, $2, $3, $4, 'open') RETURNING id`,
          [id, clientId, dto.category, dto.reason ?? null],
        );
        return d?.id ?? '';
      } catch (e) {
        // booking_disputes_one_open partial unique → a 2nd open dispute is rejected.
        if (/duplicate key|unique/i.test((e as Error).message)) throw new BadRequestException('dispute_already_open');
        throw e;
      }
    });
    // LM-N4 — the agency's payout just froze; tell it a dispute was opened.
    const provider = await this.db.qOne<{provider_user_id: string | null}>(
      `SELECT provider_user_id FROM escrow_holds WHERE booking_id = $1`,
      [id],
    );
    if (provider?.provider_user_id) {
      void this.bookingPush?.disputeOpened(provider.provider_user_id, id).catch(() => undefined);
    }
    return {id, status: 'DISPUTED', dispute_id: disputeId};
  }

  /**
   * Step 11 §41 — hold state + final split for the receipt/UI. Readable by the client
   * who owns the booking OR the assigned agency provider. Never leaks the counterparty's
   * identity — only credit amounts + status.
   */
  async getEscrow(userId: string, id: string): Promise<{
    booking_id: string; status: string; basis: string | null; currency: string;
    gross_credits: number; to_provider_credits: number | null; to_client_credits: number | null;
    platform_fee_credits: number | null; release_eligible_at: string | null; review_required: boolean;
  }> {
    const row = await this.db.qOne<{
      booking_id: string; status: string; basis: string | null; currency: string; gross_credits: number;
      to_provider_credits: number | null; to_client_credits: number | null; platform_fee_credits: number | null;
      release_eligible_at: Date | null; review_required: boolean; client_id: string; provider_user_id: string | null;
    }>(
      `SELECT eh.booking_id, eh.status, eh.basis, eh.currency, eh.gross_credits,
              eh.to_provider_credits, eh.to_client_credits, eh.platform_fee_credits,
              eh.release_eligible_at, eh.review_required, b.client_id, eh.provider_user_id
         FROM escrow_holds eh JOIN lite_bookings b ON b.id = eh.booking_id
        WHERE eh.booking_id = $1`,
      [id],
    );
    if (!row || (row.client_id !== userId && row.provider_user_id !== userId)) {
      throw new NotFoundException('Booking not found');
    }
    return {
      booking_id: row.booking_id, status: row.status, basis: row.basis, currency: row.currency,
      gross_credits: row.gross_credits, to_provider_credits: row.to_provider_credits,
      to_client_credits: row.to_client_credits, platform_fee_credits: row.platform_fee_credits,
      release_eligible_at: row.release_eligible_at ? row.release_eligible_at.toISOString() : null,
      review_required: row.review_required,
    };
  }

  /**
   * Audit fix 3.1 — replace mobile's hardcoded `REGIONS` constant with
   * a live read from the cpo_pool. Returns one row per supported region
   * with the count of currently-available CPOs. Lite uses this to
   * disable the "Coming soon" regions and stamp accurate counts on the
   * zone map; ops uses it to surface dispatch capacity.
   *
   * city-level zone breakdowns stay client-side static for now — the
   * cpo_pool only carries country-level region_code. A future migration
   * adding a `city_code` column would let this be granular.
   */
  async listRegionsAvailability(): Promise<Array<{
    code: string; name: string; cpos_available: number; cpos_total: number;
    available: boolean;
  }>> {
    const rows = await this.db.q<{
      region_code: string; available: string; total: string;
    }>(
      `SELECT
         region_code,
         SUM(CASE WHEN availability = 'available' AND active = TRUE THEN 1 ELSE 0 END)::text AS available,
         COUNT(*)::text AS total
       FROM cpo_pool
      GROUP BY region_code`,
    );
    // Audit fix #15 — supported-region list comes from a single shared
    // constant so a new region only needs adding in one place; mobile's
    // ZoneMapScreen REGION_SEED still owns city-level zone geometry
    // (lat/lng/city labels), but the canonical {code → name} map lives
    // in SUPPORTED_REGIONS below.
    const byCode = new Map(rows.map(r => [r.region_code, r]));
    return SUPPORTED_REGIONS.map(({code, name, launched}) => {
      const row = byCode.get(code);
      const cposAvailable = Number(row?.available ?? 0);
      const cposTotal     = Number(row?.total     ?? 0);
      return {
        code,
        name,
        cpos_available: cposAvailable,
        cpos_total:     cposTotal,
        // B-93 — bookability is the PRODUCT launch flag, not a live head-
        // count: a freshly-launched region (ZA) must be selectable before
        // its pool is staffed, and a live region must not flash "COMING
        // SOON" if its pool momentarily hits zero. Counts stay informational.
        available: launched,
      };
    });
  }

  async listAddOns(region: string): Promise<Array<{
    id: string; label: string; description: string | null;
    price_eur_per_hour: number; requires_ops_approval: boolean;
  }>> {
    const rows = await this.db.q<AddOnRow>(
      `SELECT * FROM lite_booking_add_ons
        WHERE active = TRUE AND (region_code = $1 OR region_code = 'GLOBAL')`,
      [region],
    );
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      description: r.description,
      price_eur_per_hour: Number(r.price_eur_per_hour),
      requires_ops_approval: r.requires_ops_approval,
    }));
  }

  // ──────────────────────────────────────────────────────────────────
  // helpers
  // ──────────────────────────────────────────────────────────────────

  private async resolveAddOns(region: string, ids: string[]): Promise<AddOnPricing[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.q<AddOnRow>(
      `SELECT * FROM lite_booking_add_ons
        WHERE id = ANY($1::text[])
          AND active = TRUE
          AND (region_code = $2 OR region_code = 'GLOBAL')`,
      [ids, region],
    );
    return rows.map(r => ({
      id: r.id,
      label: r.label,
      price_eur_per_hour: Number(r.price_eur_per_hour),
    }));
  }

  private async audit(
    bookingId: string,
    from: BookingStatus | null,
    to: BookingStatus,
    actorId: string,
    actorRole: ActorRole,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO lite_booking_audit
          (booking_id, from_status, to_status, actor_id, actor_role, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [bookingId, from, to, actorId, actorRole, JSON.stringify(metadata)],
      );
    } catch (e) {
      // Audit L1 — a dropped audit row is a compliance gap, not a UX blip,
      // so it must NOT vanish into a warn line. We keep it non-fatal (the
      // booking transition already happened; failing it on an audit hiccup
      // would be worse), but escalate to error-level with a structured,
      // greppable marker carrying the full transition so monitoring can
      // alert AND the lost row is reconstructable from logs.
      this.log.error(
        `[audit-gap] lite_booking_audit insert FAILED ` +
        `booking=${bookingId} ${from ?? '∅'}→${to} actor=${actorId}/${actorRole} ` +
        `meta=${JSON.stringify(metadata)} err=${(e as Error).message}`,
      );
    }
  }

  private toClientBooking(r: LiteBookingRow): ClientBooking {
    return {
      id: r.id,
      client_id: r.client_id,
      status: r.status,
      type: 'timeslot',
      region: r.region_code,
      region_label: r.region_label,
      service: r.service,
      pickup: {
        address: r.pickup_address,
        latitude: Number(r.pickup_lat ?? 0),
        longitude: Number(r.pickup_lng ?? 0),
      },
      dropoff: r.dropoff_address
        ? {
            address: r.dropoff_address,
            latitude: Number(r.dropoff_lat ?? 0),
            longitude: Number(r.dropoff_lng ?? 0),
          }
        : null,
      start_time: new Date(r.pickup_time).toISOString(),
      passengers: r.passengers,
      cpo_count: r.cpo_count,
      vehicle_count: r.vehicle_count,
      driver_only: r.driver_only,
      add_ons: r.add_ons,
      estimated_price: Number(r.total_eur),
      duration_hours: r.duration_hours,
      total_eur: Number(r.total_eur),
      total_aed: Number(r.total_aed),
      conversation_id: r.conversation_id,
      created_at: new Date(r.created_at).toISOString(),
      dispatch_mode: r.dispatch_mode ?? null,
      task_type: r.task_type ?? null,
      exec_transport: r.exec_transport ?? null,
      payment_method: r.payment_method ?? null,
      notes: r.notes ?? null,
      booking_mode: r.booking_mode ?? null,
      ...(r.status === 'NO_PROVIDER'
        ? {
            no_provider_fallback: {
              hotline_e164: this.config.get<string>('booking.hotlineE164') ?? '',
              can_widen:    true,  // re-dispatch with a wider region/radius (ops-driven)
              can_escalate: true,
            },
          }
        : {}),
    };
  }

  // ─── Step 16 — identity handshake + NO_PROVIDER escalation ─────────────────

  /** Client reads the on-arrival verify code for their booking (owner-scoped) plus the
   *  assigned lead's name/call-sign so they can visually confirm the guard. 400 until
   *  crew is assigned — there is no guard to verify before then. The code is derived
   *  (shared deriveVerifyCode), rotating + bound to the lead's agent id, never stored;
   *  the lead reads the same value from their mission endpoint. NEVER logged. */
  async getVerifyCode(clientId: string, id: string): Promise<{
    code: string; rotates_at: string;
    arrival_code: string; arrival_rotates_at: string;
    lead: {display_name: string | null; call_sign: string | null};
  }> {
    const booking = await this.db.qOne<{id: string}>(
      `SELECT id FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!booking) throw new NotFoundException('Booking not found');
    const lead = await this.db.qOne<{agent_id: string; call_sign: string | null; display_name: string | null}>(
      `SELECT mc.agent_id, mc.call_sign, a.display_name
         FROM mission_crew mc
         JOIN missions m ON m.id = mc.mission_id
         LEFT JOIN agents a ON a.user_id = mc.agent_id
        WHERE m.booking_id = $1 AND mc.is_lead = TRUE AND mc.status <> 'off'
        LIMIT 1`,
      [id],
    );
    if (!lead) throw new BadRequestException('no_crew_assigned');
    const secret = this.config.get<string>('jwt.actionSecret') ?? '';
    const {code, rotates_at} = deriveVerifyCode(secret, id, lead.agent_id, Date.now());
    // FRAUD-2 / P0 — the client-bound ARRIVAL code the principal shows the guard,
    // who enters it (POST /agents/me/missions/:id/verify-arrival) to prove presence.
    // Bound to the client's id, so the guard cannot self-derive it. NEVER logged.
    const arrival = deriveVerifyCode(secret, id, clientId, Date.now());
    return {
      code, rotates_at,
      arrival_code: arrival.code, arrival_rotates_at: arrival.rotates_at,
      lead: {display_name: lead.display_name, call_sign: lead.call_sign},
    };
  }

  /** Client reports the arriving person is NOT the dispatched guard: stamp the
   *  marker (owner-scoped). The booking-scoped SOS that accompanies it is raised by
   *  the caller (ClientArrivalController, DispatchModule) — kept OUT of this service
   *  so BookingModule need not import SosModule (which imports OpsModule, which imports
   *  BookingModule → a module cycle). Throws 404 if the booking isn't the client's. */
  async markNotMyGuard(clientId: string, id: string): Promise<void> {
    const upd = await this.db.q<{id: string}>(
      `UPDATE lite_bookings SET not_my_guard_at = NOW()
        WHERE id = $1 AND client_id = $2 RETURNING id`,
      [id, clientId],
    );
    if (upd.length === 0) throw new NotFoundException('Booking not found');
  }

  /** Client escalates a stranded (NO_PROVIDER) booking to a human. Side-channel
   *  ONLY — NO status flip (NO_PROVIDER is terminal). Records the escalation for ops
   *  follow-up and hands back the hotline. Owner-scoped. */
  async escalate(clientId: string, id: string): Promise<{ok: true; hotline_e164: string}> {
    const row = await this.db.qOne<{status: BookingStatus}>(
      `SELECT status FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!row) throw new NotFoundException('Booking not found');
    await this.audit(id, row.status, row.status, clientId, 'CLIENT', {action: 'escalate'});
    return {ok: true, hotline_e164: this.config.get<string>('booking.hotlineE164') ?? ''};
  }

  // ─── Step 19 — client auto-dispatch provider reveal ────────────────────────

  /**
   * Client reads the COARSE provider reveal for the agency that accepted their auto
   * booking: name / call-sign / ★rating / missions completed. Owner-scoped (the client
   * must own the booking). Deliberately reads ONLY from `agents` — never a pickup/dropoff
   * coord or address (LB1: precise location stays agency-only post-accept). 404 with
   * `no_provider_yet` while still DISPATCHING (no agency assigned).
   */
  async getProvider(clientId: string, id: string): Promise<{
    display_name: string | null;
    call_sign: string | null;
    rating: number | null;
    jobs_total: number;
  }> {
    const booking = await this.db.qOne<{assigned_provider_user_id: string | null}>(
      `SELECT assigned_provider_user_id FROM lite_bookings WHERE id = $1 AND client_id = $2`,
      [id, clientId],
    );
    if (!booking) throw new NotFoundException('Booking not found');
    if (!booking.assigned_provider_user_id) throw new NotFoundException('no_provider_yet');
    const provider = await this.db.qOne<{
      display_name: string | null; call_sign: string | null; rating: string | null; jobs_total: number;
    }>(
      `SELECT display_name, call_sign, rating, jobs_total FROM agents WHERE user_id = $1`,
      [booking.assigned_provider_user_id],
    );
    if (!provider) throw new NotFoundException('Provider not found');
    return {
      display_name: provider.display_name,
      call_sign: provider.call_sign,
      rating: provider.rating !== null ? Number(provider.rating) : null,
      jobs_total: provider.jobs_total,
    };
  }
}
