import { KeyHelper } from '@privacyresearch/libsignal-protocol-typescript';
import { InMemoryProtocolStore, buildOwnPreKeyBundle, installIdentity, type PreKeyBundle, type SessionAddress } from '@bravo/messenger-core';

/**
 * Spin up a fully-initialized store for a single test participant:
 * identity key, signed pre-key, and one one-time pre-key (id = 1).
 * Returns everything the other side needs to start a session.
 */
export async function makeParty(address: SessionAddress): Promise<{
  store: InMemoryProtocolStore;
  address: SessionAddress;
  bundle: PreKeyBundle;
}> {
  const store = new InMemoryProtocolStore();
  await installIdentity(store, { preKeyCount: 1 });
  // installIdentity always emits pre-key ids starting at 1
  const bundle = await buildOwnPreKeyBundle(store, address, 1, 1);
  return { store, address, bundle };
}

export function _unused() {
  // keep jest happy if it tries to treat this file as a suite
  return KeyHelper;
}
