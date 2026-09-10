import {
  BadRequestException, ConflictException, Injectable, NotFoundException,
} from '@nestjs/common';
import {DatabaseService} from '../database/database.service';
import {type AdminContext} from '../ops/admin.guard';
import {
  AssignProResourceDto, AssignProVehicleDto, CreateProFleetVehicleDto,
  CreateProResourceDto, UpdateProFleetVehicleDto, UpdateProResourceDto,
} from './dto/pro-management.dto';

// Ops-visible column sets. Dates cast to text so JSON carries 'YYYY-MM-DD'
// (matching pro-management.service.ts / pro-applications.service.ts).
const VEHICLE_COLS = `
  id, call_sign, make_model, plate, colour, armored, armor_grade,
  capacity, region_code, active, notes, created_at, updated_at
`;
const RESOURCE_COLS = `
  id, kind, label, identifier, active, notes, created_at, updated_at
`;
const VEHICLE_ASSIGNMENT_COLS = `
  pva.id, pva.application_id, pva.vehicle_id, pva.assignment_id,
  pva.starts_on::text AS starts_on, pva.ends_on::text AS ends_on,
  pva.status, pva.note, pva.created_at, pva.released_at
`;
const RESOURCE_ASSIGNMENT_COLS = `
  pra.id, pra.application_id, pra.resource_id, pra.assignment_id, pra.qty,
  pra.starts_on::text AS starts_on, pra.ends_on::text AS ends_on,
  pra.status, pra.note, pra.created_at, pra.released_at
`;

export interface VehicleAssignmentRow {id: string; application_id: string; vehicle_id: string}
export interface ResourceAssignmentRow {id: string; application_id: string; resource_id: string}

/**
 * Ops-side Pro fleet + resources (Issue 30): two catalogs and two plan-scoped
 * link tables. Vehicle assignments are exclusivity-safe via a DB gist exclusion
 * (23P01 → 409). Resources carry a per-assignment qty and no exclusivity. The
 * client never touches this service directly — it reads a projection through
 * ProApplicationsService.listTeam (serial/identifier withheld there).
 */
@Injectable()
export class ProFleetService {
  constructor(private readonly db: DatabaseService) {}

  // ─── Vehicle catalog ───────────────────────────────────────────────────────

  async listFleet(includeInactive = false): Promise<{vehicles: Array<Record<string, unknown>>}> {
    const where = includeInactive ? '' : 'WHERE active = TRUE';
    const vehicles = await this.db.q(
      `SELECT ${VEHICLE_COLS} FROM pro_fleet_vehicles ${where}
        ORDER BY active DESC, call_sign ASC LIMIT 500`,
    );
    return {vehicles};
  }

