/**
 * Phase 3 — WI-3.1 / WI-3.2 / WI-3.4, driven through the REAL hook.
 *
 * These three work items all guard the same window: `rejoinRoom` closes every
 * consumer and both transports and then rebuilds them across four awaits.
 * Three separate things could write into that window —
 *
 *   WI-3.1  a SECOND rejoin (flapping socket, or the hub's stuck-claim
 *           takeover), whose interleaved writes clear the winner's
 *           consumed-producer record, push producers onto a transport it is
 *           about to close, and land a terminal setState after the winner's;
 *   WI-3.2  the 4 s reconcile tick / the resume reconcile / the early-producer
 *           buffer, all consuming onto a half-built `reRecvTx` and re-inserting
 *           tiles the rejoin has just cleared;
 *   WI-3.4  the restore/adopt path, which rehydrated `consumersByPid` but
 *           started the consume-dedup sets EMPTY, so the resume reconcile
 *           re-consumed a live producer and mediasoup threw
 *           "consumer already exists".
 *
 * The sibling `groupCallHook*.test.ts` suites all passed against the broken
 * code, so these are deliberately written against OBSERVABLE effects — the
 * frames that reach the socket, and the `[CALLSM]` decisions — rather than
 * against internal state.
 *
 * Same edge-fake rule as the siblings: only mediasoup-client,
 * react-native-webrtc, HTTP, WS and the native FrameCryptor are faked.
 */
import * as React from 'react';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

interface TestRendererInstance { unmount: () => void; }
interface TestRendererModule {
  create: (element: unknown) => TestRendererInstance;
  act: (cb: () => unknown) => Promise<void>;
}
const TestRenderer = require('react-test-renderer') as TestRendererModule;

(globalThis as {IS_REACT_ACT_ENVIRONMENT?: boolean}).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-native', () => ({
  __esModule: true,
  Platform: {OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default, Version: 34},
  AppState: {currentState: 'active', addEventListener: () => ({remove: () => {}})},
  DeviceEventEmitter: {addListener: () => ({remove: () => {}}), emit: () => {}, removeAllListeners: () => {}},
  NativeModules: {},
  PermissionsAndroid: {
    PERMISSIONS: {}, RESULTS: {GRANTED: 'granted'},
    request: async () => 'granted', check: async () => true,
  },
}));
jest.mock('@utils/constants', () => ({MSG_BASE_URL: 'https://relay.test'}));
jest.mock('react-native-webrtc', () => require('./helpers/groupCallFakes').webrtcModule());
jest.mock('mediasoup-client', () => ({
  __esModule: true,
  Device: require('./helpers/groupCallFakes').FakeDevice,
}));
jest.mock('@/services/api', () => require('./helpers/groupCallFakes').apiModule());
jest.mock('../../observability/crashlytics', () => ({
  __esModule: true, log: () => {}, recordError: () => {}, setUserId: () => {},
}));
jest.mock('../webrtc/peerConnectionFactory', () =>
  require('./helpers/groupCallFakes').peerConnectionFactoryModule());
jest.mock('../webrtc/frameCryptorOrchestrator', () =>
  require('./helpers/groupCallFakes').frameCryptorModule());
jest.mock('../runtime/transportRegistry', () =>
  require('./helpers/groupCallFakes').transportRegistryModule());
jest.mock('../runtime/runtime', () => require('./helpers/groupCallFakes').runtimeModule());

import {ctl, FakeWs, defaultAck, type AckHandler} from './helpers/groupCallFakes';
import {useGroupCall, clearAllLiveSfuHandles} from '../webrtc/useGroupCall';
import type {GroupCallHandle, GroupCallOptions} from '../webrtc/useGroupCall';
import {
  setActiveGroupCall, getActiveGroupCall, patchActiveGroupCall,
} from '../runtime/groupCallRegistry';
import {clearGroupCallRejoinHandler} from '../webrtc/groupCallRejoinHub';
import {
  beginAttempt, markAttemptRunning, clearAllAttempts,
} from '../webrtc/groupCallAttemptGen';
import {useMessengerStore} from '../store/messengerStore';
import {clearRoomIdentities} from '../webrtc/groupCallIdentityRegistry';

const CONVO = 'convo-race';
const ROOM = 'ROOM_RACE';
const MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
/** A producer that is already live in the room when we join. */
const PEER_PID = 'prod_audio_peer';

function seedGroup(): void {
  useMessengerStore.setState((s: Record<string, unknown>) => ({
    ...s,
    groups: {
      ...(s.groups as Record<string, unknown>),
      [CONVO]: {
        id: CONVO, name: 'Race Group', owner: 'someone-else',
        epoch: 1, masterKeyB64: MASTER_KEY, members: {me: {}, bob: {}},
      },
    },
    _ownUserId: 'me', _ownAuthUserId: 'me',
  }) as never);
}

