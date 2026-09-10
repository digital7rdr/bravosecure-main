// ─── User & Auth ─────────────────────────────────────────────────────────────

// 'agent' = an individual officer (managed CPO) — solo missions home.
// 'service_provider' = an agency org — provider dashboard (roster, attendance).
// Both route to the partner AgentNavigator; the dashboard branches on agent.type.
export type UserRole = 'individual' | 'corporate' | 'agent' | 'service_provider' | 'ops';

/** Server-authoritative app experience chosen at login (§35A) — never a client flag. */
export type AccountKind = 'individual' | 'agency' | 'cpo';

export interface User {
  id: string;
  phone: string;
  /**
   * E.164-normalized phone from auth-service (`+<digits>`). Separate
   * from `phone` (which may be locally-formatted for display) so
   * contact discovery can look up matches without re-parsing.
   */
  phone_e164?: string;
  email?: string;
  full_name: string;
  avatar_url?: string;
  role: UserRole;
  subscription_tier?: PackageTier;
  /** ISO timestamp the current paid Pro period runs until (Pro tier only). */
  pro_active_until?: string | null;
  is_verified: boolean;
  kyc_status?: 'pending' | 'approved' | 'rejected';
  /** Server-computed app-routing discriminator from /auth/me (§35A). Optional —
   *  only present after an /auth/me fetch (login / refresh / focus). */
  account_kind?: AccountKind;
  /** True when the server authorizes this user as a manager of a provider org
   *  (company account OR an active org_members manager) — the same rule
   *  OrgManagerGuard enforces. Resolved independently of account_kind so a user
   *  who is a CPO of one org but a manager of another still gets manager UI.
   *  Optional — only present after an /auth/me fetch. */
  is_org_manager?: boolean;
  /** The org this account MANAGES as a delegated manager — null for the owner
   *  (who manages their own), for a plain CPO, and for an enterprise
   *  individual. This is the manager discriminator: `account_kind` cannot be,
   *  because a promoted CPO keeps account_kind='cpo'. */
  managed_org?: {id: string; name: string} | null;
  /** Owner-granted dashboard modules — null unless `managed_org` is set. For a
   *  manager it is the EXACT visible row set: empty array = no modules. */
  permitted_modules?: string[] | null;
  /** org_members.status for a CPO ('active'|'suspended'|'removed'); null otherwise. */
  membership_status?: string | null;
  // Populated only while membership_status === 'suspended' — the manager's
  // mandatory reason, surfaced on AccessEndedScreen.
  suspension?: {reason: string | null; until: string | null} | null;
  /** The agency a managed CPO (or agency manager) belongs to; null for individuals. */
  org?: {id: string; name: string} | null;
  /** True on a managed CPO's first login (agency-set temp password not yet changed).
   *  Forces the CPO account-activation flow before the CPO home (§35A §B). */
  must_set_password?: boolean;
  /** True for a managed CPO whose compliance pack isn't submitted/approved yet — routes
   *  them to the document-upload onboarding instead of the CPO home. */
  cpo_needs_onboarding?: boolean;
  /** Scope v2 Phase 6 — owns an Enterprise workspace (server-authoritative, from
   *  `org_workspaces`). Distinct from `account_kind === 'agency'` on purpose: a
   *  workspace owner is NOT a security-services provider, so gates that mean
   *  "is this user in an org?" must test this OR membership, never the kind. */
  owns_workspace?: boolean;
  /** Founder QA 2026-08-08 — the caller's ORG is an Enterprise WORKSPACE
   *  (tenant type: org_workspaces row exists), not a security agency. Drives
   *  vocabulary: workspace tenants say Member/Team, agencies keep CPO. */
  org_is_workspace?: boolean;
  /** Phase B (owner-join) — EVERY enterable workspace affiliation (own +
   *  membership), additive beside the single primary `org`. The Workspace
   *  Hub renders this list. Optional: an older server yields undefined and
   *  the hub falls back to the org/owns_workspace pair. */
  workspaces?: Array<{org_id: string; name: string; role: 'owner' | 'manager' | 'employee' | 'cpo'}>;
  /** B-417 — this user IS an ACTIVE agency company account (mirrors
   *  OrgManagerGuard Path 1). The direct owner fact for Ops Room key
   *  authority: `account_kind==='agency' && !org` rotted the moment Phase B
   *  let an owner join a workspace (org goes non-null). Optional: an older
   *  server yields undefined and the legacy predicate arm still admits the
   *  un-joined owner. */
  owns_agency?: boolean;
  /** Bug 1: server-driven auto-dispatch flag from /auth/me — the client books via the auto
   *  path (POST /dispatch/request) only when this is true. Replaces build-time EXPO_PUBLIC_AUTO_DISPATCH. */
  auto_dispatch_enabled?: boolean;
  created_at: string;
}

export interface AuthSession {
  access_token: string;
  refresh_token: string;
  user: User;
}

