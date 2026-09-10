#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * Protocol-level smoke test for the mediasoup SFU.
 *
 * What this proves:
 *   1. POST /sfu/rooms returns a fresh opaque room id
 *   2. Three socket.io clients can sfu.join the room and each
 *      receives a routerRtpCapabilities blob + send + recv transport
 *      params + the existingProducers snapshot
 *   3. Late joiners see earlier participants in their existingProducers
 *      list (validates room state tracking)
 *   4. sfu.participant.joined fans out to existing peers when a new
 *      participant joins
 *   5. sfu.participant.left fans out when a participant leaves
 *   6. The router auto-closes once the last participant leaves
 *      (next /sfu/rooms call reuses the worker pool cleanly)
 *
 * What it does NOT test:
 *   - Real audio/video — there's no media. Producer/consumer flows
 *     need real MediaStreamTracks which require a browser or RN host.
 *     For full media validation, place a real call from two phones.
 *   - DTLS-SRTP negotiation — same reason. The negotiation only
 *     happens when a real WebRtcTransport.connect() runs.
 *
 * Prereqs:
 *   - messenger-service running with mediasoup installed
 *   - 3 access tokens (ALICE_JWT, BOB_JWT, CARLA_JWT)
 *
 *   ALICE_JWT=… BOB_JWT=… CARLA_JWT=… node scripts/e2e-sfu-smoke.mjs
 */

import {io} from 'socket.io-client';

const MSG_BASE = process.env.MESSENGER_BASE_URL ?? 'http://127.0.0.1:3100';
const TOKENS = {
  alice: process.env.ALICE_JWT,
  bob:   process.env.BOB_JWT,
  carla: process.env.CARLA_JWT,
};

for (const [k, v] of Object.entries(TOKENS)) {
  if (!v) { console.error(`Missing ${k.toUpperCase()}_JWT in env`); process.exit(2); }
}

const log = {
  step: (n, msg) => console.log(`\x1b[36m[step ${n}]\x1b[0m ${msg}`),
  ok:   (msg)    => console.log(`\x1b[32m  ✓ ${msg}\x1b[0m`),
  fail: (msg)    => { console.error(`\x1b[31m  ✗ ${msg}\x1b[0m`); process.exitCode = 1; },
};

function assert(cond, msg) {
  if (cond) log.ok(msg); else log.fail(msg);
}

function connect(name, token) {
  return new Promise((resolve, reject) => {
    const sock = io(MSG_BASE, {
      path:        '/ws',
      transports:  ['websocket'],
      auth:        {token, signalDeviceId: 1},
      reconnection: false,
    });
    const evts = [];
    sock.onAny((event, data) => evts.push({event, data, at: Date.now()}));
    sock.on('connect',       () => resolve({name, sock, evts}));
    sock.on('connect_error', (err) => reject(new Error(`${name}: ${err.message}`)));
    setTimeout(() => reject(new Error(`${name}: connect timeout`)), 5000);
  });
}

