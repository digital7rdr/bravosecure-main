/**
 * RT-3 (XO-1 + XO-2) — deferred outbox payloads + the drain's routing decision.
 *
 * Two loss classes meet here:
 *  - XO-2: a send whose crypto prep could not run (no sender cert on an
 *    offline launch, no session) used to fail-fast with NO outbox row. It is
 *    now persisted as an INTENT (`deferred: true`); the drain re-seals it with
 *    a fresh cert + session when connectivity returns. A4 already did this
 *    per-peer inside the group fan-out; these shapes generalise it.
 *  - XO-1: a fully-sealed 1:1/reaction row queued past the ~1h sender-cert TTL
 *    used to ship verbatim; the recipient destroys an expired cert BEFORE
 *    libsignal decrypt while the relay answers 200 — silent loss behind a
 *    'sent' tick. Rows now carry `certExpSec` + re-seal inputs (SN-06 parity),
 *    so the drain re-mints instead.
 *
 * Kept free of native/runtime imports (type-only imports are erased) so it can
 * be unit-tested without standing up productionRuntime — same rationale as
 * `outboxCertFreshness.ts`.
 */

import type {SealedAttachment, SealedMention, SealedPayload} from '@bravo/messenger-core';
import {isStoredCertStale} from './outboxCertFreshness';

/** A4 — group per-peer deferred row. `sealedBody` is already master-key-wrapped. */
export interface DeferredGroupOutboxPayload {
  deferred:      true;
  sealedBody:    string;
  expiresAtSec?: number;
  attachment?:   SealedAttachment;
  groupId:       string;
  kind:          'text' | 'admin';
  clientMsgId:   string;
  /**
   * B-144 — a group reply queued while offline must still arrive AS a
   * reply. The direct shape has carried this since XO-2; the group shape
   * never did, so the drain re-sealed without it and the quote strip was
   * lost on exactly the sends most likely to be retried. Same optional
   * shape as the direct row so `ResealableOutboxPayload.replyTo` covers
   * both branches of `resealOutboxRow`.
   */
  replyTo?:      {msgId: string; preview: string};
  /**
   * Same B-144 lesson as `replyTo` above, one field later: a group post with
   * @-mentions that was queued offline must still arrive AS a mention, or the
   * highlight and the "you were mentioned" notification are lost on exactly
   * the sends most likely to be retried.
   */
  mentions?:     SealedMention[];
  /** MM-09 — same lesson again: a queued forward must arrive labelled. */
  isForwarded?:  boolean;
}

/**
 * XO-2 — 1:1 deferred row. There is no group master key to wrap under, so the
 * row carries the send intent. It sits in the SQLCipher outbox beside the same
 * text already persisted in the SQLCipher `messages` row, so this adds no new
 * at-rest exposure class. Never log `body`.
 */
export interface DeferredDirectOutboxPayload {
  deferred:      true;
  direct:        true;
  body:          string;
  expiresAtSec?: number;
  attachment?:   SealedAttachment;
  replyTo?:      {msgId: string; preview: string};
  mentions?:     SealedMention[];
  /** MM-09 — same lesson as the group shape: a queued forward stays labelled. */
  isForwarded?:  boolean;
  clientMsgId:   string;
}

export type DeferredOutboxPayload = DeferredGroupOutboxPayload | DeferredDirectOutboxPayload;

export interface ReactionDirective {
  targetMsgId: string;
  emoji:       string;
  remove?:     boolean;
}

/**
 * An edit or a delete-for-everyone directive, queued for re-mint.
 *
 * One shape for both because the drain treats them identically — a control
 * envelope with an empty body, a target id, and an optional group routing
 * stamp. Splitting them would give the reseal branch two near-identical arms,
 * which is exactly the drift that produced the M5 divergences.
 */
export interface MutationDirective {
  edit?:      NonNullable<SealedPayload['edit']>;
  deleteFor?: NonNullable<SealedPayload['deleteFor']>;
}

/**
 * Everything a re-sealable stored payload may carry, in any generation of the
 * shape. Flat single interface rather than a discriminated union: the drain
 * reads one loose JSON blob and the reseal callback branches once, so a union
 * would force casts at every touchpoint for zero safety gain.
 */
