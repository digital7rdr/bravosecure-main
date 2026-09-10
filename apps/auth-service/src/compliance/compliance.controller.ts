import {Body, Controller, Get, Post, UseGuards} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser} from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {ComplianceService} from './compliance.service';
import {SubmitComplianceDto} from './dto/compliance.dto';

/**
 * Provider-facing compliance registry (BUILD_RUNBOOK Step 15). A provider submits its
 * licence/insurance (agency) or armed permit (CPO) with an expiry; it starts UNVERIFIED
 * and an admin must verify it before the provider is dispatch-eligible. Scoped to the
 * caller (user.sub) — a provider only ever sees/edits its own credentials.
 */
@Controller('compliance')
@UseGuards(JwtAuthGuard)
export class ComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Post()
  submit(@Body() dto: SubmitComplianceDto, @CurrentUser() user: AccessClaims) {
    return this.compliance.submitForUser(user.sub, {
      docType: dto.doc_type,
      regionCode: dto.region_code,
      expiresAt: dto.expires_at,
      reference: dto.reference ?? null,
      fileUrl: dto.file_url ?? null,
      fileHashSha256: dto.file_hash_sha256 ?? null,
      cpoUserId: dto.cpo_user_id ?? null,
    });
  }

  @Get('me')
  listMine(@CurrentUser() user: AccessClaims) {
    return this.compliance.listMine(user.sub);
  }
}