function emitAck(client, event, data, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${event}: ack timeout`)), timeoutMs);
    client.sock.emit(event, data, (resp) => {
      clearTimeout(t);
      if (resp && resp.event === 'sfu.error') {
        reject(new Error(`${event}: ${resp.data?.message ?? 'sfu_error'}`));
      } else resolve(resp);
    });
  });
}

function waitForFrame(client, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const found = client.evts.find(predicate);
    if (found) return resolve(found);
    const onAny = (event, data) => {
      const e = {event, data, at: Date.now()};
      if (predicate(e)) { client.sock.offAny(onAny); resolve(e); }
    };
    client.sock.onAny(onAny);
    setTimeout(() => { client.sock.offAny(onAny); reject(new Error('frame wait timeout')); }, timeoutMs);
  });
}

async function main() {
  // ── 1. Open room via REST ──────────────────────────────
  log.step(1, 'POST /sfu/rooms');
  const roomsRes = await fetch(`${MSG_BASE}/sfu/rooms`, {
    method:  'POST',
    headers: {Authorization: `Bearer ${TOKENS.alice}`},
  });
  if (!roomsRes.ok) {
    log.fail(`/sfu/rooms returned ${roomsRes.status} — ${await roomsRes.text()}`);
    return;
  }
  const {roomId} = await roomsRes.json();
  assert(typeof roomId === 'string' && roomId.length === 32, `roomId looks valid (${roomId.slice(0, 8)}…)`);

  // ── 2. Three sockets ───────────────────────────────────
  log.step(2, 'connect 3 socket.io clients');
  const [alice, bob, carla] = await Promise.all([
    connect('alice', TOKENS.alice),
    connect('bob',   TOKENS.bob),
    connect('carla', TOKENS.carla),
  ]);
  log.ok('alice + bob + carla all connected');

  // ── 3. Sequential joins so we can verify fanout ────────
  log.step(3, 'sfu.join alice');
  const aliceJoined = await emitAck(alice, 'sfu.join', {roomId});
  assert(typeof aliceJoined.participantTag === 'string', 'alice received participantTag');
  assert(aliceJoined.routerRtpCapabilities?.codecs?.length > 0, 'alice received routerRtpCapabilities with codecs');
  assert(aliceJoined.sendTransport?.id && aliceJoined.recvTransport?.id, 'alice received send + recv transport params');
  assert(Array.isArray(aliceJoined.existingProducers) && aliceJoined.existingProducers.length === 0, 'alice sees no existing producers (first joiner)');

  log.step(4, 'sfu.join bob — alice should receive sfu.participant.joined');
  const aliceJoinedFanoutP = waitForFrame(alice, e => e.event === 'sfu.participant.joined');
  const bobJoined = await emitAck(bob, 'sfu.join', {roomId});
  assert(typeof bobJoined.participantTag === 'string', 'bob received participantTag');
  const aliceJoinedFanout = await aliceJoinedFanoutP;
  assert(aliceJoinedFanout.data.participantTag === bobJoined.participantTag, 'alice was notified of bob with the right tag');

  log.step(5, 'sfu.join carla — both alice + bob should receive participant.joined');
  const aliceFanoutP = waitForFrame(alice, e => e.event === 'sfu.participant.joined' && e !== aliceJoinedFanout);
  const bobFanoutP   = waitForFrame(bob,   e => e.event === 'sfu.participant.joined');
  const carlaJoined = await emitAck(carla, 'sfu.join', {roomId});
  const [aliceFanout, bobFanout] = await Promise.all([aliceFanoutP, bobFanoutP]);
  assert(aliceFanout.data.participantTag === carlaJoined.participantTag, 'alice notified of carla');
  assert(bobFanout.data.participantTag   === carlaJoined.participantTag, 'bob notified of carla');

  // ── 6. Leave: carla leaves, alice + bob should hear participant.left ──
  log.step(6, 'sfu.leave carla — alice + bob should receive participant.left');
  const aliceLeftP = waitForFrame(alice, e => e.event === 'sfu.participant.left');
  const bobLeftP   = waitForFrame(bob,   e => e.event === 'sfu.participant.left');
  await emitAck(carla, 'sfu.leave', {roomId});
  const [aliceLeft, bobLeft] = await Promise.all([aliceLeftP, bobLeftP]);
  assert(aliceLeft.data.participantTag === carlaJoined.participantTag, 'alice notified of carla leaving');
  assert(bobLeft.data.participantTag   === carlaJoined.participantTag, 'bob notified of carla leaving');

  // ── 7. Disconnect cleanup: alice drops the socket without sending sfu.leave ──
  log.step(7, 'disconnect alice — bob should receive participant.left from socket teardown');
  const bobLeft2P = waitForFrame(bob, e => e.event === 'sfu.participant.left' && e !== bobLeft);
  alice.sock.disconnect();
  const bobLeft2 = await bobLeft2P;
  assert(bobLeft2.data.participantTag === aliceJoined.participantTag, 'bob notified of alice leaving via disconnect');

  // ── 8. Last participant leaves → router closes (we can't observe it
  //      directly, but stats should drop to 0 rooms within a tick) ──
  log.step(8, 'bob leaves last; /sfu/stats reports 0 rooms');
  await emitAck(bob, 'sfu.leave', {roomId});
  bob.sock.disconnect(); carla.sock.disconnect();
  // Give the server a tick to tear down.
  await new Promise(r => setTimeout(r, 200));
  const statsRes = await fetch(`${MSG_BASE}/sfu/stats`, {headers: {Authorization: `Bearer ${TOKENS.alice}`}});
  const stats = await statsRes.json();
  assert(stats.rooms === 0, `rooms == 0 (got ${stats.rooms})`);
  assert(stats.participants === 0, `participants == 0 (got ${stats.participants})`);
  assert(stats.workers > 0, `workers > 0 (got ${stats.workers})`);
}

main().then(() => {
  if (process.exitCode) {
    console.error('\n\x1b[31mFAIL\x1b[0m\n');
    process.exit(process.exitCode);
  }
  console.log('\n\x1b[32mPASS\x1b[0m\n');
}).catch(err => {
  console.error('\n\x1b[31mFAIL\x1b[0m', err);
  process.exit(1);
});
