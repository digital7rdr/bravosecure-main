/**
 * Conversation membership-intent drain (admin device) — RS-02.
 *
 * SECURITY (E2EE stop-condition): the server holds NO group key, so a
 * conversation add/remove-member through the REST endpoints can only record
 * the metadata change + a pending intent. THIS function — run on a
 * conversation-admin's device — drains those intents and performs the
 * sanctioned, rekeying runtime actions:
 *   - add    → runtime.addGroupMember     (wraps planAddAndRekey)
 *   - remove → runtime.removeGroupMember  (wraps planRemoveAndRekey)
 * then acks. Until this runs, a removed member still holds the old master
 * key — drain promptly (messenger home focus).
 *
 * Mirrors orgWorkspace/membershipIntents.ts (department channels) and
 * dispatchRoomIntents.ts (booking Ops Rooms); for conversations the group id
 * IS the conversation id, so no extra mapping is needed. The runtime methods
 * already enforce admin authorisation, the per-group lock, and the
 * remove-then-rekey ordering; this layer only sequences intents. It never
 * touches key material.
 */
import {conversationApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';

export interface DrainResult {
  processed: number;
  skipped: number;   // intents this device can't act on (no local group state)
  failed: number;
}

// Coalesce concurrent drains (same D5-b rationale as the channel drain).
let inFlight: Promise<DrainResult> | null = null;

export function drainConversationIntents(): Promise<DrainResult> {
  if (inFlight) {return inFlight;}
  inFlight = drainOnce().finally(() => { inFlight = null; });
  return inFlight;
}

async function drainOnce(): Promise<DrainResult> {
  const result: DrainResult = {processed: 0, skipped: 0, failed: 0};

  const {data} = await conversationApi.listMembershipIntents();
  if (!data.intents.length) {return result;}

  const runtime = await getMessengerRuntime('production');

  for (const intent of data.intents) {
    try {
      if (intent.action === 'remove') {
        if (!runtime.removeGroupMember) {result.skipped++; continue;}
        await runtime.removeGroupMember({
          groupId: intent.conversation_id,
          removedUserId: intent.member_user_id,
        });
      } else {
        if (!runtime.addGroupMember) {result.skipped++; continue;}
        // Phase-1 peers live on signal deviceId=1 (multi-device lands later).
        await runtime.addGroupMember({
          groupId: intent.conversation_id,
          newMember: {userId: intent.member_user_id, deviceId: 1},
        });
      }
      // Only ack AFTER the rekey broadcast succeeded (at-least-once).
      await conversationApi.ackMembershipIntent(intent.id);
      result.processed++;
    } catch (e) {
      const msg = (e as Error)?.message ?? '';
      // Idempotent no-op — the member is already in/out of the group. The
      // intent is satisfied; ack it so it stops churning on every drain.
      if (/already a member of|is not a member of/.test(msg)) {
        await conversationApi.ackMembershipIntent(intent.id).catch(() => {});
        result.processed++;
        continue;
      }
      // This device has no local state for the group — it can't rekey.
      // Defer (skip, do NOT ack) so the device holding the state drains it.
      if (/unknown group/.test(msg)) {
        result.skipped++;
        continue;
      }
      // Genuine retryable failure — leave pending for the next drain.
      result.failed++;
    }
  }
  return result;
}
