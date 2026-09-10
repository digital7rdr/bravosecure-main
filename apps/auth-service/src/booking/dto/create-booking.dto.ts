import {IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Max, Min} from 'class-validator';

/** Legacy-compatible location payload. */
export class LocationDto {
  @IsNumber() latitude!: number;
  @IsNumber() longitude!: number;
  // E-12 — addresses are third-party geocoder strings of unpredictable length, so
  // they are TRUNCATED at persist time (booking.service), never rejected: a 400
  // here would block a paid booking over cosmetic payload size.
  @IsOptional() @IsString() address?: string;
  @IsOptional() @IsString() label?: string;
}

/**
 * Executive Protection — optional secure-transfer leg. Declared for typing; the nested
 * shape is validated MANUALLY in booking.service (repo pattern: the pipe does
 * not run nested validators — same as `pickup`).
 */
export class ExecTransportDto {
  mode!: 'one_way' | 'return' | 'both_ways';
  pickup!: LocationDto;
  dropoff!: LocationDto;
  /** ISO time of the transfer pickup; omitted = same as the booking start. */
  pickup_time?: string;
  passengers?: number;
}

/** POST /bookings — create a new Lite booking (DRAFT → PENDING_OPS in one call). */
export class CreateBookingDto {
  @IsIn(['transfer', 'timeslot', 'itinerary'])
  type!: 'transfer' | 'timeslot' | 'itinerary';

  @IsNotEmpty() pickup!: LocationDto;

  @IsOptional() dropoff?: LocationDto;

  @IsString() @IsNotEmpty()
  start_time!: string;

  @IsOptional() @IsInt() @Min(1) @Max(24)
  duration_hours?: number;

  @IsArray() @IsString({each: true})
  add_ons!: string[];

  @IsIn(['card', 'bravo_credits', 'corporate'])
  payment_method!: 'card' | 'bravo_credits' | 'corporate';

  @IsString() @IsNotEmpty()
  region!: string;

  // E-12 — the exec wizard caps at 500; the server previously accepted unbounded
  // bytes (payload bloat + unbounded CPO-brief render). 2000 leaves legacy room.
  @IsOptional() @IsString() @MaxLength(2000)
  notes?: string;

  /**
   * Issue 28 — optional preferred-provider / partner / referral code.
   * ATTRIBUTION ONLY: it is validated and recorded, and is never read by the
   * dispatch ranker, the offer cascade or escrow. Charset is constrained so a
   * code can never carry anything but an identifier.
   */
  @IsOptional() @IsString() @MaxLength(32)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9-]*$/, {message: 'referral_code_invalid_format'})
  referral_code?: string;

  // ─── Lite wizard extras (new flow) ───────────────────────────────
  @IsOptional() @IsString() @MaxLength(120)
  region_label?: string;

  @IsOptional() @IsIn(['secure_transfer', 'executive_protection', 'recon_team', 'emergency_extraction'])
  service?: string;

  @IsOptional() @IsIn(['now', 'later'])
  booking_mode?: 'now' | 'later';

  // ─── Executive Protection (service 'executive_protection') ────────────────
  /** What the protection detail is for; validated against the executive task
   *  list in booking.service when service === 'executive_protection'. */
  @IsOptional() @IsString() @MaxLength(40)
  task_type?: string;

  /** Optional secure-transfer leg — shape validated in booking.service. */
  @IsOptional()
  exec_transport?: ExecTransportDto;

  @IsOptional() @IsInt() @Min(1) @Max(16)
  passengers?: number;

  @IsOptional() @IsInt() @Min(1) @Max(4)
  cpo_count?: number;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  vehicle_count?: number;

  @IsOptional() @IsBoolean()
  driver_only?: boolean;

  // ─── Step 22 lawful-basis consent ────────────────────────────────
  // Auto-dispatch shares the client's precise pickup + live location with a
  // third-party agency, so the auto path (POST /dispatch/request) requires
  // explicit, versioned location + terms consent. Optional on the DTO so the
  // legacy ops-mediated path stays byte-for-byte unchanged; the server gates.
  @IsOptional() @IsBoolean()
  location_consent?: boolean;

  @IsOptional() @IsBoolean()
  terms_accepted?: boolean;

  @IsOptional() @IsString()
  location_consent_version?: string;

  @IsOptional() @IsString()
  terms_accepted_version?: string;
}

/** POST /bookings/estimate — price preview (no persistence). */
export class EstimateBookingDto {
  @IsIn(['transfer', 'timeslot', 'itinerary'])
  type!: 'transfer' | 'timeslot' | 'itinerary';

  /** 'executive_protection' switches the estimate to the per-unit fixed-block
   *  formula (and the fixed executive add-on catalogue). */
  @IsOptional() @IsIn(['secure_transfer', 'executive_protection', 'recon_team', 'emergency_extraction'])
  service?: string;

  @IsOptional() @IsInt() @Min(1) @Max(24)
  duration_hours?: number;

  @IsArray() @IsString({each: true})
  add_ons!: string[];

  @IsString() @IsNotEmpty()
  region!: string;

  @IsOptional() @IsInt() @Min(1) @Max(4)
  cpo_count?: number;

  @IsOptional() @IsInt() @Min(0) @Max(4)
  vehicle_count?: number;

  @IsOptional() @IsBoolean()
  driver_only?: boolean;

  /** Drives the driver-only seat cap so the preview clamps exactly like create(). */
  @IsOptional() @IsInt() @Min(1) @Max(16)
  passengers?: number;

  @IsOptional() @IsString()
  pickup_time?: string;
}
