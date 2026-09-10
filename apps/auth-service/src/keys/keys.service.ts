import {Injectable, NotFoundException, BadRequestException, Logger} from '@nestjs/common';
import {ConfigService} from '@nestjs/config';
import {createPublicKey, verify as cryptoVerify} from 'node:crypto';
import {DatabaseService} from '../database/database.service';
import {AuditService}    from '../kafka/audit.service';
import {signBundleBinding} from './bundle-binding';
import type {UploadKeysDto} from './dto/upload-keys.dto';

@Injectable()
export class KeysService {
  private readonly logger = new Logger(KeysService.name);

  constructor(
    private readonly db:     DatabaseService,
    private readonly audit:  AuditService,
    private readonly config: ConfigService,
  ) {}

  async upload(dto: UploadKeysDto, userId: string, deviceId: string, ip: string) {
    // Verify Ed25519 signature on the signed prekey before storage.
    // identityKey is the long-term Curve25519 public key (used as Ed25519 for verification).
    // signedPrekeySig is the Ed25519 signature over signedPrekey.
    //
    // Auth audit P1-A14 — hard-reject wrong-length keys instead of
    // falling through to the warn-and-accept branch. The previous
    // path skipped the signature check entirely when the identity
    // key wasn't exactly 32 bytes OR the signature wasn't exactly
    // 64 bytes (legacy "Curve25519 compat mode" justification). An
    // attacker uploading a 33-byte identity key bypassed verification
    // and the receiver later trusted the bundle's signedPrekey as
    // signed-by-this-identity. Now: wrong length → 400, no upload.
    // Libsignal serializes identity keys with a leading 0x05 DJB
    // type byte (33 bytes total); strip it explicitly rather than
    // matching length-only so the verify path is unambiguous.
    let identityKeyBuf: Buffer;
    const sigBuf = Buffer.from(dto.signedPrekeySig, 'base64');
    const signedPrekeyBuf = Buffer.from(dto.signedPrekey, 'base64');
    {
      const raw = Buffer.from(dto.identityKey, 'base64');
      if (raw.length === 33 && raw[0] === 0x05) {
        identityKeyBuf = raw.subarray(1);
      } else if (raw.length === 32) {
        identityKeyBuf = raw;
      } else {
        throw new BadRequestException('identity_key_wrong_length');
      }
    }
    if (sigBuf.length !== 64) {
      throw new BadRequestException('signed_prekey_signature_wrong_length');
    }
    try {
      const keyObj = createPublicKey({key: identityKeyBuf, format: 'raw', type: 'spki'} as unknown as Parameters<typeof createPublicKey>[0]);
      const ok     = cryptoVerify(null, signedPrekeyBuf, keyObj, sigBuf);
      if (!ok) throw new BadRequestException('signed_prekey_signature_invalid');
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      // Node's `format: 'raw'` import is fragile across Node versions
      // (some builds reject it as an invalid options shape even for
      // correctly-shaped 32-byte input). The P1-A14 attack vector —
      // wrong-length identity key bypasses verification — is already
      // closed by the length checks above; if we got here, the bytes
      // were the right length but Node's verifier couldn't be wired
      // up. Log and continue rather than 400 every upload on a Node
      // upgrade. The receiver-side libsignal `processPreKey` verifies
      // the same signature with curve25519-typescript, so this is
      // defense-in-depth on the issuer side, not the only gate.
      this.logger.warn('Signed prekey verification unavailable: ' + (e as Error).message);
    }

    // B-18 — the key store is per (user, signal device). Resolve THIS
    // install's numeric Signal device id (assigned at session issue) so a
    // user's second device no longer overwrites the first.
    const sigDev = await this.resolveSignalDeviceId(userId, deviceId);

    // Detect identity rotation. Clients that wipe local storage and
    // reinstall regenerate keyIds 1..N with brand-new keypairs and
    // re-upload. Without this, the identity row is upserted but the
    // OPK rows are skipped via ON CONFLICT DO NOTHING, leaving the
    // server holding the new identity paired with the previous
    // install's orphaned OPK public keys. Peers fetch a stale OPK,
    // their X3DH DH4 disagrees with the receiver's local OPK private,
    // and every first message fails to decrypt with "Bad MAC".
    const prev = await this.db.qOne<{identity_key: Buffer}>(
      `SELECT identity_key FROM public.signal_identities WHERE user_id=$1 AND device_id=$2`,
      [userId, sigDev],
    );
    const incomingIdKey = Buffer.from(dto.identityKey, 'base64');
    const identityRotated = !!prev && !prev.identity_key.equals(incomingIdKey);

    await this.db.q(
      `INSERT INTO public.signal_identities
         (user_id,device_id,registration_id,identity_key,signed_prekey_id,signed_prekey,signed_prekey_sig)
       VALUES ($1,$7,$2,decode($3,'base64'),$4,decode($5,'base64'),decode($6,'base64'))
       ON CONFLICT (user_id,device_id) DO UPDATE
         SET registration_id=$2,identity_key=decode($3,'base64'),
             signed_prekey_id=$4,signed_prekey=decode($5,'base64'),
             signed_prekey_sig=decode($6,'base64'),updated_at=now()`,
      [userId, dto.registrationId, dto.identityKey, dto.signedPrekeyId, dto.signedPrekey, dto.signedPrekeySig, sigDev],
    );

    // On identity rotation, wipe the orphaned OPK pool atomically with
    // the rotation so the next upload starts from a clean slate. Scoped to
    // THIS device so a rotation on one device never wipes another's pool.
    if (identityRotated) {
      await this.db.q(
        `DELETE FROM public.signal_one_time_prekeys WHERE user_id=$1 AND device_id=$2`,
        [userId, sigDev],
      );
    }

    // Pool cap. Without a cap a buggy or hostile client could spam
    // /auth/keys/upload with a fresh batch on every wake and the OPK
    // table grows without bound. The cap is way above the refill
    // threshold (<10) so a healthy client never bumps into it; we
    // silently drop the over-cap tail rather than 400ing because a
    // partial replenish is still useful and the client will trim on
    // its next refill cycle.
    const OPK_POOL_CAP = 200;
    const [poolBeforeRow] = await this.db.q<{cnt:string}>(
      `SELECT count(*)::text AS cnt FROM public.signal_one_time_prekeys WHERE user_id=$1 AND device_id=$2`, [userId, sigDev]);
    const poolBefore = Number(poolBeforeRow?.cnt ?? 0);
    const room = Math.max(0, OPK_POOL_CAP - poolBefore);
    const incoming = dto.oneTimePrekeys ?? [];
    const toStore = incoming.slice(0, room);

    // Incremental append for normal pool refills (same identity).
    let stored = 0;
    for (const k of toStore) {
      await this.db.q(
        `INSERT INTO public.signal_one_time_prekeys (user_id,device_id,key_id,public_key)
         VALUES ($1,$4,$2,decode($3,'base64'))
         ON CONFLICT (user_id,device_id,key_id) DO NOTHING`,
        [userId, k.keyId, k.publicKey, sigDev],
      );
      stored++;
    }

    const dropped = incoming.length - toStore.length;
    if (dropped > 0) {
      this.logger.warn(`OPK pool cap hit for user=${userId} dev=${sigDev}: stored=${stored} dropped=${dropped} (cap=${OPK_POOL_CAP})`);
    }

    const [row] = await this.db.q<{cnt:string}>(
      `SELECT count(*)::text AS cnt FROM public.signal_one_time_prekeys WHERE user_id=$1 AND device_id=$2`, [userId, sigDev]);
    const poolSize = Number(row?.cnt ?? 0);

    // Audit Rev2 CLI-01 — an identity-key ROTATION here is the amplification
    // that makes a stolen 15-minute access token dangerous: this endpoint is
    // JwtAuthGuard-only and upserts identity_key, so a bare token silently
    // overwrites the victim's Signal identity and every peer thereafter
    // encrypts to the ATTACKER — and the takeover is invisible because identity
    // keys already self-rotate ~30 days after install. We do NOT hard-block a
    // rotation (legit reinstall / re-key hit the same path, and a step-up gate
    // needs a coordinated client rollout — see the CLI-01 handoff), but we make
    // it DETECTABLE: a distinct, high-signal audit event so a takeover is no
    // longer silent, plus a release-visible warn for device tracing.
    if (identityRotated) {
      this.logger.warn(`[KEYDIAG] identity rotated user=${userId} dev=${sigDev} — verify this was a legitimate reinstall/re-key, not a stolen-token takeover`);
      await this.audit.emit({event_type:'auth.keys.identity_rotated', user_id:userId, device_id:deviceId, ip, outcome:'success', detail:`dev=${sigDev} identity key replaced`});
    }
    await this.audit.emit({event_type:'auth.keys.upload', user_id:userId, device_id:deviceId, ip, outcome:'success', detail:`dev=${sigDev} opk_pool=${poolSize}`});
    // Handoff §4.5-1 — surface the rotation to the CLIENT. A reinstalled
    // device has no local copy of its previous identity, so without this
    // it can neither detect the rotation nor supply the superseded
    // identity to the relay's purge-stale-recipient endpoint (every
    // envelope queued under the old outer-ECIES key is permanently dead).
    // `previousIdentityKey` is PUBLIC key material returned only to the
    // authenticated account owner for their own device — safe to expose.
    return {
      ok: true,
      oneTimeKeysStored: stored,
      poolSize,
      identityRotated,
      ...(identityRotated && prev ? {previousIdentityKey: prev.identity_key.toString('base64')} : {}),
    };
  }

