import {Injectable, Logger} from '@nestjs/common';
import * as crypto from 'node:crypto';
import {RedisService} from '../redis/redis.service';
import {NotificationsService} from '../notifications/notifications.service';

/**
 * Cross-service bridge for booking + agent push notifications.
 *
 * Publishes opaque event correlation IDs on the shared Redis `push:events`
 * channel; messenger-service's PushService subscribes and ships ONLY the
 * opaque `eventClass` + `eventId` over FCM data. The mobile client uses
 * the opaque ID to pull encrypted event details via the JWT-gated
 * `/events/by-id/:eventId` route over the regular sealed-relay channel.
 *
 * P0-N8 — DO NOT add `bookingId`, `missionId`, the literal `kind` value,
 * or any user-identifying field to the published payload. FCM data fields
 * are cleartext between this server and the device; Google operates the
 * intermediary. Per-user real-time SOS / mission feeds would be visible.
 *
 * The event details (bookingId, missionId, kind specifics) are stored
 * Redis-side keyed by the opaque eventId with a short TTL (5min) and
 * fetched via the encrypted relay. That way:
 *   - FCM sees: `{eventClass: 'sos', eventId: <opaque>, userId: <opaque>}`
 *   - Encrypted body delivered via sealed-sender envelope carries the rest.
 *
 * Same pattern as MissionEventsService — fire-and-forget, never throws,
 * a missed delivery falls back to the mobile client's in-app polling.
 */
@Injectable()
export class BookingPushBridge {
  private readonly log = new Logger(BookingPushBridge.name);
  static readonly CHANNEL = 'push:events';

  /** Per-event payload TTL — long enough for a Doze-thaw retry, short
   *  enough that a leaked eventId from a stale FCM log is useless.
   *  N-27 — raised 300→900 so it exceeds the messenger-service FCM data TTL
   *  (10 min). At 300 a wake delivered in the 5–10 min window (still inside
   *  FCM's own validity) deterministically hydrated to a 404 and rendered
   *  NOTHING; the blob must outlive the push it backs. Still bounded (15 min). */
  private static readonly EVENT_TTL_SECONDS = 900;

