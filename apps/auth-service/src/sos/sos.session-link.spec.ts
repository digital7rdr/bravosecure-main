/**
 * SOS ↔ protection-session linkage (spec §7). When the caller has a live
 * protection session, /sos/raise stamps protection_session_id, snapshots the
 * last known location when no fix was sent, flags the session sos_active, wakes
 * the session's CPO, and lights the session room. DatabaseService mocked.
 */
import {SosService} from './sos.service';
import type {DatabaseService, Tx} from '../database/database.service';

const PSESSION = {id: 'sess-1', cpo_user_id: 'cpo-9'};
const LAST_LOC = {lat: 25.2, lng: 55.3};

function mk(opts: {psession?: Record<string, unknown> | null; lastLoc?: Record<string, unknown> | null} = {}) {
  const txQOne: Array<{sql: string; params?: unknown[]}> = [];
  const qCalls: Array<{sql: string; params?: unknown[]}> = [];
  const tx: Tx = {
    q: jest.fn().mockResolvedValue([]),
    qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      txQOne.push({sql, params});
      if (/INSERT INTO public\.sos_events/.test(sql)) {
        return Promise.resolve({id: 'sos-1', triggered_at: new Date(0)});
      }
      return Promise.resolve(null);
    }),
  };
  const db = {
    q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
      qCalls.push({sql, params});
      return Promise.resolve([]);
    }),
    qOne: jest.fn().mockImplementation((sql: string) => {
      if (/FROM public\.protection_sessions/.test(sql)) {return Promise.resolve('psession' in opts ? opts.psession : PSESSION);}
      if (/FROM public\.protection_session_locations/.test(sql)) {return Promise.resolve(opts.lastLoc ?? null);}
      if (/FROM missions/.test(sql)) {return Promise.resolve(null);}
      return Promise.resolve(null);
    }),
    withTransaction: jest.fn().mockImplementation((fn: (t: Tx) => unknown) => fn(tx)),
  } as unknown as DatabaseService;

  const push = {psessionSos: jest.fn().mockResolvedValue(undefined), sosAlert: jest.fn().mockResolvedValue(undefined)};
  const events = {broadcast: jest.fn().mockResolvedValue(undefined)};
  const audit = {emit: jest.fn().mockResolvedValue(undefined)};
  const opsAudit = {emit: jest.fn().mockResolvedValue(undefined)};
  const svc = new SosService(db, {} as never, audit as never, opsAudit as never, push as never, events as never);
  return {svc, txQOne, qCalls, push, events};
}

describe('SosService.raise — protection-session linkage (§7)', () => {
  it('stamps protection_session_id, snapshots last location, flags + wakes the CPO', async () => {
    const {svc, txQOne, qCalls, push, events} = mk({psession: PSESSION, lastLoc: LAST_LOC});
    await svc.raise('owner-1', {reason: 'protection_session'}); // no fix supplied

    const insert = txQOne.find(c => /INSERT INTO public\.sos_events/.test(c.sql));
    expect(insert).toBeDefined();
    // (…, lat=$7, lng=$8, protection_session_id=$9)
    expect(insert!.params?.[8]).toBe('sess-1');
    expect(insert!.params?.[6]).toBe(25.2);          // snapshot lat
    expect(insert!.params?.[7]).toBe(55.3);          // snapshot lng

    expect(qCalls.some(c => /UPDATE public\.protection_sessions SET sos_active = true/.test(c.sql)
      && (c.params ?? []).includes('sess-1'))).toBe(true);
    expect(events.broadcast).toHaveBeenCalledWith('sess-1', 'psession.sos', expect.objectContaining({active: true}));
    expect(push.psessionSos).toHaveBeenCalledWith('cpo-9', 'sess-1');
  });

  it('a panic with NO live session leaves protection_session_id null and touches no session', async () => {
    const {svc, txQOne, qCalls, push} = mk({psession: null});
    await svc.raise('owner-1', {reason: 'panic_button'});

    const insert = txQOne.find(c => /INSERT INTO public\.sos_events/.test(c.sql));
    expect(insert!.params?.[8]).toBeNull();
    expect(qCalls.some(c => /sos_active = true/.test(c.sql))).toBe(false);
    expect(push.psessionSos).not.toHaveBeenCalled();
  });
});

