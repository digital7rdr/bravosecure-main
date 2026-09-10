import {BookingPushBridge} from './booking-push-bridge.service';
import type {RedisService} from '../redis/redis.service';
import type {NotificationsService} from '../notifications/notifications.service';

/**
 * P0-N8 / LB15 static opacity gate. The Redis `push:events` channel payload reaches
 * FCM/APNs in the clear (Google/Apple operate the intermediary), so it must be EXACTLY
 * {userId, eventClass, eventId} — never a bookingId/missionId/offerId/kind. The real
 * detail lives only in Redis behind the JWT-gated encrypted relay. This test fails if any
 * bridge method ever leaks a sensitive id onto the channel.
 */
function mk() {
  const publish = jest.fn().mockResolvedValue(1);
  const set = jest.fn().mockResolvedValue('OK');
  const redis = {client: {publish, set}} as unknown as RedisService;
  // N-20 — the durable inbox write rides alongside publish; it never touches
  // the FCM channel, so channel opacity is unaffected. Mock it here.
  const record = jest.fn().mockResolvedValue(undefined);
  const notifications = {record} as unknown as NotificationsService;
  const svc = new BookingPushBridge(redis, notifications);
  return {svc, publish, set, record};
}
function channelPayload(publish: jest.Mock): Record<string, unknown> {
  const call = publish.mock.calls.find(c => c[0] === BookingPushBridge.CHANNEL);
  if (!call) throw new Error('nothing published to the channel');
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

const ORG = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const SENSITIVE = ['b-booking-123', 'm-mission-456', 'o-offer-789', ORG];

const cases: Array<[string, (s: BookingPushBridge) => Promise<void>]> = [
  ['dispatchOffer',     s => s.dispatchOffer('u1', 'b-booking-123')],
  ['providerAccepted',  s => s.providerAccepted('u1', 'b-booking-123')],
  ['noProvider',        s => s.noProvider('u1', 'b-booking-123')],
  ['agencyNoShow',      s => s.agencyNoShow('u1', 'b-booking-123')],
  ['bookingApproved',   s => s.bookingApproved('u1', 'b-booking-123')],
  // B-405 — T-60 scheduled-start reminder rides the same opaque channel.
  ['bookingReminder',   s => s.bookingReminder('u1', 'b-booking-123')],
  ['missionDispatched', s => s.missionDispatched('u1', 'm-mission-456', 'b-booking-123')],
  ['missionAborted',    s => s.missionAborted('u1', 'm-mission-456', 'b-booking-123')],
  ['payoutSettled',     s => s.payoutSettled('u1', 'b-booking-123', 500)],
  ['agentDecided',      s => s.agentDecided('u1', 'APPROVED')],
  ['sosAlert',          s => s.sosAlert(['u1'], 'm-mission-456', 'b-booking-123')],
  // R13-2 — enterprise join loop. The blob carries only the kind; the channel
  // triple must stay opaque like every other class.
  ['enterpriseJoinRequested', s => s.enterpriseJoinRequested('u1')],
  ['enterpriseJoinDecided',   s => s.enterpriseJoinDecided('u1', 'approved')],
  // Dept Chat v2 incidents — previously uncovered by this spec (2026-08-07).
  ['incidentSubmitted',       s => s.incidentSubmitted(['u1'], 'ref-1', 'high')],
  ['incidentStatusChanged',   s => s.incidentStatusChanged('u1', 'ref-1', 'resolved')],
  // vs2 edge A1/A2 — the org id is a REAL tenant identifier. It rides the
  // JWT-gated blob and the recipient-scoped inbox row; it must never reach the
  // cleartext channel, where it would hand Google/Apple a per-org fan-out map.
  ['incidentSubmitted+org',       s => s.incidentSubmitted(['u1'], 'ref-1', 'high', {orgId: ORG})],
  ['enterpriseJoinRequested+org', s => s.enterpriseJoinRequested('u1', ORG)],
  ['enterpriseInviteAccepted+org', s => s.enterpriseInviteAccepted('u1', ORG)],
];

describe('BookingPushBridge — channel opacity (P0-N8)', () => {
  it.each(cases)('%s publishes EXACTLY {userId,eventClass,eventId} — no sensitive id', async (_name, fn) => {
    const {svc, publish, set} = mk();
    await fn(svc);
    // The channel payload carries only the opaque triple.
    const payload = channelPayload(publish);
    expect(Object.keys(payload).sort()).toEqual(['eventClass', 'eventId', 'userId']);
    const raw = JSON.stringify(payload);
    for (const id of SENSITIVE) expect(raw).not.toContain(id);
    // The sensitive detail goes to Redis (push-event:<id>), never the channel.
    expect(set).toHaveBeenCalledWith(expect.stringMatching(/^push-event:/), expect.any(String), 'EX', expect.any(Number));
  });

  it('eventClass stays coarse (one of the allowed category labels)', async () => {
    const allowed = new Set(['agent', 'booking', 'mission', 'payout', 'sos', 'dispatch', 'enterprise', 'incident']);
    for (const [, fn] of cases) {
      const {svc, publish} = mk();
      await fn(svc);
      expect(allowed.has(channelPayload(publish).eventClass as string)).toBe(true);
    }
  });
});

describe('BookingPushBridge — durable-row independence (N-20, edge-case review 2026-08-07)', () => {
  // The inbox row is the ONE sink that exists for when the transient lane
  // fails. With the row written last-and-inside the Redis try, a Redis outage
  // (ioredis MaxRetriesPerRequestError) skipped it too — no wake AND no bell
  // row, ever. The row is now written AFTER the wake but OUTSIDE the Redis
  // try: latency first, durability unconditional.
  it('a Redis outage does NOT lose the durable inbox row', async () => {
    const {svc, set, record} = mk();
    set.mockRejectedValue(new Error('MaxRetriesPerRequestError'));
    await svc.enterpriseJoinRequested('u1');
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({
      eventClass: 'enterprise', kind: 'enterprise.join.requested',
    }));
  });

  it('wake first, durable row after — but UNCONDITIONAL (mutation: move record back inside the try → RED above)', async () => {
    // Wake latency wins the ordering (an SOS fan-out must not queue behind
    // Postgres inserts); durability is preserved by keeping record OUTSIDE the
    // Redis try — the outage test above is the half that pins that.
    const {svc, set, record} = mk();
    await svc.enterpriseJoinDecided('u1', 'declined');
    const recordOrder = record.mock.invocationCallOrder[0];
    const setOrder = set.mock.invocationCallOrder[0];
    expect(setOrder).toBeLessThan(recordOrder);
  });

  it('vs2 edge A1/A2 — the org id reaches BOTH lanes (blob and durable row)', async () => {
    // The transient blob and the durable row are read by different doors (push
    // tap vs bell row) and the bell row is the one that survives a killed app
    // past the 5-min TTL — i.e. exactly the cold tap that fails on every
    // non-default org. Threading it into only one lane fixes half the bug.
    const {svc, set, record} = mk();
    await svc.incidentSubmitted(['u1'], 'ref-1', 'high', {incidentId: 'inc-1', orgId: ORG});
    const blob = JSON.parse(set.mock.calls[0][1] as string) as Record<string, unknown>;
    expect(blob.orgId).toBe(ORG);
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({orgUserId: ORG}));
  });

  it('an org-less wake writes NULL, never the string "undefined"', async () => {
    const {svc, record} = mk();
    await svc.enterpriseJoinDecided('u1', 'approved');
    expect(record).toHaveBeenCalledWith('u1', expect.objectContaining({orgUserId: null}));
  });

  it('a rejecting record() still never rejects to the caller', async () => {
    const {svc, record} = mk();
    record.mockRejectedValue(new Error('pg down'));
    await expect(svc.enterpriseJoinRequested('u1')).resolves.toBeUndefined();
  });

  it('a publish failure never rejects to the caller (fire-and-forget contract)', async () => {
    const {svc, set} = mk();
    set.mockRejectedValue(new Error('down'));
    await expect(svc.enterpriseJoinRequested('u1')).resolves.toBeUndefined();
  });
});
