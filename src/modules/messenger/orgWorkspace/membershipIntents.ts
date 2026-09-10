/**
 * Org chat workspace — membership-intent drain (admin device).
 *
 * SECURITY (E2EE stop-condition): the server holds NO group key, so it cannot
 * rekey on its own. When the org adds/removes a CPO from a channel, the server
 * records a metadata change + a pending intent. THIS function — run on a
 * channel-admin's device — drains those intents and performs the sanctioned,
 * rekeying runtime actions:
 *   - add    → runtime.addGroupMember     (wraps planAddAndRekey)
 *   - remove → runtime.removeGroupMember  (wraps planRemoveAndRekey)
 * then acks the intent so it isn't replayed. Until this runs, a removed CPO
 * still holds the old master key — so drain it promptly (on app focus / when
 * the department workspace opens).
 *
 * The runtime methods already enforce admin authorisation, the per-group lock,
 * and the remove-then-rekey ordering; this layer only sequences intents and
 * maps add/remove → the right call. It never touches key material.
 */
import {departmentApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';

export interface DrainResult {
  processed: number;
  skipped: number;   // intents for not-yet-provisioned groups
  failed: number;
}

// D5-b — coalesce concurrent drains. The channels list (on focus) and ChannelMembersScreen
// (on add) can both trigger a drain at once; without this they'd run two overlapping rekey
// loops over the same intents. A second caller awaits the in-flight pass instead.
let inFlight: Promise<DrainResult> | null = null;

export function drainMembershipIntents(): Promise<DrainResult> {
  if (inFlight) {return inFlight;}
  inFlight = drainOnce().finally(() => { inFlight = null; });
  return inFlight;
}

async function drainOnce(): Promise<DrainResult> {
  const result: DrainResult = {processed: 0, skipped: 0, failed: 0};

  const {data} = await departmentApi.listMembershipIntents();
  if (!data.intents.length) {return result;}

  const runtime = await getMessengerRuntime('production');

  for (const intent of data.intents) {
    // A channel whose Signal group hasn't been bootstrapped yet has no epoch
    // to rekey — leave the intent pending; it'll apply once the group exists.
    if (!intent.group_conversation_id) {
      result.skipped++;
      continue;
    }
    try {
      if (intent.action === 'remove') {
        if (!runtime.removeGroupMember) {result.skipped++; continue;}
        await runtime.removeGroupMember({
          groupId: intent.group_conversation_id,
          removedUserId: intent.member_user_id,
        });
      } else {
        if (!runtime.addGroupMember) {result.skipped++; continue;}
        // Phase-1 peers live on signal deviceId=1 (multi-device lands later).
        await runtime.addGroupMember({
          groupId: intent.group_conversation_id,
          newMember: {userId: intent.member_user_id, deviceId: 1},
        });
      }
      // Only ack AFTER the rekey broadcast succeeded — a failed rekey leaves
      // the intent pending so the next drain retries it (at-least-once).
      await departmentApi.ackMembershipIntent(intent.id);
      result.processed++;
    } catch (e) {
      // NOTE: this only decides whether an intent is acked / skipped / retried — the rekey
      // operations themselves (addGroupMember/removeGroupMember) are untouched. No key
      // material, epoch, or recipient set changes here.
      const msg = (e as Error)?.message ?? '';
      // D2-g — idempotent no-op: the member is already in/out of the group (e.g. a member who
      // was included at creation, or a duplicate intent). The intent is already satisfied, so
      // ACK it instead of leaving it pending to churn on every future drain.
      if (/already a member of|is not a member of/.test(msg)) {
        await departmentApi.ackMembershipIntent(intent.id).catch(() => {});
        result.processed++;
        continue;
      }
      // D2-e — this device has no local state for the group ("unknown group"): it isn't the
      // provisioning/owner device, so it cannot rekey. Defer cleanly (skip, do NOT ack) so the
      // device that holds the group state drains it — instead of counting a permanent failure.
      if (/unknown group/.test(msg)) {
        result.skipped++;
        continue;
      }
      // A genuine, retryable failure — leave the intent pending for the next drain.
      result.failed++;
    }
  }
  return result;
}
