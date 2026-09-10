import {IsOptional, IsString, MaxLength} from 'class-validator';

/**
 * COARSE pre-accept view of a dispatch offer (LB1 / Part III #3).
 *
 * Deliberately carries NO absolute pickup/dropoff coordinate, no address, and
 * no client identity — a rejecting (or merely offered) agency must never learn
 * where the protected principal will be. The agency decides accept/reject from
 * the RELATIVE distance bucket (how far the job is from THEM), the region, the
 * time window, the price, the headcount, and the capability requirements.
 *
 * Precise location is revealed only by GET /dispatch/offers/:id/full, and only
 * after the offer is ACCEPTED by the owning agency (see FullOfferDto).
 */
export interface CoarseOfferDto {
  offer_id: string;
  expires_at: string;       // ISO — bind the client countdown to this, not a local timer
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;      // ISO — WHEN, never WHERE
  duration_hours: number;
  distance_bucket: string;  // '<2km' | '2-5km' | '5-10km' | '>10km' | 'unknown' (relative to the agency)
  cpo_count: number;
  vehicle_count: number;
  price: {eur: string; aed: string};
  requirements: {
    armed: boolean;
    driver_only: boolean;
    add_ons: string[];
    flags: Record<string, boolean>;
  };
  /** Executive Protection — what the detail is for + whether a transfer leg exists. The
   *  agency can't judge acceptance of a protection block without them. Still
   *  NO location/identity pre-accept. Null on non-executive offers. */
  task_type?: string | null;
  has_transport?: boolean;
}

/**
 * PRECISE post-accept view — returned ONLY when the offer is ACCEPTED and the
 * caller's org owns it (DispatchService.getFullOffer enforces both; the
 * controller audits every successful read with the fail-closed
 * `dispatch.full_read` action). Carries NO client account UUID (Audit H5) — the
 * agency coordinates with the client through the SYSTEM-mediated Ops Room.
 */
export interface FullOfferDto {
  booking_id: string;
  region_code: string;
  region_label: string;
  service: string;
  pickup_time: string;
  duration_hours: number;
  cpo_count: number;
  pickup_lat: string | null;
  pickup_lng: string | null;
  pickup_address: string;
  dropoff_lat: string | null;
  dropoff_lng: string | null;
  dropoff_address: string | null;
  /** Executive Protection — task + the accepted agency's view of the transfer leg. */
  task_type?: string | null;
  exec_transport?: {
    mode: string;
    pickup: {address: string; latitude: number; longitude: number};
    dropoff: {address: string; latitude: number; longitude: number};
    pickup_time: string | null;
    passengers: number;
  } | null;
}

export class RejectOfferDto {
  // The service also redacts this (DispatchService.redactReason); this length +
  // type gate is defense in depth. A short reason/code, not free prose.
  @IsOptional() @IsString() @MaxLength(280) reason?: string;
}

export class WithdrawBookingDto {
  // Same redaction + gate as RejectOfferDto — a short reason/code, not free prose.
  @IsOptional() @IsString() @MaxLength(280) reason?: string;
}
