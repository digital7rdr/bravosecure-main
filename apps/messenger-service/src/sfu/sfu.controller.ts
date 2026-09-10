import {Body, Controller, Get, Param, Post, Req, UnauthorizedException, UseGuards} from '@nestjs/common';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {SfuService} from './sfu.service';
import {RoomTokenService} from './room-token.service';
import type {SfuRoomCreated} from './sfu.types';
import type {Request} from 'express';

/**
 * SFU REST surface — `/sfu/rooms` opens a new mediasoup Router and
 * returns the opaque room id. Join / produce / consume / leave then
 * flow over the existing WebSocket gateway via `sfu.*` frames so
 * latency stays minimal.
 *
 * Note: `createRoom` is the only HTTP surface — it's idempotent in
 * the sense that two callers get two rooms (no merging). Clients
 * agree on which room to join via the messenger group's existing
 * out-of-band channel (the chat conversation itself).
 */
@Controller('sfu')
@UseGuards(JwtHttpGuard)
export class SfuController {
  constructor(
    private readonly sfu:       SfuService,
    private readonly roomToken: RoomTokenService,
  ) {}

  @Get('stats')
  stats(): Promise<{rooms: number; participants: number; workers: number; restartTotals: number}> {
    return this.sfu.stats();
  }

  @Post('rooms')
  async createRoom(
    @Req() req: Request,
    @Body() body?: {conversationId?: string},
  ): Promise<SfuRoomCreated> {
    const hostUserId = req.caller?.claims.sub;
    if (!hostUserId) {
      throw new UnauthorizedException('missing_caller');
    }
    const room = await this.sfu.createRoom({
      conversationId: body?.conversationId,
      hostUserId,
    });
    // Audit P0-C2 / row #5 — mint a self-token for the host so they
    // pass the same `sfu.join` verify path as ringed recipients.
    // Returns empty string when SFU_ROOM_TOKEN_SECRET is unset (dev).
    let hostRoomToken = '';
    let hostRoomTokenExp = 0;
    try {
      const minted = this.roomToken.issue(room.roomId, hostUserId);
      hostRoomToken = minted.token;
      hostRoomTokenExp = minted.exp;
    } catch {
      // Secret not configured — dev / test setups. Client ships empty
      // and the gateway skips verification.
    }
    return {...room, hostRoomToken, hostRoomTokenExp};
  }

  /**
   * Discover an in-progress room for a conversation. Lets a 2nd member
   * tapping the call button join the existing room instead of starting
   * a parallel one. Returns `{roomId: null}` when no call is live.
   *
   * Audit P0-C2 / row #5 (C1 closure) — mints a per-caller HMAC token
   * alongside the discovered roomId. Without it, the 2nd-member-joins-
   * existing-call path would receive a roomId but no token and hit
   * `room_token_required` at `sfu.join` once SFU_ROOM_TOKEN_SECRET is
   * set. Does NOT verify caller is in the conversation — server has
   * no view of group membership (the messenger is E2E encrypted).
   */
  @Get('rooms/by-conversation/:conversationId')
  findRoomForConversation(
    @Req()                   req:            Request,
    @Param('conversationId') conversationId: string,
  ): {roomId: string | null; roomToken: string; roomTokenExp: number; live: boolean} {
    const callerId = req.caller?.claims.sub;
    if (!callerId) {
      throw new UnauthorizedException('missing_caller');
    }
    const roomId = this.sfu.findRoomForConversation(conversationId);
    if (!roomId) {
      return {roomId: null, roomToken: '', roomTokenExp: 0, live: false};
    }
    /**
     * `live` = someone is actually IN the room, as opposed to "a room
     * record exists". The two diverge for the whole FRESH_ROOM_GRACE_MS
     * window, and a caller who cannot tell them apart enters silently and
     * rings nobody — see roomHasParticipants for the full reasoning.
     *
     * Kept as a separate field rather than changing what `roomId` returns,
     * because the room id is still the right one to JOIN either way; only
     * the ring decision changes.
     */
    const live = this.sfu.roomHasParticipants(roomId);
    let roomToken = '';
    let roomTokenExp = 0;
    try {
      const minted = this.roomToken.issue(roomId, callerId);
      roomToken = minted.token;
      roomTokenExp = minted.exp;
    } catch {
      // Secret not configured — dev / test setups.
    }
    return {roomId, roomToken, roomTokenExp, live};
  }
}
