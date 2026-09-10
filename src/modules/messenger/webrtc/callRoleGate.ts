/**
 * Pure role-gate helper for outgoing call launches.
 *
 * Lives outside launchCall.ts so unit tests can import it without
 * pulling react-native, the auth store, or the messenger store — the
 * `messenger-crypto` Jest project runs in node-env and rejects any
 * RN-bound module at import time.
 *
 * Why: CP Agents (role='agent') are dispatch-side operators and must
 * not place 1:1 calls to individual customers off their own initiative.
 * Documented flow is customer-initiates OR ops-dispatches. Group calls
 * and ops_channel conversations are part of the agent's normal workflow
 * (mission rooms, dispatch chans) and stay allowed.
 *
 * Returns null when allowed; returns a user-facing reason string when
 * blocked.
 */
export type ConversationType = 'direct' | 'group' | 'ops_channel';

export function blockReasonForOutgoingCall(
  role: string | undefined,
  conversationType: ConversationType | undefined,
  isGroup: boolean,
): string | null {
  if (role !== 'agent') {return null;}
  if (conversationType === 'ops_channel') {return null;}
  if (isGroup) {return null;}
  return 'CP Agents cannot start direct calls to customers. The customer or dispatch must initiate the call.';
}
