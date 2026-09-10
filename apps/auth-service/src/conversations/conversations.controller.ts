import {
  Body, Controller, Delete, Get, Param, Patch, Post, UseGuards,
} from '@nestjs/common';
import {JwtAuthGuard} from '../common/guards/jwt-auth.guard';
import {CurrentUser}  from '../common/decorators/current-user.decorator';
import type {AccessClaims} from '../auth/jwt.service';
import {ConversationsService, type ConversationRecord} from './conversations.service';
import {
  CreateConversationDto, UpdateConversationDto, AddMemberDto,
} from './dto/conversation.dto';

@Controller('conversations')
@UseGuards(JwtAuthGuard)
export class ConversationsController {
  constructor(private readonly convos: ConversationsService) {}

  @Post()
  create(
    @Body() dto: CreateConversationDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<ConversationRecord> {
    return this.convos.create(user.sub, dto.kind, dto.memberUserIds, dto.title);
  }

  @Get('mine')
  async listMine(@CurrentUser() user: AccessClaims): Promise<{conversations: ConversationRecord[]}> {
    return {conversations: await this.convos.listMine(user.sub)};
  }

  // RS-02 — membership-intent drain for conversation-admin devices. Declared
  // BEFORE ':id' so the static path isn't captured as a conversation id.
  @Get('membership-intents')
  async listMembershipIntents(@CurrentUser() user: AccessClaims) {
    return {intents: await this.convos.listMembershipIntents(user.sub)};
  }

  @Post('membership-intents/:intentId/ack')
  ackMembershipIntent(
    @Param('intentId') intentId: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<{ok: true}> {
    return this.convos.ackMembershipIntent(user.sub, intentId);
  }

  @Get(':id')
  get(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<ConversationRecord> {
    return this.convos.getForUser(id, user.sub);
  }

  @Patch(':id')
  rename(
    @Param('id') id: string,
    @Body() dto: UpdateConversationDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<ConversationRecord> {
    return this.convos.rename(id, user.sub, dto.title ?? '');
  }

  @Post(':id/members')
  addMember(
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
    @CurrentUser() user: AccessClaims,
  ): Promise<ConversationRecord> {
    return this.convos.addMember(id, user.sub, dto.userId);
  }

  @Delete(':id/members/:userId')
  async removeMember(
    @Param('id') id: string,
    @Param('userId') targetUserId: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<{ok: true}> {
    await this.convos.removeMember(id, user.sub, targetUserId);
    return {ok: true};
  }

  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser() user: AccessClaims,
  ): Promise<{ok: true}> {
    await this.convos.remove(id, user.sub);
    return {ok: true};
  }
}
