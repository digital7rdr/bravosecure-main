/**
 * Stripe payments — Bravo Credits top-up flow.
 *
 * The mobile client never sees the Stripe secret. `/wallet/topup` on
 * auth-service mints a PaymentIntent and returns its `client_secret`;
 * we hand that to the native Stripe SDK's PaymentSheet to actually
 * charge the card. When auth-service is running in fallback mode (no
 * STRIPE_SECRET_KEY configured), `client_secret` is omitted and the
 * server credits the wallet locally — the UI just skips PaymentSheet.
 */
import {useStripe} from '@stripe/stripe-react-native';
import {walletApi} from './api';
import type {WalletTopUpResponse} from './api';

// ─── Bravo Credits top-up ────────────────────────────────────────────────────
//
// Exported for CreditPaywallScreen. Kept as a thin shim over `walletApi.topUp`
// so callers can stay consumer-facing without importing the full wallet module.

export const creditsApi = {
  topUp: (amount: number, currency: string) => walletApi.topUp(amount, currency),
};

/** Tiny hook that pairs a server-minted PaymentIntent with PaymentSheet. */
export function usePaymentFlow() {
  const {initPaymentSheet, presentPaymentSheet} = useStripe();

  /**
   * Open PaymentSheet for a server-minted PaymentIntent. Caller is
   * responsible for calling `walletApi.topUp` first and passing the
   * returned `client_secret` here. Returns `true` if the charge succeeded,
   * `false` if the user cancelled, throws on unrecoverable errors.
   */
  const payWithClientSecret = async (opts: {
    clientSecret: string;
    customerId?: string;
    ephemeralKey?: string;
    merchantName?: string;
  }): Promise<boolean> => {
    const {error: initError} = await initPaymentSheet({
      merchantDisplayName: opts.merchantName ?? 'Bravo Secure',
      customerId: opts.customerId,
      customerEphemeralKeySecret: opts.ephemeralKey,
      paymentIntentClientSecret: opts.clientSecret,
      allowsDelayedPaymentMethods: false,
      defaultBillingDetails: {name: 'Bravo Secure Client'},
    });
    if (initError) {throw new Error(initError.message);}

    const {error: presentError} = await presentPaymentSheet();
    if (presentError) {
      if (presentError.code === 'Canceled') {return false;}
      throw new Error(presentError.message);
    }
    return true;
  };

  /**
   * Single-shot topup: call `/wallet/topup`, run PaymentSheet if the server
   * returned a real client_secret, otherwise consider the wallet already
   * credited (fallback / no-stripe mode).
   */
  const topUpAndCharge = async (opts: {
    amountFiat: number;
    currency: string;
  }): Promise<{charged: boolean; result: WalletTopUpResponse}> => {
    const {data} = await walletApi.topUp(opts.amountFiat, opts.currency);
    if (!data.client_secret) {
      // Fallback — server credited the wallet locally, no charge.
      return {charged: true, result: data};
    }
    const ok = await payWithClientSecret({
      clientSecret: data.client_secret,
      customerId: data.customer_id,
    });
    if (ok && data.intent_id) {
      // Settle the pending ledger row even if the webhook never fires
      // (e.g. local dev without `stripe listen`). Server re-verifies the
      // intent with Stripe before crediting BC, so we can't lie here.
      try {
        const settled = await walletApi.confirmTopUp(data.intent_id);
        return {
          charged: true,
          result: {...data, credits_awarded: settled.data.credits_awarded},
        };
      } catch (e) {
        // Payment went through on Stripe's side but the confirm failed.
        // Don't lose the user's money — surface the intent_id so support
        // can reconcile manually.
        const msg = e instanceof Error ? e.message : 'confirm_failed';
        throw new Error(`Paid but not credited — intent ${data.intent_id}: ${msg}`);
      }
    }
    return {charged: ok, result: data};
  };

  /**
   * Add a saved card: the server mints a SetupIntent, PaymentSheet collects
   * the card and saves it to the customer off-session. Returns true on
   * success, false if the user cancelled.
   */
  const addCard = async (): Promise<boolean> => {
    const {data} = await walletApi.cardSetupIntent();
    if (!data.client_secret) {return false;}
    const {error: initError} = await initPaymentSheet({
      merchantDisplayName: 'Bravo Secure',
      setupIntentClientSecret: data.client_secret,
      allowsDelayedPaymentMethods: false,
      defaultBillingDetails: {name: 'Bravo Secure Client'},
    });
    if (initError) {throw new Error(initError.message);}
    const {error: presentError} = await presentPaymentSheet();
    if (presentError) {
      if (presentError.code === 'Canceled') {return false;}
      throw new Error(presentError.message);
    }
    return true;
  };

  return {payWithClientSecret, topUpAndCharge, addCard};
}
