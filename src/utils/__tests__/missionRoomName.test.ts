/**
 * Deck page 19 — the incoming mission call announced itself as
 * "MISSION MSN-956AF85E0956 · OPS ROOM".
 *
 * The server was fixed to create new rooms correctly, but that does nothing for
 * missions already running: the rename happens only at creation and the client
 * caches the first name it synced. This transform is what reaches those.
 */
import {displayRoomName} from '../missionRoomName';

describe('displayRoomName', () => {
  it('rewrites the exact string from the founder screenshot', () => {
    expect(displayRoomName('MISSION MSN-956AF85E0956 · OPS ROOM'))
      .toBe('Mission MSN-956AF85E0956 · Bravo Control System');
  });

  it('is tolerant of case, spacing and the pipe separator', () => {
    expect(displayRoomName('mission MSN-1 | ops room'))
      .toBe('Mission MSN-1 · Bravo Control System');
    expect(displayRoomName('MISSION  BL-42  ·  OPS  ROOM'))
      .toBe('Mission BL-42 · Bravo Control System');
  });

  it('handles a room that was never titled', () => {
    expect(displayRoomName('Mission Ops Room')).toBe('Mission · Bravo Control System');
  });

  it('leaves the new server-side name untouched', () => {
    const fresh = 'Mission MSN-4817 · Bravo Control System';
    expect(displayRoomName(fresh)).toBe(fresh);
  });

  it('never invents a name for a non-mission group', () => {
    expect(displayRoomName('SQA - ITSirajul')).toBe('SQA - ITSirajul');
    expect(displayRoomName('Family')).toBe('Family');
  });

  it('is empty-safe', () => {
    expect(displayRoomName('')).toBe('');
    expect(displayRoomName(null)).toBe('');
    expect(displayRoomName(undefined)).toBe('');
  });

  it('never leaks the banned term', () => {
    for (const s of ['MISSION X · OPS ROOM', 'Mission Ops Room', 'mission y | ops room']) {
      expect(displayRoomName(s)).not.toMatch(/ops room/i);
    }
  });
});
