/**
 * Department-channel E2EE provisioning — shared, idempotent helper.
 *
 * A department channel is just metadata until an admin device bootstraps its
 * Signal group (group_conversation_id). This function does exactly that, REUSING
 * the existing crypto primitives unchanged — `runtime.createGroupChat`
 * (makeNewGroup + signed `create` fan-out) + `departmentApi.registerGroup`
 * (first-writer-wins). The group master key NEVER reaches the server; only the
 * conversation id is registered.
 *
 * Why this exists (audit D1-a/f/g, D3-c): provisioning used to be an inline
 * side-effect of tapping a channel, which (a) only ran on the channel list, (b)
 * swallowed errors into a permanent silent "not yet active", and (c) had no path
 * from the create flow. Centralising it lets BOTH the create flow (eager) and the
 * first-open fallback share one tested, honest path.
 *
 * Idempotent: returns the canonical id immediately if already provisioned.
 */
import {departmentApi} from '@services/api';
import {getMessengerRuntime} from '@/modules/messenger/runtime';
import {useMessengerStore} from '@/modules/messenger/store/messengerStore';

export type ProvisionResult =
  | {status: 'ok'; groupConversationId: string}
  | {status: 'already'; groupConversationId: string}
  | {status: 'needs_members'} // can't form a group with only the org account yet
  | {status: 'failed'; message: string};

// SAME-DEVICE dedup (both reviewers, round 1): the Q3 self-heal sweep and a
// concurrent channel tap used to run createGroupChat TWICE for one channel —
// two local conversations, two master keys, one permanent orphan row in the
// encrypted store. Concurrent callers now share one in-flight promise.
// (Cross-DEVICE races remain governed by registerGroup's first-writer-wins +
// the adopt-canonical refetch below.)
const inFlight = new Map<string, Promise<ProvisionResult>>();

export async function ensureChannelProvisioned(
  channelId: string,
  channelName: string,
  currentGroupId: string | null | undefined,
): Promise<ProvisionResult> {
  if (currentGroupId) {
    return {status: 'already', groupConversationId: currentGroupId};
  }
  const running = inFlight.get(channelId);
  if (running) {return running;}
  const work = provisionOnce(channelId, channelName);
  inFlight.set(channelId, work);
  try {
    return await work;
  } finally {
    inFlight.delete(channelId);
  }
}

async function provisionOnce(
  channelId: string,
  channelName: string,
): Promise<ProvisionResult> {
  try {
    const {data} = await departmentApi.listMembers(channelId);
    const memberIds = data.members.map(m => m.user_id).filter(Boolean);
    const rt = await getMessengerRuntime('production');
    // D1-d — allowZeroDelivered: provision (register a STABLE group id) even if no member could
    // be reached yet (they have no Signal keys). Without this, a 0-delivered create threw BEFORE
    // registerGroup ran, so the channel re-forged a fresh master key on every open. Members are
    // keyed in later via add-intents / self-heal.
    // Founder QA 2026-08-08 — allowSolo: a fresh workspace's channels have ONLY
    // the admin, and the old "needs a second member" refusal left every one of
    // them Inactive and unopenable from the very screen meant to open them.
    // A solo group is valid: later members ride the same add-intent/rekey path.
    const {conversationId} = await rt.createGroupChat({
      name: channelName, members: memberIds, allowZeroDelivered: true, allowSolo: true,
    });
    /**
     * B-593 — RECORD IT THE MOMENT IT EXISTS.
     *
     * This is the only place in the app that holds a channel id and the local
     * conversation it just minted in the same hand, and it used to drop the
     * link on the floor. Every value in the dept registry came from a
     * `listChannels` RESPONSE instead, so whether a channel stayed out of the
     * Messenger list was decided by a race between this local write and a
     * network round trip — and the admin self-heal sweep
     * (`DepartmentChannelsScreen`) provisions `#broadcast` WITHOUT ever
     * navigating to the channel, so the one writer that ran at mint time
     * (`setDeptChannelGroup`, on DepartmentChat focus) was skipped entirely.
     * That is the founder's "I can see a broadcast in the messenger list".
     *
     * Recorded BEFORE `registerGroup`, not after: an interrupted provision
     * (app killed, network drop) otherwise leaves a local group row that no
     * registry will ever name — unhideable forever.
     */
    useMessengerStore.getState().rememberDeptConversation(conversationId);
    await departmentApi.registerGroup(channelId, conversationId);
    // First-writer-wins: a racing admin may already have registered a different
    // group id. Re-fetch the CANONICAL id and adopt it so we never navigate into
    // a fork only we can see.
    let groupConversationId = conversationId;
    try {
      const {data: fresh} = await departmentApi.listChannels();
      groupConversationId =
        fresh.channels.find(c => c.id === channelId)?.group_conversation_id ?? conversationId;
    } catch {
      /* keep our freshly-minted id on a transient refetch failure */
    }
    // …and the CANONICAL id too, when a racing admin won `registerGroup`. Our
    // losing fork row stays on this device (a redelivered `create` re-mints it,
    // so deleting it does not stick), and the registry is additive by design —
    // so recording BOTH is what makes the orphan permanently hideable.
    if (groupConversationId !== conversationId) {
      useMessengerStore.getState().rememberDeptConversation(groupConversationId);
    }
    return {status: 'ok', groupConversationId};
  } catch (e) {
    const message = (e as Error)?.message ?? '';
    // The "no other member" throw is an expected state, not a failure: the admin
    // just needs to add a CPO first. Surface it distinctly so the UI can guide,
    // instead of a silent permanent "not yet active".
    if (/at least one other member/i.test(message)) {
      return {status: 'needs_members'};
    }
    return {status: 'failed', message: message || 'Could not set up channel encryption.'};
  }
}
