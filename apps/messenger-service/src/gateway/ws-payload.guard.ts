/**
 * AUDIT-2026-08-13 #16 — runtime shape guards for every WS handler.
 *
 * Interface types erase at runtime: a malformed frame's property access
 * (`data.callId.slice(...)`, `data.to.userId`) threw INSIDE handlers and
 * fed the B-05 crash-armor / pod-recycle path — an unauthenticated-shape
 * DoS lever on an authenticated socket. This guard rejects at ENTRY with
 * a typed `error` frame and a silent handler drop (no throw, no armor).
 *
 * Design: ONE spec table keyed by the @SubscribeMessage event name (read
 * from the handler's metadata), applied class-wide via @UseGuards. The
 * table's completeness is PINNED by a test that enumerates every
 * @SubscribeMessage in the gateway against these keys — an unlisted
 * handler fails the pin, so fail-open here can only span one commit.
 *
 * Guards are STRUCTURAL (types/presence only). Enum narrowing, ownership
 * and business rules stay in the handlers, which already do them — the
 * guard's one job is making `data.x.y` never throw.
 */
import {CanActivate, ExecutionContext, Injectable, Logger} from '@nestjs/common';
// Imported CONSTANT, not a string literal (critic): a Nest bump renaming
// the metadata key becomes a compile error instead of a silent class-wide
// fail-open — the unbounded silent-death mode this guard must not have.
import {MESSAGE_METADATA} from '@nestjs/websockets/constants';

/**
 * Field spec grammar:
 *   'string' | 'number' | 'boolean' | 'object'  — required primitive/object
 *   suffix '?'                                   — optional (absent/null ok)
 *   'string[]'                                   — array of strings
 *   'addr'                                       — {userId: string, deviceId: number}
 */
export type WsFieldSpec =
  | 'string' | 'number' | 'boolean' | 'object'
  | 'string?' | 'number?' | 'boolean?' | 'object?'
  | 'string[]' | 'string[]?'
  | 'addr' | 'addr?';

export interface WsEventSpec {
  /** `data` itself may be absent entirely (ping, envelope.pull). */
  optionalData?: boolean;
  fields: Record<string, WsFieldSpec>;
}

export const WS_PAYLOAD_SPECS: Record<string, WsEventSpec> = {
  'ping':                  {optionalData: true, fields: {ts: 'number?'}},
  'auth.refresh':          {fields: {token: 'string'}},
  'envelope.send':         {fields: {to: 'addr', outerSealed: 'string', clientMsgId: 'string', expiresAtSec: 'number?', urgent: 'boolean?'}},
  'envelope.ack':          {fields: {envelopeId: 'string', ackToken: 'string?', disposition: 'string?'}},
  'envelope.pull':         {optionalData: true, fields: {after: 'string?', limit: 'number?', bootstrap: 'boolean?'}},
  'call.offer':            {fields: {callId: 'string', to: 'addr', sdp: 'string', kind: 'string', auth: 'object?'}},
  'call.answer':           {fields: {callId: 'string', to: 'addr', sdp: 'string', auth: 'object?'}},
  'call.ice':              {fields: {callId: 'string', to: 'addr', candidate: 'string', sdpMid: 'string?', sdpMLineIndex: 'number?'}},
  'call.hangup':           {fields: {callId: 'string', to: 'addr', reason: 'string'}},
  'call.media-state':      {fields: {callId: 'string', to: 'addr', cameraOff: 'boolean', micOff: 'boolean', auth: 'object?'}},
  'call.reoffer':          {fields: {callId: 'string', to: 'addr', sdp: 'string'}},
  'call.reanswer':         {fields: {callId: 'string', to: 'addr', sdp: 'string'}},
  // WI-6.6 — read-only reconcile probe; the handler re-validates length ≤128.
  'call.sync':             {fields: {callId: 'string'}},
  // WI-6.7 / B-566 — ring identity on the cancel/decline/ack lanes.
  'typing':                {fields: {to: 'addr', state: 'string', convTag: 'string?'}},
  'read-receipt':          {fields: {to: 'addr', envelopeIds: 'string[]'}},
  'presence':              {fields: {state: 'string'}},
  'presence.subscribe':    {fields: {userIds: 'string[]'}},
  'presence.unsubscribe':  {fields: {userIds: 'string[]'}},
  'mission.subscribe':     {fields: {missionId: 'string'}},
  'mission.unsubscribe':   {fields: {missionId: 'string'}},
  'sfu.join':              {fields: {roomId: 'string', roomToken: 'string?'}},
  'sfu.transport.connect': {fields: {roomId: 'string', transportId: 'string', dtlsParameters: 'object'}},
  'sfu.transport.restartIce': {fields: {roomId: 'string', transportId: 'string'}},
  'sfu.produce':           {fields: {roomId: 'string', transportId: 'string', kind: 'string', rtpParameters: 'object'}},
  'sfu.consume':           {fields: {roomId: 'string', transportId: 'string', producerId: 'string', rtpCapabilities: 'object'}},
  'sfu.consumer.resume':   {fields: {roomId: 'string', consumerId: 'string'}},
  'sfu.consumer.pause':    {fields: {roomId: 'string', consumerId: 'string'}},
  'sfu.producer.pause':    {fields: {roomId: 'string', producerId: 'string'}},
  'sfu.producer.resume':   {fields: {roomId: 'string', producerId: 'string'}},
  'sfu.producers':         {fields: {roomId: 'string'}},
  'sfu.leave':             {fields: {roomId: 'string'}},
  'sfu.ring':              {fields: {roomId: 'string', conversationId: 'string', callType: 'string', callerName: 'string', recipientUserIds: 'string[]'}},
  'sfu.ring.cancel':       {fields: {roomId: 'string', conversationId: 'string', recipientUserIds: 'string[]', roomToken: 'string?', ringId: 'string?'}},
  'sfu.ring.decline':      {fields: {roomId: 'string', conversationId: 'string', roomToken: 'string?'}},
  // B-479 — the recipient's "I have this ring" ack, which is what clears a
  // queued replay. `roomToken` is optional on purpose: it is verified when
  // supplied, but the FCM rescue lane's payload may not carry one, and the ack
  // can only ever delete the CALLER'S OWN queued ring.
  'sfu.ring.ack':          {fields: {roomId: 'string', roomToken: 'string?', ringId: 'string?'}},
  'sfu.mute-target':       {fields: {roomId: 'string', targetTag: 'string', unmute: 'boolean?'}},
  'sfu.kick':              {fields: {roomId: 'string', targetTag: 'string'}},
};

