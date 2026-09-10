import {Injectable, Logger, BadRequestException, NotFoundException, HttpException, HttpStatus, OnModuleInit} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Cron, CronExpression} from '@nestjs/schedule';
import {createClient, SupabaseClient} from '@supabase/supabase-js';
import {randomBytes, createHmac, createHash, timingSafeEqual} from 'crypto';
import {RedisService} from '../redis/redis.service';
import {runWithReplicaLock} from '../redis/replica-lock';

export interface BackupConfig {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  maxFailedAttempts: number;
  lockoutSeconds: number;
  maxMessageBatchSize: number;
  /**
   * H-11 — per-user ceiling on mirrored rows in messages_backup /
   * conversation_backups. A generous safety valve (there is no
   * retention sweep on these tables yet — Phase-2) so a runaway or
   * compromised client can't grow one account's mirror without bound.
   */
  maxMessageRowsPerUser?: number;
  /** TTL of the /identity/header verify nonce (seconds). */
  verifyNonceTtlSec?: number;
  /** TTL of the single-use /identity/verify token that unlocks /bundle (seconds). */
  verifyTokenTtlSec?: number;
}

export interface IdentityBackupRow {
  user_id: string;
  wrapped_master_key: string;        // base64 from server JSON
  salt: string;                      // base64
  kdf_params: Record<string, unknown>;
  wrapped_identity_bundle: string;   // base64
  verifier_key: string | null;       // HKDF(derived_key,'bravo-backup-verifier-v1',32B); NULL on legacy rows
  failed_attempts: number;
  locked_until: string | null;
  created_at: string;
  updated_at: string;
}

// P0-1 verify protocol — domain tag pinned byte-for-byte against the
// client (backupCrypto.computeVerifyProof) and backup.service.spec.ts.
const VERIFY_DOMAIN_TAG    = 'bravo-backup-verify-v1';
const DEFAULT_NONCE_TTL_SEC = 300;   // user needs time to type + argon2id derive
const DEFAULT_TOKEN_TTL_SEC = 120;   // short window from proof → bundle GET

export interface MessageMirrorRow {
  message_id: string;
  conversation_id: string;
  sender_id: string;
  recipient_id?: string | null;
  msg_type?: string;
  ciphertext: string;                // base64
  ciphertext_type?: number;
  envelope_meta?: Record<string, unknown>;
  msg_created_at: string;
}

export interface ConversationMirrorRow {
  conversation_id: string;
  kind: 'direct' | 'group' | 'system';
  name?: string | null;
  members?: Array<{userId: string; displayName?: string}>;
  last_message_at?: string | null;
  // Round 8 — round-trip mute / pin / TTL / unread / custom-name flag
  // and group state. Restored conversations now match the original.
  is_muted?: boolean | null;
  is_pinned?: boolean | null;
  default_ttl_sec?: number | null;
  unread_count?: number | null;
  is_custom_name?: boolean | null;
  group_state?: Record<string, unknown> | null;
  // B-594 fresh-install restore — round-trips the user's delete intent so a
  // restore does not resurrect a deleted conversation. Omit-if-absent.
  deleted?: boolean | null;
}

/**
 * BackupService — owns the encrypted-backup tables. The Supabase
 * service-role key bypasses RLS, which is the whole point of this
 * indirection: clients never touch these tables directly, so we get a
 * single chokepoint for the brute-force throttle and audit logging.
 *
 * All ciphertext we accept is opaque to us — the server never decrypts
 * a message and never sees the user's backup password (only a salted
 * argon2id-derived wrap, which the client computes).
 */
@Injectable()
export class BackupService implements OnModuleInit {
  private readonly log = new Logger('BackupService');
  private readonly cfg: BackupConfig;
  private client: SupabaseClient | null = null;
  // B-6 — once-per-process: the missing-migration fallback log must not
  // fire per request (same pattern as AppCheckGuard's once flags).
  private static warnedAtomicRpcMissing = false;
  /**
   * Round 7 / crypto audit fix F5 — when the Supabase project is
   * missing the `sealed_envelope_archive` table, every relay write
   * silently no-ops and the recipient loses every message on next
   * reinstall. We probe the table at boot so a missing migration
   * surfaces immediately instead of months later. False = degraded
   * mode (controller endpoints + the relay's archive write log a
   * warning + skip cleanly); true = healthy.
   */
  private archiveAvailable = false;

  constructor(config: ConfigService, private readonly redis: RedisService) {
    this.cfg = config.get<BackupConfig>('backup') ?? {
      supabaseUrl: '', supabaseServiceRoleKey: '',
      maxFailedAttempts: 5, lockoutSeconds: 3600, maxMessageBatchSize: 500,
      maxMessageRowsPerUser: 500_000,
    };
    if (!this.cfg.supabaseUrl || !this.cfg.supabaseServiceRoleKey) {
      this.log.warn(
        'backup.disabled — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing. ' +
        'POST /backup/* will return 503 until both are set.',
      );
      return;
    }
    this.client = createClient(this.cfg.supabaseUrl, this.cfg.supabaseServiceRoleKey, {
      auth: {persistSession: false, autoRefreshToken: false},
    });
    this.log.log(`backup.init-ok host=${new URL(this.cfg.supabaseUrl).host}`);
  }