/**
 * AUTHZ-1 — a caller-supplied bookingId must NOT let one user flip another
 * user's live mission to SOS (and fan panic pushes to its crew/agency). The
 * mission lookup is bound to a booking the caller OWNS (`b.client_id = $2`),
 * so a stranger's bookingId resolves no mission and no mission UPDATE runs.
 * Reverting the fix (dropping the client_id predicate / the userId param) turns
 * both assertions red.
 */
describe('SosService.raise — AUTHZ-1 cross-user SOS forgery guard', () => {
  function mkCapture(missionRow: Record<string, unknown> | null, crew: Array<{user_id: string; mission_id: string}> = []) {
    const qOneCalls: Array<{sql: string; params?: unknown[]}> = [];
    const txQ: Array<{sql: string; params?: unknown[]}> = [];
    const tx: Tx = {
      q: jest.fn().mockImplementation((sql: string, params?: unknown[]) => { txQ.push({sql, params}); return Promise.resolve([]); }),
      qOne: jest.fn().mockImplementation((sql: string) =>
        /INSERT INTO public\.sos_events/.test(sql)
          ? Promise.resolve({id: 'sos-1', triggered_at: new Date(0)})
          : Promise.resolve(null)),
    };
    const db = {
      q: jest.fn().mockImplementation((sql: string) =>
        /FROM mission_crew/.test(sql) ? Promise.resolve(crew) : Promise.resolve([])),
      qOne: jest.fn().mockImplementation((sql: string, params?: unknown[]) => {
        qOneCalls.push({sql, params});
        if (/FROM missions/.test(sql)) {return Promise.resolve(missionRow);}
        if (/assigned_provider_user_id FROM lite_bookings/.test(sql)) {return Promise.resolve({assigned_provider_user_id: null});}
        return Promise.resolve(null); // no protection session
      }),
      withTransaction: jest.fn().mockImplementation((fn: (t: Tx) => unknown) => fn(tx)),
    } as unknown as DatabaseService;
    const push = {psessionSos: jest.fn().mockResolvedValue(undefined), sosAlert: jest.fn().mockResolvedValue(undefined)};
    const events = {broadcast: jest.fn().mockResolvedValue(undefined)};
    const svc = new SosService(db, {} as never, {emit: jest.fn()} as never, {emit: jest.fn()} as never, push as never, events as never);
    return {svc, qOneCalls, txQ, push};
  }

  it('resolves the mission ONLY via a booking owned by the caller (client_id bound to the caller id)', async () => {
    const {svc, qOneCalls} = mkCapture(null);
    await svc.raise('owner-1', {bookingId: 'bk-1', reason: 'panic_button'});
    const missionQ = qOneCalls.find(c => /FROM missions/.test(c.sql));
    expect(missionQ).toBeDefined();
    expect(missionQ!.sql).toMatch(/client_id\s*=\s*\$2/);
    expect(missionQ!.params).toEqual(['bk-1', 'owner-1']);
  });

  it('does NOT flip any mission when the booking is not the caller’s (ownership lookup finds none)', async () => {
    const {svc, txQ} = mkCapture(null); // ownership-scoped lookup returns nothing
    await svc.raise('attacker-1', {bookingId: 'victim-booking', reason: 'panic_button'});
    expect(txQ.some(c => /UPDATE missions SET status = 'SOS'/.test(c.sql))).toBe(false);
  });

  // The fan-out half of AUTHZ-1 — the bug the first cut MISSED. The mission FLIP was
  // owner-scoped, but the crew/agency panic push fanned out on the caller-supplied
  // bookingId, so a stranger could still spam a booking's crew + agency desk.
  it('does NOT fan SOS pushes to the crew when the booking is not the caller’s', async () => {
    // Even if the victim booking HAS live crew, an attacker's raise must not reach them.
    const {svc, push} = mkCapture(null, [{user_id: 'victim-cpo', mission_id: 'm-9'}]);
    await svc.raise('attacker-1', {bookingId: 'victim-booking', reason: 'panic_button'});
    expect(push.sosAlert).not.toHaveBeenCalled();
  });

  it('DOES fan SOS pushes to the crew when the caller owns the booking', async () => {
    const {svc, push} = mkCapture(
      {id: 'm-1', status: 'LIVE'},              // ownership lookup resolves the mission
      [{user_id: 'my-cpo', mission_id: 'm-1'}], // live crew on it
    );
    await svc.raise('owner-1', {bookingId: 'bk-1', reason: 'panic_button'});
    expect(push.sosAlert).toHaveBeenCalledWith(['my-cpo'], 'm-1', 'bk-1');
  });
});
