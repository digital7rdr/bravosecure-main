import type {UserRole} from '@appTypes/index';

/**
 * Humanized label for a raw `users.role` enum — used by any badge that would
 * otherwise render the DB string verbatim (e.g. 'service_provider'). Kept in one
 * place so role badges stay consistent (RS-15).
 */
export function roleLabel(role: UserRole | null | undefined): string {
  switch (role) {
    case 'corporate':        return 'Corporate';
    case 'agent':            return 'Agent';
    // B-91 M1 R1 — spec renames the user-facing tier "Service Provider" to
    // "Enterprise"; the role enum value itself is untouched.
    case 'service_provider': return 'Enterprise';
    case 'ops':              return 'Ops';
    default:                 return 'Individual';
  }
}
