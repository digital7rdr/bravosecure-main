/**
 * B-150 — presence has no client-side staleness TTL; the "presence reaper" does
 * not exist. ⚠️ P3 · OPEN · pinned DOCUMENTS-style.
 *
 * `PeerPresence.tsx` carries a comment claiming "The presence reaper +
 * reconnect-clear can both flip the peer to offline…". Repo-wide, `reaper`
 * matches ONLY that comment — there is no reaper. The only transitions that can
 * move a peer to offline are:
 *
 *   1. a server `offline` frame,
 *   2. `clearPresence` on reconnect / unsubscribe,
 *   3. logout (`clearAllPresence`).
 *
 * So while OUR socket stays healthy, a peer whose device dies without a clean
 * disconnect keeps a green dot indefinitely — the client fully trusts the server
 * to emit `offline`, and nothing ages a stored state out.
 *
 * These tests pin the CURRENT behaviour so the gap is visible in a green run
 * rather than only in prose. B-150 is a live decision, not a shipped fix:
 *
 *   → If a client TTL is implemented (e.g. downgrade `online` → `recent` after
 *     N minutes with no frames), the first test's assertion must become
 *     `expect(dot).not.toBe('online')` and the second must assert the reaper
 *     symbol exists.
 *   → If server truth is accepted instead, the PeerPresence comment must be
 *     corrected and the second test kept as the pin that no reaper is claimed.
 *
 * Also recorded here (same sqa.md entry): "hide last seen" is enforced
 * SERVER-side only — the client renders any `lastSeenMs` it is handed. That is a
 * defence-in-depth gap, not a live leak while the server strip holds, so it is
 * asserted as current behaviour too.
 */

jest.mock('@react-native-async-storage/async-storage', () => {
  const store = new Map<string, string>();
  return {
    __esModule: true,
    default: {
      getItem: async (k: string) => store.get(k) ?? null,
      setItem: async (k: string, v: string) => { store.set(k, v); },
      removeItem: async (k: string) => { store.delete(k); },
      clear: async () => { store.clear(); },
    },
  };
});

import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {useMessengerStore} from '../store/messengerStore';

const PEER = 'peer-uuid';
/** Well past any plausible TTL — a peer that has been silent for 12 hours. */
const TWELVE_HOURS_MS = 12 * 3600 * 1000;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

beforeEach(() => {
  useMessengerStore.getState().clearAllPresence?.();
});

describe('B-150 — no client-side presence staleness TTL', () => {
  it('DOCUMENTS B-150: an `online` peer stays online forever with no further frames', () => {
    const store = useMessengerStore.getState();
    const longAgo = Date.now() - TWELVE_HOURS_MS;

    store.setPresence(PEER, 'online', longAgo);

    // Twelve hours of silence. Nothing in the client ages this out — there is
    // no timer, no reaper, no read-time TTL.
    const after = useMessengerStore.getState().presence[PEER];

    // WHAT IT MUST BECOME if a client TTL is adopted:
    //   expect(after?.state).not.toBe('online');
    expect(after?.state).toBe('online');
  });

  it('only a server `offline` frame, clearPresence, or logout can move a peer offline', () => {
    const store = useMessengerStore.getState();

    store.setPresence(PEER, 'online', Date.now());
    expect(useMessengerStore.getState().presence[PEER]?.state).toBe('online');

    // 1 — the server frame.
    store.setPresence(PEER, 'offline', Date.now());
    expect(useMessengerStore.getState().presence[PEER]?.state).toBe('offline');

    // 2 — reconnect / unsubscribe.
    store.setPresence(PEER, 'online', Date.now());
    store.clearPresence([PEER]);
    expect(useMessengerStore.getState().presence[PEER]?.state).not.toBe('online');

    // 3 — logout.
    store.setPresence(PEER, 'online', Date.now());
    useMessengerStore.getState().clearAllPresence();
    expect(useMessengerStore.getState().presence[PEER]).toBeUndefined();
  });

  it('DOCUMENTS B-150: no `reaper` implementation exists — only the stale comment', () => {
    // The comment that names a reaper is the ONLY place the word appears in the
    // presence surface. If a reaper is ever built, this assertion flips and the
    // first test's TTL expectation must flip with it.
    const banner = join(
      process.cwd(), 'src', 'modules', 'messenger', 'ui', 'PeerPresence.tsx',
    );
    let src: string;
    try {
      src = readFileSync(banner, 'utf8');
    } catch {
      // The surface moved or was deleted — that is a real change to this bug's
      // anchor, so fail loudly rather than pass vacuously.
      throw new Error('B-150: PeerPresence.tsx not found — re-anchor this test');
    }

    // Comments stripped: prose naming the reaper is exactly the false positive
    // this repo has been burned by (CLAUDE.md, static-scan rules).
    expect(stripComments(src)).not.toMatch(/reaper/i);
  });

  it('DOCUMENTS B-150: the client renders whatever lastSeenMs it is handed (server-side strip only)', () => {
    const store = useMessengerStore.getState();
    const leaked = Date.now() - TWELVE_HOURS_MS;

    // A server that failed to strip last-seen for a peer with "hide last seen"
    // on would have it stored and rendered verbatim — the client has no
    // independent privacy gate.
    store.setPresence(PEER, 'offline', leaked);

    // WHAT IT MUST BECOME if client-side defence-in-depth is added:
    //   expect(useMessengerStore.getState().presence[PEER]?.lastSeenMs).toBeUndefined();
    expect(useMessengerStore.getState().presence[PEER]?.lastSeenMs).toBe(leaked);
  });
});
