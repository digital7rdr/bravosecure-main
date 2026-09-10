/**
 * On-map bubble stacks — the pure state machine behind pushBubble / pushSystem.
 *
 * Ported from the WebView map (bravoAgentTrackerMapHtml.ts), where this logic
 * lives inside DOM callbacks and therefore cannot be tested at all. Keeping it
 * pure here is the point: the rules below are the ones B-406 was filed for, and
 * they are subtle enough that a source scan would not prove them.
 *
 * The rules, and why each exists:
 *  - De-dupe by id. The same envelope can arrive twice; two identical bubbles
 *    stacked on one marker reads as two messages.
 *  - Newest first. A driver glances once; the newest thing must be on top.
 *  - A VISIBLE WINDOW, not an unbounded list. Every waypoint event used to
 *    mount its own card and none ever yielded, which is how the map filled up.
 *    Entries past the window keep their place in the queue but drop their node.
 *  - SOS never auto-expires. Everything else has a TTL.
 *  - On expiry, PROMOTE a queued entry into the freed slot, so a bubble that
 *    was pushed out is not silently lost.
 */

export type BubbleKind = 'msg' | 'sos' | string;
export type BubbleAnchor = 'cpo' | 'principal';

/** Marker-anchored chat bubble. */
export interface MarkerBubble {
  id: string;
  kind: BubbleKind;
  sender?: string | null;
  name?: string | null;
  preview?: string | null;
  anchor: BubbleAnchor;
  /** Wall-clock ms at which this expires; null = holds (SOS). */
  expiresAt: number | null;
}

/** Coordinate-anchored mission event card. */
export interface SystemBubble {
  id: string;
  label?: string | null;
  preview?: string | null;
  lat: number;
  lng: number;
  expiresAt: number;
}

/** First N of each marker stack render; the rest are queued. */
export const MAX_MARKER_VISIBLE = 2;
/** B-406 — the cap that stopped the system-card pile-up. */
export const MAX_SYS_VISIBLE = 3;

export const DEFAULT_BUBBLE_TTL_MS = 6000;
export const DEFAULT_SYSTEM_TTL_MS = 8000;

export interface PushBubbleInput {
  id: string;
  kind?: BubbleKind | null;
  sender?: string | null;
  name?: string | null;
  preview?: string | null;
  anchor?: string | null;
  ttl?: number | null;
}

export interface PushSystemInput {
  id: string;
  label?: string | null;
  preview?: string | null;
  lat: number;
  lng: number;
  ttl?: number | null;
}

/**
 * Add a marker bubble. Returns the SAME array reference when the push is a
 * duplicate, so a caller can skip a re-render on the no-op.
 */
export function pushMarkerBubble(
  stack: readonly MarkerBubble[],
  input: PushBubbleInput,
  now: number,
): MarkerBubble[] {
  const anchor: BubbleAnchor = input.anchor === 'principal' ? 'principal' : 'cpo';
  if (stack.some(b => b.id === input.id && b.anchor === anchor)) {
    return stack as MarkerBubble[];
  }
  const kind = input.kind ?? 'msg';
  // SOS holds indefinitely — a panic bubble that times out is a lost alarm.
  const ttl = kind === 'sos' ? null : input.ttl ?? DEFAULT_BUBBLE_TTL_MS;
  const next: MarkerBubble = {
    id: input.id,
    kind,
    sender: input.sender ?? null,
    name: input.name ?? null,
    preview: input.preview ?? null,
    anchor,
    expiresAt: ttl === null ? null : now + ttl,
  };
  return [next, ...stack];
}

export function pushSystemBubble(
  list: readonly SystemBubble[],
  input: PushSystemInput,
  now: number,
): SystemBubble[] {
  if (input.lat === null || input.lat === undefined || input.lng === null || input.lng === undefined) {
    return list as SystemBubble[];
  }
  if (list.some(b => b.id === input.id)) {
    return list as SystemBubble[];
  }
  const next: SystemBubble = {
    id: input.id,
    label: input.label ?? null,
    preview: input.preview ?? null,
    lat: input.lat,
    lng: input.lng,
    expiresAt: now + (input.ttl ?? DEFAULT_SYSTEM_TTL_MS),
  };
  return [next, ...list];
}

/**
 * Drop everything whose TTL has passed. Returns the same reference when
 * nothing expired, so an idle tick costs no render.
 *
 * Expiry is evaluated against `now` rather than per-entry timers: one sweep
 * cannot leak a timer, and a backgrounded app that misses ten ticks catches up
 * in a single pass instead of firing ten stale callbacks.
 */
export function expireMarkerBubbles(
  stack: readonly MarkerBubble[],
  now: number,
): MarkerBubble[] {
  const kept = stack.filter(b => b.expiresAt === null || b.expiresAt > now);
  return kept.length === stack.length ? (stack as MarkerBubble[]) : kept;
}

export function expireSystemBubbles(
  list: readonly SystemBubble[],
  now: number,
): SystemBubble[] {
  const kept = list.filter(b => b.expiresAt > now);
  return kept.length === list.length ? (list as SystemBubble[]) : kept;
}

/**
 * The render window for one marker's stack. Promotion is implicit: expiry
 * removes from the array, so the next queued entry is simply inside the slice
 * on the following render — there is no separate promote step to forget.
 */
export function visibleForAnchor(
  stack: readonly MarkerBubble[],
  anchor: BubbleAnchor,
): MarkerBubble[] {
  return stack.filter(b => b.anchor === anchor).slice(0, MAX_MARKER_VISIBLE);
}

export function visibleSystem(list: readonly SystemBubble[]): SystemBubble[] {
  return list.slice(0, MAX_SYS_VISIBLE);
}

/**
 * The next moment any entry expires, or null when nothing is on a clock.
 * Lets the host schedule ONE timer instead of one per bubble.
 */
export function nextExpiry(
  markers: readonly MarkerBubble[],
  system: readonly SystemBubble[],
): number | null {
  const times: number[] = [];
  for (const m of markers) {
    if (m.expiresAt !== null) {
      times.push(m.expiresAt);
    }
  }
  for (const s of system) {
    times.push(s.expiresAt);
  }
  return times.length ? Math.min(...times) : null;
}
