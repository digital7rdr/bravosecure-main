import {createParamDecorator, ExecutionContext, UnauthorizedException} from '@nestjs/common';
import type {Request} from 'express';
import type {CallerContext} from '../guards/jwt-http.guard';

/**
 * Controller-scope sugar: `@CurrentCaller() caller: CallerContext`.
 * Throws if used on a route without @UseGuards(JwtHttpGuard) — the
 * guard is what populates `req.caller`.
 */
export const CurrentCaller = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): CallerContext => {
    const req = ctx.switchToHttp().getRequest<Request>();
    if (!req.caller) throw new UnauthorizedException('caller_context_missing');
    return req.caller;
  },
);
