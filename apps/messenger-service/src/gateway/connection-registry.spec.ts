import {ConnectionRegistry} from './connection-registry';
import type {Socket} from 'socket.io';

function fakeSocket(): Socket & {emit: jest.Mock; disconnect: jest.Mock} {
  const emit       = jest.fn();
  const disconnect = jest.fn();
  return {emit, disconnect} as unknown as Socket & {emit: jest.Mock; disconnect: jest.Mock};
}

describe('ConnectionRegistry', () => {
  let reg: ConnectionRegistry;

  beforeEach(() => { reg = new ConnectionRegistry(); });

  it('adds and retrieves connections', () => {
    const s = fakeSocket();
    reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'auth-1', socket: s, sessionId: 's1', lastSeenMs: 1});
    const c = reg.get('u1', 1);
    expect(c?.sessionId).toBe('s1');
    expect(reg.size()).toBe(1);
  });

  it('lists multiple devices for one user', () => {
    reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'a', socket: fakeSocket(), sessionId: 's1', lastSeenMs: 1});
    reg.add({userId: 'u1', deviceId: 2, authDeviceId: 'b', socket: fakeSocket(), sessionId: 's2', lastSeenMs: 1});
    expect(reg.listForUser('u1')).toHaveLength(2);
    expect(reg.listForUser('other')).toHaveLength(0);
  });

  it('supersedes a stale session and disconnects the old socket', () => {
    const old = fakeSocket();
    const firstAdd = reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'a', socket: old, sessionId: 's1', lastSeenMs: 1});
    const next = fakeSocket();
    const secondAdd = reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'a', socket: next, sessionId: 's2', lastSeenMs: 2});
    expect(old.emit).toHaveBeenCalledWith('error', expect.objectContaining({code: 'superseded'}));
    expect(old.disconnect).toHaveBeenCalledWith(true);
    expect(reg.get('u1', 1)?.sessionId).toBe('s2');
    // B-11 — add() reports whether it superseded. The gateway gates the
    // presence INCR on this so a takeover doesn't leak the per-user
    // device counter (which would pin the user 'online' forever).
    expect(firstAdd).toBe(false);
    expect(secondAdd).toBe(true);
  });

  it('a NEW device slot (different deviceId) is not a supersession', () => {
    const a = reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'a', socket: fakeSocket(), sessionId: 's1', lastSeenMs: 1});
    const b = reg.add({userId: 'u1', deviceId: 2, authDeviceId: 'b', socket: fakeSocket(), sessionId: 's2', lastSeenMs: 1});
    expect(a).toBe(false);
    expect(b).toBe(false);
  });

  it('ignores remove() for a different session (race-safe)', () => {
    reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'a', socket: fakeSocket(), sessionId: 's1', lastSeenMs: 1});
    reg.remove('u1', 1, 'different-session');
    expect(reg.get('u1', 1)?.sessionId).toBe('s1');
  });

  it('touch updates lastSeenMs', () => {
    reg.add({userId: 'u1', deviceId: 1, authDeviceId: 'a', socket: fakeSocket(), sessionId: 's1', lastSeenMs: 1});
    reg.touch('u1', 1);
    const c = reg.get('u1', 1);
    expect(c?.lastSeenMs).toBeGreaterThan(1);
  });
});
