/**
 * AUDIT-2026-08-13 #16 — WS payload guards.
 *
 * The load-bearing pin is COMPLETENESS: the guard fails open for events
 * missing from its spec table, so this suite enumerates every
 * @SubscribeMessage in the gateway source and requires a 1:1 mapping
 * with WS_PAYLOAD_SPECS. A new handler without a spec — or a spec whose
 * handler was deleted — goes RED here.
 */
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {BadRequestException, ForbiddenException, PayloadTooLargeException} from '@nestjs/common';
import {WS_PAYLOAD_SPECS, validateWsPayload, WsPayloadGuard} from './ws-payload.guard';
import {toWsError} from './messenger.gateway';

describe('AUDIT #16 — spec-table completeness (the fail-open window is one commit wide)', () => {
  it('every @SubscribeMessage handler has a spec, and every spec has a handler', () => {
    const src = readFileSync(join(__dirname, 'messenger.gateway.ts'), 'utf8');
    const events = [...src.matchAll(/@SubscribeMessage\('([^']+)'\)/g)].map(m => m[1]).sort();
    expect(events.length).toBeGreaterThanOrEqual(30); // anti-vacuous
    const specKeys = Object.keys(WS_PAYLOAD_SPECS).sort();
    expect(specKeys).toEqual([...new Set(events)].sort());
  });

  it('no payload-carrying spec is EMPTY (edge F2 — the empty-fields decoy)', () => {
    // `'x': {fields: {}}` satisfies the key-completeness pin while
    // accepting ANY object — a decoy that survived mutation testing.
    // Every non-optionalData spec must demand at least one required field.
    const offenders = Object.entries(WS_PAYLOAD_SPECS)
      .filter(([, s]) => !s.optionalData)
      .filter(([, s]) => !Object.values(s.fields).some(f => !f.endsWith('?')))
      .map(([k]) => k);
    expect(offenders).toEqual([]);
  });

  it('the guard is applied CLASS-WIDE on the gateway', () => {
    const src = readFileSync(join(__dirname, 'messenger.gateway.ts'), 'utf8');
    const lines = src.split(/\r?\n/).map(l => l.trim());
    expect(lines.some(l => l.startsWith('@UseGuards(WsPayloadGuard)'))).toBe(true);
  });

  it('the REAL metadata read works against the REAL gateway class (critic — the unbounded silent-death pin)', async () => {
    // The behavioral tests inject their own metadata and the completeness
    // pin is a source regex — neither exercises Reflect.getMetadata
    // against what @SubscribeMessage actually stored. A Nest bump that
    // moved/renamed the metadata would fail-open the guard CLASS-WIDE
    // with every other test green. This is the one read that notices.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {MessengerGateway} = require('./messenger.gateway');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const {MESSAGE_METADATA} = require('@nestjs/websockets/constants');
    expect(Reflect.getMetadata(MESSAGE_METADATA, MessengerGateway.prototype.handleEnvelopeSend)).toBe('envelope.send');
    expect(Reflect.getMetadata(MESSAGE_METADATA, MessengerGateway.prototype.handlePing)).toBe('ping');
  });
});

describe('AUDIT #16 — validateWsPayload against the audit\'s crash shapes', () => {
  const offerSpec = WS_PAYLOAD_SPECS['call.offer'];

  it('the exact pre-fix crashers are rejected, not thrown', () => {
    // data.callId.slice(...) / data.to.userId on malformed frames.
    expect(validateWsPayload('call.offer', undefined, offerSpec)).toMatch(/missing payload/);
    expect(validateWsPayload('call.offer', 'not-an-object', offerSpec)).toMatch(/must be an object/);
    expect(validateWsPayload('call.offer', {}, offerSpec)).toMatch(/missing callId/);
    expect(validateWsPayload('call.offer', {callId: 42, to: {userId: 'u', deviceId: 1}, sdp: 's', kind: 'voice'}, offerSpec)).toMatch(/callId must be string/);
    expect(validateWsPayload('call.offer', {callId: 'c', to: 'not-an-addr', sdp: 's', kind: 'voice'}, offerSpec)).toMatch(/to must be \{userId/);
    expect(validateWsPayload('call.offer', {callId: 'c', to: {userId: 'u'}, sdp: 's', kind: 'voice'}, offerSpec)).toMatch(/to must be \{userId/);
  });

  it('a Buffer does NOT pass an object field (edge F1 — socket.io binary frames)', () => {
    const spec = WS_PAYLOAD_SPECS['sfu.transport.connect'];
    expect(validateWsPayload('sfu.transport.connect',
      {roomId: 'r', transportId: 't', dtlsParameters: Buffer.from('x')}, spec)).toMatch(/must be an object/);
    expect(validateWsPayload('sfu.transport.connect',
      {roomId: 'r', transportId: 't', dtlsParameters: new Uint8Array(4)}, spec)).toMatch(/must be an object/);
    // Plain and null-prototype objects (JSON.parse output) still pass.
    expect(validateWsPayload('sfu.transport.connect',
      {roomId: 'r', transportId: 't', dtlsParameters: {role: 'client'}}, spec)).toBeNull();
    expect(validateWsPayload('sfu.transport.connect',
      {roomId: 'r', transportId: 't', dtlsParameters: Object.assign(Object.create(null), {role: 'client'})}, spec)).toBeNull();
  });

  it('valid frames pass, including optional-field and null-optional shapes', () => {
    expect(validateWsPayload('call.offer',
      {callId: 'c', to: {userId: 'u', deviceId: 1}, sdp: 's', kind: 'voice'}, offerSpec)).toBeNull();
    // call.ice ships sdpMid: null legitimately — null-optional must pass.
    expect(validateWsPayload('call.ice',
      {callId: 'c', to: {userId: 'u', deviceId: 1}, candidate: 'x', sdpMid: null, sdpMLineIndex: null},
      WS_PAYLOAD_SPECS['call.ice'])).toBeNull();
    // optionalData events accept a missing payload entirely.
    expect(validateWsPayload('ping', undefined, WS_PAYLOAD_SPECS['ping'])).toBeNull();
    expect(validateWsPayload('envelope.pull', undefined, WS_PAYLOAD_SPECS['envelope.pull'])).toBeNull();
    // string[] enforcement (sfu.ring recipient list).
    expect(validateWsPayload('sfu.ring',
      {roomId: 'r', conversationId: 'c', callType: 'voice', callerName: 'n', recipientUserIds: ['a', 'b']},
      WS_PAYLOAD_SPECS['sfu.ring'])).toBeNull();
    expect(validateWsPayload('sfu.ring',
      {roomId: 'r', conversationId: 'c', callType: 'voice', callerName: 'n', recipientUserIds: ['a', 5]},
      WS_PAYLOAD_SPECS['sfu.ring'])).toMatch(/recipientUserIds must be string\[\]/);
  });
});

describe('AUDIT #16 — the guard rejects with a typed frame, never a throw', () => {
  function makeCtx(event: string | undefined, data: unknown) {
    const emitted: Array<{ev: string; d: unknown}> = [];
    const handler = () => undefined;
    if (event) {Reflect.defineMetadata('message', event, handler);}
    const ctx = {
      getType: () => 'ws',
      getHandler: () => handler,
      switchToWs: () => ({
        getData: () => data,
        getClient: () => ({emit: (ev: string, d: unknown) => { emitted.push({ev, d}); }}),
      }),
    } as never;
    return {ctx, emitted};
  }

  it('bad payload → error frame + false (handler never runs)', () => {
    const guard = new WsPayloadGuard();
    const {ctx, emitted} = makeCtx('call.offer', {});
    expect(guard.canActivate(ctx)).toBe(false);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].ev).toBe('error');
    expect((emitted[0].d as {code: string}).code).toBe('bad_payload');
  });

  it('good payload → true; unknown event → fail-open true (pinned one-commit window)', () => {
    const guard = new WsPayloadGuard();
    const good = makeCtx('call.offer', {callId: 'c', to: {userId: 'u', deviceId: 1}, sdp: 's', kind: 'voice'});
    expect(guard.canActivate(good.ctx)).toBe(true);
    const unknown = makeCtx('brand.new.event', {whatever: true});
    expect(guard.canActivate(unknown.ctx)).toBe(true);
    const nonWs = {getType: () => 'http'} as never;
    expect(guard.canActivate(nonWs)).toBe(true);
  });
});

describe('AUDIT E-1 — WS error mapping is CLASS-based, never message substring', () => {
  it('maps the live typed throws to the same wire codes as before', () => {
    // Wire-compat: these are the exact throws the services use today.
    expect(toWsError(new BadRequestException('invalid_recipient')).data.code).toBe('bad_request');
    expect(toWsError(new ForbiddenException('not_recipient')).data.code).toBe('forbidden');
    expect(toWsError(new PayloadTooLargeException('ciphertext_too_large')).data.code).toBe('too_large');
    expect(toWsError(new Error('anything else')).data.code).toBe('internal');
    expect(toWsError('a thrown string').data.code).toBe('internal');
  });

  it('a REWORDED message no longer flips the code (the substring failure mode)', () => {
    // Under the old mapping this classified 'internal' because the prose
    // changed; class mapping is immune.
    expect(toWsError(new BadRequestException('the recipient set was invalid')).data.code).toBe('bad_request');
  });

  it('the substring map is DEAD in the gateway source', () => {
    const src = readFileSync(join(__dirname, 'messenger.gateway.ts'), 'utf8');
    const codeOnly = src.split(/\r?\n/)
      .filter(l => { const t = l.trim(); return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')); })
      .join('\n');
    expect(codeOnly).not.toMatch(/msg\.includes\('invalid_recipient'\)/);
    expect(codeOnly).not.toMatch(/\.includes\('not_recipient'\)/);
  });
});
