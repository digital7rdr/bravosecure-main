import {
  Injectable, Logger, Optional, BadRequestException, NotFoundException, ForbiddenException, ConflictException,
} from '@nestjs/common';
import {DatabaseService, type Tx} from '../database/database.service';
import {BookingStateMachine, type BookingStatus} from '../booking/state-machine.service';
import {OpsAuditService} from '../ops/ops-audit.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {DispatchKillswitchService} from '../ops/dispatch-killswitch.service';
import {WalletService} from '../wallet/wallet.service';
import {PricingService} from '../booking/pricing.service';
import {DispatchMetricsService} from '../observability/dispatch-metrics.service';
import {FamilyService} from '../family/family.service';
import type {CoarseOfferDto, FullOfferDto} from './dto/offer.dto';

/**
 * DispatchService — the Uber-style matchmaker (BUILD_RUNBOOK Steps 6–7).
 *
 * On an auto request it ranks the nearest ELIGIBLE same-region on-duty agency
 * and offers the job for OFFER_TTL_SECONDS; on reject/expire it cascades to the
 * next-nearest, up to MAX_OFFERS; if nobody is available the booking goes
 * NO_PROVIDER. On accept it wins the offer + flips the booking to CONFIRMED and
 * commits the AGENCY only — crew is assigned later (D7). The coarse/full read
 * helpers back the agency-facing offer endpoints (DispatchController).
 *
 * Invariants:
 *  - Every state change is an offer/booking-anchored conditional
 *    `UPDATE … WHERE <expected status> RETURNING` inside withTransaction, so two
 *    pods racing the same offer can never double-act (LB8) — the loser sees 0
 *    rows and 409s/no-ops. Mirrors job-feed.service.ts cancel().
 *  - The ranking is region-scoped PostGIS (ST_DWithin + GiST nearest) — never a
 *    per-row haversine — and applies the licence/insurance/armed (LB10) +
 *    capacity (D6) + requirements (LB11) predicates via SQL functions.
 *  - COARSE pre-accept (LB1/Part III #3): the ranking returns ONLY user_id +
 *    distance_km, and getCurrentOfferForOrg exposes ONLY a relative distance
 *    bucket — never an absolute pickup/dropoff coord, address, or client id.
 *    Exact location is revealed only by getFullOffer, ACCEPTED + owner only, and
 *    every such read is audited fail-closed (dispatch.full_read).
 *  - Pushes (offer / accept / no-provider wakes) are best-effort and opaque
 *    (BookingPushBridge); the apps also poll, so the cascade is correct without
 *    them. A push never blocks or fails a transition.
 */
// Why: offer accept-window is env-tunable so one-phone staging tests can use a
// longer window (DISPATCH_OFFER_TTL_SECONDS) to switch client↔agency accounts;
// prod omits the env and keeps the 30s default. Mirrors DISPATCH_RADIUS_M etc.
const OFFER_TTL_SECONDS = Number(process.env.DISPATCH_OFFER_TTL_SECONDS ?? 30);
const MAX_OFFERS = 8;
// Bound on offerNext passes within one call. A pass only repeats on a per-provider
// unique collision (candidate took a live offer elsewhere mid-ranking); each such
// collision excludes one agency from the next ranking, so the cascade terminates
// well under this cap for any realistic regional pool. Caps pathological churn.
const MAX_OFFER_ATTEMPTS = 32;
// Env-overridable so staging can relax the freshness window for manual testing (an idle
// agency's on-duty heartbeat keeps this fresh in production; a demo has no live heartbeat).
const LOCATION_FRESH_MINUTES = Number(process.env['DISPATCH_LOCATION_FRESH_MINUTES'] ?? '5');
const DISPATCH_RADIUS_M = Number(process.env['DISPATCH_RADIUS_M'] ?? '50000'); // same-region search radius (m)
// After an agency accepts it must assign crew within this window; the Step 8
// crew-SLA watchdog auto-refunds + flags a booking still uncrewed past it. The
// plan leaves the exact value open ("N minutes") — tune before cut-over.
const CREW_ASSIGN_SLA_MINUTES = 15;
// Step 24 — distance band (km) for the ranking's "best firms rise" secondary sort: only
// agencies within the SAME ~1km band compete on rating, so rating never overrides a
// MEANINGFULLY closer agency (safety-critical dispatch). Across bands, nearest still wins.
// Tight (1km ≈ <3min ETA gap) keeps the rating tradeoff defensible; tunable before cut-over.
const DISPATCH_RANK_BUCKET_KM = 1;
// A brand-new agency has no rating yet (NULL). Give it a neutral baseline in the sort so
// it isn't ranked below a genuinely low-rated incumbent (barrier-to-entry fairness).
const DISPATCH_NEUTRAL_RATING = 3.0;

// Step 23 anti-fraud — chronic-rejecter cooldown. Once an agency has RESPONDED to at
// least COOLDOWN_MIN_SAMPLE offers and accepts fewer than COOLDOWN_ACCEPT_FLOOR of
// them, it is benched for COOLDOWN_MINUTES (the ranking gates on cooldown_until).
const COOLDOWN_MIN_SAMPLE = 5;
const COOLDOWN_ACCEPT_FLOOR = 0.2;
const COOLDOWN_MINUTES = 30;

// Reliability accounting applied when an agency declines OR ignores (lets expire) an
// offer — both count against acceptance_rate so an agency can't dodge the cooldown by
// silently timing offers out instead of rejecting. $1 = provider_user_id. The cooldown
// CASE only ARMS (never clears early), so an armed bench runs its full window; it
// self-heals as the agency accepts more and acceptance_rate climbs back over the floor.
// NOTE (known limitation, soft heuristic): counters are per-agency (the org user_id);
// only `company` agents receive offers (managed CPOs never do), so there is no
// per-member aggregation gap. Cross-agency collusion would require multiple separately
// licence/insurance/DPA-verified orgs — out of scope for this cooldown.
const DECLINE_ACCOUNTING_SQL = `
  UPDATE agents
     SET offers_rejected = offers_rejected + 1,
         acceptance_rate = ROUND(offers_accepted::numeric
                           / NULLIF(offers_accepted + offers_rejected + 1, 0), 3),
         cooldown_until = CASE
           WHEN (offers_accepted + offers_rejected + 1) >= ${COOLDOWN_MIN_SAMPLE}
            AND offers_accepted::numeric
                / NULLIF(offers_accepted + offers_rejected + 1, 0) < ${COOLDOWN_ACCEPT_FLOOR}
           THEN NOW() + (${COOLDOWN_MINUTES} || ' minutes')::interval
           ELSE cooldown_until
         END
   WHERE user_id = $1`;

// STAGING-ONLY anti-fraud RELAXATION (demo enablement). When
// DISPATCH_TRUST_MOCKED_LOCATION=true the ranking (a) DROPS the `last_location_mocked
// = FALSE` gate and (b) disables the freshness window (a huge $5 fresh_minutes) — the
// two gates an emulator / mock-GPS provider structurally cannot pass. This WEAKENS a
// documented anti-fraud stop-condition (CLAUDE.md), so it is BOTH fail-fast refused at
// boot in production (main.ts dangerous-flags guard) AND ignored here unless
// NODE_ENV!=='production'. Distance is unaffected — it stays governed by
// DISPATCH_RADIUS_M (raise that env for a cross-region demo). Exported pure helpers so
// the gating logic is unit-tested without an env/module reset.
export function resolveTrustMockedLocation(flag: string | undefined, nodeEnv: string | undefined): boolean {
  return flag === 'true' && nodeEnv !== 'production';
}
export function mockedLocationClause(trust: boolean): string {
  return trust ? '' : 'AND a.last_location_mocked = FALSE';
}
const TRUST_MOCKED_LOCATION = resolveTrustMockedLocation(
  process.env['DISPATCH_TRUST_MOCKED_LOCATION'], process.env['NODE_ENV'],
);
// Effective freshness window: the real value, or "never stale" when the staging trust
// flag is on (an emulator provider has no live heartbeat to keep last_location_at fresh).
const EFFECTIVE_FRESH_MINUTES = TRUST_MOCKED_LOCATION ? 5_256_000 /* ~10y */ : LOCATION_FRESH_MINUTES;

// STAGING-ONLY region bypass (testing enablement). When
// DISPATCH_DISABLE_REGION_FILTER=true the ranking drops BOTH the explicit
// `a.region_code = $3` filter AND the region-scoped `is_eligible_for_dispatch`
// gate — the latter's licence/insurance/armed checks are all per-region, so
// keeping it would re-block a cross-region test provider. Guarded exactly like
// the mocked-location flag: fail-fast refused at boot in production (main.ts
// dangerous-flags guard) AND ignored here unless NODE_ENV!=='production'.
export function resolveDisableRegionFilter(flag: string | undefined, nodeEnv: string | undefined): boolean {
  return flag === 'true' && nodeEnv !== 'production';
}
export function regionScopeClause(disabled: boolean): string {
  // When disabled we must STILL reference $3 (with an explicit cast) — dropping
  // it entirely makes Postgres throw "could not determine data type of parameter
  // $3" and the WHOLE ranking fails (zero offers, every booking stuck
  // DISPATCHING). This predicate is always true and just keeps $3 typed.
  return disabled
    ? 'AND ($3::text IS NOT NULL OR $3::text IS NULL)'
    : 'AND a.region_code = $3';
}
export function eligibilityClause(disabled: boolean): string {
  // Same reason for $4 — keep it referenced + typed when the eligibility gate is off.
  return disabled
    ? 'AND ($4::jsonb IS NOT NULL OR $4::jsonb IS NULL)'
    : 'AND public.is_eligible_for_dispatch(a.user_id, $3, $4::jsonb)';
}
const DISABLE_REGION_FILTER = resolveDisableRegionFilter(
  process.env['DISPATCH_DISABLE_REGION_FILTER'], process.env['NODE_ENV'],
);

