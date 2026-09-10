import {GoogleAuth} from 'google-auth-library';
const PROJECT = '150226560672';
const auth = new GoogleAuth({scopes: ['https://www.googleapis.com/auth/cloud-platform']});
const client = await auth.getClient();
const token = (await client.getAccessToken()).token;
const res = await fetch(
  `https://firebaseappdistribution.googleapis.com/v1/projects/${PROJECT}/groups`,
  {headers: {Authorization: `Bearer ${token}`}},
);
console.log(`HTTP ${res.status}`);
console.log(await res.text());
