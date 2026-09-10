import {BadRequestException, Body, Controller, Delete, Get, Post, Query, UseGuards} from '@nestjs/common';
import {Throttle} from '@nestjs/throttler';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {UserThrottlerGuard} from '../common/guards/user-throttler.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {
  BackupService,
  type ConversationMirrorRow,
  type MessageMirrorRow,
} from './backup.service';

// M-8 — the pagination cursor is interpolated into a PostgREST `.or()`
// expression in the service, where commas/parens/quotes are structural.
// Validate `since` at the edge (400 on malformed) so a raw value can
// never smuggle a second filter. The charset the regex allows excludes
// every PostgREST structural char; the shape enforces a real timestamp.
const ISO_TS_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
function assertIsoTimestamp(value: string, field = 'since'): void {
  if (!ISO_TS_RE.test(value)) {
    throw new BadRequestException(`invalid_${field}`);
  }
}
// Audit P0-V4 — promote untyped @Body() interfaces to class-validator
// DTOs. The runtime ValidationPipe only fires on decorated classes;
// inline TypeScript interfaces are erased at compile time and produce
// a no-op pipe. Without these DTOs an attacker could ship 100 MB
// wrappedIdentityBundle, JSON-bomb kdfParams, unbounded message arrays,
// etc. — the controller would pass each straight through to the service.
import {
  PutIdentityDto,
  VerifyProofDto,
  PutMessagesDto,
  PutMerkleDto,
  PutSessionsDto,
  PutConversationsDto,
} from './dto/backup.dto';

/**
 * Encrypted-backup endpoints (WhatsApp parity).
 *
 *   PUT /backup/identity            — upload wrapped Signal identity (+ verifier key)
 *   GET /backup/identity/header     — salt + kdf params + fresh verify nonce (no bundle)
 *   POST /backup/identity/verify    — prove password; mint single-use bundle token
 *   GET /backup/identity/bundle     — full wrapped bundle (requires verify token)
 *   DELETE /backup                  — wipe everything (forgot password flow)
 *   PUT /backup/messages            — batch-mirror ciphertext envelopes
 *   GET /backup/messages?since=...  — pull mirrored envelopes
 *   PUT /backup/conversations       — upsert conversation list
 *   GET /backup/conversations       — pull conversation list
 *
 * All routes auth via JwtHttpGuard — caller.claims.sub IS the
 * owner_user_id; we never accept a `userId` body parameter.
 */
@Controller('backup')
// H-9 — JwtHttpGuard MUST run first so `req.caller` is populated before
// UserThrottlerGuard.getTracker reads `claims.sub` (per-user buckets, not
// per-IP — carrier-grade NAT would otherwise share one bucket). Nest runs
// guards in array order; do not reorder. Global default is 60 req / 10 s;
// per-route @Throttle tightens the identity/unlock surface below.
@UseGuards(JwtHttpGuard, UserThrottlerGuard)
export class BackupController {
  constructor(private readonly svc: BackupService) {}

  // ── Identity backup ─────────────────────────────────────────────────

  // H-9 — identity upload is a rare, expensive write (re-wraps the whole
  // bundle + resets throttle counters). 10/min per user is generous for a
  // human enabling/rotating backup and walls off a script.
  @Throttle({default: {limit: 10, ttl: 60_000}})
  @Post('identity')
  async putIdentity(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PutIdentityDto,
  ): Promise<{ok: true}> {
    return this.svc.putIdentity(caller.claims.sub, dto);
  }

  // H-9 — each header call mints a fresh verify nonce; a tight cap slows
  // an attacker priming nonces to brute-force /verify. 20/min per user.
  @Throttle({default: {limit: 20, ttl: 60_000}})
  @Get('identity/header')
  async getIdentityHeader(@CurrentCaller() caller: CallerContext): Promise<{
    userId: string;
    verifierMissing: boolean;
    verifyNonce: string;
    verifyNonceTtlSec: number;
    salt: string;
    kdfParams: Record<string, unknown>;
    failedAttempts: number;
    lockedUntil: string | null;
  }> {
    return this.svc.getIdentityHeader(caller.claims.sub);
  }

