import type { TestingModule} from '@nestjs/testing';
import {Test} from '@nestjs/testing';
import {DatabaseService}      from '../database/database.service';
import {AuditService}         from '../kafka/audit.service';
import {OpsAuditService}      from '../ops/ops-audit.service';
import {MissionEventsService} from '../ops/mission-events.service';
import {SmsService}           from '../common/services/sms.service';
import {GeofenceService}      from './geofence.service';

const mockDb = {q: jest.fn(), qOne: jest.fn()};
const mockAudit = {emitEscalation: jest.fn()};
const mockOps = {emit: jest.fn()};
const mockEvents = {broadcast: jest.fn()};
const mockSms = {sendSms: jest.fn()};

describe('GeofenceService', () => {
  let svc: GeofenceService;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockDb.q.mockResolvedValue([]);
    mockAudit.emitEscalation.mockResolvedValue(undefined);
    mockOps.emit.mockResolvedValue(undefined);
    mockEvents.broadcast.mockResolvedValue(undefined);
    mockSms.sendSms.mockResolvedValue({sent: true});

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GeofenceService,
        {provide: DatabaseService,      useValue: mockDb},
        {provide: AuditService,         useValue: mockAudit},
        {provide: OpsAuditService,      useValue: mockOps},
        {provide: MissionEventsService, useValue: mockEvents},
        {provide: SmsService,           useValue: mockSms},
      ],
    }).compile();
    svc = module.get(GeofenceService);
  });

  it('fires escalation ONCE on transition into a danger zone', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({n: 1})                                                      // active-zone count
      .mockResolvedValueOnce({id: 'z1', name: 'Hotspot', kind: 'danger', active: true}) // inDanger
      .mockResolvedValueOnce({total: 0, inside: 0})                                       // safe summary
      .mockResolvedValueOnce({last_zone_state: 'ok'});                                    // prev state

    const res = await svc.evaluate('u-1', {lat: 1, lng: 2}, async () => ['+971500000000']);

    expect(res.breached).toBe(true);
    expect(mockAudit.emitEscalation).toHaveBeenCalledWith(expect.objectContaining({type: 'geofence_breach'}));
    expect(mockEvents.broadcast).toHaveBeenCalledWith('vbg:u-1', 'mission.status', expect.objectContaining({kind: 'vbg.breach'}));
    expect(mockSms.sendSms).toHaveBeenCalledWith('+971500000000', expect.any(String));
  });

  it('does NOT re-fire while still inside the same danger zone', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({n: 1})
      .mockResolvedValueOnce({id: 'z1', name: 'Hotspot', kind: 'danger', active: true})
      .mockResolvedValueOnce({total: 0, inside: 0})
      .mockResolvedValueOnce({last_zone_state: 'in_danger'}); // already in danger

    const res = await svc.evaluate('u-1', {lat: 1, lng: 2}, async () => ['+971500000000']);

    expect(res.breached).toBe(false);
    expect(mockAudit.emitEscalation).not.toHaveBeenCalled();
  });

  it('treats leaving all safe zones as a breach', async () => {
    mockDb.qOne
      .mockResolvedValueOnce({n: 2})
      .mockResolvedValueOnce(null)                       // not in danger
      .mockResolvedValueOnce({total: 2, inside: 0})      // has safe zones, inside none
      .mockResolvedValueOnce({last_zone_state: 'ok'});

    const res = await svc.evaluate('u-1', {lat: 1, lng: 2});
    expect(res.state).toBe('outside_safe');
    expect(res.breached).toBe(true);
  });

  it('audit M-6 — skips the PostGIS eval entirely when the user has no zones', async () => {
    mockDb.qOne.mockResolvedValueOnce({n: 0}); // active-zone count

    const res = await svc.evaluate('u-1', {lat: 1, lng: 2}, async () => ['+971500000000']);

    expect(res).toEqual({state: 'ok', breached: false});
    // Only the count query ran — no containment / state queries, no fan-out.
    expect(mockDb.qOne).toHaveBeenCalledTimes(1);
    expect(mockDb.q).not.toHaveBeenCalled();
    expect(mockAudit.emitEscalation).not.toHaveBeenCalled();
  });

  it('rejects a geofence ring with < 3 valid points', async () => {
    await expect(svc.createZone('u-1', {name: 'x', kind: 'safe', ring: [[1, 2]]}))
      .rejects.toThrow(/at least 3/);
  });
});
