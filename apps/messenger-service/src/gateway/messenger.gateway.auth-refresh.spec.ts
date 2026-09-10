import {MessengerGateway} from './messenger.gateway';

/**
 * B-100/B-101 — in-place socket re-authentication (`auth.refresh`).
 *
 * The socket is pinned to its handshake token's `jti`, whose Redis
 * allowlist key dies with the 15-minute access token (and is DEL'd the
 * instant a refresh rotates the session). The P0-6 sweep then
 * disconnects the socket, which kills any live call. Letting the client
 * hand us a FRESH token and swapping claims in place removes that
 * disconnect — but it must not become an authentication bypass.
 *
 * Contract under test:
 *   1. A valid, allowlisted token for the SAME principal swaps the
 *      socket's claims in place (no disconnect).
 *   2. Identity is pinned: a different `sub` is refused and the
 *      original claims survive untouched.
 *   3. Device is pinned: a different `device_id` is refused.
 *   4. A revoked token (jti absent from the allowlist) is refused —
 *      revocation promptness is preserved, per the architecture's
 *      "instant kill" contract.
 *   5. A token failing signature/exp verification is refused.
 *   6. Failure is non-destructive: the socket keeps its existing,
 *      already-authenticated claims (no downgrade, no hijack).
 */
describe('MessengerGateway.handleAuthRefresh (in-place socket re-auth)', () => {
  const BASE_CLAIMS = {sub: 'user-1', deviceId: 'dev-1', role: 'client', jti: 'jti-old'};

  function makeGateway(opts?: {
    verify?: jest.Mock;
    jtiExists?: jest.Mock;
  }): {gw: MessengerGateway; verify: jest.Mock; exists: jest.Mock} {
    const verify = opts?.verify ?? jest.fn();
    const exists = opts?.jtiExists ?? jest.fn().mockResolvedValue(1);
    const gw = Object.create(MessengerGateway.prototype) as MessengerGateway;
    Object.assign(gw as unknown as Record<string, unknown>, {
      jwt:    {verifyAccessToken: verify},
      redis:  {client: {exists}},
      logger: {warn: jest.fn(), debug: jest.fn(), log: jest.fn()},
      // Rate gate is exercised by its own suite; keep it open here.
      rateGate: () => null,
    });
    return {gw, verify, exists};
  }

  function makeSocket(claims = {...BASE_CLAIMS}): {data: {claims: typeof BASE_CLAIMS; signalDeviceId: number; sessionId: string}} {
    return {data: {claims, signalDeviceId: 1, sessionId: 'sess-1'}};
  }

  it('swaps claims in place for a valid allowlisted token of the same principal', async () => {
    const fresh = {sub: 'user-1', deviceId: 'dev-1', role: 'client', jti: 'jti-new'};
    const {gw, exists} = makeGateway({verify: jest.fn().mockResolvedValue(fresh)});
    const socket = makeSocket();

    const res = await gw.handleAuthRefresh({token: 'fresh.jwt.token'}, socket as never);

    expect(res).toEqual({ok: true});
    expect(socket.data.claims.jti).toBe('jti-new');
    // The new jti was checked against the SAME allowlist the handshake uses.
    expect(exists).toHaveBeenCalledWith('jti:jti-new');
    // Handshake-derived session identity is untouched.
    expect(socket.data.signalDeviceId).toBe(1);
    expect(socket.data.sessionId).toBe('sess-1');
  });

  it('refuses a token for a DIFFERENT user and leaves the original claims intact', async () => {
    const attacker = {sub: 'user-2', deviceId: 'dev-1', role: 'client', jti: 'jti-attacker'};
    const {gw, exists} = makeGateway({verify: jest.fn().mockResolvedValue(attacker)});
    const socket = makeSocket();

    const res = await gw.handleAuthRefresh({token: 'other.user.token'}, socket as never);

    expect(res).toEqual({ok: false, code: 'identity_mismatch'});
    expect(socket.data.claims).toEqual(BASE_CLAIMS);
    // Refused before any allowlist lookup — no side effects at all.
    expect(exists).not.toHaveBeenCalled();
  });

  it('refuses a token for a DIFFERENT device', async () => {
    const otherDevice = {sub: 'user-1', deviceId: 'dev-2', role: 'client', jti: 'jti-other-dev'};
    const {gw} = makeGateway({verify: jest.fn().mockResolvedValue(otherDevice)});
    const socket = makeSocket();

    const res = await gw.handleAuthRefresh({token: 'other.device.token'}, socket as never);

    expect(res).toEqual({ok: false, code: 'identity_mismatch'});
    expect(socket.data.claims).toEqual(BASE_CLAIMS);
  });

  it('refuses a REVOKED token (jti absent from the allowlist) — instant-kill preserved', async () => {
    const revoked = {sub: 'user-1', deviceId: 'dev-1', role: 'client', jti: 'jti-revoked'};
    const {gw} = makeGateway({
      verify:    jest.fn().mockResolvedValue(revoked),
      jtiExists: jest.fn().mockResolvedValue(0),
    });
    const socket = makeSocket();

    const res = await gw.handleAuthRefresh({token: 'revoked.token'}, socket as never);

    expect(res).toEqual({ok: false, code: 'token_revoked'});
    expect(socket.data.claims).toEqual(BASE_CLAIMS);
  });

  it('refuses a token that fails signature/exp verification', async () => {
    const {gw} = makeGateway({verify: jest.fn().mockRejectedValue(new Error('signature verification failed'))});
    const socket = makeSocket();

    const res = await gw.handleAuthRefresh({token: 'forged.token'}, socket as never);

    expect(res).toEqual({ok: false, code: 'invalid_token'});
    expect(socket.data.claims).toEqual(BASE_CLAIMS);
  });

  it('refuses an empty payload and a socket with no established session', async () => {
    const {gw, verify} = makeGateway({verify: jest.fn()});

    expect(await gw.handleAuthRefresh({}, makeSocket() as never)).toEqual({ok: false, code: 'missing_token'});
    expect(await gw.handleAuthRefresh(undefined, makeSocket() as never)).toEqual({ok: false, code: 'missing_token'});
    expect(await gw.handleAuthRefresh({token: 't'}, {data: undefined} as never))
      .toEqual({ok: false, code: 'no_active_session'});
    expect(verify).not.toHaveBeenCalled();
  });
});
