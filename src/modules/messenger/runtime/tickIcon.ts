/**
 * B-131 companion — the ONE status→icon mapping, shared by every surface that
 * draws an outgoing tick (ChatScreen's bubble, Departmental Chat's bubble).
 * `messageTicks.ts` owns the RULE (status → semantic tick); this owns the
 * icon/colour each tick maps to, parameterised over the caller's own colour
 * tokens so a second copy of this switch can't quietly drift from the first
 * one — which is exactly the bug class B-131 was written to close.
 */
import {outgoingTick, type TickMessageLike} from './messageTicks';

export interface TickIcon {
  name: 'check' | 'check-all' | 'alert-circle' | 'progress-clock';
  color: string;
}

export interface TickIconTokens {
  /** Sent / delivered — unobtrusive. */
  mute: string;
  /** Read — draws the eye. */
  read: string;
  /** Failed / undelivered. */
  alert: string;
}

export function tickIcon(msg: TickMessageLike, tokens: TickIconTokens): TickIcon | null {
  switch (outgoingTick(msg)) {
    case 'pending':     return {name: 'progress-clock', color: tokens.mute};
    case 'single':      return {name: 'check',          color: tokens.mute};
    case 'double':      return {name: 'check-all',      color: tokens.mute};
    case 'double-read': return {name: 'check-all',      color: tokens.read};
    case 'failed':      return {name: 'alert-circle',   color: tokens.alert};
    default:            return null;
  }
}