  // P0-1 — validate the HMAC proof of password knowledge. On success
  // returns a single-use token that unlocks GET /identity/bundle. Every
  // failure bumps the server-side lockout counter, so a modified client
  // cannot brute-force offline without tripping the throttle.
  // H-9 — the online brute-force surface. The server-side lockout
  // (BACKUP_MAX_FAILED_ATTEMPTS, default 5/1h) is the primary gate; this
  // rate cap (15/min per user) is a second layer against nonce+proof
  // spraying that stays well above any legitimate retry cadence.
  @Throttle({default: {limit: 15, ttl: 60_000}})
  @Post('identity/verify')
  async verify(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: VerifyProofDto,
  ): Promise<{verifyToken: string; verifyTokenTtlSec: number}> {
    return this.svc.verifyProof(caller.claims.sub, dto);
  }

  // H-9 — bundle fetch consumes a single-use verify token; 15/min per
  // user is roomy for a legitimate unlock + retry, tight against abuse.
  @Throttle({default: {limit: 15, ttl: 60_000}})
  @Get('identity/bundle')
  async getIdentityBundle(
    @CurrentCaller() caller: CallerContext,
    @Query('verifyToken') verifyToken?: string,
  ): Promise<{
    wrappedMasterKey: string; salt: string; kdfParams: Record<string, unknown>; wrappedIdentityBundle: string;
  }> {
    return this.svc.getIdentityBundle(caller.claims.sub, verifyToken);
  }

  // H-9 — destructive, rare (forgot-password wipe). 5/min per user.
  @Throttle({default: {limit: 5, ttl: 60_000}})
  @Delete()
  async forget(@CurrentCaller() caller: CallerContext): Promise<{ok: true}> {
    return this.svc.forgetBackup(caller.claims.sub);
  }

  // ── Message mirror ──────────────────────────────────────────────────

  // H-9 — mirror push: moderate cap matching the relay send surface
  // (60 / 10 s per user). Client mirrors in ~50-row batches.
  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Post('messages')
  async putMessages(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PutMessagesDto,
  ): Promise<{written: number}> {
    return this.svc.putMessages(caller.claims.sub, (dto?.messages ?? []) as unknown as MessageMirrorRow[]);
  }

  // H-9 — mirror pull: looser cap (120 / 10 s) for reconnect drains that
  // legitimately page back-to-back on a fresh device.
  @Throttle({default: {limit: 120, ttl: 10_000}})
  @Get('messages')
  async getMessages(
    @CurrentCaller() caller: CallerContext,
    @Query('since') since?: string,
    @Query('sinceId') sinceId?: string,
    @Query('limit') limit?: string,
  ): Promise<{messages: MessageMirrorRow[]}> {
    // Round 8 — accept an optional `sinceId` for tuple-cursor pagination.
    // When the client passes `(since, sinceId)` together, the server
    // treats them as a tuple cursor and advances strictly past
    // (msg_created_at=since, message_id=sinceId). Single-`since`
    // callers keep the old timestamp-only behaviour.
    // M-8 — validate the ISO-8601 cursor at the edge (400 on malformed)
    // before it reaches the service's `.or()` interpolation. Truthiness
    // gate mirrors the service's own `if (opts.since)` — an empty string
    // means "no cursor", not a malformed one.
    if (since) assertIsoTimestamp(since);
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    const rows = await this.svc.getMessages(caller.claims.sub, {
      since,
      sinceId,
      limit: Number.isFinite(lim) ? lim : undefined,
    });
    return {messages: rows};
  }

  // ── Merkle commit (Round 5 / S8) ───────────────────────────────────
  //
  // Client computes a deterministic Merkle root over its mirrored
  // message rows + signs `(root, rowCount, seq, sentAtMs)` with their
  // identity priv key. Server stores opaquely. On restore, client
  // pulls + verifies against their identity pub key (recovered from
  // the unwrapped backup bundle). Server cannot forge a new root and
  // can only replay an old (legitimately-signed) one — and even that
  // is detectable across same-device restores via the locally-cached
  // last-seen seq.

  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post('identity/merkle')
  async putMerkle(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PutMerkleDto,
  ): Promise<{ok: true}> {
    return this.svc.putMerkleCommit(caller.claims.sub, dto);
  }

  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Get('identity/merkle')
  async getMerkle(@CurrentCaller() caller: CallerContext): Promise<{
    rootB64: string; rowCount: number; seq: number; sentAtMs: number; sigB64: string;
  } | null> {
    return this.svc.getMerkleCommit(caller.claims.sub);
  }

