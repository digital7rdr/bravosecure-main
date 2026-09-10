/**
 * B-76 — classify whether an error means the SESSION is genuinely gone (a real
 * logout) versus an ordinary business/validation failure.
 *
 * By the time an error reaches a screen's catch, the `authHttp` response
 * interceptor (api.ts) has ALREADY tried refresh-and-replay once on the first
 * 401. A 401 that still surfaces therefore means the refresh itself failed
 * (revoked or absent refresh token) — i.e. a real logout, most often the
 * single-device takeover that fires when the same account signs in on another
 * device. Screens use this to route the user to a clean re-auth instead of
 * showing the raw `token_revoked` string as a "could not advance" error.
 *
 * Duck-types the axios error shape (`isAxiosError === true`) rather than
 * importing axios, so it stays a pure, trivially-testable leaf module with no
 * bundle/side-effect import chain.
 */
export function isAuthLostError(e: unknown): boolean {
  if (!e || typeof e !== 'object') {return false;}
  const err = e as {
    isAxiosError?: boolean;
    response?: {status?: number; data?: {message?: string | string[]; code?: string}};
  };
  if (err.isAxiosError !== true) {return false;}
  if (err.response?.status === 401) {return true;}
  const body = err.response?.data;
  const msg = Array.isArray(body?.message) ? body?.message[0] : body?.message;
  const hay = `${msg ?? ''} ${body?.code ?? ''}`;
  return /token_revoked|invalid_token|missing_token|session_revoked|\brevoked\b/i.test(hay);
}
