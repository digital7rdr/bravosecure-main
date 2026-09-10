/**
 * Pure Save-button guard for the Step 21 shift editor. Mirrors the server's
 * invariants (OrgManagerGuard createShift/assignCpos) so an invalid draft fails
 * fast on-device. Kept dependency-free so it is unit-testable without RN.
 *
 * Returns a DISCRIMINATED code, not just prose (G-ab review LOW-3): the editor
 * branches on `code === 'assignees'` for the edit-to-zero confirm, and keying
 * that on a message substring meant any future rewording silently changed
 * behaviour. `noun` lets the caller pass the tenant's live staff noun
 * (deptMemberNoun()) instead of a hardcoded "CPO".
 */
export interface ShiftDraftError {
  code: 'time' | 'assignees' | 'radius';
  message: string;
}

export function validateShiftDraft(d: {
  startMs: number;
  endMs: number;
  selectedCount: number;
  hasCoords: boolean;
  radius: number;
  noun?: string;
}): ShiftDraftError | null {
  if (!(d.startMs < d.endMs)) {
    return {code: 'time', message: 'The end time must be after the start time.'};
  }
  if (d.selectedCount < 1) {
    return {code: 'assignees', message: `Select at least one ${d.noun ?? 'member'} to assign.`};
  }
  if (d.hasCoords && !(d.radius > 0)) {
    return {code: 'radius', message: 'Approved radius must be greater than 0 m.'};
  }
  return null;
}
