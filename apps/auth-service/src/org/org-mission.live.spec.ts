import {ForbiddenException} from '@nestjs/common';
import {OrgMissionService} from './org-mission.service';
import type {DatabaseService} from '../database/database.service';
import type {SystemMessengerService} from '../ops/system-messenger.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {DispatchRoomIntentsService} from '../dispatch/dispatch-room-intents.service';
import type {ConfigService} from '@nestjs/config';

/**
 * Step 32 — getMissionLive feeds the org manager's desk monitor. It must be
 * ORG-SCOPED: the SQL gate (b.assigned_provider_user_id = $org) means a manager
 * can only watch their OWN deployments (a non-owned / unknown mission → null →
 * Forbidden, IDOR closed). On success it returns BOTH the CPO leader position
 * (current_lat/lng) and the principal position (client_lat/lng) so the map draws
 * two markers, with the lead's call sign for the marker label.
 */
function mk(owned: boolean): OrgMissionService {
  const db = {
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM missions m\s+JOIN lite_bookings b/.test(sql)) {
        return Promise.resolve(owned ? {
          short_code: 'BL-9', status: 'LIVE', booking_id: 'b1',
          route_distance_m: null, route_duration_s: null, route_polyline: null,
          current_lat: 25.200, current_lng: 55.270,
          client_lat: 25.210, client_lng: 55.280,
          client_recorded_at: new Date('2026-06-25T10:00:00.000Z'),
          comms_channel_id: null,
        } : null);
      }
      if (/FROM lite_bookings b/.test(sql)) {
        return Promise.resolve({
          pickup_address: 'X', pickup_lat: null, pickup_lng: null,
          dropoff_address: null, dropoff_lat: null, dropoff_lng: null,
          booking_status: 'LIVE', client_name: 'Jane Principal',
        });
      }
      return Promise.resolve(null);
    }),
    q: jest.fn().mockImplementation((sql: string) =>
      /FROM mission_crew/.test(sql)
        ? Promise.resolve([{call_sign: 'A1', role: 'LEAD', team_idx: 0, is_lead: true, is_me: false}])
        : Promise.resolve([])), // waypoints
  } as unknown as DatabaseService;
  return new OrgMissionService(
    db,
    {} as unknown as SystemMessengerService,
    {} as unknown as BookingPushBridge,
    {} as unknown as DispatchRoomIntentsService,
    {get: () => 0} as unknown as ConfigService,
  );
}

describe('OrgMissionService.getMissionLive — org-scoped monitor (Step 32)', () => {
  it('throws Forbidden when the mission is not the caller org\'s (IDOR closed)', async () => {
    await expect(mk(false).getMissionLive('org1', 'm1')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns BOTH the CPO leader + principal positions for the owning org', async () => {
    const out = await mk(true).getMissionLive('org1', 'm1');
    expect(out.mission?.current_lat).toBe(25.200);
    expect(out.mission?.current_lng).toBe(55.270);
    expect(out.mission?.client_lat).toBe(25.210);
    expect(out.mission?.client_lng).toBe(55.280);
    expect(out.mission?.client_recorded_at).toBe('2026-06-25T10:00:00.000Z');
    expect(out.crew_role?.call_sign).toBe('A1');
    expect(out.booking?.client_name).toBe('Jane Principal');
  });
});
