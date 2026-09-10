import type { TestingModule} from '@nestjs/testing';
import {Test} from '@nestjs/testing';
import {DatabaseService}      from '../database/database.service';
import {RedisService}         from '../redis/redis.service';
import {AuditService}         from '../kafka/audit.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {SosService}           from '../sos/sos.service';
import {SmsService}           from '../common/services/sms.service';
import {GeocodeService}       from './geocode.service';
import {GdeltService}         from './gdelt.service';
import {NewsDataService}      from './newsdata.service';
import {GoogleNewsService}    from './googlenews.service';
import {GeofenceService}      from './geofence.service';
import {VbgService, telemetryAad, escalationTrend, buildExecutiveSummary} from './vbg.service';
import type {SraSnapshotDto} from './vbg.service';
import type {ThreatItem} from './gdelt.service';
import {generateTelemetryKeyB64, sealTelemetry} from './telemetryCrypto';

const mockDb = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};
const mockRedis = {client: {xadd: jest.fn(), expire: jest.fn(), xrange: jest.fn()}};
const mockAudit = {emitEscalation: jest.fn()};
const mockEvents = {broadcast: jest.fn()};
const mockSos = {raise: jest.fn()};
const mockSms = {sendSms: jest.fn()};
const mockGeocode = {reverse: jest.fn()};
const mockGdelt = {threatsForRegion: jest.fn()};
const mockNewsData = {threatsForArea: jest.fn(), enabled: false};
const mockGoogleNews = {threatsForArea: jest.fn()};
const mockGeofence = {evaluate: jest.fn()};

