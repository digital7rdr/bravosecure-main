import {Module} from '@nestjs/common';
import {AuthModule}       from '../auth/auth.module';
import {FamilyController} from './family.controller';
import {FamilyService}    from './family.service';
import {FamilyQuotaService} from './family-quota.service';
import {GeocodeService}   from '../vbg/geocode.service';
import {BookingPushBridge} from '../ops/booking-push-bridge.service';
import {OpsAuditService}  from '../ops/ops-audit.service';

@Module({
  imports:     [AuthModule],   // JWT guard machinery
  controllers: [FamilyController],
  // GeocodeService is stateless (env token + in-process cache) — providing it
  // here directly avoids importing the whole VbgModule graph for one label.
  // BookingPushBridge is a stateless Redis publisher (RedisModule is @Global) —
  // a second instance here avoids importing OpsModule (same pattern as
  // AgentModule); powers the R-3 invite wakes.
  // OpsAuditService only needs the @Global DatabaseService (+ @Optional Sentry),
  // so providing it directly keeps `request-seats` off the whole OpsModule graph
  // too — it writes one ops-feed row (family seat-increase request).
  // FamilyQuotaService owns the spending-quota control plane (quota changes +
  // their audit trail, the credit-request lifecycle, threshold warnings). Same
  // dependency set as FamilyService, so it needs no extra providers.
  providers:   [FamilyService, FamilyQuotaService, GeocodeService, BookingPushBridge, OpsAuditService],
  // FamilyService: BookingModule uses resolvePayer, auth uses linkPendingInvitesByPhone,
  // DispatchModule uses the post-commit notifyUsageThreshold hook.
  // FamilyQuotaService is exported for the controller's quota routes only — the
  // spend path deliberately does NOT go through it (see its class comment).
  exports:     [FamilyService, FamilyQuotaService],
})
export class FamilyModule {}