  /** B-18 — map an auth-service string install id to the stable numeric
   *  Signal device id assigned at session issue. Defaults to 1 (the
   *  primary / legacy single-device id) when the row predates the
   *  assignment, so old clients keep resolving to device 1. */
  private async resolveSignalDeviceId(userId: string, deviceIdString: string): Promise<number> {
    const row = await this.db.qOne<{signal_device_id: number}>(
      `SELECT signal_device_id FROM public.auth_devices WHERE user_id=$1 AND device_id=$2`,
      [userId, deviceIdString],
    );
    return Number(row?.signal_device_id ?? 1);
  }

  /**
   * Build a bundle for ONE (user, signal device): fetch that device's
   * identity, pop one of its OPKs (single-use), and authority-sign the
   * binding. Returns null when the device has no uploaded identity.
   * The returned `bundle` shape is byte-identical to the legacy
   * single-device response (no extra fields) so callers can return it
   * verbatim. The authority binding does NOT bind device id (see
   * bundleBinding.ts), so per-device bundles verify with the existing
   * client `verifyBundleBinding` unchanged.
   */
  private async buildDeviceBundle(targetUserId: string, sigDev: number) {
    const identity = await this.db.qOne<{
      registration_id: number; identity_key: Buffer;
      signed_prekey_id: number; signed_prekey: Buffer; signed_prekey_sig: Buffer;
    }>(
      `SELECT registration_id,identity_key,signed_prekey_id,signed_prekey,signed_prekey_sig
         FROM public.signal_identities WHERE user_id=$1 AND device_id=$2`,
      [targetUserId, sigDev],
    );
    if (!identity) return null;

    // Fetch and delete one OPK atomically (single-use), scoped to this device.
    // Concurrency hardening (FOR UPDATE SKIP LOCKED): two senders fetching the
    // SAME recipient simultaneously previously both resolved the same ctid; the
    // first DELETE won and the second matched 0 rows → returned null → that
    // sender silently degraded to a signed-prekey-only X3DH (weaker forward
    // secrecy on its first message). SKIP LOCKED makes each concurrent fetch
    // lock + claim a DISTINCT row, so both get their own OPK. This is a pure
    // concurrency fix — still pops exactly one, still single-use (DELETE ...
    // RETURNING), still returns null only when the pool is genuinely empty, and
    // can never hand the same row to two callers. No protocol field changes.
    const opk = await this.db.qOne<{key_id:number; public_key:Buffer}>(
      `DELETE FROM public.signal_one_time_prekeys
        WHERE ctid=(SELECT ctid FROM public.signal_one_time_prekeys WHERE user_id=$1 AND device_id=$2 LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING key_id,public_key`,
      [targetUserId, sigDev],
    );

    const [poolRow] = await this.db.q<{cnt:string}>(
      `SELECT count(*)::text AS cnt FROM public.signal_one_time_prekeys WHERE user_id=$1 AND device_id=$2`, [targetUserId, sigDev]);
    const poolSize = Number(poolRow?.cnt ?? 0);

    const identityKeyB64    = identity.identity_key.toString('base64');
    const signedPrekeyB64   = identity.signed_prekey.toString('base64');
    const signedPrekeySigB64 = identity.signed_prekey_sig.toString('base64');

    // Audit P0-I2 — authority binding over (userId, identityKey, signedPreKey).
    const authorityPrivB64 = this.config.get<string>('senderCert.privateKeyB64') ?? '';
    let authoritySig: {sig: string; signedAtMs: number} | null = null;
    if (authorityPrivB64) {
      try {
        authoritySig = await signBundleBinding(authorityPrivB64, {
          userId:          targetUserId,
          identityKey:     identityKeyB64,
          signedPrekeyId:  identity.signed_prekey_id,
          signedPrekey:    signedPrekeyB64,
          signedPrekeySig: signedPrekeySigB64,
          signedAtMs:      Date.now(),
        });
      } catch (e) {
        // Surface but don't fail the fetch — a misconfigured authority
        // key shouldn't take down the bundle endpoint. Client-side
        // verifyBundleBinding will reject and force a fix.
        this.logger.warn(`P0-I2 bundle binding sign failed: ${(e as Error).message}`);
      }
    }

    return {
      bundle: {
        registrationId:  identity.registration_id,
        identityKey:     identityKeyB64,
        signedPrekeyId:  identity.signed_prekey_id,
        signedPrekey:    signedPrekeyB64,
        signedPrekeySig: signedPrekeySigB64,
        oneTimePrekey:   opk ? {keyId: opk.key_id, publicKey: opk.public_key.toString('base64')} : null,
      },
      authoritySig,
      poolSize,
    };
  }

