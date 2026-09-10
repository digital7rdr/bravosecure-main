# Dispatch module (auto-dispatch)

> Placeholder for the Uber-style auto-dispatch engine. The service, controller,
> and module land in a later step; this README exists now to pin one convention
> every later step must follow.

## Background-loop convention (READ BEFORE adding any sweep/watchdog)

`apps/auth-service` runs **multiple replicas**. A bare `setInterval` in a service
fires **once per pod**, so any unguarded background loop double-fires (double
cascade, double charge, double expiry).

**Every** auto-dispatch background loop — the offer-expiry watchdog, the
crew-assignment SLA sweep, the escrow release / reconciliation sweeps — MUST copy
the Redis `SET NX`-locked `setInterval` pattern in
[`../booking/payment-pending-expiry.service.ts`](../booking/payment-pending-expiry.service.ts):

- an `@Injectable()` implementing `OnModuleInit` / `OnModuleDestroy`;
- `setInterval` started in `onModuleInit`, cleared in `onModuleDestroy`;
- each tick acquires a Redis lock with
  `redis.client.set(LOCK_KEY, ..., 'PX', LOCK_TTL_MS, 'NX')`, bails if the reply
  is not `'OK'`, and releases the lock in a `finally`;
- `LOCK_TTL_MS` shorter than the interval so a crashed pod self-releases.

**Do NOT add `@nestjs/schedule`.** It is not a dependency of `apps/auth-service`
and `ScheduleModule` is intentionally not registered — adding it would reintroduce
the per-pod double-fire this convention exists to prevent.
