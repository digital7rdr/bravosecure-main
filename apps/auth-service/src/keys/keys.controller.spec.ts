import {KeysController} from './keys.controller';
import type {KeysService} from './keys.service';

// Why: P0-I2 regression — the controller once destructured only {bundle,
// poolSize} from fetchBundle and dropped authoritySig, so strict clients
// (requireBundleBinding) rejected every peer bundle with
// bundle_authority_sig_missing and could not start sessions.
describe('KeysController', () => {
  const claims = {sub: 'requester', deviceId: 'd1'} as never;
  const req = {headers: {}, ip: '1.1.1.1'} as never;
  const res = {setHeader: jest.fn()} as never;

  const authoritySig = {sig: 'c2ln', signedAtMs: 1234567890};
  const bundle = {
    registrationId: 7,
    identityKey: 'aWs=',
    signedPrekeyId: 1,
    signedPrekey: 'c3Br',
    signedPrekeySig: 'c2lnMg==',
    oneTimePrekey: {keyId: 1, publicKey: 'b3Br'},
  };

  it('GET :userId returns the bundle WITH top-level authoritySig', async () => {
    const svc = {
      fetchBundle: jest.fn().mockResolvedValue({bundle, authoritySig, poolSize: 4}),
    } as unknown as KeysService;
    const controller = new KeysController(svc);
    const out = await controller.fetchBundle('peer', claims, req, res);
    expect(out).toEqual({...bundle, authoritySig});
  });

  it('GET :userId keeps authoritySig null when the server has no authority key', async () => {
    const svc = {
      fetchBundle: jest.fn().mockResolvedValue({bundle, authoritySig: null, poolSize: 4}),
    } as unknown as KeysService;
    const controller = new KeysController(svc);
    const out = await controller.fetchBundle('peer', claims, req, res);
    expect(out.authoritySig).toBeNull();
  });
});
