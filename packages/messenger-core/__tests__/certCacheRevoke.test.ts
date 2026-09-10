import {SenderCertCache, type IssuedCert} from '@bravo/messenger-core';

/**
 * Audit P1-N7 — own-identity rotation must be able to revoke the cert
 * that was issued under the SUPERSEDED identity. Receivers who poll the
 * sender-cert revocation list will then drop traffic still attributed
 * to the prior identity instead of relying purely on the
 * IdentityKeyMismatchError fallback.
 *
 * The cert format under test is `<headerB64>.<payloadB64>.<sigB64>`
 * where the payload carries a `jti` claim. `revokeCurrentAndInvalidate`
 * extracts the JTI, calls the client's `revokeCert`, then drops the
 * local cache so the next `get()` fetches a fresh cert minted under
 * the new identity.
 */
function b64url(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

function fakeCert(jti: string, exp = Math.floor(Date.now() / 1000) + 3600): string {
  return [
    b64url({alg: 'XEd25519', typ: 'BSC'}),
    b64url({jti, exp, iat: exp - 3600, senderUserId: 'alice', senderSignalDeviceId: 1, senderIdentityKey: 'k'}),
    b64url('sig'),
  ].join('.');
}

class FakeClient {
  issued: IssuedCert[] = [];
  revoked: string[] = [];
  revokeStatus: 'ok' | 'missing' | 'throw' = 'ok';

  constructor(initialJti: string) {
    this.issued.push({cert: fakeCert(initialJti), expiresAt: Math.floor(Date.now() / 1000) + 3600});
  }

  async issueCert(): Promise<IssuedCert> {
    const c = this.issued[this.issued.length - 1];
    return c;
  }

  async revokeCert(jti: string): Promise<{revoked: boolean; backendMissing: boolean}> {
    if (this.revokeStatus === 'throw') {throw new Error('boom');}
    if (this.revokeStatus === 'missing') {return {revoked: false, backendMissing: true};}
    this.revoked.push(jti);
    return {revoked: true, backendMissing: false};
  }
}

describe('SenderCertCache — P1-N7 revoke on identity rotation', () => {
  it('revokeCurrentAndInvalidate posts the cached cert\'s jti and clears the cache', async () => {
    const client = new FakeClient('jti-old');
    const cache = new SenderCertCache(
      client as never, 1, 'old-identity-b64',
    );
    // Warm the cache.
    const cert1 = await cache.get();
    expect(cert1).toBe(client.issued[0].cert);

    // Pretend identity just rotated → issue would now return a cert
    // bound to the NEW identity. Push that fresh cert before the
    // invalidate so a subsequent get() fetches it.
    client.issued.push({cert: fakeCert('jti-new'), expiresAt: Math.floor(Date.now() / 1000) + 3600});

    const r = await cache.revokeCurrentAndInvalidate();
    expect(r.revoked).toBe(true);
    expect(r.backendMissing).toBe(false);
    expect(client.revoked).toEqual(['jti-old']);

    // Next get() fetches the newly-pushed cert.
    const cert2 = await cache.get();
    expect(cert2).toBe(client.issued[1].cert);
  });

  it('revokeCurrentAndInvalidate tolerates a missing backend endpoint (404)', async () => {
    const client = new FakeClient('jti-old');
    client.revokeStatus = 'missing';
    const cache = new SenderCertCache(client as never, 1, 'id');
    await cache.get();
    const r = await cache.revokeCurrentAndInvalidate();
    expect(r.revoked).toBe(false);
    expect(r.backendMissing).toBe(true);
    expect(client.revoked).toEqual([]);
  });

  it('revokeCurrentAndInvalidate swallows transport errors so rotation flow can proceed', async () => {
    const client = new FakeClient('jti-old');
    client.revokeStatus = 'throw';
    const cache = new SenderCertCache(client as never, 1, 'id');
    await cache.get();
    const r = await cache.revokeCurrentAndInvalidate();
    expect(r.revoked).toBe(false);
    expect(r.backendMissing).toBe(false);
  });

  it('revokeCurrentAndInvalidate is a no-op when no cert is cached', async () => {
    const client = new FakeClient('jti-old');
    const cache = new SenderCertCache(client as never, 1, 'id');
    const r = await cache.revokeCurrentAndInvalidate();
    expect(r.revoked).toBe(false);
    expect(client.revoked).toEqual([]);
  });
});
