import {ProofOfCompletionService} from './proof-of-completion.service';
import type {DatabaseService} from '../database/database.service';
import type {ConfigService} from '@nestjs/config';

const db = {qOne: jest.fn()};
function cfgWith(requireIdentity = false, requireMovement = false) {
  return {
    get: (k: string) => (({
      'dispatch.arrivalRadiusM': 150,
      'dispatch.minPings': 5,
      'dispatch.minOnTaskSeconds': 300,
      'dispatch.requireIdentityHandshake': requireIdentity,
      'dispatch.requireLiveMovement': requireMovement,
      'dispatch.minLiveMovementM': 25,
    } as Record<string, number | boolean>)[k]),
  };
}

function svc(requireIdentity = false, requireMovement = false): ProofOfCompletionService {
  return new ProofOfCompletionService(db as unknown as DatabaseService, cfgWith(requireIdentity, requireMovement) as unknown as ConfigService);
}

interface Wire {
  mission?: {pickup_at: Date | null; live_at: Date | null; ended_at: Date | null; identity_verified_at?: Date | null} | null;
  booking?: {pickup_lat: string | null; pickup_lng: string | null} | null;
  reached?: boolean;
  pings?: number;
  spread?: number;   // meters of LIVE bounding-box spread (FRAUD-1)
}

function wire(w: Wire): void {
  db.qOne.mockImplementation((sql: string) => {
    if (/FROM missions WHERE id = \$1/.test(sql)) return Promise.resolve(w.mission ?? null);
    if (/pickup_lat, pickup_lng FROM lite_bookings/.test(sql)) return Promise.resolve(w.booking ?? null);
    if (/ST_DWithin/.test(sql)) return Promise.resolve({ok: w.reached ?? true});
    if (/ST_Distance/.test(sql)) return Promise.resolve({m: w.spread ?? 100});
    if (/count\(\*\)::text/.test(sql)) return Promise.resolve({n: String(w.pings ?? 10)});
    return Promise.resolve(null);
  });
}

const agoSec = (s: number): Date => new Date(Date.now() - s * 1000);
const COORDS = {pickup_lat: '25.20', pickup_lng: '55.27'};

describe('ProofOfCompletionService', () => {
  beforeEach(() => jest.resetAllMocks());

  it('PASSES when progression + reached-pickup + coverage + on-task all hold', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10});
    expect(await svc().runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS no_progression on a one-tap jump (no live_at)', async () => {
    wire({mission: {pickup_at: null, live_at: null, ended_at: null}, booking: COORDS, reached: true, pings: 10});
    const r = await svc().runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('no_progression');
  });

  it('FAILS never_reached_pickup when no GPS fix is within the arrival radius', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: false, pings: 10});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('never_reached_pickup');
  });

  it('FAILS insufficient_telemetry when too few pings during LIVE', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 2});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('insufficient_telemetry');
  });

  it('FAILS too_short when LIVE duration is under the minimum', async () => {
    wire({mission: {pickup_at: agoSec(100), live_at: agoSec(60), ended_at: null}, booking: COORDS, reached: true, pings: 10});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('too_short');
  });

  it('FAILS no_pickup_coords when the booking has no pickup point', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: {pickup_lat: null, pickup_lng: null}, reached: true, pings: 10});
    expect((await svc().runProofGate('b1', 'm1')).reasons).toContain('no_pickup_coords');
  });

  it('FAILS gracefully when the mission or booking is missing', async () => {
    wire({mission: null});
    expect(await svc().runProofGate('b1', 'm1')).toEqual({pass: false, reasons: ['mission_or_booking_missing']});
  });

  // FRAUD-2 / P0 — identity handshake (check 5).
  it('IGNORES identity when the handshake flag is off (default), even if unverified', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null, identity_verified_at: null}, booking: COORDS, reached: true, pings: 10});
    expect(await svc(false).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS identity_unverified when the handshake is required but the guard never verified', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null, identity_verified_at: null}, booking: COORDS, reached: true, pings: 10});
    const r = await svc(true).runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('identity_unverified');
  });

  it('PASSES with the handshake required AND a server-verified identity present', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null, identity_verified_at: new Date()}, booking: COORDS, reached: true, pings: 10});
    expect(await svc(true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  // FRAUD-1 — LIVE movement (check 4b).
  it('IGNORES movement when the flag is off (default), even with zero spread', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 0});
    expect(await svc(false, false).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FAILS no_live_movement when required and the LIVE fixes barely spread (fabricated at one point)', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 2});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.pass).toBe(false);
    expect(r.reasons).toContain('no_live_movement');
  });

  it('PASSES with movement required AND real spread present', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 400});
    expect(await svc(false, true).runProofGate('b1', 'm1')).toEqual({pass: true, reasons: []});
  });

  it('FRAUD-1 boundary — spread EXACTLY at the threshold (25m) PASSES (check is `< min`, not `<=`)', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 25});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).not.toContain('no_live_movement');
  });

  it('FRAUD-1 boundary — spread one metre under the threshold (24m) FAILS', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 24});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_live_movement');
  });

  it('FRAUD-1 — no valid LIVE coords (ST_Distance null → 0 spread) FAILS as no movement', async () => {
    wire({mission: {pickup_at: agoSec(700), live_at: agoSec(600), ended_at: null}, booking: COORDS, reached: true, pings: 10, spread: 0});
    const r = await svc(false, true).runProofGate('b1', 'm1');
    expect(r.reasons).toContain('no_live_movement');
  });
});
