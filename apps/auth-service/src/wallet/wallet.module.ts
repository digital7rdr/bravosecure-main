import {Module} from '@nestjs/common';
import {AuthModule} from '../auth/auth.module';
import {WalletService} from './wallet.service';
import {WalletController} from './wallet.controller';
import {StripeClient} from './stripe.client';
import {WalletExpiryCron} from './wallet-expiry.cron';

/**
 * Bravo Credits wallet + Stripe top-up.
 *
 * - GET  /wallet/balance
 * - GET  /wallet/transactions
 * - POST /wallet/topup             (mints PaymentIntent + pending ledger row)
 * - POST /wallet/stripe-webhook    (settles the ledger row)
 *
 * WalletService is exported so the booking/subscription flows can debit
 * and credit BC (payWithCredits inlines its own locked debit; features use
 * `debitForFeature`).
 *
 * WalletExpiryCron runs hourly in-process to reclaim batches whose
 * 12-month TTL has elapsed (see wallet-expiry.cron.ts).
 */
@Module({
  imports:     [AuthModule],
  controllers: [WalletController],
  providers:   [WalletService, StripeClient, WalletExpiryCron],
  // StripeClient exported so SubscriptionModule can create/verify
  // subscription objects + webhooks without re-instantiating the shim.
  exports:     [WalletService, StripeClient],
})
export class WalletModule {}
