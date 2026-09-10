/**
 * Audit fix 5.2 — single source of truth for the default mission waypoint
 * timeline. Was duplicated identically in `ops.service.ts:dispatchBooking`
 * and `job-feed.service.ts:dispatch`. If the timeline ever changes, this
 * is the only edit; both dispatch flows pick it up.
 *
 * `seq` is the visual order shown on the live ops map; `tag` is the
 * short label rendered on the waypoint chip; `event` is the full event
 * description seeded into the audit feed when the waypoint is reached.
 */
export const DEFAULT_MISSION_WAYPOINTS: ReadonlyArray<{
  seq: number; tag: string; event: string;
}> = [
  {seq: 1, tag: 'DISPATCH',  event: 'Crew dispatched from HQ'},
  {seq: 2, tag: 'RECON',     event: 'Recon team clears pickup'},
  {seq: 3, tag: 'PICKUP',    event: 'Principal onboard'},
  {seq: 4, tag: 'CHKPT 01',  event: 'Checkpoint 1'},
  {seq: 5, tag: 'EN ROUTE',  event: 'In transit'},
  {seq: 6, tag: 'CHKPT 02',  event: 'Checkpoint 2'},
  {seq: 7, tag: 'DROPOFF',   event: 'Dropoff · handoff'},
];
