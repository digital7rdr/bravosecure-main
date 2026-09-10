#!/usr/bin/env node
/**
 * Protection-sessions staging E2E smoke (spec §12).
 *
 * Exercises the DEPLOYED session flow end-to-end against staging:
 *   create → post fixes (activation-on-first-fix) → current(ACTIVE) →
 *   (optional CPO overview shows it) → SOS(linked) → end(idempotent).
 *
 * It does NOT mint fixtures (plan activation + CPO assignment go through the
 * ops flow). Provide a throwaway CUSTOMER on an ACTIVE Pro plan that already
 * has a covering dedicated officer TODAY, plus that officer's token to assert
 * the CPO side. Use throwaway accounts — never real users' credentials.
 *
 *   BASE=https://auth.94-136-184-52.sslip.io \
 *   CUSTOMER_JWT=... APP_ID=<active pro_application id> \
 *   CPO_JWT=... \                              # optional — asserts CPO overview
 *   node scripts/protection-e2e.mjs
 */
const BASE = process.env.BASE ?? 'https://auth.94-136-184-52.sslip.io';
const CUSTOMER_JWT = must('CUSTOMER_JWT');
const APP_ID = must('APP_ID');
const CPO_JWT = process.env.CPO_JWT ?? '';

function must(k) {
  const v = process.env[k];
  if (!v) { console.error(`missing env ${k}`); process.exit(2); }
  return v;
}
let idem = 0;
async function call(method, path, jwt, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json };
}
const ok = (label, cond, detail) => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? `  (${detail})` : ''}`);
  if (!cond) { process.exitCode = 1; }
};
const nowIso = () => new Date().toISOString();

(async () => {
  console.log(`→ ${BASE}`);

  // 1. create (idempotency key required)
  const created = await call('POST', '/protection/sessions', CUSTOMER_JWT,
    { application_id: APP_ID }, { 'idempotency-key': `e2e-create-${Date.now()}` });
  ok('create → 200/201', created.status < 300, `status ${created.status} ${JSON.stringify(created.json).slice(0, 160)}`);
  const sessionId = created.json?.session?.id;
  ok('session id present', !!sessionId);
  ok('starts REQUESTED (not optimistic ACTIVE)',
    created.json?.session?.status === 'REQUESTED' || created.json?.already_active === true);
  if (!sessionId) { return; }

  // 2. post a fix → activation-on-first-fix
  const fix = await call('POST', `/protection/sessions/${sessionId}/locations`, CUSTOMER_JWT,
    { fixes: [{ lat: 25.2048, lng: 55.2708, accuracy_m: 8, recorded_at: nowIso() }] });
  ok('locations → 200', fix.status === 200 || fix.status === 201, `status ${fix.status}`);
  ok('first fix flips ACTIVE', fix.json?.status === 'ACTIVE', `status=${fix.json?.status} activated=${fix.json?.activated}`);

  // 3. current reflects ACTIVE + CPO identity
  const cur = await call('GET', '/protection/sessions/current', CUSTOMER_JWT);
  ok('current → 200', cur.status === 200, `status ${cur.status}`);
  ok('current is ACTIVE', cur.json?.session?.status === 'ACTIVE');
  ok('CPO identity present (no PMC code)',
    !!cur.json?.session?.cpo_name && cur.json?.session?.mission_code === undefined);
  ok('server_now present (staleness base)', typeof cur.json?.server_now === 'string');

  // 4. CPO overview shows it (optional)
  if (CPO_JWT) {
    const ov = await call('GET', '/agents/me/protection/overview', CPO_JWT);
    ok('CPO overview → 200', ov.status === 200, `status ${ov.status}`);
    const mine = (ov.json?.customers ?? []).find(c => c.session_id === sessionId);
    ok('CPO sees the live session', !!mine, mine ? `staleness=${mine.staleness?.state}` : 'not found');
  } else {
    console.log('· CPO_JWT not set — skipping CPO overview assertion');
  }

  // 5. SOS links to the session
  const sos = await call('POST', '/sos/raise', CUSTOMER_JWT, { reason: 'protection_session' });
  ok('sos/raise → 200/201', sos.status < 300, `status ${sos.status}`);
  const afterSos = await call('GET', '/protection/sessions/current', CUSTOMER_JWT);
  ok('session flagged sos_active', afterSos.json?.session?.sos_active === true);

  // 6. end (idempotent)
  const end1 = await call('POST', `/protection/sessions/${sessionId}/end`, CUSTOMER_JWT, {},
    { 'idempotency-key': `e2e-end-${sessionId}` });
  ok('end → COMPLETED', end1.json?.session?.status === 'COMPLETED', `status=${end1.json?.session?.status}`);
  const end2 = await call('POST', `/protection/sessions/${sessionId}/end`, CUSTOMER_JWT, {},
    { 'idempotency-key': `e2e-end2-${sessionId}` });
  ok('end is idempotent', end2.status < 300 && end2.json?.session?.status === 'COMPLETED');

  // 7. current now 404
  const gone = await call('GET', '/protection/sessions/current', CUSTOMER_JWT);
  ok('no live session after end (404)', gone.status === 404, `status ${gone.status}`);

  console.log(process.exitCode ? '\n✗ E2E had failures' : '\n✓ E2E passed');
})().catch(e => { console.error(e); process.exit(1); });
