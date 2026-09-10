/**
 * `[CALLSM]` — the call state-machine diagnostic lane.
 *
 * One greppable single-line record per lifecycle DECISION (accepted and
 * dropped alike), so a whole call can be reconstructed from a release logcat.
 * `console.warn` is deliberate: `babel-plugin-transform-remove-console` strips
 * `log` and keeps `warn`, and the release build is the only one worth
 * measuring. Every existing on-device probe lane ([CALLDIAG], [LAGDIAG]) works
 * the same way.
 *
 * IDS AND ENUMS ONLY. Never route a display name, SDP, media, or key material
 * through here — `logAudit.test.ts` scans this directory.
 */

/** Values a diagnostic field may carry. Objects are deliberately not accepted. */
export type CallDiagField = string | number | boolean | null | undefined;

/**
 * Short, stable id form for logs. Full ids are line noise and correlating on
 * the first 8 chars is what every existing call log in this module already
 * does, so keeping the same width keeps old and new lines greppable together.
 */
export function shortCallId(id: string | null | undefined): string {
  if (!id) {return '-';}
  return id.length <= 8 ? id : id.slice(0, 8);
}

/**
 * Emit one `[CALLSM]` line. `undefined` fields are omitted so a call site can
 * pass an optional field without producing `k=undefined`; `null` renders `-`
 * because "known to be absent" and "not applicable" are different findings
 * when reading a teardown race backwards.
 */
export function logCallSm(event: string, fields: Record<string, CallDiagField> = {}): void {
  console.warn(formatCallSm(event, fields));
}

/**
 * Same line, but on the `log` channel — stripped from release builds.
 *
 * For events that are EXPECTED and happen on every call: the two registry
 * writes that fire before `setActiveCall` has minted a key, and CallScreen's
 * conversation/name patch that lands before the hook's async boot registers.
 * They are useful in dev and pure noise in a release logcat, where they would
 * bury the `stale-key` lines this lane exists to surface.
 */
export function logCallSmQuiet(event: string, fields: Record<string, CallDiagField> = {}): void {
  console.log(formatCallSm(event, fields));
}

/**
 * WI-7.1 — one structured line per ACCEPTED lifecycle transition, so a whole
 * call reconstructs from a release logcat (`adb logcat | grep CALLSM`).
 * Rejected transitions keep their long-standing pinned forms
 * (`[CALLSM] illegal prev→next src=…`, the terminal-absorption warn) — this
 * helper is the accepted-side twin, not a replacement. IDs and enums only.
 */
export function logCallTransition(t: {
  callId: string | null | undefined;
  gen?: number | null;
  prev: string;
  next: string;
  event: string;
  source: string;
}): void {
  logCallSm('transition', {
    cid:    shortCallId(t.callId),
    gen:    t.gen ?? null,
    prev:   t.prev,
    next:   t.next,
    event:  t.event,
    source: t.source,
  });
}

function formatCallSm(event: string, fields: Record<string, CallDiagField>): string {
  let line = `[CALLSM] ${event}`;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) {continue;}
    line += ` ${k}=${v === null ? '-' : String(v)}`;
  }
  return line;
}

// ── [CALLLAT] — the call-join LATENCY lane (audit Step 0) ──────────────
//
// One `console.warn` per step of a call's join path, each carrying `t=` (ms
// since the lane's first marker) and `dt=` (ms since the lane's previous
// marker), so a release logcat yields a per-call waterfall without any
// timestamp arithmetic. Lanes: the answering phone, the calling phone, a
// group host boot, a group invitee boot. IDS AND ENUMS ONLY — the same
// logAudit scan covers this file.
//
// Why a module map and not a per-controller field: the steps of one lane live
// in five files (screen, hook, controller, signalling, stats poller) that do
// not share an object, and the killed-app lane starts before the controller
// exists. Keyed by lane+id; entries age out after LANE_TTL_MS so a reused
// group roomId or a replayed callId cannot pin a stale t0, and the first
// marker of a NEW boot passes `reset` to restart the clock explicitly.

export type CallLatLane = '1to1-in' | '1to1-out' | 'grp-host' | 'grp-join';

// A clock pins its time SOURCE for its whole life (review round 2): mixing
// performance.now and Date.now inside one lane would make t/dt nonsense, and
// the negative case would be silently clamped to 0 below.
interface LaneClock { t0: number; last: number; touched: number; perf: boolean; lane: CallLatLane; id: string }

const LANE_TTL_MS = 5 * 60_000;
/** A lane whose last marker is older than this is not "live" for js-stall attribution. */
const LANE_LIVE_WINDOW_MS = 60_000;
const laneClocks = new Map<string, LaneClock>();

function perfNowUsable(): boolean {
  const perf = (globalThis as {performance?: {now?: () => number}}).performance;
  if (!perf || typeof perf.now !== 'function') {return false;}
  return Number.isFinite(perf.now());
}

