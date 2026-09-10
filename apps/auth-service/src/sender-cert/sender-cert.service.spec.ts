import {Test, TestingModule}    from '@nestjs/testing';
import {ConfigService}           from '@nestjs/config';
import {AsyncCurve25519Wrapper}  from '@privacyresearch/curve25519-typescript';
import {randomBytes}             from 'node:crypto';
import {SenderCertService}       from './sender-cert.service';
import {RedisService}            from '../redis/redis.service';

/**
 * Smoke-tests the XEd25519 cert issuer end-to-end: mint a cert with a
 * fresh keypair, verify the wire shape, and confirm the signature
 * passes when checked with the matching public key (and fails with a
 * different one). This is the pre-flight that catches regressions
 * before they hit the mobile/ops-console verifiers.
 */

const curve = new AsyncCurve25519Wrapper();

async function makeKeypair(): Promise<{privB64: string; pubB64: string; pubAb: ArrayBuffer}> {
  const seed = randomBytes(32);
  const seedAb = seed.buffer.slice(seed.byteOffset, seed.byteOffset + 32);
  const kp = await curve.keyPair(seedAb);
  return {
    privB64: Buffer.from(kp.privKey).toString('base64'),
    pubB64:  Buffer.from(kp.pubKey).toString('base64'),
    pubAb:   kp.pubKey,
  };
}

const mockRedis = {client: {set: jest.fn(), get: jest.fn(), incr: jest.fn(), expire: jest.fn(), scan: jest.fn()}};

describe('SenderCertService', () => {
  let svc: SenderCertService;
  let kp: Awaited<ReturnType<typeof makeKeypair>>;

  beforeEach(async () => {
    kp = await makeKeypair();
    const cfgMap: Record<string, unknown> = {
      'senderCert.privateKeyB64': kp.privB64,
      'senderCert.ttlSeconds':    3600,
      'senderCert.issuer':        'auth-service',
    };
    const mockConfig = {get: (k: string) => cfgMap[k]};
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SenderCertService,
        {provide: ConfigService,  useValue: mockConfig},
        {provide: RedisService,   useValue: mockRedis},
      ],
    }).compile();
    svc = module.get(SenderCertService);
  });

  it('mints a 3-segment cert with the expected XEd25519 header', async () => {
    const {cert, expiresAt, jti} = await svc.issue({
      senderUserId: 'u1', senderSignalDeviceId: 1, senderIdentityKey: 'AAAA',
    });
    const parts = cert.split('.');
    expect(parts).toHaveLength(3);
    const header = JSON.parse(Buffer.from(parts[0], 'base64').toString('utf8'));
    expect(header).toEqual({alg: 'XEd25519', typ: 'BSC'});
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    expect(payload.senderUserId).toBe('u1');
    expect(payload.senderSignalDeviceId).toBe(1);
    expect(payload.senderIdentityKey).toBe('AAAA');
    expect(payload.iss).toBe('auth-service');
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(payload.exp).toBe(expiresAt);
    expect(jti).toBe(payload.jti);
  });

  it('P2-17 — embeds the caller current revoke-all generation in the signed payload', async () => {
    mockRedis.client.get.mockResolvedValueOnce('3');
    const {cert} = await svc.issue({
      senderUserId: 'u1', senderSignalDeviceId: 1, senderIdentityKey: 'AAAA',
    });
    const payload = JSON.parse(Buffer.from(cert.split('.')[1], 'base64').toString('utf8'));
    expect(payload.gen).toBe(3);
    // still the same 3-segment signed shape — additive, not a wire break.
    expect(cert.split('.')).toHaveLength(3);
  });

  it('P2-17 — defaults gen to 0 when the user has never revoked all sessions', async () => {
    mockRedis.client.get.mockResolvedValueOnce(undefined);
    const {cert} = await svc.issue({
      senderUserId: 'u1', senderSignalDeviceId: 1, senderIdentityKey: 'AAAA',
    });
    const payload = JSON.parse(Buffer.from(cert.split('.')[1], 'base64').toString('utf8'));
    expect(payload.gen).toBe(0);
  });

  it('produces a signature that verifies against the matching public key', async () => {
    const {cert} = await svc.issue({
      senderUserId: 'u1', senderSignalDeviceId: 1, senderIdentityKey: 'AAAA',
    });
    const [headerB64, payloadB64, sigB64] = cert.split('.');
    const sig = Buffer.from(sigB64, 'base64');
    const msg = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const sigAb = sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength);
    const msgAb = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
    // verify returns truthy for INVALID — falsy means the signature is good.
    const verifyResult = await curve.verify(kp.pubAb, msgAb, sigAb);
    expect(verifyResult).toBeFalsy();
  });

  it('produces a signature that FAILS to verify with a different public key', async () => {
    const {cert} = await svc.issue({
      senderUserId: 'u1', senderSignalDeviceId: 1, senderIdentityKey: 'AAAA',
    });
    const [headerB64, payloadB64, sigB64] = cert.split('.');
    const sig = Buffer.from(sigB64, 'base64');
    const msg = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const other = await makeKeypair();
    const sigAb = sig.buffer.slice(sig.byteOffset, sig.byteOffset + sig.byteLength);
    const msgAb = msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength);
    const verifyResult = await curve.verify(other.pubAb, msgAb, sigAb);
    expect(verifyResult).toBeTruthy();
  });

  it('throws sender_cert_private_key_missing when env is unset', async () => {
    const cfgMap: Record<string, unknown> = {
      'senderCert.ttlSeconds': 3600, 'senderCert.issuer': 'auth-service',
    };
    const mockConfig = {get: (k: string) => cfgMap[k]};
    const module = await Test.createTestingModule({
      providers: [
        SenderCertService,
        {provide: ConfigService, useValue: mockConfig},
        {provide: RedisService,  useValue: mockRedis},
      ],
    }).compile();
    const blankSvc = module.get(SenderCertService);
    await expect(
      blankSvc.issue({senderUserId: 'u1', senderSignalDeviceId: 1, senderIdentityKey: 'AAAA'}),
    ).rejects.toThrow(/private_key_missing/);
  });
});
