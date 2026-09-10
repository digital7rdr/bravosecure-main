/**
 * Display name for a mission group.
 *
 * Mission rooms were created with the title `MISSION <code> · OPS ROOM`. Two
 * problems with showing that to a client: "Ops Room" is not the locked
 * client-facing term (it is the Bravo Control System), and shouted-caps reads
 * as a system identifier rather than a call from their own detail.
 *
 * The server now creates new rooms with the right name, but that does not help
 * missions already running: the rename only happens at creation, and the client
 * caches the name it first synced, so even renaming server-side would not
 * propagate. This is the display-time fix that reaches every existing room —
 * pure, so it can be unit-tested and used from any surface.
 */

/** `MISSION <code> · OPS ROOM`, tolerant of case, spacing and the separator. */
const LEGACY = /^\s*MISSION\s+(.+?)\s*[·|]\s*OPS\s*ROOM\s*$/i;

export function displayRoomName(name: string | null | undefined): string {
  const raw = (name ?? '').trim();
  if (!raw) {
    return '';
  }
  const m = LEGACY.exec(raw);
  if (m) {
    return `Mission ${m[1].trim()} · Bravo Control System`;
  }
  // A room whose title was never set at all.
  if (/^\s*mission\s*ops\s*room\s*$/i.test(raw)) {
    return 'Mission · Bravo Control System';
  }
  return raw;
}
