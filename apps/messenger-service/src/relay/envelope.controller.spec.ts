import {validate} from 'class-validator';
import {plainToInstance} from 'class-transformer';
import {EnvelopeController} from './envelope.controller';
import type {EnvelopeService} from './envelope.service';
import type {PushService} from '../push/push.service';
import type {CallerContext} from '../common/guards/jwt-http.guard';
import type {SendEnvelopeDto} from './dto/send-envelope.dto';
import type {AckBatchDto} from './dto/ack-batch.dto';
import {ReceiptsDto} from './dto/receipts.dto';
import type {SendEnvelopeResult} from './envelope.types';

/**
 * Audit P2-BR-3 — chat-wake gating on POST /envelopes.
 *
 * Every non-displayable envelope (reaction, group-control/rekey, deduped
 * retry, pre-expired send) used to fire a full HIGH-importance "New secure
 * message" wake — phantom sound banners that open to nothing on a killed
 * device. Two gates now apply, and both must hold:
 *
 *   1. Client Signal-style `urgent` flag (default true — legacy clients
 *      that omit it keep today's behavior): `urgent:false` skips the wake.
 *      The flag reveals only "notification-worthy or not" — no content or
 *      kind field ever reaches the relay.
 *   2. Server-detected `wakeEligible` from the submit result: a dedup HIT
 *      (retried send) and an already-expired submit never wake, regardless
 *      of the flag.
 *
 * Unit-tests the controller directly (plain constructor injection) — the
 * guard/DTO-validation layers are out of scope here.
 */

function buildController(result?: Partial<SendEnvelopeResult>) {
  const submitEnvelope = jest.fn().mockResolvedValue({
    envelopeId:   'env-1',
    clientMsgId:  'c-1',
    deliveredNow: false,
    retractToken: 'r-1',
    wakeEligible: true,
    ...result,
  } satisfies SendEnvelopeResult);
  const sendChatWake = jest.fn().mockResolvedValue({sent: 1, stubbed: false});
  const controller = new EnvelopeController(
    {submitEnvelope} as unknown as EnvelopeService,
    {sendChatWake} as unknown as PushService,
  );
  return {controller, submitEnvelope, sendChatWake};
}

const caller = {
  claims: {sub: 'alice-uuid'},
  signalDeviceId: 1,
} as unknown as CallerContext;

function dto(extra: Partial<SendEnvelopeDto> = {}): SendEnvelopeDto {
  return {
    recipient:   {userId: 'bob', deviceId: 1},
    outerSealed: 'x'.repeat(80),
    clientMsgId: 'c-1',
    ...extra,
  } as SendEnvelopeDto;
}

describe('EnvelopeController — audit P2-BR-3 urgent-flag wake gating', () => {
  it('fires the chat wake when urgent is omitted (legacy default) and the submit is wakeEligible', async () => {
    const {controller, sendChatWake} = buildController();
    await controller.send(caller, dto());
    expect(sendChatWake).toHaveBeenCalledTimes(1);
    // B-715 — the shape is asserted EXACTLY, not with objectContaining, and that
    // is the point: this is the boundary where anything added to the wake opts
    // would silently start travelling toward the push. `envelopeId` is carried
    // for LOG correlation only; `push-chat-wake.spec` separately pins that the
    // FCM `data` block still has exactly its four keys, so a leak from here to
    // the wire fails there.
    expect(sendChatWake).toHaveBeenCalledWith('bob', {senderUserId: 'alice-uuid', envelopeId: 'env-1'});
  });

  it('fires the chat wake when urgent is explicitly true', async () => {
    const {controller, sendChatWake} = buildController();
    await controller.send(caller, dto({urgent: true}));
    expect(sendChatWake).toHaveBeenCalledTimes(1);
  });

  it('skips the chat wake entirely when urgent === false (reactions / group-control / rekey)', async () => {
    const {controller, sendChatWake} = buildController();
    const res = await controller.send(caller, dto({urgent: false}));
    expect(sendChatWake).not.toHaveBeenCalled();
    // The submit itself is unaffected — accepted shape returned as usual.
    expect(res.envelopeId).toBe('env-1');
  });

  it('skips the chat wake on a dedup HIT / pre-expired submit (wakeEligible=false) even when urgent', async () => {
    const {controller, sendChatWake} = buildController({wakeEligible: false});
    await controller.send(caller, dto({urgent: true}));
    expect(sendChatWake).not.toHaveBeenCalled();
  });

  it('never forwards the urgent flag into the sealed submit input (metadata-minimal)', async () => {
    const {controller, submitEnvelope} = buildController();
    await controller.send(caller, dto({urgent: false}));
    expect(submitEnvelope).toHaveBeenCalledWith({
      recipient:    {userId: 'bob', deviceId: 1},
      outerSealed:  'x'.repeat(80),
      clientMsgId:  'c-1',
      expiresAtSec: undefined,
      // OM-03 — the anonymous receipt-slot flag is the ONLY addition;
      // omitted by the client ⇒ false ⇒ no rcpt key is allocated.
      receipt:      false,
    });
    const input = submitEnvelope.mock.calls[0][0] as Record<string, unknown>;
    expect('urgent' in input).toBe(false);
  });
});

