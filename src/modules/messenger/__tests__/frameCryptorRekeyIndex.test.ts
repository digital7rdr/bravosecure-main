/**
 * "When someone has been added to a group or removed, that key distribution
 * problem still happens â€” call connected but video and sound I can't hear, and
 * the other person can't hear my video and sound."
 *
 * ROOT CAUSE. `setKey(provider, tag, idx, key)` loads new material into the key
 * PROVIDER. It does NOT change which index a cryptor encrypts or decrypts with.
 * That is a separate call â€” `setCryptorKeyIndex(cryptorId, idx)` â€” which
 * existed in frameCryptorTransport from the start and had **no callers at all**
 * in production code.
 *
 * So a mid-call rekey (member add/remove advances the epoch) pushed the new key
 * everywhere and then left every cryptor pointed at the OLD index: our sender
 * kept encrypting at the old index while every peer had been handed the new
 * one, and symmetrically we kept decrypting at the old index. The call stayed
 * "connected" with dead audio and video in BOTH directions â€” exactly the
 * reported symptom, and why it looked like key corruption rather than a call
 * failure.
 *
 * The orchestrator is plain TS (the native module is behind frameCryptorTransport),
 * so this is a real behavioural test with the transport mocked.
 */
// The mocks are created INSIDE the factory and read back after the import.
// jest.mock is hoisted above these declarations, so a factory that closes over
// module-level consts sees them in the temporal dead zone â€” babel compiles
// them to `var`, so they arrive as `undefined` rather than throwing, and every
// transport function silently becomes 'not a function'.
jest.mock('../webrtc/frameCryptorTransport', () => ({
  isAvailable: () => true,
  createKeyProvider: jest.fn(() => Promise.resolve('kp-1')),
  setKey:             jest.fn(() => Promise.resolve()),
  attachSender:       jest.fn(() => Promise.resolve('cryptor-send')),
  attachReceiver:     jest.fn(() => Promise.resolve('cryptor-recv')),
  setCryptorEnabled:  jest.fn(() => Promise.resolve()),
  setCryptorKeyIndex: jest.fn(() => Promise.resolve()),
  disposeCryptor:     jest.fn(() => Promise.resolve()),
  disposeKeyProvider: jest.fn(() => Promise.resolve()),
  getPeerConnectionNumericId: () => 7,
}));

jest.mock('@bravo/messenger-core', () => ({
  deriveParticipantKey: (_m: string, epoch: number, tag: string) =>
    Promise.resolve(`key-${tag}-e${epoch}`),
  // The real mapping is epoch % N; identity keeps the assertions readable and
  // still proves the INDEX MOVES with the epoch, which is the whole point.
  // Delegated through a mutable impl so the #17 wrap-guard test can swap in
  // the REAL ring clamp (the wrap case is unreachable under identity).
  epochToKeyIndex: (epoch: number) => mockEpochToKeyIndexImpl(epoch),
}));

// var (not let): hoisted above the jest.mock factory.
var mockEpochToKeyIndexImpl: (e: number) => number = (e) => e;

import * as transport from '../webrtc/frameCryptorTransport';

const mockSetKey             = transport.setKey as unknown as jest.Mock;
const mockAttachSender       = transport.attachSender as unknown as jest.Mock;
const mockAttachReceiver     = transport.attachReceiver as unknown as jest.Mock;
const mockSetCryptorEnabled  = transport.setCryptorEnabled as unknown as jest.Mock;
const mockSetCryptorKeyIndex = transport.setCryptorKeyIndex as unknown as jest.Mock;
const mockDisposeCryptor     = transport.disposeCryptor as unknown as jest.Mock;

import {FrameCryptorOrchestrator} from '../webrtc/frameCryptorOrchestrator';

/** A key source whose epoch we can advance, like a member add/remove does. */
function makeSource(start = 0) {
  let cur = {masterKeyB64: 'MASTER', epoch: start};
  let listener: ((n: {masterKeyB64: string; epoch: number}) => void) | null = null;
  return {
    src: {
      current: () => cur,
      subscribe: (_id: string, cb: (n: {masterKeyB64: string; epoch: number}) => void) => {
        listener = cb;
        return () => { listener = null; };
      },
    },
    rekey: async (epoch: number) => {
      cur = {masterKeyB64: 'MASTER', epoch};
      listener?.(cur);
      // let the orchestrator's async rotate() settle
      await new Promise(r => setTimeout(r, 0));
    },
  };
}

async function boot(startEpoch = 0) {
  const {src, rekey} = makeSource(startEpoch);
  const o = new FrameCryptorOrchestrator({conversationId: 'c1', selfTag: 'self', keySource: src});
  await o.init();
  const detachSend = await o.attachSenderCryptor({id: 's'}, {}, 'audio');
  const detachRecv = await o.attachReceiverCryptor({id: 'r'}, {}, 'peer-a');
  return {o, rekey, detachSend, detachRecv};
}

