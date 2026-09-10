/**
 * B-160 (L2) — the disappearing-message sweep must cost O(armed), not O(all).
 *
 * `ExpirySweeper.sweep()` ran `Object.entries(state.messages)` over EVERY
 * conversation and EVERY hydrated message, once per second, for as long as a
 * single armed (`expires_at`) message existed anywhere. The F-13 idle backoff
 * only engaged at EXACTLY zero armed messages, so one live burn timer bought a
 * full-store walk at 1 Hz — on a 20-conversation account hydrated at 200 rows
 * each, ~4,000 row visits per second on the JS thread, forever.
 *
 * The fix keeps an armed index so a tick touches only conversations that
 * actually hold a timed message, and sleeps until the next known expiry.
 * Correctness (what gets purged, and when) must be identical — the tests below
 * assert behaviour first and cost second.
 *
 * Register: docs/audits/FIRST_BOOT_LAG_B155_2026-07-23.md §8 (L2).
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

import {ExpirySweeper} from '../runtime/expirySweeper';
import {useMessengerStore} from '../store/messengerStore';
import type {LocalMessage} from '../store/types';

const NOW = 1_700_000_000_000;

function msg(conv: string, id: string, overrides: Partial<LocalMessage> = {}): LocalMessage {
  return {
    id,
    conversation_id: conv,
    sender_id:       'peer',
    type:            'text',
    content:         `c-${id}`,
    status:          'sent',
    is_encrypted:    true,
    created_at:      new Date(NOW - 60_000).toISOString(),
    peer:            {userId: 'peer', deviceId: 1},
    ...overrides,
  };
}

/** Seed `convos` conversations × `per` plain messages, plus any armed rows. */
function seed(convos: number, per: number, armed: LocalMessage[] = []): void {
  const messages: Record<string, LocalMessage[]> = {};
  for (let c = 0; c < convos; c++) {
    const conv = `direct:peer-${c}`;
    messages[conv] = Array.from({length: per}, (_, i) => msg(conv, `m-${c}-${i}`));
  }
  for (const a of armed) {
    (messages[a.conversation_id] ??= []).push(a);
  }
  useMessengerStore.setState({
    conversations: {}, conversationOrder: [], messages, activeConversationId: null,
  } as never, false);
}

beforeEach(() => {
  seed(0, 0);
});

describe('B-160 — behaviour is unchanged', () => {
  it('purges an expired message and leaves unexpired ones alone', () => {
    seed(1, 2, [
      msg('direct:peer-0', 'dead',  {expires_at: NOW - 1}),
      msg('direct:peer-0', 'alive', {expires_at: NOW + 60_000}),
    ]);
    const swept = new ExpirySweeper().sweep(NOW);
    expect(swept).toBe(1);
    const ids = useMessengerStore.getState().messages['direct:peer-0'].map(m => m.id);
    expect(ids).toContain('alive');
    expect(ids).not.toContain('dead');
  });

  it('purges across MULTIPLE conversations in one sweep', () => {
    seed(3, 1, [
      msg('direct:peer-0', 'd0', {expires_at: NOW - 1}),
      msg('direct:peer-2', 'd2', {expires_at: NOW - 1}),
    ]);
    expect(new ExpirySweeper().sweep(NOW)).toBe(2);
  });

  it('fires retract + blob purge exactly for the rows that carried them', async () => {
    const retract = jest.fn(async () => {});
    const purgeBlob = jest.fn(async () => {});
    seed(1, 0, [
      msg('direct:peer-0', 'tok',  {expires_at: NOW - 1, retract_token: 'T1'}),
      msg('direct:peer-0', 'blob', {expires_at: NOW - 1, media_object_key: 'K1'}),
      msg('direct:peer-0', 'keep', {expires_at: NOW + 1, retract_token: 'T2'}),
    ]);
    new ExpirySweeper({retract, purgeBlob}).sweep(NOW);
    expect(retract).toHaveBeenCalledTimes(1);
    expect(retract).toHaveBeenCalledWith('T1');
    expect(purgeBlob).toHaveBeenCalledTimes(1);
    expect(purgeBlob).toHaveBeenCalledWith('K1');
  });

  it('an armed message that expires LATER is purged on the later tick', () => {
    seed(1, 1, [msg('direct:peer-0', 'later', {expires_at: NOW + 5_000})]);
    const s = new ExpirySweeper();
    expect(s.sweep(NOW)).toBe(0);
    expect(s.sweep(NOW + 5_001)).toBe(1);
  });
});

