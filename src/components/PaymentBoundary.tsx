/**
 * W4/B-685 boot diet — the Stripe host, mounted per PAYMENT SCREEN instead of
 * at the App root. `<StripeProvider>` initialises the native Stripe SDK when
 * it mounts; at the root that cost was paid at boot by every account,
 * including ones that never open a payment surface. Wrapping the four
 * payment screens here means only they pay it, at open time — and because
 * the wrap lives in each SCREEN module (not at registration sites), every
 * navigator that registers one of those screens inherits it automatically
 * (they span BookingNavigator, AgentNavigator, and a direct MainNavigator
 * render — a registration-site wrap would be the multi-shell drop trap).
 *
 * The require is lazy so the Stripe JS module also stays off the boot path.
 * Pinned by bootDietGuards.test.ts.
 */
import React from 'react';
// Type-only: erased at compile time, so the Stripe module still evaluates
// lazily at first payment-screen mount, not at boot.
import type {StripeProvider as StripeProviderT} from '@stripe/stripe-react-native';

// Why: EXPO_PUBLIC_ prefix — Expo only inlines prefixed env vars into the
// client bundle (the App.tsx comment this key ships with historically).
const STRIPE_KEY = process.env.EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

let StripeProviderLazy: typeof StripeProviderT | null = null;

export function withPaymentBoundary<P extends object>(
  Screen: React.ComponentType<P>,
): React.ComponentType<P> {
  function PaymentBoundary(props: P): React.JSX.Element {
    if (!StripeProviderLazy) {
      StripeProviderLazy = (require('@stripe/stripe-react-native') as {StripeProvider: typeof StripeProviderT}).StripeProvider;
    }
    const Provider = StripeProviderLazy;
    return (
      <Provider publishableKey={STRIPE_KEY}>
        <Screen {...props} />
      </Provider>
    );
  }
  PaymentBoundary.displayName = `withPaymentBoundary(${Screen.displayName ?? Screen.name ?? 'Screen'})`;
  return PaymentBoundary;
}
