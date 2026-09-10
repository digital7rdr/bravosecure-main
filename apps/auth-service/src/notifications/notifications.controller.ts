import {Controller, Get, Post, Body, Query, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {NotificationsService} from './notifications.service';

/**
 * N-20 — durable notification inbox API, scoped to the authenticated recipient.
 *   GET  /me/notifications?since=<iso>&limit=<n>  — recent rows (newest first)
 *   POST /me/notifications/read {ids:[...]} | {all:true}
 *
 * Payloads are metadata-only (class/kind/booking/mission ids); the client maps
 * kind → display title (same map the FCM wake path uses). See NotificationsService.
 */
@Controller('me/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly svc: NotificationsService) {}

  @Get()
  async list(
    @CurrentUser() user: AccessClaims,
    @Query('since') since?: string,
    @Query('limit') limit?: string,
  ): Promise<{notifications: Array<{
    id: string; eventClass: string; kind: string;
    bookingId?: string; missionId?: string; incidentId?: string; orgId?: string;
    createdAt: string; read: boolean;
  }>}> {
    const rows = await this.svc.list(user.sub, {
      sinceIso: since,
      limit: limit ? Number(limit) : undefined,
    });
    return {
      notifications: rows.map(r => ({
        id:         r.id,
        eventClass: r.event_class,
        kind:       r.kind,
        bookingId:  r.booking_id ?? undefined,
        missionId:  r.mission_id ?? undefined,
        // vs2 item 16 — without this the durable lane can never deep-link and
        // the column is silence in a new place.
        incidentId: r.incident_id ?? undefined,
        // vs2 edge A1/A2 — same reason, one layer up: the bell row needs to say
        // WHICH organisation, or a multi-org tap reads the wrong one.
        orgId:      r.org_user_id ?? undefined,
        createdAt:  r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        read:       r.read_at != null,
      })),
    };
  }

  @Post('read')
  async read(
    @CurrentUser() user: AccessClaims,
    @Body() body: {ids?: string[]; all?: boolean},
  ): Promise<{ok: true}> {
    if (body?.all) {
      await this.svc.markAllRead(user.sub);
    } else if (Array.isArray(body?.ids)) {
      await this.svc.markRead(user.sub, body.ids);
    }
    return {ok: true};
  }

  /**
   * B-706 A-3 — the recipient cleared rows from their feed.
   *
   * Before this there was NO delete surface at all: the app's "Clear" was a local
   * `set({rows: []})`, so the server never learned of it and the next sync handed the
   * whole inbox back. That is the founder's "I delete the notification, again it came
   * back" — the client was mutating a cache the code treated as the record.
   *
   * Scoped to `user.sub` exactly like `read`, so an id belonging to another account can
   * never be dismissed.
   */
  @Post('dismiss')
  async dismiss(
    @CurrentUser() user: AccessClaims,
    @Body() body: {ids?: string[]; all?: boolean},
  ): Promise<{ok: true}> {
    if (body?.all) {
      await this.svc.dismissAll(user.sub);
    } else if (Array.isArray(body?.ids)) {
      await this.svc.dismiss(user.sub, body.ids);
    }
    return {ok: true};
  }
}
