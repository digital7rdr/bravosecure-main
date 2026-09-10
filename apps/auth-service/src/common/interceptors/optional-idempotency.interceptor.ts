import {ExecutionContext, Injectable, CallHandler} from '@nestjs/common';
import type {Observable} from 'rxjs';
import type {Request} from 'express';
import {IdempotencyInterceptor} from './idempotency.interceptor';

/**
 * E-10 — idempotency for routes the INSTALLED BASE already calls WITHOUT a key.
 *
 * The strict interceptor 400s (`idempotency_key_required`) when the header is
 * absent, which is right for routes that always shipped with keys — but
 * mounting it on an existing route (subscription subscribe) would break every
 * old client. This variant applies the full replay protection when the header
 * is present and passes through unchanged when it is not: new builds get
 * double-charge protection, old builds keep today's behavior.
 */
@Injectable()
export class OptionalIdempotencyInterceptor extends IdempotencyInterceptor {
  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.header('idempotency-key') ?? req.header('Idempotency-Key');
    if (!header) {
      return next.handle();
    }
    return super.intercept(ctx, next);
  }
}
