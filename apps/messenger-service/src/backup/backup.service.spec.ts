/**
 * Audit P0-1 — server-side verify protocol.
 *
 * The endpoint contract:
 *   1. GET /identity/header issues a fresh single-use nonce + reports
 *      whether the row is legacy (verifierMissing).
 *   2. POST /identity/verify validates HMAC-SHA256(verifier_key,
 *      "bravo-backup-verify-v1:userId:nonce"), consumes the nonce, and
 *      either mints a single-use verifyToken or atomically bumps
 *      failed_attempts (and locks the row at the threshold).
 *   3. GET /identity/bundle requires the verifyToken — without it the
 *      wrapped bytes are unreachable even with a valid JWT.
 *
 * These specs lock the contract so the client/server pair cannot drift.
 * They mock Supabase (the row store) and Redis (the nonce/token store)
 * with hand-rolled fakes — the real wire formats are exercised in
 * integration tests, but the protocol logic is what matters here.
 */
import {createHmac} from 'crypto';
import {HttpException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {BackupService} from './backup.service';
import type {RedisService} from '../redis/redis.service';

// ─── Fakes ────────────────────────────────────────────────────────────

class FakeRedis {
  private store = new Map<string, {v: string; expiresAt: number}>();
  client = this as unknown as RedisService['client'];

  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
    // Args: 'EX', ttlSec — we honor TTL by recording expiry timestamp.
    const exIdx = _args.findIndex(a => a === 'EX');
    const ttl = exIdx >= 0 ? Number(_args[exIdx + 1]) : 3600;
    this.store.set(key, {v: value, expiresAt: Date.now() + ttl * 1000});
    return 'OK';
  }
  async getdel(key: string): Promise<string | null> {
    const e = this.store.get(key);
    if (!e) return null;
    this.store.delete(key);
    if (e.expiresAt < Date.now()) return null;
    return e.v;
  }
}

interface FakeRow {
  user_id: string;
  wrapped_master_key: string;
  salt: string;
  kdf_params: Record<string, unknown>;
  wrapped_identity_bundle: string;
  verifier_key: string | null;
  failed_attempts: number;
  locked_until: string | null;
}

/**
 * Hand-rolled stand-in for the `c.from(table).select().eq().maybeSingle()`
 * chain. We model just enough to drive verifyProof / getIdentityBundle /
 * putIdentity on `identity_backups`.
 */
function fakeSupabaseFor(rows: Map<string, FakeRow>): unknown {
  const tableHandler = (table: string) => {
    if (table !== 'identity_backups') {
      // Other tables aren't exercised in these tests.
      return {
        select: () => ({eq: () => ({maybeSingle: async () => ({data: null, error: null})})}),
        upsert: async () => ({error: null}),
        delete: () => ({eq: async () => ({error: null})}),
      };
    }
    return {
      select(_cols: string) {
        return {
          eq(_col: string, userId: string) {
            return {
              async maybeSingle() {
                const row = rows.get(userId);
                if (!row) return {data: null, error: null};
                // Server expects `\x...` hex form on bytea reads. Encode
                // it the way Supabase would so encodeB64/bytesFromBytea
                // round-trip correctly.
                const enc = (b64: string): string => '\\x' + Buffer.from(b64, 'base64').toString('hex');
                return {
                  data: {
                    wrapped_master_key:      enc(row.wrapped_master_key),
                    salt:                    enc(row.salt),
                    kdf_params:              row.kdf_params,
                    wrapped_identity_bundle: enc(row.wrapped_identity_bundle),
                    verifier_key:            row.verifier_key ? enc(row.verifier_key) : null,
                    failed_attempts:         row.failed_attempts,
                    locked_until:            row.locked_until,
                  },
                  error: null,
                };
              },
            };
          },
        };
      },
      async upsert(input: FakeRow) {
        const u = input.user_id;
        rows.set(u, {...rows.get(u), ...input} as FakeRow);
        return {error: null};
      },
      update(patch: Partial<FakeRow>) {
        return {
          async eq(_col: string, userId: string) {
            const r = rows.get(userId);
            if (r) rows.set(userId, {...r, ...patch} as FakeRow);
            return {error: null};
          },
        };
      },
    };
  };
  return {from: tableHandler};
}