/** @returns a violation description, or null when the payload conforms. */
export function validateWsPayload(event: string, data: unknown, spec: WsEventSpec): string | null {
  if (data === undefined || data === null) {
    return spec.optionalData ? null : `${event}: missing payload`;
  }
  if (typeof data !== 'object' || Array.isArray(data)) {
    return `${event}: payload must be an object`;
  }
  const d = data as Record<string, unknown>;
  for (const [key, s] of Object.entries(spec.fields)) {
    const optional = s.endsWith('?');
    const base = (optional ? s.slice(0, -1) : s) as 'string' | 'number' | 'boolean' | 'object' | 'string[]' | 'addr';
    const v = d[key];
    if (v === undefined || v === null) {
      if (optional) {continue;}
      return `${event}: missing ${key}`;
    }
    if (base === 'string[]') {
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        return `${event}: ${key} must be string[]`;
      }
      continue;
    }
    if (base === 'addr') {
      const a = v as Record<string, unknown>;
      if (typeof v !== 'object' || Array.isArray(v)
          || typeof a.userId !== 'string' || typeof a.deviceId !== 'number') {
        return `${event}: ${key} must be {userId: string, deviceId: number}`;
      }
      continue;
    }
    if (base === 'object') {
      // Plain objects only (edge F1): socket.io's binary protocol can
      // deliver a Buffer here — typeof 'object', not an array — and the
      // handler's `v.fingerprints[0]` then throws exactly like the
      // pre-fix shapes. JSON-parsed payloads are always plain.
      const proto = typeof v === 'object' ? Object.getPrototypeOf(v) : undefined;
      if (typeof v !== 'object' || Array.isArray(v)
          || (proto !== Object.prototype && proto !== null)) {
        return `${event}: ${key} must be an object`;
      }
      continue;
    }
    if (typeof v !== base) {
      return `${event}: ${key} must be ${base}`;
    }
  }
  return null;
}

@Injectable()
export class WsPayloadGuard implements CanActivate {
  private readonly logger = new Logger(WsPayloadGuard.name);

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'ws') {return true;}
    // The @SubscribeMessage event name lives under MESSAGE_METADATA on the
    // handler function (verified: @nestjs/websockets defineMetadata on
    // descriptor.value — context.getHandler() IS that function).
    const event = Reflect.getMetadata(MESSAGE_METADATA, context.getHandler()) as string | undefined;
    if (!event) {return true;}
    const spec = WS_PAYLOAD_SPECS[event];
    // Fail-open ONLY for an event not in the table — the completeness pin
    // (wsPayloadGuard.spec.ts) makes that state unshippable past a commit.
    if (!spec) {return true;}
    const data = context.switchToWs().getData();
    const violation = validateWsPayload(event, data, spec);
    if (violation === null) {return true;}
    // Reject at entry: typed error frame + silent handler drop. Never
    // throw — a throw is exactly the crash-armor lever this guard kills.
    try {
      const client = context.switchToWs().getClient<{emit?: (ev: string, d: unknown) => void}>();
      client.emit?.('error', {code: 'bad_payload', message: violation});
    } catch { /* socket mid-teardown — nothing to tell */ }
    this.logger.warn(`bad_payload dropped: ${violation}`);
    return false;
  }
}