describe('VbgService', () => {
  let service: VbgService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    // withTransaction(fn) runs fn with a tx that proxies to mockDb.q/qOne so
    // the favorites reconcile path is exercised against the same spies.
    mockDb.withTransaction.mockImplementation((fn: (tx: {q: jest.Mock; qOne: jest.Mock}) => Promise<unknown>) =>
      fn({q: mockDb.q, qOne: mockDb.qOne}));
    mockRedis.client.xadd.mockResolvedValue('1-0');
    mockRedis.client.expire.mockResolvedValue(1);
    mockRedis.client.xrange.mockResolvedValue([]);
    mockAudit.emitEscalation.mockResolvedValue(undefined);
    mockEvents.broadcast.mockResolvedValue(undefined);
    mockSos.raise.mockResolvedValue({id: 'sos-1', triggered_at: '2026-06-01T00:00:00.000Z'});
    mockSms.sendSms.mockResolvedValue({sent: true});
    mockGeocode.reverse.mockResolvedValue({region: 'Benoni', context: 'Gauteng, South Africa', country: 'ZA', lat: -26.18, lng: 28.32});
    mockGdelt.threatsForRegion.mockResolvedValue([]);
    mockNewsData.threatsForArea.mockResolvedValue([]);
    mockGoogleNews.threatsForArea.mockResolvedValue([]);
    mockGeofence.evaluate.mockResolvedValue({state: 'ok', breached: false});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VbgService,
        {provide: DatabaseService,      useValue: mockDb},
        {provide: RedisService,         useValue: mockRedis},
        {provide: AuditService,         useValue: mockAudit},
        {provide: MissionEventsService, useValue: mockEvents},
        {provide: SosService,           useValue: mockSos},
        {provide: SmsService,           useValue: mockSms},
        {provide: GeocodeService,       useValue: mockGeocode},
        {provide: GdeltService,         useValue: mockGdelt},
        {provide: NewsDataService,      useValue: mockNewsData},
        {provide: GoogleNewsService,    useValue: mockGoogleNews},
        {provide: GeofenceService,      useValue: mockGeofence},
      ],
    }).compile();
    service = module.get(VbgService);
  });

  describe('enrollMonitoring', () => {
    it('upserts the monitoring row and returns enrolled status', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        status: 'active', interval_min: 60,
        enrolled_at: new Date('2026-06-01T00:00:00Z'),
        last_heartbeat_at: new Date('2026-06-01T00:00:00Z'),
        missed_count: 0,
      });

      const res = await service.enrollMonitoring('u-1', {intervalMin: 60, lat: 1, lng: 2});

      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO public.vbg_monitoring'),
        ['u-1', 60, 1, 2],
      );
      expect(res.enrolled).toBe(true);
      expect(res.interval_min).toBe(60);
    });

    it('defaults the interval when none is supplied', async () => {
      mockDb.qOne.mockResolvedValueOnce({
        status: 'active', interval_min: 60,
        enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 0,
      });
      await service.enrollMonitoring('u-1', {});
      expect(mockDb.q).toHaveBeenCalledWith(expect.any(String), ['u-1', 60, null, null]);
    });
  });

  describe('heartbeat', () => {
    it('escalates via SosService when the window has lapsed', async () => {
      // last beat 5h ago against a 60-min interval (× 2 windows = 2h) → overdue.
      const stale = new Date(Date.now() - 5 * 60 * 60 * 1000);
      mockDb.qOne
        .mockResolvedValueOnce({interval_min: 60, last_heartbeat_at: stale, missed_count: 1, status: 'active'})
        .mockResolvedValueOnce({status: 'active', interval_min: 60, enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 0});

      await service.heartbeat('u-1', {lat: 10, lng: 20});

      expect(mockSos.raise).toHaveBeenCalledWith('u-1', expect.objectContaining({
        reason: 'vbg_biometric_missed',
        lat: 10,
        lng: 20,
      }));
      // Heartbeat still clears the counter after escalating.
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE public.vbg_monitoring'),
        ['u-1', 10, 20],
      );
    });

    it('does NOT escalate when within the window', async () => {
      const fresh = new Date(Date.now() - 10 * 60 * 1000); // 10 min ago
      mockDb.qOne
        .mockResolvedValueOnce({interval_min: 60, last_heartbeat_at: fresh, missed_count: 0, status: 'active'})
        .mockResolvedValueOnce({status: 'active', interval_min: 60, enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 0});

      await service.heartbeat('u-1', {});

      expect(mockSos.raise).not.toHaveBeenCalled();
    });

    it('is a no-op when the user is not enrolled', async () => {
      mockDb.qOne
        .mockResolvedValueOnce(null)              // no monitoring row
        .mockResolvedValueOnce(null);             // status lookup also null

      const res = await service.heartbeat('u-1', {});

      expect(mockSos.raise).not.toHaveBeenCalled();
      expect(res.enrolled).toBe(false);
    });

    it('still records the heartbeat even if escalation throws', async () => {
      const stale = new Date(Date.now() - 5 * 60 * 60 * 1000);
      mockDb.qOne
        .mockResolvedValueOnce({interval_min: 60, last_heartbeat_at: stale, missed_count: 1, status: 'active'})
        .mockResolvedValueOnce({status: 'active', interval_min: 60, enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 0});
      mockSos.raise.mockRejectedValueOnce(new Error('ops down'));

      await expect(service.heartbeat('u-1', {})).resolves.toBeDefined();
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE public.vbg_monitoring'),
        ['u-1', null, null],
      );
    });
  });

  describe('monitoringStatus', () => {
    it('returns a not-enrolled shape when no row exists', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      const res = await service.monitoringStatus('u-1');
      expect(res).toEqual({
        enrolled: false, status: null, interval_min: null, enrolled_at: null,
        last_heartbeat_at: null, missed_count: 0, overdue: false,
      });
    });
  });

  describe('sraSnapshot', () => {
    it('persists a region snapshot and scores from live threats', async () => {
      mockGeocode.reverse.mockResolvedValueOnce({region: 'Benoni', context: 'Gauteng, South Africa', country: 'ZA', lat: -26.18, lng: 28.32});
      mockGdelt.threatsForRegion.mockResolvedValueOnce([
        {title: 'Armed hijacking on Parkway', url: 'x', source: 'reuters.com', seenAt: '2026-06-01T00:00:00Z', severity: 'critical', theme: 'hijack'},
        {title: 'Mugging near mall', url: 'y', source: 'saps', seenAt: '2026-06-01T00:00:00Z', severity: 'caution', theme: 'mugging'},
      ]);
      mockDb.qOne.mockResolvedValueOnce({created_at: new Date('2026-06-01T00:00:00Z')});

      const res = await service.sraSnapshot('u-1', {lat: -26.18, lng: 28.32});

      expect(mockGeocode.reverse).toHaveBeenCalled();
      // timeWindowHours is undefined here → region-only call with no window.
      expect(mockGdelt.threatsForRegion).toHaveBeenCalledWith('Benoni', undefined);
      expect(res.region).toBe('Benoni');
      expect(res.counts).toEqual({critical: 1, caution: 1, information: 0});
      // 1 critical (×8) + 1 caution (×3) = 11 → MEDIUM band? no: 11 < 25 → LOW
      expect(res.risk_score).toBe(11);
      expect(res.level).toBe('LOW');
      expect(mockDb.qOne).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO public.vbg_sra_snapshots'),
        expect.arrayContaining(['u-1', -26.18, 28.32, 11]),
      );
    });

    it('reads LOW with a calm summary when no incidents', async () => {
      mockGdelt.threatsForRegion.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({created_at: new Date()});
      const res = await service.sraSnapshot('u-1', {lat: 1, lng: 2});
      expect(res.risk_score).toBe(0);
      expect(res.level).toBe('LOW');
      expect(res.summary).toMatch(/no significant incident signals/i);
      // Founder spec 2026-08-01 — every summary carries the full assessment
      // (75–100 words) and an escalation-trend statement.
      const wordCount = res.summary.trim().split(/\s+/).length;
      expect(wordCount).toBeGreaterThanOrEqual(75);
      expect(wordCount).toBeLessThanOrEqual(100);
      expect(res.summary).toMatch(/likelihood of escalation/i);
    });

    it('threads radius + time window into the GDELT call and summary copy', async () => {
      mockGdelt.threatsForRegion.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({created_at: new Date()});
      const res = await service.sraSnapshot('u-1', {lat: 1, lng: 2, radiusKm: 50, timeWindowHours: 48});
      // Time window is forwarded to GDELT (→ timespan); radius shapes the copy.
      expect(mockGdelt.threatsForRegion).toHaveBeenCalledWith('Benoni', 48);
      expect(res.summary).toMatch(/within 50 km of Benoni/i);
      expect(res.summary).toMatch(/in the last 48 hours/i);
    });

    it('produces DYNAMIC recommendations driven by the live risk level', async () => {
      // High violent-crime area → personal-security advice; calm area → routine.
      mockGdelt.threatsForRegion.mockResolvedValueOnce(
        Array.from({length: 4}, (_, i) => ({title: `Shooting incident ${i}`, url: `u${i}`, source: 's', seenAt: new Date().toISOString(), severity: 'critical' as const, theme: 'shooting'})),
      );
      mockDb.qOne.mockResolvedValueOnce({created_at: new Date()});
      const hot = await service.sraSnapshot('u-1', {lat: 1, lng: 2});

      mockGdelt.threatsForRegion.mockResolvedValueOnce([]);
      mockNewsData.threatsForArea.mockResolvedValueOnce([]);
      mockDb.qOne.mockResolvedValueOnce({created_at: new Date()});
      const calm = await service.sraSnapshot('u-1', {lat: 1, lng: 2});

      // They must differ, and the hot one must be more severe in tone.
      expect(hot.recommendations).not.toEqual(calm.recommendations);
      expect(hot.recommendations.join(' ')).toMatch(/avoid|defer|hotspot|after dark|alone/i);
      expect(calm.recommendations.join(' ')).toMatch(/routine|no elevated/i);
    });

    it('rejects a missing fix instead of scoring/persisting Null Island (0,0)', async () => {
      await expect(service.sraSnapshot('u-1', {})).rejects.toThrow(/location.*required/i);
      // Must not geocode, hit GDELT, or persist a snapshot.
      expect(mockGeocode.reverse).not.toHaveBeenCalled();
      expect(mockGdelt.threatsForRegion).not.toHaveBeenCalled();
      expect(mockDb.qOne).not.toHaveBeenCalled();
    });
  });

  describe('regionThreats', () => {
    it('returns region threats with severity counts', async () => {
      // seenAt must be freshness-relative: regionThreats applies a STRICT 72h
      // window against real time, so a stamped date rots the fixture out of
      // the feed within three days of writing it (this bit once already).
      mockGdelt.threatsForRegion.mockResolvedValueOnce([
        {title: 'Shooting downtown', url: 'x', source: 's', seenAt: new Date(Date.now() - 3_600_000).toISOString(), severity: 'critical', theme: 'shooting'},
      ]);
      const res = await service.regionThreats({lat: 1, lng: 2});
      expect(res.region).toBe('Benoni');
      expect(res.threats.length).toBe(1);
      expect(res.counts.critical).toBe(1);
    });

    it('forwards the time window to GDELT', async () => {
      mockGdelt.threatsForRegion.mockResolvedValueOnce([]);
      await service.regionThreats({lat: 1, lng: 2, timeWindowHours: 72});
      expect(mockGdelt.threatsForRegion).toHaveBeenCalledWith('Benoni', 72);
    });

    it('rejects a missing fix instead of querying the (0,0) region', async () => {
      await expect(service.regionThreats({})).rejects.toThrow(/location.*required/i);
      expect(mockGeocode.reverse).not.toHaveBeenCalled();
      expect(mockGdelt.threatsForRegion).not.toHaveBeenCalled();
    });

    it('blends NewsData (country-scoped) with GDELT and dedupes by headline', async () => {
      mockGeocode.reverse.mockResolvedValueOnce({region: 'Siddirganj', context: 'Narayanganj, Bangladesh', country: 'BD', lat: 23.6, lng: 90.5});
      mockGdelt.threatsForRegion.mockResolvedValueOnce([
        {title: 'Protest in city', url: 'g1', source: 'gdelt', seenAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), severity: 'caution', theme: 'protest'},
      ]);
      mockNewsData.threatsForArea.mockResolvedValueOnce([
        {title: 'Mob attacks police after murder', url: 'n1', source: 'newsdata', seenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), severity: 'critical', theme: 'murder'},
        {title: 'Protest in city', url: 'g1dup', source: 'newsdata', seenAt: new Date(Date.now() - 2.5 * 3_600_000).toISOString(), severity: 'caution', theme: 'protest'}, // dupe headline
      ]);
      const res = await service.regionThreats({lat: 23.6, lng: 90.5});
      // NewsData queried by PLACE NAMES (about the area), scoped to the country —
      // region first, then the surrounding district from the context.
      expect(mockNewsData.threatsForArea).toHaveBeenCalledWith(['Siddirganj', 'Narayanganj'], 'BD');
      // 3 in → 2 out (dedup), critical sorted first.
      expect(res.threats.length).toBe(2);
      expect(res.threats[0].severity).toBe('critical');
      expect(res.counts).toEqual({critical: 1, caution: 1, information: 0});
    });

    it('blends Google News (place-scoped) into the feed and dedupes across all sources', async () => {
      mockGeocode.reverse.mockResolvedValueOnce({region: 'Siddirganj', context: 'Narayanganj, Bangladesh', country: 'BD', lat: 23.6, lng: 90.5});
      mockGdelt.threatsForRegion.mockResolvedValueOnce([
        {title: 'Protest in city', url: 'g1', source: 'gdelt', seenAt: new Date(Date.now() - 3 * 3_600_000).toISOString(), severity: 'caution', theme: 'protest'},
      ]);
      mockNewsData.threatsForArea.mockResolvedValueOnce([]);
      mockGoogleNews.threatsForArea.mockResolvedValueOnce([
        {title: 'Armed robbery at jewellery shop', url: 'gn1', source: 'thedailystar.net', seenAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), severity: 'critical', theme: 'robbery'},
        {title: 'Protest in city', url: 'gn-dup', source: 'bdnews24', seenAt: new Date(Date.now() - 3.1 * 3_600_000).toISOString(), severity: 'caution', theme: 'protest'}, // dupe of GDELT headline
      ]);
      const res = await service.regionThreats({lat: 23.6, lng: 90.5});
      // Google News queried with the SAME place scope + country as NewsData.
      expect(mockGoogleNews.threatsForArea).toHaveBeenCalledWith(['Siddirganj', 'Narayanganj'], 'BD');
      // GDELT(1) + GoogleNews(2) = 3 in → 2 out after cross-source dedup.
      expect(res.threats.length).toBe(2);
      expect(res.threats[0].severity).toBe('critical');
      expect(res.threats.some(t => t.source === 'thedailystar.net')).toBe(true);
    });

    it('NewsData place scope is RADIUS-aware (5km = locality only; 200km = wider)', async () => {
      mockGeocode.reverse.mockResolvedValue({region: 'Siddirganj', context: 'Siddirganj, Narayanganj, Dhaka, Bangladesh', country: 'BD', lat: 23.6, lng: 90.5});
      mockDb.qOne.mockResolvedValue({created_at: new Date()});

      await service.sraSnapshot('u-1', {lat: 23.6, lng: 90.5, radiusKm: 5});
      // 5km → locality + parent (a thana alone finds no news).
      expect(mockNewsData.threatsForArea).toHaveBeenLastCalledWith(['Siddirganj', 'Narayanganj'], 'BD');

      await service.sraSnapshot('u-1', {lat: 23.6, lng: 90.5, radiusKm: 200});
      // 200km → wider: locality + district + city/division.
      expect(mockNewsData.threatsForArea).toHaveBeenLastCalledWith(['Siddirganj', 'Narayanganj', 'Dhaka'], 'BD');
    });
  });

  describe('favorites (BE-7.6)', () => {
    it('lists favorites for the user', async () => {
      mockDb.q.mockResolvedValueOnce([
        {id: 'f1', name: 'Spouse', phone: '+971500000001', position: 0},
      ]);
      const res = await service.listFavorites('u-1');
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('FROM public.vbg_favorites'),
        ['u-1'],
      );
      expect(res).toEqual([{id: 'f1', name: 'Spouse', phone: '+971500000001', position: 0}]);
    });

    it('normalizes + dedupes by E.164, caps at 3, and reconciles in a txn', async () => {
      // The final listFavorites read returns what was "persisted".
      mockDb.q.mockResolvedValue([]);
      mockDb.q.mockResolvedValueOnce(undefined as never); // DELETE (non-kept)
      // 4 inputs, two of which collapse to the same E.164 → 3 unique kept.
      await service.setFavorites('u-1', [
        {name: 'Spouse', phone: '+971 50 000 0001'},
        {name: 'Spouse dup', phone: '00971500000001'}, // same number, different format → dedupes
        {name: 'Brother', phone: '+971500000002'},
        {name: 'Mum', phone: '+971500000003'},
        {name: 'Boss', phone: '+971500000004'}, // beyond cap of 3 → dropped
      ]);

      expect(mockDb.withTransaction).toHaveBeenCalled();
      // Three upserts (one per unique kept favorite).
      const upserts = mockDb.q.mock.calls.filter(c => String(c[0]).includes('INSERT INTO public.vbg_favorites'));
      expect(upserts.length).toBe(3);
      // Positions assigned 0..2 in order.
      expect(upserts[0][1][4]).toBe(0);
      expect(upserts[2][1][4]).toBe(2);
    });

    it('clears all favorites when given an empty list', async () => {
      mockDb.q.mockResolvedValue([]);
      await service.setFavorites('u-1', []);
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM public.vbg_favorites WHERE user_id = $1'),
        ['u-1'],
      );
    });

    it('takes a per-user advisory lock inside the reconcile txn', async () => {
      mockDb.q.mockResolvedValue([]);
      await service.setFavorites('u-1', [{name: 'Spouse', phone: '+971500000001'}]);
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('pg_advisory_xact_lock'),
        ['vbg_favorites:u-1'],
      );
    });

    it('REJECTS a non-empty list whose phones are all invalid (no silent wipe)', async () => {
      mockDb.q.mockResolvedValue([]);
      // 'abc' (0 digits) + '12345' (5 digits) both fail normalizePhone.
      await expect(
        service.setFavorites('u-1', [{name: 'X', phone: 'abc'}, {name: 'Y', phone: '12345'}]),
      ).rejects.toThrow(/no valid phone/i);
      // Crucially, the wipe DELETE must NOT have run.
      const wipes = mockDb.q.mock.calls.filter(c =>
        String(c[0]).includes('DELETE FROM public.vbg_favorites WHERE user_id = $1'));
      expect(wipes.length).toBe(0);
    });
  });

  describe('keyPoints', () => {
    const realFetch = global.fetch;
    afterEach(() => { global.fetch = realFetch; });

    it('returns [] gracefully when Overpass + Mapbox both yield nothing', async () => {
      // Stub fetch so no real network call is made: Overpass returns no
      // elements, Mapbox (no token here) is skipped → empty list.
      global.fetch = jest.fn().mockResolvedValue({
        ok: true, json: async () => ({elements: []}), text: async () => '{}',
      }) as unknown as typeof fetch;
      const res = await service.keyPoints({lat: 0, lng: 0});
      expect(Array.isArray(res)).toBe(true);
      expect(res).toEqual([]);
    });

    it('maps OSM Overpass elements → key points, distance-sorted', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({elements: [
          {lat: 23.74, lon: 90.40, tags: {amenity: 'hospital', name: 'City Hospital'}},
          {lat: 23.73, lon: 90.50, tags: {amenity: 'police'}},
          {lat: 23.79, lon: 90.42, tags: {office: 'diplomatic', name: 'Embassy of X'}},
          {lat: 23.70, lon: 90.49, tags: {amenity: 'cafe', name: 'Not a keypoint'}}, // skipped
          // Audit M-1 — a hospital mapped as a WAY carries `center`, not lat/lon.
          {center: {lat: 23.72, lon: 90.45}, tags: {amenity: 'hospital', name: 'Way-Mapped General'}},
        ]}),
        text: async () => '{}',
      }) as unknown as typeof fetch;
      const res = await service.keyPoints({lat: 23.63, lng: 90.50, radiusKm: 20});
      const kinds = res.map(r => r.kind);
      expect(kinds).toContain('hospital');
      expect(kinds).toContain('police');
      expect(kinds).toContain('embassy');
      expect(kinds).not.toContain('cafe' as never);
      // The way-mapped hospital (center coords) is included — audit M-1.
      expect(res.some(r => r.label === 'Way-Mapped General')).toBe(true);
      // distance-sorted ascending
      for (let i = 1; i < res.length; i++) {expect(res[i].distanceKm).toBeGreaterThanOrEqual(res[i - 1].distanceKm);}
    });
  });

  describe('ingestTelemetry (BE-7.1/7.3)', () => {
    it('decrypts, stores, fans out WS, and runs geofence eval', async () => {
      const key = generateTelemetryKeyB64();
      const sealed = sealTelemetry(JSON.stringify({lat: -26.18, lng: 28.32}), key);
      mockDb.qOne.mockResolvedValueOnce({key_b64: key}); // device key lookup
      mockGeofence.evaluate.mockResolvedValueOnce({state: 'in_danger', breached: true});

      const res = await service.ingestTelemetry('u-1', 'dev-1', sealed);

      expect(res).toEqual({ok: true, breach: true});
      expect(mockRedis.client.xadd).toHaveBeenCalled();
      expect(mockEvents.broadcast).toHaveBeenCalledWith('vbg:u-1', 'mission.telemetry', expect.objectContaining({lat: -26.18, lng: 28.32}));
      // The SMS recipients resolve lazily inside the geofence eval (H-4).
      expect(mockGeofence.evaluate).toHaveBeenCalledWith('u-1', {lat: -26.18, lng: 28.32}, expect.any(Function));
    });

    it('audit M-5 — accepts a blob sealed with the owner-bound AAD', async () => {
      const key = generateTelemetryKeyB64();
      const sealed = sealTelemetry(JSON.stringify({lat: 1, lng: 2}), key, telemetryAad('u-1'));
      mockDb.qOne.mockResolvedValueOnce({key_b64: key});
      await expect(service.ingestTelemetry('u-1', 'dev-1', sealed)).resolves.toEqual({ok: true, breach: false});
    });

    it('audit M-5 — rejects a blob AAD-bound to a DIFFERENT user', async () => {
      const key = generateTelemetryKeyB64();
      const sealed = sealTelemetry(JSON.stringify({lat: 1, lng: 2}), key, telemetryAad('u-other'));
      mockDb.qOne.mockResolvedValueOnce({key_b64: key});
      await expect(service.ingestTelemetry('u-1', 'dev-1', sealed)).rejects.toThrow(/decrypt failed/);
    });

    it('audit M-5 — clamps an implausible recordedAt to server time', async () => {
      const key = generateTelemetryKeyB64();
      const sealed = sealTelemetry(
        JSON.stringify({lat: 1, lng: 2, recordedAt: '2020-01-01T00:00:00.000Z'}), key,
      );
      mockDb.qOne.mockResolvedValueOnce({key_b64: key});
      const before = Date.now();
      await service.ingestTelemetry('u-1', 'dev-1', sealed);
      const upsert = mockDb.q.mock.calls.find(c => String(c[0]).includes('vbg_telemetry_last'));
      expect(upsert).toBeDefined();
      const recordedAt = Date.parse(upsert![1][5] as string);
      expect(recordedAt).toBeGreaterThanOrEqual(before - 1000);
    });

    it('rejects when the device key is not enrolled', async () => {
      mockDb.qOne.mockResolvedValueOnce(null);
      await expect(service.ingestTelemetry('u-1', 'dev-1', 'x')).rejects.toThrow(/not enrolled/);
    });

    it('rejects a tampered / wrong-key ciphertext', async () => {
      const wrongKey = generateTelemetryKeyB64();
      const sealed = sealTelemetry(JSON.stringify({lat: 1, lng: 2}), generateTelemetryKeyB64());
      mockDb.qOne.mockResolvedValueOnce({key_b64: wrongKey});
      await expect(service.ingestTelemetry('u-1', 'dev-1', sealed)).rejects.toThrow(/decrypt failed/);
    });
  });

  describe('biometricCheckin (BE-7.4)', () => {
    it('resets on pass', async () => {
      mockDb.qOne.mockResolvedValueOnce({status: 'active', consecutive_fails: 2})  // checkin read
        .mockResolvedValueOnce({status: 'active', interval_min: 60, enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 0}); // status
      await service.biometricCheckin('u-1', {result: 'pass'});
      expect(mockSos.raise).not.toHaveBeenCalled();
      expect(mockDb.q).toHaveBeenCalledWith(expect.stringContaining('consecutive_fails = 0'), ['u-1']);
    });

    it('does NOT escalate on the 2nd consecutive fail', async () => {
      mockDb.qOne.mockResolvedValueOnce({status: 'active', consecutive_fails: 1})
        .mockResolvedValueOnce({status: 'active', interval_min: 60, enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 2});
      await service.biometricCheckin('u-1', {result: 'fail'});
      expect(mockSos.raise).not.toHaveBeenCalled();
      expect(mockSms.sendSms).not.toHaveBeenCalled();
    });

    it('escalates (SOS + SMS to Next-of-Kin + WS + Kafka) on the 3rd consecutive fail', async () => {
      mockDb.qOne.mockResolvedValueOnce({status: 'active', consecutive_fails: 2})
        .mockResolvedValueOnce({status: 'active', interval_min: 60, enrolled_at: new Date(), last_heartbeat_at: new Date(), missed_count: 0});
      // H-4 — the escalation SMS goes to the saved favorites, not the principal.
      mockDb.q.mockImplementation((sql: string) =>
        String(sql).includes('vbg_favorites')
          ? Promise.resolve([{phone_e164: '+971509999999'}])
          : Promise.resolve([]));
      await service.biometricCheckin('u-1', {result: 'fail'});
      expect(mockSos.raise).toHaveBeenCalledWith('u-1', expect.objectContaining({reason: 'vbg_biometric_missed'}));
      expect(mockSms.sendSms).toHaveBeenCalledWith('+971509999999', expect.any(String));
      expect(mockEvents.broadcast).toHaveBeenCalledWith('vbg:u-1', 'mission.status', expect.objectContaining({kind: 'vbg.biometric.escalation'}));
      expect(mockAudit.emitEscalation).toHaveBeenCalledWith(expect.objectContaining({type: 'biometric_missed'}));
    });
  });

  describe('panic (BE-7.1)', () => {
    it('raises SOS and fans out SMS to Next-of-Kin + WS + Kafka', async () => {
      mockDb.q.mockImplementation((sql: string) =>
        String(sql).includes('vbg_favorites')
          ? Promise.resolve([{phone_e164: '+971509999999'}, {phone_e164: '+971508888888'}])
          : Promise.resolve([]));
      const res = await service.panic('u-1', {lat: 1, lng: 2});
      expect(res.id).toBe('sos-1');
      expect(mockSos.raise).toHaveBeenCalledWith('u-1', expect.objectContaining({reason: 'vbg_panic'}));
      // H-4 — every saved favorite gets the alert.
      expect(mockSms.sendSms).toHaveBeenCalledWith('+971509999999', expect.any(String));
      expect(mockSms.sendSms).toHaveBeenCalledWith('+971508888888', expect.any(String));
      expect(mockEvents.broadcast).toHaveBeenCalledWith('vbg:u-1', 'mission.status', expect.objectContaining({kind: 'vbg.panic'}));
      expect(mockAudit.emitEscalation).toHaveBeenCalledWith(expect.objectContaining({type: 'panic'}));
    });

    it('falls back to the principal phone when no favorites are saved', async () => {
      mockDb.q.mockResolvedValue([]); // no favorites
      mockDb.qOne.mockResolvedValueOnce({phone_e164: '+971500000000'}); // users row
      await service.panic('u-1', {lat: 1, lng: 2});
      expect(mockSms.sendSms).toHaveBeenCalledWith('+971500000000', expect.any(String));
    });
  });

  describe('sweepOverdueMonitoring (H-1 watchdog)', () => {
    it('escalates an overdue enrollment: SOS + kin SMS + escalated_at marker', async () => {
      mockDb.q.mockImplementation((sql: string) => {
        const s = String(sql);
        if (s.includes('FROM public.vbg_monitoring') && s.includes('escalated_at IS NULL')) {
          return Promise.resolve([{user_id: 'u-9', missed_count: 0, lat: 1.5, lng: 2.5}]);
        }
        if (s.includes('vbg_favorites')) {
          return Promise.resolve([{phone_e164: '+971509999999'}]);
        }
        return Promise.resolve([]);
      });

      const n = await service.sweepOverdueMonitoring();

      expect(n).toBe(1);
      expect(mockSos.raise).toHaveBeenCalledWith('u-9', expect.objectContaining({
        reason: 'vbg_biometric_missed',
        payload: expect.objectContaining({source: 'vbg_watchdog'}),
      }));
      expect(mockSms.sendSms).toHaveBeenCalledWith('+971509999999', expect.any(String));
      // The silent window is marked handled so the next sweep doesn't re-fire.
      expect(mockDb.q).toHaveBeenCalledWith(
        expect.stringContaining('SET escalated_at = NOW()'),
        ['u-9'],
      );
    });

    it('does nothing when no enrollment is overdue', async () => {
      mockDb.q.mockResolvedValue([]);
      const n = await service.sweepOverdueMonitoring();
      expect(n).toBe(0);
      expect(mockSos.raise).not.toHaveBeenCalled();
    });
  });
});

