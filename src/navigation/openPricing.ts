import {CommonActions} from '@react-navigation/native';
import {navigationRef, mountedTreeHasRoute} from './navigationRef';
import {Alert} from '@utils/alert';

/**
 * M1A — jump to Settings → Pricing from anywhere (locked-feature prompts,
 * upgrade CTAs). Same root-dispatch pattern as the tier_insufficient
 * interceptor; a no-op until the container is ready.
 *
 * `Pricing` is registered in BookingNavigator ONLY, reached via `SecureTab`,
 * which exists only in the client tab shell. MainNavigator renders exactly one
 * of CpoNavigator / AgentNavigator / that tab shell — so in the Agent and CPO
 * shells this dispatch names a route the mounted tree does not have, the nested
 * payload goes unhandled, and the button is silently dead. That is the same
 * failure as Issues 18/19, and it was found (R6-4) on a CTA added to REPLACE a
 * working dialog, which would have made that persona strictly worse off.
 *
 * So: resolve against the mounted tree first, and say so out loud when the
 * route is not there rather than dropping the tap.
 */

export function openPricing(): boolean {
  if (!navigationRef.isReady()) {return false;}
  if (!mountedTreeHasRoute('SecureTab')) {
    Alert.alert(
      'Plans unavailable here',
      'Subscription plans are managed from your personal account dashboard. Sign in with the account that holds the subscription to change it.',
    );
    return false;
  }
  // `initial: false` — SecureTab is lazy whenever the user is in the messenger
  // product, so without it BookingNavigator's FIRST mount roots at Pricing.
  // The tabPress listener then pushes BookingHome on top, and back from the
  // booking home lands on the pricing page for the life of the tab tree.
  navigationRef.dispatch(
    CommonActions.navigate('Main', {
      screen: 'SecureTab',
      params: {screen: 'Pricing', initial: false},
    }),
  );
  return true;
}
