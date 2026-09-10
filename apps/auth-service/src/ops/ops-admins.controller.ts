import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post,
  Req, UseGuards,
} from '@nestjs/common';
import type {Request} from 'express';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CsrfGuard} from '../common/guards/csrf.guard';
import {AdminGuard, RequireRoles, type AdminContext} from './admin.guard';
import {AdminInvitesService} from './admin-invites.service';
import {CreateAdminInviteDto, SetAdminActiveDto, SetAdminRoleDto} from './dto/ops.dto';

type OpsReq = Request & {admin: AdminContext};

/**
 * RS-09 — admin account management: list admins, change an admin's role,
 * and mint/revoke single-use invites. ADMIN-only, class-wide: this is the
 * highest-privilege surface in the console (it creates the people who run
 * the console), so nothing here is delegated to SUPERVISOR/OPS.
 */
@Controller('ops/admins')
@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)
@RequireRoles('ADMIN')
export class OpsAdminsController {
  constructor(private readonly invites: AdminInvitesService) {}

  @Get()
  listAdmins() {
    return this.invites.listAdmins();
  }

  @Patch(':userId/role')
  @HttpCode(200)
  setRole(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetAdminRoleDto,
    @Req() req: OpsReq,
  ) {
    return this.invites.setAdminRole(req.admin, userId, dto.role);
  }

  // OC-09 — offboard (deactivate) / reinstate an operator account.
  @Patch(':userId/active')
  @HttpCode(200)
  setActive(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: SetAdminActiveDto,
    @Req() req: OpsReq,
  ) {
    return this.invites.setAdminActive(req.admin, userId, dto.active);
  }

  @Get('invites')
  listInvites() {
    return this.invites.listInvites();
  }

  @Post('invites')
  createInvite(@Body() dto: CreateAdminInviteDto, @Req() req: OpsReq) {
    return this.invites.createInvite(req.admin, dto);
  }

  @Delete('invites/:id')
  @HttpCode(200)
  revokeInvite(@Param('id', ParseUUIDPipe) id: string, @Req() req: OpsReq) {
    return this.invites.revokeInvite(req.admin, id);
  }
}
