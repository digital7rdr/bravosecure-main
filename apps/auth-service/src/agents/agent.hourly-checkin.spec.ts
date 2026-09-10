import {BadRequestException, ForbiddenException, NotFoundException} from '@nestjs/common';
import {AgentService} from './agent.service';
import type {DatabaseService} from '../database/database.service';

/**
 * Executive Protection — hourly check-ins (the executive replacement for waypoints).
 *
 * Contract pinned here: lead-only · executive-only · mission LIVE/SOS · hour within
 * the booked block · an hour is confirmable only once ELAPSED (live_at +
 * h×3600s − 120s grace) · idempotent per (mission, hour) · pushes fan out to
 * the client AND the agency on a FRESH insert only.
 */
type Ctx = Partial<{
  booking_id: string; mission_status: string; live_at: Date | null;
  service: string; duration_hours: number; client_id: string;
  provider: string | null; is_lead: boolean; short_code: string;
}>;

function mk(ctx: Ctx | null, opts?: {conflict?: boolean}) {
  const inserted = {hour_index: 2, status: 'SMOOTH', comment: null, created_at: new Date()};
  const qOne = jest.fn().mockImplementation((sql: string) => {
    if (/FROM mission_crew mc/.test(sql)) {return Promise.resolve(ctx);}
    if (/INSERT INTO mission_hourly_checkins/.test(sql)) {
      return Promise.resolve(opts?.conflict ? null : inserted);
    }
    if (/SELECT hour_index/.test(sql)) {return Promise.resolve(inserted);}
    return Promise.resolve(null);
  });
  const db = {qOne, q: jest.fn().mockResolvedValue([])} as unknown as DatabaseService;
  const push = {
    hourlyCheckin: jest.fn().mockResolvedValue(undefined),
    hourlyCheckinAgency: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new AgentService(
    db, {} as never, {} as never, {} as never, {} as never,
    {} as never, {} as never, {get: () => undefined} as never,
    undefined, push as never,
  );
  return {svc, qOne, push};
}

const HOUR = 3600_000;

function execCtx(over: Ctx = {}): Ctx {
  return {
    booking_id: 'bk1', mission_status: 'LIVE',
    live_at: new Date(Date.now() - 2 * HOUR - 60_000), // 2h01m ago → hours 1..2 elapsed
    service: 'executive_protection', duration_hours: 6, client_id: 'client1',
    provider: 'org1', is_lead: true, short_code: 'MSN-X',
    ...over,
  };
}

describe('AgentService.hourlyCheckIn — Executive Protection', () => {
  it('confirms an elapsed hour and pushes to client + agency', async () => {
    const {svc, push} = mk(execCtx());
    const res = await svc.hourlyCheckIn('lead1', 'm1', 2, 'all quiet');
    expect(res.ok).toBe(true);
    expect(res.hour_index).toBe(2);
    expect(push.hourlyCheckin).toHaveBeenCalledWith('client1', 'bk1', 2);
    expect(push.hourlyCheckinAgency).toHaveBeenCalledWith('org1', 'bk1', 'm1', 2);
  });

  it('is idempotent — a re-tap adopts the existing row and does NOT re-push', async () => {
    const {svc, push} = mk(execCtx(), {conflict: true});
    const res = await svc.hourlyCheckIn('lead1', 'm1', 2);
    expect(res.ok).toBe(true);
    expect(push.hourlyCheckin).not.toHaveBeenCalled();
    expect(push.hourlyCheckinAgency).not.toHaveBeenCalled();
  });

  it('rejects an hour that has not elapsed yet (with the 2-min grace honored)', async () => {
    // live_at 57 minutes ago: hour 1 is due at live+58m (60−2 grace) — not yet.
    const {svc} = mk(execCtx({live_at: new Date(Date.now() - 57 * 60_000)}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts inside the grace window (59 minutes elapsed for hour 1)', async () => {
    const {svc} = mk(execCtx({live_at: new Date(Date.now() - 59 * 60_000)}));
    const res = await svc.hourlyCheckIn('lead1', 'm1', 1);
    expect(res.ok).toBe(true);
  });

  it('rejects non-lead crew (lead_only)', async () => {
    const {svc} = mk(execCtx({is_lead: false}));
    await expect(svc.hourlyCheckIn('cp2', 'm1', 1)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects non-executive missions', async () => {
    const {svc} = mk(execCtx({service: 'secure_transfer'}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when the mission is not LIVE/SOS', async () => {
    const {svc} = mk(execCtx({mission_status: 'PICKUP'}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 1)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('allows confirmation during SOS (the record must survive an incident)', async () => {
    const {svc} = mk(execCtx({mission_status: 'SOS'}));
    const res = await svc.hourlyCheckIn('lead1', 'm1', 1);
    expect(res.ok).toBe(true);
  });

  it('rejects hours beyond the booked block', async () => {
    const {svc} = mk(execCtx({duration_hours: 3, live_at: new Date(Date.now() - 10 * HOUR)}));
    await expect(svc.hourlyCheckIn('lead1', 'm1', 4)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a caller who is not on the crew', async () => {
    const {svc} = mk(null);
    await expect(svc.hourlyCheckIn('stranger', 'm1', 1)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects garbage hour_index values', async () => {
    const {svc} = mk(execCtx());
    await expect(svc.hourlyCheckIn('lead1', 'm1', 0)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.hourlyCheckIn('lead1', 'm1', 25)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.hourlyCheckIn('lead1', 'm1', Number.NaN)).rejects.toBeInstanceOf(BadRequestException);
  });
});