function readClock(perf: boolean): number {
  if (perf) {
    const v = (globalThis as {performance?: {now?: () => number}}).performance?.now?.();
    if (typeof v === 'number' && Number.isFinite(v)) {return v;}
  }
  return Date.now();
}

function laneKey(lane: CallLatLane, id: string | null | undefined): string {
  return `${lane}:${shortCallId(id)}`;
}

function gcLaneClocks(): void {
  if (laneClocks.size === 0) {return;}
  for (const [k, c] of laneClocks) {
    // Each clock is aged on its OWN time axis (perf vs Date).
    if (readClock(c.perf) - c.touched > LANE_TTL_MS) {laneClocks.delete(k);}
  }
}

export interface CallLatOpts {
  /** Restart the lane clock unconditionally (a host START, a rejoin boot). */
  reset?: boolean;
  /**
   * Restart the clock only if the existing one began more than this many ms
   * ago — i.e. it belongs to a PREVIOUS call on the same id. Used by the
   * "first sight of a call" markers (offer/ring received, notification
   * answer tap, invitee boot) so whichever of them fires first owns t0 and
   * the later ones continue it, while a stale clock from an earlier call on
   * the same conversation/callId cannot be inherited.
   */
  freshAfterMs?: number;
}

/**
 * Emit one `[CALLLAT]` line for `step` on `lane` for the call/room `id`.
 * Fields follow the [CALLSM] rules: `undefined` omitted, `null` rendered
 * `-`, scalars only. `t` = ms since the lane clock started, `dt` = ms since
 * the previous marker of ANY kind on this lane — rows that need a precise
 * interval carry their own `ms=` field too.
 */
export function logCallLat(
  lane: CallLatLane,
  id: string | null | undefined,
  step: string,
  fields: Record<string, CallDiagField> = {},
  opts?: CallLatOpts,
): void {
  stampLane(lane, id, step, fields, opts, true);
}

/**
 * `touch` = whether this row counts as lane LIVENESS (review round 2, Edge row
 * 31): a js-stall row must update `last` (its `dt` absorbs the gap like any
 * other row) but NOT `touched`, or a lane under recurring stalls would re-arm
 * its own liveness forever and never age out of the GC.
 */
function stampLane(
  lane: CallLatLane,
  id: string | null | undefined,
  step: string,
  fields: Record<string, CallDiagField>,
  opts: CallLatOpts | undefined,
  touch: boolean,
): void {
  gcLaneClocks(); // BEFORE the lookup — a TTL-expired clock must not be inherited
  const key = laneKey(lane, id);
  let clock = laneClocks.get(key);
  let now = clock ? readClock(clock.perf) : NaN;
  const stale = clock && opts?.freshAfterMs !== undefined && (now - clock.t0) > opts.freshAfterMs;
  if (!clock || opts?.reset || stale) {
    const perf = perfNowUsable();
    now = readClock(perf);
    clock = {t0: now, last: now, touched: now, perf, lane, id: shortCallId(id)};
    laneClocks.set(key, clock);
  }
  const t  = Math.max(0, Math.round(now - clock.t0));
  const dt = Math.max(0, Math.round(now - clock.last));
  clock.last = now;
  if (touch) {clock.touched = now;}
  console.warn(formatCallLat(lane, clock.id, step, t, dt, fields));
}

function formatCallLat(lane: CallLatLane, cid: string, step: string, t: number, dt: number, fields: Record<string, CallDiagField>): string {
  let line = `[CALLLAT] lane=${lane} cid=${cid} step=${step} t=${t} dt=${dt}`;
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) {continue;}
    line += ` ${k}=${v === null ? '-' : String(v)}`;
  }
  return line;
}

/** Forget a lane's clock (call on the lane's terminal step). Idempotent. */
export function endCallLatLane(lane: CallLatLane, id: string | null | undefined): void {
  laneClocks.delete(laneKey(lane, id));
}

/**
 * Step 0 DO-item 3 — a JS-thread stall (jsThreadWatchdog) lands as a row on
 * every lane that is LIVE (a marker within the last minute), so a B-279-class
 * stall inside a join is distinguishable from a network wait. The stall's
 * own `dt` absorbs the gap exactly like any other row.
 */
export function markJsStallOnActiveLanes(driftMs: number): void {
  if (laneClocks.size === 0) {return;}
  for (const c of [...laneClocks.values()]) {
    const now = readClock(c.perf);
    if (now - c.touched > LANE_LIVE_WINDOW_MS) {continue;}
    // touch=false — a stall row never counts as liveness (see stampLane).
    stampLane(c.lane, c.id, 'js-stall', {driftMs}, undefined, false);
  }
}

/** Test seam — drop every lane clock. */
export function _resetCallLatForTest(): void {
  laneClocks.clear();
}
