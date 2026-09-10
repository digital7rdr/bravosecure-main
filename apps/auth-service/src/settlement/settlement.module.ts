import {Module} from '@nestjs/common';
import {WalletModule} from '../wallet/wallet.module';
import {SettlementService} from './settlement.service';

/**
 * SettlementModule (BUILD_RUNBOOK Step 10) — a standalone home for the shared escrow
 * release settlement. It imports ONLY WalletModule (plus the @Global Database/Config),
 * so it sits BELOW BookingModule in the dependency graph and can be imported freely by
 * Booking / Agent / Ops without re-creating the Ops<->Booking cycle. SettlementService
 * injects only {Database, Config, Wallet} and never reaches up into Booking/Ops.
 */
@Module({
  imports: [WalletModule],
  providers: [SettlementService],
  exports: [SettlementService],
})
export class SettlementModule {}
