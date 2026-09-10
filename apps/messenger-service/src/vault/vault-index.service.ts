import {BadRequestException, HttpException, HttpStatus, Injectable, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createClient, type SupabaseClient} from '@supabase/supabase-js';

/**
 * B-696 Phase D (VAULT_DURABILITY_DESIGN_2026-08-29 §6) — per-user opaque
 * vault index blob.
 *
 * The blob is the client's vault index (per-file AES keys + album names),
 * AES-256-GCM under an HKDF subkey of the client's BACKUP master key — this
 * server can never read it. Shape and semantics are a deliberate clone of
 * `backup_session_snapshots` / putSessionSnapshot (the stale_seq 409 +
 * client adopt-once contract), kept OUT of backup/** on purpose: the vault
 * index has no per-row history and must never entangle the Merkle mirror.
 *
 * DELIBERATELY NOT behind MfaGuard: proofs are single-use and each one costs
 * the user a biometric ceremony — a background sync cannot pay that per
 * push, and the payload is E2E-encrypted exactly like the session snapshots
 * this mirrors, which are likewise JWT+throttle only. The vault FILE
 * download gate (MfaGuard on /vault) is untouched.
 */
@Injectable()
export class VaultIndexService {
  private readonly log = new Logger('VaultIndex');
  private client: SupabaseClient | null = null;

  /** Base64 of ~1.5 MiB plaintext — thousands of index rows; DTO enforces it too. */
  static readonly MAX_BLOB_B64 = 2 * 1024 * 1024;

  constructor(config: ConfigService) {
    const url = config.get<string>('backup.supabaseUrl') ?? '';
    const key = config.get<string>('backup.supabaseServiceRoleKey') ?? '';
    if (!url || !key) {
      this.log.warn('vault-index.disabled — SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY missing.');
      return;
    }
    this.client = createClient(url, key, {auth: {persistSession: false, autoRefreshToken: false}});
  }

  private requireClient(): SupabaseClient {
    if (!this.client) {
      throw new HttpException('vault_index_disabled', HttpStatus.SERVICE_UNAVAILABLE);
    }
    return this.client;
  }

  async put(userId: string, payload: {blob: string; seq: number}): Promise<{ok: true; seq: number}> {
    const c = this.requireClient();
    if (typeof payload?.blob !== 'string' || payload.blob.length === 0) {
      throw new BadRequestException('invalid_blob');
    }
    if (payload.blob.length > VaultIndexService.MAX_BLOB_B64) {
      throw new HttpException('blob_too_large', HttpStatus.PAYLOAD_TOO_LARGE);
    }
    if (!Number.isFinite(payload.seq) || payload.seq < 0) {
      throw new BadRequestException('invalid_seq');
    }
    const existing = await c
      .from('vault_index_blobs')
      .select('seq')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing.error) {
      if (/relation .+ does not exist|schema cache/i.test(existing.error.message)) {
        this.log.warn(`put table missing user=${userId}`);
        throw new HttpException('vault_index_disabled', HttpStatus.SERVICE_UNAVAILABLE);
      }
      this.log.error(`put read failed user=${userId} err=${existing.error.message}`);
      throw new HttpException('vault_index_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (existing.data && Number(existing.data.seq) >= payload.seq) {
      // Same contract as the session snapshots: the client GETs, merges,
      // and retries ONCE with currentSeq+1 (I6 adopt-never-hammer).
      throw new HttpException(
        {error: 'stale_seq', currentSeq: Number(existing.data.seq)},
        HttpStatus.CONFLICT,
      );
    }
    const {error} = await c
      .from('vault_index_blobs')
      .upsert({user_id: userId, blob: b64ToByteaHex(payload.blob), seq: payload.seq}, {onConflict: 'user_id'});
    if (error) {
      this.log.error(`put write failed user=${userId} err=${error.message}`);
      throw new HttpException('vault_index_write_failed', HttpStatus.BAD_GATEWAY);
    }
    return {ok: true, seq: payload.seq};
  }

  async get(userId: string): Promise<{blob: string; seq: number} | null> {
    const c = this.requireClient();
    const {data, error} = await c
      .from('vault_index_blobs')
      .select('blob, seq')
      .eq('user_id', userId)
      .maybeSingle();
    if (error) {
      // Pre-migration deployment behaves as "nothing uploaded yet".
      if (/relation .+ does not exist|schema cache/i.test(error.message)) {
        return null;
      }
      this.log.error(`get failed user=${userId} err=${error.message}`);
      throw new HttpException('vault_index_read_failed', HttpStatus.BAD_GATEWAY);
    }
    if (!data) {return null;}
    return {blob: byteaToB64(data.blob as unknown), seq: Number(data.seq)};
  }
}

// PostgREST bytea marshalling — the backup.service house pattern: send the
// `\x<hex>` literal, read back either that form, a Buffer, or base64.
function b64ToByteaHex(value: string): string {
  let buf: Buffer;
  try {
    buf = Buffer.from(value, 'base64');
  } catch {
    throw new BadRequestException('invalid_blob');
  }
  if (buf.length === 0) {throw new BadRequestException('invalid_blob');}
  return '\\x' + buf.toString('hex');
}

function byteaToB64(value: unknown): string {
  if (Buffer.isBuffer(value)) {return value.toString('base64');}
  if (value instanceof Uint8Array) {return Buffer.from(value).toString('base64');}
  if (typeof value === 'string') {
    if (value.startsWith('\\x')) {return Buffer.from(value.slice(2), 'hex').toString('base64');}
    return value;
  }
  return '';
}
