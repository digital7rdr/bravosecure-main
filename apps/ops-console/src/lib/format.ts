/**
 * Human-facing labels for the platform `users.role` DB enum.
 *
 * Why (Audit RS-15): the stored values are internal (`individual`,
 * `service_provider`) but operators read them as Client / Provider. The
 * users list mapped `individual`->'Client' inline while the user-detail
 * and finance screens rendered the raw string, so the same account read
 * as three different roles. Route every role render through here.
 * Keep in sync with the role chips on the users list and the backend
 * `users.role` enum.
 */
const ROLE_LABELS: Record<string, string> = {
  individual: 'Client',
  service_provider: 'Provider',
  agent: 'Agent',
};

export function roleLabel(role: string | null | undefined): string {
  if (!role) return '—';
  return ROLE_LABELS[role] ?? role.replace(/_/g, ' ');
}

// SK-10 — one label for the booking `service` value. The bookings detail
// special-cased executive_protection inline while the live page rendered
// the raw enum; both route through here now.
const SERVICE_LABELS: Record<string, string> = {
  executive_protection: 'Executive Protection',
};

export function bookingServiceLabel(service: string | null | undefined): string {
  if (!service) return '—';
  return SERVICE_LABELS[service] ?? service.replace(/_/g, ' ');
}
