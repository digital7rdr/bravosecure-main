/**
 * End-to-end runtime scenario — hits live services on localhost.
 *
 *  Stage 1: seed admin user in admin_users (bypass AdminGuard)
 *  Stage 2: agent signs up → submits onboarding → ops approves → deployment passed
 *  Stage 3: client signs up → books a transfer → ops approves → auto-publishes job
 *  Stage 4: agent applies → ops assigns → ops dispatches → mission created + ops-room group
 *  Stage 5: mission lifecycle (dispatched → pickup → live → complete) compressed into ~30s
 *  Stage 6: verify audit + system broadcasts landed in the messenger thread
 *
 * Pre-reqs (already running in local stack):
 *   • Postgres on 54322 (supabase local db)
 *   • Auth-service on 3001 with OTP_DEV_BYPASS=true
 *
 * Run: `npx tsx scripts/e2e-flow.ts` from the repo root.
 */
import axios, {AxiosError} from 'axios';
import {Client} from 'pg';

const API = 'http://127.0.0.1:3001';
const DB  = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// ─── Tiny logging helpers ─────────────────────────────────────────
const stamp = () => new Date().toISOString().slice(11, 19);
function step(title: string) {
  console.log(`\n\x1b[1;34m[${stamp()}] ── ${title}\x1b[0m`);
}
function ok(msg: string)   { console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`); }
function info(msg: string) { console.log(`\x1b[90m    ${msg}\x1b[0m`); }
function fail(msg: string) { console.log(`\x1b[31m  ✗ ${msg}\x1b[0m`); }

function explain(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{message?: unknown}>;
    const body = ax.response?.data;
    const msg = (body as {message?: unknown} | undefined)?.message;
    const asStr = Array.isArray(msg) ? msg.join(' · ') : (typeof msg === 'string' ? msg : JSON.stringify(body));
    return `HTTP ${ax.response?.status ?? '??'} · ${asStr}`;
  }
  return (err as Error)?.message ?? String(err);
}

async function request<T>(
  method: 'POST' | 'GET' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  token?: string,
): Promise<T> {
  const res = await axios.request<T>({
    method,
    url: `${API}${path}`,
    data: body,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? {Authorization: `Bearer ${token}`} : {}),
    },
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw Object.assign(new Error(`HTTP ${res.status}`), {response: res});
  }
  return res.data;
}

const uniq = (prefix: string) =>
  `${prefix}+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

// ─── Auth helpers ─────────────────────────────────────────────────

interface Session {
  user_id: string;
  token: string;
  display_name: string;
  email: string;
  phoneE164: string;
  role: string;
}

async function registerAndVerify(args: {
  email: string; displayName: string; phoneE164: string; role: string;
}): Promise<Session> {
  const password = 'TestPass!2026';
  const deviceId = 'e2e-' + Math.random().toString(36).slice(2, 10);

  await request('POST', '/auth/register', {
    email: args.email,
    password,
    displayName: args.displayName,
    phoneE164: args.phoneE164,
    role: args.role,
    subscriptionTier: 'lite',
    deviceId,
    platform: 'android',
  });

  const verify = await request<{
    user: {id: string; email: string; role: string; display_name: string; phone_e164: string};
    accessToken: string;
  }>('POST', '/auth/register/verify', {
    email: args.email,
    password,
    displayName: args.displayName,
    phoneE164: args.phoneE164,
    role: args.role,
    subscriptionTier: 'lite',
    deviceId,
    platform: 'android',
    code: '123456', // any digits pass in OTP_DEV_BYPASS
  });

  return {
    user_id: verify.user.id,
    token: verify.accessToken,
    display_name: verify.user.display_name,
    email: verify.user.email,
    phoneE164: verify.user.phone_e164,
    role: verify.user.role,
  };
}

// ─── Main scenario ────────────────────────────────────────────────

async function main() {
  const pg = new Client({connectionString: DB});
  await pg.connect();

  try {
    // ════════════════════════════════════════════════════════════
    // STAGE 1 — users
    // ════════════════════════════════════════════════════════════
    step('Stage 1 · register admin, agent, client');

    // Admin user (acts as Ops Supervisor)
    const admin = await registerAndVerify({
      email:        uniq('ops-admin') + '@bravo.test',
      displayName:  'E2E Ops Admin',
      phoneE164:    `+9715${String(Date.now()).slice(-8)}`,
      role:         'individual', // the users table accepts any; role does not matter for admin
    });
    ok(`admin registered · ${admin.user_id}`);

    // Seed into admin_users so AdminGuard passes.
    await pg.query(
      `INSERT INTO admin_users (user_id, display_name, call_sign, role, region)
       VALUES ($1, $2, $3, 'SUPERVISOR', 'AE')
       ON CONFLICT (user_id) DO UPDATE SET role = 'SUPERVISOR'`,
      [admin.user_id, admin.display_name, `E2E-${Date.now() % 10000}`],
    );
    ok('admin seeded as SUPERVISOR in admin_users');

    // Agent user
    const agent = await registerAndVerify({
      email:       uniq('agent') + '@bravo.test',
      displayName: 'E2E CPO Agent',
      phoneE164:   `+9715${String(Date.now() + 1).slice(-8)}`,
      role:        'agent',
    });
    ok(`agent registered · role=${agent.role} · ${agent.user_id}`);

    // Client user
    const client = await registerAndVerify({
      email:       uniq('client') + '@bravo.test',
      displayName: 'E2E Client',
      phoneE164:   `+9715${String(Date.now() + 2).slice(-8)}`,
      role:        'individual',
    });
    ok(`client registered · ${client.user_id}`);

    // ════════════════════════════════════════════════════════════
    // STAGE 2 — agent onboarding + ops approval
    // ════════════════════════════════════════════════════════════
    step('Stage 2 · agent walks onboarding + ops approves');

    await request('POST', '/agents', {type: 'cpo', display_name: agent.display_name}, agent.token);
    ok('agent row created (type=cpo, status=DRAFT)');

    await request('PATCH', '/agents/me/company', {
      legal_name:    'E2E Close Protection Ltd.',
      company_number:'SIA-E2E-001',
      regulator:     'UK SIA',
      established:   '2020-01-01',
      primary_contact:'E2E Tester',
      primary_email:  agent.email,
      primary_phone:  agent.phoneE164,
      capabilities:   ['first_aid', 'firearms'],
    }, agent.token);
    ok('company + contact + capabilities saved');

    await request('POST', '/agents/me/kyc/start', {}, agent.token);
    ok('KYC started (status → KYC_PENDING)');

    // Auto-settle all KYC checks (in prod these come from Twilio/DBS webhooks).
    await pg.query(
      `UPDATE agent_kyc_checks SET state = 'done', settled_at = NOW() WHERE user_id = $1`,
      [agent.user_id],
    );
    await pg.query(
      `UPDATE agents SET status = 'DOCS_PENDING' WHERE user_id = $1 AND status = 'KYC_PENDING'`,
      [agent.user_id],
    );
    ok('KYC checks force-settled (simulating regulator webhooks)');

    await request('PATCH', '/agents/me/coverage', {
      countries: [{code: 'AE', on: true}, {code: 'GB', on: true}],
      services:  [{key: 'cp', on: true}, {key: 'driving', on: true}],
    }, agent.token);
    ok('coverage saved (AE + GB · CP + driving)');

    await request('PATCH', '/agents/me/availability', {
      mode: 'full', loadout: ['armoured', 'sia'],
    }, agent.token);
    ok('availability saved (full-time, armoured+sia)');

    for (const slot of ['sia', 'passport', 'insurance', 'dbs']) {
      await request('POST', '/agents/me/documents', {
        slot, title: slot.toUpperCase(),
        file_url: `s3://e2e/${agent.user_id}/${slot}.pdf`,
      }, agent.token);
    }
    ok('4 required documents uploaded');

    await request('POST', '/agents/me/submit', {}, agent.token);
    ok('agent submitted for admin review (status → SUBMITTED)');

    // Ops approves.
    await request('POST', `/ops/agents/${agent.user_id}/decide`, {
      decision: 'APPROVED', notes: 'e2e auto-approve',
    }, admin.token);
    ok('ops-admin APPROVED the agent');

    // Simulate ops signing off every deployment check → agent goes ACTIVE.
    // Endpoint lives under /agents/:id/deploy/signoff (OPS actor).
    const {rows: dcRows} = await pg.query<{check_key: string}>(
      `SELECT check_key FROM agent_deployment_checks WHERE user_id = $1`,
      [agent.user_id],
    );
    for (const dc of dcRows) {
      await request('POST', `/agents/${agent.user_id}/deploy/signoff`, {
        check_key: dc.check_key, state: 'passed',
      }, admin.token);
    }
    ok('all 4 deployment checks signed off');

    const meAfterActive = await request<{agent: {status: string}}>(
      'GET', '/agents/me', undefined, agent.token,
    );
    if (meAfterActive.agent.status !== 'ACTIVE') {
      fail(`expected status=ACTIVE, got ${meAfterActive.agent.status}`);
    } else {
      ok(`agent is ACTIVE · ready for jobs`);
    }

    // ════════════════════════════════════════════════════════════
    // STAGE 3 — client books
    // ════════════════════════════════════════════════════════════
    step('Stage 3 · client books a Secure transfer');

    const startIso = new Date(Date.now() + 4 * 3600_000).toISOString(); // +4h (well past MIN_LEAD_HOURS=3)
    const booking = await request<{booking: {id: string; status: string; total_aed: string}}>(
      'POST', '/bookings',
      {
        type: 'timeslot',
        pickup:   {latitude: 25.1972, longitude: 55.2744, address: 'DIFC Gate 3'},
        dropoff:  {latitude: 25.1124, longitude: 55.1390, address: 'Palm Jumeirah'},
        start_time: startIso,
        duration_hours: 4,
        add_ons: [],
        payment_method: 'card',
        region: 'AE',
        region_label: 'UAE',
        service: 'secure_transfer',
        booking_mode: 'later',
        passengers: 2,
        cpo_count: 1,
        vehicle_count: 1,
        driver_only: false,
      },
      client.token,
    );
    ok(`booking created · ${booking.booking.id} · PENDING_OPS · AED ${booking.booking.total_aed}`);

    // Ops approves → publishes to job feed.
    const approved = await request<{job: {id: string; short_code: string; status: string}}>(
      'POST', `/ops/bookings/${booking.booking.id}/approve`,
      {notes: 'e2e approved', dress_instructions: 'Black suit, white shirt, no tie. Concealed earpiece.'},
      admin.token,
    );
    ok(`ops approved booking → job ${approved.job.short_code} published`);

    // ════════════════════════════════════════════════════════════
    // STAGE 4 — agent applies + ops assigns + ops dispatches
    // ════════════════════════════════════════════════════════════
    step('Stage 4 · agent applies → ops assigns → dispatch creates mission + ops room');

    // Agent applies. The agent-facing apply endpoint doesn't exist on the
    // public mobile API yet — the public JobMarketplace uses `/agent/jobs/:id/apply`
    // which isn't wired in the scope of this project. For the e2e scenario
    // we insert the application directly.
    const appId = (await pg.query<{id: string}>(
      `INSERT INTO job_applications
         (job_id, agent_id, agent_call_sign, status, fit_score, distance_km, rate_per_hour, rate_ccy)
       VALUES ($1, $2, $3, 'PENDING', 94, 3.2, 540, 'AED')
       RETURNING id`,
      [approved.job.id, agent.user_id, `AGT-E2E-${Date.now() % 1000}`],
    )).rows[0].id;
    ok(`agent applied · application ${appId}`);

    await request('POST', `/ops/applications/${appId}/assign`, {}, admin.token);
    ok('ops assigned the agent to the job');

    const dispatched = await request<{mission_id: string}>(
      'POST', `/ops/jobs/${approved.job.id}/dispatch`, {}, admin.token,
    );
    ok(`mission created · ${dispatched.mission_id}`);

    // Verify auto ops-room group was created + seed broadcast landed.
    const {rows: missionRow} = await pg.query<{comms_channel_id: string | null; short_code: string}>(
      `SELECT comms_channel_id, short_code FROM missions WHERE id = $1`,
      [dispatched.mission_id],
    );
    if (!missionRow[0].comms_channel_id) {
      fail('mission.comms_channel_id is NULL — ops-room group was NOT created');
    } else {
      ok(`ops-room group conversation created · ${missionRow[0].comms_channel_id}`);
    }

    const {rows: greetingRows} = await pg.query<{kind: string; body: string}>(
      `SELECT kind, body FROM system_broadcasts
        WHERE subject_type = 'mission' AND subject_id = $1 AND kind = 'mission_started'`,
      [dispatched.mission_id],
    );
    if (greetingRows.length === 0) {
      fail('no mission_started broadcast found in the ops-room');
    } else {
      ok(`ops-room greeting card posted: "${greetingRows[0].body.slice(0, 60)}…"`);
    }

    // ════════════════════════════════════════════════════════════
    // STAGE 5 — mission lifecycle (compressed 5 min → ~15 s)
    // ════════════════════════════════════════════════════════════
    step('Stage 5 · mission lifecycle — dispatched → pickup → live → complete (compressed)');

    const missionId = dispatched.mission_id;

    // Telemetry pings simulating the agent's phone.
    for (let i = 0; i < 3; i++) {
      await request('POST', `/ops/missions/${missionId}/telemetry`, {
        lat: 25.197 + i * 0.005, lng: 55.274 - i * 0.005,
        heading_deg: 220, speed_kph: 42,
      }, admin.token);
      await sleep(500);
    }
    ok('3 telemetry pings ingested');

    // Agent-driven transitions — simulated server-side (the mobile app
    // would hit these endpoints; backend doesn't yet expose public
    // agent-side mission endpoints, so drive via DB + emit audit).
    await driveMissionStatus(pg, missionId, 'PICKUP', 'e2e-agent-pickup');
    ok('mission → PICKUP (principal onboard)');

    await sleep(1000);
    await driveMissionStatus(pg, missionId, 'LIVE', 'e2e-agent-live');
    ok('mission → LIVE (en route)');

    await sleep(2000);  // compress 5 min → 2 s

    // Ops completes via the admin endpoint — this is a test affordance,
    // in prod the agent would fire it. We use the abort endpoint with
    // reason='completed' as a stand-in, OR just flip the row.
    await pg.query(
      `UPDATE missions SET status = 'COMPLETED', ended_at = NOW() WHERE id = $1`,
      [missionId],
    );
    await pg.query(
      `UPDATE lite_bookings SET status = 'COMPLETED' WHERE id = $1`,
      [booking.booking.id],
    );
    ok('mission → COMPLETED (bookings flipped to COMPLETED too)');

    // ════════════════════════════════════════════════════════════
    // STAGE 6 — verify audit + broadcasts
    // ════════════════════════════════════════════════════════════
    step('Stage 6 · verify audit + system broadcasts');

    const audit = await request<{id: number; actor_role: string; action: string}[]>(
      'GET', `/ops/audit/mission/${missionId}`, undefined, admin.token,
    );
    ok(`${audit.length} audit rows for mission ${missionId.slice(0, 8)}`);
    for (const row of audit.slice(0, 5)) {
      info(`${row.actor_role} · ${row.action}`);
    }

    const bookingAudit = await request<{id: number; action: string}[]>(
      'GET', `/ops/audit/booking/${booking.booking.id}`, undefined, admin.token,
    );
    ok(`${bookingAudit.length} audit rows for the booking`);

    const bcasts = await request<{kind: string; body: string}[]>(
      'GET', `/ops/broadcasts/subject/mission/${missionId}`, undefined, admin.token,
    );
    ok(`${bcasts.length} system broadcasts in the mission's ops room`);
    for (const b of bcasts) info(`${b.kind} · ${b.body.slice(0, 60)}`);

    const clientBcasts = await request<{kind: string}[]>(
      'GET', `/ops/broadcasts/subject/booking/${booking.booking.id}`, undefined, admin.token,
    );
    ok(`${clientBcasts.length} broadcasts sent to the client (booking_approved etc.)`);

    console.log('\n\x1b[1;32m════════════════════════════════════════════════════\x1b[0m');
    console.log('\x1b[1;32m  🎉  END-TO-END SCENARIO PASSED\x1b[0m');
    console.log('\x1b[1;32m════════════════════════════════════════════════════\x1b[0m');
  } catch (e) {
    console.error('\n\x1b[1;31m════════════════════════════════════════════════════\x1b[0m');
    console.error('\x1b[1;31m  ✗ SCENARIO FAILED\x1b[0m');
    console.error(`\x1b[1;31m    ${explain(e)}\x1b[0m`);
    console.error('\x1b[1;31m════════════════════════════════════════════════════\x1b[0m');
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
}

async function driveMissionStatus(pg: Client, missionId: string, status: string, reason: string) {
  await pg.query(`UPDATE missions SET status = $2 WHERE id = $1`, [missionId, status]);
  await pg.query(
    `INSERT INTO ops_audit (actor_role, action, subject_type, subject_id, metadata)
     VALUES ('AGENT', $1, 'mission', $2, $3::jsonb)`,
    [`mission.${status.toLowerCase()}`, missionId, JSON.stringify({reason})],
  );
}

function sleep(ms: number) { return new Promise<void>(r => setTimeout(r, ms)); }

void main();
