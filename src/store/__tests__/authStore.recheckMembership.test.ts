/**
 * §35A §F — CPO mid-session revocation re-check. We exercise the REAL authStore
 * recheckMembership/endCpoAccess logic with the API layer mocked. signOut() is stubbed
 * (its full teardown does heavy lazy requires of the messenger runtime that don't belong
 * in a store unit test) — we only assert that it IS invoked on revocation.
 */
jest.mock('@services/api', () => ({
  authApi: {me: jest.fn()},
  agentApi: {setDuty: jest.fn(() => Promise.resolve())},
  getDeviceId: jest.fn(() => Promise.resolve('dev-1')),
  tokenStore: {get: jest.fn(), getRefresh: jest.fn(), set: jest.fn(), clear: jest.fn()},
  subscriptionApi: {},
}));
jest.mock('@modules/observability', () => ({setUser: jest.fn()}));
jest.mock('expo-local-authentication', () => ({}));

import {useAuthStore} from '@store/authStore';
import {authApi, agentApi} from '@services/api';

const mockMe = authApi.me as jest.Mock;
const mockSetDuty = agentApi.setDuty as jest.Mock;

const API_USER = {
  id: 'u1', email: 'guard@x.io', display_name: 'Guard One', role: 'agent',
  subscription_tier: 'lite', phone_e164: '+10000000000',
};
const mockSignOut = jest.fn(() => Promise.resolve());

function meReturns(
  account_kind: string,
  membership_status: string | null,
  // vs2 item 4 — extra fields the revocation branch now has to READ from this
  // response rather than from the store, which it deliberately does not update.
  extra: Record<string, unknown> = {},
) {
  mockMe.mockResolvedValueOnce({
    user: API_USER, account_kind, org: {id: 'o1', name: 'Acme CP'},
    must_set_password: false, membership_status, ...extra,
  });
}

