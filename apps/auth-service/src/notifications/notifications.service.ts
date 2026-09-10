import {Injectable, Logger} from '@nestjs/common';
import type {QueryResultRow} from 'pg';
import {DatabaseService} from '../database/database.service';

/**
 * N-20 — durable per-user notification inbox.
 *
 * Before this, every server-driven wake (booking / dispatch / mission / payout /
 * SOS / incident) lived ONLY as a 5-min Redis detail blob + a fire-and-forget
 * FCM wake. Any device that missed the wake (dead/absent push token, Doze,
 * reinstall, app killed >5 min) lost the event permanently, and no client
 * surface could ever backfill or reconcile — so the in-app "bell" could never
 * stay in sync. This table is the durable record written at the single
 * BookingPushBridge fan-out point, read by the mobile ActivityCenter (and,
 * later, the ops console) so both surfaces share ONE source of truth.
 *
 * Metadata-only (P0-N8): we store the coarse class + kind + optional
 * booking/mission ids — the SAME shape the JWT-gated Redis detail blob already
 * carried — never a message body, description, coordinates, or key. Retrieval
 * is JWT-gated and scoped to the recipient (user_id = req.user.sub).
 */

const UUID_RE = /^[0-9a-fA-F-]{32,36}$/;

export interface NotificationRow extends QueryResultRow {
  id:          string;
  event_class: string;
  kind:        string;
  booking_id:  string | null;
  mission_id:  string | null;
  /** Deep-link target for incident-* kinds (client review vs2 item 16). */
  incident_id: string | null;
  /** Which org the event is about, for multi-org tap scoping (vs2 edge A1/A2). */
  org_user_id: string | null;
  created_at:  Date | string;
  read_at:     Date | string | null;
}

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  constructor(private readonly db: DatabaseService) {}

  /**
   * Record a notification row. Fire-and-forget by contract — a DB hiccup
   * (or a not-yet-migrated table) must never break the push fan-out it rides
   * alongside, so this swallows errors after logging.
   */
  async record(
    userId: string,
    n: {
      eventClass: string; kind: string;
      bookingId?: string | null; missionId?: string | null;
      /** vs2 item 16 — lets the durable lane deep-link, not just the 5-min blob. */
      incidentId?: string | null;
      /** vs2 edge A1/A2 — lets a multi-org tap scope the surface before it reads. */
      orgUserId?: string | null;
    },
  ): Promise<void> {
    if (!userId || !n.kind) {return;}
    try {
      await this.db.q(
        `INSERT INTO public.notifications (user_id, event_class, kind, booking_id, mission_id, incident_id, org_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, n.eventClass, n.kind, n.bookingId ?? null, n.missionId ?? null,
         n.incidentId ?? null, n.orgUserId ?? null],
      );
      // B-706 A-6 — after the insert has been awaited, never before it and never
      // blocking it.
      this.maybeSweepRetention();
    } catch (e) {
      this.log.warn(`notification record failed kind=${n.kind}: ${(e as Error).message}`);
    }
  }

  /** Recent notifications for a user, newest first. `sinceIso` enables an
   *  incremental foreground sync (only rows newer than the client's watermark). */
  async list(userId: string, opts: {sinceIso?: string; limit?: number} = {}): Promise<NotificationRow[]> {
    // B-706 A-12 — a NaN limit (`?limit=abc` → Number('abc')) reached `LIMIT $n`, raised
    // 22P02, and the catch below turned it into an empty feed behind a 200. Coerce first.
    const asked = Number(opts.limit);
    const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 50, 1), 200);
    // B-706 A-3 — dismissed rows are the recipient's own deletion. Filtering here is what
    // makes `Clear` durable: without it the next sync (or any reinstall, or a second
    // device) handed the whole inbox straight back.
    const params: unknown[] = [userId];
    let where = 'user_id = $1 AND dismissed_at IS NULL';
    if (opts.sinceIso) {
      params.push(opts.sinceIso);
      // B-706 A-2 — `>=`, not `>`. `created_at` is now millisecond-truncated to match the
      // millisecond the client can actually echo back (see the 20260830120000 migration),
      // and a strict `>` on a truncated column SKIPS a row sharing the boundary
      // millisecond. Over-returning the boundary row is free — the client dedupes by id —
      // whereas skipping one loses a notification permanently.
      where += ` AND created_at >= $${params.length}`;
    }
    params.push(limit);
    try {
      return await this.db.q<NotificationRow>(
        `SELECT id, event_class, kind, booking_id, mission_id, incident_id, org_user_id,
                created_at, read_at
           FROM public.notifications
          WHERE ${where}
          ORDER BY created_at DESC
          LIMIT $${params.length}`,
        params,
      );
    } catch (e) {
      this.log.warn(`notification list failed sub=${userId}: ${(e as Error).message}`);
      return [];
    }
  }

  /**
   * B-706 A-3 — the recipient cleared these rows from their feed.
   *
   * Suppression, not deletion: this table is an append-only event log, and a dismissal is
   * one recipient's VIEW of a row. Stamping a column also keeps the call idempotent under
   * retry, which a DELETE would not be. Always scoped by `user_id`, so an id belonging to
   * someone else can never be touched.
   */
  async dismiss(userId: string, ids: string[]): Promise<void> {
    const clean = ids.filter(id => typeof id === 'string' && UUID_RE.test(id)).slice(0, 500);
    if (clean.length === 0) {return;}
    await this.db.q(
      `UPDATE public.notifications SET dismissed_at = now()
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND dismissed_at IS NULL`,
      [userId, clean],
    );
  }

  async dismissAll(userId: string): Promise<void> {
    await this.db.q(
      `UPDATE public.notifications SET dismissed_at = now()
        WHERE user_id = $1 AND dismissed_at IS NULL`,
      [userId],
    );
  }

  /**
   * B-706 A-6 — the retention sweep 20260727210000_notifications_inbox.sql promised
   * ("a cheap opportunistic sweep on insert-heavy paths") and never shipped. Live, 43% of
   * the table was past the documented 30-day window and the oldest row was 52 days, which
   * is what a fresh install pulled down as its "current" feed.
   *
   * Sampled, and deliberately NOT on `record()`'s await path: BookingPushBridge orders the
   * wake BEFORE durability on purpose so an SOS fan-out never queues behind Postgres, and
   * a sweep must not reintroduce that. Fire-and-forget, errors swallowed.
   */
  private sweepInFlight = false;
  maybeSweepRetention(): void {
    if (this.sweepInFlight || Math.random() >= NotificationsService.SWEEP_SAMPLE_RATE) {return;}
    this.sweepInFlight = true;
    void this.db
      .q(`DELETE FROM public.notifications
           WHERE ctid IN (
             SELECT ctid FROM public.notifications
              WHERE created_at < now() - interval '30 days'
              LIMIT $1)`, [NotificationsService.SWEEP_BATCH])
      .catch((e: Error) => this.log.warn(`notification sweep failed: ${e.message}`))
      .finally(() => { this.sweepInFlight = false; });
  }

  /** ~1 insert in 200 triggers a sweep; a bounded batch keeps any single one cheap. */
  private static readonly SWEEP_SAMPLE_RATE = 0.005;
  private static readonly SWEEP_BATCH = 500;

  async markRead(userId: string, ids: string[]): Promise<void> {
    const clean = ids.filter(id => typeof id === 'string' && UUID_RE.test(id)).slice(0, 500);
    if (clean.length === 0) {return;}
    await this.db.q(
      `UPDATE public.notifications SET read_at = now()
        WHERE user_id = $1 AND id = ANY($2::uuid[]) AND read_at IS NULL`,
      [userId, clean],
    );
  }

  async markAllRead(userId: string): Promise<void> {
    await this.db.q(
      `UPDATE public.notifications SET read_at = now()
        WHERE user_id = $1 AND read_at IS NULL`,
      [userId],
    );
  }
}
