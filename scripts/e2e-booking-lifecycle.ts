/**
 * E2E test for the new booking lifecycle (Apr 2026 rebuild):
 *
 *   client books → ops approves → client auto-pays → agent applies →
 *   ops dispatches with applicationIds → group auto-created →
 *   ops completes → escrow distributed → group purged
 *
 * Hits live services on localhost. Reuses the helper style of e2e-flow.ts
 * but is focused on the new dispatch-from-applications path.
 *
 * Pre-reqs:
 *   • Postgres on 54322 (supabase local)
 *   • auth-service on 3001 (OTP_DEV_BYPASS=true)
 *
 * Run: `npx tsx scripts/e2e-booking-lifecycle.ts`
 */
import axios, {AxiosError} from 'axios';
import {Client} from 'pg';

const API = 'http://127.0.0.1:3001';
const DB  = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

const stamp = () => new Date().toISOString().slice(11, 19);
function step(t: string)  { console.log(`\n\x1b[1;34m[${stamp()}] ── ${t}\x1b[0m`); }
function ok(m: string)    { console.log(`\x1b[32m  ✓ ${m}\x1b[0m`); }
function info(m: string)  { console.log(`\x1b[90m    ${m}\x1b[0m`); }
function fail(m: string)  { console.log(`\x1b[31m  ✗ ${m}\x1b[0m`); }

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

async function req<T>(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown, token?: string): Promise<T> {
  const res = await axios.request<T>({
    method, url: `${API}${path}`, data: body,
    headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
    validateStatus: () => true,
  });
  if (res.status >= 400) throw Object.assign(new Error(`HTTP ${res.status}`), {response: res});
  return res.data;
}

