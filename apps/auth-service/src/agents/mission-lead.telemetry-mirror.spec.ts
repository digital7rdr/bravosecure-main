import {BadRequestException} from '@nestjs/common';
import {MissionLeadService} from './mission-lead.service';
import type {DatabaseService} from '../database/database.service';
import type {MissionEventsService} from '../ops/mission-events.service';
import type {TelemetryService} from '../telemetry/telemetry.service';

/**
 * B-89 MG-01/MG-02 — pushTelemetry must (a) mirror every fix into the
 * CLIENT-facing telemetry stores (TelemetryService.ping) and emit the
 * `mission.telemetry` realtime frame, keyed by booking id; (b) derive a
 * bearing from the previous → current fix when the device reports no GPS
 * course. Before this, those stores had no living writer, so the
 * principal's LiveTracking screen rendered a simulated dot all mission.
 */

type Fix = {lat: number; lng: number; heading_deg?: number; speed_kph?: number; accuracy_m?: number; battery_pct?: number};

function mk(opts: {
  prev?: {lat: number; lng: number} | null;
  bookingId?: string | null;
  routeDistanceM?: number | null;
  routeDurationS?: number | null;
  pingRejects?: boolean;
} = {}) {
  const prev = opts.prev === undefined ? {lat: 25.1000, lng: 55.2000} : opts.prev;
  const db = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/SELECT is_lead FROM mission_crew/.test(sql)) {
        return Promise.resolve({is_lead: true});
      }
      if (/route_distance_m, m\.route_duration_s, m\.booking_id/.test(sql)) {
        return Promise.resolve({
          route_distance_m: opts.routeDistanceM === undefined ? 10_000 : opts.routeDistanceM,
          route_duration_s: opts.routeDurationS === undefined ? 1_200 : opts.routeDurationS,
          booking_id: opts.bookingId === undefined ? 'bk-1' : opts.bookingId,
          prev_lat: prev?.lat ?? null,
          prev_lng: prev?.lng ?? null,
          booking_dropoff_lat: '25.2000',
          booking_dropoff_lng: '55.3000',
        });
      }
      // wentLive UPDATE ... RETURNING / waypoint auto-marks → no transition.
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  const events = {
    telemetryFix: jest.fn().mockResolvedValue(undefined),
    statusChanged: jest.fn().mockResolvedValue(undefined),
  } as unknown as MissionEventsService;
  const ping = opts.pingRejects
    ? jest.fn().mockRejectedValue(new Error('redis down'))
    : jest.fn().mockResolvedValue({});
  const telemetry = {ping} as unknown as TelemetryService;
  const svc = new MissionLeadService(db, events, telemetry);
  return {svc, db, events, ping};
}

const push = (svc: MissionLeadService, fix: Fix) => svc.pushTelemetry('cpo-1', 'm-1', fix);

describe('MG-01 — client-store mirror + realtime frame', () => {
  it('mirrors the fix to TelemetryService.ping keyed by BOOKING id, with ETA from route remaining', async () => {
    const {svc, ping} = mk();
    await push(svc, {lat: 25.15, lng: 55.25, heading_deg: 90, speed_kph: 40});
    expect(ping).toHaveBeenCalledTimes(1);
    const [bookingId, fix] = (ping as jest.Mock).mock.calls[0];
    expect(bookingId).toBe('bk-1');
    expect(fix.lat).toBe(25.15);
    expect(fix.lng).toBe(55.25);
    expect(fix.heading_deg).toBe(90);
    expect(fix.source).toBe('agent');
    // dist ≈ haversine(25.15,55.25 → 25.2,55.3) ≈ 7.5 km of a 10 km /
    // 20 min route → ETA ≈ 15 min. Sanity-band, not exact.
    expect(fix.eta_minutes).toBeGreaterThanOrEqual(10);
    expect(fix.eta_minutes).toBeLessThanOrEqual(20);
  });

  it('emits the mission.telemetry frame with the booking id + heading in the payload', async () => {
    const {svc, events} = mk();
    await push(svc, {lat: 25.15, lng: 55.25, heading_deg: 45});
    expect(events.telemetryFix).toHaveBeenCalledTimes(1);
    const [missionId, frame, bookingId] = (events.telemetryFix as jest.Mock).mock.calls[0];
    expect(missionId).toBe('m-1');
    expect(bookingId).toBe('bk-1');
    expect(frame.heading_deg).toBe(45);
    expect(typeof frame.recordedAt).toBe('string');
  });

  it('a mirror failure never fails the CPO push (ops write already landed)', async () => {
    const {svc} = mk({pingRejects: true});
    await expect(push(svc, {lat: 25.15, lng: 55.25})).resolves.toMatchObject({ok: true});
  });

  it('skips the mirror when the mission has no booking id', async () => {
    const {svc, ping, events} = mk({bookingId: null});
    await push(svc, {lat: 25.15, lng: 55.25});
    expect(ping).not.toHaveBeenCalled();
    expect(events.telemetryFix).not.toHaveBeenCalled();
  });
});