// ─── Booking ─────────────────────────────────────────────────────────────────

export type BookingType = 'transfer' | 'timeslot' | 'itinerary';

/**
 * Booking status — uppercase wire enum from auth-service `state-machine.service.ts`.
 *
 * Older mobile code compares against lowercase variants; those comparisons
 * are dead at runtime since the server only emits uppercase. Always
 * normalize with `.toUpperCase()` before comparing.
 */
export type BookingStatus =
  | 'DRAFT'
  // LM-U4 — the auto-dispatch statuses were missing from this union, so those
  // bookings type-checked as impossible and history rendered the UNKNOWN chip.
  | 'DISPATCHING'
  | 'PENDING_OPS'
  | 'OPS_APPROVED'
  | 'PAYMENT_PENDING'
  | 'CONFIRMED'
  | 'LIVE'
  | 'COMPLETED'
  | 'NO_PROVIDER'
  | 'AGENCY_NO_SHOW'
  | 'CANCELLED';

export type PackageTier = 'lite' | 'pro' | 'enterprise';
export type PaymentMethod = 'card' | 'bravo_credits' | 'corporate';

export interface Location {
  latitude: number;
  longitude: number;
  address?: string;
  label?: string;
}

/**
 * Wire shape of an add-on returned by GET /bookings/add-ons.
 * Auth-service ships `price_eur_per_hour` (string), NOT a flat `price` field.
 */
export interface BookingAddOn {
  id: string;
  label: string;
  description: string | null;
  price_eur_per_hour: string;
  requires_ops_approval: boolean;
}

/**
 * Booking — mirrors auth-service `ClientBooking` (booking.service.ts:75-97).
 *
 * Fields are EXACTLY what the wire returns. `add_ons` is `string[]` of IDs;
 * resolve labels via the `/bookings/add-ons` catalog if needed. `total_eur`
 * is the canonical chargeable amount in Bravo Credits (the BC and EUR rate
 * is 1:1 in Phase-1). `total_aed` is for display only.
 *
 * Legacy mobile code referenced `total_price`, `tier`, `vehicle_type`,
 * `payment_method`, `notes`, `end_time` — none of these are on the wire.
 * They're declared optional here so legacy reads compile and return
 * `undefined` (matching current runtime behaviour); new code should use
 * the wire-true fields.
 */
export interface Booking {
  id: string;
  client_id: string;
  status: BookingStatus;
  type: BookingType;
  region: string;
  region_label: string;
  service: string;
  pickup: Location;
  dropoff: Location | null;
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

  // Step 16 — present ONLY on a NO_PROVIDER booking; drives the NoDetail safety
  // fallback card (hotline / widen / escalate). Undefined on every other status.
  no_provider_fallback?: {
    hotline_e164: string;
    can_widen: boolean;
    can_escalate: boolean;
  } | null;

  // Assigned mission lifecycle (DISPATCHED/PICKUP/LIVE/COMPLETED/ABORTED), surfaced by
  // GET /bookings/:id so the client's live-tracking reflects real progress while the
  // booking itself stays CONFIRMED. Null/undefined when no mission exists yet.
  mission_status?: string | null;

  // Ops-gated auto dispatch — 'auto' when the booking runs the offer cascade
  // (escrow-charged at accept; the legacy auto-pay flow must never run on it).
  // Null/undefined on legacy admin-flow bookings.
  dispatch_mode?: string | null;

  // Executive Protection (service 'executive_protection') — what the detail is for + the optional
  // secure-transfer leg. Null/undefined on non-executive bookings.
  task_type?: string | null;
  exec_transport?: {
    mode: 'one_way' | 'return' | 'both_ways';
    pickup: Location;
    dropoff: Location;
    pickup_time: string | null;
    passengers: number;
  } | null;
  /** Executive Protection — hourly "all smooth" confirmations (GET /bookings/:id only). */
  hourly_checkins?: Array<{
    hour_index: number; status: string; comment: string | null; created_at: string;
  }>;

  // C-5 (2026-08-05) — payment_method / notes / booking_mode ARE now returned
  // by GET /bookings(/:id): TripSummary's Payment row and notes block render
  // real data. The remaining fields below are still legacy-only (undefined).
  payment_method?: PaymentMethod;
  notes?: string;
  booking_mode?: 'now' | 'later' | null;

  // Legacy-compatibility fields not returned by the server. Always
  // `undefined` at runtime. Kept so existing reads compile without
  // changing behaviour; prefer wire-true fields above for new code.
  tier?: PackageTier;
  vehicle_type?: 'standard' | 'armoured' | 'suv';
  total_price?: number;
  end_time?: string;
}