async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await TestRenderer.act(async () => { await new Promise<void>(r => setTimeout(r, 0)); });
  }
}

interface Rig { handle: () => GroupCallHandle; unmount: () => void; }

const baseOpts = (over: Partial<GroupCallOptions> = {}): GroupCallOptions => ({
  conversationId:   CONVO,
  callType:         'video',
  direction:        'incoming',
  roomId:           ROOM,
  roomToken:        'TOK',
  hostUserId:       'bob',
  recipientUserIds: ['bob'],
  ownDisplayName:   'Me',
  callerName:       'Bob',
  ...over,
});

async function mount(opts: GroupCallOptions): Promise<Rig> {
  let latest: GroupCallHandle | null = null;
  const Probe = (): null => { latest = useGroupCall(opts); return null; };
  let renderer: TestRendererInstance | null = null;
  await TestRenderer.act(async () => {
    renderer = TestRenderer.create(React.createElement(Probe));
  });
  await flush(14);
  return {
    handle: () => latest as GroupCallHandle,
    unmount: () => { TestRenderer.act(() => { renderer?.unmount(); }); },
  };
}

async function run(fn: () => unknown): Promise<void> {
  await TestRenderer.act(async () => { await fn(); });
  await flush(3);
}

const joinerAck = (over: Record<string, unknown> = {}): AckHandler =>
  defaultAck({isHost: false, participantTag: 'TAG_ME', ...over});

/** Every `console.warn` line emitted since the spy was installed. */
function warnLines(): string {
  return (console.warn as unknown as jest.Mock).mock.calls
    .map((c: unknown[]) => c.join(' ')).join('\n');
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
  ctl.reset();
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  clearAllAttempts();
  clearRoomIdentities(ROOM);
  seedGroup();
  useMessengerStore.setState((s: Record<string, unknown>) => ({...s, messages: {}}) as never);
});

afterEach(() => {
  setActiveGroupCall(null);
  clearAllLiveSfuHandles();
  clearGroupCallRejoinHandler();
  clearAllAttempts();
  jest.restoreAllMocks();
});

// ── WI-3.1 — a superseded rejoin must stop writing ───────────────────

describe('WI-3.1 — attempt generation', () => {
  it('a rejoin superseded mid-flight abandons its rebuild instead of stomping', async () => {
    // The supersede has to happen from INSIDE the rebuild, which is why it is
    // driven from the WS ack rather than the test body: the generation is
    // taken in `onJoined` (review round 1 moved it there — taking it on
    // handler entry permanently stranded the boot's reconnect-budget timer),
    // so any bump the test makes before that is simply the number the rejoin
    // then adopts. Bumping while the rejoin is re-consuming models the real
    // shape: a second onReconnect, or the hub's stuck-claim takeover, claiming
    // the room mid-rebuild.
    const PEER = 'prod_audio_peer';
    let joins = 0;
    let bumped = false;
    const inner = joinerAck({
      existingProducers: [{producerId: PEER, participantTag: 'peer', kind: 'audio'}],
    });
    ctl.liveWs = new FakeWs((event, data) => {
      if (event === 'sfu.join') {joins += 1;}
      if (event === 'sfu.consume' && joins >= 2 && !bumped) {
        bumped = true;
        beginAttempt(ROOM);
      }
      return inner(event, data);
    });
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    expect(rig.handle().state).toBe('joined');
    (console.warn as unknown as jest.Mock).mockClear();

    await run(() => ws.fireReconnect());

    // Guard the guard: if the rebuild never reached its consume loop, the
    // assertions below would pass or fail for the wrong reason.
    expect(bumped).toBe(true);
    const lines = warnLines();
    expect(lines).toContain('groupcall.attempt.drop');
    expect(lines).toContain('superseded');
    // It stopped at one of rejoinRoom's guarded points rather than finishing
    // the rebuild and stomping the winner's transports, tiles and state.
    expect(lines).toMatch(/where=rejoin\./);

    rig.unmount();
    await flush(3);
  });

  it('a rejoin RE-CONSUMES the room it rebuilt — it is not blocked by its own guard', async () => {
    /**
     * The counterweight to everything above, and the mutation that exposed it.
     *
     * WI-3.2 makes readers stand down while a rejoin holds the room. But the
     * rejoin re-consumes every existing producer through the SAME
     * `consumeProducer` funnel those readers use, so a guard phrased as
     * "stand down whenever a rejoin is running" makes the rejoin stand down
     * from its own work — and it rebuilds a room with no remote tiles in it.
     * Every peer goes silent and black, permanently, and the reconcile tick
     * (also standing down) never repairs it.
     *
     * That is why the guard compares generations instead of a boolean.
     */
    const PEER = 'prod_audio_peer';
    const inner = joinerAck({
      existingProducers: [{producerId: PEER, participantTag: 'peer', kind: 'audio'}],
    });
    ctl.liveWs = new FakeWs(inner);
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    const consumesAfterBoot = ws.eventsNamed('sfu.consume')
      .filter(e => e.producerId === PEER).length;
    expect(consumesAfterBoot).toBe(1);

    await run(() => ws.fireReconnect());

    // The rejoin closed every consumer, so it MUST have consumed the peer
    // again against the freshly built recv transport.
    const consumesAfterRejoin = ws.eventsNamed('sfu.consume')
      .filter(e => e.producerId === PEER).length;
    expect(consumesAfterRejoin).toBeGreaterThan(consumesAfterBoot);
    expect(rig.handle().state).toBe('joined');

    rig.unmount();
    await flush(3);
  });

  it('an UNsuperseded rejoin still completes normally', async () => {
    // The guard must not be so eager that ordinary recovery stops working —
    // this is the control for the test above.
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());
    expect(ws.eventsNamed('sfu.join')).toHaveLength(1);
    (console.warn as unknown as jest.Mock).mockClear();

    await run(() => ws.fireReconnect());

    expect(ws.eventsNamed('sfu.join')).toHaveLength(2);
    expect(rig.handle().state).toBe('joined');
    expect(warnLines()).not.toContain('superseded');

    rig.unmount();
    await flush(3);
  });
});

