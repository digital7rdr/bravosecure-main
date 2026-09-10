/**
 * Issue 30 — Pro fleet + resources (Layer 1). DatabaseService is mocked, so the
 * SQL text and bind values ARE the pinned behavior (same rationale as
 * pro-management.dedicated.spec.ts / pro-applications.service.spec.ts).
 *
 * Covers:
 *  - catalog create inserts the right columns;
 *  - vehicle-assign scopes by application_id, writes the date window, and
 *    marks the row ASSIGNED;
 *  - a Postgres gist clash (23P01) on vehicle-assign surfaces as HTTP 409;
 *  - the client projection (ProApplicationsService.listTeam) exposes the
 *    vehicle `plate` (Issue-30 headline) but WITHHOLDS the resource
 *    `identifier` (ops-internal serial);
 *  - every mutation carries @RequireRoles('SUPERVISOR','ADMIN') and records the
 *    right ops_audit action.
 */
import 'reflect-metadata';
import {ConflictException} from '@nestjs/common';
import {ProFleetService} from './pro-fleet.service';
import {ProFleetOpsController} from './pro-fleet-ops.controller';
import {ProApplicationsService} from '../pro-applications/pro-applications.service';
import {REQUIRED_ROLES_KEY, type AdminContext} from '../ops/admin.guard';
import type {DatabaseService} from '../database/database.service';

const ADMIN: AdminContext = {user_id: 'adm-1', role: 'SUPERVISOR', call_sign: 'OPS-2', region: 'AE'};

// ─── Service-level SQL-text pins ─────────────────────────────────────────────

function mkFleet(opts: {assignError?: {code: string}} = {}) {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qOneCalls.push({sql, params});
      if (/SELECT id FROM pro_applications/.test(sql)) {return Promise.resolve({id: 'app-1'});}
      if (/SELECT active FROM/.test(sql)) {return Promise.resolve({active: true});}
      // Same-plan pin (#11): only 'cpo-inplan' is a detail OF this plan; any other
      // CPO id is a cross-plan pin and the query (id AND application_id) misses.
      if (/SELECT id FROM pro_cpo_assignments/.test(sql)) {
        return Promise.resolve(params?.[0] === 'cpo-inplan' ? {id: 'cpo-inplan'} : null);
      }
      if (/INSERT INTO pro_vehicle_assignments/.test(sql)) {
        if (opts.assignError) {return Promise.reject(opts.assignError);}
        return Promise.resolve({id: 'va-1', application_id: 'app-1', vehicle_id: 'veh-1'});
      }
      if (/INSERT INTO pro_resource_assignments/.test(sql)) {
        return Promise.resolve({id: 'ra-1', application_id: 'app-1', resource_id: 'res-1'});
      }
      if (/INSERT INTO pro_fleet_vehicles/.test(sql)) {return Promise.resolve({id: 'veh-1'});}
      if (/INSERT INTO pro_resources/.test(sql)) {return Promise.resolve({id: 'res-1'});}
      if (/UPDATE pro_vehicle_assignments/.test(sql)) {
        return Promise.resolve({id: 'va-1', application_id: 'app-1', vehicle_id: 'veh-1'});
      }
      if (/UPDATE pro_resource_assignments/.test(sql)) {
        return Promise.resolve({id: 'ra-1', application_id: 'app-1', resource_id: 'res-1'});
      }
      return Promise.resolve(null);
    }),
  } as unknown as DatabaseService;
  return {svc: new ProFleetService(db), qCalls, qOneCalls};
}