beforeEach(() => {
  // Re-arm every test: the project config resets mock implementations between
  // tests, so setting them at declaration time only works for the first one.
  jest.clearAllMocks();
  mockSetKey.mockResolvedValue(undefined);
  mockAttachSender.mockResolvedValue('cryptor-send');
  mockAttachReceiver.mockResolvedValue('cryptor-recv');
  mockSetCryptorEnabled.mockResolvedValue(undefined);
  mockSetCryptorKeyIndex.mockResolvedValue(undefined);
  mockDisposeCryptor.mockResolvedValue(undefined);
});

describe('a mid-call rekey switches every cryptor to the new key index', () => {
  it('tells the SENDER cryptor to move â€” otherwise we encrypt at a stale index', () => {
    // The bug in one assertion: peers get the new key, we keep sending the old
    // index, and nobody can decrypt us.
    return boot().then(async ({rekey}) => {
      mockSetCryptorKeyIndex.mockClear();
      await rekey(3);
      expect(mockSetCryptorKeyIndex).toHaveBeenCalledWith('cryptor-send', 3);
    });
  });

  it('tells every RECEIVER cryptor to move â€” otherwise we decrypt at a stale index', async () => {
    const {rekey} = await boot();
    mockSetCryptorKeyIndex.mockClear();
    await rekey(3);
    expect(mockSetCryptorKeyIndex).toHaveBeenCalledWith('cryptor-recv', 3);
  });

  it('still pushes the new KEY as well â€” the index alone is not enough', async () => {
    const {rekey} = await boot();
    mockSetKey.mockClear();
    await rekey(3);
    expect(mockSetKey).toHaveBeenCalled();
    // Key material AND index both move to the new epoch.
    expect(mockSetKey.mock.calls.every(c => c[2] === 3)).toBe(true);
  });

  it('a cryptor attached MID-CALL starts at the current epoch, not 0', async () => {
    // Someone joining after a rekey would otherwise be born on the wrong index.
    const {o} = await boot(5);
    mockSetCryptorKeyIndex.mockClear();
    await o.attachReceiverCryptor({id: 'r2'}, {}, 'peer-b');
    expect(mockSetCryptorKeyIndex).toHaveBeenCalledWith('cryptor-recv', 5);
  });

  it('a detached cryptor is not re-indexed on later rekeys', async () => {
    // Calling into a disposed native cryptor is at best a warning per rekey.
    const {rekey, detachRecv} = await boot();
    detachRecv();
    mockSetCryptorKeyIndex.mockClear();
    await rekey(2);
    expect(mockSetCryptorKeyIndex).not.toHaveBeenCalledWith('cryptor-recv', 2);
    expect(mockSetCryptorKeyIndex).toHaveBeenCalledWith('cryptor-send', 2);
  });

  it('one failing cryptor does not stop the others moving', async () => {
    // Same independence rule the per-tag key push already had (audit GC-07):
    // a single failure must not strand everyone else on the old index.
    const {rekey} = await boot();
    mockSetCryptorKeyIndex.mockClear();
    mockSetCryptorKeyIndex.mockRejectedValueOnce(new Error('native boom'));
    await rekey(4);
    expect(mockSetCryptorKeyIndex).toHaveBeenCalledTimes(2);
  });

  it('dispose drops the tracked cryptors', async () => {
    const {o, rekey} = await boot();
    o.dispose();
    mockSetCryptorKeyIndex.mockClear();
    await rekey(6);
    expect(mockSetCryptorKeyIndex).not.toHaveBeenCalled();
  });
});

