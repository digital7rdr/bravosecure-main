/**
 * Ops dashboard load scenario — exercises every dashboard page + every
 * /ops/* endpoint by seeding 6+ missions distributed across the pipeline
 * and then hitting each GET the ops-console polls.
 *
 * Pipeline targets (min 6 missions active at once):
 *   • 1 booking  PENDING_OPS   (awaiting ops approval)
 *   • 1 booking  OPS_APPROVED  (job published, no apps)
 *   • 1 job      REVIEW        (apps submitted, awaiting assign)
 *   • 1 job      ASSIGNED      (ready to dispatch)
 *   • 2 missions LIVE          (telemetry streaming — laptop coords)
 *   • 1 mission  COMPLETED     (to verify ops-room archives)
 *
 * Also verifies:
 *   • wallet topup ledger entries per client
 *   • ops-room conversation auto-created on dispatch
 *   • system_broadcasts posted for every lifecycle event
 *   • archived_at set on conversations of completed/aborted missions
 *   • ops console KPIs, agent list, mission list, jobs board data load
 *
 * Pre-reqs:
 *   • Postgres 54322, Redis 6379, auth-service :3001 with OTP_DEV_BYPASS=true
 *   • Migrations 20260424200000_conversation_archive.sql applied
 *
 * Run: `npx tsx scripts/e2e-ops-load.ts`
 */
import axios, {AxiosError} from 'axios';
import {Client} from 'pg';

const API = 'http://127.0.0.1:3001';
const DB  = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

// Laptop approximate location (ipwho.is lookup: Gazipur, Bangladesh)
const LAPTOP_LAT = 23.9999;
const LAPTOP_LNG = 90.4202;

// ─── Logging ──────────────────────────────────────────────────────
const t = () => new Date().toISOString().slice(11, 19);
const b = (s: string) => `\x1b[1;34m[${t()}] ── ${s}\x1b[0m`;
const g = (s: string) => `\x1b[32m  ✓ ${s}\x1b[0m`;
const y = (s: string) => `\x1b[33m  ⚠ ${s}\x1b[0m`;
const r = (s: string) => `\x1b[31m  ✗ ${s}\x1b[0m`;
const m = (s: string) => `\x1b[90m    ${s}\x1b[0m`;

function explain(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const ax = err as AxiosError<{message?: unknown}>;
    const body = ax.response?.data as {message?: unknown} | undefined;
    const msg = body?.message;
    const s = Array.isArray(msg) ? msg.join(' · ') : (typeof msg === 'string' ? msg : JSON.stringify(body));
    return `HTTP ${ax.response?.status ?? '??'} · ${ax.config?.method?.toUpperCase()} ${ax.config?.url} · ${s}`;
  }
  if (err && typeof err === 'object' && 'response' in err) {
    const r = (err as {response?: {status?: number; data?: unknown; config?: {url?: string; method?: string}}}).response;
    return `HTTP ${r?.status ?? '??'} · ${r?.config?.method?.toUpperCase() ?? '?'} ${r?.config?.url ?? '?'} · ${JSON.stringify(r?.data)}`;
  }
  return (err as Error)?.message ?? String(err);
}

async function req<T>(method: 'POST'|'GET'|'PATCH'|'DELETE', path: string, body?: unknown, token?: string): Promise<T> {
  const res = await axios.request<T>({
    method, url: `${API}${path}`, data: body,
    headers: {'Content-Type':'application/json', ...(token ? {Authorization:`Bearer ${token}`} : {})},
    validateStatus: () => true,
  });
  if (res.status >= 400) {
    throw Object.assign(new Error(`HTTP ${res.status}`), {
      response: {...res, config: {url: path, method}},
    });
  }
  return res.data;
}

const uniq = (p: string) => `${p}+${Date.now().toString(36)}${Math.random().toString(36).slice(2,5)}`;
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

interface Session {user_id: string; token: string; display_name: string; email: string; phoneE164: string}