describe('authStore.recheckMembership', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Reset the slice we touch + stub the heavy signOut teardown.
    useAuthStore.setState({accessEnded: false, user: null, isAuthenticated: true, signOut: mockSignOut});
  });

  it('active CPO → no teardown, just refreshes the local user', async () => {
    meReturns('cpo', 'active');
    await useAuthStore.getState().recheckMembership();
    expect(mockSetDuty).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
    expect(useAuthStore.getState().user?.org?.name).toBe('Acme CP');
  });

  it('suspended CPO → setDuty(false) + signOut() + accessEnded', async () => {
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSetDuty).toHaveBeenCalledWith(false);
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('removed CPO → teardown', async () => {
    meReturns('cpo', 'removed');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('individual account → never torn down', async () => {
    meReturns('individual', null);
    await useAuthStore.getState().recheckMembership();
    expect(mockSetDuty).not.toHaveBeenCalled();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  // RS-06 narrowed this rule and the test was never updated, so it had been red:
  // it seeded `user: null` and expected a teardown, but a 401 is now a
  // revocation signal ONLY for a managed CPO. Since RS-06 this catch also runs
  // on foreground-resume for EVERY shell, where a 401 is just as likely to be a
  // transient refresh outage (auth-service mid-deploy) — tearing every shell
  // down on that would be a false-positive logout wave. Both halves are pinned.
  it('RS-06 — a 401 on the re-check tears down a managed CPO', async () => {
    useAuthStore.setState({user: {...API_USER, account_kind: 'cpo'} as never});
    mockMe.mockRejectedValueOnce({isAxiosError: true, response: {status: 401}});
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('RS-06 — a 403 tears down a managed CPO too', async () => {
    useAuthStore.setState({user: {...API_USER, account_kind: 'cpo'} as never});
    mockMe.mockRejectedValueOnce({isAxiosError: true, response: {status: 403}});
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(useAuthStore.getState().accessEnded).toBe(true);
  });

  it('RS-06 — a 401 does NOT log out a non-CPO shell', async () => {
    // The false-positive logout wave this rule exists to prevent. A genuinely
    // revoked client/agency user is caught by their next real API call.
    useAuthStore.setState({user: {...API_USER, account_kind: 'individual'} as never});
    mockMe.mockRejectedValueOnce({isAxiosError: true, response: {status: 401}});
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  it('a transient network error does NOT log the guard out', async () => {
    mockMe.mockRejectedValueOnce(new Error('Network Error'));
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  /**
   * Scope v2 Phase 6 — A WORKSPACE OWNER'S SESSION SURVIVES A CPO REVOCATION.
   *
   * An Enterprise workspace owner can also be a managed CPO of a DIFFERENT org
   * ("a real membership still wins"). When that org suspends them the CPO branch
   * fires — and the full teardown would destroy the session of somebody whose
   * own workspace is untouched: Ops Rooms dropped, runtime torn down, at-rest
   * wiped, tokens cleared, because an unrelated organisation revoked a
   * membership.
   *
   * CPO access still ENDS (accessEnded is raised, so the CPO shell ejects);
   * only the session teardown is skipped.
   */
  it('does NOT sign out a workspace owner whose CPO membership was revoked', async () => {
    useAuthStore.setState({user: {...API_USER, owns_workspace: true} as never});
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).not.toHaveBeenCalled();
    /**
     * …and `accessEnded` must stay FALSE, which round 3 got wrong.
     *
     * The flag is not a mild signal: `RootNavigator` renders ONLY
     * `AccessEndedScreen` while it is true, so `resolveAuthedRoute` never runs
     * and this person is shown a dead-end screen telling them they were signed
     * out — which this very branch declined to do. Their only button returns
     * them to the same session, and the next recheck (every Workspace Hub
     * focus, since round 2) throws them out again.
     *
     * The CPO shell still ejects: resolveAuthedRoute sees the revoked
     * membership plus the workspace affiliation and routes to the client shell.
     */
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  it('vs2 item 4 — nor a MEMBER of a workspace they do not own', async () => {
    /**
     * The rule was written when the only life outside the agency was owning a
     * workspace. Multi-org added a second: Chidi is an officer at Meridian and
     * an EMPLOYEE of workspace Acme. He owns nothing, so the owner-only guard
     * missed him — Meridian suspending him destroyed his whole session, Acme's
     * work included, and the Workspace Hub now calls recheckMembership on every
     * focus, which turned that from rare into on demand.
     */
    useAuthStore.setState({user: {
      ...API_USER, owns_workspace: false,
      workspaces: [{org_id: 'acme', name: 'Acme Corp', role: 'employee'}],
    } as never});
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  it('reads the affiliation from the FRESH /auth/me, not the stale snapshot', async () => {
    /**
     * recheckMembership fetches /auth/me and, on this branch, returns WITHOUT
     * storing it — so anything reading `getState().user` sees the previous
     * snapshot. Acme adds Chidi at 09:00 and Meridian suspends him at 09:05:
     * the response carries both facts, the store still says he has no
     * workspaces, and the guard fails open into a full teardown that WIPES HIS
     * AT-REST STORE. The affiliation has to travel as an argument.
     */
    useAuthStore.setState({user: {...API_USER, owns_workspace: false, workspaces: []} as never});
    meReturns('cpo', 'suspended', {workspaces: [{org_id: 'acme', name: 'Acme', role: 'employee'}]});
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).not.toHaveBeenCalled();
    expect(useAuthStore.getState().accessEnded).toBe(false);
  });

  it('still signs out a plain CPO with no workspace anywhere', async () => {
    useAuthStore.setState({user: {...API_USER, owns_workspace: false, workspaces: []} as never});
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });

  it('endCpoAccess is idempotent (a second call is a no-op)', async () => {
    meReturns('cpo', 'suspended');
    await useAuthStore.getState().recheckMembership();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    // Already torn down — calling again must not re-run setDuty/signOut.
    await useAuthStore.getState().endCpoAccess();
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockSetDuty).toHaveBeenCalledTimes(1);
  });
});
