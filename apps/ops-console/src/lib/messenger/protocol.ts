/**
 * Wire-frame mirror of `apps/messenger-service/src/gateway/protocol.ts`.
 *
 * Kept as a separate file (not a shared package) because the Next.js
 * build and the NestJS build have incompatible tsconfigs. When the
 * server changes a frame shape, change it here in the same commit —
 * type drift is silent.
 */

import type {SessionAddress} from './types';

// ─── Outbound (client → server) ────────────────────────────────────

export interface ClientPing {
  event: 'ping';
  data?: {ts: number};
}

export interface ClientEnvelopeSend {
  event: 'envelope.send';
  data: {
    to:           SessionAddress;
    /** Sealed Sender v2 outer ECIES wrap (base64). Replaces `{ciphertext, senderAddressHint}`. */
    outerSealed:  string;
    clientMsgId:  string;
    expiresAtSec?: number;
  };
}

export interface ClientEnvelopeAck {
  event: 'envelope.ack';
  data:  {envelopeId: string};
}

export interface ClientTyping {
  event: 'typing';
  data:  {to: SessionAddress; state: 'start' | 'stop'; convTag?: string};
}

export interface ClientReadReceipt {
  event: 'read-receipt';
  data:  {to: SessionAddress; envelopeIds: string[]};
}

export interface ClientPresence {
  event: 'presence';
  data:  {state: 'active' | 'away'};
}

export interface ClientPresenceSubscribe {
  event: 'presence.subscribe';
  data:  {userIds: string[]};
}

export interface ClientPresenceUnsubscribe {
  event: 'presence.unsubscribe';
  data:  {userIds: string[]};
}

export type ClientFrame =
  | ClientPing
  | ClientEnvelopeSend
  | ClientEnvelopeAck
  | ClientTyping
  | ClientReadReceipt
  | ClientPresence
  | ClientPresenceSubscribe
  | ClientPresenceUnsubscribe;

// ─── Inbound (server → client) ─────────────────────────────────────

export interface ServerPong {
  event: 'pong';
  data:  {ts: number};
}

export interface ServerEnvelopeAccepted {
  event: 'envelope.accepted';
  data:  {clientMsgId: string; envelopeId: string; retractToken?: string};
}

export interface ServerEnvelopeDeliver {
  event: 'envelope.deliver';
  data:  {
    envelopeId:    string;
    /** Sealed Sender v2 outer ECIES wrap (base64). */
    outerSealed:   string;
    timestamp:     number;
    clientMsgId?:  string;
    expiresAtSec?: number;
  };
}

export interface ServerError {
  event: 'error';
  data:  {code: string; message: string};
}

export interface ServerTyping {
  event: 'typing';
  data:  {from: SessionAddress; state: 'start' | 'stop'; convTag?: string};
}

export interface ServerReadReceipt {
  event: 'read-receipt';
  data:  {from: SessionAddress; envelopeIds: string[]};
}

export interface ServerPresence {
  event: 'presence';
  data:  {
    userId:      string;
    state:       'online' | 'active' | 'away' | 'offline';
    lastSeenMs?: number;
  };
}

export type ServerFrame =
  | ServerPong
  | ServerEnvelopeAccepted
  | ServerEnvelopeDeliver
  | ServerError
  | ServerTyping
  | ServerReadReceipt
  | ServerPresence;