  constructor(
    private readonly redis: RedisService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Publish a wake event. `details` are stored separately under
   * `push-event:<eventId>` (TTL 5min) and resolved via the encrypted
   * relay by the mobile client. The pub/sub payload carries ONLY the
   * opaque IDs and the coarse class label.
   *
   * `eventClass` IS visible to FCM/APNs and is intentionally coarse —
   * one bit per category at most. The cleartext SOS feed leak the
   * audit flagged comes from per-instance bookingId/missionId; the
   * class label alone is operationally necessary so the client can
   * route the wake to the right module without unwrapping first.
   */
  private async publish(
    userId: string,
    eventClass: 'agent' | 'booking' | 'mission' | 'payout' | 'sos' | 'dispatch' | 'incident' | 'enterprise',
    details: Record<string, unknown>,
  ): Promise<void> {
    try {
      const eventId = crypto.randomBytes(16).toString('base64url');
      // A2 — RECIPIENT-BIND the detail blob: key by `push-event:<userId>:
      // <eventId>` so the `GET /events/by-id/:eventId` hydration route can only
      // resolve it for the authenticated recipient (req.user.sub). A leaked
      // opaque eventId is then useless to any other account, on top of the
      // 5-min TTL. The wire payload below stays {userId, eventClass, eventId}.
      await this.redis.client.set(
        `push-event:${userId}:${eventId}`,
        JSON.stringify(details),
        'EX', BookingPushBridge.EVENT_TTL_SECONDS,
      );
      await this.redis.client.publish(
        BookingPushBridge.CHANNEL,
        JSON.stringify({userId, eventClass, eventId}),
      );
    } catch (e) {
      this.log.warn(`push publish failed class=${eventClass}: ${(e as Error).message}`);
    }
    // N-20 — the DURABLE inbox row, AFTER the wake but OUTSIDE the Redis try:
    // wake latency first (an SOS fan-out must not queue behind N Postgres
    // inserts), durability second but unconditional — a caught Redis throw
    // falls through to this line, so an outage can no longer skip the one
    // event sink that exists precisely for when the transient lane fails
    // (dead token, Doze, reinstall, killed >TTL, Redis down). Backfilled from
    // GET /me/notifications; keeps the in-app bell in sync. Metadata-only.
    // `record` swallows its own errors; the extra .catch keeps this method's
    // never-throws contract independent of that implementation detail.
    await this.notifications.record(userId, {
      eventClass,
      kind:       typeof details.kind === 'string' ? details.kind : eventClass,
      bookingId:  typeof details.bookingId === 'string' ? details.bookingId : null,
      missionId:  typeof details.missionId === 'string' ? details.missionId : null,
      // vs2 item 16 — the ONE field that lets a bell row (or any delivery that
      // misses the 5-minute blob) open the incident instead of a list screen.
      incidentId: typeof details.incidentId === 'string' ? details.incidentId : null,
      // vs2 edge A1/A2 — WHICH organisation this event belongs to, so a
      // multi-org recipient's tap can point the workspace surface at it before
      // it reads. Threaded from the same `details.orgId` the Redis blob carries,
      // so the transient and durable lanes cannot disagree about the org.
      orgUserId: typeof details.orgId === 'string' ? details.orgId : null,
    }).catch(() => {});
  }

  // ─── Client-side push ─────────────────────────────────────────────

  async bookingApproved(userId: string, bookingId: string, status = 'OPS_APPROVED'): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'booking-approved', bookingId, status});
  }

  /** B-405 — T-60 reminder for a scheduled ('later') booking: the client booked
   *  days ahead and needs a heads-up an hour before the detail starts. */
  async bookingReminder(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-reminder', bookingId});
  }

  /** Auto-dispatch: wake an AGENCY that just received a job offer — render the
   *  incoming-offer card. The countdown still binds to the server `expires_at`. */
  async dispatchOffer(providerUserId: string, bookingId: string): Promise<void> {
    return this.publish(providerUserId, 'dispatch', {kind: 'dispatch-offer', bookingId});
  }

  /** Auto-dispatch: wake the CLIENT that an agency accepted their job. */
  async providerAccepted(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'provider-accepted', bookingId});
  }

  /** Auto-dispatch: wake the CLIENT that no agency was available (terminal). */
  async noProvider(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'no-provider', bookingId});
  }

  /** Auto-dispatch: wake the CLIENT that the accepting agency never crewed in time
   *  (crew-SLA breach). The escrow refund (Step 9) rides the same event. */
  async agencyNoShow(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'agency-no-show', bookingId});
  }

  /** Auto-dispatch (Step 16): wake the CLIENT that the assigned crew never arrived and
   *  the booking is being re-dispatched to another agency. The escrow hold is unchanged
   *  (the client is NOT re-charged) — this is a "reassigning your detail" reassurance. */
  async bookingReDispatching(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-redispatching', bookingId});
  }

  /** LM-B7 — wake the CLIENT that their booking was cancelled because the escrow
   *  charge failed at accept-time (balance moved after the request-time soft-check).
   *  The client tops up and re-requests; the agency never learns why. */
  async paymentFailed(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'payment-failed', bookingId});
  }

  // ─── LM-N4 — previously-silent lifecycle transitions ──────────────

  /** Ops rejected the booking (was card-only — a backgrounded client never knew). */
  async bookingRejected(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-rejected', bookingId});
  }

  /** The mission finished — wake the CLIENT to rate + view the receipt. */
  async bookingCompleted(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'booking-completed', bookingId});
  }

  /** The agency assigned a crew — wake the CLIENT ("your detail is being prepared"). */
  async crewAssigned(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'crew-assigned', bookingId});
  }

  /** LM-N4 — the lead started toward pickup (mission DISPATCHED→PICKUP). Wake the
   *  CLIENT ("your detail is en route") + deep-link into live tracking. The kind is
   *  `detail-*` (not `mission-*`) so it classifies as a CLIENT 'booking' event, not
   *  an agent 'mission' one (kindToActivityClass keys off the prefix). */
  async missionEnRoute(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'detail-enroute', bookingId});
  }

  /** LM-N4 — protection went live (mission PICKUP→LIVE). Wake the CLIENT
   *  ("protection is now active") + deep-link into live tracking. */
  async missionLive(clientUserId: string, bookingId: string): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'detail-live', bookingId});
  }

  /** Credits were returned to the CLIENT's wallet on a path they didn't initiate
   *  (ops abort / dispute outcome) — the wallet must never change silently. */
  async refundIssued(clientUserId: string, bookingId: string, credits: number): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'refund-issued', bookingId, credits});
  }

  /** Executive Protection — the lead confirmed an elapsed hour ("all smooth"). CLIENT copy
   *  ("Hour N confirmed — all smooth"); `detail-*` prefix = client booking class. */
  async hourlyCheckin(clientUserId: string, bookingId: string, hourIndex: number): Promise<void> {
    return this.publish(clientUserId, 'booking', {kind: 'detail-hour-checkin', bookingId, hourIndex});
  }

  /** Executive Protection — same hourly confirmation, AGENCY desk copy (mission class). */
  async hourlyCheckinAgency(
    providerUserId: string, bookingId: string, missionId: string, hourIndex: number,
  ): Promise<void> {
    return this.publish(providerUserId, 'mission', {kind: 'mission-hour-checkin', missionId, bookingId, hourIndex});
  }

  /** A dispute was opened on the booking — wake the AGENCY (its payout froze). */
  async disputeOpened(providerUserId: string, bookingId: string): Promise<void> {
    return this.publish(providerUserId, 'booking', {kind: 'dispute-opened', bookingId});
  }

  /** Ops resolved the dispute — wake a party with the outcome. */
  async disputeResolved(userId: string, bookingId: string, outcome: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'dispute-resolved', bookingId, outcome});
  }

  // ─── Agent-side push ──────────────────────────────────────────────

  /** Agent's KYC decision settled (ACTIVE or REJECTED). */
  async agentDecided(userId: string, decision: 'APPROVED' | 'REJECTED'): Promise<void> {
    // Quote-free ternary condition on purpose — serverWakeKindParity's
    // extractor cannot cross a quoted condition, and the inline comparison
    // left BOTH kinds invisible to the parity gate (found 2026-08-07).
    const approved = decision === 'APPROVED';
    return this.publish(userId, 'agent', {kind: approved ? 'agent-approved' : 'agent-rejected'});
  }

  /** Agent was picked for a dispatch — wake the device to render the mission card. */
  async missionDispatched(userId: string, missionId: string, bookingId: string): Promise<void> {
    return this.publish(userId, 'mission', {kind: 'mission-dispatched', missionId, bookingId});
  }

  /** Agent's mission was aborted by ops. */
  async missionAborted(userId: string, missionId: string, bookingId: string): Promise<void> {
    return this.publish(userId, 'mission', {kind: 'mission-aborted', missionId, bookingId});
  }

  /** B-378 — the CLIENT cancelled a booking this agency had ACCEPTED: wake it so the
   *  board updates now (crew slot freed, possible cancellation fee) instead of on poll.
   *  `missionId` is null when the cancel lands before any crew was assigned — that
   *  in-SLA window is exactly when the agency is still actively working the job. */
  async missionCancelledByClient(
    providerUserId: string, missionId: string | null, bookingId: string,
  ): Promise<void> {
    return this.publish(providerUserId, 'mission', {
      kind: 'mission-cancelled', bookingId,
      ...(missionId ? {missionId} : {}),
    });
  }

  /**
   * Issue 41 — the assigned officer answered. Wakes the AGENCY, because the
   * acceptance stage is only useful if the party who must act on a decline
   * hears about it: `declined_at` was being recorded where nobody was looking,
   * and the client's rail silently sat at "assigning team" with no one told to
   * re-crew.
   */
  async missionResponse(
    providerUserId: string, missionId: string, bookingId: string, accepted: boolean,
  ): Promise<void> {
    return this.publish(providerUserId, 'mission', {
      kind: accepted ? 'mission-accepted' : 'mission-declined',
      missionId, bookingId,
    });
  }

  /** LM-C7 — a crew member asked to close a mission (lead unreachable); wake the
   *  AGENCY manager to confirm from the missions board. */
  async missionCompleteRequested(providerUserId: string, missionId: string, bookingId: string): Promise<void> {
    return this.publish(providerUserId, 'mission', {kind: 'mission-complete-requested', missionId, bookingId});
  }

  /** Agent's wallet was credited on mission completion. */
  async payoutSettled(userId: string, bookingId: string, credits: number): Promise<void> {
    return this.publish(userId, 'payout', {kind: 'payout-settled', bookingId, credits});
  }

  /**
   * Fan-out for a CPO-raised SOS — wakes every other crew member on the
   * mission AND the principal so they see the alert even if no app
   * screen is mounted. The acker uses `OpsController.ackSos` to clear.
   *
   * P0-N8: previously published `{kind: 'sos-cpo-alert', missionId,
   * bookingId}` as the literal pub/sub payload — meaning FCM saw the
   * SOS class IN THE CLEAR per user in real time. Now publishes only
   * the opaque eventId + the coarse `eventClass: 'sos'`; the detail
   * blob lands behind the encrypted relay.
   */
  async sosAlert(userIds: readonly string[], missionId: string, bookingId: string): Promise<void> {
    for (const uid of userIds) {
      await this.publish(uid, 'sos', {kind: 'sos-cpo-alert', missionId, bookingId});
    }
  }

  // ─── Bravo Secure Pro applications ────────────────────────────────────
  //
  // Same metadata posture as every booking event: FCM sees only the opaque
  // eventId + coarse 'booking' class; the applicationId rides the Redis
  // detail blob behind the encrypted relay.

  /** Confirm receipt of a new Pro application ("we're preparing your proposal"). */
  async proApplicationReceived(userId: string, applicationId: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-application-received', applicationId});
  }

  /** The Bravo Control System published a (possibly revised) proposal. */
  async proProposalReady(userId: string, applicationId: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-proposal-ready', applicationId});
  }

  /** The application was declined (terminal). */
  async proApplicationRejected(userId: string, applicationId: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-application-rejected', applicationId});
  }

  /** Ops cancelled the application on the client's behalf (terminal). */
  async proApplicationCancelled(userId: string, applicationId: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-application-cancelled', applicationId});
  }

  /** Payment settled — the Pro plan is live (credits = full-period total). */
  async proPlanActivated(userId: string, applicationId: string, totalCredits: number): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-plan-activated', applicationId, credits: totalCredits});
  }

  /** Ops replied in the application thread (revision conversation). */
  async proOpsMessage(userId: string, applicationId: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-ops-message', applicationId});
  }

  /** An in-plan mission request was scheduled or declined by ops. */
  async proMissionUpdate(userId: string, applicationId: string, status: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'pro-mission-update', applicationId, status});
  }

  // ─── Protection sessions (spec §10) ───────────────────────────────────
  //
  // Ids-only detail blobs, same metadata posture as every other kind (the
  // sessionId rides the encrypted relay, not the FCM cleartext). Each method
  // publishes ONE literal `kind` so the serverWakeKindParity extractor sees it;
  // every kind has an enumerated branch in serverWakeNotifications + a tap route
  // in fcmBootstrap (the serverWakeTapRouting parity scan fails otherwise).

  /** Customer: their session went live (REQUESTED→ACTIVE). */
  async psessionStarted(customerUserId: string, sessionId: string): Promise<void> {
    return this.publish(customerUserId, 'booking', {kind: 'psession-started', sessionId});
  }

  /** Customer: their session was ended (by ops/timeout — a customer-ended one they already know). */
  async psessionEnded(customerUserId: string, sessionId: string): Promise<void> {
    return this.publish(customerUserId, 'booking', {kind: 'psession-ended', sessionId});
  }

  /** Customer: their dedicated officer changed (assignment create/cancel/transfer). */
  async proCpoChanged(customerUserId: string, applicationId: string): Promise<void> {
    return this.publish(customerUserId, 'booking', {kind: 'pro-cpo-changed', applicationId});
  }

  /** CPO: a session was created for one of their customers (the "automatic receive"). */
  async psessionNew(cpoUserId: string, sessionId: string): Promise<void> {
    return this.publish(cpoUserId, 'mission', {kind: 'psession-new', sessionId});
  }

  /** CPO: SOS raised on their session. */
  async psessionSos(cpoUserId: string, sessionId: string): Promise<void> {
    return this.publish(cpoUserId, 'sos', {kind: 'psession-sos', sessionId});
  }

  /** CPO: the customer went silent past the connection-lost threshold. */
  async psessionConnLost(cpoUserId: string, sessionId: string): Promise<void> {
    return this.publish(cpoUserId, 'mission', {kind: 'psession-conn-lost', sessionId});
  }

  // ─── Family (shared credits) ──────────────────────────────────────────
  //
  // R-3 — the invite lifecycle was pull-only: an invitee who never opened
  // Profile never learned they were invited, and the holder learned of an
  // acceptance only by reopening the members screen. Ids-only detail blobs,
  // same metadata posture as every other kind.

  /** Wake the INVITEE that a family invitation is waiting. */
  async familyInvite(inviteeUserId: string, inviteId: string): Promise<void> {
    return this.publish(inviteeUserId, 'booking', {kind: 'family-invite', inviteId});
  }

  /** Wake the HOLDER that their invite was accepted (member is now active). */
  async familyInviteAccepted(holderUserId: string, inviteId: string): Promise<void> {
    return this.publish(holderUserId, 'booking', {kind: 'family-invite-accepted', inviteId});
  }

  /** B-384 — a member's booking could not be charged because the HOLDER revoked
   *  them, put them on hold, or their spend cap is exhausted. Sent to BOTH: the
   *  member (so they stop retrying a top-up that cannot help) and the holder. */
  async familyChargeBlocked(userId: string, bookingId: string): Promise<void> {
    return this.publish(userId, 'booking', {kind: 'family-charge-blocked', bookingId});
  }

  // ─── Family spending-quota pushes ─────────────────────────────────────
  //
  // Metadata-only like every other kind: ids and enums cross the wire, never
  // the requested amount or the member's balance. The client hydrates the
  // numbers from the authenticated /family endpoints — which is also what keeps
  // a stale push from being an authority on money (spec §48).

  /** Wake the HOLDER that a member asked for more spending credit (spec §33). */
  async familyCreditRequested(holderUserId: string, requestId: string): Promise<void> {
    return this.publish(holderUserId, 'booking', {kind: 'family-credit-requested', requestId});
  }

  /**
   * Wake the MEMBER with the outcome of their request (spec §33).
   * `decision` separates a partial approval from a full one because the copy
   * differs — "Approved ৳2,000 of ৳5,000" is not "Approved".
   */
  async familyCreditDecided(
    memberUserId: string,
    requestId: string,
    decision: 'approved' | 'partially_approved' | 'rejected' | 'cancelled',
  ): Promise<void> {
    return this.publish(memberUserId, 'booking', {kind: 'family-credit-decided', requestId, decision});
  }

  /** Wake the MEMBER that the holder changed their spending limit (spec §33). */
  async familyQuotaChanged(memberUserId: string, familyRowId: string): Promise<void> {
    return this.publish(memberUserId, 'booking', {kind: 'family-quota-changed', familyRowId});
  }

  /**
   * Wake the HOLDER that a member crossed a usage band (spec §33/§34).
   * Crossing-based — the caller only calls this on an actual band change, so
   * this is not a per-transaction ding.
   */
  async familyQuotaThreshold(holderUserId: string, familyRowId: string, pct: 80 | 90 | 100): Promise<void> {
    return this.publish(holderUserId, 'booking', {kind: 'family-quota-threshold', familyRowId, pct});
  }

  // ─── Dept Chat v2 · incident push (Step 11) ───────────────────────────
  //
  // Metadata-only by construction: the FCM cleartext carries only the opaque
  // eventId + coarse 'incident' class. The ref/severity/status live in the
  // Redis detail blob fetched over the encrypted relay (P0-N8). The incident
  // description, coordinates, and photo are NEVER published.

  /**
   * Wake the org manager(s) that a new incident was filed.
   *
   * vs2 item 16 — the banner must name the organisation and the reporter and
   * open the incident on tap. `incidentId` routes; `orgName`/`reporterName`
   * are the two identifiers the client asked for by name. Still metadata-only:
   * the narrative, the coordinates and the photos never leave the record, and
   * `reporterName` is a display name the recipient can already see on the
   * roster. A missing/blank reporter name is OMITTED rather than sent empty,
   * so the client falls back to generic copy instead of "Reported by ."
   *
   * vs2 edge A1 — `orgId` rides along for the TAP, not the banner. A manager of
   * two organisations was shown the org's NAME and then read the incident with
   * their other org stamped on the request, so the deep link dead-ended on an
   * empty screen. Additive: an old app ignores the field.
   */
  async incidentSubmitted(
    managerUserIds: readonly string[],
    ref: string | null,
    severity: string,
    extra: {
      incidentId?: string | null; orgName?: string | null; reporterName?: string | null;
      orgId?: string | null;
    } = {},
  ): Promise<void> {
    const reporter = extra.reporterName?.trim();
    for (const uid of managerUserIds) {
      await this.publish(uid, 'incident', {
        kind: 'incident-submitted', ref, severity,
        ...(extra.incidentId ? {incidentId: extra.incidentId} : {}),
        ...(extra.orgId ? {orgId: extra.orgId} : {}),
        ...(extra.orgName?.trim() ? {orgName: extra.orgName.trim()} : {}),
        ...(reporter ? {reporterName: reporter} : {}),
      });
    }
  }

  /**
   * Notify the submitter that their incident's status changed.
   *
   * Carries `incidentId` for the same reason: without it the reporter's tap
   * can only reach a list.
   */
  async incidentStatusChanged(
    submitterUserId: string, ref: string | null, status: string, incidentId?: string | null,
  ): Promise<void> {
    return this.publish(submitterUserId, 'incident', {
      kind: 'incident-status', ref, status,
      ...(incidentId ? {incidentId} : {}),
    });
  }

  // ─── Enterprise workspace · join loop (A11 / M11A) ────────────────────
  //
  // Closes R13-2: the join loop previously wrote inbox rows only, so an admin
  // who was not in the app never learned a request was waiting. The blob
  // carries ONLY the kind and — for the ADMIN-side kinds — the org the request
  // is about (vs2 edge A2: a two-org admin tapping org-B's "join request
  // waiting" read org-A's inbox, because the list is stamped with the sticky
  // context). Still no request id: both tap targets are list screens (Approvals
  // / ApprovalStatus) that refetch on focus, so a per-record id would add
  // metadata surface for zero routing value (P0-N8).
  //
  // The APPLICANT-side kinds (join.approved / declined / invite.received) get no
  // orgId on purpose — ApprovalStatus is the caller's own cross-org status
  // screen, and narrowing it to one org would HIDE the other org's invites.
  // Normal FCM priority on purpose —
  // a Dozed device may defer or drop the wake (10-min FCM TTL) and the
  // durable row backfills on next foreground. The admin-side wake is the
  // latency-sensitive half; promote 'enterprise' to the messenger-service
  // high-priority set only with a founder decision, not as a drive-by.

  /** Wake an org admin that a join request is waiting (A11). Inline literal so
   *  the serverWakeKindParity extractor sees the kind (one kind per publish).
   *  `orgUserId` is optional so the fan-out cannot break if a caller has not
   *  got it — an absent id degrades to today's sticky-context behaviour. */
  async enterpriseJoinRequested(adminUserId: string, orgUserId?: string | null): Promise<void> {
    return this.publish(adminUserId, 'enterprise', {
      kind: 'enterprise.join.requested',
      ...(orgUserId ? {orgId: orgUserId} : {}),
    });
  }

  /** Wake the applicant with the decision (M11A). The durable inbox row rides
   *  `publish` (N-20). The quote-free ternary condition is deliberate: the
   *  serverWakeKindParity extractor's `[^'\n?]*` stops at a quoted condition
   *  and would silently drop both arms from the parity gate. */
  async enterpriseJoinDecided(applicantUserId: string, decision: 'approved' | 'declined'): Promise<void> {
    const approved = decision === 'approved';
    return this.publish(applicantUserId, 'enterprise',
      {kind: approved ? 'enterprise.join.approved' : 'enterprise.join.declined'});
  }

  /** Wake a user that a workspace invited them (Item E). Fired only when the
   *  minted contact resolves to an existing account — the MINT RESPONSE must
   *  stay byte-identical matched or unmatched, so this is the only place the
   *  match is allowed to have an observable effect. */
  async enterpriseInviteReceived(userId: string): Promise<void> {
    return this.publish(userId, 'enterprise', {kind: 'enterprise.invite.received'});
  }

  /** Wake org admins that an invitee accepted and is now a member (Item E).
   *  Admin-side, so it carries the org for the tap (vs2 edge A2). */
  async enterpriseInviteAccepted(adminUserId: string, orgUserId?: string | null): Promise<void> {
    return this.publish(adminUserId, 'enterprise', {
      kind: 'enterprise.invite.accepted',
      ...(orgUserId ? {orgId: orgUserId} : {}),
    });
  }
}
