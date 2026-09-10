import {createParamDecorator, ExecutionContext} from '@nestjs/common';
import type {Request} from 'express';
import type {OrgManagerContext} from './org-manager.guard';

// Reads the manager context OrgManagerGuard stamped onto the request.
export const CurrentOrgManager = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): OrgManagerContext => {
    const req = ctx.switchToHttp().getRequest<Request & {orgManager: OrgManagerContext}>();
    return req.orgManager;
  },
);
