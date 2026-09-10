/**
 * Dispatch Inspector read methods (listDispatchRequests / getDispatchRequestDetail).
 * Pure assembly logic over mocked db.q/db.qOne — verifies param passing, the null→404
 * short-circuit, rank-order preservation, and that the crew query is skipped when there
 * is no mission. The SQL itself is validated separately against the live schema.
 */
import {DispatchService} from './dispatch.service';
import {BookingStateMachine} from '../booking/state-machine.service';
import type {DatabaseService} from '../database/database.service';
import type {OpsAuditService} from '../ops/ops-audit.service';
import type {BookingPushBridge} from '../ops/booking-push-bridge.service';
import type {WalletService} from '../wallet/wallet.service';

const fsm = new BookingStateMachine();
const audit = {record: jest.fn()};
const push = {dispatchOffer: jest.fn(), providerAccepted: jest.fn(), noProvider: jest.fn()};
const wallet = {holdToEscrow: jest.fn()};
const db = {q: jest.fn(), qOne: jest.fn(), withTransaction: jest.fn()};

function service(): DispatchService {
  return new DispatchService(
    db as unknown as DatabaseService, fsm,
    audit as unknown as OpsAuditService,
    push as unknown as BookingPushBridge,
    wallet as unknown as WalletService,
  );
}

describe('DispatchService — Inspector reads', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('listDispatchRequests passes [status, limit] and returns the rows', async () => {
    db.q.mockResolvedValueOnce([{booking_id: 'b1', status: 'DISPATCHING'}]);
    const rows = await service().listDispatchRequests('DISPATCHING', 25);
    expect(db.q).toHaveBeenCalledTimes(1);
    expect(db.q.mock.calls[0][1]).toEqual(['DISPATCHING', 25]);
    expect(rows).toEqual([{booking_id: 'b1', status: 'DISPATCHING'}]);
  });

  it('listDispatchRequests defaults an absent status to null', async () => {
    db.q.mockResolvedValueOnce([]);
    await service().listDispatchRequests(undefined, 50);
    expect(db.q.mock.calls[0][1]).toEqual([null, 50]);
  });

  it('getDispatchRequestDetail returns null when the booking is missing (drives the 404)', async () => {
    db.qOne.mockResolvedValueOnce(null); // booking lookup misses
    const out = await service().getDispatchRequestDetail('nope');
    expect(out).toBeNull();
    expect(db.q).not.toHaveBeenCalled(); // short-circuits before offers/timeline
  });

  it('assembles booking + offers(rank order) + escrow + mission + crew + timeline', async () => {
    db.qOne
      .mockResolvedValueOnce({booking_id: 'b1', status: 'CONFIRMED', cpo_count: 2}) // booking
      .mockResolvedValueOnce({escrow_id: 'e1', status: 'HELD', gross_credits: 100})  // escrow
      .mockResolvedValueOnce({mission_id: 'm1', status: 'LIVE', short_code: 'MSN-1'}); // mission
    db.q
      .mockResolvedValueOnce([{offer_id: 'o1', rank: 1, status: 'REJECTED'},
                              {offer_id: 'o2', rank: 2, status: 'ACCEPTED'}])         // offers
      .mockResolvedValueOnce([{agent_id: 'a1', is_lead: true, role: 'LEAD'}])         // crew
      .mockResolvedValueOnce([{at: '2026-01-01T00:00:00Z', source: 'status', label: 'CONFIRMED'}]); // timeline

    const out = await service().getDispatchRequestDetail('b1');

    expect(out).not.toBeNull();
    expect(out!.booking.booking_id).toBe('b1');
    expect(out!.offers).toHaveLength(2);
    expect(out!.offers[0].rank).toBe(1);                 // rank order preserved
    expect(out!.escrow?.status).toBe('HELD');
    expect(out!.mission?.short_code).toBe('MSN-1');
    expect(out!.crew).toHaveLength(1);
    expect(out!.crew[0].is_lead).toBe(true);
    expect(out!.timeline).toHaveLength(1);
    // crew query is scoped to the mission id, not the booking id
    const crewCall = db.q.mock.calls.find((c: unknown[]) => /FROM public\.mission_crew mc/.test(c[0] as string));
    expect(crewCall?.[1]).toEqual(['m1']);
  });

  it('skips the crew query when there is no mission', async () => {
    db.qOne
      .mockResolvedValueOnce({booking_id: 'b1', status: 'DISPATCHING'}) // booking
      .mockResolvedValueOnce(null)                                       // escrow (none)
      .mockResolvedValueOnce(null);                                      // mission (none)
    db.q
      .mockResolvedValueOnce([])                                                                // offers
      .mockResolvedValueOnce([{at: '2026-01-01T00:00:00Z', source: 'status', label: 'DISPATCHING'}]); // timeline

    const out = await service().getDispatchRequestDetail('b1');

    expect(out!.mission).toBeNull();
    expect(out!.crew).toEqual([]);
    expect(db.q).toHaveBeenCalledTimes(2); // offers + timeline only — no crew query
  });
});
