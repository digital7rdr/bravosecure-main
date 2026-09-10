import {useCallback} from 'react';
import {StackActions, useFocusEffect, useNavigation} from '@react-navigation/native';
import {useSecureProStore} from '@store/secureProStore';

/**
 * Audit Rev2 SP-01 — the single activation gate for every Bravo Secure Pro
 * screen that lives BEHIND the paywall.
 *
 * ProDashboardScreen had this gate inline; the ~nine sibling screens
 * (ProAssignedTeam, ProLiveMission, ProActivityHistory, SecureProCalendar,
 * SecureProMissions, SecureProMembers, …) were plain BookingStack routes with
 * NO gate at all and cross-link to one another — nine side doors around one
 * locked front door. Every one of them now mounts this hook, so the gate lives
 * in exactly one place (the repo's duplicate-copy rule).
 *
 * Behaviour:
 *  - On focus it (re)loads /pro-applications/me via the store.
 *  - Once `hasLoaded`, if the plan is not ACTIVE it REPLACES the current route
 *    with SecureProStatus (which self-routes to the intro when there is no
 *    application yet). `replace`, not `navigate`, so the gated screen never
 *    lingers in the back stack.
 *  - It fails CLOSED: while `hasLoaded` is false nothing is admitted, and a
 *    load error still flips `hasLoaded` in the store (secureProStore's catch),
 *    so an offline/500/timeout can never leave the screen rendered.
 *
 * Family members are covered without a special case: /pro-applications/me
 * returns the OWNER's ACTIVE row to a linked member, so `planActive` is already
 * true for them.
 *
 * Returns `{planActive, hasLoaded}` so a caller can render a spinner until the
 * decision is known instead of flashing protected content for one frame.
 */
export function useProPlanGate(): {planActive: boolean; hasLoaded: boolean} {
  const navigation = useNavigation();
  const application = useSecureProStore(s => s.application);
  const hasLoaded = useSecureProStore(s => s.hasLoaded);
  const loadApplication = useSecureProStore(s => s.loadApplication);
  const planActive = application?.status === 'ACTIVE';

  useFocusEffect(
    useCallback(() => {
      void loadApplication();
    }, [loadApplication]),
  );

  useFocusEffect(
    useCallback(() => {
      if (hasLoaded && !planActive) {
        navigation.dispatch(StackActions.replace('SecureProStatus'));
      }
    }, [hasLoaded, planActive, navigation]),
  );

  return {planActive, hasLoaded};
}
