/**
 * backupClient.callJson status→kind mapping — previously ZERO coverage
 * against a real Response shape (every suite mocked the client whole).
 * A wrong mapping here is the literal B-50 mechanism (409 → the wrong
 * kind bricked every fresh-install restore), and the 2026-07-23 audit
 * added three more:
 *   • BUG-K — 403 is `verify_required`, NOT 'unauthorized': the proof
 *     verified (password CORRECT) and only the single-use token expired.
 *     Rendering it "Wrong password" steered users toward the wipe.
 *   • BUG-L — 507 is `quota_exceeded` and other 4xx `invalid_request`,
 *     both non-retryable; classifying them 'server'/'network' made the
 *     mirror re-encrypt + re-POST the same batch every 5-8s forever.
 */

jest.mock('@utils/constants', () => ({
  __esModule: true,
  MSG_BASE_URL: 'http://test.local',
}));
jest.mock('@services/api', () => ({
  __esModule: true,
  refreshAccessTokenShared: jest.fn(async () => undefined),
}));
jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: async () => 'test-access-token',
  },
}));

import {backupClient, BackupError} from '../backup/backupClient';

type FakeRes = {
  status: number;
  ok: boolean;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
  clone: () => FakeRes;
};

function makeRes(status: number, body: unknown = {}): FakeRes {
  const res: FakeRes = {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => JSON.stringify(body),
    clone: () => res,
  };
  return res;
}

const fetchMock = jest.fn<Promise<FakeRes>, unknown[]>();
(globalThis as {fetch: unknown}).fetch = fetchMock;

async function kindOf(call: () => Promise<unknown>): Promise<{kind: string; message: string; meta?: Record<string, unknown>}> {
  try {
    await call();
    throw new Error('expected BackupError');
  } catch (e) {
    if (!(e instanceof BackupError)) {throw e;}
    return {kind: e.kind, message: e.message, meta: e.meta};
  }
}

