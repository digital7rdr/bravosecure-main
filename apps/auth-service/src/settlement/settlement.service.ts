import {Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {DatabaseService, type Tx} from '../database/database.service';
import {WalletService} from '../wallet/wallet.service';

/**
 * Actor driving a settlement. `kind` selects the policy:
 *  - 'system' — the release sweep / reconciliation (no human, decided_by null).
 *  - 'client' — an early confirm-complete (the client releases their own hold).
 *  - 'admin'  — the ops exception path (D1); may force-promote a still-HELD hold.
 * `userId` lands in mission_payouts.decided_by (nullable). `callSign` is for logs only.
 */
export interface SettlementActor {
  kind: 'system' | 'client' | 'admin';
  userId?: string | null;
  callSign?: string | null;
}

/**
 * SettlementService (BUILD_RUNBOOK Step 10) — the ONE actor-agnostic owner of the
 * escrow RELEASE settlement (pay the agency after a verified completion). Extracted so
 * the release sweep, the client confirm-complete, and the admin completeBooking exception
 * all funnel through a single escrow-aware path instead of three copies.
 *
 * DI: deliberately a standalone SettlementModule importing only WalletModule (+ the
 * @Global db/config). It does the crew-payout row + group dissolve via RAW SQL rather
 * than injecting CpoAssignmentService (BookingModule) or OpsAuditService (OpsModule) —
 * either would import a module at/above BookingModule and re-create the Ops<->Booking DI
 * cycle the EscrowReleaseSweepService header already documents. The durable audit is the
 * paired wallet_transactions ledger + the mission_payouts row; the rich ops feed/audit
 * stays with the admin-only resolve path (which has OpsAuditService).
 */
@Injectable()
export class SettlementService {
  private readonly log = new Logger(SettlementService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly config: ConfigService,
    private readonly wallet: WalletService,
  ) {}

  /**
   * Release a PENDING_RELEASE escrow hold to the agency (escrow -> provider + platform
   * fee) AND record the operational side-effects: a single agency mission_payouts row,
   * the agency jobs_total bump, and the Ops-Room group dissolve. Tx-aware — runs on the
   * caller's tx so the money move and the side-effects commit atomically.
   *
   * Idempotent: releaseEscrowHold is gated on status='PENDING_RELEASE' under FOR UPDATE,
   * and the payout / mission_payouts rows are unique-constrained, so a double-run no-ops.
   *
   * `opts.force` (admin only): if the hold is still HELD, first promote it to
   * PENDING_RELEASE (the admin vouches for completion — D1 exception path) before
   * releasing. System/client callers never force, so a HELD hold is left untouched.
   *
   * Returns escrow:false when the booking has no hold (a legacy booking — the caller
   * keeps its own non-escrow settlement).
   */
  async settleEscrowRelease(
    tx: Tx,
    bookingId: string,
    actor: SettlementActor,
    opts: {force?: boolean} = {},
  ): Promise<{escrow: boolean; released: boolean; toProvider: number; platformFee: number; providerUserId: string | null}> {
    const hold = await tx.qOne<{status: string; provider_user_id: string | null}>(
      `SELECT status, provider_user_id FROM escrow_holds WHERE booking_id = $1 FOR UPDATE`,
      [bookingId],
    );
    if (!hold) {
      return {escrow: false, released: false, toProvider: 0, platformFee: 0, providerUserId: null};
    }
    // Admin exception: vouch a still-HELD hold straight to releasable.
    if (hold.status === 'HELD' && opts.force && actor.kind === 'admin') {
      await tx.q(
        `UPDATE escrow_holds
            SET status = 'PENDING_RELEASE',
                completed_at = COALESCE(completed_at, NOW()),
                release_eligible_at = NOW()
          WHERE booking_id = $1 AND status = 'HELD'`,
        [bookingId],
      );
    }

    const feePct = this.config.get<number>('dispatch.platformFeePct') ?? 0;
    const res = await this.wallet.releaseEscrowHold(tx, bookingId, feePct);
    if (!res.released) {
      return {escrow: true, released: false, toProvider: 0, platformFee: 0, providerUserId: hold.provider_user_id};
    }

    // Side-effects keyed off the (now RELEASED) hold + booking + mission.
    const ctx = await tx.qOne<{provider_user_id: string | null; conversation_id: string | null; mission_id: string | null; call_sign: string | null}>(
      `SELECT eh.provider_user_id,
              b.conversation_id,
              m.id        AS mission_id,
              m.short_code AS call_sign
         FROM escrow_holds eh
         JOIN lite_bookings b ON b.id = eh.booking_id
         -- LM-B1: skip ABORTED history rows — the payout row must key the mission
         -- that actually ran (≤1 non-ABORTED per booking by partial unique).
         LEFT JOIN missions m ON m.booking_id = eh.booking_id AND m.status <> 'ABORTED'
        WHERE eh.booking_id = $1`,
      [bookingId],
    );
    const providerId = ctx?.provider_user_id ?? null;

    // Agency payout audit row (single row for the AGENCY — it settles its own CPOs).
    if (providerId && ctx?.mission_id) {
      await tx.q(
        `INSERT INTO mission_payouts
           (mission_id, booking_id, agent_user_id, payee_user_id, call_sign,
            proposed_credits, paid_credits, deduction_credits, deduction_reason, decided_by)
         VALUES ($1, $2, $3, $3, $4, $5, $5, 0, NULL, $6)
         ON CONFLICT (mission_id, agent_user_id) DO NOTHING`,
        [ctx.mission_id, bookingId, providerId, ctx.call_sign, res.toProvider, actor.userId ?? null],
      );
    }
    // Agency completed-job stat.
    if (providerId) {
      await tx.q(`UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id = $1`, [providerId]);
    }
    // Individual crew CPOs — this bump above only credits the AGENCY (the
    // escrow provider). The auto-dispatch crew (mission_crew) never got their
    // own jobs_total moved on this path, so a CPO's dashboard "N jobs" stat
    // silently undercounted every job they worked as crew (only legacy/manual
    // completions via ops.service's completeBooking bumped them — see that
    // method's "RATING-CARD (#10)" comment, which fixed the mirror-image gap
    // on the OTHER completion path). Exclude providerId so a solo booking
    // (provider is also the sole crew) isn't double-counted.
    if (ctx?.mission_id) {
      const crew = await tx.q<{agent_id: string}>(
        `SELECT agent_id FROM mission_crew WHERE mission_id = $1`,
        [ctx.mission_id],
      );
      const crewIds = [...new Set(crew.map(c => c.agent_id))].filter(id => id !== providerId);
      if (crewIds.length > 0) {
        await tx.q(`UPDATE agents SET jobs_total = jobs_total + 1 WHERE user_id = ANY($1)`, [crewIds]);
      }
    }
    // MISSION-GROUP (area 5) — DELETE the Ops Room on completion so it disappears
    // for the client AND the SP/agency. SET NULL the back-references (lite_bookings,
    // missions) first so the booking/mission rows survive, then delete the child
    // rows that FK conversations.id, then the conversation itself. Idempotent: a
    // missing/already-deleted conversation is a no-op. Server-side metadata only —
    // no group keys touched.
    if (ctx?.conversation_id) {
      const c = [ctx.conversation_id];
      await tx.q(`UPDATE public.lite_bookings SET conversation_id = NULL WHERE conversation_id = $1`, c);
      await tx.q(`UPDATE public.missions SET comms_channel_id = NULL WHERE comms_channel_id = $1`, c);
      await tx.q(`DELETE FROM public.dispatch_room_intents WHERE conversation_id = $1`, c);
      await tx.q(`DELETE FROM public.conversation_members WHERE conversation_id = $1`, c);
      await tx.q(`DELETE FROM public.system_broadcasts WHERE conversation_id = $1`, c);
      await tx.q(`DELETE FROM public.conversations WHERE id = $1`, c);
    }
    this.log.log(`settle release booking=${bookingId} by=${actor.kind} provider=${providerId} (+${res.toProvider} BC, fee ${res.platformFee})`);
    // LM-N4 — providerUserId rides back so the caller can wake the agency about
    // its payout AFTER the commit (pushing inside the txn could announce money
    // that then rolls back).
    return {escrow: true, released: true, toProvider: res.toProvider, platformFee: res.platformFee, providerUserId: providerId};
  }
}