// ── WI-3.2 — readers stand down while a rebuild holds the room ───────

describe('WI-3.2 — the rebuild window is serialized', () => {
  /** Boot, then minimize with keepAlive and drop the screen. */
  async function bootThenMinimize(ack: AckHandler): Promise<FakeWs> {
    ctl.liveWs = new FakeWs(ack);
    const ws = ctl.liveWs;
    const first = await mount(baseOpts());
    expect(first.handle().state).toBe('joined');
    await run(() => patchActiveGroupCall(
      getActiveGroupCall()?.roomId ?? null, {isMinimized: true, keepAlive: true},
    ));
    first.unmount();
    await flush(3);
    return ws;
  }

  it('the resume reconcile does NOT probe the SFU while a rejoin is rebuilding', async () => {
    const ws = await bootThenMinimize(joinerAck());
    const probesBefore = ws.eventsNamed('sfu.producers').length;

    // A rejoin owns the room. The restore path fires `consumeMissingAfterRestore`
    // immediately, and that helper issues `recv.consume` DIRECTLY — bypassing
    // every dedup guard the consumeProducer funnel applies — so it is the most
    // dangerous of the readers.
    markAttemptRunning(ROOM, 999);

    const restored = await mount(baseOpts());
    expect(ws.eventsNamed('sfu.producers')).toHaveLength(probesBefore);

    restored.unmount();
    await flush(3);
  });

  it('the resume reconcile DOES probe once no rejoin holds the room', async () => {
    // Control: without the mark, the same restore must still reconcile —
    // otherwise the guard would have silently disabled recovery entirely.
    const ws = await bootThenMinimize(joinerAck());
    const probesBefore = ws.eventsNamed('sfu.producers').length;

    const restored = await mount(baseOpts());
    expect(ws.eventsNamed('sfu.producers').length).toBeGreaterThan(probesBefore);

    restored.unmount();
    await flush(3);
  });
});

// ── WI-3.4 — the consume-dedup sets belong to the call ───────────────

