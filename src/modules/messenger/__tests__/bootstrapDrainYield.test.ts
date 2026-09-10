/**
 * B-155 — first-boot messenger jank: the bootstrap relay drain saturates the
 * JS thread.
 *
 * On the very first boot per owner (`bravo.relay.bootstrap-done` unset),
 * `drainRelay` pulls ONE page of up to 1000 envelopes and processes them
 * back-to-back: sealed-sender unwrap + cert admission + libsignal decrypt
 * (pure-JS curve25519 / @noble hashes) + the SQL receive txn + a Zustand
 * commit — per envelope, with no macrotask yield anywhere in the loop.
 * Touch events, navigation, and every JS-driven animation starve until the
 * whole backlog is drained. Later boots use the 50-cap steady-state page, so
 * the lag reproduces exactly once per install — which is why it reads as
 * "the messenger fell laggy on first boot".
 *
 * `productionRuntime.ts` cannot be imported by this Jest project, so the loop
 * property is pinned by a comment-stripped source scan (same discipline as
 * receivePersistenceInvariants.test.ts). The file is CRLF — no `\n`-anchored
 * regexes.
 *
 * Register: docs/audits/FIRST_BOOT_LAG_B155_2026-07-23.md
 */

import {readFileSync} from 'node:fs';
import {join} from 'node:path';

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
import type {LocalMessage} from '../store/types';

const RUNTIME = join(process.cwd(), 'src', 'modules', 'messenger', 'runtime', 'productionRuntime.ts');