// @nestjs/throttler writes `THROTTLER:LIMIT` + name / `THROTTLER:TTL` + name onto the
// handler function. The constants aren't exported from the package index, so the
// literal keys are inlined here.
describe('EnvelopeController — SRV-01 fan-out burst budget', () => {
  const limitOf = (fn: unknown) => Reflect.getMetadata('THROTTLER:LIMITdefault', fn as object) as number;
  const ttlOf   = (fn: unknown) => Reflect.getMetadata('THROTTLER:TTLdefault',   fn as object) as number;

  it('admits a full MAX_GROUP_FANOUT (250) fan-out inside one throttle window', () => {
    expect(limitOf(EnvelopeController.prototype.send)).toBeGreaterThanOrEqual(250);
    expect(ttlOf(EnvelopeController.prototype.send)).toBeGreaterThanOrEqual(10_000);
  });

  it('keeps the sustained rate bounded (no unlimited bucket)', () => {
    const limit = limitOf(EnvelopeController.prototype.send);
    const ttl   = ttlOf(EnvelopeController.prototype.send);
    expect(limit / (ttl / 1000)).toBeLessThanOrEqual(10);
  });

  it('raises the single-ack cap for connect-time backlog drains (SRV-05 part A)', () => {
    expect(limitOf(EnvelopeController.prototype.ack)).toBe(240);
    expect(ttlOf(EnvelopeController.prototype.ack)).toBe(10_000);
  });

  it('caps ack-batch requests at 30/10s (× 100 items = 3000 acks/10s ceiling — SRV-05 part C)', () => {
    expect(limitOf(EnvelopeController.prototype.ackBatch)).toBe(30);
    expect(ttlOf(EnvelopeController.prototype.ackBatch)).toBe(10_000);
  });

  it('honours the RELAY_SEND_THROTTLE_* operator overrides', () => {
    const prevLimit = process.env['RELAY_SEND_THROTTLE_LIMIT'];
    const prevTtl   = process.env['RELAY_SEND_THROTTLE_TTL_MS'];
    process.env['RELAY_SEND_THROTTLE_LIMIT']  = '42';
    process.env['RELAY_SEND_THROTTLE_TTL_MS'] = '5000';
    jest.resetModules();
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const reloaded = require('./envelope.controller').EnvelopeController;
      expect(limitOf(reloaded.prototype.send)).toBe(42);
      expect(ttlOf(reloaded.prototype.send)).toBe(5000);
    } finally {
      if (prevLimit === undefined) {delete process.env['RELAY_SEND_THROTTLE_LIMIT'];} else {process.env['RELAY_SEND_THROTTLE_LIMIT'] = prevLimit;}
      if (prevTtl === undefined) {delete process.env['RELAY_SEND_THROTTLE_TTL_MS'];} else {process.env['RELAY_SEND_THROTTLE_TTL_MS'] = prevTtl;}
      jest.resetModules();
    }
  });
});

// SRV-05 part C — POST /envelopes/ack-batch. The controller is a thin
// forwarder: the caller's session address + the validated acks array go to
// `EnvelopeService.ackBatch` verbatim (where the per-envelope P0-N9 proof is
// enforced), and the per-item result array comes back unchanged. Unlike
// `send`, an ack must NEVER wake anyone.
describe('EnvelopeController — SRV-05 ack-batch forwarding', () => {
  function buildAckBatchController() {
    const ackBatch = jest.fn().mockResolvedValue({
      results: [
        {envelopeId: 'e-1', status: 'ok'},
        {envelopeId: 'e-2', status: 'forbidden'},
      ],
    });
    const sendChatWake = jest.fn().mockResolvedValue({sent: 1, stubbed: false});
    const controller = new EnvelopeController(
      {ackBatch} as unknown as EnvelopeService,
      {sendChatWake} as unknown as PushService,
    );
    return {controller, ackBatch, sendChatWake};
  }

  const batchDto = {
    acks: [
      {envelopeId: 'e-1', ackToken: 't-1'},
      {envelopeId: 'e-2', ackToken: 't-2', disposition: 'discarded' as const},
    ],
  } as AckBatchDto;

  it('forwards the caller address and the acks array verbatim, returns the service result unchanged', async () => {
    const {controller, ackBatch} = buildAckBatchController();
    const res = await controller.ackBatch(caller, batchDto);
    expect(ackBatch).toHaveBeenCalledTimes(1);
    expect(ackBatch).toHaveBeenCalledWith(
      {userId: 'alice-uuid', deviceId: 1},
      batchDto.acks,
    );
    expect(res).toEqual({
      results: [
        {envelopeId: 'e-1', status: 'ok'},
        {envelopeId: 'e-2', status: 'forbidden'},
      ],
    });
  });

  it('never fires a chat wake (guard against a copy-paste regression from send)', async () => {
    const {controller, sendChatWake} = buildAckBatchController();
    await controller.ackBatch(caller, batchDto);
    expect(sendChatWake).not.toHaveBeenCalled();
  });
});