describe('ProFleetService — catalog creates', () => {
  it('createVehicle inserts call_sign/make_model/plate + created_by', async () => {
    const {svc, qOneCalls} = mkFleet();
    await svc.createVehicle(ADMIN, {call_sign: 'V1', make_model: 'Suburban', plate: 'ABC-123'} as never);
    const ins = qOneCalls.find(c => /INSERT INTO pro_fleet_vehicles/.test(c.sql))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toMatch(/call_sign, make_model, plate/);
    expect(ins.params).toEqual(['V1', 'Suburban', 'ABC-123', null, null, null, null, null, null, 'adm-1']);
  });

  it('createResource inserts kind/label + carries the ops-internal identifier', async () => {
    const {svc, qOneCalls} = mkFleet();
    await svc.createResource(ADMIN, {kind: 'comms', label: 'Radio set', identifier: 'SN-9'} as never);
    const ins = qOneCalls.find(c => /INSERT INTO pro_resources/.test(c.sql))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toMatch(/kind, label, identifier/);
    expect(ins.params).toEqual(['comms', 'Radio set', 'SN-9', null, 'adm-1']);
  });
});

describe('ProFleetService — vehicle assignment', () => {
  it('scopes by application_id, writes the date window, and marks the row ASSIGNED', async () => {
    const {svc, qOneCalls} = mkFleet();
    await svc.assignVehicle(ADMIN, 'app-1', {
      vehicle_id: 'veh-1', starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never);
    const ins = qOneCalls.find(c => /INSERT INTO pro_vehicle_assignments/.test(c.sql))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toMatch(/'ASSIGNED'/);
    // application_id, vehicle_id, assignment_id(null), starts_on, ends_on, note(null), assigned_by
    expect(ins.params).toEqual(['app-1', 'veh-1', null, '2030-01-10', '2030-01-12', null, 'adm-1']);
  });

  it('a Postgres gist clash (23P01) surfaces as HTTP 409', async () => {
    const {svc} = mkFleet({assignError: {code: '23P01'}});
    await expect(svc.assignVehicle(ADMIN, 'app-1', {
      vehicle_id: 'veh-1', starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never)).rejects.toBeInstanceOf(ConflictException);
  });

  it('accepts an assignment_id that is a CPO detail OF this plan', async () => {
    const {svc, qOneCalls} = mkFleet();
    await svc.assignVehicle(ADMIN, 'app-1', {
      vehicle_id: 'veh-1', assignment_id: 'cpo-inplan',
      starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never);
    const ins = qOneCalls.find(c => /INSERT INTO pro_vehicle_assignments/.test(c.sql))!;
    expect(ins.params).toEqual(['app-1', 'veh-1', 'cpo-inplan', '2030-01-10', '2030-01-12', null, 'adm-1']);
  });

  it('REJECTS an assignment_id from a DIFFERENT plan (no cross-plan pin) and never inserts', async () => {
    const {svc, qOneCalls} = mkFleet();
    await expect(svc.assignVehicle(ADMIN, 'app-1', {
      vehicle_id: 'veh-1', assignment_id: 'cpo-otherplan',
      starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never)).rejects.toThrow('assignment_plan_mismatch');
    expect(qOneCalls.some(c => /INSERT INTO pro_vehicle_assignments/.test(c.sql))).toBe(false);
  });

  it('release flips ASSIGNED → RELEASED (guarded on the live status) and stamps released_at', async () => {
    const {svc, qOneCalls} = mkFleet();
    const out = await svc.releaseVehicle(ADMIN, 'va-1');
    expect(out.assignment.id).toBe('va-1');
    const upd = qOneCalls.find(c => /UPDATE pro_vehicle_assignments/.test(c.sql))!;
    expect(upd).toBeDefined();
    expect(upd.sql).toMatch(/status = 'RELEASED'/);
    expect(upd.sql).toMatch(/released_at = now\(\)/);
    expect(upd.sql).toMatch(/WHERE pva\.id = \$1 AND pva\.status = 'ASSIGNED'/);
  });
});

describe('ProFleetService — resource assignment (qty, no exclusivity)', () => {
  it('scopes by application_id, defaults qty via COALESCE, marks ASSIGNED', async () => {
    const {svc, qOneCalls} = mkFleet();
    await svc.assignResource(ADMIN, 'app-1', {
      resource_id: 'res-1', starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never);
    const ins = qOneCalls.find(c => /INSERT INTO pro_resource_assignments/.test(c.sql))!;
    expect(ins).toBeDefined();
    expect(ins.sql).toMatch(/COALESCE\(\$4,1\)/);
    expect(ins.sql).toMatch(/'ASSIGNED'/);
    // application_id, resource_id, assignment_id(null), qty(null→COALESCE), starts, ends, note(null), assigned_by
    expect(ins.params).toEqual(['app-1', 'res-1', null, null, '2030-01-10', '2030-01-12', null, 'adm-1']);
  });

  it('REJECTS an assignment_id from a DIFFERENT plan and never inserts', async () => {
    const {svc, qOneCalls} = mkFleet();
    await expect(svc.assignResource(ADMIN, 'app-1', {
      resource_id: 'res-1', assignment_id: 'cpo-otherplan',
      starts_on: '2030-01-10', ends_on: '2030-01-12',
    } as never)).rejects.toThrow('assignment_plan_mismatch');
    expect(qOneCalls.some(c => /INSERT INTO pro_resource_assignments/.test(c.sql))).toBe(false);
  });
});

// ─── Client projection (listTeam): plate shown, identifier withheld ──────────

function mkProApps() {
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM pro_applications WHERE id/.test(sql)) {
        return Promise.resolve({id: 'app-1', user_id: 'client-1', status: 'ACTIVE'});
      }
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn(),
  } as unknown as DatabaseService;
  const svc = new ProApplicationsService(
    db, {} as never, {} as never,
    {broadcast: jest.fn().mockResolvedValue(undefined)} as never,
    {} as never,
  );
  return {svc, qCalls};
}

describe('ProApplicationsService.listTeam — Issue 30 client projection', () => {
  it('returns team + vehicles + resources in one round-trip', async () => {
    const {svc} = mkProApps();
    const out = await svc.listTeam('client-1', 'app-1');
    expect(out).toHaveProperty('team');
    expect(out).toHaveProperty('vehicles');
    expect(out).toHaveProperty('resources');
  });

  it('vehicles projection EXPOSES plate (Issue-30 headline) with live_today', async () => {
    const {svc, qCalls} = mkProApps();
    await svc.listTeam('client-1', 'app-1');
    const vq = qCalls.find(c => /FROM pro_vehicle_assignments/.test(c.sql))!;
    expect(vq).toBeDefined();
    expect(vq.sql).toMatch(/v\.plate/);
    expect(vq.sql).toMatch(/status = 'ASSIGNED'/);
    expect(vq.sql).toMatch(/AS live_today/);
    expect(vq.params).toEqual(['app-1']);
  });

  it('resources projection WITHHOLDS the ops-internal identifier (serial)', async () => {
    const {svc, qCalls} = mkProApps();
    await svc.listTeam('client-1', 'app-1');
    const rq = qCalls.find(c => /FROM pro_resource_assignments/.test(c.sql))!;
    expect(rq).toBeDefined();
    expect(rq.sql).toMatch(/r\.kind/);
    expect(rq.sql).toMatch(/r\.label/);
    expect(rq.sql).toMatch(/pra\.qty/);
    // The serial must never reach the member (same discipline as mission_code).
    expect(rq.sql).not.toMatch(/identifier/);
    expect(rq.params).toEqual(['app-1']);
  });
});

// ─── Controller: authorization + audit attribution ──────────────────────────

function mkCtrl() {
  const fleet = {
    createVehicle: jest.fn().mockResolvedValue({vehicle: {id: 'veh-1'}}),
    updateVehicle: jest.fn().mockResolvedValue({vehicle: {id: 'veh-1'}}),
    createResource: jest.fn().mockResolvedValue({resource: {id: 'res-1'}}),
    updateResource: jest.fn().mockResolvedValue({resource: {id: 'res-1'}}),
    assignVehicle: jest.fn().mockResolvedValue({assignment: {id: 'va-1', application_id: 'app-1', vehicle_id: 'veh-1'}}),
    releaseVehicle: jest.fn().mockResolvedValue({assignment: {id: 'va-1', application_id: 'app-9', vehicle_id: 'veh-1'}}),
    assignResource: jest.fn().mockResolvedValue({assignment: {id: 'ra-1', application_id: 'app-1', resource_id: 'res-1'}}),
    releaseResource: jest.fn().mockResolvedValue({assignment: {id: 'ra-1', application_id: 'app-9', resource_id: 'res-1'}}),
  };
  const audit = {recordAdmin: jest.fn().mockResolvedValue(undefined)};
  const ctrl = new ProFleetOpsController(fleet as never, audit as never);
  return {ctrl, fleet, audit};
}

const req = {admin: ADMIN} as never;

describe('ProFleetOpsController — audit attribution', () => {
  it('vehicle create records pro_fleet.create against the new vehicle', async () => {
    const {ctrl, audit} = mkCtrl();
    await ctrl.createVehicle({call_sign: 'V1', plate: 'ABC-123'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_fleet.create', 'system', 'veh-1', expect.objectContaining({plate: 'ABC-123'}));
  });

  it('resource create records pro_resource.create against the new resource', async () => {
    const {ctrl, audit} = mkCtrl();
    await ctrl.createResource({kind: 'comms', label: 'Radio'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_resource.create', 'system', 'res-1', expect.objectContaining({kind: 'comms'}));
  });

  it('vehicle assign records pro_vehicle.assign against the application', async () => {
    const {ctrl, audit} = mkCtrl();
    await ctrl.assignVehicle('app-1', {vehicle_id: 'veh-1', starts_on: '2030-01-10', ends_on: '2030-01-12'} as never, req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_vehicle.assign', 'application', 'app-1', expect.objectContaining({vehicle_id: 'veh-1'}));
  });

  it('vehicle release records pro_vehicle.release against the assignment’s application', async () => {
    const {ctrl, audit} = mkCtrl();
    await ctrl.releaseVehicle('va-1', req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_vehicle.release', 'application', 'app-9', expect.objectContaining({assignment_id: 'va-1'}));
  });

  it('resource assign / release record against the application', async () => {
    const {ctrl, audit} = mkCtrl();
    await ctrl.assignResource('app-1', {resource_id: 'res-1', starts_on: '2030-01-10', ends_on: '2030-01-12'} as never, req);
    await ctrl.releaseResource('ra-1', req);
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_resource.assign', 'application', 'app-1', expect.objectContaining({resource_id: 'res-1'}));
    expect(audit.recordAdmin).toHaveBeenCalledWith(
      ADMIN, 'pro_resource.release', 'application', 'app-9', expect.objectContaining({assignment_id: 'ra-1'}));
  });
});

describe('ProFleetOpsController — every mutation is SUPERVISOR/ADMIN gated', () => {
  const roles = (m: unknown) => Reflect.getMetadata(REQUIRED_ROLES_KEY, m as object) as string[] | undefined;
  const P = ProFleetOpsController.prototype;

  it.each([
    ['createVehicle', P.createVehicle],
    ['updateVehicle', P.updateVehicle],
    ['createResource', P.createResource],
    ['updateResource', P.updateResource],
    ['assignVehicle', P.assignVehicle],
    ['releaseVehicle', P.releaseVehicle],
    ['assignResource', P.assignResource],
    ['releaseResource', P.releaseResource],
  ])('%s requires SUPERVISOR/ADMIN', (_name, method) => {
    expect(roles(method)).toEqual(['SUPERVISOR', 'ADMIN']);
  });

  it.each([
    ['listFleet', P.listFleet],
    ['listResources', P.listResources],
    ['applicationVehicles', P.applicationVehicles],
    ['applicationResources', P.applicationResources],
  ])('%s is a read (no role gate)', (_name, method) => {
    expect(roles(method)).toBeUndefined();
  });
});
