import {Injectable, Logger, BadRequestException, ForbiddenException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {Cron, CronExpression} from '@nestjs/schedule';
import {runWithReplicaLock} from '../redis/replica-lock';
import {S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {randomUUID} from 'node:crypto';
import {RedisService} from '../redis/redis.service';

/**
 * Presigner for message-attachment blobs.
 *
 * The SERVICE never sees plaintext bytes — clients encrypt locally with
 * AES-256-CBC before upload, and the decryption key travels in-band
 * inside the sealed Signal envelope (not through any HTTP call).
 *
 * What this service enforces:
 *   - Object keys are server-generated UUIDs, not client-supplied paths.
 *   - Signed URLs are short-lived (5 min default) and scoped to a
 *     single operation (PUT or GET).
 *   - Content-length constraint on PUT prevents 100 GB uploads.
 *   - P0-V5: per-object recipient grant set. The sender registers the
 *     recipient userIds after upload + envelope mint; downloads are
 *     rejected for callers not in the set.
 *
 * Audit log + per-download MFA re-prompts live in M10 (File Vault MFA),
 * which layers on top of this service for user-initiated vault access.
 * M6 attachments are considered "session media" — no per-file MFA.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private client?: S3Client;

  /**
   * P0-V5 — recipient grant registry.
   *
   * Redis SET keyed by `media-grant:<objectKey>` holding the set of
   * userIds authorized to download the object. Populated by
   * `registerGrants` after the sender ships the sealed envelope that
   * carries the per-file AES key. `createDownloadUrl` rejects any
   * caller whose userId isn't in the set.
   *
   * Grants live for 30 days (Signal-spec relay dwell), and every successful
   * download REFRESHES that TTL (media-parity M3) so actively-viewed media
   * survives the cliff. Consequence to be honest about: the set is SADD-only
   * with no revoke path, so a REMOVED group member who keeps opening an old
   * attachment resets its 30-day clock and retains access for as long as they
   * keep viewing. Bounding that properly needs group-key rotation (the envelope
   * still carries the in-band AES key they already hold) — a room/grant TTL
   * cannot fix it. The 30-day bound only bites a member who STOPS for 30
   * continuous days. (Audit follow-up: an SREM-on-removal revoke path.)
   */
  private static readonly GRANT_PREFIX      = 'media-grant:';
  private static readonly OWNER_PREFIX      = 'media-owner:';
  private static readonly GRANT_TTL_SECONDS = 30 * 24 * 3600;
  private static readonly MAX_GRANT_SIZE    = 1024;

  constructor(
    private readonly config: ConfigService,
    private readonly redis:  RedisService,
  ) {}

  private s3(): S3Client {
    if (this.client) return this.client;
    const endpoint  = this.config.get<string>('media.endpoint');
    const region    = this.config.get<string>('media.region') ?? 'auto';
    const accessKey = this.config.get<string>('media.accessKeyId');
    const secretKey = this.config.get<string>('media.secretAccessKey');
    if (!accessKey || !secretKey) {
      throw new BadRequestException('media_storage_not_configured');
    }
    // F16 media-config-endpoint-guard-gap — a half-configured R2 deploy (keys
    // set but MEDIA_S3_ENDPOINT unset) would otherwise silently build an S3
    // client pointed at REAL AWS with the invalid placeholder region 'auto',
    // surfacing as confusing signing/host errors at upload/download instead of
    // a clear config error. R2/minio REQUIRE an endpoint; only a genuine AWS
    // deploy omits it, and that needs a real region (never the 'auto' default).
    if (!endpoint && region === 'auto') {
      throw new BadRequestException(
        'media_storage_not_configured: set MEDIA_S3_ENDPOINT (R2/minio) or a real MEDIA_S3_REGION (AWS)',
      );
    }
    this.client = new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle: !!endpoint, // R2 / minio prefer path-style
      credentials: {accessKeyId: accessKey, secretAccessKey: secretKey},
    });
    return this.client;
  }

  /**
   * Audit MEDIA-A4 (2026-07-02): daily orphan-media GC. Encrypted attachment
   * ciphertext used to accumulate in R2 forever — the client purges on
   * retract/disappear-expiry, but a killed app, a failed purge, or a plain
   * "delete for me" left the blob behind, and after the 30-day grant TTL a lax
   * deploy re-opened it. This sweep deletes any `att/` object that is BOTH
   * older than the grant window AND has no live owner record (its grant window
   * has fully elapsed → no legitimate recipient can still be downloading it).
   * Aligns object lifetime with the 30-day relay dwell. No-op when R2 isn't
   * configured. Bounded by ListObjectsV2 pagination; fail-soft per object.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM, {name: 'media.orphan-sweep'})
  async sweepOrphanedMediaCron(): Promise<void> {
    // HIGH-2 — a full R2 ListObjectsV2 pagination + DeleteObject storm must NOT
    // run on every replica. TTL (30 min) > worst-case bucket scan.
    await runWithReplicaLock(this.redis, 'media:orphan-sweep:lock', 1800, async () => {
      await this.sweepOrphanedMedia();
    });
  }

  async sweepOrphanedMedia(): Promise<{scanned: number; deleted: number}> {
    const accessKey = this.config.get<string>('media.accessKeyId');
    const secretKey = this.config.get<string>('media.secretAccessKey');
    if (!accessKey || !secretKey) return {scanned: 0, deleted: 0}; // not configured
    const bucket = this.config.get<string>('media.bucket');
    if (!bucket) return {scanned: 0, deleted: 0};
    const graceMs = MediaService.GRANT_TTL_SECONDS * 1000;
    let scanned = 0, deleted = 0;
    let token: string | undefined;
    try {
      const s3 = this.s3();
      do {
        const list = await s3.send(new ListObjectsV2Command({
          Bucket: bucket, Prefix: 'att/', ContinuationToken: token, MaxKeys: 1000,
        }));
        for (const obj of list.Contents ?? []) {
          const key = obj.Key;
          if (!key) continue;
          scanned++;
          // Still within the grant window — a recipient could legitimately be
          // downloading it. Keep.
          const ageMs = Date.now() - (obj.LastModified?.getTime() ?? Date.now());
          if (ageMs < graceMs) continue;
          // Owner record still live (recently (re)granted) — keep.
          const owner = await this.redis.client.get(`${MediaService.OWNER_PREFIX}${key}`);
          if (owner) continue;
          try {
            await s3.send(new DeleteObjectCommand({Bucket: bucket, Key: key}));
            // Drop any stale grant set alongside.
            await this.redis.client.del(`${MediaService.GRANT_PREFIX}${key}`);
            deleted++;
          } catch (e) {
            this.logger.warn(`[MEDIA-A4] delete failed key=${key}: ${(e as Error).message}`);
          }
        }
        token = list.IsTruncated ? list.NextContinuationToken : undefined;
      } while (token);
      if (deleted > 0 || scanned > 0) {
        this.logger.log(`[MEDIA-A4] orphan-sweep scanned=${scanned} deleted=${deleted}`);
      }
    } catch (e) {
      this.logger.warn(`[MEDIA-A4] orphan-sweep aborted: ${(e as Error).message}`);
    }
    return {scanned, deleted};
  }

  /**
   * Returns a presigned PUT URL + the object key the client uses to
   * reference the blob later. Client must PUT exactly `contentLength`
   * bytes with the exact same `contentType` header — mismatches fail.
   */
  async createUploadUrl(params: {
    contentLength: number;
    contentType:   string;
    callerUserId:  string;
  }): Promise<{uploadUrl: string; objectKey: string; expiresAt: number}> {
    const max = this.config.get<number>('media.maxUploadBytes') ?? 50 * 1024 * 1024;
    if (!Number.isFinite(params.contentLength) || params.contentLength <= 0 || params.contentLength > max) {
      throw new BadRequestException('invalid_content_length');
    }
    if (!params.contentType || params.contentType.length > 100
        || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(params.contentType)) {
      throw new BadRequestException('invalid_content_type');
    }
    if (!params.callerUserId) {
      throw new ForbiddenException('caller_required');
    }

    const ttl    = this.config.get<number>('media.presignTtlSeconds') ?? 300;
    const bucket = this.config.get<string>('media.bucket')!;
    const key    = `att/${randomUUID()}`;

    // Audit Rev2 MED-01 — stamp the uploader as owner AND into the grant set
    // HERE, before the PUT. Two things depend on it:
    //   1. The client's post-PUT length probe (headObjectLength → download-url)
    //      runs BEFORE registerGrants; under strict mode it would 403 and the
    //      swallowed error silently disables the truncation guard on every
    //      upload. With the owner grant already present, the uploader's own
    //      probe passes.
    //   2. Note-to-self: registerGrants short-circuits (no other recipient), so
    //      the sender was never granted and 403'd on their own upload.
    // Mirrors registerGrants' owner logic: SADD the caller, NX the owner record.
    const grantKey = `${MediaService.GRANT_PREFIX}${key}`;
    const ownerKey = `${MediaService.OWNER_PREFIX}${key}`;
    await this.redis.client.sadd(grantKey, params.callerUserId);
    await this.redis.client.expire(grantKey, MediaService.GRANT_TTL_SECONDS);
    await this.redis.client.set(ownerKey, params.callerUserId, 'EX', MediaService.GRANT_TTL_SECONDS, 'NX');

    const cmd = new PutObjectCommand({
      Bucket:         bucket,
      Key:            key,
      ContentLength:  params.contentLength,
      ContentType:    params.contentType,
    });
    const uploadUrl = await getSignedUrl(this.s3(), cmd, {expiresIn: ttl});
    return {
      uploadUrl,
      objectKey: key,
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
  }

  /**
   * Returns a presigned GET URL for the given object key. Key must
   * come from a sealed envelope — we don't expose listing here.
   *
   * P0-V5: caller MUST be in the recipient-grant set registered for
   * this object key, OR no grant set exists yet and the lax-mode flag
   * is off (rollout window). Sealed-sender means the relay can't
   * authorize on its own — the sender ships the grant explicitly via
   * `registerGrants` after the upload + envelope mint.
   *
   * Set `MEDIA_REQUIRE_RECIPIENT_GRANT=true` to flip strict mode on
   * after mobile + ops-console roll the grant-registration client call.
   */
  async createDownloadUrl(
    objectKey:    string,
    callerUserId: string,
  ): Promise<{downloadUrl: string; expiresAt: number}> {
    if (!/^att\/[a-f0-9-]{36}$/.test(objectKey)) {
      throw new BadRequestException('invalid_object_key');
    }
    if (!callerUserId) {
      throw new ForbiddenException('caller_required');
    }

    const grantKey  = `${MediaService.GRANT_PREFIX}${objectKey}`;
    const hasGrant  = (await this.redis.client.sismember(grantKey, callerUserId)) === 1;
    if (!hasGrant) {
      // No grant set, OR caller not in it. Strict mode (Audit Rev2 MED-01, now
      // the DEFAULT — see config media.requireRecipientGrant) always rejects
      // without a positive grant. Lax mode (only when the flag is the literal
      // 'false') additionally admits when NO grant set exists at all. NOTE: this
      // lax escape hatch now only reaches LEGACY objects uploaded before
      // grant-stamping — every object created via createUploadUrl already has a
      // grant set (the owner), so flipping back to lax does NOT re-open a
      // post-deploy object to non-recipients. Operational contract: strict mode
      // assumes the grant registry survives (durable/non-evicting Redis, the
      // audit's X1 prerequisite) — a full Redis wipe otherwise 403s every
      // still-live object until its 30-day sweep.
      const strict      = this.config.get<boolean>('media.requireRecipientGrant') ?? true;
      const grantExists = (await this.redis.client.exists(grantKey)) === 1;
      if (strict || grantExists) {
        this.logger.warn(
          `[P0-V5] download denied: caller=${callerUserId} key=${objectKey} ` +
          `grantExists=${grantExists} strict=${strict}`,
        );
        throw new ForbiddenException('not_in_recipient_grant');
      }
      this.logger.warn(
        `[P0-V5] download admitted under lax mode: caller=${callerUserId} ` +
        `key=${objectKey} (no grant set yet)`,
      );
    }

    // Media-parity M3 (2026-07-03) — extend the object's lifetime on
    // DOWNLOAD ACTIVITY. The grant + owner records expire 30 days after
    // the last registerGrants, and the daily orphan sweep then deletes
    // the R2 object — while the chat bubble lives forever. That made any
    // still-actively-viewed media >30 days old permanently unopenable.
    // Refreshing both TTLs whenever a recipient actually downloads means
    // media people still open stays alive; only truly abandoned objects
    // age out into the sweep. Best-effort — never blocks the download.
    try {
      const ownerKey = `${MediaService.OWNER_PREFIX}${objectKey}`;
      await this.redis.client.expire(grantKey, MediaService.GRANT_TTL_SECONDS);
      await this.redis.client.expire(ownerKey, MediaService.GRANT_TTL_SECONDS);
    } catch (e) {
      this.logger.warn(`[media] grant TTL refresh failed for ${objectKey}: ${(e as Error).message}`);
    }

    const ttl    = this.config.get<number>('media.presignTtlSeconds') ?? 300;
    const bucket = this.config.get<string>('media.bucket')!;
    const cmd = new GetObjectCommand({Bucket: bucket, Key: objectKey});
    const downloadUrl = await getSignedUrl(this.s3(), cmd, {expiresIn: ttl});
    return {
      downloadUrl,
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
  }

  /**
   * P0-V5 — sender registers the recipient set for an uploaded object.
   * Called once after the sealed envelope is shipped. Idempotent and
   * additive: safe to call again with the same or a superset of
   * recipients (groups grow over time; SADD merges).
   *
   * For 1:1 messages the recipient set is one user; for groups it's
   * the current membership at send time. Bounded to MAX_GRANT_SIZE so
   * a malicious caller can't push 10M userIds into one set.
   *
   * The sender is always included so they can re-fetch their own
   * upload (cross-device sync, restore-from-mirror).
   */
  async registerGrants(
    objectKey:        string,
    senderUserId:     string,
    recipientUserIds: string[],
  ): Promise<{ok: true; count: number}> {
    if (!/^att\/[a-f0-9-]{36}$/.test(objectKey)) {
      throw new BadRequestException('invalid_object_key');
    }
    if (!senderUserId) {
      throw new ForbiddenException('caller_required');
    }
    const clean = Array.from(new Set(recipientUserIds))
      .filter(uid => typeof uid === 'string' && uid.length > 0 && uid.length < 128);
    if (clean.length === 0 || clean.length > MediaService.MAX_GRANT_SIZE) {
      throw new BadRequestException('invalid_recipient_set');
    }
    if (!clean.includes(senderUserId)) clean.push(senderUserId);

    // Audit MEDIA-A1 (2026-07-02): the owner record is authoritative and must
    // be set ONCE by the uploader. Every recipient legitimately learns
    // objectKey from the sealed envelope, so the previous unconditional
    // `set` (owner overwrite) let ANY recipient (a) become "owner" and then
    // purge/delete the blob for everyone via /media/purge, or (b) extend the
    // grant set to arbitrary accounts. Reject any registration for an object
    // that already has a DIFFERENT owner, BEFORE touching the grant set, and
    // write the owner with NX so it can't be clobbered after TTL races.
    const ownerKey = `${MediaService.OWNER_PREFIX}${objectKey}`;
    const existingOwner = await this.redis.client.get(ownerKey);
    if (existingOwner && existingOwner !== senderUserId) {
      throw new ForbiddenException('not_object_owner');
    }

    const grantKey = `${MediaService.GRANT_PREFIX}${objectKey}`;
    await this.redis.client.sadd(grantKey, ...clean);
    await this.redis.client.expire(grantKey, MediaService.GRANT_TTL_SECONDS);
    // A10 — record the SENDER as the object owner so only they can purge it
    // later (retract / disappearing-expiry). NX so the first (uploader)
    // registration wins; refresh the TTL either way.
    await this.redis.client.set(
      ownerKey, senderUserId, 'EX', MediaService.GRANT_TTL_SECONDS, 'NX',
    );
    if (existingOwner === senderUserId) {
      await this.redis.client.expire(ownerKey, MediaService.GRANT_TTL_SECONDS);
    }
    return {ok: true, count: clean.length};
  }

  /**
   * A10 r2-media-never-purged — hard-delete an attachment blob from object
   * storage AND drop its grant + owner records. The owning message's SENDER
   * calls this when they retract the message or its disappearing (TTL) timer
   * fires on their device — the relay can't see the E2E object key, so purge is
   * sender-initiated. Without it the encrypted ciphertext lingered in R2
   * indefinitely, re-downloadable with the in-band key inside the lax-mode /
   * 30-day grant window. Owner-checked (only the sender), idempotent.
   */
  async purgeObject(objectKey: string, callerUserId: string): Promise<{ok: true; purged: boolean}> {
    if (!/^att\/[a-f0-9-]{36}$/.test(objectKey)) {
      throw new BadRequestException('invalid_object_key');
    }
    if (!callerUserId) {
      throw new ForbiddenException('caller_required');
    }
    const owner = await this.redis.client.get(`${MediaService.OWNER_PREFIX}${objectKey}`);
    if (!owner || owner !== callerUserId) {
      // Fail closed: no owner record (never registered / TTL-expired) or a
      // non-owner caller cannot purge someone else's object.
      throw new ForbiddenException('not_object_owner');
    }
    const bucket = this.config.get<string>('media.bucket')!;
    let purged = false;
    try {
      await this.s3().send(new DeleteObjectCommand({Bucket: bucket, Key: objectKey}));
      purged = true;
    } catch (e) {
      // S3 DELETE is idempotent (204 even when absent); a real error (creds /
      // network) is logged but must not block the retract/expiry path.
      this.logger.warn(`[A10] media purge failed key=${objectKey}: ${(e as Error).message}`);
    }
    try {
      await this.redis.client.del(
        `${MediaService.GRANT_PREFIX}${objectKey}`,
        `${MediaService.OWNER_PREFIX}${objectKey}`,
      );
    } catch { /* best-effort; both records TTL out regardless */ }
    return {ok: true, purged};
  }
}