describe('B-160 — a steady-state tick does not re-walk unchanged history', () => {
  /**
   * Rows visited by a tick that follows an identical tick. This is the shape that
   * actually burns the device: the sweeper fires at 1 Hz against a store that is
   * unchanged between almost every pair of ticks. The FIRST tick after a change
   * must still scan that conversation — that is not the defect.
   *
   * Proxies are installed BEFORE the warm-up tick so array identity is stable
   * across both ticks (installing one mints a new reference).
   */
  function rowsVisitedOnSecondTick(sweeper: ExpirySweeper): number {
    let visited = 0;
    const raw = useMessengerStore.getState().messages;
    const instrumented: Record<string, LocalMessage[]> = {};
    for (const [conv, list] of Object.entries(raw)) {
      instrumented[conv] = new Proxy(list, {
        get(target, prop, recv) {
          if (typeof prop === 'string' && /^\d+$/.test(prop)) {visited += 1;}
          return Reflect.get(target, prop, recv);
        },
      });
    }
    useMessengerStore.setState({messages: instrumented} as never, false);
    sweeper.sweep(NOW);      // warm: allowed to scan
    visited = 0;             // measure only the steady-state tick
    sweeper.sweep(NOW + 1_000);
    return visited;
  }

  it('one armed message does not cost a 2,000-row walk every second', () => {
    seed(20, 100, [msg('direct:peer-7', 'armed', {expires_at: NOW + 30_000})]);
    // Old behaviour: 2,001 rows visited on EVERY tick, forever.
    expect(rowsVisitedOnSecondTick(new ExpirySweeper())).toBe(0);
  });

  it('no armed message anywhere costs nothing', () => {
    seed(20, 100);
    expect(rowsVisitedOnSecondTick(new ExpirySweeper())).toBe(0);
  });

  it('cost does not scale with history size', () => {
    seed(5, 50, [msg('direct:peer-1', 'a', {expires_at: NOW + 10_000})]);
    const small = rowsVisitedOnSecondTick(new ExpirySweeper());
    seed(40, 200, [msg('direct:peer-1', 'a', {expires_at: NOW + 10_000})]);
    const large = rowsVisitedOnSecondTick(new ExpirySweeper());
    expect(large).toBe(small);
  });

  it('a conversation whose list CHANGED is re-scanned', () => {
    // The cache must follow list identity, or a newly-armed message is invisible.
    seed(2, 5);
    const s = new ExpirySweeper();
    s.sweep(NOW);
    useMessengerStore.getState().appendMessage(
      'direct:peer-0', msg('direct:peer-0', 'fresh', {expires_at: NOW - 1}));
    expect(s.sweep(NOW)).toBe(1);
  });
});

describe('B-160 — the F-13 idle backoff no longer delays a fresh burn timer', () => {
  it('a message armed just after an idle tick is purged on time', () => {
    // F-13 skipped all sweeps for 30s after any scan that saw zero armed
    // messages. A 10s disappearing message sent inside that window survived up
    // to ~20s past its own expiry. The armed index makes an empty tick free, so
    // the backoff is gone and this window closes.
    seed(3, 10);
    const s = new ExpirySweeper();
    expect(s.sweep(NOW)).toBe(0);            // idle scan: nothing armed
    useMessengerStore.getState().appendMessage(
      'direct:peer-0', msg('direct:peer-0', 'burn', {expires_at: NOW + 10_000}));
    expect(s.sweep(NOW + 10_001)).toBe(1);   // was 0 under the 30s backoff
  });
});