function makeService(opts: {
  rows: Map<string, FakeRow>;
  redis: FakeRedis;
  maxFailedAttempts?: number;
}): BackupService {
  const cfg = new ConfigService({
    backup: {
      supabaseUrl:           'http://test',
      supabaseServiceRoleKey: 'svc',
      maxFailedAttempts:     opts.maxFailedAttempts ?? 3,
      lockoutSeconds:        3600,
      maxMessageBatchSize:   500,
    },
  });
  const svc = new BackupService(cfg, opts.redis as unknown as RedisService);
  // Swap the Supabase client for our fake (the constructor created a
  // real one with no URL, but we replace before any call uses it).
  (svc as unknown as {client: unknown}).client = fakeSupabaseFor(opts.rows);
  return svc;
}

// ─── Crypto helpers for the test (mirror client/server) ──────────────

function computeProof(verifierKey: Buffer, userId: string, nonce: string): string {
  const mac = createHmac('sha256', verifierKey);
  mac.update(Buffer.from('bravo-backup-verify-v1', 'utf8'));
  mac.update(Buffer.from(':', 'utf8'));
  mac.update(Buffer.from(userId, 'utf8'));
  mac.update(Buffer.from(':', 'utf8'));
  mac.update(Buffer.from(nonce, 'utf8'));
  return mac.digest('base64');
}

function makeRow(userId: string, verifierKey: Buffer | null, overrides?: Partial<FakeRow>): FakeRow {
  return {
    user_id:                 userId,
    wrapped_master_key:      Buffer.alloc(60).toString('base64'),
    salt:                    Buffer.alloc(16).toString('base64'),
    kdf_params:              {algo: 'argon2id', memoryKib: 65536, iterations: 3, parallelism: 1, saltBytes: 16, derivedKeyBytes: 32},
    wrapped_identity_bundle: Buffer.alloc(200).toString('base64'),
    verifier_key:            verifierKey ? verifierKey.toString('base64') : null,
    failed_attempts:         0,
    locked_until:            null,
    ...overrides,
  };
}

// ─── Specs ────────────────────────────────────────────────────────────