// Region-scoped, eligibility-filtered, coarse (no coords out). $1=pickup_lat,
// $2=pickup_lng, $3=region, $4=requirements json, $5=fresh_minutes, $6=radius_m,
// $7=cpo_count, $8=booking_id. PostGIS is schema-qualified (extensions.*) so it
// resolves regardless of the connection search_path.
const RANKING_SQL = `
  SELECT a.user_id,
         extensions.ST_Distance(
           a.last_location,
           extensions.ST_SetSRID(extensions.ST_MakePoint($2, $1), 4326)::extensions.geography
         ) / 1000.0 AS distance_km
    FROM public.agents a
   WHERE a.type = 'company' AND a.status = 'ACTIVE' AND a.on_duty = TRUE
     AND a.last_location_at > NOW() - ($5 || ' minutes')::interval
     ${regionScopeClause(DISABLE_REGION_FILTER)}
     AND a.last_location IS NOT NULL
     -- Step 23 anti-fraud — never offer to a spoofed-position or benched agency.
     -- (the mocked predicate is dropped only under the staging DISPATCH_TRUST_MOCKED_LOCATION flag)
     ${mockedLocationClause(TRUST_MOCKED_LOCATION)}
     AND (a.cooldown_until IS NULL OR a.cooldown_until < NOW())
     AND extensions.ST_DWithin(
           a.last_location,
           extensions.ST_SetSRID(extensions.ST_MakePoint($2, $1), 4326)::extensions.geography,
           $6
         )
     ${eligibilityClause(DISABLE_REGION_FILTER)}
     -- Why: capacity is mission-level — a CPO committed to a non-terminal mission
     -- holds their seat for the mission lifetime (incl. stood-down crew), biasing
     -- a full agency toward NO_PROVIDER rather than over-allocating a CPO. Tunable
     -- in has_free_cpo_capacity before cut-over (flag-gated until then).
     AND public.has_free_cpo_capacity(a.user_id, $7)
     AND a.user_id NOT IN (SELECT provider_user_id FROM public.dispatch_offers WHERE status = 'OFFERED')
     -- Exclude any agency that already saw THIS booking: rejected/expired, or had its
     -- offer SUPERSEDED — the latter covers the Step-16 re-dispatch, where the
     -- no-show agency's prior ACCEPTED offer is superseded so it is never re-offered
     -- the same job it failed to arrive for.
     AND a.user_id NOT IN (SELECT provider_user_id FROM public.dispatch_offers
                            WHERE booking_id = $8 AND status IN ('REJECTED','EXPIRED','SUPERSEDED'))
   -- Step 24 — "best firms rise": nearest still wins ACROSS distance bands (the band is
   -- the primary sort), but WITHIN a ~1km band the higher-rated agency is preferred
   -- (agents.rating, written by the client rating loop; new agencies get a neutral
   -- baseline so they aren't penalized). Exact distance is the final tiebreaker.
   ORDER BY floor(
              extensions.ST_Distance(
                a.last_location,
                extensions.ST_SetSRID(extensions.ST_MakePoint($2, $1), 4326)::extensions.geography
              ) / 1000.0 / ${DISPATCH_RANK_BUCKET_KM}
            ) ASC,
            COALESCE(a.rating, ${DISPATCH_NEUTRAL_RATING}) DESC,
            a.last_location OPERATOR(extensions.<->)
            extensions.ST_SetSRID(extensions.ST_MakePoint($2, $1), 4326)::extensions.geography ASC
   LIMIT 1
`;

interface BookingCtx {
  status: string;
  region_code: string;
  cpo_count: number;
  pickup_lat: string | null;
  pickup_lng: string | null;
  requirements: Record<string, unknown> | null;
  armed_required: boolean;
}

/** Light PII redaction for a free-text reject reason (Part III privacy P1):
 *  strip email + long digit runs (phone) and cap the length. The controller
 *  (Step 7) should additionally constrain it to known reason codes. */
function redactReason(reason: string | undefined): string | null {
  if (!reason) {
    return null;
  }
  return reason
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[redacted]')
    // separator-laden phone runs ("+1 555-123-4567", "(555) 123 4567")…
    .replace(/\+?\d[\d\s().-]{5,}\d/g, '[redacted]')
    // …then any bare 6+-digit run the separator pattern doesn't cover.
    .replace(/\d{6,}/g, '[redacted]')
    .slice(0, 120);
}

/** Coarse, RELATIVE distance band for the pre-accept offer (LB1) — never the
 *  absolute pickup. distance_km arrives from pg as a string (numeric column). */
function distanceBucket(distanceKm: string | null): string {
  if (distanceKm === null) {
    return 'unknown';
  }
  const d = Number(distanceKm);
  if (!Number.isFinite(d)) {
    return 'unknown';
  }
  if (d < 2) {
    return '<2km';
  }
  if (d < 5) {
    return '2-5km';
  }
  if (d < 10) {
    return '5-10km';
  }
  return '>10km';
}

/** pg returns timestamptz as a Date; normalise to an ISO string for the DTO. */
function toIso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : new Date(v as string).toISOString();
}

/** The coarse offer exposes ONLY boolean capability flags (armed/female/medical…)
 *  from the requirements jsonb. Filtering to boolean VALUES structurally prevents
 *  any string/object a future ops/compliance path might store there (a principal
 *  name, note, vip id, phone) from leaking pre-accept to firms that didn't take
 *  the job — the crown-jewel leak LB1 forbids. Capability requirements are flags. */
