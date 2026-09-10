/**
 * Ops-console-only helper. Builds the upload DTO for /auth/keys/upload
 * by walking the protocol store. Mobile builds the same DTO inside its
 * productionRuntime; the shape is ops-specific (server endpoint format),
 * so it stays here rather than going into @bravo/messenger-core.
 */
import {toBase64, type CryptoStore, StoreError} from '@bravo/messenger-core';

export async function exportPublicBundle(
  store: CryptoStore,
  preKeyCount = 100,
): Promise<{
  registrationId:  number;
  identityKey:     string;
  signedPrekeyId:  number;
  signedPrekey:    string;
  signedPrekeySig: string;
  oneTimePrekeys:  Array<{keyId: number; publicKey: string}>;
}> {
  const reg = await store.getLocalRegistrationId();
  const id  = await store.getIdentityKeyPair();
  const spk = await store.loadSignedPreKey(1);
  if (!spk?.signature) throw new StoreError('signed pre-key 1 missing or unsigned');
  const oneTime: Array<{keyId: number; publicKey: string}> = [];
  for (let i = 1; i <= preKeyCount; i++) {
    const pk = await store.loadPreKey(i);
    if (pk) oneTime.push({keyId: i, publicKey: toBase64(pk.pubKey)});
  }
  return {
    registrationId:  reg,
    identityKey:     toBase64(id.pubKey),
    signedPrekeyId:  1,
    signedPrekey:    toBase64(spk.pubKey),
    signedPrekeySig: toBase64(spk.signature),
    oneTimePrekeys:  oneTime,
  };
}
