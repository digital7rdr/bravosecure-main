/**
 * WI-2.1 / WI-2.2 — the 1:1 state machine proper.
 *
 * Before this, the ONLY enforced rule in `CallController.setState` was
 * terminal-absorption. Everything else was reachable, and one illegal
 * transition is live on the dominant outgoing path:
 *
 *   `handleAnswer` awaits `acceptAnswer` then `drainPendingIce`, and only
 *   THEN calls `setState('connecting')`. Its guards check `ended`/`failed`
 *   and nothing else. So when ICE + DTLS complete during those awaits — the
 *   fast-ICE case, and the reason `calling → connected` is a real row — the
 *   late write drags a live call `connected → connecting`, and `setState`
 *   re-arms the 20 s connecting watchdog against it. Twenty seconds later a
 *   healthy call is hung up as `failed`.
 *
 * WI-2.2: one controller = one call. `end()`'s "clean slate" resets and
 * `startOutgoing`'s `state === 'idle'` requirement imply reuse is supported,
 * but terminal-absorption makes it impossible — and a reused instance would
 * inherit `everConnected = true`, faking a 30 s reconnect budget on a fresh
 * call's TURN failure (the B-41 class).
 */

import {CallSignalling} from '../webrtc/signallingClient';
import {CallController} from '../webrtc/callController';
import type {PeerConnectionLike, PeerConnectionFactory, StatsReport} from '../webrtc/types';
import type {TransportClient, ClientFrame} from '@bravo/messenger-core';

const FP = 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99';
const sdp = (label: string) =>
  `v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\na=fingerprint:sha-256 ${FP}\r\nx-label=${label}\r\n`;

function fakeTransport(initial = 'connected') {
  const sent: ClientFrame[] = [];
  const t = {
    state: initial,
    send: (f: ClientFrame) => {
      if (t.state !== 'connected') {throw new Error('transport not open');}
      sent.push(f);
    },
  };
  return {sent, t, transport: t as unknown as TransportClient};
}

type MutablePeer = PeerConnectionLike & {iceConnectionState?: string};

/**
 * `acceptAnswerGate` is the whole point of this harness: it lets a test hold
 * `handleAnswer` inside its await while ICE completes underneath, which is the
 * real-world fast-ICE ordering and is otherwise not reproducible.
 */
function fakePeer(gate?: () => Promise<void>): MutablePeer {
  return {
    createOffer:  async () => ({type: 'offer',  sdp: sdp('offer')}),
    createAnswer: async () => ({type: 'answer', sdp: sdp('answer')}),
    setLocalDescription:  async () => {},
    setRemoteDescription: async () => { if (gate) {await gate();} },
    addIceCandidate:      async () => {},
    addTrack:             () => {},
    close:                () => {},
    getStats: async () => new Map<string, StatsReport>([
      ['t0', {type: 'transport', dtlsState: 'connected', srtpCipher: 'AEAD_AES_128_GCM', remoteCertificateId: 'cr'}],
      ['cr', {type: 'certificate', id: 'cr', fingerprint: FP, fingerprintAlgorithm: 'sha-256'}],
    ]),
    oniceconnectionstatechange: null,
    onicecandidate:             null,
    ontrack:                    null,
  };
}

const PEER_BOB = {userId: 'bob', deviceId: 1};

function build(opts: {connectingWatchdogMs?: number; acceptAnswerGate?: () => Promise<void>} = {}) {
  const {sent, transport} = fakeTransport();
  const signalling = new CallSignalling(transport);
  const peers: MutablePeer[] = [];
  const pcFactory: PeerConnectionFactory = () => {
    const p = fakePeer(opts.acceptAnswerGate);
    peers.push(p);
    return p;
  };
  const states: string[] = [];
  const controller = new CallController({
    signalling,
    pcFactory,
    iceServers: [],
    onState:       s => states.push(s),
    onMissedCall:  jest.fn(),
    ringTimeoutMs: 60_000,
    connectingWatchdogMs: opts.connectingWatchdogMs ?? 1000,
  });
  return {controller, signalling, sent, states, peers};
}

const flush = async (n = 12): Promise<void> => {
  for (let i = 0; i < n; i++) {await Promise.resolve();}
};