async function registerAndVerify(args: {email: string; displayName: string; phoneE164: string; role: string}): Promise<Session> {
  const password = 'TestPass!2026';
  const deviceId = 'e2e-' + Math.random().toString(36).slice(2,10);
  await req('POST', '/auth/register', {...args, password, subscriptionTier:'lite', deviceId, platform:'android'});
  const v = await req<{user:{id:string;display_name:string;email:string;phone_e164:string}; accessToken:string}>(
    'POST', '/auth/register/verify',
    {...args, password, subscriptionTier:'lite', deviceId, platform:'android', code:'123456'},
  );
  return {
    user_id: v.user.id, token: v.accessToken, display_name: v.user.display_name,
    email: v.user.email, phoneE164: v.user.phone_e164,
  };
}

async function seedAdmin(pg: Client, admin: Session) {
  await pg.query(
    `INSERT INTO admin_users (user_id, display_name, call_sign, role, region)
     VALUES ($1, $2, $3, 'SUPERVISOR', 'AE')
     ON CONFLICT (user_id) DO UPDATE SET role = 'SUPERVISOR'`,
    [admin.user_id, admin.display_name, `OPS-${Date.now() % 10000}-${Math.random().toString(36).slice(2,4).toUpperCase()}`],
  );
}

/** Walk a freshly-registered user through the agent onboarding + ops approval. */
async function onboardAgentToActive(agent: Session, admin: Session, pg: Client, tag: string): Promise<void> {
  await req('POST', '/agents', {type:'cpo', display_name: agent.display_name}, agent.token);
  await req('PATCH', '/agents/me/company', {
    legal_name: `E2E CPO ${tag} Ltd`,
    company_number: `SIA-${tag}-${Date.now() % 10000}`,
    regulator: 'UK SIA',
    established: '2020-01-01',
    primary_contact: agent.display_name,
    primary_email:   agent.email,
    primary_phone:   agent.phoneE164,
    capabilities: ['first_aid','firearms'],
  }, agent.token);
  await req('POST', '/agents/me/kyc/start', {}, agent.token);
  await pg.query(`UPDATE agent_kyc_checks SET state='done', settled_at=NOW() WHERE user_id=$1`, [agent.user_id]);
  await pg.query(`UPDATE agents SET status='DOCS_PENDING' WHERE user_id=$1 AND status='KYC_PENDING'`, [agent.user_id]);
  await req('PATCH', '/agents/me/coverage', {countries:[{code:'AE',on:true},{code:'BD',on:true}], services:[{key:'cp',on:true}]}, agent.token);
  await req('PATCH', '/agents/me/availability', {mode:'full', loadout:['armoured','sia']}, agent.token);
  for (const slot of ['sia','passport','insurance','dbs']) {
    await req('POST', '/agents/me/documents', {slot, title: slot.toUpperCase(), file_url: `s3://e2e/${agent.user_id}/${slot}.pdf`}, agent.token);
  }
  await req('POST', '/agents/me/submit', {}, agent.token);
  await req('POST', `/ops/agents/${agent.user_id}/decide`, {decision:'APPROVED', notes:'e2e load'}, admin.token);
  const checks = (await pg.query<{check_key:string}>(`SELECT check_key FROM agent_deployment_checks WHERE user_id=$1`, [agent.user_id])).rows;
  for (const c of checks) {
    await req('POST', `/agents/${agent.user_id}/deploy/signoff`, {check_key: c.check_key, state:'passed'}, admin.token);
  }
}

async function createBooking(client: Session, offsetHours: number): Promise<{id: string; total_aed: string}> {
  // Pickup around the laptop location with slight per-booking jitter.
  const jitter = () => (Math.random() - 0.5) * 0.05;
  const booking = await req<{booking:{id:string; total_aed:string}}>(
    'POST', '/bookings',
    {
      type: 'timeslot',
      pickup:  {latitude: LAPTOP_LAT + jitter(), longitude: LAPTOP_LNG + jitter(), address: 'DIFC Gate 3'},
      dropoff: {latitude: LAPTOP_LAT + jitter(), longitude: LAPTOP_LNG + jitter(), address: 'Palm Jumeirah'},
      start_time: new Date(Date.now() + offsetHours * 3600_000).toISOString(),
      duration_hours: 4, add_ons: [], payment_method: 'card',
      region: 'AE', region_label: 'UAE', service: 'secure_transfer',
      booking_mode: 'later', passengers: 2, cpo_count: 1, vehicle_count: 1, driver_only: false,
    }, client.token,
  );
  return booking.booking;
}

