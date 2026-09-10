import {Body, Controller, Get, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CpoSessionGuard} from '../common/guards/cpo-session.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {ProManagementService} from './pro-management.service';
import {MissionCodeDto} from './dto/pro-management.dto';

/**
 * CPO mission-code gate (founder spec): after the normal login, a CPO types
 * the code from operations; valid + assigned → the dedicated Pro mission
 * view payload; anything else → a clean denial. Auth flow itself unchanged.
 */
@Controller('agents/me')
@UseGuards(JwtAuthGuard, CpoSessionGuard)
export class CpoMissionCodeController {
  constructor(private readonly mgmt: ProManagementService) {}

  @Post('pro-mission-code')
  resolve(@Body() dto: MissionCodeDto, @CurrentUser() user: AccessClaims) {
    return this.mgmt.resolveMissionCode(user.sub, dto.code);
  }

  /**
   * Restore an already-authorized mission after reinstall / new device /
   * re-login — no code. The server, not the device, decides: 404 the moment
   * ops revokes the assignment or the schedule finishes.
   */
  @Get('pro-mission')
  current(@CurrentUser() user: AccessClaims) {
    return this.mgmt.getActiveMission(user.sub);
  }
}