describe('MG-02 — bearing derivation when the device reports no course', () => {
  it('derives heading from previous → current fix (movement ≥ 8 m)', async () => {
    // prev (25.1, 55.2) → new point due EAST ≈ bearing 90°.
    const {svc, db} = mk({prev: {lat: 25.1, lng: 55.2}});
    await push(svc, {lat: 25.1, lng: 55.21});
    const insert = (db.q as jest.Mock).mock.calls.find(c => /INSERT INTO mission_telemetry/.test(c[0]));
    expect(insert).toBeDefined();
    const derived = insert![1][4]; // heading_deg param
    expect(derived).toBeGreaterThanOrEqual(85);
    expect(derived).toBeLessThanOrEqual(95);
  });

  it('does NOT derive from sub-8m jitter (heading stays null)', async () => {
    const {svc, db} = mk({prev: {lat: 25.1, lng: 55.2}});
    await push(svc, {lat: 25.100001, lng: 55.200001});
    const insert = (db.q as jest.Mock).mock.calls.find(c => /INSERT INTO mission_telemetry/.test(c[0]));
    expect(insert![1][4]).toBeNull();
  });

  it('the device-reported course always wins over derivation', async () => {
    const {svc, db, ping} = mk({prev: {lat: 25.1, lng: 55.2}});
    await push(svc, {lat: 25.1, lng: 55.21, heading_deg: 270});
    const insert = (db.q as jest.Mock).mock.calls.find(c => /INSERT INTO mission_telemetry/.test(c[0]));
    expect(insert![1][4]).toBe(270);
    expect((ping as jest.Mock).mock.calls[0][1].heading_deg).toBe(270);
  });

  it('no previous fix → no derivation, push still succeeds', async () => {
    const {svc, db} = mk({prev: null});
    await expect(push(svc, {lat: 25.1, lng: 55.21})).resolves.toMatchObject({ok: true});
    const insert = (db.q as jest.Mock).mock.calls.find(c => /INSERT INTO mission_telemetry/.test(c[0]));
    expect(insert![1][4]).toBeNull();
  });
});

describe('ingest validation (pre-existing, still enforced)', () => {
  it('rejects non-finite coordinates', async () => {
    const {svc} = mk();
    await expect(push(svc, {lat: Number.NaN, lng: 55.2})).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('Client Picked Up — telemetry may no longer pre-empt the lead confirmation', () => {
  /**
   * Founder deck, August 2026: "The driver must confirm Client Picked Up at pickup."
   * This path used to flip PICKUP -> LIVE on the FIRST telemetry push, i.e. seconds
   * after arriving, so the mission announced itself as protection-active before
   * anyone was in the vehicle and live_at recorded "a GPS ping arrived". live_at
   * drives the proof gate, the pre-LIVE full-refund boundary and the executive
   * check-in schedule, so that was a data-integrity problem as well as a UX one.
   *
   * It survives ONLY as an anti-strand fallback: a lead who never taps would
   * otherwise leave the mission unfinishable (Finish requires LIVE/SOS) and escrow
   * would never settle.
   */
  const goLiveCall = (db: DatabaseService) =>
    (db.qOne as jest.Mock).mock.calls
      .find(c => /UPDATE missions SET status = 'LIVE'/.test(String(c[0])));

  it('the go-live UPDATE is gated on a pickup_at grace window, not just status', async () => {
    const {svc, db} = mk();
    await push(svc, {lat: 25.15, lng: 55.25});
    const call = goLiveCall(db);
    expect(call).toBeDefined();
    const sql = String(call![0]);
    // The old statement was `WHERE id = $1 AND status = 'PICKUP'` and nothing else.
    expect(sql).toMatch(/status = 'PICKUP'/);
    expect(sql).toMatch(/pickup_at IS NOT NULL/);
    expect(sql).toMatch(/pickup_at < NOW\(\) - \(\$2 \|\| ' minutes'\)::interval/);
  });

  it('passes a grace window long enough never to fire during a normal pickup', async () => {
    const {svc, db} = mk();
    await push(svc, {lat: 25.15, lng: 55.25});
    const call = goLiveCall(db);
    expect(call).toBeDefined();
    const minutes = Number((call![1] as unknown[])[1]);
    expect(Number.isFinite(minutes)).toBe(true);
    expect(minutes).toBeGreaterThanOrEqual(10);
  });
});