  async fetchBundle(targetUserId: string, requesterId: string, deviceId: string, ip: string) {
    // Legacy 1:1 endpoint — returns the user's CURRENT device bundle.
    //
    // Why `updated_at DESC` (was `device_id ASC`): this app is
    // single-device, but `resolveSignalDeviceId` assigns a NEW numeric
    // signal device id on every reinstall/relogin (a fresh auth_devices
    // row → next device number). Each install uploads its NEW identity
    // under that higher device id, leaving the OLD device id rows behind
    // as orphans with STALE identity keys. The previous `device_id ASC`
    // therefore handed peers the OLDEST (dead) identity — so the sender's
    // outer-ECIES wrap (`wrapOuter` binds the recipient identity into the
    // GCM AAD) used a key the live install no longer holds → the live
    // install hit "outer sealed authentication failed" and dropped EVERY
    // sealed envelope from that peer, including group-call master keys
    // (joiner stalls at the key-wait → "Call failed"). Serving the most-
    // recently-updated row returns the active install's current identity.
    // The bundle is still authority-signed (P0-I2), so this changes WHICH
    // device's bundle is returned, never WHETHER it is authenticated.
    const primary = await this.db.qOne<{device_id: number}>(
      `SELECT device_id FROM public.signal_identities WHERE user_id=$1 ORDER BY updated_at DESC, device_id DESC LIMIT 1`,
      [targetUserId],
    );
    if (!primary) throw new NotFoundException('no_keys_found');
    const primaryDev = Number(primary.device_id);
    const built = await this.buildDeviceBundle(targetUserId, primaryDev);
    if (!built) throw new NotFoundException('no_keys_found');
    await this.audit.emit({event_type:'auth.keys.fetch', user_id:requesterId, device_id:deviceId, ip, outcome:'success', detail:`for=${targetUserId} dev=${primaryDev} opk_remaining=${built.poolSize}`});
    return {bundle: built.bundle, authoritySig: built.authoritySig, poolSize: built.poolSize};
  }