/** Drive the peer's ICE agent to connected, as the engine would. */
async function driveIceConnected(peer: MutablePeer): Promise<void> {
  peer.iceConnectionState = 'connected';
  peer.oniceconnectionstatechange?.('connected');
  await flush();
}

beforeEach(() => { jest.useFakeTimers(); jest.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(()  => { jest.useRealTimers(); jest.restoreAllMocks(); });

// ────────────────────────────────────────────────────────────────────
describe('WI-2.1 — a late answer must not drag a connected call back to connecting', () => {
  it('THE RACE: answer processing starts → ICE connects → answer processing finishes', async () => {
    // Hold `handleAnswer` inside `acceptAnswer`, connect ICE underneath, then
    // let the answer finish. This is the fast-ICE ordering, and it is the only
    // way `connected → connecting` is reachable.
    let releaseAccept!: () => void;
    const gate = new Promise<void>(r => { releaseAccept = r; });
    const {controller, signalling, states, peers, sent} =
      build({acceptAnswerGate: () => gate, connectingWatchdogMs: 1000});

    await controller.startOutgoing({callId: 'c-race', peer: PEER_BOB, kind: 'voice'});
    await flush();
    expect(controller.currentState).toBe('calling');

    // The answer lands and stalls inside setRemoteDescription.
    signalling.ingest({event: 'call.answer', data: {callId: 'c-race', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();

    // ICE + DTLS complete while the answer is still being applied.
    await driveIceConnected(peers[0]);
    expect(controller.currentState).toBe('connected');

    // Now the answer finishes and tries its `setState('connecting')`.
    releaseAccept();
    await flush(20);

    // The call must STILL be connected — the state is unchanged, not merely
    // warned about.
    expect(controller.currentState).toBe('connected');
    expect(states.filter(s => s === 'connecting')).toHaveLength(0);

    // …and the watchdog must not have been re-armed against a healthy call.
    jest.advanceTimersByTime(5_000);
    await flush();
    expect(controller.currentState).toBe('connected');
    expect(sent.find(f => f.event === 'call.hangup')).toBeUndefined();
  });

  it('logs the rejection on the [CALLSM] lane', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseAccept!: () => void;
    const gate = new Promise<void>(r => { releaseAccept = r; });
    const {controller, signalling, peers} = build({acceptAnswerGate: () => gate});

    await controller.startOutgoing({callId: 'c-log', peer: PEER_BOB, kind: 'voice'});
    await flush();
    signalling.ingest({event: 'call.answer', data: {callId: 'c-log', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    await driveIceConnected(peers[0]);
    warn.mockClear();
    releaseAccept();
    await flush(20);

    const lines = warn.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes('[CALLSM]') && l.includes('illegal') && l.includes('connected') && l.includes('connecting'))).toBe(true);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.1 — the legal transition table', () => {
  it('`calling → connected` IS legal — fast ICE on the caller reaches it', async () => {
    // Traced, not assumed: for the caller, ICE can only connect once the answer's
    // remote description is applied — which `handleAnswer` does BEFORE its
    // `setState('connecting')`. So `connected` is genuinely reachable while the
    // state is still `calling`, and the row must be in the table.
    let releaseAccept!: () => void;
    const gate = new Promise<void>(r => { releaseAccept = r; });
    const {controller, signalling, peers, states} = build({acceptAnswerGate: () => gate});

    await controller.startOutgoing({callId: 'c-fast', peer: PEER_BOB, kind: 'voice'});
    await flush();
    signalling.ingest({event: 'call.answer', data: {callId: 'c-fast', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    await driveIceConnected(peers[0]);

    // The property that matters: 'connected' is reached DIRECTLY from
    // 'calling', with no 'connecting' in between. (`connected → connected`
    // repeats are emitted by both the ICE handler and the DTLS poll; a
    // self-transition is not a rejected one, and de-duping it would be an
    // unaudited change to what every onState consumer sees.)
    expect(states[0]).toBe('calling');
    expect(states).toContain('connected');
    expect(states).not.toContain('connecting');
    expect(controller.currentState).toBe('connected');
    releaseAccept();
    await flush();
  });

  it('terminal absorption survives — nothing resurrects an ended call', async () => {
    const {controller, signalling, peers, states} = build();
    controller.handleIncomingOffer({callId: 'c-term', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await controller.accept();
    await flush();
    controller.hangup('ended');
    await flush();
    expect(controller.currentState).toBe('ended');

    // Every late path that could write state.
    await driveIceConnected(peers[0]);
    signalling.ingest({event: 'call.answer', data: {callId: 'c-term', from: PEER_BOB, sdp: sdp('late')}});
    await flush(20);

    expect(controller.currentState).toBe('ended');
    expect(states.filter(s => s === 'connected')).toHaveLength(0);
  });

  it('a RINGING callee has no PeerConnection yet — but accept() builds one before writing connecting', async () => {
    const {controller, peers, states} = build();
    controller.handleIncomingOffer({callId: 'c-ring', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await flush();
    expect(controller.currentState).toBe('ringing');
    expect(peers).toHaveLength(0);
    expect(states).toEqual(['ringing']);
  });

  it('`ringing → connected` IS legal — accept() builds the PC before the connecting write', async () => {
    // REVIEW CORRECTION. The first cut of the table omitted this row on the
    // premise that "the callee builds its PeerConnection inside accept(), so
    // there is no ICE agent to connect before the 'connecting' transition".
    // That is not what the code does: `acceptInner` builds the PC and applies
    // the local description well before it writes 'connecting', with the remote
    // candidates already drained. Same class as the caller's window, narrower.
    // Rejecting it did not lose the call — the DTLS poll and the watchdog's ICE
    // re-probe both promote — but it STALLED it, and a table that rejects a
    // reachable transition is a table that lies.
    let releaseRemote!: () => void;
    const gate = new Promise<void>(r => { releaseRemote = r; });
    const {controller, peers, states} = build({acceptAnswerGate: () => gate});

    controller.handleIncomingOffer({callId: 'c-ring2', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await flush();
    void controller.accept();
    await flush();
    expect(peers.length).toBeGreaterThan(0);   // the PC exists while still 'ringing'
    expect(controller.currentState).toBe('ringing');

    await driveIceConnected(peers[0]);
    expect(controller.currentState).toBe('connected');
    expect(states).toContain('connected');

    releaseRemote();
    await flush(20);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.2 — one controller = one call', () => {
  it('a used instance refuses a second startOutgoing', async () => {
    const {controller} = build();
    await controller.startOutgoing({callId: 'c-reuse-1', peer: PEER_BOB, kind: 'voice'});
    await flush();
    controller.hangup('ended');
    await flush();

    await expect(
      controller.startOutgoing({callId: 'c-reuse-2', peer: PEER_BOB, kind: 'voice'}),
    ).rejects.toThrow(/one call/i);
  });

  /**
   * CORRECTION — my first draft asserted `handleIncomingOffer` THROWS on a
   * second, different callId. That is wrong, and the tests caught it: a
   * different caller's offer arriving while we are busy must be answered
   * `busy` on the wire. Throwing would break that protocol response and the
   * B-320 / call-waiting behaviour built on it. What WI-2.2 actually requires
   * is that the instance is not REUSED — no descriptor overwrite, no state
   * change — and the busy bounce already satisfies that. Pinned as such.
   */
  it('a DIFFERENT callId is answered `busy` and never adopted (not thrown)', async () => {
    const {controller, sent} = build();
    controller.handleIncomingOffer({callId: 'c-reuse-3', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await flush();
    const claimed = controller.currentCall;

    controller.handleIncomingOffer({callId: 'c-reuse-4', from: PEER_BOB, sdp: sdp('inb2'), kind: 'voice'});
    await flush();

    const busy = sent.filter(f => f.event === 'call.hangup' &&
      (f as {data: {reason?: string; callId: string}}).data.reason === 'busy');
    expect(busy).toHaveLength(1);
    expect((busy[0] as {data: {callId: string}}).data.callId).toBe('c-reuse-4');
    // The instance still belongs to the FIRST call.
    expect(controller.currentCall).toBe(claimed);
    expect(controller.currentCall?.callId).toBe('c-reuse-3');
  });

  it('an outgoing instance answers `busy` to a different incoming call, keeping its own', async () => {
    const {controller, sent} = build();
    await controller.startOutgoing({callId: 'c-mixed', peer: PEER_BOB, kind: 'voice'});
    await flush();

    controller.handleIncomingOffer({callId: 'c-other', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await flush();

    expect(sent.some(f => f.event === 'call.hangup' &&
      (f as {data: {reason?: string}}).data.reason === 'busy')).toBe(true);
    expect(controller.currentCall?.callId).toBe('c-mixed');
    expect(controller.currentState).toBe('calling');
  });

  it('reuse cannot inherit everConnected (the B-41 fake reconnect budget)', async () => {
    // A reused instance that kept `everConnected = true` would grant a FRESH
    // call the 30 s mid-call reconnect budget on its very first TURN failure,
    // instead of failing fast. Proving the refusal is what makes that
    // unreachable.
    const {controller, signalling, peers} = build();
    await controller.startOutgoing({callId: 'c-ever', peer: PEER_BOB, kind: 'voice'});
    await flush();
    signalling.ingest({event: 'call.answer', data: {callId: 'c-ever', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    await driveIceConnected(peers[0]);
    expect(controller.currentState).toBe('connected');
    controller.hangup('ended');
    await flush();

    await expect(
      controller.startOutgoing({callId: 'c-ever-2', peer: PEER_BOB, kind: 'voice'}),
    ).rejects.toThrow(/one call/i);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.5 — a replayed offer for our OWN call is not a busy bounce', () => {
  it('the same callId re-offer is ignored, not answered `busy`', async () => {
    // Without the carve-out, wiring an offer replay through to the controller
    // would answer the caller `busy` and kill the call it is trying to rescue.
    const {controller, sent} = build();
    controller.handleIncomingOffer({callId: 'c-dup', from: PEER_BOB, sdp: sdp('inb'), kind: 'voice'});
    await flush();
    expect(controller.currentState).toBe('ringing');

    controller.handleIncomingOffer({callId: 'c-dup', from: PEER_BOB, sdp: sdp('inb-replay'), kind: 'voice'});
    await flush();

    expect(controller.currentState).toBe('ringing');
    const hangups = sent.filter(f => f.event === 'call.hangup');
    expect(hangups).toHaveLength(0);
  });
});

// ────────────────────────────────────────────────────────────────────
describe('WI-2.1 — the [CALLSM] illegal line names its caller (WI-7.1)', () => {
  const {readFileSync} = require('node:fs') as typeof import('node:fs');
  const {join} = require('node:path') as typeof import('node:path');

  /** Comment lines stripped; CRLF-safe. */
  const CODE = readFileSync(
    join(process.cwd(), 'src', 'modules', 'messenger', 'webrtc', 'callController.ts'), 'utf8',
  ).split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

  it('EVERY setState call site passes a src label', () => {
    // Without this the whole diagnostic is inert: `src=unknown` on every
    // rejection, and four different sites write `connected`, so a logcat
    // cannot say which one was refused. WI-7.1 requires the lifecycle to be
    // reconstructable from the log.
    const unlabelled = CODE.split('\n')
      .map((l, i) => [i + 1, l] as const)
      .filter(([, l]) => /this\.setState\([^,)]*\)\s*;/.test(l))
      .map(([n, l]) => `${n}: ${l.trim()}`);
    expect(unlabelled).toEqual([]);
  });

  it('POSITIVE CONTROL — the scanner sees the real call sites', () => {
    const labelled = CODE.match(/this\.setState\([^)]*,\s*'[\w-]+'\)/g) ?? [];
    expect(labelled.length).toBeGreaterThanOrEqual(10);
  });

  it('the rejection line carries the label, not the default', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let releaseAccept!: () => void;
    const gate = new Promise<void>(r => { releaseAccept = r; });
    const {controller, signalling, peers} = build({acceptAnswerGate: () => gate});

    await controller.startOutgoing({callId: 'c-src', peer: PEER_BOB, kind: 'voice'});
    await flush();
    signalling.ingest({event: 'call.answer', data: {callId: 'c-src', from: PEER_BOB, sdp: sdp('ans')}});
    await flush();
    await driveIceConnected(peers[0]);
    warn.mockClear();
    releaseAccept();
    await flush(20);

    const line = warn.mock.calls.map(c => String(c[0])).find(l => l.includes('[CALLSM] illegal'));
    expect(line).toBeDefined();
    expect(line).toContain('src=handleAnswer');
    expect(line).not.toContain('src=unknown');
  });
});
