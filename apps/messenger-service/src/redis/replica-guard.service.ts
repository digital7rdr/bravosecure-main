import {Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {RedisService} from './redis.service';

/**
 * AUDIT-2026-08-13 #3/#10 — single-replica ENFORCEMENT.
 *
 * The 1:1 call-session map (`messenger.gateway.ts` callSessions) and the SFU
 * control plane are pod-local while the WS fan-out rides the cluster-ready
 * Redis adapter. With >=2 replicas, a callee's `call.answer` lands on a pod
 * with no session and `authorizeCallFrame` SILENTLY drops it — every
 * cross-pod call strands at "Answering…" with no error anywhere. The audit's
 * sanctioned stopgap is exactly this guard: make an accidental scale-out a
 * LOUD boot refusal on the extra replica instead of a silent total outage.
 * (The full fix — Redis-backed call sessions + SFU room→pod affinity — is a
 * deliberate scaling project tracked in REMAINING_TODO.)
 *
 * Failure-direction rules (the #6 lesson):
 *   - The FIRST replica always boots. A Redis error while claiming is
 *     fail-OPEN (warn + boot) — the relay is unusable without Redis anyway,
 *     and a guard blip must never take the only replica down.
 *   - Only a LIVE COMPETING CLAIM refuses boot, after a retry window that
 *     absorbs rolling restarts (old container draining while the new one
 *     starts).
 *   - If our claim is ever OBSERVED STOLEN mid-run (possible only after our
 *     TTL lapsed — long stall/partition — and another replica claimed), WE
 *     yield: two live replicas IS the outage, and the newest claimant is
 *     serving. The restart policy brings us back as the refuser.
 *   - REPLICA_GUARD=off disables entirely (ops escape hatch, logged).
 */
@Injectable()
export class ReplicaGuardService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(ReplicaGuardService.name);
  /** Exposed for tests. */
  static readonly KEY = 'messenger:single-replica:claim';
  static readonly TTL_SEC = 15;
  static readonly HEARTBEAT_MS = 5_000;
  static readonly CLAIM_RETRY_MS = 3_000;
  static readonly CLAIM_WINDOW_MS = 45_000;

  readonly instanceId = randomUUID();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly redis: RedisService) {}

  private get disabled(): boolean {
    return (process.env.REPLICA_GUARD ?? '').trim().toLowerCase() === 'off';
  }

  /** Test seam — production exits the process. */
  fatalExit(reason: string): void {
    this.log.error(`[replica-guard] ${reason} — exiting so the surviving replica keeps calls alive.`);
    process.exit(1);
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.disabled) {
      this.log.warn('[replica-guard] REPLICA_GUARD=off — single-replica enforcement DISABLED. Cross-pod calls silently strand if >1 replica runs (audit #3/#10).');
      return;
    }
    const deadline = Date.now() + ReplicaGuardService.CLAIM_WINDOW_MS;
    for (;;) {
      let claimed: string | null;
      try {
        claimed = await this.redis.client.set(
          ReplicaGuardService.KEY, this.instanceId,
          'EX', ReplicaGuardService.TTL_SEC, 'NX',
        );
      } catch (e) {
        // Fail-OPEN on infra error: the only replica must boot even if Redis
        // is briefly unreachable (nothing works without Redis regardless).
        this.log.warn(`[replica-guard] claim attempt errored (${(e as Error).message}) — booting UNGUARDED; will not enforce single-replica this run.`);
        return;
      }
      if (claimed === 'OK') {
        this.log.log(`[replica-guard] single-replica claim held (instance=${this.instanceId.slice(0, 8)})`);
        this.startHeartbeat();
        return;
      }
      if (Date.now() >= deadline) {
        // A live holder kept the claim through the whole window: a genuinely
        // competing replica. Refuse THIS instance only.
        this.fatalExit(
          `another live messenger-service replica holds the single-replica claim after ${ReplicaGuardService.CLAIM_WINDOW_MS / 1000}s — ` +
          'running >1 replica silently strands every cross-pod call (audit #3/#10). Scale back to 1, or see REMAINING_TODO for the scale-out project. ' +
          'Emergency override: REPLICA_GUARD=off',
        );
        return; // reached only when fatalExit is stubbed (tests)
      }
      await new Promise(r => setTimeout(r, ReplicaGuardService.CLAIM_RETRY_MS));
    }
  }

  private startHeartbeat(): void {
    this.heartbeat = setInterval(() => {
      void (async () => {
        try {
          const holder = await this.redis.client.get(ReplicaGuardService.KEY);
          if (holder === this.instanceId) {
            // GET-then-EXPIRE (not Lua: ioredis-mock's eval is unfaithful,
            // see RELAY_DISABLE_LUA_CAP). Benign window: takeover requires
            // our TTL to have already lapsed (>=3 missed beats = we were
            // effectively dead), so a live holder cannot be raced here.
            await this.redis.client.expire(ReplicaGuardService.KEY, ReplicaGuardService.TTL_SEC);
          } else if (holder === null) {
            // TTL lapsed (long stall) but nobody took over — re-claim.
            await this.redis.client.set(ReplicaGuardService.KEY, this.instanceId, 'EX', ReplicaGuardService.TTL_SEC, 'NX');
          } else {
            // Stolen: another replica claimed after our TTL lapsed. Two live
            // replicas IS the silent-outage condition — yield to the newer.
            this.fatalExit(`single-replica claim now held by another instance (${String(holder).slice(0, 8)})`);
          }
        } catch {
          // Redis blip mid-run: keep serving (fail-open); next beat retries.
        }
      })();
    }, ReplicaGuardService.HEARTBEAT_MS);
    // Never keep the process alive just for the heartbeat.
    this.heartbeat.unref?.();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeat) {clearInterval(this.heartbeat); this.heartbeat = null;}
    try {
      const holder = await this.redis.client.get(ReplicaGuardService.KEY);
      if (holder === this.instanceId) {
        await this.redis.client.del(ReplicaGuardService.KEY);
      }
    } catch { /* TTL cleans up within 15s */ }
  }
}
