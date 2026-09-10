/**
 * Presence store reducers — setPresence / clearPresence / clearAllPresence.
 *
 * First direct coverage of the active-status state machine. The map is
 * session-scoped (never persisted), written by exactly one WS frame
 * handler, and read by every online dot in the app; these tests pin the
 * derivation rules (PRES audit fix #7) and DOCUMENT one live defect:
 * a non-offline frame without `lastSeenMs` wipes the stored last-seen
 * (B-146, sqa.md) — clearPresence then faithfully preserves the wiped
 * value, so the "Last seen …" line is gone until the peer next goes
 * offline with a server-stamped timestamp.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem:    async (k: string) => store.get(k) ?? null,
      setItem:    async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear:      async () => { store.clear(); },
    },
  };
});

import {useMessengerStore} from '../store/messengerStore';

const T = 1_753_248_000_000;

const presenceOf = (uid: string) => useMessengerStore.getState().presence[uid];

beforeEach(() => {
  useMessengerStore.getState().reset();
});

describe('setPresence — 4-state granularity with the derived online boolean', () => {
  it.each<['online' | 'active' | 'away', boolean]>([
    ['online', true],
    ['active', true],
    ['away', true],
  ])('%s frame → online=%s, state preserved', (state, online) => {
    useMessengerStore.getState().setPresence('u1', state, T);
    expect(presenceOf('u1')).toEqual({state, online, lastSeen: T, lastSeenMs: T});
  });

  it('offline frame → online=false with the server timestamp', () => {
    useMessengerStore.getState().setPresence('u1', 'offline', T);
    expect(presenceOf('u1')).toEqual({
      state: 'offline', online: false, lastSeen: T, lastSeenMs: T,
    });
  });

  it('a newer frame replaces the older one wholesale', () => {
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'away', T);
    s.setPresence('u1', 'active', T + 1000);
    expect(presenceOf('u1')).toEqual({
      state: 'active', online: true, lastSeen: T + 1000, lastSeenMs: T + 1000,
    });
  });

  it('B-146 FIXED: an online frame without lastSeenMs PRESERVES the stored last-seen', () => {
    // ServerPresence.lastSeenMs is optional and a plain `online` frame
    // ("connected, no hint yet") ships without it. Absence there is not
    // a statement about last-seen, so it must not destroy one.
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'offline', T);
    s.setPresence('u1', 'online', undefined);
    expect(presenceOf('u1').lastSeen).toBe(T);
    expect(presenceOf('u1').lastSeenMs).toBe(T);
  });

  it.each<'online' | 'active' | 'away'>(['online', 'active', 'away'])(
    'B-146 FIXED: a %s frame carries the last-seen forward', state => {
      const s = useMessengerStore.getState();
      s.setPresence('u1', 'offline', T);
      s.setPresence('u1', state, undefined);
      expect(presenceOf('u1').lastSeen).toBe(T);
    });

  it('B-146 PRIVACY: an OFFLINE frame without lastSeenMs CLEARS it', () => {
    // The relay strips lastSeenMs when the peer hides last-seen (M-06).
    // Backfilling here would resurrect a timestamp the peer just hid,
    // so absence on an offline frame is authoritative.
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'offline', T);
    s.setPresence('u1', 'online', undefined);
    s.setPresence('u1', 'offline', undefined);
    expect(presenceOf('u1').lastSeen).toBeUndefined();
    expect(presenceOf('u1').lastSeenMs).toBeUndefined();
  });

  it('B-146: an explicit newer timestamp always wins over the remembered one', () => {
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'offline', T);
    s.setPresence('u1', 'away', T + 5_000);
    expect(presenceOf('u1').lastSeen).toBe(T + 5_000);
  });
});

describe('clearPresence — local downgrade that keeps the last-seen claim', () => {
  it('flips watched peers to offline but preserves lastSeen', () => {
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'active', T);
    s.clearPresence(['u1']);
    expect(presenceOf('u1')).toEqual({
      state: 'offline', online: false, lastSeen: T, lastSeenMs: T,
    });
  });

  it('clears several peers at once and leaves others untouched', () => {
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'online', T);
    s.setPresence('u2', 'active', T);
    s.setPresence('u3', 'away', T);
    s.clearPresence(['u1', 'u2']);
    expect(presenceOf('u1').online).toBe(false);
    expect(presenceOf('u2').online).toBe(false);
    expect(presenceOf('u3')).toEqual({state: 'away', online: true, lastSeen: T, lastSeenMs: T});
  });

  it('an unknown peer becomes a plain offline record (no phantom lastSeen)', () => {
    useMessengerStore.getState().clearPresence(['stranger']);
    expect(presenceOf('stranger')).toEqual({
      state: 'offline', online: false, lastSeen: undefined, lastSeenMs: undefined,
    });
  });

  it('B-146 FIXED: the last-seen survives online → reconnect-clear', () => {
    // This is the end-to-end shape of the bug: offline(T) → online(no
    // ts) → LOCAL reconnect downgrade. clearPresence was always
    // faithful; it was preserving an already-wiped value. The banner
    // now keeps its "Last seen …" line.
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'offline', T);
    s.setPresence('u1', 'online', undefined);
    s.clearPresence(['u1']);
    expect(presenceOf('u1').state).toBe('offline');
    expect(presenceOf('u1').lastSeen).toBe(T);
  });
});

describe('clearAllPresence — logout / owner switch', () => {
  it('empties the map entirely', () => {
    const s = useMessengerStore.getState();
    s.setPresence('u1', 'online', T);
    s.setPresence('u2', 'away', T);
    s.clearAllPresence();
    expect(useMessengerStore.getState().presence).toEqual({});
  });
});