// --- AUDIT-2026-08-13 #17 --- the superseded key index is RETIRED ---------
describe('AUDIT #17 --- old-epoch call keys do not stay live for the rest of the call', () => {
  it('overwrites the superseded index with GARBAGE for every tag, after the grace window', async () => {
    // The native ring (16 slots) otherwise keeps the old epoch keys
    // addressable forever: a REMOVED member (old master key + SFU reach
    // --- the architecture does not trust SFU access control) could inject
    // frames at the old index that every peer still decrypts.
    const {rekey} = await boot();
    jest.useFakeTimers();
    try {
      const p = rekey(3);
      await jest.advanceTimersByTimeAsync(1); // settle rotate; retire timer armed
      await p;
      mockSetKey.mockClear();
      await jest.advanceTimersByTimeAsync(10_000); // the grace elapses
      const retireCalls = mockSetKey.mock.calls.filter(c => c[2] === 2); // idx(epoch-1)
      expect(retireCalls.length).toBeGreaterThanOrEqual(2); // self + peer-a
      // GARBAGE, never derived material (derived keys are `key-<tag>-e<epoch>`).
      expect(retireCalls.every(c => !String(c[3]).startsWith('key-'))).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  it('back-to-back rekeys retire EVERY superseded index, not just the latest (critic MUST-FIX)', async () => {
    // FLIPPED 2026-08-14: the first version of this test pinned
    // latest-wins supersession as the contract â€” which left the MIDDLE
    // epoch's index (idx-2 here) live for the rest of the call after a
    // 3â†’4 rekey burst, the exact defect #17 exists to kill. Each
    // superseded epoch now owns its own retire timer.
    const {rekey} = await boot();
    jest.useFakeTimers();
    try {
      const p1 = rekey(3); await jest.advanceTimersByTimeAsync(1); await p1;
      const p2 = rekey(4); await jest.advanceTimersByTimeAsync(1); await p2;
      mockSetKey.mockClear();
      await jest.advanceTimersByTimeAsync(10_000);
      const garbageAt = (idx: number) =>
        mockSetKey.mock.calls.filter(c => c[2] === idx && !String(c[3]).startsWith('key-'));
      // BOTH superseded indexes are garbaged, each on its own timer.
      expect(garbageAt(2).length).toBeGreaterThanOrEqual(2); // middle epoch â€” the old gap
      expect(garbageAt(3).length).toBeGreaterThanOrEqual(2);
      // The LIVE index (epoch 4) is never garbaged.
      expect(garbageAt(4)).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('dispose() cancels every pending retire (no post-teardown native calls)', async () => {
    const {rekey, o} = await boot();
    jest.useFakeTimers();
    try {
      const p1 = rekey(3); await jest.advanceTimersByTimeAsync(1); await p1;
      const p2 = rekey(4); await jest.advanceTimersByTimeAsync(1); await p2;
      o.dispose();
      mockSetKey.mockClear();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(mockSetKey).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

// --- #17 edge D3 --- epoch 0 must never schedule a retire ----------------
describe('AUDIT #17 --- a rotate at epoch 0 schedules NO retire', () => {
  it('same-epoch master-key change at epoch 0 (G-04 fork heal) never garbages idx 0', async () => {
    // epochToKeyIndex(-1) clamps to 0 --- the LIVE index. The `epoch >= 1`
    // arm guard (and, belt-and-braces, the fire-time wrap guard) is the
    // only thing between a fork-heal at epoch 0 and the orchestrator
    // destroying its own call key 10s in.
    const {rekey} = await boot(0);
    jest.useFakeTimers();
    try {
      const p = rekey(0); // same-epoch key change --- the fork-heal shape
      await jest.advanceTimersByTimeAsync(1);
      await p;
      mockSetKey.mockClear();
      await jest.advanceTimersByTimeAsync(11_000);
      const garbage = mockSetKey.mock.calls.filter(c => !String(c[3]).startsWith('key-'));
      expect(garbage).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });
});

// --- #17 edge rev-2 --- the fire-time wrap guard is load-bearing ----------
describe('AUDIT #17 --- a stale timer whose slot WRAPPED onto the live index never fires', () => {
  it('epoch-1 timer pending while the call reaches epoch 16: idx 0 is LIVE and must not be garbaged', async () => {
    // Real ring clamp: idx(0) === idx(16) === 0. A stale epoch-1 retire
    // timer targets idx 0; by fire time the wrap has made idx 0 the
    // CURRENT key slot. Without the wrap guard the timer overwrites the
    // working key with random bytes and every participant's media dies
    // for the rest of the call --- silently (measured by the edge
    // reviewer; the removal mutant was green before this test).
    const real = jest.requireActual('@bravo/messenger-core') as {epochToKeyIndex: (e: number) => number};
    mockEpochToKeyIndexImpl = real.epochToKeyIndex;
    try {
      const {rekey} = await boot(0);
      jest.useFakeTimers();
      try {
        const p1 = rekey(1); await jest.advanceTimersByTimeAsync(1); await p1;   // arms retire of idx(0)=0
        const p2 = rekey(16); await jest.advanceTimersByTimeAsync(1); await p2;  // live idx becomes 0 again
        mockSetKey.mockClear();
        await jest.advanceTimersByTimeAsync(10_000);
        // The stale epoch-1 timer fired (16 >= 1) but its target is the
        // live index --- the wrap guard must skip it entirely...
        const liveIdxGarbage = mockSetKey.mock.calls.filter(
          c => c[2] === 0 && !String(c[3]).startsWith('key-'));
        expect(liveIdxGarbage).toHaveLength(0);
        // ...while the epoch-16 timer legitimately retires idx(15)=15.
        const idx15 = mockSetKey.mock.calls.filter(
          c => c[2] === 15 && !String(c[3]).startsWith('key-'));
        expect(idx15.length).toBeGreaterThanOrEqual(2);
      } finally {
        jest.useRealTimers();
      }
    } finally {
      mockEpochToKeyIndexImpl = (e) => e;
    }
  });
});
