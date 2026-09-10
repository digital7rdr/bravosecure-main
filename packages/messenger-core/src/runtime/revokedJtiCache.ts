import type {SenderCertClient} from '../transport/senderCertClient';

/**
 * Audit 1:1 P1-1 — cert revocation polling.
 *
 * Closes the gap where a leaked or compromised sender cert remained
 * usable for its full TTL because the mobile client never consulted
 * the auth-service revocation list. `verifySenderCert` ALREADY
 * supports a `revokedJtis: ReadonlySet<string>` param; it just wasn't
 * being supplied. This module is the missing producer.
 *
 * Design
 * ------
 *   - Lazy start: `start()` schedules the first fetch immediately and
 *     then a setInterval at the configured cadence. `stop()` cancels.
 *   - Fail-open on the network: if the fetch throws, the cache keeps
 *     the previous set (so a flaky auth-service doesn't degrade us to
 *     "accept every cert" or "reject every cert").
 *   - Bounded staleness: callers can check `lastUpdatedAt`/`isFresh`
 *     and decide whether to skip the cert revocation guard if the
 *     last successful poll is older than e.g. 30 min (defence against
 *     a "deny all revocations by DoSing the endpoint" attack).
 *
 *   The audit's stated improvement is "leaked-cert window 24h → 5min";
 *   with a 5-minute poll cadence the steady-state window is bounded by
 *   the poll interval plus one cert TTL after the next refresh —
 *   exactly the target.
 */
export interface RevokedJtiCacheOptions {
  client:        SenderCertClient;
  /** Poll cadence in milliseconds. Default 5 minutes. */
  intervalMs?:   number;
  /** Optional logger for transient fetch failures. */
  onError?:      (err: Error) => void;
}

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
/**
 * Freshness ceiling — when the last successful poll is older than
 * this, the runtime should treat the cache as "unknown" and let the
 * verify path proceed without consulting the (stale) set, rather than
 * accept-OR-reject based on data that may be hours out of date.
 *
 * 30 minutes is generous (6× the default poll interval) — enough that
 * legitimate transient outages don't disable revocation enforcement,
 * tight enough that a deliberate DoS can only widen the window by 30
 * min rather than indefinitely.
 */
export const REVOCATION_FRESHNESS_MS = 30 * 60 * 1000;

export class RevokedJtiCache {
  private set:    Set<string> = new Set();
  private lastOk: number = 0;
  private timer:  ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly opts: RevokedJtiCacheOptions) {}

  /** Snapshot of the current revoked jtis. Safe to pass to verifySenderCert. */
  snapshot(): ReadonlySet<string> {
    return this.set;
  }

  /** Wall-clock ms of the last successful fetch. 0 means never. */
  get lastUpdatedAt(): number {
    return this.lastOk;
  }

  /** True if the last successful fetch was within REVOCATION_FRESHNESS_MS. */
  isFresh(now: number = Date.now()): boolean {
    return this.lastOk > 0 && now - this.lastOk < REVOCATION_FRESHNESS_MS;
  }

  /**
   * Kick off polling. Fires once immediately so the first send after
   * boot has a recent snapshot; then repeats on intervalMs cadence.
   * Idempotent — calling twice is a no-op.
   */
  start(): void {
    if (this.timer) {return;}
    const cadence = this.opts.intervalMs ?? DEFAULT_INTERVAL_MS;
    void this.refresh();
    this.timer = setInterval(() => { void this.refresh(); }, cadence);
  }

  /** Cancel polling. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Force a refresh now. Returns the same in-flight promise on
   * concurrent calls so we don't fan-out duplicate requests.
   */
  async refresh(): Promise<void> {
    if (this.inflight) {return this.inflight;}
    this.inflight = (async () => {
      try {
        const list = await this.opts.client.fetchRevocationList();
        this.set    = new Set(list.jtis);
        this.lastOk = Date.now();
      } catch (e) {
        // Fail-open: keep the previous set so a transient outage
        // doesn't flip us into "reject every cert" or "accept every
        // cert" mode.
        this.opts.onError?.(e instanceof Error ? e : new Error(String(e)));
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