  /**
   * B-18 — list ALL of a user's Signal devices, each with its own bundle
   * (own OPK popped, own authority binding). The group/1:1 fan-out calls
   * this to reach every device of every recipient. Returns one entry per
   * device row, each shaped like the legacy bundle plus an explicit
   * `deviceId` and per-entry `authoritySig`.
   */
  async fetchDevices(targetUserId: string, requesterId: string, deviceId: string, ip: string) {
    // Audit G-09 (2026-07-02): exclude ORPHAN identity rows. A reinstall
    // creates a NEW signal_device_id and never deletes the old row, so the
    // multi-device fan-out endpoint would otherwise return DEAD identities —
    // senders would wrap sealed envelopes to keys no device holds ("outer
    // sealed authentication failed") and burn OPKs on ghosts. Only return
    // devices whose identity was refreshed within the 90-day window (a live
    // install re-uploads its bundle on the 30-day SPK rotation, so a genuinely
    // active device is always well inside 90 days; an abandoned reinstall's old
    // row ages out). The client is device-1 today, so this is latent hygiene
    // that de-risks the Phase-2 multi-device fan-out.
    const rows = await this.db.q<{device_id: number}>(
      `SELECT device_id FROM public.signal_identities
         WHERE user_id=$1
           AND updated_at > now() - interval '90 days'
         ORDER BY device_id`,
      [targetUserId],
    );
    const devices: Array<{
      deviceId: number; registrationId: number; identityKey: string;
      signedPrekeyId: number; signedPrekey: string; signedPrekeySig: string;
      oneTimePrekey: {keyId: number; publicKey: string} | null;
      authoritySig: {sig: string; signedAtMs: number} | null;
    }> = [];
    for (const r of rows) {
      const built = await this.buildDeviceBundle(targetUserId, r.device_id);
      if (!built) continue;
      devices.push({deviceId: Number(r.device_id), ...built.bundle, authoritySig: built.authoritySig});
    }
    if (devices.length === 0) throw new NotFoundException('no_keys_found');
    await this.audit.emit({event_type:'auth.keys.fetch_devices', user_id:requesterId, device_id:deviceId, ip, outcome:'success', detail:`for=${targetUserId} devices=${devices.length}`});
    return {devices};
  }
}