/** Body of `drainRelay`, sliced by its neighbouring top-level function. */
function drainRelayBody(): string {
  const src = readFileSync(RUNTIME, 'utf8');
  const start = src.indexOf('async function drainRelay(');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('\nfunction convoIdFor(', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

function stripSourceComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

describe('B-155 — bootstrap drain vs the JS thread (source scan)', () => {
  it('CONTROL: the scan sees the envelope loop and the 1000-cap bootstrap page', () => {
    // If either anchor disappears (rename, extraction to a module), the scan
    // below would go vacuous — this control fails first and names the reason.
    const body = stripSourceComments(drainRelayBody());
    expect(body).toContain('for (const env of envelopes)');
    expect(body).toMatch(/\(bootstrap && iter === 0\)\s*\?\s*1000\s*:\s*50/);
  });

  it('B-155 FIXED: the envelope loop yields the JS thread to the UI', () => {
    // Was a DOCUMENTS case: no macrotask yield existed anywhere in `drainRelay`,
    // so a page ran decrypt-to-decrypt with only microtask boundaries and RN's
    // touch/timer callbacks starved for the whole drain. Flipped by the fix.
    const body = stripSourceComments(drainRelayBody());
    expect(body).toMatch(/await yieldToEventLoop\(\)/);
  });

  it('the yield is a MACROtask — a microtask hop would change nothing', () => {
    // `await Promise.resolve()` / `await null` keeps the JS thread; only a
    // timer/immediate boundary lets React Native run pending UI callbacks.
    const src = readFileSync(RUNTIME, 'utf8');
    const helper = src.slice(src.indexOf('function yieldToEventLoop('));
    expect(helper.slice(0, 300)).toMatch(/setTimeout\(resolve,\s*0\)|setImmediate\(/);
  });

  it('the yield sits OUTSIDE the in-flight hold and the receive txn', () => {
    // Ack and dwell semantics are a CLAUDE.md stop-condition: the yield must be
    // between envelopes, never between an envelope's decrypt and its ack, and
    // never inside the hold (a yielded-with-hold envelope would be skipped as
    // busy by a concurrent WS deliver for the whole slice).
    const body = stripSourceComments(drainRelayBody());
    const loopStart = body.indexOf('for (const env of envelopes)');
    const yieldAt   = body.indexOf('await yieldToEventLoop()', loopStart);
    const holdAt    = body.indexOf('tryAcquireEnvelope(', loopStart);
    expect(loopStart).toBeGreaterThan(-1);
    expect(yieldAt).toBeGreaterThan(loopStart);
    expect(yieldAt).toBeLessThan(holdAt);
  });

  it('the slice budget stays within one frame', () => {
    // A budget far above a frame re-introduces visible jank; a tiny one pays a
    // macrotask per envelope. Anything in this range is defensible — the point
    // is that a future edit to a 500ms "optimisation" fails here.
    const src = readFileSync(RUNTIME, 'utf8');
    const m = /const DRAIN_SLICE_MS = (\d+);/.exec(src);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(0);
    expect(Number(m![1])).toBeLessThanOrEqual(20);
  });
});

describe('B-155 F3 — the boot group-stash drain does not race the first paint', () => {
  /** The boot group-stash region, sliced between two stable anchors. */
  function bootStashRegion(): string {
    const src = readFileSync(RUNTIME, 'utf8');
    const start = src.indexOf('const txnDbForDrain =');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('groupMasterKey store wire-up failed', start);
    expect(end).toBeGreaterThan(start);
    return stripSourceComments(src.slice(start, end));
  }

  it('CONTROL: the region still drives drainPendingGroup off selectGroupIdsToDrain', () => {
    const region = bootStashRegion();
    expect(region).toContain('selectGroupIdsToDrain');
    expect(region).toContain('drainPendingGroup(');
  });

  it('the stash replay is deferred to first idle', () => {
    // Replaying a stashed group envelope runs the group crypto path. It is pure
    // catch-up (it restores what is already on disk) and already fire-and-forget,
    // so it must not compete with the boot drain and the first paint.
    const region = bootStashRegion();
    const deferAt = region.indexOf('deferToIdle(');
    const drainAt = region.indexOf('drainPendingGroup(');
    expect(deferAt).toBeGreaterThan(-1);
    expect(deferAt).toBeLessThan(drainAt);
  });

  it('the deferred work re-checks the epoch before touching the store', () => {
    // A deferred callback can fire after logout/runtime rebuild, when txnDb is
    // closed and the store belongs to another user. Every other deferred path in
    // this file guards on isOurEpoch(); this one must too.
    expect(bootStashRegion()).toContain('isOurEpoch()');
  });

  it('deferToIdle uses a real RN idle hop and falls back to running inline', () => {
    const src = readFileSync(RUNTIME, 'utf8');
    const helper = src.slice(src.indexOf('function deferToIdle('));
    const body = stripSourceComments(helper.slice(0, 700));
    expect(body).toContain('InteractionManager');
    // Loopback/tests have no RN runtime — the work must still happen, not vanish.
    expect(body).toMatch(/catch[\s\S]{0,120}fn\(\)/);
  });
});

// ── Behavioural pins on the store half of the boot path ────────────────────
// These two properties are what keep boot-time store traffic O(changed): if
// either regresses, every drained envelope goes back to paying an O(total)
// cost and the first-boot freeze returns through the store even with a
// yielding drain loop.

const msg = (conv: string, id: string, overrides: Partial<LocalMessage> = {}): LocalMessage => ({
  id,
  conversation_id: conv,
  sender_id:       'peer-uuid',
  type:            'text',
  content:         `body-${id}`,
  status:          'sent',
  is_encrypted:    true,
  created_at:      '2026-07-23T12:00:00.000Z',
  peer:            {userId: conv.replace('direct:', ''), deviceId: 1},
  ...overrides,
});

beforeEach(() => {
  useMessengerStore.setState({
    conversations: {}, conversationOrder: [], messages: {},
    activeConversationId: null,
  } as never, false);
});

describe('B-155 — boot hydration commits once', () => {
  it('hydrateMessages is ONE store commit regardless of conversation count', () => {
    // Boot hydration (loadRecent → hydrateMessages) must stay a single `set`.
    // If it ever becomes one commit per conversation, every subscriber —
    // the SQLCipher write-through diff and every mounted screen — re-runs
    // per conversation at the worst possible moment (cold boot).
    const map: Record<string, LocalMessage[]> = {};
    for (let c = 0; c < 8; c++) {
      const conv = `direct:peer-${c}`;
      map[conv] = Array.from({length: 25}, (_, i) => msg(conv, `m-${c}-${i}`));
    }
    let commits = 0;
    const unsub = useMessengerStore.subscribe(() => { commits += 1; });
    try {
      useMessengerStore.getState().hydrateMessages(map);
    } finally {
      unsub();
    }
    expect(commits).toBe(1);
    expect(Object.keys(useMessengerStore.getState().messages)).toHaveLength(8);
  });
});

describe('B-155 / N-30 — untouched conversations stay referentially stable', () => {
  it('appending to one conversation does not re-create the other lists', () => {
    // The write-through subscriber skips referentially-unchanged lists
    // (`if (list === prevList) continue` — N-30), which is the only thing
    // that makes a drain of N envelopes O(N) instead of O(N × total). This
    // holds today because zustand+immer keep untouched draft keys
    // reference-stable; pin it so a store refactor (spread-clone, non-immer
    // set, list rebuild) can't silently reintroduce the full-store walk.
    const s = useMessengerStore.getState();
    s.hydrateMessages({
      'direct:alice': [msg('direct:alice', 'a-1')],
      'direct:bob':   [msg('direct:bob', 'b-1')],
    });
    const bobBefore   = useMessengerStore.getState().messages['direct:bob'];
    const aliceBefore = useMessengerStore.getState().messages['direct:alice'];

    useMessengerStore.getState().appendMessage(
      'direct:alice', msg('direct:alice', 'a-2', {envelope_id: 'env-a-2'}));

    const after = useMessengerStore.getState().messages;
    expect(after['direct:bob']).toBe(bobBefore);
    expect(after['direct:alice']).not.toBe(aliceBefore);
    expect(after['direct:alice']).toHaveLength(2);
  });
});