function pickBooleanFlags(requirements: Record<string, unknown> | null): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(requirements ?? {})) {
    if (typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  return (e as {code?: string})?.code === '23505';
}

function isDeadlock(e: unknown): boolean {
  return (e as {code?: string})?.code === '40P01';
}

function constraintIs(e: unknown, name: string): boolean {
  return (e as {constraint?: string})?.constraint === name;
}

// ─── Dispatch Inspector (admin-only) response shapes ─────────────────────────
// Read models backing GET /ops/dispatch/requests (list) + /requests/:id (detail).
// Numeric DECIMAL columns (distance_km, rating, total_eur/aed) come back as
// strings from node-postgres; the ops-console coerces with Number(...) at render.
export interface DispatchRequestListRow {
  booking_id: string;
  status: string;
  region_code: string;
  region_label: string;
  service: string;
  cpo_count: number;
  armed_required: boolean;
  dispatch_mode: string | null;
  dispatch_started_at: string | null;
  dispatch_settled_at: string | null;
  created_at: string;
  updated_at: string;
  assigned_provider_user_id: string | null;
  accepting_agency_name: string | null;
  accepting_agency_call_sign: string | null;
  offers_count: number;
  crew_count: number;
  escrow_status: string | null;
  escrow_gross_credits: number | null;
  mission_status: string | null;
  mission_short_code: string | null;
  last_activity_at: string;
}

export interface DispatchRequestOffer {
  offer_id: string;
  provider_user_id: string;
  agency_name: string | null;
  agency_call_sign: string | null;
  agency_email: string | null;
  agency_rating: string | null;
  agency_region: string | null;
  rank: number;
  status: 'OFFERED' | 'ACCEPTED' | 'REJECTED' | 'EXPIRED' | 'SUPERSEDED' | 'CANCELLED';
  distance_km: string | null;
  offered_at: string;
  expires_at: string;
  responded_at: string | null;
  reject_reason: string | null;
}

export interface DispatchRequestCrew {
  agent_id: string;
  agent_name: string | null;
  agent_rating: string | null;
  call_sign: string;
  role: string;
  is_lead: boolean;
  slot: number;
  team_idx: number;
  armed: boolean;
  status: string;
}

export interface DispatchRequestEscrow {
  escrow_id: string;
  status: 'HELD' | 'PENDING_RELEASE' | 'RELEASED' | 'REFUNDED' | 'PARTIAL' | 'DISPUTED';
  gross_credits: number;
  currency: string;
  to_provider_credits: number | null;
  to_client_credits: number | null;
  platform_fee_credits: number | null;
  basis: string | null;
  review_required: boolean;
  held_at: string;
  completed_at: string | null;
  release_eligible_at: string | null;
  settled_at: string | null;
  offer_id: string | null;
}

export interface DispatchRequestMission {
  mission_id: string;
  status: 'DISPATCHED' | 'PICKUP' | 'LIVE' | 'SOS' | 'COMPLETED' | 'ABORTED';
  short_code: string;
  started_at: string;
  created_at: string;
  pickup_at: string | null;
  live_at: string | null;
  ended_at: string | null;
  end_reason: string | null;
  comms_channel_id: string | null;
}

export interface DispatchTimelineEntry {
  at: string;
  source: 'status' | 'ops_audit' | 'offer_made' | 'offer_outcome' | 'escrow' | 'mission';
  label: string;
  actor_role: string | null;
  actor_call: string | null;
  metadata: Record<string, unknown>;
}

export interface DispatchRequestDetail {
  booking: {
    booking_id: string;
    status: string;
    dispatch_mode: string | null;
    region_code: string;
    region_label: string;
    service: string;
    cpo_count: number;
    armed_required: boolean;
    requirements: Record<string, unknown> | null;
    client_id: string;
    assigned_provider_user_id: string | null;
    agency_name: string | null;
    agency_call_sign: string | null;
    agency_rating: string | null;
    agency_email: string | null;
    pickup_address: string | null;
    pickup_time: string | null;
    duration_hours: number | null;
    total_eur: string | null;
    total_aed: string | null;
    dispatch_started_at: string | null;
    dispatch_settled_at: string | null;
    crew_deadline_at: string | null;
    arrival_deadline_at: string | null;
    created_at: string;
    updated_at: string;
  };
  offers: DispatchRequestOffer[];
  escrow: DispatchRequestEscrow | null;
  mission: DispatchRequestMission | null;
  crew: DispatchRequestCrew[];
  timeline: DispatchTimelineEntry[];
}

@Injectable()
export class DispatchService {
  private readonly log = new Logger(DispatchService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly fsm: BookingStateMachine,
    private readonly audit: OpsAuditService,
    private readonly push: BookingPushBridge,
    private readonly wallet: WalletService,
    // Step 26 — optional so existing unit specs (which construct DispatchService directly)
    // don't need the registry; metric calls are guarded with `?.`.
    @Optional() private readonly metrics?: DispatchMetricsService,
    // INFRA-4 — runtime kill switch, so a mid-traffic kill also stops the offer cascade
    // and portal claims (it previously covered only the client submit path). Optional:
    // existing unit specs construct DispatchService directly → guarded with `?.`.
    @Optional() private readonly killswitch?: DispatchKillswitchService,
    // MON-6 — live eur_per_bc so the escrow charge is peg-correct. Optional: unit specs
    // construct DispatchService directly and get undefined → fall back to peg 1.0, which
    // is byte-identical to the shipped behaviour (total_eur / 1.0 === total_eur).
    @Optional() private readonly pricing?: PricingService,
    // Spec §33/§34 — post-commit family quota-threshold warnings. Optional for
    // the same reason as every dependency above it: the existing unit specs
    // construct DispatchService directly, and an absent instance simply skips a
    // notification. It is never on the charge path, so a missing one cannot
    // affect whether money moves.
    @Optional() private readonly family?: FamilyService,
  ) {
    if (TRUST_MOCKED_LOCATION) {
      this.log.warn(
        'DISPATCH_TRUST_MOCKED_LOCATION is ON — mocked-GPS + location-freshness anti-fraud gates are RELAXED. Staging/demo only; this must never run in production.',
      );
    }
  }

  /** Begin auto-dispatch for an auto booking: OPS_APPROVED → DISPATCHING (ops-gated
   *  flow — the ops-approved subscriber / scheduled cron call this after approval) or
   *  DRAFT → DISPATCHING (admin test-fire + any in-flight pre-gate rows), then offer
   *  the nearest eligible agency.
   *
   *  LM-B7 closed the two cut-over blockers that used to be flagged here: (a) the
   *  affordability soft-check runs at submit (BookingService.create routes a short
   *  balance to the paywall pre-dispatch) and (b) the family payer is resolved at
   *  submit and debited by accept() (lite_bookings.payer_user_id). */
  async start(bookingId: string): Promise<void> {
    const fromStatus = await this.db.withTransaction(async tx => {
      const b = await tx.qOne<{status: string; dispatch_mode: string | null}>(
        `SELECT status, dispatch_mode FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!b) {
        throw new NotFoundException('booking_not_found');
      }
      if (b.dispatch_mode !== 'auto') {
        throw new BadRequestException('not_an_auto_booking');
      }
      // Why: actor tracks the source edge — OPS_APPROVED→DISPATCHING is the ops-gated
      // SYSTEM edge; DRAFT→DISPATCHING stays the CLIENT submit edge. Any other source
      // (e.g. CONFIRMED) still fails the assert — the Step-16 re-dispatch has its own path.
      const actor = b.status === 'OPS_APPROVED' ? 'SYSTEM' as const : 'CLIENT' as const;
      this.fsm.assert(b.status as BookingStatus, 'DISPATCHING', actor);
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'DISPATCHING', dispatch_started_at = NOW()
          WHERE id = $1 AND status = $2 RETURNING id`,
        [bookingId, b.status],
      );
      if (upd.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }
      return b.status;
    });
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.start',
      subject_type: 'booking', subject_id: bookingId,
    });
    await this.auditBooking(bookingId, fromStatus, 'DISPATCHING', null,
      fromStatus === 'OPS_APPROVED' ? 'SYSTEM' : 'CLIENT', {reason: 'dispatch_start'});
    await this.offerNext(bookingId);
  }

  /**
   * Admin "fire a test dispatch" (ops-console Dispatch Monitor). Creates a fresh DRAFT
   * auto booking from the given params and runs the matchmaker, so an operator can watch
   * the engine offer the nearest eligible agency without the client app. The booking is a
   * real auto booking (DRAFT → DISPATCHING → OFFERED); accept/escrow follow the normal path.
   */
  async fireTestDispatch(
    adminUserId: string,
    args: {region_code: string; region_label?: string; pickup_lat: number; pickup_lng: number; pickup_address?: string; cpo_count?: number; duration_hours?: number; armed?: boolean; total_eur?: number},
  ): Promise<{booking_id: string}> {
    const cpoCount = Math.max(1, Math.min(4, args.cpo_count ?? 1));
    const durationHours = Math.max(1, args.duration_hours ?? 4);
    const totalEur = Math.max(1, args.total_eur ?? 100);
    const ratePerHour = Math.round((totalEur / durationHours) * 100) / 100;
    const pickupTime = new Date(Date.now() + 4 * 3_600_000); // 4h out — clears the lead-time gate
    const booking = await this.db.qOne<{id: string}>(
      `INSERT INTO public.lite_bookings
         (client_id, status, dispatch_mode, region_code, region_label, service, booking_mode,
          pickup_time, pickup_address, pickup_lat, pickup_lng,
          passengers, cpo_count, vehicle_count, driver_only,
          rate_eur_per_hour, rate_aed_per_hour, duration_hours, total_eur, total_aed,
          payment_method, armed_required)
       VALUES ($1, 'DRAFT', 'auto', $2, $3, 'secure_transfer', 'now',
          $4, $5, $6, $7,
          1, $8, 1, FALSE,
          $9, $10, $11, $12, $13,
          'card', $14)
       RETURNING id`,
      [adminUserId, args.region_code, args.region_label ?? args.region_code,
       pickupTime, args.pickup_address ?? 'Test pickup (ops-console)', args.pickup_lat, args.pickup_lng,
       cpoCount, ratePerHour, Math.round(ratePerHour * 3.67 * 100) / 100, durationHours, totalEur, Math.round(totalEur * 3.67 * 100) / 100,
       args.armed ?? false],
    );
    if (!booking) throw new BadRequestException('test_booking_create_failed');
    await this.audit.record({actor_id: adminUserId, actor_role: 'ADMIN', action: 'dispatch.test_fire', subject_type: 'booking', subject_id: booking.id});
    await this.start(booking.id);
    return {booking_id: booking.id};
  }

  /**
   * Live dispatch state for the ops-console Dispatch Monitor: bookings currently
   * DISPATCHING (with each offer's agency + status + countdown), and recently-settled
   * auto bookings (CONFIRMED / NO_PROVIDER / ...). Read-only. Provider EMAILS are shown
   * because this is admin-only — never exposed to the offered agencies (LB1).
   */
  async monitor(): Promise<{dispatching: unknown[]; recent: unknown[]}> {
    const dispatching = await this.db.q(
      `SELECT b.id AS booking_id, b.region_code, b.region_label, b.service, b.cpo_count,
              b.armed_required, b.dispatch_started_at,
              COALESCE(json_agg(json_build_object(
                'offer_id', o.id, 'provider_user_id', o.provider_user_id,
                'provider_email', (SELECT email FROM public.users u WHERE u.id = o.provider_user_id),
                'status', o.status, 'rank', o.rank, 'distance_km', o.distance_km,
                'offered_at', o.offered_at, 'expires_at', o.expires_at, 'reject_reason', o.reject_reason)
                ORDER BY o.offered_at DESC) FILTER (WHERE o.id IS NOT NULL), '[]') AS offers
         FROM public.lite_bookings b
         LEFT JOIN public.dispatch_offers o ON o.booking_id = b.id
        WHERE b.status = 'DISPATCHING'
        GROUP BY b.id
        ORDER BY b.dispatch_started_at DESC NULLS LAST
        LIMIT 50`,
    );
    const recent = await this.db.q(
      `SELECT b.id AS booking_id, b.status::text AS status, b.region_code, b.service, b.cpo_count,
              b.assigned_provider_user_id,
              (SELECT email FROM public.users u WHERE u.id = b.assigned_provider_user_id) AS provider_email,
              b.dispatch_started_at, b.dispatch_settled_at, b.updated_at
         FROM public.lite_bookings b
        WHERE b.dispatch_mode = 'auto' AND b.status IN ('CONFIRMED', 'NO_PROVIDER', 'AGENCY_NO_SHOW', 'LIVE', 'COMPLETED', 'CANCELLED')
        ORDER BY COALESCE(b.dispatch_settled_at, b.updated_at) DESC
        LIMIT 25`,
    );
    return {dispatching, recent};
  }

  /**
   * Dispatch Inspector — admin-only LIST of every auto-dispatch request with its
   * current state + a few rollups (accepting agency, #offers, #crew, escrow). Read-only;
   * reuses the same service-role connection as monitor() (bypasses FORCE-RLS). Admin-only,
   * so provider names/emails are fine — never exposed to offered agencies (LB1).
   */
  async listDispatchRequests(status?: string, limit = 50): Promise<DispatchRequestListRow[]> {
    return this.db.q<DispatchRequestListRow>(
      `SELECT
         b.id AS booking_id, b.status::text AS status, b.region_code, b.region_label, b.service,
         b.cpo_count, b.armed_required, b.dispatch_mode,
         b.dispatch_started_at, b.dispatch_settled_at, b.created_at, b.updated_at,
         b.assigned_provider_user_id,
         pa.display_name AS accepting_agency_name, pa.call_sign AS accepting_agency_call_sign,
         (SELECT count(*) FROM public.dispatch_offers o WHERE o.booking_id = b.id) AS offers_count,
         (SELECT count(*) FROM public.mission_crew mc
            JOIN public.missions m ON m.id = mc.mission_id WHERE m.booking_id = b.id) AS crew_count,
         eh.status::text AS escrow_status, eh.gross_credits AS escrow_gross_credits,
         ms.status::text AS mission_status, ms.short_code AS mission_short_code,
         GREATEST(
           b.updated_at,
           COALESCE(b.dispatch_settled_at, b.dispatch_started_at, b.created_at),
           COALESCE((SELECT max(GREATEST(o.offered_at, o.responded_at))
                       FROM public.dispatch_offers o WHERE o.booking_id = b.id), b.created_at)
         ) AS last_activity_at
       FROM public.lite_bookings b
       LEFT JOIN public.agents pa ON pa.user_id = b.assigned_provider_user_id
       LEFT JOIN public.escrow_holds eh ON eh.booking_id = b.id
       LEFT JOIN LATERAL (
         SELECT status, short_code FROM public.missions
          WHERE booking_id = b.id
          ORDER BY (status <> 'ABORTED') DESC, created_at DESC LIMIT 1
       ) ms ON TRUE
       WHERE ($1::text IS NULL OR b.status::text = $1)
         AND b.dispatch_mode = 'auto'
       ORDER BY last_activity_at DESC
       LIMIT $2`,
      [status ?? null, limit],
    );
  }

  /**
   * Dispatch Inspector — admin-only DETAIL of one request: booking + accepting agency,
   * the full offer cascade (rank order), escrow hold, mission + crew (lead first), and a
   * chronological timeline merged from six sources (FSM log, ops-audit, offers, escrow,
   * mission progression). Returns null when the booking does not exist (controller → 404).
   */
  async getDispatchRequestDetail(id: string): Promise<DispatchRequestDetail | null> {
    const booking = await this.db.qOne<DispatchRequestDetail['booking']>(
      `SELECT
         b.id AS booking_id, b.status::text AS status, b.dispatch_mode,
         b.region_code, b.region_label, b.service, b.cpo_count, b.armed_required,
         b.requirements, b.client_id, b.assigned_provider_user_id,
         b.pickup_address, b.pickup_time, b.duration_hours, b.total_eur, b.total_aed,
         b.dispatch_started_at, b.dispatch_settled_at, b.crew_deadline_at,
         b.arrival_deadline_at, b.created_at, b.updated_at,
         pa.display_name AS agency_name, pa.call_sign AS agency_call_sign, pa.rating AS agency_rating,
         (SELECT email FROM public.users u WHERE u.id = b.assigned_provider_user_id) AS agency_email
       FROM public.lite_bookings b
       LEFT JOIN public.agents pa ON pa.user_id = b.assigned_provider_user_id
       WHERE b.id = $1`,
      [id],
    );
    if (!booking) {
      return null;
    }

    const offers = await this.db.q<DispatchRequestOffer>(
      `SELECT o.id AS offer_id, o.provider_user_id, o.rank, o.status::text AS status,
              o.distance_km, o.offered_at, o.expires_at, o.responded_at, o.reject_reason,
              a.display_name AS agency_name, a.call_sign AS agency_call_sign,
              a.rating AS agency_rating, a.region_code AS agency_region,
              (SELECT email FROM public.users u WHERE u.id = o.provider_user_id) AS agency_email
         FROM public.dispatch_offers o
         LEFT JOIN public.agents a ON a.user_id = o.provider_user_id
        WHERE o.booking_id = $1
        ORDER BY o.rank ASC, o.offered_at ASC`,
      [id],
    );

    const escrow = await this.db.qOne<DispatchRequestEscrow>(
      `SELECT id AS escrow_id, status::text AS status, gross_credits, currency,
              to_provider_credits, to_client_credits, platform_fee_credits, basis,
              review_required, held_at, completed_at, release_eligible_at, settled_at, offer_id
         FROM public.escrow_holds WHERE booking_id = $1`,
      [id],
    );

    const mission = await this.db.qOne<DispatchRequestMission>(
      `SELECT id AS mission_id, status::text AS status, short_code,
              started_at, created_at, pickup_at, live_at, ended_at, end_reason, comms_channel_id
         FROM public.missions WHERE booking_id = $1`,
      [id],
    );

    const crew = mission
      ? await this.db.q<DispatchRequestCrew>(
          `SELECT mc.agent_id, mc.is_lead, mc.role, mc.call_sign, mc.slot, mc.team_idx, mc.armed, mc.status,
                  a.display_name AS agent_name, a.rating AS agent_rating
             FROM public.mission_crew mc
             LEFT JOIN public.agents a ON a.user_id = mc.agent_id
            WHERE mc.mission_id = $1
            ORDER BY mc.is_lead DESC, mc.slot ASC`,
          [mission.mission_id],
        )
      : [];

    const timeline = await this.db.q<DispatchTimelineEntry>(
      `WITH tl AS (
         SELECT created_at, 'status'::text AS source, to_status::text AS label,
                actor_role, NULL::text AS actor_call, metadata
           FROM public.lite_booking_audit WHERE booking_id = $1
         UNION ALL
         SELECT created_at, 'ops_audit', action, actor_role, actor_call, metadata
           FROM public.ops_audit WHERE subject_type = 'booking' AND subject_id = $1::text
         UNION ALL
         SELECT offered_at, 'offer_made',
                ('offer #' || rank || COALESCE(' · ' || distance_km::text || 'km', ''))::text,
                'SYSTEM', NULL,
                jsonb_build_object('offer_id', id, 'provider_user_id', provider_user_id,
                                   'rank', rank, 'distance_km', distance_km, 'status', status)
           FROM public.dispatch_offers WHERE booking_id = $1
         UNION ALL
         SELECT responded_at, 'offer_outcome', status::text, 'SYSTEM', NULL,
                jsonb_build_object('offer_id', id, 'reject_reason', reject_reason)
           FROM public.dispatch_offers WHERE booking_id = $1 AND responded_at IS NOT NULL
         UNION ALL
         SELECT held_at, 'escrow', 'HELD', 'SYSTEM', NULL,
                jsonb_build_object('gross_credits', gross_credits)
           FROM public.escrow_holds WHERE booking_id = $1
         UNION ALL
         SELECT completed_at, 'escrow',
                CASE WHEN review_required THEN 'REVIEW_REQUIRED' ELSE 'PENDING_RELEASE' END,
                'SYSTEM', NULL, '{}'::jsonb
           FROM public.escrow_holds WHERE booking_id = $1 AND completed_at IS NOT NULL
         UNION ALL
         SELECT settled_at, 'escrow', status::text, 'SYSTEM', NULL,
                jsonb_build_object('basis', basis, 'to_provider', to_provider_credits,
                                   'to_client', to_client_credits, 'fee', platform_fee_credits)
           FROM public.escrow_holds WHERE booking_id = $1 AND settled_at IS NOT NULL
         UNION ALL
         SELECT created_at, 'mission', 'CREW_ASSIGNED', 'SYSTEM', NULL,
                jsonb_build_object('short_code', short_code)
           FROM public.missions WHERE booking_id = $1
         UNION ALL
         SELECT pickup_at, 'mission', 'PICKUP', 'CPO', NULL, '{}'::jsonb
           FROM public.missions WHERE booking_id = $1 AND pickup_at IS NOT NULL
         UNION ALL
         SELECT live_at, 'mission', 'LIVE', 'CPO', NULL, '{}'::jsonb
           FROM public.missions WHERE booking_id = $1 AND live_at IS NOT NULL
         UNION ALL
         SELECT ended_at, 'mission', status::text, 'CPO', NULL,
                jsonb_build_object('end_reason', end_reason)
           FROM public.missions WHERE booking_id = $1 AND ended_at IS NOT NULL
       )
       SELECT created_at AS at, source, label, actor_role, actor_call, metadata
         FROM tl WHERE created_at IS NOT NULL
        ORDER BY at ASC`,
      [id],
    );

    return {booking, offers, escrow, mission, crew, timeline};
  }

  /** Offer the booking to the next-nearest eligible agency, or resolve to
   *  NO_PROVIDER when the pool is empty or MAX_OFFERS is reached.
   *
   *  Bounded cascade (not recursion): a pass repeats only on a per-provider
   *  unique collision, advancing to the next-ranked agency; a per-booking
   *  collision ends the call so a booking can never hold two live offers (LB8). */
  async offerNext(bookingId: string): Promise<void> {
    // INFRA-4 — honor the runtime kill switch: when auto-dispatch is killed mid-flight,
    // stop minting NEW offers (the booking stays DISPATCHING and the always-on
    // relist-timeout sweep refunds it). In-flight accepts/holds are untouched.
    if (this.killswitch && !(await this.killswitch.isAutoDispatchEnabled())) {
      this.log.log(`offerNext skipped — auto-dispatch killed (booking ${bookingId})`);
      return;
    }
    for (let attempt = 0; attempt < MAX_OFFER_ATTEMPTS; attempt++) {
      const b = await this.db.qOne<BookingCtx>(
        `SELECT status, region_code, cpo_count, pickup_lat, pickup_lng, requirements, armed_required
           FROM lite_bookings WHERE id = $1`,
        [bookingId],
      );
      // Booking already settled (accepted → CONFIRMED, or cancelled) — stop cascading.
      if (!b || b.status !== 'DISPATCHING') {
        return;
      }

      const countRow = await this.db.qOne<{n: string}>(
        // FRAUD-7 — count only real attempts toward MAX_OFFERS. CANCELLED (a blameless
        // sibling retired at accept) and SUPERSEDED (a withdraw / arrival-no-show that
        // wasn't this agency's fault) must NOT burn the budget, or a claim-then-withdraw
        // griefer could starve a client into NO_PROVIDER. MAX_OFFER_ATTEMPTS still caps
        // the loop.
        `SELECT count(*)::text AS n FROM dispatch_offers
          WHERE booking_id = $1 AND status NOT IN ('CANCELLED', 'SUPERSEDED')`,
        [bookingId],
      );
      const offerCount = Number(countRow?.n ?? '0');
      if (offerCount >= MAX_OFFERS) {
        await this.noProvider(bookingId);
        return;
      }

      const requirements = {...(b.requirements ?? {}), armed: b.armed_required};
      const rankStart = Date.now();
      const candidate = await this.db.qOne<{user_id: string; distance_km: string}>(
        RANKING_SQL,
        [
          b.pickup_lat, b.pickup_lng, b.region_code, JSON.stringify(requirements),
          EFFECTIVE_FRESH_MINUTES, DISPATCH_RADIUS_M, b.cpo_count, bookingId,
        ],
      );
      this.metrics?.observe('dispatch_rank_query_ms', Date.now() - rankStart, {region: b.region_code});
      if (!candidate) {
        await this.noProvider(bookingId);
        return;
      }

      const nextRank = offerCount + 1;
      let inserted: boolean;
      try {
        inserted = await this.db.withTransaction(async tx => {
          // Re-check the booking under its row lock before inserting. The ranking
          // read above is unlocked, so a concurrent accept (DISPATCHING→CONFIRMED)
          // or cancel could have settled the booking in the meantime. Taking the
          // same FOR UPDATE lock accept() holds serializes us behind its commit, so
          // we never strand a fresh OFFERED row behind a CONFIRMED/terminal booking.
          const bk = await tx.qOne<{status: string}>(
            `SELECT status FROM lite_bookings WHERE id = $1 FOR UPDATE`,
            [bookingId],
          );
          if (!bk || bk.status !== 'DISPATCHING') {
            return false;
          }
          await tx.q(
            `INSERT INTO dispatch_offers
               (booking_id, provider_user_id, rank, distance_km, status, offered_at, expires_at)
             VALUES ($1, $2, $3, $4, 'OFFERED', NOW(), NOW() + ($5 || ' seconds')::interval)`,
            [bookingId, candidate.user_id, nextRank, candidate.distance_km, OFFER_TTL_SECONDS],
          );
          // Step 23 — count the offer the agency received (denominator context for
          // reliability; acceptance_rate itself is over responded offers).
          await tx.q(
            `UPDATE agents SET offers_received = offers_received + 1 WHERE user_id = $1`,
            [candidate.user_id],
          );
          return true;
        });
      } catch (e) {
        if (isUniqueViolation(e)) {
          // dispatch_offers_one_live_per_booking: a concurrent cascade already
          // placed THIS booking's live offer — stop, never a second live offer.
          if (constraintIs(e, 'dispatch_offers_one_live_per_booking')) {
            return;
          }
          // dispatch_offers_one_live_per_provider: the candidate took a live offer
          // for another booking between our ranking read and this INSERT. The next
          // ranking excludes them, so advance to the next-nearest agency.
          continue;
        }
        throw e;
      }
      if (!inserted) {
        // Booking settled (accepted/cancelled) under the lock — stop cascading.
        return;
      }

      await this.audit.record({
        actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.offer',
        subject_type: 'booking', subject_id: bookingId,
        metadata: {rank: nextRank, distance_km: candidate.distance_km, provider_user_id: candidate.user_id},
      });
      // Best-effort wake — the agency app also polls GET /dispatch/offers/current.
      void this.push.dispatchOffer(candidate.user_id, bookingId).catch(() => undefined);
      return;
    }
    // Exhausted the per-provider retry budget without offering or settling — leave
    // the booking DISPATCHING for the Step 8 watchdog to re-drive. Rare: needs many
    // concurrent dispatches contending for the same agencies.
    this.log.warn(`offerNext retry budget exhausted for booking ${bookingId}`);
  }

  /** Provider declined: mark REJECTED then cascade. 404 unknown offer; 403
   *  (org_scope_violation) wrong tenant — checked before status, so a cross-tenant
   *  caller can't probe offer state; 409 on a non-OFFERED offer. */
  async reject(offerId: string, providerUserId: string, reason?: string): Promise<void> {
    const bookingId = await this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{booking_id: string; status: string; provider_user_id: string}>(
        `SELECT booking_id, status, provider_user_id FROM dispatch_offers WHERE id = $1 FOR UPDATE`,
        [offerId],
      );
      if (!cur) {
        throw new NotFoundException('offer_not_found');
      }
      // IDOR (LB7): inlined assertOrgScope — checked before status so a cross-tenant
      // caller cannot probe offer state.
      if (cur.provider_user_id !== providerUserId) {
        throw new ForbiddenException('org_scope_violation');
      }
      if (cur.status !== 'OFFERED') {
        throw new BadRequestException('offer_state_changed_concurrently');
      }
      const upd = await tx.q(
        `UPDATE dispatch_offers SET status = 'REJECTED', responded_at = NOW(), reject_reason = $3
          WHERE id = $1 AND status = 'OFFERED' AND provider_user_id = $2 RETURNING id`,
        [offerId, providerUserId, redactReason(reason)],
      );
      if (upd.length === 0) {
        throw new BadRequestException('offer_state_changed_concurrently');
      }
      // Step 23 — decline accounting (see DECLINE_ACCOUNTING_SQL). An explicit reject
      // counts against acceptance_rate and may arm the chronic-rejecter cooldown.
      await tx.q(DECLINE_ACCOUNTING_SQL, [providerUserId]);
      return cur.booking_id;
    });
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.reject',
      subject_type: 'booking', subject_id: bookingId, metadata: {offer_id: offerId},
    });
    await this.offerNext(bookingId);
  }

  /** Offer lapsed (called by the Step 8 watchdog): mark EXPIRED then cascade.
   *  No-op if it already moved on (raced with accept/reject). */
  async expire(offerId: string): Promise<void> {
    const bookingId = await this.db.withTransaction(async tx => {
      const upd = await tx.q<{booking_id: string; provider_user_id: string}>(
        `UPDATE dispatch_offers SET status = 'EXPIRED', responded_at = NOW()
          WHERE id = $1 AND status = 'OFFERED' RETURNING booking_id, provider_user_id`,
        [offerId],
      );
      const row = upd[0];
      if (!row) {return null;}
      // Step 23 — an ignored (timed-out) offer is a soft decline: it counts against
      // acceptance_rate too, so an agency can't dodge the cooldown by silently letting
      // offers expire instead of rejecting them. Same accounting as reject().
      await tx.q(DECLINE_ACCOUNTING_SQL, [row.provider_user_id]);
      return row.booking_id;
    });
    if (!bookingId) {
      return;
    }
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.expire',
      subject_type: 'booking', subject_id: bookingId, metadata: {offer_id: offerId},
    });
    await this.offerNext(bookingId);
  }

  /** Nobody available / MAX_OFFERS reached: DISPATCHING → NO_PROVIDER (terminal). */
  async noProvider(bookingId: string): Promise<void> {
    const settled = await this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{status: string; client_id: string; region_code: string | null}>(
        `SELECT status, client_id, region_code FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!cur || cur.status !== 'DISPATCHING') {
        return null; // already accepted/cancelled — no-op
      }
      this.fsm.assert(cur.status as BookingStatus, 'NO_PROVIDER', 'SYSTEM');
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'NO_PROVIDER', dispatch_settled_at = NOW()
          WHERE id = $1 AND status = 'DISPATCHING' RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        return null;
      }
      // R12 (JOB_PORTAL_MARKETPLACE_SPEC) — a RELISTED booking (arrival no-show /
      // agency withdraw) reaches NO_PROVIDER still carrying the HELD hold from its
      // first accept, so "money only moves at accept" doesn't hold for it. Refund
      // atomically with the terminal flip; idempotent no-op for the common
      // never-charged case (no hold / non-HELD).
      await this.wallet.refundEscrowHold(tx, bookingId, `No provider available · booking ${bookingId}`);
      return {clientId: cur.client_id, region: cur.region_code ?? 'unknown'};
    });
    if (!settled) {
      return;
    }
    // Step 26 — count once per booking that exhausts the cascade (the conditional flip
    // above makes this exactly-once).
    this.metrics?.inc('dispatch_no_provider_total', {region: settled.region});
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.no_provider',
      subject_type: 'booking', subject_id: bookingId,
    });
    await this.auditBooking(bookingId, 'DISPATCHING', 'NO_PROVIDER', null, 'SYSTEM', {reason: 'cascade_exhausted'});
    // Best-effort wake — the client app also polls GET /bookings/:id.
    void this.push.noProvider(settled.clientId, bookingId).catch(() => undefined);
    // TODO(LB13): NO_PROVIDER should later offer a safety fallback, not just "no one available".
  }

  /** Client cancels while searching: supersede the live offer + DISPATCHING → CANCELLED.
   *  A first-search booking is uncharged (money moves at accept), but a withdraw/no-show
   *  RELISTED booking is DISPATCHING **with a HELD hold** — refund it with the flip. */
  async cancel(bookingId: string): Promise<void> {
    const result = await this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{status: string}>(
        `SELECT status FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!cur || cur.status !== 'DISPATCHING') {
        return null;
      }
      this.fsm.assert(cur.status as BookingStatus, 'CANCELLED', 'CLIENT');
      const superseded = await tx.q<{provider_user_id: string}>(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED' RETURNING provider_user_id`,
        [bookingId],
      );
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'CANCELLED', dispatch_settled_at = NOW()
          WHERE id = $1 AND status = 'DISPATCHING' RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        return null;
      }
      // R12/D4 — idempotent no-op for the common uncharged case.
      await this.wallet.refundEscrowHold(tx, bookingId, `Refund · booking ${bookingId} cancelled while searching`);
      return superseded.map(r => r.provider_user_id);
    });
    if (!result) {
      return;
    }
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.cancel',
      subject_type: 'booking', subject_id: bookingId,
    });
    await this.auditBooking(bookingId, 'DISPATCHING', 'CANCELLED', null, 'CLIENT', {reason: 'client_cancel_while_searching'});
    // Best-effort: tell the agency that was holding the offer it's gone.
    for (const providerUserId of result) {
      void this.push.dispatchOffer(providerUserId, bookingId).catch(() => undefined);
    }
  }

  /** Step 19 — roll a just-created auto booking back to CANCELLED when its start() failed,
   *  covering BOTH a pre-commit DRAFT and a post-commit DISPATCHING orphan (start() commits
   *  the DRAFT→DISPATCHING flip before offerNext, so a late offerNext throw leaves it
   *  DISPATCHING). STATUS-GUARDED: if an agency ACCEPTED in the race window the booking is
   *  CONFIRMED (escrow HELD) and this NO-OPs — it must never clobber+refund a real accept.
   *  Supersedes any live offer; a RELISTED DISPATCHING row can carry a HELD hold, so the
   *  idempotent refund runs with the flip (no-op on the common uncharged path). */
  async abandonUnstarted(bookingId: string): Promise<boolean> {
    return this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{status: string}>(
        `SELECT status FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!cur || (cur.status !== 'DRAFT' && cur.status !== 'DISPATCHING')) {
        return false; // raced to CONFIRMED/terminal (or still OPS_APPROVED) — leave it for the normal flow.
      }
      this.fsm.assert(cur.status as BookingStatus, 'CANCELLED', 'SYSTEM');
      await tx.q(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED'`,
        [bookingId],
      );
      await tx.q(
        `UPDATE lite_bookings SET status = 'CANCELLED', dispatch_settled_at = NOW()
          WHERE id = $1 AND status IN ('DRAFT', 'DISPATCHING')`,
        [bookingId],
      );
      await this.wallet.refundEscrowHold(tx, bookingId, `Refund · booking ${bookingId} abandoned`);
      return true;
    });
  }

  /** Step 26 — SUPERVISOR override: cancel a stuck DISPATCHING booking. Race-safe
   *  conditional flip (0 rows ⇒ {cancelled:false} ⇒ the controller 409s). A first-search
   *  DISPATCHING booking is uncharged, but a withdraw/no-show RELISTED one carries a HELD
   *  hold — refund it with the flip (idempotent no-op otherwise). The controller writes
   *  the attributable `ops_audit` row with the admin actor. */
  async adminCancel(bookingId: string): Promise<{cancelled: boolean; superseded: string[]}> {
    const result = await this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{status: string}>(
        `SELECT status FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!cur || cur.status !== 'DISPATCHING') {
        return null;
      }
      this.fsm.assert(cur.status as BookingStatus, 'CANCELLED', 'SYSTEM');
      const superseded = await tx.q<{provider_user_id: string}>(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED' RETURNING provider_user_id`,
        [bookingId],
      );
      const upd = await tx.q(
        `UPDATE lite_bookings SET status = 'CANCELLED', dispatch_settled_at = NOW()
          WHERE id = $1 AND status = 'DISPATCHING' RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        return null;
      }
      await this.wallet.refundEscrowHold(tx, bookingId, `Refund · booking ${bookingId} cancelled by ops`);
      return superseded.map(r => r.provider_user_id);
    });
    if (!result) {
      return {cancelled: false, superseded: []};
    }
    for (const providerUserId of result) {
      void this.push.dispatchOffer(providerUserId, bookingId).catch(() => undefined);
    }
    return {cancelled: true, superseded: result};
  }

  /** Step 26 — SUPERVISOR override: bind a stuck booking to its current live offer by
   *  running the normal accept saga on the agency's behalf (charges escrow exactly like a
   *  real accept — exactly-once via the offer-win conditional UPDATE). 409 if no live offer. */
  async adminForceAssign(bookingId: string): Promise<{offer_id: string; provider_user_id: string; booking_id: string}> {
    const offer = await this.db.qOne<{id: string; provider_user_id: string}>(
      `SELECT id, provider_user_id FROM dispatch_offers
        WHERE booking_id = $1 AND status = 'OFFERED'
        ORDER BY offered_at DESC LIMIT 1`,
      [bookingId],
    );
    if (!offer) {
      throw new ConflictException('no_live_offer');
    }
    // Pass the OFFER'S provider_user_id (from the DB row, NOT user input) so accept()'s
    // IDOR check passes legitimately — the admin is invoking the normal accept saga on the
    // agency's behalf. Exactly-once + no double-charge is guaranteed by accept()'s offer-win
    // conditional UPDATE (a re-run finds status≠'OFFERED' → 'offer_not_available') backed by
    // the escrow `ON CONFLICT (booking_id) DO NOTHING` anchor; the IdempotencyInterceptor on
    // the endpoint is the outer belt.
    const res = await this.accept(offer.id, offer.provider_user_id);
    return {offer_id: offer.id, provider_user_id: offer.provider_user_id, booking_id: res.booking_id};
  }

  /** Provider accepts the offer: win the offer (race-safe), flip the booking
   *  DISPATCHING → CONFIRMED ("accepted, awaiting crew"), stamp the crew-assign
   *  deadline, and supersede any sibling live offer — all in ONE transaction so a
   *  double-tap / two-pod race resolves to exactly one winner (LB3/LB8).
   *
   *  Step 9 inserts the escrow debit (client → platform escrow) + the
   *  `escrow_holds` row INSIDE this same txn, between the booking-lock and the
   *  CONFIRMED flip, so the charge is all-or-nothing with the accept. The Ops Room
   *  opens at crew-assign (D7), where the mission row finally exists. */
  async accept(
    offerId: string,
    providerUserId: string,
  ): Promise<{offer_id: string; booking_id: string; status: 'CONFIRMED'}> {
    let result: {bookingId: string; clientId: string};
    try {
      // Why: a portal claim locks booking→offers while accept locks offer→booking; a
      // 40P01 victim here is safe to re-run once — the whole txn rolled back and every
      // guard re-evaluates against the winner's committed state (spec R1/R3).
      result = await this.retryOnDeadlock(() => this.acceptTxn(offerId, providerUserId));
    } catch (e) {
      // LM-B7 — accept-time charge failure (balance moved after the request-time
      // soft-check). Terminate the search + wake the client; the agency gets the
      // neutral `offer_not_available`.
      const chargeFail = e instanceof BadRequestException
        && ((e as Error).message === 'charge_failed_internal' || (e as Error).message === 'charge_failed_family');
      if (chargeFail) {
        const familyBlocked = (e as Error).message === 'charge_failed_family';
        void this.handleChargeFailure(offerId, familyBlocked).catch(() => undefined);
        throw new BadRequestException('offer_not_available');
      }
      throw e;
    }
    await this.audit.record({
      actor_id: providerUserId, actor_role: 'SYSTEM', action: 'dispatch.accept',
      subject_type: 'booking', subject_id: result.bookingId,
      metadata: {offer_id: offerId, provider_user_id: providerUserId},
    });
    // LM-V6 — booking-status audit row for the timeline.
    await this.auditBooking(result.bookingId, 'DISPATCHING', 'CONFIRMED', providerUserId, 'SYSTEM',
      {reason: 'offer_accepted', offer_id: offerId});
    // Best-effort wake — the client app also polls GET /bookings/:id.
    void this.push.providerAccepted(result.clientId, result.bookingId).catch(() => undefined);
    // Spec §33/§34 — the escrow hold just consumed family quota, so warn the
    // HOLDER if this member crossed 80/90/100%. After the commit (it reads the
    // post-bump total) and never able to fail the accept. A non-member client
    // resolves to no membership row and nothing is sent.
    // try/catch, not `.catch()`: the accept is committed, and a `.catch()` would
    // not stop a SYNCHRONOUS throw from an older/partial FamilyService double.
    try {
      await this.family?.notifyUsageThresholdForMember(result.clientId);
    } catch { /* a warning may never undo a confirmed booking */ }
    return {offer_id: offerId, booking_id: result.bookingId, status: 'CONFIRMED'};
  }

  private async acceptTxn(
    offerId: string,
    providerUserId: string,
  ): Promise<{bookingId: string; clientId: string}> {
    return this.db.withTransaction(async tx => {
      const cur = await tx.qOne<{booking_id: string; status: string; provider_user_id: string}>(
        `SELECT booking_id, status, provider_user_id FROM dispatch_offers WHERE id = $1 FOR UPDATE`,
        [offerId],
      );
      if (!cur) {
        throw new NotFoundException('offer_not_found');
      }
      // IDOR (LB7): only the agency the offer was made to may accept it (inlined
      // assertOrgScope — provider_user_id is only known after the lock read).
      if (cur.provider_user_id !== providerUserId) {
        throw new ForbiddenException('org_scope_violation');
      }
      // Race lock (LB3/LB8): win the offer only while it is still live + unexpired.
      // 0 rows ⇒ it was taken / expired between the read and here ⇒ the agency app
      // shows "this job was reassigned." Mirrors the per-status conditional UPDATE.
      const won = await tx.q(
        `UPDATE dispatch_offers SET status = 'ACCEPTED', responded_at = NOW()
          WHERE id = $1 AND status = 'OFFERED' AND expires_at > NOW() RETURNING id`,
        [offerId],
      );
      if (won.length === 0) {
        throw new BadRequestException('offer_not_available');
      }
      return this.settleWonOffer(tx, cur.booking_id, offerId, providerUserId);
    });
  }

  /** Shared tail of every accept-shaped transition — the ranked-offer accept AND the
   *  Job-Portal claim (JOB_PORTAL_MARKETPLACE_SPEC §2). Runs INSIDE the caller's txn,
   *  which must already hold the winning ACCEPTED offer row: accept accounting, the
   *  escrow charge/re-point, the SINGLE-WRITER `assigned_provider_user_id` +
   *  DISPATCHING→CONFIRMED flip, and the defensive sibling supersede. Do NOT add a
   *  second copy of any of these — this method is the one money/FSM path. */
  private async settleWonOffer(
    tx: Tx, bookingId: string, offerId: string, providerUserId: string,
  ): Promise<{bookingId: string; clientId: string}> {
      // Step 23 — accept accounting. Bump offers_accepted + recompute acceptance_rate
      // (a successful accept lifts the rate back above the cooldown floor over time).
      await tx.q(
        `UPDATE agents
            SET offers_accepted = offers_accepted + 1,
                acceptance_rate = ROUND((offers_accepted + 1)::numeric
                                  / NULLIF(offers_accepted + 1 + offers_rejected, 0), 3)
          WHERE user_id = $1`,
        [providerUserId],
      );
      const b = await tx.qOne<{status: string; client_id: string; payer_user_id: string | null; total_eur: string}>(
        `SELECT status, client_id, payer_user_id, total_eur FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!b || b.status !== 'DISPATCHING') {
        throw new BadRequestException('booking_not_dispatching');
      }
      this.fsm.assert('DISPATCHING', 'CONFIRMED', 'SYSTEM');
      // Escrow charge (§39.1, "charged ≠ paid"): debit the client into the platform
      // escrow account + record the HELD hold, all in THIS txn — BEFORE the CONFIRMED
      // flip. On insufficient_credits holdToEscrow throws, so the whole accept (incl.
      // the OFFERED→ACCEPTED win above) rolls back: offer stays OFFERED, no charge, no
      // hold. The conditional offer-win is the exactly-once guard, so this runs once.
      // total_eur is the EUR magnitude (despite the name); a 0-total booking is free.
      // MON-6 — convert to BC at the LIVE peg, mirroring the legacy payWithCredits path
      // (booking.service.ts). At the shipped peg (eur_per_bc = 1.0) this is identical to
      // the old raw `Math.round(total_eur)`; when the peg moves, the raw form would over/
      // under-charge escrow (and desync from the pre-flight affordability check). `|| 1.0`
      // guards a 0/NaN/missing peg (and the @Optional pricing being absent in unit specs).
      const eurPerBc = (await this.pricing?.config?.())?.eur_per_bc || 1.0;
      const credits = Math.round(Number(b.total_eur) / eurPerBc);
      if (credits > 0) {
        // Idempotency anchor: gate the charge on there being NO hold yet, so we can
        // never debit the client without recording the hold (charged credits can't be
        // orphaned in escrow). We hold the booking FOR UPDATE, so this read + the
        // INSERT can't race a sibling accept; this is belt-and-braces behind the
        // offer-win guard, which already makes a second accept impossible.
        const existing = await tx.qOne<{booking_id: string}>(
          `SELECT booking_id FROM escrow_holds WHERE booking_id = $1`,
          [bookingId],
        );
        if (!existing) {
          let currency: string;
          try {
            // LM-B7 — debit the PAYER resolved at request time (family holder or the
            // client themselves); refunds then symmetrically credit the same wallet.
            // actorUserId keeps the MEMBER on the ledger row for per-member spend;
            // familyRowId pins cap bookkeeping to the charge-time membership row.
            let familyRowId: string | null = null;
            if (b.payer_user_id && b.payer_user_id !== b.client_id) {
              // B-384 — re-resolve the family relationship AT CHARGE TIME. The
              // request-time soft-check could be days old (scheduled bookings):
              // a holder who since revoked the member, put them on hold, or
              // lowered their cap must NOT be debited — and a revoked member's
              // charge previously escaped spent_credits accounting entirely.
              // Same neutral failure path as insufficient credits: the search
              // ends, the client is woken, the agency sees only "passed".
              // MON-4 — lock the member row FOR UPDATE so two concurrent accepts for
              // different bookings of the SAME member serialize on the cap: the second
              // blocks here until the first commits its spent_credits bump below, then
              // reads the fresh total and correctly trips overCap. Locked BEFORE the
              // wallet balance (holdToEscrow) to keep a single family→wallet lock order.
              // Spec §21 — the holder's suspension is read in the SAME locked
              // statement, so a suspension landing between two separate reads
              // cannot be missed. `FOR UPDATE OF fm` is deliberate: it locks
              // only the membership row. A bare FOR UPDATE across the join
              // would also lock the holder's `users` row, taking a lock this
              // path has never held and putting it out of order against every
              // other path that touches that table.
              const fam = await tx.qOne<{
                id: string; held_until: Date | null;
                spend_limit_credits: number | null; spent_credits: number;
                holder_suspended_at: Date | null;
              }>(
                `SELECT fm.id, fm.held_until, fm.spend_limit_credits, fm.spent_credits,
                        h.suspended_at AS holder_suspended_at
                   FROM public.family_members fm
                   JOIN public.users h ON h.id = fm.holder_id
                  WHERE fm.member_id = $1 AND fm.holder_id = $2 AND fm.status = 'active'
                  FOR UPDATE OF fm`,
                [b.client_id, b.payer_user_id],
              );
              const onHold = !!fam?.held_until && new Date(fam.held_until).getTime() > Date.now();
              const rootSuspended = !!fam?.holder_suspended_at;
              const overCap = fam?.spend_limit_credits != null
                && Number(fam.spent_credits) + credits > Number(fam.spend_limit_credits);
              // (metric increments in the enclosing catch — same as insufficient.)
              // Distinct marker: this is a PERMISSION failure, not an empty
              // wallet. Telling the member to "top up" would send them round a
              // loop they cannot exit — and the holder who caused it hears
              // nothing at all. See handleChargeFailureForBooking.
              if (!fam || onHold || overCap || rootSuspended) {
                throw new BadRequestException('charge_failed_family');
              }
              familyRowId = fam.id;
            }
            ({currency} = await this.wallet.holdToEscrow(tx, {
              clientId: b.payer_user_id ?? b.client_id, bookingId, offerId, credits,
              actorUserId: b.client_id, familyRowId,
            }));
          } catch (e) {
            // Step 26 — count the charge failure (e.g. insufficient_credits). The metric
            // is in-memory so it survives the txn rollback this throw triggers.
            this.metrics?.inc('dispatch_charge_failure_total');
            // LM-B7 — never leak the client's balance state to the AGENCY. Re-thrown
            // as an internal marker; the outer catch terminates the search + wakes
            // the client, then surfaces the neutral `offer_not_available` (which the
            // agency UI already maps to the "passed" card).
            if ((e as Error).message?.includes('insufficient_credits')) {
              throw new BadRequestException('charge_failed_internal');
            }
            throw e;
          }
          await tx.q(
            `INSERT INTO escrow_holds
               (booking_id, offer_id, client_id, provider_user_id, gross_credits, currency, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'HELD')
             ON CONFLICT (booking_id) DO NOTHING`,
            [bookingId, offerId, b.client_id, providerUserId, credits, currency],
          );
          // Family cap bookkeeping — the escrow debit hit the OWNER's wallet;
          // bump the member's running spend so the request-time cap check sees
          // it (this path previously never did — caps only accumulated on the
          // legacy payWithCredits path). Same txn as the debit.
          if (b.payer_user_id && b.payer_user_id !== b.client_id) {
            await tx.q(
              `UPDATE public.family_members SET spent_credits = spent_credits + $3
                WHERE member_id = $1 AND holder_id = $2 AND status = 'active'`,
              [b.client_id, b.payer_user_id, credits],
            );
          }
        } else {
          // Step 16 re-dispatch: a HELD hold persisted from the prior (arrival
          // no-show) agency's accept. Re-point it to THIS winning agency so the
          // Step-11 release pays the firm that actually shows up — NOT the one that
          // no-showed. No new charge: the client was debited exactly once at the
          // first accept (the !existing branch is the idempotency anchor). A no-op
          // when the same agency re-accepts, and the status='HELD' guard makes it a
          // no-op once the hold has moved on (PENDING_RELEASE/RELEASED/REFUNDED).
          await tx.q(
            `UPDATE escrow_holds SET offer_id = $2, provider_user_id = $3
              WHERE booking_id = $1 AND status = 'HELD'`,
            [bookingId, offerId, providerUserId],
          );
        }
      }
      const upd = await tx.q(
        `UPDATE lite_bookings
            SET status = 'CONFIRMED', assigned_provider_user_id = $2,
                dispatch_settled_at = NOW(),
                crew_deadline_at = NOW() + ($3 || ' minutes')::interval
          WHERE id = $1 AND status = 'DISPATCHING' RETURNING id`,
        [bookingId, providerUserId, CREW_ASSIGN_SLA_MINUTES],
      );
      if (upd.length === 0) {
        throw new BadRequestException('booking_state_changed_concurrently');
      }
      // Defensive: retire any sibling live offer for this booking — as CANCELLED,
      // not SUPERSEDED. A raced sibling is an INNOCENT bystander (it never declined;
      // someone else simply won first), and both the R9 claim exclusion and the
      // RANKING_SQL exclusion treat REJECTED/EXPIRED/SUPERSEDED as "this agency saw
      // the booking out" — stamping SUPERSEDED here would permanently ban a blameless
      // agency from the booking's withdraw/no-show relist. CANCELLED retires the row
      // (it can't be accepted; both one-live partial indexes only cover OFFERED)
      // without poisoning future eligibility.
      await tx.q(
        `UPDATE dispatch_offers SET status = 'CANCELLED', responded_at = NOW()
          WHERE booking_id = $1 AND status = 'OFFERED' AND id <> $2`,
        [bookingId, offerId],
      );
      return {bookingId, clientId: b.client_id};
  }

  /** Re-run a dispatch txn once after a Postgres deadlock abort (40P01). The claim
   *  path locks booking→offers while accept locks offer→booking, so under contention
   *  PG may pick either as the victim; a single re-run re-evaluates every status
   *  guard against the winner's committed state and resolves to a clean 4xx. */
  private async retryOnDeadlock<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!isDeadlock(e)) {
        throw e;
      }
      this.log.warn('dispatch txn deadlock (40P01) — retrying once');
      return fn();
    }
  }

  /**
   * Job-Portal pull-claim (JOB_PORTAL_MARKETPLACE_SPEC §2) — first-come-first-served
   * accept of an open booking straight from the portal browse, without waiting for
   * the ranked cascade to offer it. Reuses settleWonOffer (the SAME escrow charge/
   * re-point + single-writer CONFIRMED flip as accept()), so money/FSM semantics are
   * identical; only the offer's provenance differs — a self-claimed rank-0 row born
   * ACCEPTED (never OFFERED), so the expiry sweep can never race it (spec R7).
   */
  async claimOpenBooking(
    bookingId: string,
    providerUserId: string,
  ): Promise<{offer_id: string; booking_id: string; status: 'CONFIRMED'}> {
    // INFRA-4 — the portal claim charges escrow (settleWonOffer), so it must honor the
    // runtime kill switch too. A killed engine refuses new claims; in-flight is untouched.
    if (this.killswitch && !(await this.killswitch.isAutoDispatchEnabled())) {
      throw new BadRequestException('auto_dispatch_disabled');
    }
    let result: {offerId: string; fromOpsApproved: boolean; bookingId: string; clientId: string};
    try {
      result = await this.retryOnDeadlock(() => this.claimTxn(bookingId, providerUserId));
    } catch (e) {
      // LM-B7 — same neutral charge-failure path as accept(): terminate the search +
      // wake the client to top up; the agency only ever learns the job is gone.
      const chargeFail2 = e instanceof BadRequestException
        && ((e as Error).message === 'charge_failed_internal' || (e as Error).message === 'charge_failed_family');
      if (chargeFail2) {
        void this.handleChargeFailureForBooking(bookingId, (e as Error).message === 'charge_failed_family')
          .catch(() => undefined);
        throw new BadRequestException('job_unavailable');
      }
      throw e;
    }
    await this.audit.record({
      actor_id: providerUserId, actor_role: 'SYSTEM', action: 'dispatch.claim',
      subject_type: 'booking', subject_id: bookingId,
      metadata: {offer_id: result.offerId, provider_user_id: providerUserId},
    });
    // LM-V6 — the claim can hop TWO statuses in one txn; the timeline gets both rows.
    if (result.fromOpsApproved) {
      await this.auditBooking(bookingId, 'OPS_APPROVED', 'DISPATCHING', providerUserId, 'SYSTEM',
        {reason: 'portal_claim_start', offer_id: result.offerId});
    }
    await this.auditBooking(bookingId, 'DISPATCHING', 'CONFIRMED', providerUserId, 'SYSTEM',
      {reason: 'portal_claim', offer_id: result.offerId});
    // Best-effort wake — the client app also polls GET /bookings/:id.
    void this.push.providerAccepted(result.clientId, bookingId).catch(() => undefined);
    return {offer_id: result.offerId, booking_id: bookingId, status: 'CONFIRMED'};
  }

  private async claimTxn(
    bookingId: string,
    providerUserId: string,
  ): Promise<{offerId: string; fromOpsApproved: boolean; bookingId: string; clientId: string}> {
    return this.db.withTransaction(async tx => {
      // Booking row lock FIRST — the claim's serialization point against sibling
      // claims, the ranked accept, client cancel, and ops actions (spec R1/R2/R3).
      const b = await tx.qOne<{
        status: string; client_id: string; region_code: string; cpo_count: number;
        requirements: Record<string, unknown> | null; armed_required: boolean;
        dispatch_mode: string | null;
      }>(
        `SELECT status, client_id, region_code, cpo_count, requirements, armed_required, dispatch_mode
           FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!b) {
        throw new NotFoundException('job_not_found');
      }
      // Consent stop-condition: only an AUTO booking may be claimed — its client
      // consented at request time to charge-on-accept (LM-B7 payer + affordability
      // ran at submit). A LEGACY booking's client pays via an explicit
      // PAYMENT_PENDING step; debiting them from a claim would be an un-consented
      // charge, so those rows stay browse-only in the portal.
      if (b.dispatch_mode !== 'auto') {
        throw new ConflictException('job_not_claimable');
      }
      if (b.status === 'PENDING_OPS') {
        throw new ConflictException('job_not_approved');
      }
      if (b.status !== 'OPS_APPROVED' && b.status !== 'DISPATCHING') {
        // Post-accept / terminal — from the portal's perspective the job is gone.
        throw new ConflictException('job_taken');
      }
      // Eligibility — the same vetting the ranked cascade applies (minus proximity/
      // on-duty, which a pull-claim deliberately doesn't require): active company,
      // not benched, region licence+insurance+armed capability, free CPO seats.
      const agent = await tx.qOne<{type: string; status: string; cooldown_until: Date | null}>(
        'SELECT type, status, cooldown_until FROM public.agents WHERE user_id = $1',
        [providerUserId],
      );
      if (!agent || agent.type !== 'company') {
        throw new ForbiddenException('provider_only');
      }
      if (agent.status !== 'ACTIVE') {
        throw new ForbiddenException('agent_not_approved');
      }
      if (agent.cooldown_until && new Date(agent.cooldown_until).getTime() > Date.now()) {
        throw new ConflictException('provider_on_cooldown');
      }
      // Why: the staging DISPATCH_DISABLE_REGION_FILTER flag drops the region-scoped
      // credential gate here exactly as it does in RANKING_SQL — the licence/insurance/
      // armed checks are all per-region, so keeping them would re-block a cross-region
      // test provider (prod refuses the flag at boot).
      if (!DISABLE_REGION_FILTER) {
        const requirements = {...(b.requirements ?? {}), armed: b.armed_required};
        const el = await tx.qOne<{ok: boolean}>(
          'SELECT public.is_eligible_for_dispatch($1, $2, $3::jsonb) AS ok',
          [providerUserId, b.region_code, JSON.stringify(requirements)],
        );
        if (!el?.ok) {
          throw new ForbiddenException('provider_not_eligible');
        }
      }
      const cap = await tx.qOne<{ok: boolean}>(
        'SELECT public.has_free_cpo_capacity($1, $2) AS ok',
        [providerUserId, b.cpo_count],
      );
      if (!cap?.ok) {
        throw new ConflictException('no_free_cpo_capacity');
      }
      // R9 — an agency that already saw this booking out (rejected / let expire /
      // superseded, incl. its own withdraw) can't claim it back.
      const seen = await tx.qOne<{x: number}>(
        `SELECT 1 AS x FROM dispatch_offers
          WHERE booking_id = $1 AND provider_user_id = $2
            AND status IN ('REJECTED','EXPIRED','SUPERSEDED')
          LIMIT 1`,
        [bookingId, providerUserId],
      );
      if (seen) {
        throw new ConflictException('provider_excluded');
      }
      const fromOpsApproved = b.status === 'OPS_APPROVED';
      if (fromOpsApproved) {
        // An approved auto booking the engine hasn't started yet (flag off / frame
        // lost) — the claim starts the search and settles it in one txn.
        this.fsm.assert('OPS_APPROVED', 'DISPATCHING', 'SYSTEM');
        const flipped = await tx.q(
          `UPDATE lite_bookings
              SET status = 'DISPATCHING', dispatch_started_at = NOW()
            WHERE id = $1 AND status = 'OPS_APPROVED' RETURNING id`,
          [bookingId],
        );
        if (flipped.length === 0) {
          throw new ConflictException('job_taken'); // unreachable under the lock; never flip blind
        }
      }
      // Win-or-mint the claim offer. If the cascade already offered THIS agency the
      // job, winning that row keeps its rank/distance provenance; otherwise mint a
      // rank-0 row born ACCEPTED — never OFFERED — so the 8s expiry sweep and the
      // one-live-per-booking/provider partial indexes (both WHERE status='OFFERED')
      // can never race or block it (spec R7).
      const won = await tx.q<{id: string}>(
        `UPDATE dispatch_offers SET status = 'ACCEPTED', responded_at = NOW()
          WHERE booking_id = $1 AND provider_user_id = $2 AND status = 'OFFERED'
          RETURNING id`,
        [bookingId, providerUserId],
      );
      let offerId = won[0]?.id;
      if (!offerId) {
        const minted = await tx.qOne<{id: string}>(
          `INSERT INTO dispatch_offers
             (booking_id, provider_user_id, rank, status, offered_at, expires_at, responded_at)
           VALUES ($1, $2, 0, 'ACCEPTED', NOW(), NOW(), NOW())
           RETURNING id`,
          [bookingId, providerUserId],
        );
        if (!minted) {
          throw new BadRequestException('claim_failed');
        }
        offerId = minted.id;
      }
      const settled = await this.settleWonOffer(tx, bookingId, offerId, providerUserId);
      return {offerId, fromOpsApproved, ...settled};
    });
  }

  /**
   * Agency withdraw (JOB_PORTAL_MARKETPLACE_SPEC §3) — the accepting agency releases
   * an accepted-but-not-yet-crewed booking back to the portal. Mirrors the arrival-
   * no-show reDispatch relist (the existing CONFIRMED → DISPATCHING SYSTEM edge):
   * provider cleared, this agency's ACCEPTED offer SUPERSEDED (the ranking AND the
   * claim exclusion both stop it seeing this booking again), reliability breach
   * counted, and the escrow hold DELIBERATELY left HELD — the client is never
   * re-charged; the next claim/accept re-points the hold (settleWonOffer's Step-16
   * branch). Phase 1 scope: pre-crew only — with a live (non-ABORTED) mission it
   * 409s; crew-edit / ops abort remain the post-crew exits. No offerNext re-entry:
   * the portal itself is the re-offer surface (a fresh OFFERED row minted while the
   * expiry sweep is dark would bench the agency forever — the LM-B2 class).
   */
  async withdrawBooking(
    bookingId: string,
    orgUserId: string,
    reason?: string,
  ): Promise<{booking_id: string; status: 'DISPATCHING'}> {
    const result = await this.db.withTransaction(async tx => {
      const b = await tx.qOne<{status: string; client_id: string; assigned_provider_user_id: string | null}>(
        `SELECT status, client_id, assigned_provider_user_id
           FROM lite_bookings WHERE id = $1 FOR UPDATE`,
        [bookingId],
      );
      if (!b) {
        throw new NotFoundException('booking_not_found');
      }
      // IDOR (LB7 pattern) — scope before status, so a non-owner can't probe state.
      if (b.assigned_provider_user_id !== orgUserId) {
        throw new ForbiddenException('org_scope_violation');
      }
      if (b.status !== 'CONFIRMED') {
        throw new ConflictException('booking_not_withdrawable');
      }
      // Booking→mission lock order — same as reDispatch / client cancel (spec R5).
      const mission = await tx.qOne<{id: string}>(
        `SELECT id FROM missions WHERE booking_id = $1 AND status <> 'ABORTED'
          LIMIT 1 FOR UPDATE`,
        [bookingId],
      );
      if (mission) {
        throw new ConflictException('crew_already_assigned');
      }
      this.fsm.assert('CONFIRMED', 'DISPATCHING', 'SYSTEM');
      const upd = await tx.q(
        `UPDATE lite_bookings
            SET status = 'DISPATCHING',
                assigned_provider_user_id = NULL,
                crew_deadline_at = NULL,
                arrival_deadline_at = NULL,
                dispatch_started_at = NOW()
          WHERE id = $1 AND status = 'CONFIRMED' RETURNING id`,
        [bookingId],
      );
      if (upd.length === 0) {
        throw new ConflictException('booking_state_changed_concurrently');
      }
      await tx.q(
        `UPDATE dispatch_offers SET status = 'SUPERSEDED', responded_at = NOW()
          WHERE booking_id = $1 AND provider_user_id = $2 AND status = 'ACCEPTED'`,
        [bookingId, orgUserId],
      );
      // Provider-fault accounting — a voluntary hand-back is a reliability breach,
      // same counter the arrival-no-show sweep bumps (serial withdrawers rank lower).
      await tx.q(
        'UPDATE agents SET reliability_breaches = reliability_breaches + 1 WHERE user_id = $1',
        [orgUserId],
      );
      // NB: the escrow hold is deliberately NOT touched — it stays HELD and is
      // carried to the next accepting agency (re-pointed in settleWonOffer).
      return {clientId: b.client_id};
    });
    await this.audit.record({
      actor_id: orgUserId, actor_role: 'SYSTEM', action: 'dispatch.withdraw',
      subject_type: 'booking', subject_id: bookingId,
      metadata: {provider_user_id: orgUserId, reason: redactReason(reason)},
    });
    await this.auditBooking(bookingId, 'CONFIRMED', 'DISPATCHING', orgUserId, 'SYSTEM',
      {reason: 'agency_withdraw'});
    // Best-effort wake — the client app also polls GET /bookings/:id.
    void this.push.bookingReDispatching(result.clientId, bookingId).catch(() => undefined);
    return {booking_id: bookingId, status: 'DISPATCHING'};
  }

  /** LM-B7 — accept-time charge failure: terminate the search (frees the client's
   *  active-booking slot), audit it, and wake the client to top up + retry. The
   *  agency never learns why — it only ever saw `offer_not_available`. */
  private async handleChargeFailure(offerId: string, familyBlocked = false): Promise<void> {
    const row = await this.db.qOne<{booking_id: string}>(
      'SELECT booking_id FROM dispatch_offers WHERE id = $1',
      [offerId],
    );
    if (!row) {return;}
    await this.handleChargeFailureForBooking(row.booking_id, familyBlocked);
  }

  /** Booking-keyed variant for the portal claim — its rolled-back txn leaves no
   *  offer row behind to look up, so the claim path keys the failure on the booking.
   *  abandonUnstarted's status-guarded flip only fires for a DISPATCHING booking; an
   *  OPS_APPROVED claim target stays claimable (the client is woken to top up, and
   *  the next claim retries the charge). */
  private async handleChargeFailureForBooking(bookingId: string, familyBlocked = false): Promise<void> {
    const row = await this.db.qOne<{client_id: string; payer_user_id: string | null}>(
      'SELECT client_id, payer_user_id FROM lite_bookings WHERE id = $1',
      [bookingId],
    );
    if (!row) {return;}
    const cancelled = await this.abandonUnstarted(bookingId);
    await this.audit.record({
      actor_id: null, actor_role: 'SYSTEM', action: 'dispatch.payment_failed',
      subject_type: 'booking', subject_id: bookingId,
    });
    // Only stamp the status-transition audit row when the flip really ran — an
    // OPS_APPROVED claim target stays OPS_APPROVED (abandonUnstarted no-ops).
    if (cancelled) {
      await this.auditBooking(bookingId, 'DISPATCHING', 'CANCELLED', null, 'SYSTEM',
        {reason: 'payment_failed'});
    }
    // B-384 review — a holder-permission block is NOT an empty wallet. The member
    // gets copy they can act on, and the holder (who caused it) is told at all.
    if (familyBlocked) {
      void this.push.familyChargeBlocked(row.client_id, bookingId).catch(() => undefined);
      if (row.payer_user_id && row.payer_user_id !== row.client_id) {
        void this.push.familyChargeBlocked(row.payer_user_id, bookingId).catch(() => undefined);
      }
    } else {
      void this.push.paymentFailed(row.client_id, bookingId).catch(() => undefined);
    }
  }

  /** LM-V6 — booking-status audit rows for engine transitions (start / accept /
   *  no-provider / cancel / payment-failed), so the client-facing timeline is not
   *  blind to SYSTEM hops. Best-effort; a failed insert is logged, never thrown. */
  private async auditBooking(
    bookingId: string, from: string | null, to: string,
    actorId: string | null, actorRole: string, metadata: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await this.db.q(
        `INSERT INTO lite_booking_audit (booking_id, from_status, to_status, actor_id, actor_role, metadata)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [bookingId, from, to, actorId, actorRole, JSON.stringify(metadata)],
      );
    } catch (e) {
      this.log.warn(`[audit-gap] booking=${bookingId} ${from ?? '∅'}→${to}: ${(e as Error).message}`);
    }
  }

  /** Coarse, pre-accept view of the caller-org's single live offer, or null (LB1).
   *  Returns ONLY the relative distance band + region/time/price/headcount/
   *  requirements — never an absolute pickup/dropoff coord, address, or client id. */
  async getCurrentOfferForOrg(orgUserId: string): Promise<CoarseOfferDto | null> {
    const row = await this.db.qOne<{
      offer_id: string; expires_at: Date; distance_km: string | null;
      region_code: string; region_label: string; service: string; pickup_time: Date;
      duration_hours: number; cpo_count: number; vehicle_count: number;
      driver_only: boolean; armed_required: boolean; add_ons: string[];
      requirements: Record<string, unknown> | null; total_eur: string; total_aed: string;
      task_type: string | null; has_transport: boolean;
    }>(
      `SELECT o.id AS offer_id, o.expires_at, o.distance_km,
              b.region_code, b.region_label, b.service, b.pickup_time, b.duration_hours,
              b.cpo_count, b.vehicle_count, b.driver_only, b.armed_required,
              b.add_ons, b.requirements, b.total_eur, b.total_aed,
              b.task_type, (b.exec_transport IS NOT NULL) AS has_transport
         FROM dispatch_offers o
         JOIN lite_bookings b ON b.id = o.booking_id
        WHERE o.provider_user_id = $1 AND o.status = 'OFFERED'
        ORDER BY o.offered_at DESC
        LIMIT 1`,
      [orgUserId],
    );
    if (!row) {
      return null;
    }
    return {
      offer_id: row.offer_id,
      expires_at: toIso(row.expires_at),
      region_code: row.region_code,
      region_label: row.region_label,
      service: row.service,
      pickup_time: toIso(row.pickup_time),
      duration_hours: row.duration_hours,
      distance_bucket: distanceBucket(row.distance_km),
      cpo_count: row.cpo_count,
      vehicle_count: row.vehicle_count,
      price: {eur: row.total_eur, aed: row.total_aed},
      requirements: {
        armed: row.armed_required,
        driver_only: row.driver_only,
        add_ons: row.add_ons ?? [],
        flags: pickBooleanFlags(row.requirements),
      },
      // Executive Protection — the agency needs the task + transfer-leg presence to judge
      // a protection block; still no location/identity pre-accept.
      task_type: row.task_type,
      has_transport: row.has_transport,
    };
  }

  /** Precise offer view — ONLY when the offer is ACCEPTED and the caller's org
   *  owns it. 404 if unknown; 403 (org_scope_violation) for a non-owner — checked
   *  BEFORE status so a non-owner can never learn the offer's STATE; 403
   *  (offer_not_accepted) for the owner before accept. The controller audits every
   *  successful read (dispatch.full_read, fail-closed).
   *
   *  Note: the 404-before-403 order (per runbook) means a non-owner can still tell
   *  an offer EXISTS (403) from a non-existent id (404) — acceptable because offer
   *  ids are unguessable UUIDs (ParseUUIDPipe-gated), so enumeration is infeasible. */
  async getFullOffer(orgUserId: string, offerId: string): Promise<FullOfferDto> {
    const o = await this.db.qOne<{status: string; provider_user_id: string; booking_id: string}>(
      `SELECT status, provider_user_id, booking_id FROM dispatch_offers WHERE id = $1`,
      [offerId],
    );
    if (!o) {
      throw new NotFoundException('offer_not_found');
    }
    // Why: equivalent to assertOrgScope(req.orgManager, provider_user_id) — inlined
    // because provider_user_id is only known after this fetch; same 403 + error code.
    if (o.provider_user_id !== orgUserId) {
      throw new ForbiddenException('org_scope_violation');
    }
    if (o.status !== 'ACCEPTED') {
      throw new ForbiddenException('offer_not_accepted');
    }
    const b = await this.db.qOne<{
      region_code: string; region_label: string; service: string; pickup_time: Date;
      duration_hours: number; cpo_count: number;
      pickup_lat: string | null; pickup_lng: string | null; pickup_address: string;
      dropoff_lat: string | null; dropoff_lng: string | null; dropoff_address: string | null;
      task_type: string | null;
      exec_transport: FullOfferDto['exec_transport'];
    }>(
      `SELECT region_code, region_label, service, pickup_time, duration_hours, cpo_count,
              pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
              task_type, exec_transport
         FROM lite_bookings WHERE id = $1`,
      [o.booking_id],
    );
    if (!b) {
      throw new NotFoundException('booking_not_found');
    }
    return {
      booking_id: o.booking_id,
      region_code: b.region_code,
      region_label: b.region_label,
      service: b.service,
      pickup_time: toIso(b.pickup_time),
      duration_hours: b.duration_hours,
      cpo_count: b.cpo_count,
      pickup_lat: b.pickup_lat,
      pickup_lng: b.pickup_lng,
      pickup_address: b.pickup_address,
      dropoff_lat: b.dropoff_lat,
      dropoff_lng: b.dropoff_lng,
      dropoff_address: b.dropoff_address,
      task_type: b.task_type,
      exec_transport: b.exec_transport ?? null,
    };
  }
}