describe('BackupService — P0-1 verify protocol', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const verifierKey = Buffer.alloc(32, 0xaa);

  it('header issues a fresh nonce and surfaces verifierMissing=false on a P0-1 row', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, verifierKey)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const header = await svc.getIdentityHeader(userId);
    expect(header.userId).toBe(userId);
    expect(header.verifierMissing).toBe(false);
    expect(typeof header.verifyNonce).toBe('string');
    expect(header.verifyNonce.length).toBeGreaterThan(0);
    expect(header.verifyNonceTtlSec).toBeGreaterThan(0);
  });

  it('header surfaces verifierMissing=true on a legacy row (verifier_key NULL)', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, null)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const header = await svc.getIdentityHeader(userId);
    expect(header.verifierMissing).toBe(true);
  });

  it('verify with a correct proof mints a verifyToken AND resets failed_attempts', async () => {
    const row = makeRow(userId, verifierKey, {failed_attempts: 2});
    const rows = new Map<string, FakeRow>([[userId, row]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const header = await svc.getIdentityHeader(userId);
    const proof = computeProof(verifierKey, userId, header.verifyNonce);
    const res = await svc.verifyProof(userId, {nonce: header.verifyNonce, proofB64: proof});

    expect(typeof res.verifyToken).toBe('string');
    expect(res.verifyTokenTtlSec).toBeGreaterThan(0);
    expect(rows.get(userId)!.failed_attempts).toBe(0);
    expect(rows.get(userId)!.locked_until).toBeNull();
  });

  it('verify with a wrong proof rejects with 401 AND bumps failed_attempts', async () => {
    const row = makeRow(userId, verifierKey);
    const rows = new Map<string, FakeRow>([[userId, row]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const header = await svc.getIdentityHeader(userId);
    const wrongProof = Buffer.alloc(32, 0xff).toString('base64');
    await expect(svc.verifyProof(userId, {nonce: header.verifyNonce, proofB64: wrongProof}))
      .rejects.toThrow(HttpException);
    expect(rows.get(userId)!.failed_attempts).toBe(1);
  });

  it('verify locks the row after maxFailedAttempts consecutive wrong proofs', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, verifierKey)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis, maxFailedAttempts: 3});

    const wrongProof = Buffer.alloc(32, 0xff).toString('base64');
    for (let i = 0; i < 3; i++) {
      const h = await svc.getIdentityHeader(userId);
      try {
        await svc.verifyProof(userId, {nonce: h.verifyNonce, proofB64: wrongProof});
      } catch { /* expected */ }
    }
    const r = rows.get(userId)!;
    expect(r.failed_attempts).toBe(3);
    expect(r.locked_until).not.toBeNull();
    // Subsequent verify (even with a correct proof) is 423 LOCKED.
    const h2 = await svc.getIdentityHeader(userId);
    const goodProof = computeProof(verifierKey, userId, h2.verifyNonce);
    await expect(svc.verifyProof(userId, {nonce: h2.verifyNonce, proofB64: goodProof}))
      .rejects.toMatchObject({status: 423});
  });

  it('verify rejects a nonce that was never issued (no remote counter burn)', async () => {
    const row = makeRow(userId, verifierKey);
    const rows = new Map<string, FakeRow>([[userId, row]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const proof = computeProof(verifierKey, userId, 'forged-nonce');
    await expect(svc.verifyProof(userId, {nonce: 'forged-nonce', proofB64: proof}))
      .rejects.toMatchObject({status: 410});
    // Critically — failed_attempts is NOT bumped on missing-nonce path,
    // otherwise an attacker without verifier_key could remotely lock out
    // the legitimate user by posting random nonces.
    expect(rows.get(userId)!.failed_attempts).toBe(0);
  });

  it('verify is single-use per nonce (replay is rejected)', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, verifierKey)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const h = await svc.getIdentityHeader(userId);
    const proof = computeProof(verifierKey, userId, h.verifyNonce);
    await svc.verifyProof(userId, {nonce: h.verifyNonce, proofB64: proof});
    // Same nonce, same proof — the nonce was consumed; the server treats
    // this as the same shape as a forged-nonce attempt (410 Gone).
    await expect(svc.verifyProof(userId, {nonce: h.verifyNonce, proofB64: proof}))
      .rejects.toMatchObject({status: 410});
  });

  it('verify rejects legacy rows with 409 verifier_missing (no proof can succeed)', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, null)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const h = await svc.getIdentityHeader(userId);
    const proof = computeProof(verifierKey, userId, h.verifyNonce);
    await expect(svc.verifyProof(userId, {nonce: h.verifyNonce, proofB64: proof}))
      .rejects.toMatchObject({status: 409});
  });

  it('getIdentityBundle without a verify token is 403 verify_required', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, verifierKey)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    await expect(svc.getIdentityBundle(userId, undefined))
      .rejects.toMatchObject({status: 403});
    await expect(svc.getIdentityBundle(userId, ''))
      .rejects.toMatchObject({status: 403});
  });

  it('getIdentityBundle with a valid verify token returns the wrapped bundle exactly once', async () => {
    const rows = new Map<string, FakeRow>([[userId, makeRow(userId, verifierKey)]]);
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    const h = await svc.getIdentityHeader(userId);
    const proof = computeProof(verifierKey, userId, h.verifyNonce);
    const {verifyToken} = await svc.verifyProof(userId, {nonce: h.verifyNonce, proofB64: proof});

    const bundle = await svc.getIdentityBundle(userId, verifyToken);
    expect(bundle.wrappedMasterKey).toBeTruthy();
    expect(bundle.wrappedIdentityBundle).toBeTruthy();

    // Replaying the same token is 403 — single-use per /verify success.
    await expect(svc.getIdentityBundle(userId, verifyToken))
      .rejects.toMatchObject({status: 403});
  });

  it('putIdentity rejects when verifierKey is missing (clients pre-P0-1 fail loudly)', async () => {
    const rows = new Map<string, FakeRow>();
    const redis = new FakeRedis();
    const svc = makeService({rows, redis});

    await expect(svc.putIdentity(userId, {
      wrappedMasterKey:      Buffer.alloc(60).toString('base64'),
      salt:                  Buffer.alloc(16).toString('base64'),
      kdfParams:             {algo: 'argon2id'},
      wrappedIdentityBundle: Buffer.alloc(200).toString('base64'),
      // verifierKey deliberately absent
    } as unknown as Parameters<BackupService['putIdentity']>[1])).rejects.toThrow(/verifier_key/);
  });
});
