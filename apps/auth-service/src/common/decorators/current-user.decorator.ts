import {createParamDecorator, ExecutionContext} from '@nestjs/common';
import type {Request} from 'express';
import type {AccessClaims} from '../../auth/jwt.service';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims => {
    const req = ctx.switchToHttp().getRequest<Request & {user: AccessClaims}>();
    return req.user;
  },
);
