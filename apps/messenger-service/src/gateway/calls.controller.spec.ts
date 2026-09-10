/**
 * P1-BR-3 — POST /calls/:callId/decline contract tests.
 *
 * The controller is a thin authenticated shim over
 * MessengerGateway.declineCallViaHttp; what matters here is the CONTRACT:
 * caller identity comes from the verified JWT (never the body), the response
 * is ALWAYS 200 {ok:true} (idempotent — even when the call is gone or the
 * fan-out throws), and malformed callIds are no-op'd instead of erroring.
 */
import {CallsController} from './calls.controller';
import type {MessengerGateway} from './messenger.gateway';
import type {CallerContext} from '../common/guards/jwt-http.guard';

function makeController(declineImpl?: jest.Mock) {
  const decline = declineImpl ?? jest.fn(async () => undefined);
  const gateway = {declineCallViaHttp: decline} as unknown as MessengerGateway;
  return {ctrl: new CallsController(gateway), decline};
}

const CALLER = {claims: {sub: 'me-user'}, signalDeviceId: 7} as unknown as CallerContext;

describe('CallsController — POST /calls/:callId/decline (P1-BR-3)', () => {
  it('forwards the JWT identity + body to the gateway and returns {ok:true}', async () => {
    const {ctrl, decline} = makeController();
    const res = await ctrl.decline(CALLER, 'call-123', {
      peerUserId: 'caller-user', kind: 'direct',
    });
    expect(res).toEqual({ok: true});
    expect(decline).toHaveBeenCalledWith(
      {userId: 'me-user', deviceId: 7},
      'call-123',
      {peerUserId: 'caller-user', kind: 'direct', roomId: undefined},
    );
  });

  it('group decline threads roomId through', async () => {
    const {ctrl, decline} = makeController();
    await ctrl.decline(CALLER, 'room-1', {kind: 'group', roomId: 'room-1'});
    expect(decline).toHaveBeenCalledWith(
      {userId: 'me-user', deviceId: 7},
      'room-1',
      {peerUserId: undefined, kind: 'group', roomId: 'room-1'},
    );
  });

  it('still 200 {ok:true} when the gateway fan-out throws (call already gone)', async () => {
    const {ctrl} = makeController(jest.fn(async () => { throw new Error('redis down'); }));
    await expect(ctrl.decline(CALLER, 'call-123', {})).resolves.toEqual({ok: true});
  });

  it('malformed callId → no-op 200, gateway never touched', async () => {
    const {ctrl, decline} = makeController();
    await expect(ctrl.decline(CALLER, 'bad id/../%00', {})).resolves.toEqual({ok: true});
    await expect(ctrl.decline(CALLER, '', {})).resolves.toEqual({ok: true});
    expect(decline).not.toHaveBeenCalled();
  });
});