export interface ResealableOutboxPayload {
  deferred?:     true;
  /** XO-2 — marks a 1:1 deferred row (vs the A4 group shape). */
  direct?:       true;
  /** XO-1 — absent ⇒ group row (SN-06 / A4), the only sealed shape before RT-3. */
  resealKind?:   'direct' | 'reaction' | 'mutation';
  expiresAtSec?: number;
  attachment?:   SealedAttachment;
  clientMsgId?:  string;
  /** group rows */
  sealedBody?:   string;
  groupId?:      string;
  kind?:         'text' | 'admin';
  /** 1:1 rows. `body` may legitimately be '' (media caption). */
  body?:         string;
  replyTo?:      {msgId: string; preview: string};
  /** text rows (1:1 and group) carry their @-mentions so a re-mint keeps them. */
  mentions?:     SealedMention[];
  /** MM-09 — forwarded flag; a re-mint must keep it (same B-144 lesson). */
  isForwarded?:  boolean;
  /** reaction rows carry only the directive (+ group stamp when in a group). */
  reaction?:     ReactionDirective;
  /** edit / delete-for-everyone rows: exactly one of the two is set. */
  edit?:         NonNullable<SealedPayload['edit']>;
  deleteFor?:    NonNullable<SealedPayload['deleteFor']>;
  group?:        {groupId: string; kind: 'text'; clientMsgId: string};
}

export type ResealOutboxFn = (
  /** OM-05 — `createdAt` is the row's compose moment, carried into `aad.ts`. */
  row: {peerUserId: string; peerDeviceId: number; clientMsgId: string; createdAt: number},
  payload: ResealableOutboxPayload,
) => Promise<{outerSealed: string; expiresAtSec?: number}>;

/** Everything a stored outbox payload may carry, in any generation of the shape. */
type ParsedOutboxPayload = ResealableOutboxPayload & {
  outerSealed?: string;
  certExpSec?:  number;
  /** GF-2 — group key-material/admin row: no bubble, no re-mintable body. */
  keyMaterial?: boolean;
  urgent?:      boolean;
};

export function isDeferredDirect(p: ResealableOutboxPayload): p is DeferredDirectOutboxPayload {
  return p.deferred === true && p.direct === true;
}

/**
 * A deferred row that carries neither a group body nor a direct body can never
 * be re-sealed. Only reachable after an app DOWNGRADE past a newer payload
 * shape; the drain drops it (and surfaces a retry chip) instead of looping.
 */
export function isUnresealableDeferred(p: ParsedOutboxPayload): boolean {
  if (p.deferred !== true) {
    return false;
  }
  if (p.direct === true) {
    return typeof p.body !== 'string';
  }
  return typeof p.sealedBody !== 'string' || typeof p.groupId !== 'string';
}

/**
 * XO-1 — can a sealed row whose cert aged out be re-minted from what it
 * stored? Direct rows pin `typeof body === 'string'` (a media caption is
 * legitimately ''; a truthiness check would silently drop every image send).
 */
function isStaleRowResealable(p: ParsedOutboxPayload): boolean {
  if (p.resealKind === 'direct') {
    return typeof p.body === 'string';
  }
  if (p.resealKind === 'reaction') {
    return p.reaction !== undefined;
  }
  if (p.resealKind === 'mutation') {
    return p.edit !== undefined || p.deleteFor !== undefined;
  }
  return typeof p.sealedBody === 'string' && typeof p.groupId === 'string';
}

export type OutboxDrainAction =
  | {
      mode: 'ship';
      outerSealed: string;
      expiresAtSec?: number;
      keyMaterial?: boolean;
      urgent?: boolean;
      /** SYNC-1 — present ⇒ this row is one leg of a GROUP fan-out. */
      groupId?: string;
    }
  | {mode: 'reseal'; payload: ResealableOutboxPayload; staleCert: boolean}
  | {mode: 'drop'; reason: 'corrupt' | 'unresealable' | 'no_payload' | 'stale_key_material'}
  | {mode: 'fail'; reason: 'cert_expired_unresealable'};

/**
 * Decide what the drain should do with one stored payload. Preserves the
 * pre-existing semantics exactly:
 *   - unparseable JSON  → drop (was: catch around JSON.parse)
 *   - `deferred: true`  → re-seal (A4 / XO-2)
 *   - stored bytes with a stale cert → re-seal when re-mintable, else fail
 *     loudly rather than ship a dead envelope (SN-06 / XO-1)
 *   - neither sealed nor deferred → drop
 * Rows written before SN-06 carry no `certExpSec` and stay on the ship path
 * (`isStoredCertStale(undefined) === false`) — no upgrade hazard.
 */
