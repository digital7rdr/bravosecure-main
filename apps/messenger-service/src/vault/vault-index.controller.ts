import {Body, Controller, Get, Post, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {VaultIndexService} from './vault-index.service';
import {PutVaultIndexDto} from './dto/vault-index.dto';

/**
 * B-696 Phase D — the vault index blob (VAULT_DURABILITY_DESIGN §6).
 *
 * A SEPARATE controller from `/vault` ON PURPOSE: that controller applies
 * MfaGuard class-wide with single-use proofs (each one costs the user a
 * biometric ceremony), which a background sync cannot pay per push. The
 * payload here is E2E-encrypted client-side — the same protection class as
 * POST/GET /backup/identity/sessions, which carries the identical guard set
 * (JWT + throttle). The vault FILE download gate keeps its MFA untouched.
 *
 * caller.claims.sub IS the owner — no userId parameter is ever accepted.
 */
@Controller('vault-index')
@UseGuards(JwtHttpGuard)
export class VaultIndexController {
  constructor(private readonly svc: VaultIndexService) {}

  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post()
  async put(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PutVaultIndexDto,
  ): Promise<{ok: true; seq: number}> {
    return this.svc.put(caller.claims.sub, dto);
  }

  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Get()
  async get(
    @CurrentCaller() caller: CallerContext,
  ): Promise<{blob: string; seq: number} | null> {
    return this.svc.get(caller.claims.sub);
  }
}
