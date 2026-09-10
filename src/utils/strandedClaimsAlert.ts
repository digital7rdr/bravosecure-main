// B-88 — the branded Alert wrapper, never react-native's system dialog.
import {Alert} from '@utils/alert';

/**
 * B-417 — surface the server's stranded-claims warning at act time.
 *
 * A demoted/suspended/removed member who holds an Ops Room's crypto claim
 * (B-416) strands that room: their device stops distributing the room key and
 * every other admin device stands down on the claim. The server deliberately
 * does NOT auto-free the claim (fork surface — B-416 review), so the ONLY
 * timely signal is this alert on the owner's device. Every setCpoStatus /
 * setCpoRole call site routes its response through here (one rule, scanned) —
 * the server returns an empty list for actions that cannot strand, and this
 * no-ops on empty/undefined (older servers included).
 */
export function warnStrandedClaims(rooms?: string[] | null): void {
  if (!rooms?.length) {return;}
  const n = rooms.length;
  Alert.alert(
    'Ops Room key delivery paused',
    `This member holds the encryption-key authority for ${n} mission Ops Room${n === 1 ? '' : 's'}. ` +
      'New members of those rooms cannot receive the room key until each mission ' +
      'completes normally, or ops runs the claim-recovery procedure (contact ops ' +
      `with the room id${n === 1 ? '' : 's'} below).\n\n${rooms.join('\n')}`,
  );
}
