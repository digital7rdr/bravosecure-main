/**
 * Warm-start FIX-02 — the claims decoder behind the offline boot.
 *
 * This module chooses which LOCAL SHELL to render when the server is
 * unreachable, so the interesting cases are all the ways a token can be
 * unusable: the decoder must return null (→ the user stays on the login flow)
 * rather than half-build a session out of garbage.
 */
import {decodeAccessTokenClaims, minimalUserFromClaims} from '@services/jwtClaims';

const b64url = (s: string): string =>
  Buffer.from(s, 'utf8').toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');

const tokenWith = (payload: unknown): string =>
  `hdr.${b64url(JSON.stringify(payload))}.sig`;

describe('decodeAccessTokenClaims', () => {
  it('reads sub / role / device_id / exp from a real-shaped access token', () => {
    const c = decodeAccessTokenClaims(
      tokenWith({sub: 'user-1', role: 'agent', device_id: 'dev-9', exp: 1893456000, jti: 'j1'}),
    );
    expect(c).toEqual({sub: 'user-1', role: 'agent', deviceId: 'dev-9', exp: 1893456000});
  });

  it('accepts every role auth-service can mint', () => {
    for (const role of ['individual', 'corporate', 'agent', 'service_provider', 'ops']) {
      expect(decodeAccessTokenClaims(tokenWith({sub: 'u', role}))?.role).toBe(role);
    }
  });

  it('survives multi-byte UTF-8 anywhere in the payload', () => {
    // atob yields one char per BYTE; without the UTF-8 reassembly this throws
    // inside JSON.parse and a legitimate user is bounced to the login screen.
    const c = decodeAccessTokenClaims(
      tokenWith({sub: 'u1', role: 'individual', name: 'Ünïcødé ✅ 日本語'}),
    );
    expect(c?.sub).toBe('u1');
  });

  it('rejects an unknown role rather than guessing a shell', () => {
    expect(decodeAccessTokenClaims(tokenWith({sub: 'u', role: 'superadmin'}))).toBeNull();
    expect(decodeAccessTokenClaims(tokenWith({sub: 'u', role: ''}))).toBeNull();
    expect(decodeAccessTokenClaims(tokenWith({sub: 'u'}))).toBeNull();
  });

  it('rejects a missing or non-string sub', () => {
    expect(decodeAccessTokenClaims(tokenWith({role: 'individual'}))).toBeNull();
    expect(decodeAccessTokenClaims(tokenWith({sub: 42, role: 'individual'}))).toBeNull();
    expect(decodeAccessTokenClaims(tokenWith({sub: '', role: 'individual'}))).toBeNull();
  });

  it('rejects malformed input without throwing', () => {
    for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b', 'a.b.c.d', 'hdr..sig', 'hdr.%%%.sig']) {
      expect(() => decodeAccessTokenClaims(bad as string)).not.toThrow();
      expect(decodeAccessTokenClaims(bad as string)).toBeNull();
    }
  });

  it('rejects a payload that is valid base64 but not JSON', () => {
    expect(decodeAccessTokenClaims(`hdr.${b64url('plain text')}.sig`)).toBeNull();
  });

  it('rejects a JSON payload that is not an object', () => {
    expect(decodeAccessTokenClaims(`hdr.${b64url('"a string"')}.sig`)).toBeNull();
    expect(decodeAccessTokenClaims(`hdr.${b64url('null')}.sig`)).toBeNull();
  });
});

describe('minimalUserFromClaims', () => {
  it('builds only what RootNavigator needs — and none of the §35A routing fields', () => {
    const u = minimalUserFromClaims({sub: 'u-7', role: 'agent'});
    expect(u.id).toBe('u-7');
    expect(u.role).toBe('agent');
    // Inventing any of these is how a manager lands in the wrong product.
    expect(u.account_kind).toBeUndefined();
    expect(u.managed_org).toBeUndefined();
    expect(u.permitted_modules).toBeUndefined();
    expect(u.workspaces).toBeUndefined();
    expect(u.org).toBeUndefined();
    expect(u.is_org_manager).toBeUndefined();
  });

  it('never claims the account is verified', () => {
    expect(minimalUserFromClaims({sub: 'u', role: 'individual'}).is_verified).toBe(false);
  });
});
