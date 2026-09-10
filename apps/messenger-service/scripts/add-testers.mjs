// One-off: add testers to Firebase App Distribution + join them to a group
// (joining a group triggers the invitation email). Auths with the same
// service-account JSON the Gradle upload uses. Run from apps/messenger-service
// so google-auth-library resolves.
//
//   node scripts/add-testers.mjs <groupAlias> <email> [<email> ...]
//
// Env: GOOGLE_APPLICATION_CREDENTIALS=<path to SA json>
import {GoogleAuth} from 'google-auth-library';

// App Distribution REST uses the PROJECT NUMBER in the resource path,
// not the alphanumeric project id. From the app id 1:150226560672:android:…
const PROJECT_ID = '150226560672';
const groupAlias = process.argv[2];
const emails = process.argv.slice(3);
if (!groupAlias || emails.length === 0) {
  console.error('usage: node add-testers.mjs <groupAlias> <email...>');
  process.exit(2);
}

const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});

async function main() {
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;
  const H = {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'};
  const base = `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT_ID}`;

  // 1. Create the testers (idempotent — re-adding an existing tester is a no-op).
  const addRes = await fetch(`${base}/testers:batchAdd`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({emails}),
  });
  const addBody = await addRes.text();
  console.log(`[batchAdd] HTTP ${addRes.status} ${addBody.slice(0, 400)}`);
  if (!addRes.ok) process.exit(1);

  // 2. Join them to the group — this is what sends the invitation email.
  // The batchJoin verb hangs off the GROUP resource itself (colon), not a
  // /testers subcollection, and takes `emails`.
  const joinRes = await fetch(
    `${base}/groups/${encodeURIComponent(groupAlias)}:batchJoin`,
    {method: 'POST', headers: H, body: JSON.stringify({emails})},
  );
  const joinBody = await joinRes.text();
  console.log(`[batchJoin ${groupAlias}] HTTP ${joinRes.status} ${joinBody.slice(0, 400)}`);
  if (!joinRes.ok) process.exit(1);

  console.log(`DONE: added ${emails.length} tester(s) to group "${groupAlias}"`);
}

main().catch(e => { console.error('ERR', e?.message ?? e); process.exit(1); });