// ─── Messenger ───────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'file' | 'audio' | 'video' | 'system' | 'call';
// `undelivered` — the recipient's device destroyed the envelope (decrypt
// failure); set by the relay's `envelope.undeliverable`, never by a timeout.
export type MessageStatus = 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'undelivered';

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  type: MessageType;
  content: string;
  media_url?: string;
  media_mime?: string;
  self_destruct_at?: string;
  status: MessageStatus;
  is_encrypted: boolean;
  created_at: string;
}

export interface Conversation {
  id: string;
  type: 'direct' | 'group' | 'ops_channel';
  name?: string;
  avatar_url?: string;
  participants: string[];
  /**
   * B-247 — the FULL roster, never narrowed by crypto state.
   *
   * `participants` is deliberately collapsed to "peers I already hold a group
   * key for" by resolveRosterOverwrite, because that is what stops a removed
   * member being resurrected into media grants. Correct for grants; wrong for
   * RINGING, which is plain SFU signalling and needs no key — so a mission Ops
   * Room rang whoever had finished key exchange (usually just the client) and
   * silently skipped the CPOs and the agency manager.
   *
   * Written by whoever knows the true membership (ensureAssignedGroup, the
   * server roster sync) and read only by the ring fan-out. Optional: absent on
   * conversations that predate it, where the ring falls back as before.
   */
  rosterUserIds?: string[];
  last_message?: Message;
  unread_count: number;
  is_muted: boolean;
  created_at: string;
}

// ─── Agent ───────────────────────────────────────────────────────────────────
//
// Wire shape mirrors auth-service `AgentRow` (agent.service.ts:17-34).
// The previous `Agent` interface used lowercase status ('available' /
// 'busy' / 'offline') + invented fields (`full_name`, `regions`,
// `specializations`, `vehicle_types`, `kyc_verified`, `earnings_total`)
// that the server never returns. Mobile code that needs the live agent
// portal state uses `AgentPortalState` from `src/services/api.ts`.

export type AgentStatus =
  | 'DRAFT'
  | 'PROFILE_COMPLETE'
  | 'KYC_PENDING'
  | 'DOCS_PENDING'
  | 'SUBMITTED'
  | 'UNDER_REVIEW'
  | 'APPROVED'
  | 'ACTIVE'
  | 'REJECTED';

export interface Agent {
  user_id: string;
  type: 'cpo' | 'company';
  status: AgentStatus;
  tier: number;
  call_sign: string | null;
  display_name: string | null;
  rate_aed_per_hour: string | null;
  rating: string | null;
  jobs_total: number;
  duty_hours_mtd: number;
  on_duty: boolean;
}

// `JobRequest` deleted — the legacy /agent/jobs endpoint never existed
// on auth-service. Agent job flow uses `agentApi.getAvailableJobs()` +
// `applyToJob` / `withdrawApplication` whose response shapes live
// inline in `src/services/api.ts`.

// ─── Live Operations ──────────────────────────────────────────────────────────

export interface LiveConvoy {
  booking_id: string;
  vehicles: ConvoyVehicle[];
  sos_active: boolean;
  status: 'en_route' | 'on_site' | 'complete';
}

export interface ConvoyVehicle {
  id: string;
  label: string;
  driver_name: string;
  cpo_name: string;
  location: Location;
  heading: number;
  speed: number;
  last_updated: string;
}

// ─── News Feed ───────────────────────────────────────────────────────────────

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  source_logo?: string;
  url: string;
  image_url?: string;
  published_at: string;
  category: 'security' | 'geopolitical' | 'general' | 'ad';
  risk_level?: 'low' | 'medium' | 'high';
  region_tags: string[];
}

// ─── Wallet ──────────────────────────────────────────────────────────────────

export interface WalletBalance {
  bravo_credits: number;
  currency: string;
}

export interface CreditBatch {
  id: string;
  label: string;           // e.g. "Nov 2025"
  booking_id?: string;     // null for top-ups
  amount: number;          // credits in this batch
  aed_equivalent: number;  // 1:1 with AED
  issued_at: string;       // ISO date
  expires_at: string;      // ISO date
  source: 'booking' | 'topup';
}

export interface VaultStoragePlan {
  id: string;
  label: string;           // "500 MB", "1 GB" etc.
  increment_mb: number;
  eur_price: number;
  aed_price: number;
  is_popular?: boolean;
}

export interface Transaction {
  id: string;
  user_id: string;
  type: 'topup' | 'payment' | 'refund' | 'payout';
  amount: number;
  currency: string;
  description: string;
  booking_id?: string;
  created_at: string;
}

// ─── Itinerary / Pro ─────────────────────────────────────────────────────────

export interface ItineraryEvent {
  id: string;
  title: string;
  location: Location;
  start_time: string;
  end_time: string;
  risk_score: number;
  risk_reason?: string;
  security_recommended: boolean;
  booking_id?: string;
}

export interface TripItinerary {
  id: string;
  client_id: string;
  name: string;
  events: ItineraryEvent[];
  created_at: string;
  ai_parsed: boolean;
}