describe('backupClient — status → BackupError kind mapping', () => {
  beforeEach(() => { fetchMock.mockReset(); });

  it('BUG-K — 403 maps to verify_required, never to the wrong-password kind', async () => {
    fetchMock.mockResolvedValue(makeRes(403, {error: 'verify_required'}));
    const e = await kindOf(() => backupClient.getIdentityBundle('tok'));
    expect(e.kind).toBe('verify_required');
    expect(e.kind).not.toBe('unauthorized');
  });

  it('BUG-L — 507 maps to quota_exceeded (terminal, not server/retryable)', async () => {
    fetchMock.mockResolvedValue(makeRes(507, {error: 'backup_quota_exceeded'}));
    const e = await kindOf(() => backupClient.putMessages([]));
    expect(e.kind).toBe('quota_exceeded');
  });

  it('BUG-L — 400 validation maps to invalid_request (terminal), 500 stays server', async () => {
    fetchMock.mockResolvedValue(makeRes(400, {error: 'invalid_message_id'}));
    expect((await kindOf(() => backupClient.putMessages([]))).kind).toBe('invalid_request');

    fetchMock.mockResolvedValue(makeRes(500, {error: 'boom'}));
    expect((await kindOf(() => backupClient.putMessages([]))).kind).toBe('server');
  });

  it('B-50 — 409 {error:stale_seq} carries currentSeq; any other 409 is verifier_missing', async () => {
    fetchMock.mockResolvedValue(makeRes(409, {error: 'stale_seq', currentSeq: 41}));
    const stale = await kindOf(() => backupClient.putMerkleCommit({rootB64: 'r', rowCount: 1, seq: 1, sentAtMs: 1, sigB64: 's'}));
    expect(stale.kind).toBe('stale_seq');
    expect(stale.meta).toMatchObject({currentSeq: 41});

    fetchMock.mockResolvedValue(makeRes(409, {error: 'legacy'}));
    expect((await kindOf(() => backupClient.getIdentityHeader())).kind).toBe('verifier_missing');
  });

  it('401 wrong_proof maps to unauthorized/wrong_password WITHOUT a token-refresh retry', async () => {
    const {refreshAccessTokenShared} = require('@services/api') as {refreshAccessTokenShared: jest.Mock};
    fetchMock.mockResolvedValue(makeRes(401, {error: 'wrong_proof'}));
    const e = await kindOf(() => backupClient.verify({nonce: 'n', proofB64: 'p'}));
    expect(e.kind).toBe('unauthorized');
    expect(e.message).toBe('wrong_password');
    // Retrying a wrong proof would consume a second nonce and DOUBLE-count
    // the lockout attempt.
    expect(refreshAccessTokenShared).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('plain 401 refreshes once and retries; a second 401 surfaces unauthorized', async () => {
    const {refreshAccessTokenShared} = require('@services/api') as {refreshAccessTokenShared: jest.Mock};
    fetchMock.mockResolvedValue(makeRes(401, {error: 'expired'}));
    const e = await kindOf(() => backupClient.getIdentityHeader());
    expect(e.kind).toBe('unauthorized');
    expect(refreshAccessTokenShared).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('423 carries lockedUntil; 410 nonce_expired; 404 no_backup; 503 service_disabled', async () => {
    fetchMock.mockResolvedValue(makeRes(423, {lockedUntil: '2026-07-24T00:00:00Z'}));
    const locked = await kindOf(() => backupClient.getIdentityHeader());
    expect(locked.kind).toBe('locked');
    expect(locked.meta).toMatchObject({lockedUntil: '2026-07-24T00:00:00Z'});

    fetchMock.mockResolvedValue(makeRes(410, {}));
    expect((await kindOf(() => backupClient.getIdentityHeader())).kind).toBe('nonce_expired');

    fetchMock.mockResolvedValue(makeRes(404, {}));
    expect((await kindOf(() => backupClient.getIdentityHeader())).kind).toBe('no_backup');

    fetchMock.mockResolvedValue(makeRes(503, {}));
    expect((await kindOf(() => backupClient.getIdentityHeader())).kind).toBe('service_disabled');
  });

  it('a thrown fetch (offline / abort) maps to network', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('failed'), {name: 'TypeError'}));
    expect((await kindOf(() => backupClient.getIdentityHeader())).kind).toBe('network');
  });
});

describe('B-690 — the BODY read is bounded (a hung res.json() must throw, not wedge)', () => {
  // On-device 2026-08-28: a mid-body `connection reset by peer` left RN's
  // res.json() pending FOREVER — no throw means netRetry never retried and
  // the hung promise wedged the single-flight Merkle commit chain silently
  // for the rest of the session. The body read now races a timeout that
  // throws the 'network' kind (the one netRetry retries).
  const {withBodyTimeout} = require('../backup/backupClient') as typeof import('../backup/backupClient');

  it('a never-settling body rejects with the retryable network kind', async () => {
    const hung = new Promise<never>(() => { /* never settles */ });
    await expect(withBodyTimeout(hung, 60)).rejects.toMatchObject({
      name: 'BackupError',
      kind: 'network',
      message: 'fetch_failed:body_timeout',
    });
  });

  it('a settling body passes through untouched', async () => {
    await expect(withBodyTimeout(Promise.resolve({ok: 1}), 60)).resolves.toEqual({ok: 1});
  });

  it('callJson routes its body reads through the bound (source scan)', () => {
    const {readFileSync} = require('node:fs') as typeof import('node:fs');
    const {join} = require('node:path') as typeof import('node:path');
    const src = readFileSync(
      join(process.cwd(), 'src', 'modules', 'messenger', 'backup', 'backupClient.ts'), 'utf8',
    );
    expect(src).toMatch(/return await withBodyTimeout\(res\.json\(\)/);
    expect(src).not.toMatch(/return res\.json\(\) as Promise<T>/);
    expect(src).toMatch(/withBodyTimeout\(res\.clone\(\)\.json\(\)/);
    expect(src).toMatch(/withBodyTimeout\(res\.text\(\)/);
  });
});