  async createVehicle(admin: AdminContext, dto: CreateProFleetVehicleDto): Promise<{vehicle: Record<string, unknown>}> {
    try {
      const vehicle = await this.db.qOne(
        `INSERT INTO pro_fleet_vehicles
           (call_sign, make_model, plate, colour, armored, armor_grade,
            capacity, region_code, notes, created_by)
         VALUES ($1,$2,$3,$4,COALESCE($5,true),$6,COALESCE($7,4),$8,$9,$10)
         RETURNING ${VEHICLE_COLS}`,
        [
          dto.call_sign, dto.make_model, dto.plate, dto.colour ?? null,
          dto.armored ?? null, dto.armor_grade ?? null, dto.capacity ?? null,
          dto.region_code ?? null, dto.notes ?? null, admin.user_id,
        ],
      );
      return {vehicle: vehicle!};
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('call_sign_taken');
      }
      throw e;
    }
  }

  async updateVehicle(admin: AdminContext, id: string, dto: UpdateProFleetVehicleDto): Promise<{vehicle: Record<string, unknown>}> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {sets.push(`${col} = $${params.length + 1}`); params.push(val);};
    if (dto.call_sign !== undefined) {set('call_sign', dto.call_sign);}
    if (dto.make_model !== undefined) {set('make_model', dto.make_model);}
    if (dto.plate !== undefined) {set('plate', dto.plate);}
    if (dto.colour !== undefined) {set('colour', dto.colour);}
    if (dto.armored !== undefined) {set('armored', dto.armored);}
    if (dto.armor_grade !== undefined) {set('armor_grade', dto.armor_grade);}
    if (dto.capacity !== undefined) {set('capacity', dto.capacity);}
    if (dto.region_code !== undefined) {set('region_code', dto.region_code);}
    if (dto.active !== undefined) {set('active', dto.active);}
    if (dto.notes !== undefined) {set('notes', dto.notes);}
    if (sets.length === 0) {throw new BadRequestException('no_fields');}
    sets.push('updated_at = now()');
    params.push(id);
    try {
      const vehicle = await this.db.qOne(
        `UPDATE pro_fleet_vehicles SET ${sets.join(', ')}
          WHERE id = $${params.length} RETURNING ${VEHICLE_COLS}`,
        params,
      );
      if (!vehicle) {throw new NotFoundException('vehicle_not_found');}
      return {vehicle};
    } catch (e) {
      if ((e as {code?: string}).code === '23505') {
        throw new ConflictException('call_sign_taken');
      }
      throw e;
    }
  }

  // ─── Resource catalog ──────────────────────────────────────────────────────

  async listResources(includeInactive = false): Promise<{resources: Array<Record<string, unknown>>}> {
    const where = includeInactive ? '' : 'WHERE active = TRUE';
    const resources = await this.db.q(
      `SELECT ${RESOURCE_COLS} FROM pro_resources ${where}
        ORDER BY active DESC, kind ASC, label ASC LIMIT 500`,
    );
    return {resources};
  }

  async createResource(admin: AdminContext, dto: CreateProResourceDto): Promise<{resource: Record<string, unknown>}> {
    const resource = await this.db.qOne(
      `INSERT INTO pro_resources (kind, label, identifier, notes, created_by)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING ${RESOURCE_COLS}`,
      [dto.kind, dto.label, dto.identifier ?? null, dto.notes ?? null, admin.user_id],
    );
    return {resource: resource!};
  }

  async updateResource(admin: AdminContext, id: string, dto: UpdateProResourceDto): Promise<{resource: Record<string, unknown>}> {
    const sets: string[] = [];
    const params: unknown[] = [];
    const set = (col: string, val: unknown) => {sets.push(`${col} = $${params.length + 1}`); params.push(val);};
    if (dto.kind !== undefined) {set('kind', dto.kind);}
    if (dto.label !== undefined) {set('label', dto.label);}
    if (dto.identifier !== undefined) {set('identifier', dto.identifier);}
    if (dto.active !== undefined) {set('active', dto.active);}
    if (dto.notes !== undefined) {set('notes', dto.notes);}
    if (sets.length === 0) {throw new BadRequestException('no_fields');}
    sets.push('updated_at = now()');
    params.push(id);
    const resource = await this.db.qOne(
      `UPDATE pro_resources SET ${sets.join(', ')}
        WHERE id = $${params.length} RETURNING ${RESOURCE_COLS}`,
      params,
    );
    if (!resource) {throw new NotFoundException('resource_not_found');}
    return {resource};
  }

  // ─── Vehicle assignments ─────────────────────────────────────────────────────

  async listApplicationVehicles(applicationId: string): Promise<{assignments: Array<Record<string, unknown>>}> {
    const assignments = await this.db.q(
      `SELECT ${VEHICLE_ASSIGNMENT_COLS},
              v.call_sign, v.make_model, v.plate, v.colour, v.armored, v.armor_grade, v.capacity
         FROM pro_vehicle_assignments pva
         JOIN pro_fleet_vehicles v ON v.id = pva.vehicle_id
        WHERE pva.application_id = $1
        ORDER BY pva.status = 'ASSIGNED' DESC, pva.starts_on DESC
        LIMIT 200`,
      [applicationId],
    );
    return {assignments};
  }

  async assignVehicle(admin: AdminContext, applicationId: string, dto: AssignProVehicleDto): Promise<{assignment: VehicleAssignmentRow}> {
    if (dto.ends_on < dto.starts_on) {throw new BadRequestException('ends_before_starts');}
    await this.assertApplication(applicationId);
    await this.assertActiveCatalogRow('pro_fleet_vehicles', dto.vehicle_id, 'vehicle_not_found');
    if (dto.assignment_id) {await this.assertAssignmentInPlan(dto.assignment_id, applicationId);}
    try {
      const assignment = await this.db.qOne<VehicleAssignmentRow>(
        `INSERT INTO pro_vehicle_assignments
           (application_id, vehicle_id, assignment_id, starts_on, ends_on, status, note, assigned_by)
         VALUES ($1,$2,$3,$4,$5,'ASSIGNED',$6,$7)
         RETURNING ${VEHICLE_ASSIGNMENT_COLS.replace(/pva\./g, '')}`,
        [
          applicationId, dto.vehicle_id, dto.assignment_id ?? null,
          dto.starts_on, dto.ends_on, dto.note ?? null, admin.user_id,
        ],
      );
      return {assignment: assignment!};
    } catch (e) {
      // A physical vehicle can't be two places: the gist exclusion (23P01) is
      // the race-proof authority — surface it as the same 409 the CPO overlap
      // uses (mirrors pro-management.service.ts insertAssignment).
      if ((e as {code?: string}).code === '23P01') {
        throw new ConflictException('vehicle_unavailable_overlap');
      }
      throw e;
    }
  }

  async releaseVehicle(admin: AdminContext, id: string): Promise<{assignment: VehicleAssignmentRow}> {
    const row = await this.db.qOne<VehicleAssignmentRow>(
      `UPDATE pro_vehicle_assignments pva
          SET status = 'RELEASED', released_at = now(), updated_at = now()
        WHERE pva.id = $1 AND pva.status = 'ASSIGNED'
        RETURNING ${VEHICLE_ASSIGNMENT_COLS.replace(/pva\./g, '')}`,
      [id],
    );
    if (!row) {throw new BadRequestException('vehicle_assignment_not_active');}
    return {assignment: row};
  }

  // ─── Resource assignments ─────────────────────────────────────────────────────

  async listApplicationResources(applicationId: string): Promise<{assignments: Array<Record<string, unknown>>}> {
    const assignments = await this.db.q(
      `SELECT ${RESOURCE_ASSIGNMENT_COLS},
              r.kind, r.label, r.identifier
         FROM pro_resource_assignments pra
         JOIN pro_resources r ON r.id = pra.resource_id
        WHERE pra.application_id = $1
        ORDER BY pra.status = 'ASSIGNED' DESC, pra.starts_on DESC
        LIMIT 200`,
      [applicationId],
    );
    return {assignments};
  }

  async assignResource(admin: AdminContext, applicationId: string, dto: AssignProResourceDto): Promise<{assignment: ResourceAssignmentRow}> {
    if (dto.ends_on < dto.starts_on) {throw new BadRequestException('ends_before_starts');}
    await this.assertApplication(applicationId);
    await this.assertActiveCatalogRow('pro_resources', dto.resource_id, 'resource_not_found');
    if (dto.assignment_id) {await this.assertAssignmentInPlan(dto.assignment_id, applicationId);}
    const assignment = await this.db.qOne<ResourceAssignmentRow>(
      `INSERT INTO pro_resource_assignments
         (application_id, resource_id, assignment_id, qty, starts_on, ends_on, status, note, assigned_by)
       VALUES ($1,$2,$3,COALESCE($4,1),$5,$6,'ASSIGNED',$7,$8)
       RETURNING ${RESOURCE_ASSIGNMENT_COLS.replace(/pra\./g, '')}`,
      [
        applicationId, dto.resource_id, dto.assignment_id ?? null, dto.qty ?? null,
        dto.starts_on, dto.ends_on, dto.note ?? null, admin.user_id,
      ],
    );
    return {assignment: assignment!};
  }

  async releaseResource(admin: AdminContext, id: string): Promise<{assignment: ResourceAssignmentRow}> {
    const row = await this.db.qOne<ResourceAssignmentRow>(
      `UPDATE pro_resource_assignments pra
          SET status = 'RELEASED', released_at = now(), updated_at = now()
        WHERE pra.id = $1 AND pra.status = 'ASSIGNED'
        RETURNING ${RESOURCE_ASSIGNMENT_COLS.replace(/pra\./g, '')}`,
      [id],
    );
    if (!row) {throw new BadRequestException('resource_assignment_not_active');}
    return {assignment: row};
  }

  // ─── helpers ─────────────────────────────────────────────────────────────────

  private async assertApplication(applicationId: string): Promise<void> {
    const app = await this.db.qOne<{id: string}>(
      `SELECT id FROM pro_applications WHERE id = $1`, [applicationId]);
    if (!app) {throw new NotFoundException('pro_application_not_found');}
  }

  // An optional assignment_id pins a vehicle/resource to a specific CPO detail —
  // but only within THIS plan. The FK alone enforces existence, not same-plan, so
  // a CPO id from a different application must be rejected here (else the link
  // silently cross-plans; decision #3 means "a detail OF this plan").
  private async assertAssignmentInPlan(assignmentId: string, applicationId: string): Promise<void> {
    const row = await this.db.qOne<{id: string}>(
      `SELECT id FROM pro_cpo_assignments WHERE id = $1 AND application_id = $2`,
      [assignmentId, applicationId]);
    if (!row) {throw new BadRequestException('assignment_plan_mismatch');}
  }

  private async assertActiveCatalogRow(table: 'pro_fleet_vehicles' | 'pro_resources', id: string, notFound: string): Promise<void> {
    // `table` is a fixed internal literal (never user input) — no injection surface.
    const row = await this.db.qOne<{active: boolean}>(
      `SELECT active FROM ${table} WHERE id = $1`, [id]);
    if (!row) {throw new NotFoundException(notFound);}
    if (!row.active) {throw new BadRequestException('catalog_row_inactive');}
  }
}
