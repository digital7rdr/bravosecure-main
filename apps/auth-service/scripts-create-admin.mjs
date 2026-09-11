#!/usr/bin/env node
/**
 * Create or bind an ops-console admin.
 *
 *   node scripts-create-admin.mjs <phone> <password> <call_sign> [role] [displayName]
 *
 *   phone      e.g. +911234567890        (E.164)
 *   role       OPS | SUPERVISOR | ADMIN  (default SUPERVISOR)
 *
 * If a `users` row exists for that phone, we re-use it (and the password
 * you pass MUST match the one stored, or you'll just keep using the
 * existing one — we won't overwrite). If no user exists, we create one
 * with the given password (argon2 hashed) and kyc_status='approved'.
 *
 * Then we upsert an `admin_users` row binding that user_id to the
 * call_sign + role. Run again to update the role / display name.
 */
import {Client} from 'pg';
import argon2   from 'argon2';
import {randomUUID} from 'node:crypto';

const [, , phone, password, callSign, roleRaw, displayNameRaw] = process.argv;
if (!phone || !password || !callSign) {
  console.error('Usage: node scripts-create-admin.mjs <phone> <password> <call_sign> [role] [displayName]');
  process.exit(1);
}
const role = (roleRaw ?? 'SUPERVISOR').toUpperCase();
if (!['OPS', 'SUPERVISOR', 'ADMIN'].includes(role)) {
  console.error(`Bad role "${role}" — must be OPS, SUPERVISOR, or ADMIN`);
  process.exit(1);
}
const displayName = displayNameRaw ?? `Ops ${callSign}`;

// DATABASE_URL when set (production: the same value auth-service runs with),
// otherwise the local `supabase start` Postgres — so the one script works on
// a laptop AND inside the bravo-auth container.
const pg = new Client({connectionString: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'});
await pg.connect();

// 1) Find or create users row
const {rows: existing} = await pg.query(
  `SELECT id, password_hash FROM public.users WHERE phone_e164 = $1 AND deleted_at IS NULL`,
  [phone],
);

let userId;
if (existing.length > 0) {
  userId = existing[0].id;
  console.log(`Found existing user ${userId} for ${phone} (password kept as-is)`);
} else {
  const hash = await argon2.hash(password, {
    type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1,
  });
  const id = randomUUID();
  // `users.role` is restricted to individual | agent | service_provider since
  // 20260707120000_tighten_users_role_taxonomy. Ops privilege is NOT a users.role
  // value — it is the admin_users row bound below (see ops/admin.guard.ts).
  await pg.query(
    `INSERT INTO public.users
       (id, email, phone_e164, display_name, role, subscription_tier, password_hash, kyc_status)
     VALUES ($1, $2, $3, $4, 'individual', 'lite', $5, 'approved')`,
    [id, `${callSign.toLowerCase()}@bravo.local`, phone, displayName, hash],
  );
  userId = id;
  console.log(`Created user ${userId} for ${phone}`);
}

// 2) Upsert admin_users — first try to bind by call_sign, else by user_id
const {rowCount: bound} = await pg.query(
  `UPDATE admin_users
      SET user_id = $1, role = $2, display_name = $3, phone_e164 = $4, active = TRUE
    WHERE call_sign = $5`,
  [userId, role, displayName, phone, callSign],
);
if (bound === 0) {
  await pg.query(
    `INSERT INTO admin_users (user_id, display_name, call_sign, role, region, phone_e164)
     VALUES ($1, $2, $3, $4, 'AE', $5)
     ON CONFLICT (user_id) DO UPDATE
       SET call_sign = EXCLUDED.call_sign,
           role      = EXCLUDED.role,
           phone_e164= EXCLUDED.phone_e164,
           active    = TRUE`,
    [userId, displayName, callSign, role, phone],
  );
}

await pg.end();
console.log(`\nAdmin ${callSign} (${role}) bound to user ${userId}.`);
console.log(`Login at http://localhost:3002/login with:`);
console.log(`  phone:    ${phone}`);
console.log(`  password: ${password}`);
console.log(`  OTP:      any 4-8 digits (OTP_DEV_BYPASS=true in this env)`);
