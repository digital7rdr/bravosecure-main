import {Controller, Get, UseGuards} from '@nestjs/common';
import {JwtHttpGuard} from '../common/guards/jwt-http.guard';
import {CurrentCaller} from '../common/decorators/current-caller.decorator';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import {TurnService} from './turn.service';

/**
 *   GET /webrtc/turn-credentials
 *
 * Client calls this right before RTCPeerConnection construction.
 * Returns time-limited credentials the RN client plugs into the
 * `iceServers` config. No request body — caller identity comes from
 * the bearer token.
 */
@Controller('webrtc')
@UseGuards(JwtHttpGuard)
export class TurnController {
  constructor(private readonly turn: TurnService) {}

  @Get('turn-credentials')
  creds(@CurrentCaller() caller: CallerContext): {
    username: string; credential: string; urls: string[]; expiresAt: number;
  } {
    return this.turn.issueCredentials(caller.claims.sub);
  }
}
