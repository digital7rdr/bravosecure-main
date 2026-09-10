/**
 * CRIT-7 multi-device — KeysHttpClient.fetchDevices.
 *
 * Backs the flag-gated 1:1 fan-out: fetch every one of a peer's device bundles
 * (each with its real deviceId + its own authority binding) so a send can reach
 * a linked/second device instead of only device 1. Covers response mapping,
 * the no-one-time-prekey case, and the empty-device-list case. Verify is skipped
 * (no pin configured), matching the existing keysClient tests.
 */
import {KeysHttpClient} from '../src/transport/keysClient';

const fetchMock = jest.fn();
beforeEach(() => {
  fetchMock.mockReset();
  (global as unknown as {fetch: jest.Mock}).fetch = fetchMock;
});

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    text: async () => JSON.stringify(body),
    headers: {get: () => null},
  };
}
const token = async () => 'tok';
const dev = (deviceId: number, opk: {keyId: number; publicKey: string} | null = {keyId: 9, publicKey: 'opk'}) => ({
  deviceId,
  registrationId:  10 + deviceId,
  identityKey:     'idk' + deviceId,
  signedPrekeyId:  5,
  signedPrekey:    'spk',
  signedPrekeySig: 'sig',
  oneTimePrekey:   opk,
  authoritySig:    null,
});

describe('KeysHttpClient.fetchDevices (CRIT-7 multi-device)', () => {
  it('returns one bundle per device with the real deviceId + preKey', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {devices: [dev(1), dev(2)]}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    const bundles = await c.fetchDevices('bob');

    expect(fetchMock.mock.calls[0][0]).toBe('http://h/auth/keys/bob/devices');
    expect(bundles.map(b => b.address)).toEqual([
      {userId: 'bob', deviceId: 1},
      {userId: 'bob', deviceId: 2},
    ]);
    expect(bundles[1].identityKey).toBe('idk2');
    expect(bundles[0].preKey).toEqual({keyId: 9, publicKey: 'opk'});
  });

  it('omits preKey for a device with no one-time prekey', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {devices: [dev(1, null)]}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    const bundles = await c.fetchDevices('bob');
    expect(bundles[0].preKey).toBeUndefined();
  });

  it('returns empty for a user with no devices', async () => {
    fetchMock.mockResolvedValueOnce(reply(200, {devices: []}));
    const c = new KeysHttpClient({baseUrl: 'http://h', getToken: token});
    expect(await c.fetchDevices('bob')).toEqual([]);
  });
});
