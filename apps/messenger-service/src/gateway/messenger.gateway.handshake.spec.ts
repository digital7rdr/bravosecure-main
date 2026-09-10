/**
 * Audit P0-T1 — `extractHandshakeParams` unit tests.
 *
 * The handshake extractor used to read JWT + signalDeviceId only from
 * `socket.handshake.query`, which left the token in nginx access logs
 * and any L7 LB record-URL setting. The fix prefers the socket.io
 * `auth` payload (carried in the WS upgrade body, not the URL) and
 * keeps query as a fallback for one rollout release.
 *
 * Asserts:
 *   - auth wins when both auth and query carry a token
 *   - query is used when auth is absent (rollout-window compat)
 *   - missing-everywhere returns `{token: null, signalDeviceId: null, source: 'none'}`
 *   - auth signalDeviceId accepts both number and stringy number forms
 *   - auth without a valid signalDeviceId falls through to query
 *     (so a half-shipped client doesn't lock itself out)
 *   - source field correctly identifies the wire location
 */
import type {Socket} from 'socket.io';
import {extractHandshakeParams} from './messenger.gateway';

function fakeSocket(parts: {auth?: Record<string, unknown>; query?: Record<string, unknown>}): Socket {
  return {
    handshake: {
      auth:  parts.auth  ?? {},
      query: parts.query ?? {},
    },
  } as unknown as Socket;
}

describe('P0-T1 — extractHandshakeParams prefers auth over query', () => {
  test('auth carries both → returns auth values, source=auth', () => {
    const sock = fakeSocket({
      auth:  {token: 'jwt-from-auth', signalDeviceId: 1},
      query: {token: 'jwt-from-query', signalDeviceId: '2'},
    });
    const r = extractHandshakeParams(sock);
    expect(r.token).toBe('jwt-from-auth');
    expect(r.signalDeviceId).toBe(1);
    expect(r.source).toBe('auth');
  });

  test('auth only → returns auth values', () => {
    const r = extractHandshakeParams(fakeSocket({auth: {token: 'jwt', signalDeviceId: 3}}));
    expect(r.token).toBe('jwt');
    expect(r.signalDeviceId).toBe(3);
    expect(r.source).toBe('auth');
  });

  test('auth signalDeviceId as numeric string still resolves', () => {
    const r = extractHandshakeParams(fakeSocket({auth: {token: 'jwt', signalDeviceId: '5'}}));
    expect(r.signalDeviceId).toBe(5);
    expect(r.source).toBe('auth');
  });

  test('query only → returns query values, source=query (rollout fallback)', () => {
    const r = extractHandshakeParams(fakeSocket({query: {token: 'jwt', signalDeviceId: '7'}}));
    expect(r.token).toBe('jwt');
    expect(r.signalDeviceId).toBe(7);
    expect(r.source).toBe('query');
  });

  test('auth has token but no signalDeviceId → falls through to query for the whole pair', () => {
    // A half-shipped client (token in auth, deviceId still in query)
    // shouldn't lock itself out — accept the values, source=query so
    // we still log the warning that the client needs to finish moving.
    const r = extractHandshakeParams(fakeSocket({
      auth:  {token: 'jwt'},
      query: {token: 'jwt', signalDeviceId: '4'},
    }));
    expect(r.token).toBe('jwt');
    expect(r.signalDeviceId).toBe(4);
    expect(r.source).toBe('query');
  });

  test('empty everywhere → {null, null, none}', () => {
    const r = extractHandshakeParams(fakeSocket({}));
    expect(r.token).toBeNull();
    expect(r.signalDeviceId).toBeNull();
    expect(r.source).toBe('none');
  });

  test('auth signalDeviceId = 0 is rejected (must be >= 1)', () => {
    const r = extractHandshakeParams(fakeSocket({
      auth:  {token: 'jwt', signalDeviceId: 0},
      query: {token: 'jwt', signalDeviceId: '9'},
    }));
    // Falls through to query.
    expect(r.signalDeviceId).toBe(9);
    expect(r.source).toBe('query');
  });

  test('auth token is empty string → falls through to query', () => {
    const r = extractHandshakeParams(fakeSocket({
      auth:  {token: '', signalDeviceId: 1},
      query: {token: 'jwt', signalDeviceId: '2'},
    }));
    expect(r.token).toBe('jwt');
    expect(r.source).toBe('query');
  });

  test('query token returned as array (socket.io quirk) is unwrapped', () => {
    const r = extractHandshakeParams(fakeSocket({
      query: {token: ['jwt'], signalDeviceId: ['3']} as unknown as Record<string, unknown>,
    }));
    expect(r.token).toBe('jwt');
    expect(r.signalDeviceId).toBe(3);
    expect(r.source).toBe('query');
  });
});