  // ── Session-ratchet snapshot (Sprint-6 backend hand-off) ───────────
  //
  // Encrypted snapshot of the per-peer Double-Ratchet state. The blob
  // is AES-256-GCM under the client's backup master key — the server
  // never sees plaintext. Server enforces a monotonic `seq` so a
  // compromised server can't roll the client back to an older snapshot
  // (which would re-open a one-time-key window the chain had burned).
  //
  // POST /backup/identity/sessions — upload (idempotent on seq)
  // GET  /backup/identity/sessions — fetch latest (null when none yet)

  @Throttle({default: {limit: 30, ttl: 10_000}})
  @Post('identity/sessions')
  async putSessions(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PutSessionsDto,
  ): Promise<{ok: true; seq: number}> {
    return this.svc.putSessionSnapshot(caller.claims.sub, dto);
  }

  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Get('identity/sessions')
  async getSessions(
    @CurrentCaller() caller: CallerContext,
  ): Promise<{blob: string; seq: number} | null> {
    return this.svc.getSessionSnapshot(caller.claims.sub);
  }

  // ── Conversation mirror ─────────────────────────────────────────────

  @Throttle({default: {limit: 60, ttl: 10_000}})
  @Post('conversations')
  async putConvs(
    @CurrentCaller() caller: CallerContext,
    @Body() dto: PutConversationsDto,
  ): Promise<{written: number}> {
    return this.svc.putConversations(caller.claims.sub, (dto?.conversations ?? []) as unknown as ConversationMirrorRow[]);
  }

  // L-6 — optional limit/cursor pagination. Backward compatible: no
  // params returns the (now capped) default page. `cursor` is a
  // last_message_at ISO timestamp validated like `since`.
  @Throttle({default: {limit: 120, ttl: 10_000}})
  @Get('conversations')
  async getConvs(
    @CurrentCaller() caller: CallerContext,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
    // BUG-T — tuple-cursor tie-break (same class of fix as getMessages'
    // sinceId): without it, rows sharing the boundary last_message_at
    // were dropped at every page seam.
    @Query('cursorId') cursorId?: string,
  ): Promise<{conversations: ConversationMirrorRow[]}> {
    if (cursor) assertIsoTimestamp(cursor, 'cursor');
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    const rows = await this.svc.getConversations(caller.claims.sub, {
      limit: Number.isFinite(lim) ? lim : undefined,
      cursor,
      cursorId,
    });
    return {conversations: rows};
  }

  // ── Sealed-envelope archive (server-side relay mirror) ──────────────
  //
  // GET /backup/sealed-archive — caller pulls every sealed envelope
  // ever delivered to them that the server still has on file. Server
  // never decrypted these; they are the same opaque outerSealed bytes
  // the relay shipped at delivery time. The caller unseals each with
  // their identity priv key (just like the live deliver path) and
  // reconstitutes the chat. Critical for the "I reinstalled and most
  // of my messages are gone" case: the client mirror was only writing
  // when its master key was unlocked — many sessions were never
  // unlocked, so their messages never reached messages_backup.
  @Throttle({default: {limit: 120, ttl: 10_000}})
  @Get('sealed-archive')
  async getSealedArchive(
    @CurrentCaller() caller: CallerContext,
    @Query('since') since?: string,
    @Query('sinceId') sinceId?: string,
    @Query('limit') limit?: string,
  ): Promise<{
    envelopes: Array<{envelopeId: string; outerSealed: string; timestampMs: number}>;
  }> {
    // Round 8 — same tuple-cursor extension as /backup/messages.
    // M-8 — `since` here is integer ms; reject a non-integer at the edge
    // (400) rather than silently coercing via parseInt (which would drop
    // a garbage cursor to `undefined` and skip pagination unexpectedly).
    if (since && !/^\d+$/.test(since)) {
      throw new BadRequestException('invalid_since');
    }
    const sinceMs = since ? Number.parseInt(since, 10) : undefined;
    const lim = limit ? Number.parseInt(limit, 10) : undefined;
    const rows = await this.svc.getSealedArchive(caller.claims.sub, {
      sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
      sinceId,
      limit:   Number.isFinite(lim)     ? lim     : undefined,
    });
    return {envelopes: rows};
  }
}
