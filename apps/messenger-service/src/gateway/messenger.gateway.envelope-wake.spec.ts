/**
 * Audit P2-BR-3 — WS envelope.send chat-wake gating (parity with the HTTP
 * path). The wake fires ONLY when:
 *   - the client did not mark the envelope non-displayable (`urgent !== false`)
 *   - AND the relay marked the submit notification-worthy
 *     (`res.wakeEligible` — false on dedup-hit retries / pre-expired sends).
 * Everything else about the send (persist, accept event) is unchanged.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import type {Socket} from 'socket.io';
import {MessengerGateway} from './messenger.gateway';

const proto: any = MessengerGateway.prototype;

const ME = 'me-user';
const PEER = 'peer-user';

function fakeClient(): Socket & {emit: jest.Mock} {
  return {
    id:   'sock-1',
    data: {claims: {sub: ME}, signalDeviceId: 7, sessionId: 's-1'},
    emit: jest.fn(),
  } as unknown as Socket & {emit: jest.Mock};
}

function sendThis(opts: {wakeEligible: boolean}) {
  const sendChatWake = jest.fn(async () => ({sent: 1, stubbed: false}));
  const submitEnvelope = jest.fn(async () => ({
    envelopeId:   'env-0001',
    clientMsgId:  'cm-0001',
    deliveredNow: true,
    retractToken: 'rt-0001',
    wakeEligible: opts.wakeEligible,
  }));
  const self = {
    rateGate:         () => null,
    userRateExceeded: jest.fn(async () => false),
    envelopes:        {submitEnvelope},
    push:             {sendChatWake},
    logger:           {log: () => {}, warn: () => {}, error: () => {}},
  };
  return {self, sendChatWake, submitEnvelope};
}

const payload = (urgent?: boolean) => ({
  to:          {userId: PEER, deviceId: 1},
  outerSealed: 'b64-sealed',
  clientMsgId: 'cm-0001',
  urgent,
});

describe('P2-BR-3 — envelope.send wake gating (WS parity with HTTP)', () => {
  it('default send (urgent absent, wakeEligible) still fires the wake', async () => {
    const {self, sendChatWake} = sendThis({wakeEligible: true});
    const client = fakeClient();
    await proto.handleEnvelopeSend.call(self, payload(), client);
    // B-715 — exact shape on purpose (see the HTTP twin in
    // envelope.controller.spec): `envelopeId` rides for LOG correlation only, and
    // push-chat-wake.spec pins that the FCM `data` block is unchanged.
    expect(sendChatWake).toHaveBeenCalledWith(PEER, {senderUserId: ME, envelopeId: 'env-0001'});
    expect(client.emit).toHaveBeenCalledWith('envelope.accepted', expect.objectContaining({
      envelopeId: 'env-0001',
    }));
  });

  it('urgent:false (non-displayable envelope) skips the wake — send still accepted', async () => {
    const {self, sendChatWake} = sendThis({wakeEligible: true});
    const client = fakeClient();
    await proto.handleEnvelopeSend.call(self, payload(false), client);
    expect(sendChatWake).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('envelope.accepted', expect.anything());
  });

  it('wakeEligible:false (dedup-hit retry) skips the wake — send still accepted', async () => {
    const {self, sendChatWake} = sendThis({wakeEligible: false});
    const client = fakeClient();
    await proto.handleEnvelopeSend.call(self, payload(), client);
    expect(sendChatWake).not.toHaveBeenCalled();
    expect(client.emit).toHaveBeenCalledWith('envelope.accepted', expect.anything());
  });

  it('explicit urgent:true fires when eligible', async () => {
    const {self, sendChatWake} = sendThis({wakeEligible: true});
    await proto.handleEnvelopeSend.call(self, payload(true), fakeClient());
    expect(sendChatWake).toHaveBeenCalledTimes(1);
  });
});