describe('WI-3.4 — consume-dedup survives minimize/restore', () => {
  /**
   * A room whose only remote producer is already consumed at boot, and whose
   * `sfu.producers` snapshot keeps reporting it — the shape the resume
   * reconcile is built to diff against.
   */
  const ackWithPeer = (): AckHandler => {
    const inner = joinerAck({
      existingProducers: [{producerId: PEER_PID, participantTag: 'peer', kind: 'audio'}],
    });
    return (event, data) => {
      if (event === 'sfu.producers') {
        return {producers: [{producerId: PEER_PID, participantTag: 'peer', kind: 'audio', paused: false}]};
      }
      return inner(event, data);
    };
  };

  /**
   * COVERAGE NOTE (from mutation-proving this suite): the restore path now has
   * TWO mechanisms that each prevent the re-consume — adopting the stashed
   * dedup sets, and backfilling `consumedProducerIds` from the adopted
   * `consumersByPid`. They are redundant BY DESIGN, because they cover
   * different gaps: only the stash carries `inFlightConsumes` (a consume still
   * in flight across the minimize has no consumer to derive from), and only
   * the backfill catches a consumer registered before its producer reached the
   * consumed set (`attemptConsume` writes `consumersByPid` first, so a
   * minimize landing in that window leaves the sets disagreeing).
   *
   * The consequence for THIS test: removing either mechanism alone leaves the
   * other one covering, so the assertion below pins the PAIR, not each half.
   * A mutation must remove both to turn it red. Do not read a green run here
   * as evidence that either mechanism individually still works.
   */
  it('a consumed-but-TILELESS producer is not re-consumed after a restore', async () => {
    ctl.liveWs = new FakeWs(ackWithPeer());
    const ws = ctl.liveWs;
    const first = await mount(baseOpts());
    expect(first.handle().state).toBe('joined');
    // Boot consumed the peer exactly once.
    const consumesAfterBoot = ws.eventsNamed('sfu.consume')
      .filter(e => e.producerId === PEER_PID).length;
    expect(consumesAfterBoot).toBe(1);

    await run(() => patchActiveGroupCall(ROOM, {isMinimized: true, keepAlive: true}));
    first.unmount();
    await flush(3);
    // Drop the tile from the registry surface WITHOUT closing the consumer.
    // That drift is real: `attemptConsume` registers the consumer BEFORE the
    // tile is flushed, so a minimize landing in that window leaves exactly
    // this state — and it is where the resume reconcile used to re-issue
    // `sfu.consume` and make mediasoup throw "consumer already exists".
    //
    // It must happen AFTER the owning instance unmounts: while instance 1 is
    // still mounted its registry-sync effect writes the tile straight back,
    // which silently made an earlier version of this test vacuous (the
    // producer stayed in `haveTile`, so the dedup sets were never consulted).
    await run(() => patchActiveGroupCall(ROOM, {remoteTiles: []}));
    expect(getActiveGroupCall()?.remoteTiles ?? []).toHaveLength(0);

    const restored = await mount(baseOpts());
    await flush(8);

    const consumesTotal = ws.eventsNamed('sfu.consume')
      .filter(e => e.producerId === PEER_PID).length;
    expect(consumesTotal).toBe(consumesAfterBoot);

    restored.unmount();
    await flush(3);
  });
});

/**
 * WIRING SCAN — the guards this suite cannot reach executably.
 *
 * Three WI-3.1/3.2 sites are bound to timers that only fire on a real clock:
 * the reconnect budget expires after RECONNECT_BUDGET_MS (30 s), the producer
 * reconcile ticks every 4 s, and the boot's terminal `setState` is reached
 * only after a full join. Driving those under the hook harness would mean
 * mixing fake timers into a suite whose `flush()` depends on real ones.
 *
 * They are pinned here instead, because the mutation pass found every one of
 * them surviving otherwise — an unpinned guard is one refactor from being
 * silently deleted. Comments are stripped first: the fixes' own comments name
 * these symbols, so an unstripped scan would match the prose that explains the
 * guard rather than the guard.
 */
