import {Injectable, BadRequestException} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {S3Client, PutObjectCommand, GetObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {createHash, randomUUID} from 'node:crypto';
import {VaultAuditLog} from './audit.log';

/**
 * File Vault — distinct from M6 session attachments.
 *
 *   M6 `MediaService`:     per-message ephemeral blobs, 5-min TTL, NO per-file MFA
 *   M10 `VaultService`:    long-lived encrypted vault files, 60-sec TTL, fresh MFA required each access
 *
 * Both use the same S3-compatible backend. Vault uses a separate
 * prefix (`vault/`) so lifecycle policies can differ (vault blobs
 * never auto-expire; media blobs may).
 *
 * Zero plaintext ever touches this service. Client uploads encrypted
 * bytes after local AES-256 encryption; key stays on device forever.
 */
@Injectable()
export class VaultService {
  private client?: S3Client;

  constructor(
    private readonly config: ConfigService,
    private readonly audit:  VaultAuditLog,
  ) {}

  private s3(): S3Client {
    if (this.client) return this.client;
    const endpoint  = this.config.get<string>('media.endpoint');
    const region    = this.config.get<string>('media.region') ?? 'auto';
    const accessKey = this.config.get<string>('media.accessKeyId');
    const secretKey = this.config.get<string>('media.secretAccessKey');
    if (!accessKey || !secretKey) {
      throw new BadRequestException('vault_storage_not_configured');
    }
    // F16 (parity with MediaService) — a half-configured R2 deploy (keys set,
    // MEDIA_S3_ENDPOINT unset) would silently target real AWS with the invalid
    // 'auto' region. Fail with a clear config error instead.
    if (!endpoint && region === 'auto') {
      throw new BadRequestException(
        'vault_storage_not_configured: set MEDIA_S3_ENDPOINT (R2/minio) or a real MEDIA_S3_REGION (AWS)',
      );
    }
    this.client = new S3Client({
      region,
      endpoint: endpoint || undefined,
      forcePathStyle: !!endpoint,
      credentials: {accessKeyId: accessKey, secretAccessKey: secretKey},
    });
    return this.client;
  }

  /** Presigned PUT for the first-time upload of a vault file. */
  async createUploadUrl(params: {
    callerUserId:     string;
    callerAuthDevice: string;
    ip:               string;
    contentLength:    number;
    contentType:      string;
  }): Promise<{uploadUrl: string; objectKey: string; expiresAt: number}> {
    const max = this.config.get<number>('media.maxUploadBytes') ?? 50 * 1024 * 1024;
    if (!Number.isFinite(params.contentLength) || params.contentLength <= 0 || params.contentLength > max) {
      this.audit.record({
        at: Date.now(), userId: params.callerUserId, authDeviceId: params.callerAuthDevice,
        fileHash: '-', ip: params.ip, outcome: 'denied', reason: 'invalid_content_length',
      });
      throw new BadRequestException('invalid_content_length');
    }
    if (!params.contentType || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(params.contentType)) {
      throw new BadRequestException('invalid_content_type');
    }

    const ttl    = this.config.get<number>('vault.presignTtlSeconds') ?? 60;
    const bucket = this.config.get<string>('media.bucket')!;
    // L15 vault-download-no-owner-check (IDOR) — bind the object to its owner by
    // namespacing the key under the caller's user id. createDownloadUrl then
    // only presigns keys under the CALLER's own prefix, so a valid MFA proof
    // for account A can no longer mint a GET for account B's vault object.
    const key    = `vault/${params.callerUserId}/${randomUUID()}`;

    const cmd = new PutObjectCommand({
      Bucket:        bucket,
      Key:           key,
      ContentLength: params.contentLength,
      ContentType:   params.contentType,
    });
    const uploadUrl = await getSignedUrl(this.s3(), cmd, {expiresIn: ttl});
    this.audit.record({
      at: Date.now(), userId: params.callerUserId, authDeviceId: params.callerAuthDevice,
      fileHash: hashKey(key), ip: params.ip, outcome: 'granted', reason: 'upload',
    });
    return {
      uploadUrl,
      objectKey: key,
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
  }

  /** Presigned GET — ONLY called through the MfaGuard. TTL = 60s. */
  async createDownloadUrl(params: {
    callerUserId:     string;
    callerAuthDevice: string;
    ip:               string;
    objectKey:        string;
  }): Promise<{downloadUrl: string; expiresAt: number}> {
    // L15 vault-download-no-owner-check (IDOR) — the caller may only presign a
    // key under their OWN owner prefix (`vault/<callerUserId>/<uuid>`). Legacy
    // single-segment keys (`vault/<uuid>`, written before this fix) are still
    // honoured so existing files aren't orphaned — they carry no owner binding,
    // but the 128-bit key is unguessable and they age out as the vault re-rolls.
    const ownPrefix  = `vault/${params.callerUserId}/`;
    const isOwnedNew = params.objectKey.startsWith(ownPrefix)
      && /^[a-f0-9-]{36}$/.test(params.objectKey.slice(ownPrefix.length));
    const isLegacy   = /^vault\/[a-f0-9-]{36}$/.test(params.objectKey);
    if (!isOwnedNew && !isLegacy) {
      this.audit.record({
        at: Date.now(), userId: params.callerUserId, authDeviceId: params.callerAuthDevice,
        fileHash: '-', ip: params.ip, outcome: 'denied', reason: 'invalid_object_key',
      });
      throw new BadRequestException('invalid_object_key');
    }
    const ttl    = this.config.get<number>('vault.presignTtlSeconds') ?? 60;
    const bucket = this.config.get<string>('media.bucket')!;
    const cmd = new GetObjectCommand({Bucket: bucket, Key: params.objectKey});
    const downloadUrl = await getSignedUrl(this.s3(), cmd, {expiresIn: ttl});
    this.audit.record({
      at: Date.now(), userId: params.callerUserId, authDeviceId: params.callerAuthDevice,
      fileHash: hashKey(params.objectKey), ip: params.ip, outcome: 'granted', reason: 'download',
    });
    return {
      downloadUrl,
      expiresAt: Math.floor(Date.now() / 1000) + ttl,
    };
  }
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}
