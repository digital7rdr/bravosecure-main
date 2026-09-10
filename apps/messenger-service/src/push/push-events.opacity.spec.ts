import {PushService} from './push.service';
import type {RedisService} from '../redis/redis.service';

/**
 * LB15 / P0-N8 — the push:events consumer must forward ONLY the opaque {eventId, eventClass}
 * onto FCM data; it must NEVER reconstruct a bookingId / missionId / kind into the cleartext
 * payload (Google/Apple operate the FCM intermediary). The device hydrates the real detail by
 * eventId over the JWT-gated encrypted relay.
 */
type Handler = (channel: string, raw: string) => void;

function setup() {
  let handler: Handler | undefined;
  const fakeSub = {
    on: (ev: string, cb: Handler) => { if (ev === 'message') handler = cb; },
    subscribe: jest.fn().mockResolvedValue(undefined),
  };
  const redis = {client: {duplicate: () => fakeSub}} as unknown as RedisService;
  const push = new PushService(redis);
  const spy = jest
    .spyOn(push as unknown as {sendDataOnlyToUser: (...a: unknown[]) => Promise<number>}, 'sendDataOnlyToUser')
    .mockResolvedValue(0);
  return {push, spy, getHandler: () => handler};
}

describe('PushService push:events consumer — opacity (LB15)', () => {
  it('forwards ONLY {eventId, eventClass} and drops any sensitive fields on the frame', async () => {
    const {push, spy, getHandler} = setup();
    await (push as unknown as {bootstrapPushEventsSubscriber: () => Promise<void>}).bootstrapPushEventsSubscriber();
    const handler = getHandler();
    expect(handler).toBeDefined();

    // Even a (legacy/malicious) frame carrying ids must be stripped to the opaque triple.
    handler!('push:events', JSON.stringify({
      userId: 'u1', eventClass: 'mission', eventId: 'evt-1',
      bookingId: 'b-LEAK', missionId: 'm-LEAK', kind: 'mission-dispatched',
    }));

    expect(spy).toHaveBeenCalledTimes(1);
    const [userId, data] = spy.mock.calls[0] as [string, Record<string, string>];
    expect(userId).toBe('u1');
    expect(Object.keys(data).sort()).toEqual(['eventClass', 'eventId']);
    expect(data.eventId).toBe('evt-1');
    expect(JSON.stringify(data)).not.toContain('LEAK');
  });

  it('routes a frame from a non-push:events channel nowhere', async () => {
    const {push, spy, getHandler} = setup();
    await (push as unknown as {bootstrapPushEventsSubscriber: () => Promise<void>}).bootstrapPushEventsSubscriber();
    getHandler()!('some:other:channel', JSON.stringify({userId: 'u1', eventClass: 'sos', eventId: 'e2'}));
    expect(spy).not.toHaveBeenCalled();
  });

  it('drops a frame missing userId or eventId', async () => {
    const {push, spy, getHandler} = setup();
    await (push as unknown as {bootstrapPushEventsSubscriber: () => Promise<void>}).bootstrapPushEventsSubscriber();
    const h = getHandler()!;
    h('push:events', JSON.stringify({eventClass: 'mission', eventId: 'evt-1'})); // no userId
    h('push:events', JSON.stringify({userId: 'u1', eventClass: 'mission'}));     // no eventId
    expect(spy).not.toHaveBeenCalled();
  });

  // B-706 A-7 re-point: `booking` and `mission` joined the high-priority set
  // (android.ttl is 10 minutes, so a normal-priority wake deferred past a Doze
  // maintenance window is DISCARDED, not merely late). The invariant this case
  // exists for — the set is deliberate, NOT blanket — is what the third
  // assertion now pins.
  it('marks the time-critical classes high priority and leaves the rest normal', async () => {
    const {push, spy, getHandler} = setup();
    await (push as unknown as {bootstrapPushEventsSubscriber: () => Promise<void>}).bootstrapPushEventsSubscriber();
    const h = getHandler()!;
    h('push:events', JSON.stringify({userId: 'u1', eventClass: 'sos', eventId: 's1'}));
    h('push:events', JSON.stringify({userId: 'u2', eventClass: 'mission', eventId: 'm1'}));
    h('push:events', JSON.stringify({userId: 'u3', eventClass: 'booking', eventId: 'b1'}));
    h('push:events', JSON.stringify({userId: 'u4', eventClass: 'payout', eventId: 'p1'}));
    expect(spy.mock.calls[0][3]).toBe(true);  // sos → high priority
    expect(spy.mock.calls[1][3]).toBe(true);  // mission → high priority (A-7)
    expect(spy.mock.calls[2][3]).toBe(true);  // booking → high priority (A-7)
    expect(spy.mock.calls[3][3]).toBe(false); // payout → normal; the set is not blanket
  });
});