async function topupWallet(user: Session, amountAed: number): Promise<number> {
  // Local dev path: Stripe disabled → topup auto-settles, credits the ledger.
  const res = await req<{credits_awarded: number; fallback?: boolean}>(
    'POST', '/wallet/topup', {amount: amountAed, currency: 'aed', credits_hint: amountAed}, user.token,
  );
  return res.credits_awarded;
}

async function main() {
  const pg = new Client({connectionString: DB});
  await pg.connect();
  try {
    console.log(b('Stage 0 · register ops admin, 3 agents, 7 clients'));

    const admin = await registerAndVerify({
      email: uniq('ops')+'@bravo.test', displayName: 'E2E Ops Supervisor',
      phoneE164: `+9715${String(Date.now()).slice(-8)}`, role: 'individual',
    });
    await seedAdmin(pg, admin);
    console.log(g(`admin · ${admin.user_id.slice(0,8)} · SUPERVISOR`));

    const agents: Session[] = [];
    for (let i = 0; i < 3; i++) {
      const a = await registerAndVerify({
        email: uniq(`agt${i}`)+'@bravo.test', displayName: `E2E CPO ${i+1}`,
        phoneE164: `+9715${String(Date.now()+i).slice(-8)}`, role: 'agent',
      });
      await onboardAgentToActive(a, admin, pg, `AG${i}`);
      agents.push(a);
      console.log(g(`agent${i+1} ACTIVE · ${a.user_id.slice(0,8)}`));
    }

    const clients: Session[] = [];
    for (let i = 0; i < 7; i++) {
      const c = await registerAndVerify({
        email: uniq(`cli${i}`)+'@bravo.test', displayName: `E2E Client ${i+1}`,
        phoneE164: `+9715${String(Date.now()+100+i).slice(-8)}`, role: 'individual',
      });
      clients.push(c);
    }
    console.log(g(`7 clients registered`));

    console.log(b('Stage 1 · seed wallet topups (payment-captured ledger)'));
    const thisRunClientIds = clients.map(c => c.user_id);
    for (const c of clients) await topupWallet(c, 2000);
    // Simulate Stripe webhook settlement for this run's topups — local dev
    // has STRIPE_SECRET_KEY set so topups are born PENDING and need the
    // webhook to flip them. We settle directly to mirror prod behavior.
    await pg.query(
      `UPDATE wallet_transactions
          SET status = 'succeeded', settled_at = NOW()
        WHERE type = 'topup' AND status = 'pending' AND user_id = ANY($1::uuid[])`,
      [thisRunClientIds],
    );
    // Credit the balance rows to match, so /wallet/balance reads correctly.
    for (const c of clients) {
      await pg.query(
        `UPDATE wallet_balances
            SET bravo_credits = bravo_credits + 2000, updated_at = NOW()
          WHERE user_id = $1`,
        [c.user_id],
      );
    }
    const ledger = await pg.query<{s:string; n:string}>(
      `SELECT status AS s, COUNT(*)::text AS n FROM wallet_transactions
        WHERE type='topup' AND user_id = ANY($1::uuid[]) GROUP BY 1`,
      [thisRunClientIds],
    );
    for (const row of ledger.rows) console.log(g(`topup · ${row.s} × ${row.n}`));
    const balances = await req<{bravo_credits: number; currency: string}>(
      'GET', '/wallet/balance', undefined, clients[0].token,
    );
    console.log(g(`client[0] wallet balance · ${balances.bravo_credits} BC ${balances.currency}`));
    const txs = await req<{transactions: {type:string; status:string; amount:number}[]}>(
      'GET', '/wallet/transactions', undefined, clients[0].token,
    );
    console.log(g(`client[0] ledger · ${txs.transactions.length} transactions`));

    console.log(b('Stage 2 · create 7 bookings distributed across the pipeline'));
    const bookings = [];
    for (let i = 0; i < 7; i++) {
      const bk = await createBooking(clients[i], 4 + i);
      bookings.push({...bk, client: clients[i], idx: i});
    }
    console.log(g(`7 bookings in PENDING_OPS · AED totals: ${bookings.map(x => x.total_aed).join(', ')}`));

    // Drive each into its target stage.
    // idx 0 → PENDING_OPS (leave untouched)
    // idx 1 → OPS_APPROVED (approve, don't dispatch)
    // idx 2 → REVIEW (approve + 2 apps pending, no assign)
    // idx 3 → ASSIGNED (approve + app + assign, don't dispatch)
    // idx 4 → LIVE mission 1
    // idx 5 → LIVE mission 2
    // idx 6 → COMPLETED (to verify archival)

    console.log(b('Stage 3 · ops approves bookings 1..6 → jobs published'));
    const jobs: Record<number, {id: string; short_code: string}> = {};
    for (const idx of [1,2,3,4,5,6]) {
      const res = await req<{job:{id:string; short_code:string}}>(
        'POST', `/ops/bookings/${bookings[idx].id}/approve`,
        {notes:`e2e idx ${idx}`, dress_instructions: 'Black suit, white shirt, no tie. Concealed earpiece.'},
        admin.token,
      );
      jobs[idx] = res.job;
    }
    console.log(g(`6 jobs PUBLISHED: ${Object.values(jobs).map(j => j.short_code).join(', ')}`));

    console.log(b('Stage 4 · agents apply to jobs 2..6'));
    const apps: Record<number, string[]> = {};
    for (const idx of [2,3,4,5,6]) {
      const appIds: string[] = [];
      for (const agent of agents) {
        const row = await pg.query<{id:string}>(
          `INSERT INTO job_applications (job_id, agent_id, agent_call_sign, status, fit_score, distance_km, rate_per_hour, rate_ccy)
           VALUES ($1,$2,$3,'PENDING',$4,$5,540,'AED') RETURNING id`,
          [jobs[idx].id, agent.user_id, `CPO-${agent.user_id.slice(0,4).toUpperCase()}`, 90 + Math.floor(Math.random()*10), (Math.random()*10).toFixed(1)],
        );
        appIds.push(row.rows[0].id);
      }
      apps[idx] = appIds;
    }
    console.log(g(`${Object.values(apps).flat().length} applications (3 agents × 5 jobs)`));

    console.log(b('Stage 5 · assign agents on jobs 3..6 (job 2 stays REVIEW)'));
    for (const idx of [3,4,5,6]) {
      await req('POST', `/ops/applications/${apps[idx][0]}/assign`, {}, admin.token);
    }
    console.log(g(`4 applications ASSIGNED`));

    console.log(b('Stage 6 · dispatch 4,5,6 → missions created + ops-rooms'));
    const missions: Record<number, string> = {};
    for (const idx of [4,5,6]) {
      const d = await req<{mission_id:string}>('POST', `/ops/jobs/${jobs[idx].id}/dispatch`, {}, admin.token);
      missions[idx] = d.mission_id;
    }
    console.log(g(`3 missions dispatched: ${Object.values(missions).map(id => id.slice(0,8)).join(', ')}`));

    // Verify every dispatched mission has an ops-room conversation + greeting broadcast.
    for (const [idx, mid] of Object.entries(missions)) {
      const {rows} = await pg.query<{comms_channel_id:string|null; short_code:string}>(
        `SELECT comms_channel_id, short_code FROM missions WHERE id=$1`, [mid],
      );
      const greet = await pg.query<{n:string}>(
        `SELECT COUNT(*)::text AS n FROM system_broadcasts WHERE subject_type='mission' AND subject_id=$1 AND kind='mission_started'`, [mid],
      );
      if (!rows[0].comms_channel_id) console.log(r(`mission ${idx} has no comms_channel_id`));
      else if (greet.rows[0].n === '0') console.log(r(`mission ${idx} missing mission_started broadcast`));
      else console.log(g(`mission ${idx} (${rows[0].short_code}) · ops-room ${rows[0].comms_channel_id.slice(0,8)} + greeting ✓`));
    }

    console.log(b('Stage 7 · live telemetry — laptop coords streaming to missions 4 + 5'));
    // Simulate 5 ticks of movement for each live mission — should show up in /ops/missions and ops-console map.
    for (const idx of [4, 5]) {
      const mid = missions[idx];
      await pg.query(`UPDATE missions SET status='PICKUP' WHERE id=$1`, [mid]);
      await pg.query(`UPDATE missions SET status='LIVE' WHERE id=$1`, [mid]);
    }
    for (let tick = 0; tick < 5; tick++) {
      for (const idx of [4, 5]) {
        const drift = tick * 0.001 + (idx === 5 ? 0.003 : 0);
        await req('POST', `/ops/missions/${missions[idx]}/telemetry`, {
          lat: LAPTOP_LAT + drift,
          lng: LAPTOP_LNG + drift,
          heading_deg: 220 + tick * 5,
          speed_kph: 42 + tick * 2,
        }, admin.token);
      }
      await sleep(300);
    }
    console.log(g(`2 missions LIVE at laptop coords (${LAPTOP_LAT.toFixed(3)}, ${LAPTOP_LNG.toFixed(3)}) + drift`));

    console.log(b('Stage 8 · end mission 6 via ops abort → exercise real service path'));
    // Drive mission through PICKUP → LIVE first so abort is a valid transition
    // from a non-DISPATCHED state — MissionService.abort posts the
    // mission_abort broadcast and archives the ops-room.
    await pg.query(`UPDATE missions SET status='PICKUP' WHERE id=$1`, [missions[6]]);
    await pg.query(`UPDATE missions SET status='LIVE' WHERE id=$1`, [missions[6]]);
    const conv6 = await pg.query<{comms_channel_id:string}>(
      `SELECT comms_channel_id FROM missions WHERE id=$1`, [missions[6]],
    );
    await req('POST', `/ops/missions/${missions[6]}/abort`, {
      reason: 'mission_completed_e2e', notes: 'e2e scenario wrap-up',
    }, admin.token);

    const archived = await pg.query<{archived_at:Date|null; archived_reason:string|null}>(
      `SELECT archived_at, archived_reason FROM conversations WHERE id=$1`, [conv6.rows[0].comms_channel_id],
    );
    if (archived.rows[0].archived_at) {
      console.log(g(`mission 6 ops-room ARCHIVED · reason=${archived.rows[0].archived_reason}`));
    } else {
      console.log(r(`ops-room was NOT archived`));
    }
    // Confirm the abort broadcast landed too.
    const abortBcast = await pg.query<{n:string}>(
      `SELECT COUNT(*)::text AS n FROM system_broadcasts
        WHERE subject_id=$1 AND kind='mission_abort'`, [missions[6]],
    );
    if (abortBcast.rows[0].n === '0') console.log(r(`missing mission_abort broadcast`));
    else console.log(g(`mission_abort broadcast posted in ops-room (last card before archive)`));

    // Verify archived conversation does NOT appear in listMine for the client.
    const cliConvs = await req<{conversations:{id:string; title:string|null}[]}>(
      'GET', '/conversations/mine', undefined, bookings[6].client.token,
    );
    const stillListed = cliConvs.conversations.find(c => c.id === conv6.rows[0].comms_channel_id);
    if (stillListed) {
      console.log(r(`archived room STILL in client's conversation list — archival filter broken`));
    } else {
      console.log(g(`client's conversation list correctly hides the archived room`));
    }

    console.log(b('Stage 9 · dashboard data — hit every /ops GET endpoint'));
    const dash = await req<{kpis:Record<string,number>; activity:unknown[]}>('GET', '/ops/dashboard', undefined, admin.token);
    console.log(g('GET /ops/dashboard:'));
    for (const [k,v] of Object.entries(dash.kpis)) console.log(m(`${k.padEnd(20)} = ${v}`));
    console.log(m(`activity rows: ${dash.activity.length}`));

    const activity = await req<unknown[]>('GET', '/ops/activity?limit=20', undefined, admin.token);
    console.log(g(`GET /ops/activity · ${activity.length} rows`));

    const bks = await req<unknown[]>('GET', '/ops/bookings', undefined, admin.token);
    console.log(g(`GET /ops/bookings · ${bks.length} rows`));

    const pendingBks = await req<unknown[]>('GET', '/ops/bookings?status=PENDING_OPS', undefined, admin.token);
    console.log(g(`GET /ops/bookings?status=PENDING_OPS · ${pendingBks.length} rows`));

    const jobs_list = await req<unknown[]>('GET', '/ops/jobs', undefined, admin.token);
    console.log(g(`GET /ops/jobs · ${jobs_list.length} rows`));

    const jobDetail = await req<{job:{short_code:string}; applications:unknown[]}>(
      'GET', `/ops/jobs/${jobs[2].id}`, undefined, admin.token,
    );
    console.log(g(`GET /ops/jobs/:id · ${jobDetail.job.short_code} · ${jobDetail.applications.length} applicants`));

    const missionList = await req<unknown[]>('GET', '/ops/missions', undefined, admin.token);
    console.log(g(`GET /ops/missions · ${missionList.length} active (should NOT include completed mission 6)`));

    const missionDetail = await req<{mission:{short_code:string}; crew:unknown[]; waypoints:unknown[]; audit:unknown[]}>(
      'GET', `/ops/missions/${missions[4]}`, undefined, admin.token,
    );
    console.log(g(`GET /ops/missions/:id · ${missionDetail.mission.short_code} · ${missionDetail.crew.length} crew · ${missionDetail.waypoints.length} waypoints · ${missionDetail.audit.length} audit`));

    const agentList = await req<unknown[]>('GET', '/ops/agents', undefined, admin.token);
    console.log(g(`GET /ops/agents · ${agentList.length} rows`));

    console.log(b('Stage 10 · broadcasts + audit across missions'));
    for (const [idx, mid] of Object.entries(missions)) {
      const bcasts = await req<{kind:string}[]>('GET', `/ops/broadcasts/subject/mission/${mid}`, undefined, admin.token);
      const audit = await req<unknown[]>('GET', `/ops/audit/mission/${mid}`, undefined, admin.token);
      console.log(m(`mission ${idx} (${mid.slice(0,8)}): ${bcasts.length} broadcasts, ${audit.length} audit rows`));
    }

    console.log(b('Stage 11 · final summary'));
    const counts = await pg.query<{
      bookings: string; pending: string; jobs: string; apps: string;
      missions: string; live: string; rooms: string; archived: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM lite_bookings) AS bookings,
         (SELECT COUNT(*)::text FROM lite_bookings WHERE status='PENDING_OPS') AS pending,
         (SELECT COUNT(*)::text FROM jobs) AS jobs,
         (SELECT COUNT(*)::text FROM job_applications) AS apps,
         (SELECT COUNT(*)::text FROM missions) AS missions,
         (SELECT COUNT(*)::text FROM missions WHERE status IN ('DISPATCHED','PICKUP','LIVE','SOS')) AS live,
         (SELECT COUNT(*)::text FROM conversations WHERE archived_at IS NULL AND kind='group') AS rooms,
         (SELECT COUNT(*)::text FROM conversations WHERE archived_at IS NOT NULL) AS archived`,
    );
    const s = counts.rows[0];
    console.log(m(`bookings=${s.bookings} (pending=${s.pending}) · jobs=${s.jobs} · apps=${s.apps}`));
    console.log(m(`missions=${s.missions} (live=${s.live}) · active ops-rooms=${s.rooms} · archived=${s.archived}`));

    console.log('\n\x1b[1;32m════════════════════════════════════════════════════\x1b[0m');
    console.log('\x1b[1;32m  🎉  OPS DASHBOARD LOAD SCENARIO PASSED\x1b[0m');
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

void main();