// OM-03 / G1-SRV — POST /envelopes/receipts. Capability-token auth only:
// like `retract`, the handler takes NO @CurrentCaller — the retract token
// per item is the entire entitlement, so the relay records no
// sender↔envelope link. The submit path gains exactly one boolean
// (`receipt`) and must STILL pass no submitter identity.
describe('EnvelopeController — OM-03 anonymous delivery receipts', () => {
  it('POST /envelopes with receipt:true reaches submitEnvelope with receipt:true and STILL no submitter', async () => {
    const {controller, submitEnvelope} = buildController();
    await controller.send(caller, dto({receipt: true}));
    expect(submitEnvelope).toHaveBeenCalledTimes(1);
    const input = submitEnvelope.mock.calls[0][0] as Record<string, unknown>;
    expect(input.receipt).toBe(true);
    expect('submitter' in input).toBe(false);
    expect(JSON.stringify(input)).not.toContain('alice-uuid');
  });

  it('receipt omitted ⇒ receipt:false (legacy behaviour, no slot allocated)', async () => {
    const {controller, submitEnvelope} = buildController();
    await controller.send(caller, dto());
    const input = submitEnvelope.mock.calls[0][0] as Record<string, unknown>;
    expect(input.receipt).toBe(false);
  });

  function buildReceiptsController() {
    const readReceipts = jest.fn().mockResolvedValue([
      {envelopeId: 'e-1', outcome: 'delivered'},
      {envelopeId: 'e-2', outcome: 'unknown'},
    ]);
    const sendChatWake = jest.fn().mockResolvedValue({sent: 1, stubbed: false});
    const controller = new EnvelopeController(
      {readReceipts} as unknown as EnvelopeService,
      {sendChatWake} as unknown as PushService,
    );
    return {controller, readReceipts, sendChatWake};
  }

  const receiptsDto = {
    items: [
      {envelopeId: 'e-1', retractToken: '00000000-0000-4000-a000-000000000001'},
      {envelopeId: 'e-2', retractToken: '00000000-0000-4000-a000-000000000002'},
    ],
  } as ReceiptsDto;

  it('receipts forwards ONLY the items array to the service (no caller identity in the signature)', async () => {
    const {controller, readReceipts} = buildReceiptsController();
    const res = await controller.receipts(receiptsDto);
    expect(readReceipts).toHaveBeenCalledTimes(1);
    expect(readReceipts).toHaveBeenCalledWith(receiptsDto.items);
    // The handler's arity is 1: the DTO. No @CurrentCaller parameter exists.
    expect(EnvelopeController.prototype.receipts.length).toBe(1);
    expect(res).toEqual({
      receipts: [
        {envelopeId: 'e-1', outcome: 'delivered'},
        {envelopeId: 'e-2', outcome: 'unknown'},
      ],
    });
  });

  it('never fires a chat wake', async () => {
    const {controller, sendChatWake} = buildReceiptsController();
    await controller.receipts(receiptsDto);
    expect(sendChatWake).not.toHaveBeenCalled();
  });

  it('is throttled at 30 requests / 10 s (batch route budget, same as ack-batch)', () => {
    const limitOf = (fn: unknown) => Reflect.getMetadata('THROTTLER:LIMITdefault', fn as object) as number;
    const ttlOf   = (fn: unknown) => Reflect.getMetadata('THROTTLER:TTLdefault',   fn as object) as number;
    expect(limitOf(EnvelopeController.prototype.receipts)).toBe(30);
    expect(ttlOf(EnvelopeController.prototype.receipts)).toBe(10_000);
  });

  describe('ReceiptsDto validation (the wire bound)', () => {
    const validItem = (i: number) => ({
      envelopeId: `e-${i}`,
      retractToken: '00000000-0000-4000-a000-000000000abc',
    });

    it('accepts a well-formed batch of 100', async () => {
      const dtoInst = plainToInstance(ReceiptsDto, {
        items: Array.from({length: 100}, (_, i) => validItem(i)),
      });
      const errors = await validate(dtoInst);
      expect(errors).toHaveLength(0);
    });

    it('rejects more than 100 items', async () => {
      const dtoInst = plainToInstance(ReceiptsDto, {
        items: Array.from({length: 101}, (_, i) => validItem(i)),
      });
      const errors = await validate(dtoInst);
      expect(errors.length).toBeGreaterThan(0);
      expect(JSON.stringify(errors)).toContain('arrayMaxSize');
    });

    it('rejects a malformed retractToken (not the relay-minted UUID shape)', async () => {
      const dtoInst = plainToInstance(ReceiptsDto, {
        items: [{envelopeId: 'e-1', retractToken: 'not-a-uuid'}],
      });
      const errors = await validate(dtoInst);
      expect(errors.length).toBeGreaterThan(0);
    });

    it('rejects a non-array items payload', async () => {
      const dtoInst = plainToInstance(ReceiptsDto, {items: 'e-1'});
      const errors = await validate(dtoInst);
      expect(errors.length).toBeGreaterThan(0);
    });
  });
});
