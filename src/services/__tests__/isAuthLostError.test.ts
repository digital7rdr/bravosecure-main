import {isAuthLostError} from '@services/authError';

/** Minimal axios-error shape (axios.isAxiosError keys on `isAxiosError === true`). */
function axiosErr(status: number | undefined, data?: unknown) {
  return {isAxiosError: true, response: status === undefined ? undefined : {status, data}};
}

describe('isAuthLostError (B-76) — genuine session loss vs business error', () => {
  it('treats a surfaced 401 as session loss (refresh already failed to recover it)', () => {
    expect(isAuthLostError(axiosErr(401, {message: 'token_revoked'}))).toBe(true);
    expect(isAuthLostError(axiosErr(401))).toBe(true);
  });

  it('treats a coded revocation body as session loss even off a non-401 status', () => {
    expect(isAuthLostError(axiosErr(403, {message: 'session_revoked'}))).toBe(true);
    expect(isAuthLostError(axiosErr(400, {message: ['invalid_token']}))).toBe(true);
    expect(isAuthLostError(axiosErr(403, {code: 'token_revoked'}))).toBe(true);
  });

  it('does NOT treat business/validation failures as session loss', () => {
    expect(isAuthLostError(axiosErr(400, {message: 'deploy_checks_incomplete'}))).toBe(false);
    expect(isAuthLostError(axiosErr(404, {message: 'not_assigned_to_mission'}))).toBe(false);
    expect(isAuthLostError(axiosErr(409, {message: 'mission_not_completable'}))).toBe(false);
    expect(isAuthLostError(axiosErr(403, {code: 'tier_insufficient', message: 'Upgrade to Pro'}))).toBe(false);
    expect(isAuthLostError(axiosErr(500))).toBe(false);
  });

  it('does NOT treat non-axios errors / network errors as session loss', () => {
    expect(isAuthLostError(new Error('Network Error'))).toBe(false);
    expect(isAuthLostError(axiosErr(undefined))).toBe(false); // no response (timeout/offline)
    expect(isAuthLostError(null)).toBe(false);
    expect(isAuthLostError(undefined)).toBe(false);
  });
});
