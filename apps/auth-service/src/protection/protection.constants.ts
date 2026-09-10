/**
 * Protection-session tunables (spec §13 founder defaults). SINGLE definition
 * each — the service, the sweeps, and the CPO/Ops staleness projection all
 * import from here so a number can never drift between the enforcement site
 * and the UI that explains it.
 */

/** Coordinates older than this are pruned by the lazy retention sweep (§9). */
export const LOCATION_RETENTION_DAYS = 30;

/** A REQUESTED session with no accepted fix within this window is ABORTED
 *  (end_reason 'failed_activation'). Proof-of-stream never arrived. */
export const NO_FIX_ACTIVATION_TIMEOUT_MIN = 10;

/** An ACTIVE session past this age auto-ends (end_reason 'timeout', ops alert). */
export const MAX_SESSION_DURATION_HOURS = 12;

/** CPO-side "connection lost" — customer silent longer than this while ACTIVE.
 *  Drives the amber→red staleness ladder and the conn-lost push latch (§6/§10). */
export const CONNECTION_LOST_THRESHOLD_MIN = 3;

/** Ops "location silent" alert threshold (§8/§10). */
export const OPS_SILENT_ALERT_MIN = 10;

/** Staleness ladder green ceiling (§6): ≤45s LIVE, ≤3m DELAYED, else UNAVAILABLE. */
export const LIVE_FIX_MAX_AGE_SEC = 45;
