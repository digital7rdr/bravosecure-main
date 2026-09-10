import {
  Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from '../ops/admin.guard';
import {OpsAuditService} from '../ops/ops-audit.service';
import {ProFleetService} from './pro-fleet.service';
import {
  AssignProResourceDto, AssignProVehicleDto, CreateProFleetVehicleDto,
  CreateProResourceDto, UpdateProFleetVehicleDto, UpdateProResourceDto,
} from './dto/pro-management.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * Ops-console Pro fleet + resources surface (Issue 30): the vehicle/resource
 * catalogs and their plan-scoped assignments. Same /ops guard chain as
 * pro-management-ops.controller.ts; every mutation is SUPERVISOR/ADMIN and
 * leaves an ops_audit row. Catalog writes record against 'system' (no entity
 * subject type); plan assignments record against 'application'.
 */
@Controller('ops/pro-management')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
export class ProFleetOpsController {
  constructor(
    private readonly fleet: ProFleetService,
    private readonly audit: OpsAuditService,
  ) {}

  // ── Vehicle catalog ──
  @Get('fleet')
  listFleet(@Query('include_inactive') includeInactive?: string) {
    return this.fleet.listFleet(includeInactive === 'true');
  }

  @Post('fleet')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createVehicle(@Body() dto: CreateProFleetVehicleDto, @Req() req: OpsReq) {
    const r = await this.fleet.createVehicle(req.admin, dto);
    await this.audit.recordAdmin(req.admin, 'pro_fleet.create', 'system',
      (r.vehicle as {id: string}).id, {call_sign: dto.call_sign, plate: dto.plate});
    return r;
  }

  @Post('fleet/:id')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async updateVehicle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProFleetVehicleDto, @Req() req: OpsReq) {
    const r = await this.fleet.updateVehicle(req.admin, id, dto);
    await this.audit.recordAdmin(req.admin, 'pro_fleet.update', 'system', id,
      {active: dto.active ?? null});
    return r;
  }

  // ── Resource catalog ──
  @Get('resources')
  listResources(@Query('include_inactive') includeInactive?: string) {
    return this.fleet.listResources(includeInactive === 'true');
  }

  @Post('resources')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async createResource(@Body() dto: CreateProResourceDto, @Req() req: OpsReq) {
    const r = await this.fleet.createResource(req.admin, dto);
    await this.audit.recordAdmin(req.admin, 'pro_resource.create', 'system',
      (r.resource as {id: string}).id, {kind: dto.kind, label: dto.label});
    return r;
  }

  @Post('resources/:id')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async updateResource(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateProResourceDto, @Req() req: OpsReq) {
    const r = await this.fleet.updateResource(req.admin, id, dto);
    await this.audit.recordAdmin(req.admin, 'pro_resource.update', 'system', id,
      {active: dto.active ?? null});
    return r;
  }

  // ── Vehicle assignments ──
  @Get('applications/:id/vehicles')
  applicationVehicles(@Param('id', ParseUUIDPipe) id: string) {
    return this.fleet.listApplicationVehicles(id);
  }

  @Post('applications/:id/vehicles')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async assignVehicle(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignProVehicleDto, @Req() req: OpsReq) {
    const r = await this.fleet.assignVehicle(req.admin, id, dto);
    await this.audit.recordAdmin(req.admin, 'pro_vehicle.assign', 'application', id, {
      assignment_id: r.assignment.id, vehicle_id: dto.vehicle_id,
      starts_on: dto.starts_on, ends_on: dto.ends_on,
    });
    return r;
  }

  @Post('vehicle-assignments/:id/release')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async releaseVehicle(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.fleet.releaseVehicle(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'pro_vehicle.release', 'application',
      r.assignment.application_id, {assignment_id: id, vehicle_id: r.assignment.vehicle_id});
    return r;
  }

  // ── Resource assignments ──
  @Get('applications/:id/resources')
  applicationResources(@Param('id', ParseUUIDPipe) id: string) {
    return this.fleet.listApplicationResources(id);
  }

  @Post('applications/:id/resources')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async assignResource(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignProResourceDto, @Req() req: OpsReq) {
    const r = await this.fleet.assignResource(req.admin, id, dto);
    await this.audit.recordAdmin(req.admin, 'pro_resource.assign', 'application', id, {
      assignment_id: r.assignment.id, resource_id: dto.resource_id,
      qty: dto.qty ?? 1, starts_on: dto.starts_on, ends_on: dto.ends_on,
    });
    return r;
  }

  @Post('resource-assignments/:id/release')
  @RequireRoles('SUPERVISOR', 'ADMIN')
  async releaseResource(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    const r = await this.fleet.releaseResource(req.admin, id);
    await this.audit.recordAdmin(req.admin, 'pro_resource.release', 'application',
      r.assignment.application_id, {assignment_id: id, resource_id: r.assignment.resource_id});
    return r;
  }
}
