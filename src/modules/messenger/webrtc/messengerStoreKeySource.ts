/**
 * Mobile-side adapter that exposes the local `useMessengerStore.groups`
 * slice as a platform-agnostic `GroupKeySource` (defined in
 * messenger-core). `useGroupCall` constructs a `GroupCallEncryption`
 * and wires this in as the keySource.
 *
 * Kept separate from the platform-agnostic orchestrator so that the
 * orchestrator can be tested in messenger-core's Node-mode jest
 * project without dragging in the messengerStore + SQLCipher graph.
 */

import type {GroupKeySource} from '@bravo/messenger-core';
import {useMessengerStore} from '../store/messengerStore';
import {resolveGroupForCall} from '../runtime/callKeyRegistry';

// B-124 root fix — lookups resolve through the callKeyRegistry: an
// escalated-call handle (`direct:<host>` / the origin 1:1 id) maps to the
// minted 'Call' state's own id, so chat-bearing ids never need to hold key
// material. Real group ids pass through unchanged (no registry entry). The
// subscribe callback re-resolves on EVERY store change, so a re-escalation
// that re-points the mapping mid-call rotates the cryptor onto the new key
// exactly like the old alias-overwrite did.
export const messengerStoreKeySource: GroupKeySource = {
  current(conversationId) {
    const s = resolveGroupForCall(useMessengerStore.getState().groups, conversationId);
    if (!s?.masterKeyB64) {return null;}
    return {masterKeyB64: s.masterKeyB64, epoch: s.epoch};
  },
  subscribe(conversationId, listener) {
    let lastKey   = '';
    let lastEpoch = -1;
    return useMessengerStore.subscribe((state) => {
      const g = resolveGroupForCall(state.groups, conversationId);
      if (!g?.masterKeyB64) {return;}
      if (g.masterKeyB64 === lastKey && g.epoch === lastEpoch) {return;}
      lastKey   = g.masterKeyB64;
      lastEpoch = g.epoch;
      listener({masterKeyB64: g.masterKeyB64, epoch: g.epoch});
    });
  },
};