describe('WI-3.1 / WI-3.2 — wiring (source scan)', () => {
  const HOOK_SRC = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
  ).split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  it('the boot\'s terminal setState is NOT generation-guarded', () => {
    /**
     * Round 1 removed a guard here, and this pin exists so it does not come
     * back. It was minted against the room known at step 1, and the B-08
     * `room_not_found` re-create RE-POINTS `rid` at a freshly minted room
     * without re-minting the generation — so it compared a generation from the
     * reaped room against a room with no counter at all, read "superseded",
     * and returned. The second person to tap Call got a fully-connected call
     * behind a screen stuck on "Connecting…", with setState('joined'), the
     * BS-LEAK handle stash and setActiveGroupCall all skipped and the whole
     * mediasoup pipeline leaked. Both reviewers found it independently.
     *
     * It also protected nothing: no await separates
     * `rejoinRoomRef.current = rejoinRoom` from the terminal setState, so no
     * rejoin can interleave there.
     */
    expect(HOOK_SRC).not.toContain('boot.joined');
    // The ordinary teardown guard IS still required.
    const at = HOOK_SRC.indexOf('callStartedAtRef.current = Date.now();');
    expect(at).toBeGreaterThan(-1);
    const before = HOOK_SRC.slice(Math.max(0, at - 200), at);
    expect(before).toMatch(/if \(cancelled \|\| isLeavingRef\.current\) \{return;\}/);
  });

  it('the reconnect-budget expiry defers to a rebuild IN PROGRESS, and only that', () => {
    /**
     * G6's core stomp is a budget timer failing a call a rejoin has already
     * recovered. Round 1's first attempt asked "has a newer attempt superseded
     * the boot?" — which is permanently TRUE after the first rejoin of the
     * call's life, because the boot's generation never moves again. That
     * silently retired B-108's stated contract that this handler is "the only
     * terminal authority": a call whose ICE died later sat in 'reconnecting'
     * forever, holding the audio session, the foreground service and
     * launchCall's busy guard, with no way out but a force-quit.
     *
     * Asking whether a rebuild is running RIGHT NOW hands authority back the
     * moment it finishes — so this pin is about WHICH question is asked.
     */
    expect(HOOK_SRC).not.toContain('budget.expiry');
    const at = HOOK_SRC.indexOf('const onBudgetExpiry = ');
    expect(at).toBeGreaterThan(-1);
    const body = HOOK_SRC.slice(at, at + 1600);
    const guard = body.indexOf('if (isAttemptRunning(rid!)) {');
    const fails = body.indexOf("setState('failed')");
    expect(guard).toBeGreaterThan(-1);
    expect(fails).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(fails);
    // It must RE-ARM rather than return with a live deadline: the foreground
    // probe re-arms on a non-zero deadline, so a bare return would leave a
    // timer treadmill on a call that can never terminate.
    expect(body.slice(guard, fails)).toContain('startBudget();');
  });

  it('the 4s reconcile tick stands down while a rejoin holds the room', () => {
    const at = HOOK_SRC.indexOf('}, 4000);');
    expect(at).toBeGreaterThan(-1);
    // Window the INTERVAL CALLBACK only. A fixed look-back also swallowed the
    // immediate on-'joined' kick that sits just above it — which carries its
    // own `isAttemptRunning` call, so the assertion passed even with the
    // interval's guard deleted.
    const open = HOOK_SRC.lastIndexOf('setInterval(', at);
    expect(open).toBeGreaterThan(-1);
    const body = HOOK_SRC.slice(open, at);
    expect(body).toMatch(/if \(isAttemptRunning\(roomIdRef\.current \?\? ''\)\) \{return;\}/);
    expect(body).toContain('reconcileProducersRef.current?.()');

    // The immediate kick on entering 'joined' is guarded too — it fires at
    // exactly the moment a rejoin's setState('joined') lands.
    const kick = HOOK_SRC.slice(Math.max(0, open - 400), open);
    expect(kick).toMatch(/if \(!isAttemptRunning\(/);
  });

  it('the restore backfill does not resurrect CLOSED consumers', () => {
    // Membership in `consumersByPid` is not proof of a live consumer — the
    // reconcile tests `!closed` for exactly that reason. Marking a dead one's
    // producer as consumed makes it permanently unrecoverable: both
    // consumeProducer and the resume reconcile skip anything in that set, and
    // before WI-3.4 the empty-set restore self-healed it.
    //
    // Scanned rather than driven: producing a closed-consumer-at-adopt state
    // through the hook needs a consume to fail after `consumersByPid.set` but
    // before its tile flush, which the fakes cannot stage.
    const at = HOOK_SRC.indexOf('consumedProducerIdsRef.current.add(cx.producerId)');
    expect(at).toBeGreaterThan(-1);
    const block = HOOK_SRC.slice(Math.max(0, at - 400), at + 80);
    // THREE-part, to agree with the reconcile's own liveness test
    // (`live && !live.closed && track`). Round 2 shipped only two of the three:
    // an OPEN consumer with a null track is classified as needing re-consume by
    // the reconcile, so marking it consumed here left it permanently
    // unrecoverable — the same defect, narrowed rather than closed.
    expect(block).toMatch(/if \(cx\.producerId && !cx\.closed && cx\.track\)/);
  });

  it('the backfill and the reconcile agree on what "live" means', () => {
    // Pin the agreement itself, not just the backfill's shape: these two
    // predicates must move together or the disagreement re-opens silently.
    expect(HOOK_SRC).toMatch(
      /if \(live && !\(live as unknown as \{closed\?: boolean\}\)\.closed && track\)/,
    );
    const at = HOOK_SRC.indexOf('consumedProducerIdsRef.current.add(cx.producerId)');
    const block = HOOK_SRC.slice(Math.max(0, at - 400), at + 80);
    expect(block).toContain('cx.closed');
    expect(block).toContain('cx.track');
  });

  it('consumeProducer parks for ANOTHER attempt but not for its own', () => {
    // Both halves of the predicate matter and they fail in opposite
    // directions: drop `running !== null` and nothing ever parks; drop
    // `running !== attemptGen` and the rejoin refuses its own re-consume and
    // rebuilds an empty room.
    const at = HOOK_SRC.indexOf('const running = runningAttemptGen(');
    expect(at).toBeGreaterThan(-1);
    const block = HOOK_SRC.slice(at, at + 700);
    expect(block).toMatch(/if \(running !== null && running !== attemptGen\) \{/);
    // It parks into the early-producer buffer rather than dropping the frame:
    // no fresh sfu.new-producer is ever re-sent for an announced producer.
    expect(block).toContain('buf.accept(');
  });
});

/**
 * REVIEW ROUND 2 — the guards the review loop added.
 *
 * All of these live inside the boot IIFE's `rejoinRoom`, on paths that need two
 * overlapping rejoins with a controlled interleave to reach. They are scanned
 * rather than driven because the fakes cannot stage a stuck-claim takeover with
 * a late ack; every one of them survived a mutation until this block existed.
 */
describe('review round 2 — wiring (source scan)', () => {
  const SRC = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
  ).split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  it('R1 — the re-produced producers are published under a stale check, not pushed live', () => {
    // The header of `groupCallAttemptGen.ts` claims this write is guarded, and
    // for one round it was not: `reSendTx.produce()` is a full round-trip and
    // `attachSenderCryptor` another await, with the next checkpoint one await
    // too late — so a superseded attempt appended a producer bound to a
    // transport the WINNER had already closed into the winner's live array.
    expect(SRC).toContain('const newProducers: Producer[] = [];');
    expect(SRC).toContain('const newDetachers: Array<() => void> = [];');
    // The produce callbacks must NOT touch the refs directly.
    const from = SRC.indexOf('const newProducers: Producer[] = [];');
    const to   = SRC.indexOf("if (stale('rejoin.produced'))");
    expect(to).toBeGreaterThan(from);
    const producing = SRC.slice(from, to);
    expect(producing).toContain('newProducers.push(p)');
    expect(producing).toContain('newDetachers.push(detach)');
    expect(producing).not.toContain('producersRef.current.push(');
    expect(producing).not.toContain('sframeDetachersRef.current.push(');
    // …and the publish happens after the guard.
    const after = SRC.slice(to, to + 900);
    expect(after).toContain('producersRef.current.push(...newProducers)');
    expect(after).toContain('sframeDetachersRef.current.push(...newDetachers)');
  });

  it('R1 — a superseded attempt CLOSES what it built instead of leaking it', () => {
    const to = SRC.indexOf("if (stale('rejoin.produced'))");
    const block = SRC.slice(to, to + 500);
    expect(block).toMatch(/for \(const p of newProducers\)/);
    expect(block).toMatch(/p\.close\(\)/);
    expect(block).toMatch(/for \(const d of newDetachers\)/);
  });

  it('R2 — withTrackBlanked is depth-counted so nested blanking restores once', () => {
    // Two overlapping rejoins can blank the SAME track. The single-frame
    // version had the inner call record "was off" (the outer had already
    // blanked it) and decline to restore — leaving the mic or camera disabled
    // for the rest of the call while the UI showed it live.
    const at = SRC.indexOf('async function withTrackBlanked');
    expect(at).toBeGreaterThan(-1);
    const body = SRC.slice(at, at + 900);
    expect(body).toContain('blankedTracks');
    expect(body).toMatch(/rec\.depth \+= 1/);
    expect(body).toMatch(/rec\.depth -= 1/);
    // The ORIGINAL state is recorded once, by the outermost entrant.
    expect(body).toMatch(/existing \?\? \{depth: 0, wasEnabled: t\.enabled === true\}/);
    // …and restored only at the outermost exit.
    expect(body).toMatch(/if \(rec\.depth <= 0\)/);
  });

  it('S3 — the resume reconcile re-checks the rebuild mark AFTER its await', () => {
    // The entry guard is not enough: `sfu.producers` is a full WS round-trip,
    // and a rejoin taking the room inside it would find this loop adding to the
    // dedup sets it has just rebuilt.
    const at = SRC.indexOf("wsRequest<typeof resp>(ws, 'sfu.producers'");
    expect(at).toBeGreaterThan(-1);
    const after = SRC.slice(at, at + 700);
    expect(after).toMatch(/if \(isAttemptRunning\(rid\)\) \{return;\}/);
  });

  it('S5B — consumeProducer captures the in-flight set instead of re-reading it', () => {
    // A rejoin replaces the set; re-reading `.current` in the finally deleted
    // the WINNER's entry, switching the Fix-#12 dedup off for that producer.
    const at = SRC.indexOf('const inFlightSet = inFlightConsumes.current;');
    expect(at).toBeGreaterThan(-1);
    // Window has to reach the `finally`. B-482's dead-tile drop added lines
    // between the add and the release, and a fixed 1800 stopped short —
    // reporting a missing capture that was present.
    const body = SRC.slice(at, at + 2600);
    expect(body).toContain('inFlightSet.add(producerId)');
    expect(body).toContain('inFlightSet.delete(producerId)');
    expect(body).not.toContain('inFlightConsumes.current.delete(producerId)');
  });

  it('S5B — the rejoin REPLACES the dedup sets rather than clearing them in place', () => {
    const at = SRC.indexOf("if (stale('rejoin.enter'))");
    expect(at).toBeGreaterThan(-1);
    const rebuild = SRC.slice(at, at + 2500);
    expect(rebuild).toMatch(/inFlightConsumes\.current\s*=\s*new Set<string>\(\)/);
    expect(rebuild).toMatch(/consumedProducerIdsRef\.current\s*=\s*new Set<string>\(\)/);
    expect(rebuild).not.toContain('inFlightConsumes.current.clear()');
  });

  it('NEW-1 — a LATE ack cannot mint a newer generation than the attempt that replaced it', () => {
    /**
     * The generation is minted when `sfu.join` acks, so that an attempt which
     * never joins cannot supersede anything. That ordering is by ACK ARRIVAL,
     * which is safe only while attempts are serialised — and the 90 s
     * stuck-claim takeover exists precisely to break that, on the explicit
     * premise that the first attempt's ack can arrive late.
     *
     * Without this check the ABANDONED attempt's late ack mints the HIGHER
     * number and tears down the transports its replacement just built: the
     * exact interleaving the generation exists to prevent, on the one path
     * where two attempts are guaranteed to overlap.
     */
    const sites = SRC.split('attemptGen = beginAttempt(rid);');
    // Two mint sites (restore twin + boot twin), so three fragments.
    expect(sites).toHaveLength(3);
    for (const before of sites.slice(0, 2)) {
      const tail = before.slice(-400);
      expect(tail).toMatch(/if \(rejoinClaim !== currentGroupCallRejoinClaim\(\)\) \{/);
      expect(tail).toMatch(/return;/);
    }
  });
});

/**
 * B-477 / B-482 / B-483 — the findings the Phase 3 review logged and deferred.
 */
describe('B-477 — a rejoin republishes its handles to the mounted instance', () => {
  it('a restored instance re-adopts after the adopted rejoin rebuilds', async () => {
    /**
     * `rejoinRoom` is stashed and ADOPTED, so a restored instance runs the
     * ORIGINAL instance's closure — which writes the ORIGINAL instance's refs.
     * The restored hook was therefore left holding the transports that rejoin
     * had just closed: the resume reconcile issuing `recv.consume` against a
     * dead transport every 4 s, the audio-level poller bound to it,
     * `leaveInternal` closing the OLD pair so the new one leaked, and frozen
     * tiles whose consumerIds blocked any rebuild. None of it self-heals
     * inside the call.
     */
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;

    const first = await mount(baseOpts());
    expect(first.handle().state).toBe('joined');
    await run(() => patchActiveGroupCall(ROOM, {isMinimized: true, keepAlive: true}));
    first.unmount();
    await flush(3);

    const restored = await mount(baseOpts());
    expect(restored.handle().state).toBe('joined');
    (console.warn as unknown as jest.Mock).mockClear();

    // The socket bounces while the restored instance is the mounted one.
    await run(() => ws.fireReconnect());

    expect(ws.eventsNamed('sfu.join').length).toBeGreaterThan(1);
    expect(warnLines()).toContain('re-adopted republished handles');

    restored.unmount();
    await flush(3);
  });

  it('a rejoin with NO restored instance still works (the boot-only path)', async () => {
    // The notifier must not become a required participant: the common case has
    // exactly one instance, which owns its own refs already.
    ctl.liveWs = new FakeWs(joinerAck());
    const ws = ctl.liveWs;
    const rig = await mount(baseOpts());

    await run(() => ws.fireReconnect());

    expect(ws.eventsNamed('sfu.join')).toHaveLength(2);
    expect(rig.handle().state).toBe('joined');

    rig.unmount();
    await flush(3);
  });
});

describe('B-477 / B-482 / B-483 — wiring (source scan)', () => {
  const SRC2 = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
  ).split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  it('B-477 — the rejoin notifies AFTER republishing, not before', () => {
    // Notifying first would have every listener re-adopt the OLD stash.
    const set = SRC2.indexOf('liveSfuHandlesByRoom.set(rid!, {');
    expect(set).toBeGreaterThan(-1);
    const after = SRC2.slice(set, set + 1400);
    expect(after).toContain('notifyLiveSfuHandles(rid!)');
    const notify = after.indexOf('notifyLiveSfuHandles(rid!)');
    const close  = after.indexOf('});');
    expect(close).toBeGreaterThan(-1);
    expect(notify).toBeGreaterThan(close);
  });

  it('B-477 — the adopt is a single shared function, used by both callers', () => {
    // A second copy of the hydration is how the two paths drift apart.
    expect(SRC2).toContain('const adoptLiveHandles = useCallback(');
    expect(SRC2).toContain('subscribeLiveSfuHandles(roomId,');
    // The restore path must call it rather than inline its own copy.
    const restore = SRC2.indexOf('const stash = liveSfuHandlesByRoom.get(opts.roomId);');
    expect(restore).toBeGreaterThan(-1);
    expect(SRC2.slice(restore, restore + 200)).toContain('adoptLiveHandles(stash)');
  });

  it('B-482 — the consumed mark is gated on the consumer still being live', () => {
    // A rebuild that lands mid-consume closes the transport this was built on
    // and clears the map; marking the producer then strands it behind both
    // dedup guards forever.
    const at = SRC2.indexOf('const consumerId = await attemptConsume(');
    expect(at).toBeGreaterThan(-1);
    const block = SRC2.slice(at, at + 700);
    expect(block).toMatch(/if \(consumersByPid\.current\.has\(consumerId\)\) \{/);
    expect(block).toContain('consumedProducerIdsRef.current.add(producerId)');
    // attemptConsume must report the id, not a bare boolean.
    expect(SRC2).toMatch(/attemptConsume\([^)]*\): Promise<string \| null>/);
  });

  it('B-483 — a superseded transport cannot drive the live call', () => {
    const at = SRC2.indexOf('const onTxState = ');
    expect(at).toBeGreaterThan(-1);
    const head = SRC2.slice(at, at + 900);
    expect(head).toMatch(/source: unknown/);
    expect(head).toMatch(/if \(source && owner && source !== owner\) \{/);
    // Every registration names the transport it belongs to — the param is
    // required so a missed site is a compile error.
    const regs = SRC2.match(/onTxState\('(send|recv)', s[^)]*\)/g) ?? [];
    expect(regs).toHaveLength(4);
    for (const r of regs) {expect(r).toMatch(/, (sendTx|recvTx|reSendTx|reRecvTx)\)/);}
  });
});