export function planOutboxDrain(raw: string, nowMs: number = Date.now()): OutboxDrainAction {
  let parsed: ParsedOutboxPayload;
  try {
    parsed = JSON.parse(raw) as ParsedOutboxPayload;
  } catch {
    return {mode: 'drop', reason: 'corrupt'};
  }
  if (!parsed || typeof parsed !== 'object') {
    return {mode: 'drop', reason: 'corrupt'};
  }
  if (parsed.deferred === true) {
    if (isUnresealableDeferred(parsed)) {
      return {mode: 'drop', reason: 'unresealable'};
    }
    return {mode: 'reseal', payload: parsed, staleCert: false};
  }
  if (typeof parsed.outerSealed === 'string') {
    if (isStoredCertStale(parsed.certExpSec, nowMs)) {
      // GF-2 — a key-material row deliberately persists no re-mintable body
      // (the group key is never duplicated at rest), so a dead cert means the
      // recipient destroys it pre-decrypt. Shipping it is the silent loss
      // SN-06 exists to prevent: drop the row and let the receive-side
      // key-request self-heal (GF-3) re-solicit the key.
      if (parsed.keyMaterial === true) {
        return {mode: 'drop', reason: 'stale_key_material'};
      }
      if (!isStaleRowResealable(parsed)) {
        return {mode: 'fail', reason: 'cert_expired_unresealable'};
      }
      return {mode: 'reseal', payload: parsed, staleCert: true};
    }
    return {
      mode:         'ship',
      outerSealed:  parsed.outerSealed,
      expiresAtSec: parsed.expiresAtSec,
      keyMaterial:  parsed.keyMaterial === true ? true : undefined,
      urgent:       parsed.urgent,
      groupId:      typeof parsed.groupId === 'string' ? parsed.groupId : undefined,
    };
  }
  return {mode: 'drop', reason: 'no_payload'};
}

/** XO-1 — sealed 1:1 row: bytes + freshness metadata + re-mint inputs. */
export interface SealedDirectOutboxPayload extends ResealableOutboxPayload {
  outerSealed: string;
  certExpSec:  number;
  resealKind:  'direct';
  body:        string;
  clientMsgId: string;
}

export function buildDirectSealedOutboxPayload(args: {
  outerSealed:   string;
  expiresAtSec?: number;
  certExpSec:    number;
  body:          string;
  attachment?:   SealedAttachment;
  replyTo?:      {msgId: string; preview: string};
  mentions?:     SealedMention[];
  isForwarded?:  boolean;
  clientMsgId:   string;
}): SealedDirectOutboxPayload {
  return {
    outerSealed:  args.outerSealed,
    expiresAtSec: args.expiresAtSec,
    certExpSec:   args.certExpSec,
    resealKind:   'direct',
    body:         args.body,
    attachment:   args.attachment,
    replyTo:      args.replyTo,
    mentions:     args.mentions?.length ? args.mentions : undefined,
    isForwarded:  args.isForwarded === true ? true : undefined,
    clientMsgId:  args.clientMsgId,
  };
}

/** XO-1 — sealed reaction row: bytes + freshness metadata + the directive. */
export interface SealedReactionOutboxPayload extends ResealableOutboxPayload {
  outerSealed: string;
  certExpSec:  number;
  resealKind:  'reaction';
  reaction:    ReactionDirective;
  clientMsgId: string;
}

export function buildReactionSealedOutboxPayload(args: {
  outerSealed: string;
  certExpSec:  number;
  reaction:    ReactionDirective;
  group?:      {groupId: string; kind: 'text'; clientMsgId: string};
  clientMsgId: string;
}): SealedReactionOutboxPayload {
  return {
    outerSealed: args.outerSealed,
    certExpSec:  args.certExpSec,
    resealKind:  'reaction',
    reaction:    args.reaction,
    group:       args.group,
    clientMsgId: args.clientMsgId,
  };
}

/**
 * XO-1 — sealed edit / delete-for-everyone row.
 *
 * These need the durable row for the same reason reactions do (MSG-08): the
 * directive is fire-and-forget over the WS, so one dropped socket frame means
 * the peer keeps rendering the old body — or, worse for a delete, keeps
 * rendering content the author has already retracted everywhere else. Both are
 * idempotent on replay, so a duplicate drain costs nothing.
 */
export interface SealedMutationOutboxPayload extends ResealableOutboxPayload {
  outerSealed: string;
  certExpSec:  number;
  resealKind:  'mutation';
  clientMsgId: string;
}

export function buildMutationSealedOutboxPayload(args: {
  outerSealed: string;
  certExpSec:  number;
  mutation:    MutationDirective;
  group?:      {groupId: string; kind: 'text'; clientMsgId: string};
  clientMsgId: string;
}): SealedMutationOutboxPayload {
  return {
    outerSealed: args.outerSealed,
    certExpSec:  args.certExpSec,
    resealKind:  'mutation',
    edit:        args.mutation.edit,
    deleteFor:   args.mutation.deleteFor,
    group:       args.group,
    clientMsgId: args.clientMsgId,
  };
}