// Founder spec 2026-08-01 — Executive Summary contract: full display (client),
// ~75–100 words, and an escalation-trend statement derived from the OSINT
// signals inside the selected window.
describe('executive summary (founder spec 2026-08-01)', () => {
  const threat = (hoursAgo: number, severity: ThreatItem['severity']): ThreatItem => ({
    title: `t-${hoursAgo}-${severity}`,
    url: `https://x/${hoursAgo}-${severity}`,
    source: 'src',
    seenAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
    severity,
    theme: 'crime',
  } as ThreatItem);

  const article = (n: number) => Array.from({length: n}, (_, i) => ({
    title: `a${i}`, url: `https://a/${i}`, source: 's', seenAt: new Date().toISOString(), severity: 'caution' as const,
  }));

  const risks = (violent: number, robbery: number): SraSnapshotDto['risks'] => ([
    {name: 'Violent Crime',       level: violent >= 3 ? 'high' : violent >= 1 ? 'medium' : 'low', articles: article(violent)},
    {name: 'Robbery / Theft',     level: robbery >= 4 ? 'high' : robbery >= 1 ? 'medium' : 'low', articles: article(robbery)},
    {name: 'Civil Disruption',    level: 'low', articles: []},
    {name: 'Opportunistic Crime', level: 'low', articles: []},
  ]);

  const words = (s: string): number => s.trim().split(/\s+/).length;

  describe('escalationTrend', () => {
    it('reads increasing when the newer half of the window carries more weighted signal', () => {
      const t = [threat(2, 'critical'), threat(4, 'critical'), threat(60, 'caution')];
      expect(escalationTrend(t, 72)).toBe('increasing');
    });

    it('reads decreasing when the older half dominates', () => {
      const t = [threat(60, 'critical'), threat(70, 'critical'), threat(2, 'caution')];
      expect(escalationTrend(t, 72)).toBe('decreasing');
    });

    it('reads stable inside the dead band and on an empty window', () => {
      const t = [threat(10, 'caution'), threat(50, 'caution')];
      expect(escalationTrend(t, 72)).toBe('stable');
      expect(escalationTrend([], 72)).toBe('stable');
    });

    it('skips undated and out-of-window items rather than guessing', () => {
      const undated = {...threat(1, 'critical'), seenAt: 'not-a-date'};
      const ancient = threat(500, 'critical');
      expect(escalationTrend([undated, ancient], 24)).toBe('stable');
    });
  });

  describe('buildExecutiveSummary', () => {
    const base = {scope: 'within 50 km of Zayed Military City', window: 'in the last 72 hours'};

    it('elevated case: 75–100 words, names the counts, patterns, and rising escalation', () => {
      const s = buildExecutiveSummary({
        ...base,
        counts: {critical: 7, caution: 15, information: 3},
        level: 'CRITICAL',
        risks: risks(6, 4),
        trend: 'increasing',
      });
      expect(words(s)).toBeGreaterThanOrEqual(75);
      expect(words(s)).toBeLessThanOrEqual(100);
      expect(s).toContain('within 50 km of Zayed Military City');
      expect(s).toContain('7 serious and 15 cautionary');
      expect(s).toContain('violent crime');
      expect(s).toContain('likelihood of escalation is assessed as increasing');
    });

    it('quiet case: still 75–100 words with a stable-trend statement', () => {
      const s = buildExecutiveSummary({
        scope: 'in Benoni',
        window: 'in the last 24 hours',
        counts: {critical: 0, caution: 0, information: 2},
        level: 'LOW',
        risks: risks(0, 0),
        trend: 'stable',
      });
      expect(words(s)).toBeGreaterThanOrEqual(75);
      expect(words(s)).toBeLessThanOrEqual(100);
      expect(s).toContain('no significant incident signals');
      expect(s).toContain('likelihood of escalation is assessed as remaining stable');
    });

    it('moderate scattered case sits in the band and reports decreasing when signals fade', () => {
      const s = buildExecutiveSummary({
        ...base,
        counts: {critical: 1, caution: 3, information: 0},
        level: 'MEDIUM',
        risks: risks(0, 0),
        trend: 'decreasing',
      });
      expect(words(s)).toBeGreaterThanOrEqual(75);
      expect(words(s)).toBeLessThanOrEqual(100);
      expect(s).toContain('No single risk pattern dominates');
      expect(s).toContain('likelihood of escalation is assessed as decreasing');
    });

    it('single dominant category reads naturally and stays in the band', () => {
      const s = buildExecutiveSummary({
        ...base,
        counts: {critical: 2, caution: 1, information: 0},
        level: 'HIGH',
        risks: risks(3, 0),
        trend: 'stable',
      });
      expect(words(s)).toBeGreaterThanOrEqual(75);
      expect(words(s)).toBeLessThanOrEqual(100);
      expect(s).toContain('violent crime (3 reports)');
    });
  });
});