describe('round 4 — the tile half of B-477 and B-482', () => {
  const SRC3 = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'useGroupCall.ts'), 'utf8',
  ).split(/\r?\n/)
    .filter(l => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  it('B-477 — re-adoption also refreshes the TILES, from the registry', () => {
    /**
     * Adopting the refs alone left the restored instance holding pre-rejoin
     * tiles whose streams come from consumers the rebuild closed. Nothing
     * repairs them: the resume reconcile keys `haveTile` on producerId (which
     * does not change across a rejoin) and has no prune branch. Video heals
     * only when the stall watchdog rebuilds it; AUDIO NEVER DOES.
     *
     * The source has to be the REGISTRY, not our own tiles filtered against
     * `consumersByPid`: the rejoin's `setRemoteTiles` calls land on the
     * instance that owns the closure, so filtering would leave this instance
     * with none at all.
     */
    const at = SRC3.indexOf('const reAdopt = (): void => {');
    expect(at).toBeGreaterThan(-1);
    const body = SRC3.slice(at, at + 900);
    expect(body).toContain('adoptLiveHandles(fresh)');
    expect(body).toContain('getActiveGroupCall()');
    expect(body).toMatch(/setRemoteTiles\(live\.remoteTiles \?\? \[\]\)/);
    // Guarded on the room, so a successor call's tiles can never be painted in.
    expect(body).toMatch(/live\.roomId === roomId/);
  });

  it('B-477 — the subscription adopts once on subscribe, not only on notify', () => {
    // The restore branch adopts while `roomId` state is still null, so this
    // effect does not subscribe until the next commit; a republish in that
    // window would be missed permanently, as nothing re-reads the stash.
    const at = SRC3.indexOf('const reAdopt = (): void => {');
    const after = SRC3.slice(at, at + 1400);
    const call = after.indexOf('reAdopt();');
    const sub  = after.indexOf('subscribeLiveSfuHandles(roomId, reAdopt)');
    expect(call).toBeGreaterThan(-1);
    expect(sub).toBeGreaterThan(call);
  });

  it('B-482 — a consume that lands on a dead transport drops its tile too', () => {
    // `attemptConsume` registers the tile BEFORE returning the id, so leaving
    // it behind gives the participant a permanently blank cell alongside the
    // live one the rebuild creates — and neither reconcile removes it.
    const at = SRC3.indexOf('not marking consumed');
    expect(at).toBeGreaterThan(-1);
    const after = SRC3.slice(at, at + 600);
    expect(after).toMatch(/setRemoteTiles\(prev => \{/);
    expect(after).toMatch(/t\.consumerId !== consumerId/);
  });
});
