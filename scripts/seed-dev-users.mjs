#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Seed dev users into auth-service for messenger testing.
 *
 * REQUIRES auth-service running locally with OTP_DEV_BYPASS=true so
 * register-verify always accepts the stub code "000000" (configure via
 * apps/auth-service/.env). In production this flag MUST be false.
 *
 * Hits the existing /auth/register → /auth/register-verify flow for
 * Alice / Bob / Carol. Prints their userId + access-token so you can
 *   (a) paste the UUIDs into src/modules/messenger/dev/devContacts.ts
 *   (b) use the JWTs in scripts/e2e-messenger-smoke.mjs
 *
 * Usage:
 *   AUTH_BASE_URL=http://127.0.0.1:3001 node scripts/seed-dev-users.mjs
 */

const AUTH = process.env.AUTH_BASE_URL ?? 'http://127.0.0.1:3001';
const STUB_OTP = process.env.STUB_OTP ?? '000000';

const DEV_USERS = [
  {fullName: 'Alice (Dev)', phoneE164: '+15550000001', password: 'alice-dev-password-123!', email: 'alice.dev@bravosecure.test'},
  {fullName: 'Bob (Dev)',   phoneE164: '+15550000002', password: 'bob-dev-password-123!',   email: 'bob.dev@bravosecure.test'},
  {fullName: 'Carol (Dev)', phoneE164: '+15550000003', password: 'carol-dev-password-123!', email: 'carol.dev@bravosecure.test'},
];

async function register(u) {
  const res = await fetch(`${AUTH}/auth/register`, {
    method:  'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      email:           u.email,
      password:        u.password,
      displayName:     u.fullName,
      phoneE164:       u.phoneE164,
      role:            'individual',
      subscriptionTier:'lite',
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    // Already registered is fine — go straight to login.
    if (res.status === 409 || t.includes('already')) return {alreadyExists: true};
    throw new Error(`register ${u.email} failed: ${res.status} ${t}`);
  }
  return {alreadyExists: false};
}

async function registerVerify(u) {
  const res = await fetch(`${AUTH}/auth/register/verify`, {
    method:  'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      email:           u.email,
      password:        u.password,
      displayName:     u.fullName,
      phoneE164:       u.phoneE164,
      role:            'individual',
      subscriptionTier:'lite',
      code:            STUB_OTP,
      deviceId:        `dev-seed-${u.fullName.replace(/\s+/g, '-')}`,
      platform:        'android',
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`register-verify ${u.email} failed: ${res.status} ${t}`);
  }
  return res.json();
}

async function login(u) {
  const res = await fetch(`${AUTH}/auth/login`, {
    method:  'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({email: u.email, password: u.password}),
  });
  if (!res.ok) throw new Error(`login ${u.email} failed: ${res.status}`);
  const {userId} = await res.json();
  const vRes = await fetch(`${AUTH}/auth/verify`, {
    method:  'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({userId, code: STUB_OTP, deviceId: `dev-seed-${u.fullName.replace(/\s+/g, '-')}`, platform: 'android'}),
  });
  if (!vRes.ok) throw new Error(`verify ${u.email} failed: ${vRes.status}`);
  return vRes.json();
}

async function main() {
  console.log(`→ Seeding ${DEV_USERS.length} dev users against ${AUTH}`);
  console.log(`  (requires OTP_DEV_BYPASS=true on auth-service)\n`);

  const results = [];
  for (const u of DEV_USERS) {
    console.log(`• ${u.fullName}`);
    try {
      const reg = await register(u);
      let auth;
      if (reg.alreadyExists) {
        auth = await login(u);
        console.log(`  (already existed — signed in)`);
      } else {
        auth = await registerVerify(u);
        console.log(`  registered + verified`);
      }
      const userId = auth?.user?.id ?? auth?.userId ?? auth?.id ?? '(unknown — check response)';
      const accessToken = auth?.accessToken ?? auth?.tokens?.accessToken ?? '(no token in response)';
      console.log(`  userId:      ${userId}`);
      console.log(`  accessToken: ${accessToken.slice(0, 28)}...`);
      results.push({name: u.fullName, userId, accessToken});
    } catch (e) {
      console.error(`  FAIL: ${e.message}`);
      results.push({name: u.fullName, error: e.message});
    }
  }

  const ok = results.filter(r => !r.error);
  console.log(`\n${ok.length}/${results.length} users ready.\n`);

  if (ok.length > 0) {
    console.log(`Paste these into src/modules/messenger/dev/devContacts.ts:`);
    for (const r of ok) {
      console.log(`  ${r.name.padEnd(16)} → '${r.userId}'`);
    }
    console.log(`\nFor scripts/e2e-messenger-smoke.mjs:`);
    for (const r of ok) {
      const envName = r.name.split(' ')[0].toUpperCase();
      console.log(`  export ${envName}_JWT='${r.accessToken}'`);
    }
  }
}

main().catch(e => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