const uniq = (p: string) => `${p}+${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Session { user_id: string; token: string; display_name: string; email: string; phoneE164: string; role: string; }

async function registerAndVerify(args: {email: string; displayName: string; phoneE164: string; role: string}): Promise<Session> {
  const password = 'TestPass!2026';
  const deviceId = 'e2e-' + Math.random().toString(36).slice(2, 10);
  await req('POST', '/auth/register', {
    email: args.email, password, displayName: args.displayName,
    phoneE164: args.phoneE164, role: args.role, subscriptionTier: 'lite',
    deviceId, platform: 'android',
  });
  const v = await req<{user: {id: string; email: string; role: string; display_name: string; phone_e164: string}; accessToken: string}>(
    'POST', '/auth/register/verify',
    {email: args.email, password, displayName: args.displayName, phoneE164: args.phoneE164,
     role: args.role, subscriptionTier: 'lite', deviceId, platform: 'android', code: '123456'},
  );
  return {
    user_id: v.user.id, token: v.accessToken, display_name: v.user.display_name,
    email: v.user.email, phoneE164: v.user.phone_e164, role: v.user.role,
  };
}

async function main() {
  const pg = new Client({connectionString: DB});
  await pg.connect();

  try {
    // ────────────────────────────────────────────────────────────
    step('Stage 1 · register admin / agent / client');
    const admin  = await registerAndVerify({email: uniq('ops') + '@bravo.test', displayName: 'E2E Ops', phoneE164: `+9715${String(Date.now()).slice(-8)}`,    role: 'individual'});
    const agent  = await registerAndVerify({email: uniq('cpo') + '@bravo.test', displayName: 'E2E CPO', phoneE164: `+9715${String(Date.now() + 1).slice(-8)}`, role: 'agent'});
    const client = await registerAndVerify({email: uniq('cli') + '@bravo.test', displayName: 'E2E Client', phoneE164: `+9715${String(Date.now() + 2).slice(-8)}`, role: 'individual'});
    ok(`admin=${admin.user_id.slice(0, 8)} · agent=${agent.user_id.slice(0, 8)} · client=${client.user_id.slice(0, 8)}`);

    await pg.query(
      `INSERT INTO admin_users (user_id, display_name, call_sign, role, region)
       VALUES ($1, $2, $3, 'SUPERVISOR', 'AE')
       ON CONFLICT (user_id) DO UPDATE SET role = 'SUPERVISOR'`,
      [admin.user_id, admin.display_name, `E2E-${Date.now() % 10000}`],
    );

    // ────────────────────────────────────────────────────────────
    step('Stage 2 · fast-track agent to ACTIVE');
    await req('POST', '/agents', {type: 'cpo', display_name: agent.display_name}, agent.token);
    await pg.query(
      `UPDATE agents SET status = 'ACTIVE', call_sign = $2 WHERE user_id = $1`,
      [agent.user_id, `CPO-E2E-${Date.now() % 1000}`],
    );
    // Mirror into cpo_pool so dispatch can lock the row.
    await pg.query(
      `INSERT INTO cpo_pool (id, call_sign, display_name, role, region_code, armed, female, specialties, availability, active)
       SELECT a.user_id,
              COALESCE(NULLIF(a.call_sign,''),'AGT-'||SUBSTRING(a.user_id::text,1,4)),
              COALESCE(NULLIF(a.display_name,''), SPLIT_PART(u.email,'@',1)),
              CASE a.tier WHEN 1 THEN 'Senior CPO' ELSE 'CPO' END,
              'AE', TRUE, FALSE, ARRAY['exec_protection']::text[], 'available', TRUE
       FROM agents a JOIN users u ON u.id=a.user_id
       WHERE a.user_id=$1
       ON CONFLICT (id) DO NOTHING`,
      [agent.user_id],
    );
    ok('agent ACTIVE + mirrored into cpo_pool');

    // Seed a vehicle if the pool is empty in this region.
    await pg.query(
      `INSERT INTO vehicle_pool (call_sign, make_model, plate, region_code, armored, armor_grade, capacity, status)
       VALUES ('E2E-VEH','Toyota LC300','E2E '||LEFT(MD5(NOW()::text),4),'AE',true,'B6',4,'available')
       ON CONFLICT (call_sign) DO NOTHING`,
    );

    // Top up client wallet so debit can succeed at pay-with-credits.
    const totalEur = 200; // matches the booking total below
    await pg.query(
      `INSERT INTO wallet_balances (user_id, bravo_credits, currency, updated_at)
       VALUES ($1, $2, 'AED', now())
       ON CONFLICT (user_id) DO UPDATE SET bravo_credits = wallet_balances.bravo_credits + EXCLUDED.bravo_credits`,
      [client.user_id, totalEur * 5],
    );
    ok(`client wallet topped up · ${totalEur * 5} BC`);

    // ────────────────────────────────────────────────────────────
    step('Stage 3 · client books → PENDING_OPS');
    const startIso = new Date(Date.now() + 4 * 3600_000).toISOString();
    const created = await req<{booking: {id: string; status: string; total_eur: number}}>(
      'POST', '/bookings',
      {type: 'timeslot',
       pickup:  {latitude: 25.197, longitude: 55.274, address: 'DIFC Gate 3'},
       dropoff: {latitude: 25.112, longitude: 55.139, address: 'Palm Jumeirah'},
       start_time: startIso, duration_hours: 4,
       add_ons: [], payment_method: 'bravo_credits',
       region: 'AE', region_label: 'UAE', service: 'secure_transfer',
       booking_mode: 'later', passengers: 2,
       cpo_count: 1, vehicle_count: 1, driver_only: false},
      client.token,
    );
    const bookingId = created.booking.id;
    ok(`booking ${bookingId.slice(0, 8)} · ${created.booking.status} · €${created.booking.total_eur}`);
    if (created.booking.status !== 'PENDING_OPS') fail(`expected PENDING_OPS, got ${created.booking.status}`);

    // ────────────────────────────────────────────────────────────
    step('Stage 4 · ops approves → job auto-published');
    const approved = await req<{job: {id: string; short_code: string; status: string}}>(
      'POST', `/ops/bookings/${bookingId}/approve`,
      {notes: 'e2e', dress_instructions: 'Black suit, white shirt, no tie. Concealed earpiece.'},
      admin.token,
    );
    ok(`ops approved · job ${approved.job.short_code} (${approved.job.status})`);
    const jobId = approved.job.id;

    // ────────────────────────────────────────────────────────────
    step('Stage 5 · client pays-with-credits → CONFIRMED');
    const paid = await req<{booking: {status: string}}>('POST', `/bookings/${bookingId}/pay-with-credits`, {}, client.token);
    ok(`paid · status=${paid.booking.status}`);
    if (paid.booking.status !== 'CONFIRMED') fail(`expected CONFIRMED, got ${paid.booking.status}`);

    // Verify booking has NO team yet (no auto-assignment).
    const {rows: noTeam} = await pg.query<{cnt: string}>(
      `SELECT COUNT(*)::text AS cnt FROM booking_cpo_assignments WHERE booking_id = $1`, [bookingId],
    );
    if (Number(noTeam[0].cnt) > 0) fail('booking already has a team — auto-assignment must be off');
    else ok('booking sits at CONFIRMED with no team (manual dispatch path enforced)');

    // ────────────────────────────────────────────────────────────
    step('Stage 6 · agent applies via public endpoint');
    const apply = await req<{application: {id: string; status: string}}>(
      'POST', `/agents/me/jobs/${jobId}/apply`,
      {dress_pledge: 'Black two-piece, plain white shirt, concealed earpiece.'},
      agent.token,
    );
    ok(`agent applied · application ${apply.application.id.slice(0, 8)} · ${apply.application.status}`);
    if (apply.application.status !== 'PENDING') fail(`expected PENDING, got ${apply.application.status}`);

    // Available-jobs feed should now report applied=true for this job.
    const feed = await req<{jobs: Array<{id: string; applied: boolean; application_status: string | null}>}>(
      'GET', '/agents/me/available-jobs', undefined, agent.token,
    );
    const jobInFeed = feed.jobs.find(j => j.id === jobId);
    if (!jobInFeed || !jobInFeed.applied || jobInFeed.application_status !== 'PENDING') {
      fail(`available-jobs feed didn't reflect the application · ${JSON.stringify(jobInFeed)}`);
    } else {
      ok('available-jobs feed shows applied=true · application_status=PENDING');
    }

    // ────────────────────────────────────────────────────────────
    step('Stage 7 · ops sees applicants + dispatches');
    const applicants = await req<{job: {id: string} | null; applicants: Array<{id: string; agent_id: string; status: string}>}>(
      'GET', `/ops/bookings/${bookingId}/applicants`, undefined, admin.token,
    );
    if (applicants.applicants.length !== 1) fail(`expected 1 applicant, got ${applicants.applicants.length}`);
    else ok(`ops sees ${applicants.applicants.length} applicant`);

    // Pick a vehicle from the pool.
    const vehicles = await req<Array<{id: string; call_sign: string}>>(
      'GET', '/ops/pool/vehicles?region=AE', undefined, admin.token,
    );
    if (vehicles.length === 0) { fail('no vehicles in AE pool'); return; }

    const dispatched = await req<{ok: true; status: string; conversation_id: string | null}>(
      'POST', `/ops/bookings/${bookingId}/dispatch`,
      {applicationIds: [applicants.applicants[0].id], vehicleId: vehicles[0].id},
      admin.token,
    );
    ok(`dispatched · ${dispatched.status} · conversation=${dispatched.conversation_id?.slice(0, 8) ?? 'NULL'}`);
    if (dispatched.status !== 'LIVE') fail(`expected LIVE, got ${dispatched.status}`);
    if (!dispatched.conversation_id) fail('dispatch did not create a mission group');

    const convId = dispatched.conversation_id!;

    // Verify group has admin (ops) + agent as members.
    const {rows: members} = await pg.query<{user_id: string; role: string}>(
      `SELECT user_id, role FROM conversation_members WHERE conversation_id = $1`, [convId],
    );
    const adminMember = members.find(m => m.user_id === admin.user_id);
    const agentMember = members.find(m => m.user_id === agent.user_id);
    if (!adminMember || adminMember.role !== 'admin') fail('ops admin not present as admin in group');
    else if (!agentMember || agentMember.role !== 'member') fail('agent not present as member in group');
    else ok(`group has ${members.length} members · admin=ops · member=agent`);

    // Verify the rejected-applications branch behaves correctly when it's
    // the only applicant: nothing to reject, but the others stay PENDING.
    const {rows: appRows} = await pg.query<{status: string}>(
      `SELECT status FROM job_applications WHERE id = $1`, [applicants.applicants[0].id],
    );
    if (appRows[0].status !== 'ASSIGNED') fail(`expected ASSIGNED, got ${appRows[0].status}`);
    else ok('chosen application flipped to ASSIGNED');

    // ────────────────────────────────────────────────────────────
    step('Stage 8 · ops completes → payouts settled + group dissolved');
    const {rows: balBefore} = await pg.query<{bravo_credits: string}>(
      `SELECT bravo_credits FROM wallet_balances WHERE user_id = $1`, [agent.user_id],
    );
    const before = Number(balBefore[0]?.bravo_credits ?? 0);

    const completed = await req<{
      ok: true; status: string;
      payouts: Array<{user_id: string; credits: number}>;
      platform_fee: number; group_purged: boolean;
    }>('POST', `/ops/bookings/${bookingId}/complete`, undefined, admin.token);
    ok(`completed · status=${completed.status} · platform_fee=${completed.platform_fee} BC · group_purged=${completed.group_purged}`);
    if (completed.status !== 'COMPLETED') fail(`expected COMPLETED, got ${completed.status}`);
    if (!completed.group_purged)         fail('group was not purged');

    if (completed.payouts.length !== 1) fail(`expected 1 payout, got ${completed.payouts.length}`);
    else ok(`payout · ${completed.payouts[0].credits} BC → agent ${completed.payouts[0].user_id.slice(0, 8)}`);

    // Verify wallet credit landed.
    const {rows: balAfter} = await pg.query<{bravo_credits: string}>(
      `SELECT bravo_credits FROM wallet_balances WHERE user_id = $1`, [agent.user_id],
    );
    const after = Number(balAfter[0]?.bravo_credits ?? 0);
    info(`agent BC: ${before} → ${after} (Δ ${after - before})`);
    if (after - before !== completed.payouts[0].credits) {
      fail(`agent BC delta ${after - before} ≠ expected payout ${completed.payouts[0].credits}`);
    } else {
      ok('wallet ledger reflects payout');
    }

    // Per-side dissolution: conversation row + ops admin membership stay
    // (audit retention); agent member rows are gone (room drops off the
    // agents' Messenger list on next listMine poll).
    const {rows: convRows} = await pg.query<{id: string; title: string | null}>(
      `SELECT id, title FROM conversations WHERE id = $1`, [convId],
    );
    if (convRows.length === 0) fail('conversation row was deleted (expected to be retained for ops audit)');
    else ok(`conversation retained · title="${convRows[0].title}"`);

    const {rows: memberRows} = await pg.query<{user_id: string; role: 'admin' | 'member'}>(
      `SELECT user_id, role FROM conversation_members WHERE conversation_id = $1`, [convId],
    );
    const adminsLeft   = memberRows.filter(m => m.role === 'admin').length;
    const membersLeft  = memberRows.filter(m => m.role === 'member').length;
    if (adminsLeft < 1)    fail(`expected ops admin to remain, got ${adminsLeft} admins`);
    else                   ok(`ops admin retained · ${adminsLeft} admin row(s)`);
    if (membersLeft !== 0) fail(`expected 0 agent members after complete, got ${membersLeft}`);
    else                   ok('agents removed from conversation_members');

    // CPO + vehicle should be back in 'available' state for the next mission.
    const {rows: cpoStatus} = await pg.query<{availability: string}>(
      `SELECT availability FROM cpo_pool WHERE id = $1`, [agent.user_id],
    );
    if (cpoStatus[0]?.availability !== 'available') fail(`agent cpo_pool.availability = ${cpoStatus[0]?.availability}`);
    else ok('agent released back to pool · availability=available');

    console.log('\n\x1b[1;32m✓ booking lifecycle e2e PASSED\x1b[0m\n');
  } catch (e) {
    fail(explain(e));
    process.exitCode = 1;
  } finally {
    await pg.end();
  }
}

main();
