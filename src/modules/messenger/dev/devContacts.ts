/**
 * Dev-only contacts for local testing.
 *
 * Populated by `scripts/seed-dev-users.mjs` which hits auth-service's
 * /auth/register flow for each of Alice / Bob / Carol with the same
 * passwords listed here. The resulting `userId` values from Postgres
 * will be whatever UUIDs auth-service mints — fill those in below
 * after running the seeder (the seeder prints them).
 *
 * Production builds MUST NOT show these contacts. `isDevMode()` guards
 * every UI that imports from here.
 */

import type {SessionAddress} from '@bravo/messenger-core';

export interface DevContact {
  /** userId as stored in auth-service (UUID). Fill in after running seeder. */
  userId:      string;
  /** Bravo display name. */
  name:        string;
  /** E.164 phone used at registration. */
  phoneE164:   string;
  /** Dev-only password (OTP_DEV_BYPASS must be true in auth-service). */
  password:    string;
  /** Visual identifier for the UI. */
  initials:    string;
  /** Avatar bg color. */
  bg:          string;
  /** Signal device id — always 1 in Phase 1. */
  deviceId:    number;
}

/**
 * Default dev roster. Edit the `userId` values to match what the
 * seeder minted on your local auth-service.
 *
 *   node scripts/seed-dev-users.mjs
 *
 * Output looks like:
 *   Alice  userId=3c8a4f7d-...
 *   Bob    userId=91b2e5a0-...
 *   Carol  userId=0fd3c6b8-...
 */
export const DEV_CONTACTS: DevContact[] = [
  {
    userId:    '00c25919-7ba3-468a-8082-47db1c72ed8d',
    name:      'Alice (Dev)',
    phoneE164: '+15550000001',
    password:  'alice-dev-password-123!',
    initials:  'AL',
    bg:        '#7B5EA7',
    deviceId:  1,
  },
  {
    userId:    'cd9f8f73-1862-49f6-bb3f-ee0bc7f20cd8',
    name:      'Bob (Dev)',
    phoneE164: '+15550000002',
    password:  'bob-dev-password-123!',
    initials:  'BO',
    bg:        '#0E7490',
    deviceId:  1,
  },
  {
    userId:    'd545b3e1-9166-419f-b248-c31ec461bcb0',
    name:      'Carol (Dev)',
    phoneE164: '+15550000003',
    password:  'carol-dev-password-123!',
    initials:  'CA',
    bg:        '#065f46',
    deviceId:  1,
  },
];

export function devContactAddress(c: DevContact): SessionAddress {
  return {userId: c.userId, deviceId: c.deviceId};
}

export function isDevMode(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

/**
 * Filter out the currently-signed-in user so we don't show a chat
 * with ourselves in the contact picker.
 */
export function otherDevContacts(selfUserId?: string): DevContact[] {
  if (!isDevMode()) {return [];}
  return DEV_CONTACTS.filter(c =>
    c.userId !== 'REPLACE_WITH_SEEDED_UUID' && c.userId !== selfUserId,
  );
}