  private requireClient(): SupabaseClient {
    if (!this.client) {
      throw new HttpException('backup_disabled', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.client;
  }

  /**
   * Round 7 / crypto audit fix F5 — boot-time probe for the
   * sealed_envelope_archive table. Without this, a deploy that ships
   * before the migration runs leaves the archive permanently inert
   * (every write returns "relation does not exist", which the
   * archiveSealedEnvelope path silently swallows). Surface the state
   * loudly at startup so on-call notices.
   */
  async onModuleInit(): Promise<void> {
    if (!this.client) return;
    try {
      const probe = await this.client
        .from('sealed_envelope_archive')
        .select('envelope_id', {count: 'exact', head: true})
        .limit(1);
      if (probe.error) {
        const msg = probe.error.message || '';
        if (msg.includes('does not exist') || msg.includes('schema cache') || (probe.error as {code?: string}).code === '42P01') {
          this.archiveAvailable = false;
          this.log.error(
            `backup.archive UNAVAILABLE — sealed_envelope_archive table missing. ` +
            `Apply the migration immediately: sealed messages will NOT be recoverable on reinstall until this table exists.`,
          );
          return;
        }
        this.log.warn(`backup.archive probe error: ${msg}`);
      }
      this.archiveAvailable = true;
      this.log.log('backup.archive probe-ok');
    } catch (e) {
      this.archiveAvailable = false;
      this.log.error(`backup.archive probe failed: ${(e as Error).message}`);
    }
    await this.probeAtomicRpc();
  }

  /**
   * B-6 / F3 (critic) — boot-time probe for put_identity_rotation_atomic,
   * same rationale as the archive probe above: a missing migration (or a
   * mis-typed rpc arg name — PostgREST reports both as PGRST202) must be
   * a startup-visible state, not a per-request inference that silently
   * degrades every rotation to the non-atomic sequential path forever.
   * Probing with a NULL user executes the function far enough to prove
   * it EXISTS (the insert then fails not-null, any non-PGRST202 error =
   * function present) without writing anything.
   */
  private async probeAtomicRpc(): Promise<void> {
    if (!this.client) return;
    try {
      const rpcClient = this.client as unknown as {
        rpc?: (fn: string, args: Record<string, unknown>) =>
          Promise<{error: {code?: string; message: string} | null}>;
      };
      if (typeof rpcClient.rpc !== 'function') return;
      const {error} = await rpcClient.rpc('put_identity_rotation_atomic', {
        p_user_id: null, p_wrapped_master_key: null, p_salt: null,
        p_kdf_params: null, p_wrapped_identity_bundle: null, p_verifier_key: null,
      });
      if (error && (error.code === 'PGRST202' || error.code === '42883')) {
        this.log.error(
          'backup.atomic-rpc UNAVAILABLE — put_identity_rotation_atomic missing. ' +
          'Apply migration 20260814190000_put_identity_rotation_atomic.sql: ' +
          'rotations run the NON-ATOMIC legacy path (B-6 windows open) until it lands.',
        );
        return;
      }
      this.log.log('backup.atomic-rpc probe-ok');
    } catch (e) {
      this.log.warn(`backup.atomic-rpc probe failed: ${(e as Error).message}`);
    }
  }

  /**
   * Public health bit — surfaced on the /ready probe (see main.ts) so
   * operators see a missing sealed_envelope_archive table as a DEGRADED
   * readiness field without draining the pod.
   */
  isArchiveAvailable(): boolean {
    return this.archiveAvailable;
  }

  private get maxMessageRowsPerUser(): number {
    return this.cfg.maxMessageRowsPerUser ?? 500_000;
  }

  /**
   * H-11 — best-effort per-user row-count guard for the mirror tables.
   * Neither messages_backup nor conversation_backups has a retention
   * sweep yet (Phase-2), so this is the only bound on a single account's
   * footprint. Best-effort by design: a failing/slow count query returns
   * `false` (do NOT block) so a Supabase hiccup never wedges a legitimate
   * backup flush.
   */
  private async isOverRowCap(
    c: SupabaseClient,
    table: 'messages_backup' | 'conversation_backups',
    ownerUserId: string,
  ): Promise<boolean> {
    const cap = this.maxMessageRowsPerUser;
    if (!Number.isFinite(cap) || cap <= 0) return false;
    try {
      const {count, error} = await c
        .from(table)
        .select('owner_user_id', {count: 'exact', head: true})
        .eq('owner_user_id', ownerUserId);
      if (error) {
        this.log.warn(`row-cap count skipped table=${table} owner=${ownerUserId} err=${error.message}`);
        return false;
      }
      return (count ?? 0) >= cap;
    } catch (e) {
      this.log.warn(`row-cap count failed table=${table}: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * M-7 — best-effort SCAN + DEL of a Redis key pattern. Used by
   * forgetBackup to purge in-flight verify nonces/tokens for a user who
   * wiped their backup. Non-blocking: bounded cursor loop, swallows
   * errors (a Redis blip must not fail the wipe).
   */
  private async scanDelete(pattern: string): Promise<void> {
    try {
      let cursor = '0';
      let guard = 0;
      do {
        const [next, keys] = await this.redis.client.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
        cursor = next;
        if (keys.length > 0) await this.redis.client.del(...keys);
        guard += 1;
      } while (cursor !== '0' && guard < 1000);
    } catch (e) {
      this.log.warn(`scanDelete ${pattern} failed: ${(e as Error).message}`);
    }
  }

  // ── Identity backup ─────────────────────────────────────────────────

  async putIdentity(userId: string, payload: {
    wrappedMasterKey:       string;   // base64
    salt:                   string;   // base64
    kdfParams:              Record<string, unknown>;
    wrappedIdentityBundle:  string;   // base64
    verifierKey:            string;   // base64 — P0-1: HKDF verifier key
  }): Promise<{ok: true}> {
    const c = this.requireClient();

    // P0-1 — every upload MUST carry a verifier key. Clients that
    // pre-date the verify protocol (which never sent one) fail loudly
    // here instead of silently creating a legacy row that can never be
    // restored. The client surfaces a "please update" prompt.
    if (!payload.verifierKey || typeof payload.verifierKey !== 'string') {
      throw new BadRequestException('verifier_key_required');
    }

    // AUDIT-2026-08-13 B-6 — decode EVERYTHING before any write. The
    // sequential path used to decode salt/bundle/verifier AFTER the
    // rotation wipes, so a rotation request carrying one malformed
    // field wiped the mirror and then 400'd — all cost, no write.
    const decoded = {
      user_id:                 userId,
      wrapped_master_key:      decodeB64(payload.wrappedMasterKey,      'wrappedMasterKey'),
      salt:                    decodeB64(payload.salt,                  'salt'),
      kdf_params:              payload.kdfParams,
      wrapped_identity_bundle: decodeB64(payload.wrappedIdentityBundle, 'wrappedIdentityBundle'),
      verifier_key:            decodeB64(payload.verifierKey,           'verifierKey'),
    };

    // B-6 — the rotation wipe + identity upsert as ONE transaction
    // (supabase/migrations/20260814190000_put_identity_rotation_atomic.sql).
    // The sequential path's five separate calls left windows: a failure
    // between the wipes and the upsert stranded the OLD identity over a
    // WIPED mirror — and if the client abandoned setup there, the owner
    // device's mirror_flushed ledger still claimed every row was flushed
    // (BACKUP_LOOP I1), so nothing ever re-uploaded: a silently EMPTY
    // backup behind a valid-looking identity row (the I5 class).
    // Fall back to the sequential path ONLY when the function is absent
    // (migration not yet applied — this repo's migrations do not
    // auto-deploy); any other rpc failure surfaces as backup_write_failed
    // so the client retries the ATOMIC path, never the windowed one.
    const rpcClient = c as unknown as {
      rpc?: (fn: string, args: Record<string, unknown>) =>
        Promise<{data: unknown; error: {code?: string; message: string} | null}>;
    };
    if (typeof rpcClient.rpc === 'function') {
      const {data, error} = await rpcClient.rpc('put_identity_rotation_atomic', {
        p_user_id:                 userId,
        p_wrapped_master_key:      decoded.wrapped_master_key,
        p_salt:                    decoded.salt,
        p_kdf_params:              decoded.kdf_params,
        p_wrapped_identity_bundle: decoded.wrapped_identity_bundle,
        p_verifier_key:            decoded.verifier_key,
      });
      if (!error) {
        // F4 (critic) — postgrest-js rewrites some 404 shapes to
        // {error: null, data: null} (empty-body 404 → 204). Reporting
        // that as success would tell the client to purge its ledger over
        // an identity row that was never written. The function ALWAYS
        // returns {had_existing, rotated}; anything else is not success.
        const out = data as {rotated?: boolean; had_existing?: boolean} | null;
        if (!out || typeof out.had_existing !== 'boolean') {
          this.log.error(`putIdentity atomic-rpc returned no result user=${userId}`);
          throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
        }
        if (out.rotated === true) {
          this.log.warn(`putIdentity rotated master key user=${userId} — mirror+snapshot+merkle wiped ATOMICALLY with the upsert`);
        } else if (out.had_existing === true) {
          this.log.log(`putIdentity re-setup with same master key user=${userId} — preserving mirrored rows`);
        }
        return {ok: true};
      }
      // F2 (critic) — CODE-GATED ONLY. PGRST202 = PostgREST "no function
      // matched the call" (absent OR called with wrong arg names/types);
      // 42883 = Postgres undefined_function (direct passthrough). The
      // earlier message-regex fallback re-admitted live-but-failing
      // functions whose error text merely CONTAINED the phrase (probe
      // P4: a P0001 raised inside a healthy function) — the exact
      // windowed-path re-opening this branch refuses 6 lines up. A
      // code-less error (proxy HTML 404) stays NOT-missing → 502, the
      // safe direction.
      const missing = error.code === 'PGRST202' || error.code === '42883';
      if (!missing) {
        this.log.error(`putIdentity atomic-rpc failed user=${userId} code=${error.code ?? '?'} err=${error.message}`);
        throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
      }
      if (!BackupService.warnedAtomicRpcMissing) {
        BackupService.warnedAtomicRpcMissing = true;
        this.log.error(
          'putIdentity: put_identity_rotation_atomic MISSING — apply migration ' +
          '20260814190000_put_identity_rotation_atomic.sql. Falling back to the ' +
          'NON-ATOMIC sequential path (B-6 windows are open) until it lands.',
        );
      }
    }

    // Round 7 / crypto audit fix F6 — only wipe the message archive
    // when the master key actually rotates. Previously every PUT
    // unconditionally deleted every mirrored row for the user, so a
    // user who tap-tap-tapped "Enable backup" or whose client retried
    // setup after a network blip lost all of their previously-mirrored
    // history. Now we compare the incoming wrapped_master_key with the
    // stored one — if they're identical bytes the wipe is skipped (no
    // rotation actually happened); only a true rotation (different
    // wrapped key, e.g. user changed their password) drops the orphans
    // that would no longer decrypt.
    const {data: existing, error: readErr} = await c
      .from('identity_backups')
      .select('user_id, wrapped_master_key')
      .eq('user_id', userId)
      .maybeSingle();
    if (readErr) {
      // L-3 — a transient read failure must NOT be silently treated as
      // "no existing row" (which would skip the stale-wipe on a real
      // rotation and strand undecryptable orphans). Fail the write so
      // the client retries against a consistent view.
      this.log.error(`putIdentity existing-read-failed user=${userId} err=${readErr.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    // `decodeB64` returns a Postgres bytea literal (`\x<hex>`); the
    // value coming back from Supabase is the same `\x<hex>` string.
    // String equality on the canonical hex form is the simplest
    // exact-bytes comparison and avoids encoding-coercion pitfalls.
    const isRotation = !!existing
      && normalizeBytea(existing.wrapped_master_key) !== normalizeBytea(decoded.wrapped_master_key);
    if (existing && isRotation) {
      this.log.warn(`putIdentity rotating master key user=${userId} — wiping stale message rows + snapshot + merkle`);
      const {error: msgErr} = await c
        .from('messages_backup')
        .delete()
        .eq('owner_user_id', userId);
      if (msgErr) {
        // Don't block the new setup on a partial wipe — log and
        // proceed; the orphan rows will silently fail to decrypt on
        // restore (already handled client-side).
        this.log.error(`putIdentity stale-wipe-failed user=${userId} err=${msgErr.message}`);
      }
      const {error: convErr} = await c
        .from('conversation_backups')
        .delete()
        .eq('owner_user_id', userId);
      if (convErr) {
        this.log.error(`putIdentity stale-conv-wipe-failed user=${userId} err=${convErr.message}`);
      }
      // M-4 — a true rotation also strands the ratchet snapshot (blob
      // encrypted under the OLD master key, and its monotonic seq would
      // 409-block the fresh device forever) and the Merkle commit
      // (signed over the now-wiped mirror). Reset both so the new key's
      // captures/commits start clean. Best-effort; missing tables are
      // fine on partially-migrated deploys.
      await c.from('backup_session_snapshots').delete().eq('user_id', userId)
        .then(r => { if (r.error) this.log.warn(`putIdentity snapshot-reset skipped user=${userId} err=${r.error.message}`); });
      await c.from('backup_merkle_commits').delete().eq('user_id', userId)
        .then(r => { if (r.error) this.log.warn(`putIdentity merkle-reset skipped user=${userId} err=${r.error.message}`); });
    } else if (existing) {
      this.log.log(`putIdentity re-setup with same master key user=${userId} — preserving mirrored rows`);
    }

    const row = {
      ...decoded,
      // Reset throttle counters whenever the user re-uploads — they
      // either set a new password or recovered, either way the
      // server-side guess counter is moot for the new ciphertext.
      failed_attempts: 0,
      locked_until:    null,
    };
    const {error} = await c.from('identity_backups').upsert(row, {onConflict: 'user_id'});
    if (error) {
      this.log.error(`putIdentity failed user=${userId} err=${error.message}`);
      throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
    }
    return {ok: true};
  }

  // ── P0-1 verify protocol — Redis nonce/token helpers ────────────────
  private nonceKey(userId: string, nonce: string): string {
    return `backup:verify:nonce:${userId}:${nonce}`;
  }
  private tokenKey(userId: string, token: string): string {
    return `backup:verify:token:${userId}:${token}`;
  }
  private get nonceTtlSec(): number { return this.cfg.verifyNonceTtlSec ?? DEFAULT_NONCE_TTL_SEC; }
  private get tokenTtlSec(): number { return this.cfg.verifyTokenTtlSec ?? DEFAULT_TOKEN_TTL_SEC; }

  /**
   * Fingerprint of the current verifier key — bound into the verify
   * token so a token minted against an OLD backup can't unlock a
   * backup that was re-setup (new verifier_key) within the token TTL
   * (round-2 audit P0-A race). SHA-256 of the raw verifier bytes.
   */
  private verifierFingerprint(verifierKeyBytea: unknown): string {
    return createHash('sha256').update(bytesFromBytea(verifierKeyBytea)).digest('hex');
  }

  /**
   * P0-1 — returns the metadata needed to derive the master key
   * locally (salt + kdf_params) plus a fresh single-use verify nonce,
   * WITHOUT exposing the wrapped bundle. The client derives the key,
   * computes HMAC(verifier_key, tag:userId:nonce), and POSTs it to
   * /verify; only on success does the server mint a token that unlocks
   * /bundle. This keeps the bundle off the wire until the password is
   * proven, and — crucially — moves the brute-force counter server-side
   * so a modified client can't skip it.
   *
   * `verifierMissing` is true for legacy rows (verifier_key NULL): the
   * client detects this and prompts a one-time re-setup, because no
   * proof can succeed and /bundle is unreachable until it re-uploads.
   */
  async getIdentityHeader(userId: string): Promise<{
    userId: string;
    verifierMissing: boolean;
    verifyNonce: string;
    verifyNonceTtlSec: number;
    salt: string;
    kdfParams: Record<string, unknown>;
    failedAttempts: number;
    lockedUntil: string | null;
  }> {
    const c = this.requireClient();
    const {data, error} = await c
      .from('identity_backups')
      .select('salt, kdf_params, failed_attempts, locked_until, verifier_key')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      this.log.error(`getIdentityHeader failed user=${userId} err=${error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (!data) throw new NotFoundException('no_backup');

    // Issue a fresh, single-use nonce and stash it in Redis with a TTL.
    // /verify consumes it via GETDEL, so it can be used at most once and
    // auto-expires if the user abandons the flow.
    const nonce = randomBytes(24).toString('base64url');
    await this.redis.client.set(this.nonceKey(userId, nonce), '1', 'EX', this.nonceTtlSec);

    return {
      userId,
      verifierMissing: data.verifier_key == null,
      verifyNonce:     nonce,
      verifyNonceTtlSec: this.nonceTtlSec,
      salt:            encodeB64(data.salt as unknown),
      kdfParams:       (data.kdf_params ?? {}) as Record<string, unknown>,
      failedAttempts:  Number(data.failed_attempts ?? 0),
      lockedUntil:     data.locked_until as string | null,
    };
  }

  /**
   * P0-1 — validate the client's HMAC proof against the stored
   * verifier key. Consumes the nonce (single-use), enforces the
   * server-side lockout, and on success mints a single-use token that
   * gates /bundle. This is the throttle a modified client cannot skip:
   * every wrong proof bumps failed_attempts server-side regardless of
   * client cooperation.
   *
   * Status codes (see spec): 404 no row · 423 locked · 410 nonce
   * missing/replayed (NOT counted, so an attacker without the verifier
   * key can't remotely lock a user by posting random nonces) · 409
   * legacy row (verifier_missing) · 401 wrong proof (counted).
   */
  async verifyProof(userId: string, body: {nonce: string; proofB64: string}): Promise<{
    verifyToken: string; verifyTokenTtlSec: number;
  }> {
    const c = this.requireClient();
    const {data, error} = await c
      .from('identity_backups')
      .select('verifier_key, failed_attempts, locked_until')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      this.log.error(`verifyProof read failed user=${userId} err=${error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (!data) throw new NotFoundException('no_backup');

    // Already locked → 423, before consuming the nonce.
    if (data.locked_until && new Date(data.locked_until as string).getTime() > Date.now()) {
      throw new HttpException({error: 'locked', lockedUntil: data.locked_until}, 423);
    }

    // Consume the nonce FIRST (single-use). A missing nonce is a forged
    // or replayed request — reject 410 WITHOUT bumping the counter, so
    // an attacker who lacks the verifier key cannot lock out the real
    // user by spraying random nonces.
    const nonceHit = await this.redis.client.getdel(this.nonceKey(userId, body.nonce));
    if (!nonceHit) {
      throw new HttpException({error: 'nonce_expired'}, HttpStatus.GONE);
    }

    // Legacy row — no verifier key was ever uploaded. No proof can
    // succeed; tell the client to re-setup (409).
    if (data.verifier_key == null) {
      throw new HttpException({error: 'verifier_missing'}, HttpStatus.CONFLICT);
    }

    const verifierBytes = bytesFromBytea(data.verifier_key);
    const expected = createHmac('sha256', verifierBytes)
      .update(Buffer.from(VERIFY_DOMAIN_TAG, 'utf8'))
      .update(Buffer.from(':', 'utf8'))
      .update(Buffer.from(userId, 'utf8'))
      .update(Buffer.from(':', 'utf8'))
      .update(Buffer.from(body.nonce, 'utf8'))
      .digest();
    let given: Buffer;
    try { given = Buffer.from(String(body.proofB64), 'base64'); } catch { given = Buffer.alloc(0); }
    const ok = given.length === expected.length && timingSafeEqual(given, expected);

    if (!ok) {
      const failed = await this.bumpFailedAttempts(userId, Number(data.failed_attempts ?? 0));
      this.log.warn(`verifyProof wrong-proof user=${userId} failed=${failed.failedAttempts}${failed.lockedUntil ? ' LOCKED' : ''}`);
      // 401 with a machine-readable body so the client distinguishes
      // "wrong password" from a bearer-token 401 (which would trigger a
      // token refresh + retry, double-counting the attempt).
      throw new HttpException({error: 'wrong_proof', failedAttempts: failed.failedAttempts}, HttpStatus.UNAUTHORIZED);
    }

    // Success — reset the throttle and mint a single-use bundle token.
    const {error: resetErr} = await c
      .from('identity_backups')
      .update({failed_attempts: 0, locked_until: null})
      .eq('user_id', userId);
    if (resetErr) {
      this.log.error(`verifyProof reset failed user=${userId} err=${resetErr.message}`);
    }
    const token = randomBytes(24).toString('base64url');
    // Bind the token to the verifier fingerprint so a token minted
    // against a since-rotated backup can't unlock the new one.
    await this.redis.client.set(
      this.tokenKey(userId, token),
      this.verifierFingerprint(data.verifier_key),
      'EX', this.tokenTtlSec,
    );
    return {verifyToken: token, verifyTokenTtlSec: this.tokenTtlSec};
  }

  /**
   * Read-modify-write bump of failed_attempts with the lockout applied
   * at the threshold. M-5 — production uses the atomic
   * `bump_backup_failed_attempts` RPC when available (race-free under
   * concurrent proofs); we fall back to read-modify-write (which the
   * unit spec exercises) when the RPC isn't deployed.
   */
  private async bumpFailedAttempts(userId: string, currentAttempts: number): Promise<{failedAttempts: number; lockedUntil: string | null}> {
    const c = this.requireClient();
    const lockoutSec = this.cfg.lockoutSeconds;
    const maxAttempts = this.cfg.maxFailedAttempts;
    const rpc = (c as unknown as {rpc?: (fn: string, args: Record<string, unknown>) => Promise<{data: unknown; error: {message: string} | null}>}).rpc;
    if (typeof rpc === 'function') {
      try {
        const {data, error} = await rpc.call(c, 'bump_backup_failed_attempts', {
          p_user_id: userId, p_max_attempts: maxAttempts, p_lockout_sec: lockoutSec,
        });
        if (!error && data && typeof data === 'object') {
          const row = Array.isArray(data) ? data[0] : data;
          return {
            failedAttempts: Number((row as {failed_attempts?: number}).failed_attempts ?? currentAttempts + 1),
            lockedUntil:    ((row as {locked_until?: string | null}).locked_until ?? null) as string | null,
          };
        }
      } catch {
        // Fall through to read-modify-write below.
      }
    }
    const next = currentAttempts + 1;
    const lockedUntil = next >= maxAttempts
      ? new Date(Date.now() + lockoutSec * 1000).toISOString()
      : null;
    const update: Record<string, unknown> = {failed_attempts: next};
    if (lockedUntil) update['locked_until'] = lockedUntil;
    const {error: upErr} = await c.from('identity_backups').update(update).eq('user_id', userId);
    if (upErr) {
      this.log.error(`bumpFailedAttempts update failed user=${userId} err=${upErr.message}`);
      throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
    }
    return {failedAttempts: next, lockedUntil};
  }

  /**
   * P0-1 — pull the wrapped bundle. Requires a single-use verify token
   * minted by /verify; without it the wrapped bytes are unreachable
   * even with a valid JWT (403). The token is consumed on use, so it
   * unlocks exactly one bundle GET.
   */
  async getIdentityBundle(userId: string, verifyToken?: string): Promise<{
    wrappedMasterKey: string; salt: string; kdfParams: Record<string, unknown>; wrappedIdentityBundle: string;
  }> {
    if (!verifyToken) {
      throw new HttpException({error: 'verify_required'}, HttpStatus.FORBIDDEN);
    }
    const c = this.requireClient();
    // Consume the token (single-use). Its value is the verifier
    // fingerprint captured at mint time.
    const tokenBinding = await this.redis.client.getdel(this.tokenKey(userId, verifyToken));
    if (!tokenBinding) {
      throw new HttpException({error: 'verify_required'}, HttpStatus.FORBIDDEN);
    }
    const {data, error} = await c
      .from('identity_backups')
      .select('wrapped_master_key, salt, kdf_params, wrapped_identity_bundle, verifier_key, locked_until')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      this.log.error(`getIdentityBundle failed user=${userId} err=${error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (!data) throw new NotFoundException('no_backup');
    // Reject if the backup was re-setup (new verifier_key) after this
    // token was minted — the token proves knowledge of the OLD password.
    if (data.verifier_key == null || this.verifierFingerprint(data.verifier_key) !== tokenBinding) {
      throw new HttpException({error: 'verify_required'}, HttpStatus.FORBIDDEN);
    }
    if (data.locked_until && new Date(data.locked_until as string).getTime() > Date.now()) {
      throw new HttpException({error: 'locked', lockedUntil: data.locked_until}, 423);
    }
    return {
      wrappedMasterKey:       encodeB64(data.wrapped_master_key as unknown),
      salt:                   encodeB64(data.salt as unknown),
      kdfParams:              (data.kdf_params ?? {}) as Record<string, unknown>,
      wrappedIdentityBundle:  encodeB64(data.wrapped_identity_bundle as unknown),
    };
  }

  /**
   * Round 5 / Security S8 — store the Merkle commit signed by the
   * client. The server CANNOT forge a new commit (no priv key), so
   * even a fully-compromised database can only return a stale
   * (legitimately-signed) commit. Client-side replay protection
   * (locally-cached last-seen seq on the same device) closes the gap
   * for re-restores; fresh-device restore relies on the client's
   * willingness to refuse if the row count looks anomalously low.
   *
   * Storage: a sibling `backup_merkle_commits` table keyed by
   * user_id. We use a separate table (not a column on the existing
   * identity_backups row) to keep the schema migration safe — older
   * deployments without the table just see a 503 from the new path.
   *
   * Implementation note: the existing identity_backups path predates
   * this fix and is kept intact. The `kdf_params` JSON column would
   * be a tempting place to stash the commit, but kdf_params is hot-
   * read on every login (header endpoint) so co-locating a
   * write-heavy commit field would introduce contention.
   */
  async putMerkleCommit(userId: string, dto: {
    rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string;
  }): Promise<{ok: true}> {
    const c = this.requireClient();
    if (!Number.isFinite(dto.seq) || dto.seq < 0) {
      throw new BadRequestException('invalid_seq');
    }
    // L-9 — monotonic seq guard (mirrors putSessionSnapshot). Without
    // this, any JWT holder could overwrite the stored commit with an
    // older but legitimately-signed one, rolling the client's integrity
    // baseline backwards on a fresh-device restore. Reject a strictly-
    // lower seq with 409; an equal seq is allowed (idempotent re-commit).
    const existing = await c
      .from('backup_merkle_commits')
      .select('seq')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing.error) {
      if (/relation .+ does not exist|schema cache/i.test(existing.error.message)) {
        this.log.warn(`putMerkleCommit table missing user=${userId}`);
        throw new HttpException('merkle_disabled', HttpStatus.SERVICE_UNAVAILABLE);
      }
      this.log.error(`putMerkleCommit read failed user=${userId} err=${existing.error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (existing.data && Number(existing.data.seq) > dto.seq) {
      throw new HttpException(
        {error: 'stale_seq', currentSeq: Number(existing.data.seq)},
        HttpStatus.CONFLICT,
      );
    }
    const row = {
      user_id:    userId,
      root_b64:   dto.rootB64,
      row_count:  dto.rowCount,
      seq:        dto.seq,
      sent_at_ms: dto.sentAtMs,
      sig_b64:    dto.sigB64,
    };
    const {error} = await c.from('backup_merkle_commits').upsert(row, {onConflict: 'user_id'});
    if (error) {
      // Table missing — log + downgrade to a soft no-op so older
      // deployments don't 500 on every commit. The client interprets
      // a 503 as "feature not yet enabled on this server" and
      // continues without S8 protection.
      this.log.warn(`putMerkleCommit suppressed user=${userId} err=${error.message}`);
      throw new HttpException('merkle_disabled', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return {ok: true};
  }

  async getMerkleCommit(userId: string): Promise<{
    rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string;
  } | null> {
    const c = this.requireClient();
    const {data, error} = await c
      .from('backup_merkle_commits')
      .select('root_b64, row_count, seq, sent_at_ms, sig_b64')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      this.log.warn(`getMerkleCommit suppressed user=${userId} err=${error.message}`);
      return null;
    }
    if (!data) {return null;}
    return {
      rootB64:   data.root_b64 as string,
      rowCount:  Number(data.row_count),
      seq:       Number(data.seq),
      sentAtMs:  Number(data.sent_at_ms),
      sigB64:    data.sig_b64 as string,
    };
  }

  /**
   * Sprint-6 backend hand-off — store the encrypted ratchet-state
   * snapshot. The blob is opaque AES-256-GCM ciphertext under the
   * client's backup master key (which the server never sees); the
   * server only enforces a monotonic `seq` so a compromised server
   * can't roll the client back to a prior ratchet state by serving
   * an older snapshot.
   *
   * Concurrency: SELECT-then-UPSERT inside the same call window is
   * racy under concurrent writers, but the client only ever has one
   * uploader per device and the consequence of a lost race is a 409
   * the client treats as a benign "no-op" (the newer seq is already
   * in place). Hardening the seq check into a single SQL statement
   * with a CHECK would require a Postgres function — overkill given
   * the realistic call pattern.
   */
  async putSessionSnapshot(userId: string, payload: {
    blob: string;   // base64
    seq:  number;
  }): Promise<{ok: true; seq: number}> {
    const c = this.requireClient();
    if (typeof payload?.blob !== 'string' || payload.blob.length === 0) {
      throw new BadRequestException('invalid_blob');
    }
    if (!Number.isFinite(payload.seq) || payload.seq < 0) {
      throw new BadRequestException('invalid_seq');
    }
    const existing = await c
      .from('backup_session_snapshots')
      .select('seq')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing.error) {
      // Treat missing-table as "feature not enabled in this deployment"
      // so a pre-migration server returns 503 — the client's idempotent
      // upload path catches the 503 and proceeds without the snapshot.
      if (/relation .+ does not exist|schema cache/i.test(existing.error.message)) {
        this.log.warn(`putSessionSnapshot table missing user=${userId}`);
        throw new HttpException('session_snapshot_disabled', HttpStatus.SERVICE_UNAVAILABLE);
      }
      this.log.error(`putSessionSnapshot read failed user=${userId} err=${existing.error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (existing.data && Number(existing.data.seq) >= payload.seq) {
      // Rollback defence — the stored snapshot is at least as recent as
      // what the client is trying to upload. 409 lets the client log +
      // skip without treating it as a hard error.
      throw new HttpException(
        {error: 'stale_seq', currentSeq: Number(existing.data.seq)},
        HttpStatus.CONFLICT,
      );
    }
    const row = {
      user_id: userId,
      blob:    decodeB64(payload.blob, 'blob'),
      seq:     payload.seq,
    };
    const {error} = await c
      .from('backup_session_snapshots')
      .upsert(row, {onConflict: 'user_id'});
    if (error) {
      this.log.error(`putSessionSnapshot write failed user=${userId} err=${error.message}`);
      throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
    }
    return {ok: true, seq: payload.seq};
  }

  /**
   * Sprint-6 backend hand-off — pull the latest encrypted ratchet
   * snapshot. Returns `null` when none has been uploaded yet (the
   * normal pre-restore state on a brand-new account) so the client's
   * `applyRatchetSnapshot` reports `no_snapshot` rather than throwing.
   */
  async getSessionSnapshot(userId: string): Promise<{blob: string; seq: number} | null> {
    const c = this.requireClient();
    const {data, error} = await c
      .from('backup_session_snapshots')
      .select('blob, seq')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      // Missing-table → null so a pre-migration deployment behaves the
      // same as "no snapshot uploaded yet" — client falls back to the
      // existing ratchet-recovery counter path without a hard failure.
      if (/relation .+ does not exist|schema cache/i.test(error.message)) {
        return null;
      }
      this.log.error(`getSessionSnapshot failed user=${userId} err=${error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (!data) {return null;}
    return {
      blob: encodeB64(data.blob as unknown),
      seq:  Number(data.seq),
    };
  }

  /**
   * "Forget my backup" — used when the user has lost their password
   * past recovery and wants to start fresh. Wipes everything we hold
   * for them: identity bundle + every mirrored conversation/message
   * + sealed envelope archive + Merkle commit row.
   *
   * Round 11.1 — fail-soft semantics. Previously a single Supabase
   * error (most often "relation does not exist" against a table the
   * deployed migration hadn't created yet) bounced the entire forget
   * call as 502, locking the user out of the "wipe + start fresh"
   * path indefinitely. The user-facing screen showed "Could not wipe
   * backup http_502:backup_purge_failed" with no obvious recovery —
   * exactly the report on the Pixel screenshot. Now we:
   *
   *   • Treat missing-table errors as success per-table (the row was
   *     never going to exist there anyway).
   *   • Treat 0-rows-affected as success (idempotent: nothing left to
   *     wipe is functionally identical to nothing was wiped).
   *   • Wipe sealed_envelope_archive too — Agent 3 P1 #11 audit finding
   *     deferred from Round 11. Without this the server retains 90 days
   *     of opaque ciphertext envelopes for a user who explicitly asked
   *     us to forget them. Privacy regression vs WhatsApp's "permanently
   *     lost" semantics.
   *   • Only return 502 when EVERY table delete failed with a non-
   *     missing-table error. Partial-purge logs a warning and returns
   *     200 — the user's intent ("get me out") is honored even if a
   *     single row couldn't be reached.
   */
  async forgetBackup(userId: string): Promise<{ok: true}> {
    const c = this.requireClient();
    const errors: string[] = [];
    let anySucceeded = false;

    // M-7 — set a short-lived tombstone FIRST so any archive-retry entry
    // still queued (or a drain running concurrently on another replica)
    // sees it and refuses to re-create rows for a user who just invoked
    // the privacy wipe. tryArchiveOnce consults this before every upsert.
    // TTL ≈ the automated retry horizon (OUTBOX_MAX_ATTEMPTS × drain
    // cadence); once it lapses no scheduled retry can still fire.
    try {
      await this.redis.client.set(
        BackupService.forgottenKey(userId), '1', 'EX', BackupService.FORGOTTEN_TTL_SEC,
      );
    } catch (e) {
      this.log.warn(`forgetBackup tombstone set failed user=${userId}: ${(e as Error).message}`);
    }

    /**
     * Recognise the "relation does not exist" / schema-cache shape that
     * Supabase returns for a not-yet-migrated table. Different Supabase
     * versions phrase it slightly differently; the `42P01` Postgres code
     * is the authoritative signal.
     */
    const isMissingTable = (msg: string, code?: string): boolean =>
      code === '42P01'
      || /relation .+ does not exist/i.test(msg)
      || /could not find the table/i.test(msg)
      || /schema cache/i.test(msg);

    type TargetTable =
      | {name: 'identity_backups';          col: 'user_id'}
      | {name: 'messages_backup';           col: 'owner_user_id'}
      | {name: 'conversation_backups';      col: 'owner_user_id'}
      | {name: 'sealed_envelope_archive';   col: 'recipient_user_id'}
      | {name: 'backup_merkle_commits';     col: 'user_id'}
      | {name: 'backup_session_snapshots';  col: 'user_id'};
    const targets: TargetTable[] = [
      {name: 'identity_backups',          col: 'user_id'},
      {name: 'messages_backup',           col: 'owner_user_id'},
      {name: 'conversation_backups',      col: 'owner_user_id'},
      {name: 'sealed_envelope_archive',   col: 'recipient_user_id'},
      {name: 'backup_merkle_commits',     col: 'user_id'},
      {name: 'backup_session_snapshots',  col: 'user_id'},
    ];

    for (const t of targets) {
      const {error} = await c.from(t.name).delete().eq(t.col, userId);
      if (!error) {
        anySucceeded = true;
        continue;
      }
      if (isMissingTable(error.message, (error as {code?: string}).code)) {
        // Table doesn't exist in this deployment — can't have stored
        // anything there. Functionally equivalent to a successful wipe.
        anySucceeded = true;
        this.log.log(`forgetBackup ${t.name} missing — treating as already-wiped user=${userId}`);
        continue;
      }
      errors.push(`${t.name}: ${error.message}`);
    }

    // Hard-fail only when every single attempt errored AND none of them
    // were "missing table" (i.e. real Supabase outage / RLS denial).
    // Anything else is "good enough" — the user's wipe intent stands.
    if (errors.length > 0 && !anySucceeded) {
      this.log.error(`forgetBackup all-failed user=${userId} errs=${errors.join(' | ')}`);
      throw new HttpException('backup_purge_failed', HttpStatus.BAD_GATEWAY);
    }
    if (errors.length > 0) {
      this.log.warn(`forgetBackup partial-purge (returning ok) user=${userId} errs=${errors.join(' | ')}`);
    }

    // M-7 — invalidate any in-flight verify ceremony so the wipe also
    // drops a half-finished unlock (nonce issued but /verify never
    // completed, or a minted /bundle token). Best-effort SCAN + DEL.
    await this.scanDelete(`backup:verify:nonce:${userId}:*`);
    await this.scanDelete(`backup:verify:token:${userId}:*`);

    // M-7 — best-effort proactive purge of this user's queued archive-
    // retry entries so they don't wait out the tombstone. Bounded scan;
    // the tombstone above is the real guarantee if this misses any under
    // concurrent churn.
    await this.purgeOutboxForUser(userId);

    return {ok: true};
  }

  /**
   * M-7 — remove every archive-retry outbox entry addressed to `userId`.
   * The list interleaves all users; we LRANGE a bounded window, LREM the
   * matches, and keep the approximate byte counter in step. Best-effort.
   */
  private async purgeOutboxForUser(userId: string): Promise<void> {
    try {
      const entries = await this.redis.client.lrange(
        BackupService.OUTBOX_KEY, 0, BackupService.OUTBOX_MAX_LEN,
      );
      for (const raw of entries) {
        let rec: string | undefined;
        try { rec = (JSON.parse(raw) as {recipientUserId?: string}).recipientUserId; }
        catch { continue; }
        if (rec !== userId) continue;
        const removed = await this.redis.client.lrem(BackupService.OUTBOX_KEY, 0, raw);
        if (removed > 0) {
          await this.redis.client
            .decrby(BackupService.OUTBOX_BYTES_KEY, Buffer.byteLength(raw, 'utf8') * removed)
            .catch(() => 0);
        }
      }
    } catch (e) {
      this.log.warn(`forgetBackup outbox purge skipped user=${userId}: ${(e as Error).message}`);
    }
    // AUDIT #15 rev-2 (critic catch) — the staging list is a SECOND durable
    // location for outbox rows; without this pass a wiped user's staged row
    // survives the M-7 purge, outlives the 1h forget-tombstone (which only
    // covers the consume horizon, not an indefinitely-parked row), and a
    // later drain's reclaim re-archives data the user deleted. No decrby
    // here: bytes were already decremented when the row was staged.
    // rev-3: OWN catch — an outbox-pass failure must not skip this pass.
    try {
      const staged = await this.redis.client.lrange(
        BackupService.OUTBOX_PROCESSING_KEY, 0, BackupService.OUTBOX_MAX_LEN,
      );
      for (const raw of staged) {
        let rec: string | undefined;
        try { rec = (JSON.parse(raw) as {recipientUserId?: string}).recipientUserId; }
        catch { continue; }
        if (rec !== userId) continue;
        await this.redis.client.lrem(BackupService.OUTBOX_PROCESSING_KEY, 0, raw);
      }
    } catch (e) {
      this.log.warn(`forgetBackup staging purge skipped user=${userId}: ${(e as Error).message}`);
    }
  }

  // ── Message mirror ──────────────────────────────────────────────────

  async putMessages(ownerUserId: string, rows: MessageMirrorRow[]): Promise<{written: number}> {
    if (!Array.isArray(rows) || rows.length === 0) return {written: 0};
    if (rows.length > this.cfg.maxMessageBatchSize) {
      throw new BadRequestException(`batch_too_large_max_${this.cfg.maxMessageBatchSize}`);
    }
    const c = this.requireClient();
    // H-11 — per-user quota guard. messages_backup has NO retention
    // sweep yet: retention here is a deliberate Phase-2 decision (deferred
    // until the storage-cost shape is known — see the note in
    // 20260508120000_backup_round8.sql). Until then this configurable
    // ceiling is the only bound on a single account's footprint. 507
    // (not 429) so a modified client doesn't just hammer-retry; the guard
    // is best-effort so a failing count never blocks a legitimate write.
    if (await this.isOverRowCap(c, 'messages_backup', ownerUserId)) {
      throw new HttpException({error: 'backup_quota_exceeded'}, 507);
    }
    // Why: Postgres ON CONFLICT DO UPDATE rejects a batch where two rows
    // share the conflict key with "command cannot affect row a second
    // time". Clients (especially mobile retry queues) can legitimately
    // post a batch containing duplicate message_ids — dedupe here so the
    // whole batch isn't lost to one duplicate. Last-write-wins matches
    // upsert semantics for an idempotent mirror.
    const dedup = new Map<string, MessageMirrorRow>();
    for (const r of rows) {
      dedup.set(r.message_id, r);
    }
    const dbRows = Array.from(dedup.values()).map(r => ({
      owner_user_id:   ownerUserId,
      message_id:      r.message_id,
      conversation_id: r.conversation_id,
      sender_id:       r.sender_id,
      recipient_id:    r.recipient_id ?? null,
      msg_type:        r.msg_type ?? 'text',
      ciphertext:      decodeB64(r.ciphertext, 'ciphertext'),
      ciphertext_type: r.ciphertext_type ?? 1,
      envelope_meta:   r.envelope_meta ?? {},
      msg_created_at:  r.msg_created_at,
    }));
    const {error} = await c
      .from('messages_backup')
      .upsert(dbRows, {onConflict: 'owner_user_id,message_id'});
    if (error) {
      this.log.error(`putMessages failed owner=${ownerUserId} count=${rows.length} err=${error.message}`);
      throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
    }
    return {written: dbRows.length};
  }

  async getMessages(ownerUserId: string, opts: {since?: string; sinceId?: string; limit?: number}): Promise<MessageMirrorRow[]> {
    // Round 8 — tuple cursor on (msg_created_at, message_id).
    // Previously the cursor was timestamp-only with `gt`, which dropped
    // every row sharing a timestamp at the page boundary (groups,
    // bursts, batched mirror writes routinely tie ms timestamps). The
    // new cursor advances strictly past (sinceTs, sinceId) so duplicate
    // timestamps at the boundary are no longer skipped, and the
    // ORDER BY tuple guarantees deterministic tie-break.
    const c = this.requireClient();
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 1000);
    let q = c.from('messages_backup')
      .select('message_id, conversation_id, sender_id, recipient_id, msg_type, ciphertext, ciphertext_type, envelope_meta, msg_created_at')
      .eq('owner_user_id', ownerUserId)
      .order('msg_created_at', {ascending: true})
      .order('message_id', {ascending: true})
      .limit(limit);
    if (opts.since) {
      if (opts.sinceId) {
        // (msg_created_at > since) OR (msg_created_at = since AND message_id > sinceId)
        // PostgREST .or() encoding — M-8: double-quote BOTH the timestamp
        // and the message_id so commas/colons/parens in either can't
        // smuggle a second filter. `since` is additionally validated as a
        // strict ISO-8601 string at the controller edge (400 on malformed).
        const escapedId = String(opts.sinceId).replace(/"/g, '\\"');
        const escapedSince = String(opts.since).replace(/"/g, '\\"');
        q = q.or(`msg_created_at.gt."${escapedSince}",and(msg_created_at.eq."${escapedSince}",message_id.gt."${escapedId}")`);
      } else {
        q = q.gt('msg_created_at', opts.since);
      }
    }
    const {data, error} = await q;
    if (error) {
      this.log.error(`getMessages failed owner=${ownerUserId} err=${error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    return (data ?? []).map(r => ({
      message_id:      r.message_id as string,
      conversation_id: r.conversation_id as string,
      sender_id:       r.sender_id as string,
      recipient_id:    (r.recipient_id ?? null) as string | null,
      msg_type:        (r.msg_type ?? 'text') as string,
      ciphertext:      encodeB64(r.ciphertext as unknown),
      ciphertext_type: Number(r.ciphertext_type ?? 1),
      envelope_meta:   (r.envelope_meta ?? {}) as Record<string, unknown>,
      msg_created_at:  r.msg_created_at as string,
    }));
  }

  // ── Conversation mirror ─────────────────────────────────────────────

  async putConversations(ownerUserId: string, rows: ConversationMirrorRow[]): Promise<{written: number}> {
    if (!Array.isArray(rows) || rows.length === 0) return {written: 0};
    const c = this.requireClient();
    // H-11 — same per-user quota guard as putMessages (best-effort).
    if (await this.isOverRowCap(c, 'conversation_backups', ownerUserId)) {
      throw new HttpException({error: 'backup_quota_exceeded'}, 507);
    }
    // M-9 — dedupe by conversation_id (last-write-wins) BEFORE the upsert,
    // mirroring putMessages. Postgres ON CONFLICT DO UPDATE rejects a
    // batch where two rows share the conflict key ('owner_user_id,
    // conversation_id') with "command cannot affect row a second time",
    // so a single duplicate conversation_id used to 502 the whole batch.
    const dedup = new Map<string, ConversationMirrorRow>();
    for (const r of rows) {
      dedup.set(r.conversation_id, r);
    }
    const deduped = Array.from(dedup.values());
    const baseRow = (r: ConversationMirrorRow) => ({
      owner_user_id:   ownerUserId,
      conversation_id: r.conversation_id,
      kind:            r.kind,
      name:            r.name ?? null,
      members:         r.members ?? [],
      last_message_at: r.last_message_at ?? null,
      // Round 8 — round-trip the conversation-level UX state. Previously
      // mute/pin/TTL/unread/custom-name silently reset on restore.
      is_muted:        r.is_muted ?? false,
      is_pinned:       r.is_pinned ?? false,
      default_ttl_sec: r.default_ttl_sec ?? null,
      unread_count:    r.unread_count ?? 0,
      is_custom_name:  r.is_custom_name ?? false,
    });
    // BUG-M (audit 2026-07-23) — a null group_state must PRESERVE the
    // stored value, not clobber it. The client legitimately mirrors a
    // group conversation with no group_state (state not yet hydrated, or
    // a decrypt failure skipped it on restore); writing null here erased
    // the stored encrypted group master key, so the NEXT restore came
    // back with no key for that group. Split the upsert: rows WITHOUT a
    // group_state omit the column entirely (ON CONFLICT leaves the
    // stored column untouched); rows WITH one update it as before.
    // BUG-M (group_state) + B-594 (deleted): both columns are OMIT-IF-ABSENT
    // — a null/absent value must PRESERVE whatever is stored, never clobber it
    // (a live mirror with no group_state must not erase the group key; a
    // partial/legacy mirror with no `deleted` must not clear a stored delete).
    // A Supabase array upsert emits ONE insert, so every row in a batch must
    // carry the SAME columns; group rows by their exact column signature and
    // upsert each group. Only an EXPLICIT value is written — an explicit
    // deleted:false is how re-adding a room clears the flag (the lift).
    const payloadFor = (r: ConversationMirrorRow): Record<string, unknown> => {
      const row: Record<string, unknown> = baseRow(r);
      if (r.group_state != null) {row.group_state = r.group_state;}
      if (r.deleted === true || r.deleted === false) {row.deleted = r.deleted;}
      return row;
    };
    const groups = new Map<string, Array<Record<string, unknown>>>();
    for (const r of deduped) {
      const row = payloadFor(r);
      const sig = Object.keys(row).sort().join(',');
      const g = groups.get(sig) ?? [];
      g.push(row);
      groups.set(sig, g);
    }
    let error: {message: string} | null = null;
    for (const g of groups.values()) {
      if (error) {break;}
      const res = await c
        .from('conversation_backups')
        .upsert(g, {onConflict: 'owner_user_id,conversation_id'});
      error = res.error;
    }
    if (error) {
      // Round 8 — if the upgrade migration hasn't landed yet, the new
      // columns are missing and PostgREST returns a 400 with column-name
      // hints. Retry once with the legacy column set so a partial-deploy
      // (server before DB) still keeps the old behaviour rather than
      // 502'ing the entire mirror flush.
      if (/column .+ does not exist|schema cache/i.test(error.message)) {
        this.log.warn(`putConversations legacy-fallback (migration pending) owner=${ownerUserId} err=${error.message}`);
        const legacy = deduped.map(r => ({
          owner_user_id:   ownerUserId,
          conversation_id: r.conversation_id,
          kind:            r.kind,
          name:            r.name ?? null,
          members:         r.members ?? [],
          last_message_at: r.last_message_at ?? null,
        }));
        const retry = await c.from('conversation_backups').upsert(legacy, {onConflict: 'owner_user_id,conversation_id'});
        if (retry.error) {
          this.log.error(`putConversations legacy retry failed: ${retry.error.message}`);
          throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
        }
        return {written: deduped.length};
      }
      this.log.error(`putConversations failed owner=${ownerUserId} count=${deduped.length} err=${error.message}`);
      throw new HttpException('backup_write_failed', HttpStatus.BAD_GATEWAY);
    }
    return {written: deduped.length};
  }

  async getConversations(
    ownerUserId: string,
    opts: {limit?: number; cursor?: string; cursorId?: string} = {},
  ): Promise<ConversationMirrorRow[]> {
    // L-6 — optional limit/cursor pagination (was unpaginated → unbounded
    // rows in one response). Ordered by last_message_at DESC; the cursor
    // is a last_message_at timestamp validated ISO-8601 at the controller.
    // No params keeps backward compatibility but now caps at DEFAULT_CAP
    // and logs a truncation warning so a huge account is visible in ops.
    //
    // BUG-T (audit 2026-07-23) — tuple keyset (last_message_at,
    // conversation_id), the same class of fix getMessages received: a
    // timestamp-only `.lt` dropped every row sharing the boundary
    // timestamp. `cursorId` is optional so legacy clients keep the old
    // (lossy) behaviour unchanged.
    const c = this.requireClient();
    const DEFAULT_CAP = 5000;
    const explicitLimit = typeof opts.limit === 'number' && Number.isFinite(opts.limit);
    const cap = explicitLimit
      ? Math.min(Math.max(1, opts.limit as number), 1000)
      : DEFAULT_CAP;
    const runQuery = (columns: string) => {
      let q = c
        .from('conversation_backups')
        .select(columns)
        .eq('owner_user_id', ownerUserId)
        .order('last_message_at', {ascending: false, nullsFirst: false})
        .order('conversation_id', {ascending: true})
        .limit(cap);
      // Keyset on last_message_at DESC. `.lt` naturally excludes NULL
      // last_message_at rows (NULL < x is false); those tail rows are
      // returned only on the first (cursor-less) page — acceptable since
      // a conversation with no last_message_at is a rare empty room.
      if (opts.cursor && opts.cursorId) {
        // (last_message_at < cursor) OR (last_message_at = cursor AND
        // conversation_id > cursorId). M-8-style quoting — see getMessages.
        const escapedTs = String(opts.cursor).replace(/"/g, '\\"');
        const escapedId = String(opts.cursorId).replace(/"/g, '\\"');
        q = q.or(`last_message_at.lt."${escapedTs}",and(last_message_at.eq."${escapedTs}",conversation_id.gt."${escapedId}")`);
      } else if (opts.cursor) {
        q = q.lt('last_message_at', opts.cursor);
      }
      return q;
    };
    const initial = await runQuery('conversation_id, kind, name, members, last_message_at, is_muted, is_pinned, default_ttl_sec, unread_count, is_custom_name, group_state, deleted');
    let data: Array<Record<string, unknown>> | null = initial.data as unknown as Array<Record<string, unknown>> | null;
    let error = initial.error;
    if (error) {
      // Round 8 — legacy-fallback for deployments where the migration
      // hasn't landed yet. Retries with the pre-Round-8 column set so a
      // pre-migration server still serves restore requests cleanly.
      if (/column .+ does not exist|schema cache/i.test(error.message)) {
        this.log.warn(`getConversations legacy-fallback (migration pending): ${error.message}`);
        const retry = await runQuery('conversation_id, kind, name, members, last_message_at');
        data = retry.data as unknown as Array<Record<string, unknown>> | null;
        error = retry.error;
      }
      if (error) {
        this.log.error(`getConversations failed owner=${ownerUserId} err=${error.message}`);
        throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
      }
    }
    const rows = data ?? [];
    if (!explicitLimit && rows.length >= DEFAULT_CAP) {
      this.log.warn(`getConversations truncated at ${DEFAULT_CAP} owner=${ownerUserId} — client should paginate (?limit=&cursor=)`);
    }
    return rows.map(r => ({
      conversation_id: r.conversation_id as string,
      kind:            r.kind as 'direct' | 'group' | 'system',
      name:            (r.name ?? null) as string | null,
      members:         (r.members ?? []) as Array<{userId: string; displayName?: string}>,
      last_message_at: (r.last_message_at ?? null) as string | null,
      is_muted:        Boolean(r.is_muted ?? false),
      is_pinned:       Boolean(r.is_pinned ?? false),
      default_ttl_sec: (r.default_ttl_sec ?? null) as number | null,
      unread_count:    Number(r.unread_count ?? 0),
      is_custom_name:  Boolean(r.is_custom_name ?? false),
      group_state:     (r.group_state ?? null) as Record<string, unknown> | null,
      // B-594 — false when the column is absent (legacy-fallback select or a
      // pre-migration row): fail-open, a missing flag never hides a live room.
      deleted:         Boolean(r.deleted ?? false),
    }));
  }

  // ── Sealed-envelope archive ─────────────────────────────────────────
  //
  // The client mirror only runs when the user has unlocked their backup
  // key for the session. On every cold-start window where the mirror is
  // dead — and on every gap where the recipient hasn't seen a given
  // message yet — the relay's Redis copy is the only one. After 30 days
  // (relay TTL) or after the recipient acks, that copy is gone. This
  // archive closes the gap server-side: we mirror EVERY accepted
  // envelope's opaque outer wrap into a Supabase row keyed by recipient
  // userId. The server still can't decrypt — Sealed Sender means the
  // outer wrap is opaque to us — but the row survives reinstall, so on
  // restore the client can pull, unseal locally with their restored
  // identity priv key, and reconstitute the chat.
  //
  // Schema (Postgres / Supabase):
  //   create table sealed_envelope_archive (
  //     recipient_user_id  text        not null,
  //     envelope_id        uuid        not null,
  //     outer_sealed       bytea       not null,
  //     ts_ms              bigint      not null,
  //     created_at         timestamptz not null default now(),
  //     primary key (recipient_user_id, envelope_id)
  //   );
  //   create index sealed_envelope_archive_recipient_ts
  //     on sealed_envelope_archive (recipient_user_id, ts_ms);
  //
  // Retention is the responsibility of a separate cron (90 days is a
  // sensible default — long enough that a typical reinstall window
  // recovers everything, short enough to bound storage).

  /**
   * Audit P1-T8 — Redis-backed retry outbox for archive writes.
   *
   * The original archive path was fire-and-forget: a transient Supabase
   * outage permanently dropped the archive row, and the receiver lost
   * that envelope on next reinstall (the Redis dwell copy expires after
   * 30 days, the archive was the durability backstop). Now any
   * non-missing-table failure pushes the payload onto a Redis list; a
   * 5-minute cron drains the list with a fresh Supabase upsert.
   *
   * Storage: LPUSH onto `backup:archive-retry`. Each entry is JSON of
   * the input row + `attempts: number`. Bounded by `MAX_OUTBOX_LEN` so
   * a sustained Supabase outage doesn't fill Redis. Entries with
   * `attempts >= MAX_RETRY_ATTEMPTS` are dead-lettered to
   * `backup:archive-retry:dead` for ops investigation; the cron logs
   * a count once per drain pass.
   */
  private static readonly OUTBOX_KEY = 'backup:archive-retry';
  // AUDIT-2026-08-13 #15 — crash-safe drain staging list: rows move here
  // atomically (LMOVE) while being processed and are LREM'd on completion;
  // a crash mid-process leaves the row HERE instead of dropped, and the
  // next drain reclaims it back into the outbox. Single-replica semantics
  // (matches the deployment; audit #3 documents the constraint).
  private static readonly OUTBOX_PROCESSING_KEY = 'backup:archive-retry:processing';
  private static readonly OUTBOX_DEAD_KEY = 'backup:archive-retry:dead';
  private static readonly OUTBOX_BYTES_KEY = 'backup:archive-retry:bytes';
  // M-6 — the old 50_000-by-COUNT cap allowed ~47 GB of Redis because
  // each entry embeds outerSealed (~933 KB base64 worst case). Bound the
  // outbox by APPROXIMATE BYTES (a companion counter) AND reject any
  // single oversized entry — it's still recoverable from the relay's
  // 30-day active queue, so dropping it here is not data loss.
  private static readonly OUTBOX_MAX_BYTES = 512 * 1024 * 1024;   // ~512 MB budget
  private static readonly OUTBOX_MAX_ENTRY_BYTES = 1_000_000;     // reject larger entries
  private static readonly OUTBOX_MAX_LEN = 100_000;               // secondary count ceiling
  private static readonly OUTBOX_DRAIN_BATCH = 200;
  private static readonly OUTBOX_MAX_ATTEMPTS = 12;
  // M-6 — the dead-letter list had no bound/TTL; cap its length and give
  // it an expiry so a persistent failure class can't grow it unboundedly.
  private static readonly OUTBOX_DEAD_MAX_LEN = 10_000;
  private static readonly OUTBOX_DEAD_TTL_SEC = 7 * 24 * 3600;    // 7 days
  // M-7 — forget tombstone. TTL ≈ the automated retry horizon
  // (OUTBOX_MAX_ATTEMPTS × the 5-minute drain cadence ≈ 1 h), the window
  // in which a queued retry could otherwise re-create a wiped user's rows.
  private static readonly FORGOTTEN_TTL_SEC = 3600;
  private static forgottenKey(userId: string): string { return `backup:forgotten:${userId}`; }

  async archiveSealedEnvelope(input: {
    recipientUserId: string;
    envelopeId:      string;
    outerSealed:     string;   // base64 (the ServerEnvelopeDeliver outerSealed)
    timestampMs:     number;
    /**
     * Audit P1-T1 — disappearing-message TTL contract.
     *
     * The active relay path correctly shrinks the Redis TTL to the
     * recipient deadline when shorter than the 30-day dwell. The
     * long-term archive ignored this and retained every envelope for
     * the full 90-day archive TTL — silently breaking the "1-hour
     * disappearing" contract for any recipient that restored from
     * the archive path. Now persisted into the `expires_at_sec`
     * column so the archive sweeper can drop expired rows
     * proactively (and the restore client can filter on read).
     *
     * Optional because not every envelope carries a TTL.
     */
    expiresAtSec?: number;
  }): Promise<void> {
    if (!this.client) return;
    const result = await this.tryArchiveOnce(input);
    if (result === 'transient-error') {
      // Audit P1-T8 — enqueue for the retry cron.
      await this.enqueueArchiveRetry(input, 1);
    }
  }

  /** Audit P1-T8 — single attempt. Returns the outcome so the caller
   * can decide whether to enqueue for retry. `missing-table` is a
   * deploy ordering issue (migration not run); enqueueing wouldn't
   * help because every attempt would hit the same error. */
  private async tryArchiveOnce(input: {
    recipientUserId: string;
    envelopeId:      string;
    outerSealed:     string;
    timestampMs:     number;
    expiresAtSec?:   number;
  }): Promise<'ok' | 'missing-table' | 'transient-error' | 'permanent'> {
    if (!this.client) return 'transient-error';
    const c = this.client;
    // M-7 — respect the forget tombstone. A user who wiped their backup
    // must not have archive rows re-created by a queued retry (or a late
    // live archive during the wipe window). Treat as 'ok' so the drain
    // drops the entry instead of re-enqueuing it.
    try {
      if (await this.redis.client.exists(BackupService.forgottenKey(input.recipientUserId))) {
        return 'ok';
      }
    } catch { /* best-effort — proceed with the write if Redis is flaky */ }
    try {
      const row: Record<string, unknown> = {
        recipient_user_id: input.recipientUserId,
        envelope_id:       input.envelopeId,
        outer_sealed:      decodeB64(input.outerSealed, 'outerSealed'),
        ts_ms:             input.timestampMs,
      };
      if (typeof input.expiresAtSec === 'number' && input.expiresAtSec > 0) {
        row.expires_at_sec = input.expiresAtSec;
      }
      const {error} = await c
        .from('sealed_envelope_archive')
        .upsert(row, {onConflict: 'recipient_user_id,envelope_id'});
      if (error) {
        const code = (error as {code?: string}).code;
        if (/relation .+ does not exist/i.test(error.message)) {
          this.log.warn('archiveSealedEnvelope: sealed_envelope_archive table missing — apply the migration to enable the server-side archive');
          return 'missing-table';
        }
        // L-8 — a Postgres integrity-constraint violation (class 23xxx,
        // e.g. 23503 recipient_user_id FK not in users) will NEVER
        // succeed on retry. Classify as PERMANENT so it dead-letters
        // immediately instead of burning 12 retries over an hour.
        if ((code && /^23\d{3}$/.test(code)) || /violates .*constraint/i.test(error.message)) {
          this.log.warn(`archiveSealedEnvelope permanent-error envelope=${input.envelopeId} code=${code ?? '?'} err=${error.message}`);
          return 'permanent';
        }
        this.log.error(`archiveSealedEnvelope failed envelope=${input.envelopeId} err=${error.message}`);
        return 'transient-error';
      }
      return 'ok';
    } catch (e) {
      this.log.warn(`archiveSealedEnvelope unexpected: ${(e as Error).message}`);
      return 'transient-error';
    }
  }

  private async enqueueArchiveRetry(input: {
    recipientUserId: string;
    envelopeId:      string;
    outerSealed:     string;
    timestampMs:     number;
    expiresAtSec?:   number;
  }, attempts: number): Promise<void> {
    try {
      const payload = JSON.stringify({...input, attempts});
      const size = Buffer.byteLength(payload, 'utf8');
      // M-6 — reject a single pathologically-large entry rather than let
      // it dominate the byte budget. It's still in the relay's 30-day
      // active queue, so this is not data loss.
      if (size > BackupService.OUTBOX_MAX_ENTRY_BYTES) {
        this.log.warn(`archive-retry entry too large (${size}B) — dropping envelope=${input.envelopeId}`);
        return;
      }
      // M-6 — bound the outbox by APPROXIMATE BYTES: drop oldest entries
      // (rpop) until the newcomer fits under OUTBOX_MAX_BYTES, keeping the
      // companion byte counter in step. "Newest failures win" — a recent
      // row an active session might re-pull beats an ancient one.
      let budget = Number(await this.redis.client.get(BackupService.OUTBOX_BYTES_KEY)) || 0;
      let guard = 0;
      while (budget + size > BackupService.OUTBOX_MAX_BYTES && guard < 10_000) {
        const dropped = await this.redis.client.rpop(BackupService.OUTBOX_KEY);
        if (!dropped) { await this.redis.client.set(BackupService.OUTBOX_BYTES_KEY, '0'); budget = 0; break; }
        const droppedSize = Buffer.byteLength(dropped, 'utf8');
        budget = Math.max(0, Number(await this.redis.client.decrby(BackupService.OUTBOX_BYTES_KEY, droppedSize)) || 0);
        guard += 1;
      }
      if (guard > 0) this.log.warn(`archive-retry outbox over byte budget — dropped ${guard} oldest entr${guard === 1 ? 'y' : 'ies'}`);
      // Secondary count ceiling (defence-in-depth against a flood of tiny
      // entries that individually fit the byte budget).
      const len = await this.redis.client.llen(BackupService.OUTBOX_KEY);
      if (len >= BackupService.OUTBOX_MAX_LEN) {
        const dropped = await this.redis.client.rpop(BackupService.OUTBOX_KEY);
        if (dropped) await this.redis.client.decrby(BackupService.OUTBOX_BYTES_KEY, Buffer.byteLength(dropped, 'utf8'));
      }
      await this.redis.client.lpush(BackupService.OUTBOX_KEY, payload);
      await this.redis.client.incrby(BackupService.OUTBOX_BYTES_KEY, size);
    } catch (e) {
      // Best-effort: if Redis is also down we have nowhere to stash
      // the row. Log + continue; the envelope is still in the relay's
      // active queue until dwell expiry.
      this.log.warn(`archive-retry enqueue failed: ${(e as Error).message}`);
    }
  }

  /**
   * Audit P1-T8 — drain pass for the archive retry outbox. Pulls up to
   * OUTBOX_DRAIN_BATCH entries, retries each, and re-enqueues with
   * `attempts + 1` on continued failure. Entries that hit
   * OUTBOX_MAX_ATTEMPTS are moved to a dead-letter list so ops can
   * inspect them without growing the active retry queue indefinitely.
   *
   * Returns `{ok, retried, dead}` for the cron's single-line log.
   */
  /**
   * M-6 — dead-letter a raw entry: push it, then bound the list length
   * (LTRIM) and refresh its TTL (EXPIRE) so a persistent failure class
   * can't grow it without limit and stale entries auto-expire.
   */
  private async deadLetter(raw: string): Promise<void> {
    try {
      await this.redis.client.lpush(BackupService.OUTBOX_DEAD_KEY, raw);
      await this.redis.client.ltrim(BackupService.OUTBOX_DEAD_KEY, 0, BackupService.OUTBOX_DEAD_MAX_LEN - 1);
      await this.redis.client.expire(BackupService.OUTBOX_DEAD_KEY, BackupService.OUTBOX_DEAD_TTL_SEC);
    } catch (e) {
      this.log.warn(`archive-retry dead-letter failed: ${(e as Error).message}`);
    }
  }

  /** AUDIT #15 — drop one staged copy of `raw` from the processing list. */
  private async settleProcessed(raw: string): Promise<void> {
    try {
      await this.redis.client.lrem(BackupService.OUTBOX_PROCESSING_KEY, 1, raw);
    } catch (e) {
      this.log.warn(`archive-retry settle failed (row will be reclaimed next drain): ${(e as Error).message}`);
    }
  }

  // AUDIT #15 rev-2 (edge catch) — in-process reentrancy guard. The @Cron
  // wrapper does NOT await its callback and the replica lock self-expires,
  // so without this a drain outliving the lock is OVERLAPPED by the next
  // tick in the SAME process — and drain B's reclaim then steals drain A's
  // in-flight staged row; A's value-matched LREM later deletes B's staged
  // copy, leaving the row in NEITHER list (reproduced: the exact loss class
  // LMOVE was added to kill). The guard makes the reclaim's "cannot steal
  // this run's rows" invariant actually true in-process; the raised lock
  // TTL (>= tick period) covers cross-pod.
  private draining = false;

  async drainArchiveRetryOutbox(): Promise<{ok: number; retried: number; dead: number}> {
    if (!this.client) {return {ok: 0, retried: 0, dead: 0};}
    if (this.draining) {
      this.log.warn('archive-retry drain still running — skipping this tick (reentrancy guard)');
      return {ok: 0, retried: 0, dead: 0};
    }
    this.draining = true;
    try {
      return await this.drainArchiveRetryOutboxLocked();
    } finally {
      this.draining = false;
    }
  }

  private async drainArchiveRetryOutboxLocked(): Promise<{ok: number; retried: number; dead: number}> {
    // AUDIT #15 — reclaim rows a previous CRASHED drain left in the
    // processing list. The reentrancy guard above + the >=tick replica lock
    // make "a reclaim can never steal a LIVE run's rows" hold; without them
    // it was false under overlap (edge reviewer, reproduced).
    // Bytes were decremented when the row was first staged, so re-adding to
    // the outbox re-increments to keep the approximate counter honest.
    // KNOWN NARROW WINDOW (accepted, comment-only per both reviewers): a
    // crash BETWEEN the staging lmove and its decrby leaves the counter
    // overstated by one row-size after reclaim (+size twice, -size once) —
    // biasing the byte-budget eviction slightly toward early drops. The
    // process is far likelier to die inside the seconds-long Supabase call
    // than in that 1-RTT window.
    try {
      for (;;) {
        const stale = await this.redis.client.lmove(
          BackupService.OUTBOX_PROCESSING_KEY, BackupService.OUTBOX_KEY, 'RIGHT', 'LEFT');
        if (!stale) {break;}
        await this.redis.client.incrby(BackupService.OUTBOX_BYTES_KEY, Buffer.byteLength(stale, 'utf8')).catch(() => 0);
      }
    } catch (e) {
      this.log.warn(`archive-retry reclaim failed: ${(e as Error).message}`);
    }
    let ok = 0;
    let retried = 0;
    let dead = 0;
    // AUDIT #15 (surfaced by the new crash-safety suite, pre-existing under
    // RPOP too): a transient row re-enqueued by THIS run must wait for the
    // NEXT drain, not be re-popped by the same loop — otherwise a single
    // Supabase blip burns all 12 attempts (~the whole designed ~1h retry
    // horizon) inside one 5-minute tick and dead-letters rows the next tick
    // would have archived. Cap the loop at the queue length seen at start.
    // rev-2 (both reviewers): a failed llen must degrade to HEAD's fixed
    // batch, not silently no-op the whole tick.
    const startLen = await this.redis.client.llen(BackupService.OUTBOX_KEY).catch(() => {
      this.log.warn('archive-retry llen failed — falling back to the fixed drain batch');
      return BackupService.OUTBOX_DRAIN_BATCH;
    });
    const budget = Math.min(BackupService.OUTBOX_DRAIN_BATCH, startLen);
    for (let i = 0; i < budget; i++) {
      // AUDIT #15 — LMOVE (not RPOP): the row stays in Redis (processing
      // list) while `tryArchiveOnce` runs, so a crash between pop and
      // completion no longer drops it permanently. Completion paths below
      // LREM it out of the staging list.
      const raw = await this.redis.client.lmove(
        BackupService.OUTBOX_KEY, BackupService.OUTBOX_PROCESSING_KEY, 'RIGHT', 'LEFT');
      if (!raw) {break;}
      // M-6 — keep the approximate byte counter in step with the pop.
      await this.redis.client.decrby(BackupService.OUTBOX_BYTES_KEY, Buffer.byteLength(raw, 'utf8')).catch(() => 0);
      let entry: {
        recipientUserId: string;
        envelopeId:      string;
        outerSealed:     string;
        timestampMs:     number;
        expiresAtSec?:   number;
        attempts:        number;
      };
      try {
        entry = JSON.parse(raw);
      } catch {
        // Malformed entry — dead-letter so the cron doesn't spin on it.
        await this.deadLetter(raw);
        dead += 1;
        await this.settleProcessed(raw);
        continue;
      }
      const result = await this.tryArchiveOnce(entry);
      if (result === 'ok') {
        ok += 1;
      } else if (result === 'missing-table' || result === 'permanent') {
        // No point retrying — a missing-table loop never makes progress,
        // and an integrity-constraint (L-8) will fail identically every
        // time. Dead-letter so the cron stops touching it; once the
        // migration runs (or the FK is fixed) an operator can re-prime.
        await this.deadLetter(raw);
        dead += 1;
      } else {
        // transient — re-enqueue with attempts++ unless we've hit the cap.
        const nextAttempts = entry.attempts + 1;
        if (nextAttempts >= BackupService.OUTBOX_MAX_ATTEMPTS) {
          await this.deadLetter(raw);
          dead += 1;
        } else {
          await this.enqueueArchiveRetry(entry, nextAttempts);
          retried += 1;
        }
      }
      // AUDIT #15 — the row's outcome is recorded (archived / dead-lettered /
      // re-enqueued with attempts++); release the staged copy. If THIS lrem
      // fails, the next drain's reclaim re-queues the row — a bounded
      // double-process, safe because the archive insert is idempotent per
      // envelopeId and dead-letter/attempts paths tolerate a repeat.
      await this.settleProcessed(raw);
    }
    if (ok + retried + dead > 0) {
      this.log.log(`archive-retry drain: ok=${ok} retried=${retried} dead=${dead}`);
    }
    // M-6 — surface dead-letter growth so ops notices a persistent
    // failure class instead of it silently accumulating.
    if (dead > 0) {
      try {
        const deadLen = await this.redis.client.llen(BackupService.OUTBOX_DEAD_KEY);
        this.log.warn(`archive-retry dead-letter list length=${deadLen} (bounded ${BackupService.OUTBOX_DEAD_MAX_LEN}, TTL ${BackupService.OUTBOX_DEAD_TTL_SEC}s)`);
      } catch { /* best-effort */ }
    }
    return {ok, retried, dead};
  }

  /**
   * Audit P1-T8 — periodic drain. Every 5 minutes so a steady-state
   * outage recovers within minutes once Supabase comes back, without
   * hot-looping in normal operation.
   */
  @Cron(CronExpression.EVERY_5_MINUTES, {name: 'archive-retry-outbox'})
  async scheduledArchiveRetryDrain(): Promise<void> {
    // HIGH-2 — one replica drains the Supabase retry outbox per tick (N pods
    // draining concurrently = duplicate archive writes + row contention).
    // AUDIT #15 rev-2 — TTL raised 240→360 (> the 300s tick). Honest bound
    // (critic rev-3): the lock compare-and-deletes on completion, so this
    // RAISES the cross-pod overlap threshold from a 300s drain to a 600s
    // drain rather than eliminating it (the deployment is single-replica,
    // making the residual moot; the Supabase client's missing fetch timeout
    // is what makes >600s drains conceivable at all — register follow-up).
    // The in-process reentrancy guard covers same-pod overlap (the @Cron
    // wrapper does not await its callback).
    await runWithReplicaLock(this.redis, 'backup:archive-retry:lock', 360, async () => {
      try {
        await this.drainArchiveRetryOutbox();
      } catch (e) {
        this.log.warn(`archive-retry drain failed: ${(e as Error).message}`);
      }
    });
  }

  async getSealedArchive(recipientUserId: string, opts: {sinceMs?: number; sinceId?: string; limit?: number}): Promise<Array<{
    envelopeId: string; outerSealed: string; timestampMs: number;
  }>> {
    // Round 8 — tuple cursor on (ts_ms, envelope_id), same fix as
    // getMessages. The archive frequently sees same-ms envelopes
    // (batched submits, group fan-out) and the previous timestamp-only
    // `gt` cursor dropped the second envelope at every page boundary.
    const c = this.requireClient();
    const limit = Math.min(Math.max(1, opts.limit ?? 500), 1000);
    // M-8 — `sinceMs` is validated as an integer at the controller edge,
    // so interpolating it into the `.or()` below is injection-safe (it is
    // never a raw string); `sinceId` is still double-quoted defensively.
    const nowSec = Math.floor(Date.now() / 1000);
    const build = (withExpiresFilter: boolean) => {
      let q = c.from('sealed_envelope_archive')
        .select('envelope_id, outer_sealed, ts_ms')
        .eq('recipient_user_id', recipientUserId)
        .order('ts_ms', {ascending: true})
        .order('envelope_id', {ascending: true})
        .limit(limit);
      if (typeof opts.sinceMs === 'number') {
        if (opts.sinceId) {
          const escapedId = String(opts.sinceId).replace(/"/g, '\\"');
          q = q.or(`ts_ms.gt.${opts.sinceMs},and(ts_ms.eq.${opts.sinceMs},envelope_id.gt."${escapedId}")`);
        } else {
          q = q.gt('ts_ms', opts.sinceMs);
        }
      }
      // H-12 — server-side drop of rows past their disappearing-message
      // deadline so an expired envelope can never be resurrected on
      // restore. NULL expires_at_sec = no per-envelope deadline (kept
      // until the 90-day ts_ms sweep). Uses the partial index
      // sealed_envelope_archive_expires_at_idx.
      if (withExpiresFilter) {
        q = q.or(`expires_at_sec.is.null,expires_at_sec.gt.${nowSec}`);
      }
      return q;
    };
    let {data, error} = await build(true);
    if (error && /column .+ does not exist/i.test(error.message)) {
      // Pre-migration deployment without expires_at_sec — fall back to
      // the unfiltered query so restore still works (no per-envelope TTL
      // enforcement until the column lands).
      this.log.warn(`getSealedArchive expires-filter fallback (migration pending): ${error.message}`);
      ({data, error} = await build(false));
    }
    if (error) {
      // Treat missing-table as "empty archive" so a deployment that
      // hasn't run the migration still serves restore requests cleanly.
      if (/relation .+ does not exist/i.test(error.message)) {
        return [];
      }
      this.log.error(`getSealedArchive failed user=${recipientUserId} err=${error.message}`);
      throw new HttpException('backup_read_failed', HttpStatus.BAD_GATEWAY);
    }
    return (data ?? []).map(r => ({
      envelopeId:  r.envelope_id as string,
      outerSealed: encodeB64(r.outer_sealed as unknown),
      timestampMs: Number(r.ts_ms),
    }));
  }

  /**
   * Round 8 — sealed-archive retention sweep.
   *
   * The archive table grows unbounded otherwise: every accepted
   * envelope adds a row, with no client-driven delete signal because
   * the client's pagination cursor only walks forward. The sweep
   * deletes rows older than `olderThanMs` (default 90 days). Called
   * by relay.cron.ts on a daily timer.
   *
   * Returns the count of rows actually deleted so the cron can log a
   * single-line operational metric.
   */
  async sweepSealedArchive(olderThanMs: number = 90 * 24 * 60 * 60 * 1000): Promise<number> {
    if (!this.client) return 0;
    const c = this.client;
    const cutoff = Date.now() - olderThanMs;
    let deleted = 0;
    // Pass 1 — the 90-day ts_ms retention (bounds storage).
    try {
      const {error, count} = await c
        .from('sealed_envelope_archive')
        .delete({count: 'exact'})
        .lt('ts_ms', cutoff);
      if (error) {
        if (/relation .+ does not exist/i.test(error.message)) {
          return 0;
        }
        this.log.error(`sweepSealedArchive failed err=${error.message}`);
      } else {
        deleted += count ?? 0;
      }
    } catch (e) {
      this.log.error(`sweepSealedArchive unexpected: ${(e as Error).message}`);
    }
    // H-12 — Pass 2: proactively drop rows whose per-envelope
    // disappearing-message deadline (expires_at_sec) has already passed,
    // ahead of the ts_ms retention above. Uses the partial index
    // sealed_envelope_archive_expires_at_idx (WHERE expires_at_sec IS NOT
    // NULL). `.lt` never matches NULL rows, so envelopes without a
    // deadline are only reaped by pass 1.
    const nowSec = Math.floor(Date.now() / 1000);
    try {
      const {error, count} = await c
        .from('sealed_envelope_archive')
        .delete({count: 'exact'})
        .lt('expires_at_sec', nowSec);
      if (error) {
        // Missing table/column (pre-migration) → nothing to sweep here.
        if (!/relation .+ does not exist|column .+ does not exist/i.test(error.message)) {
          this.log.error(`sweepSealedArchive expired-pass failed err=${error.message}`);
        }
      } else {
        deleted += count ?? 0;
      }
    } catch (e) {
      this.log.error(`sweepSealedArchive expired-pass unexpected: ${(e as Error).message}`);
    }
    if (deleted > 0) {
      this.log.log(`sweepSealedArchive deleted ${deleted} archive rows (ts_ms < ${new Date(cutoff).toISOString()} or past expires_at_sec)`);
    }
    return deleted;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Decode a base64-encoded payload from the client and return a Postgres
 * bytea-literal string (`\x...hex...`).
 *
 * Why not just return a Node Buffer:
 * @supabase/supabase-js sends row payloads through PostgREST as JSON.
 * When you put a Node Buffer into a `.upsert({...})` row, the JSON
 * serializer renders it as `{"type":"Buffer","data":[...]}` — that
 * literal JSON gets stored in the `bytea` column verbatim. Reading it
 * back returns 80+ bytes of garbage that doesn't decode as the
 * intended payload. Diagnosed live in production after the first
 * backup-restore failed: `wrapped_master_key` was 239 bytes (the JSON
 * blob length) instead of the expected 44 bytes.
 *
 * The fix: send the `\x...` hex-prefix form, which PostgREST passes
 * through as a Postgres bytea literal. Reading the column back later
 * comes out as the same `\x...` string, which encodeB64 handles.
 */
function decodeB64(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BadRequestException(`invalid_${field}`);
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    throw new BadRequestException(`invalid_${field}`);
  }
  return '\\x' + buf.toString('hex');
}

function encodeB64(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (typeof value === 'string') {
    // Supabase returns bytea as a "\\x..." hex prefix string by default.
    if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex').toString('base64');
    return value;
  }
  return '';
}

/**
 * Normalise a stored bytea value to its `\x<hex>` canonical form so
 * two values can be string-compared regardless of how Supabase /
 * PostgREST returns them across versions (raw Buffer, base64 string,
 * or already-canonical "\\x..." string). Round 7 / fix F6.
 */
function normalizeBytea(value: unknown): string {
  if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex');
  if (value instanceof Uint8Array) return '\\x' + Buffer.from(value).toString('hex');
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) return value;
    // Best-effort base64 → hex; if Buffer.from rejects it, fall back
    // to the original string so unequal-but-malformed values still
    // compare unequal.
    try {
      return '\\x' + Buffer.from(value, 'base64').toString('hex');
    } catch {
      return value;
    }
  }
  return '';
}

/**
 * Return the RAW bytes of a stored bytea value (Buffer, Uint8Array,
 * `\x<hex>` string, or base64 string). Used by the P0-1 verify path to
 * recompute the HMAC over the exact verifier key bytes.
 */
function bytesFromBytea(value: unknown): Buffer {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) return Buffer.from(value.slice(2), 'hex');
    return Buffer.from(value, 'base64');
  }
  return Buffer.alloc(0);
}
