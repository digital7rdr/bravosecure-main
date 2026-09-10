/**
 * OC-05 — the middleware has exempted /api/health from the auth gate since
 * CFG-04, but no route existed: the exemption pointed at a 404 and the Docker
 * HEALTHCHECK probed `/` (a login redirect) instead. This is the real probe.
 * Liveness only — it answers "is the Next server up", not "is the backend up"
 * (the console is still useful for triage when auth-service is down, so the
 * container must not restart-loop on a backend outage).
 */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json({ok: true, service: 'ops-console', ts: new Date().toISOString()});
}
