/**
 * B-88 — branded replacement for React Native's `Alert.alert`.
 *
 * The native Android AlertDialog renders in the SYSTEM theme (white
 * card, purple Material buttons) on top of the obsidian app — 248 call
 * sites shipped that clash. This module keeps the EXACT `Alert.alert`
 * signature so call sites don't change; only their import line does:
 *
 *   import {Alert} from '@utils/alert';   // was: from 'react-native'
 *
 * The queue here is PURE (no react-native imports) so it stays
 * unit-testable in a node env; `BravoAlertHost` (mounted once in
 * App.tsx) subscribes and renders the obsidian/cobalt dialog inside a
 * transparent RN Modal — which stacks above any other open Modal on
 * Android, matching how the native dialog floated above everything.
 *
 * Semantics mirror RN Android:
 *   - no buttons → single "OK"
 *   - back / backdrop dismisses when `options.cancelable` (default true,
 *     as in RN Android) and fires `options.onDismiss` — button onPress
 *     handlers are NOT called on a dismiss.
 *   - alerts issued while one is visible queue FIFO.
 */

export interface BravoAlertButton {
  text?:    string;
  onPress?: () => void;
  style?:   'default' | 'cancel' | 'destructive';
}

export interface BravoAlertOptions {
  cancelable?: boolean;
  onDismiss?:  () => void;
}

export interface BravoAlertRequest {
  id:       number;
  title:    string;
  message?: string;
  buttons:  BravoAlertButton[];
  options?: BravoAlertOptions;
}

let nextId = 1;
let queue: BravoAlertRequest[] = [];
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try { cb(); } catch { /* one bad subscriber mustn't break the rest */ }
  }
}

export function subscribeAlerts(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The alert currently on screen (head of the queue), or null. */
export function currentAlert(): BravoAlertRequest | null {
  return queue[0] ?? null;
}

function show(
  title: string,
  message?: string,
  buttons?: BravoAlertButton[],
  options?: BravoAlertOptions,
): void {
  const t = String(title ?? '');
  const m = message === undefined || message === null ? undefined : String(message);
  // NAV-16 (2026-08-26 rapid-use audit) — coalesce identical HANDLER-LESS
  // requests. A mashed action whose failure path alerts used to enqueue one
  // dialog per tap, dismissed one at a time. Only pure info alerts (no button
  // onPress, no onDismiss) may be dropped: several call sites wrap Alert in a
  // Promise settled ONLY by their own handlers (locationPermission,
  // ShiftEditor), so dropping a handler-carrying duplicate would strand that
  // caller's await forever (critic finding, this session). Handler-carrying
  // confirms guard at their own source instead (see confirmSwitchDashboard).
  // A repeat AFTER dismissal still shows — the queue no longer holds it.
  const handlerless =
    (!buttons || buttons.every(b => !b.onPress)) && !options?.onDismiss;
  if (handlerless && queue.some(q => q.title === t && q.message === m)) {return;}
  queue = [...queue, {
    id:      nextId++,
    title:   t,
    message: m,
    buttons: buttons && buttons.length > 0 ? buttons : [{text: 'OK'}],
    options,
  }];
  notify();
}

/** A button was pressed — advance the queue, THEN run its handler (so a handler that opens another alert queues cleanly). */
export function pressAlertButton(id: number, button: BravoAlertButton): void {
  if (queue[0]?.id !== id) {return;}
  queue = queue.slice(1);
  notify();
  try { button.onPress?.(); } catch { /* caller's handler threw — the dialog must still close */ }
}

/**
 * Backdrop tap / hardware back. Only acts when the request is
 * cancelable (RN Android default: true); fires onDismiss, never a
 * button handler — mirrors the native dialog.
 */
export function dismissCurrentAlert(): void {
  const current = queue[0];
  if (!current) {return;}
  if (current.options?.cancelable === false) {return;}
  queue = queue.slice(1);
  notify();
  try { current.options?.onDismiss?.(); } catch { /* best-effort */ }
}

/** Test seam. */
export function _resetAlertsForTest(): void {
  queue = [];
  lastConfirmSwitchAt = 0;
  notify();
}

export type AlertButtonVariant = 'primary' | 'secondary' | 'cancel' | 'destructive';

/**
 * Pure presentation mapping (unit-tested):
 *   - cancel      → glass button
 *   - destructive → red-tinted button
 *   - default     → cobalt; when several defaults exist, only the LAST
 *                   is the filled primary (one-primary-action rule)
 *   - axis: ≤2 buttons side-by-side (cancel pinned left), 3+ stacked
 */
export function resolveAlertLayout(buttons: BravoAlertButton[]): {
  axis: 'row' | 'column';
  items: Array<{button: BravoAlertButton; variant: AlertButtonVariant}>;
} {
  const lastDefaultIdx = buttons.reduce(
    (acc, b, i) => ((b.style ?? 'default') === 'default' ? i : acc), -1);
  const items = buttons.map((button, i) => {
    const style = button.style ?? 'default';
    const variant: AlertButtonVariant =
      style === 'cancel' ? 'cancel'
      : style === 'destructive' ? 'destructive'
      : i === lastDefaultIdx ? 'primary'
      : 'secondary';
    return {button, variant};
  });
  // B-680/FS-54: a half-card button holds ~14 chars at the 1.3 font ceiling
  // before numberOfLines={2} truncates the verb — long labels stack instead.
  const fitsRow = items.every(i => (i.button.text ?? '').length <= 14);
  if (items.length <= 2 && fitsRow) {
    // Cancel reads left in a row (native Android order).
    items.sort((a, b) => (a.variant === 'cancel' ? -1 : 0) - (b.variant === 'cancel' ? -1 : 0));
    return {axis: 'row', items};
  }
  if (items.length <= 2) {
    // Long-label 2-button stack: action on top, cancel last — consistently,
    // regardless of call order (critic P1-2). 3+ keeps call order (pinned).
    items.sort((a, b) => (a.variant === 'cancel' ? 1 : 0) - (b.variant === 'cancel' ? 1 : 0));
  }
  return {axis: 'column', items};
}

/** Drop-in for `import {Alert} from 'react-native'`. */
export const Alert = {
  alert: show,
};

/**
 * Channels vs2 item 18 — "are you sure you want to go?" before a dashboard
 * switch.
 *
 * ONE helper because there are three callers (the switch section's
 * cross-product path, the drawer's workspace row, and the live-call variant)
 * and the client asked for one wording. Three hand-written Alerts would drift
 * in copy first and in button order second, and button order is the part a user
 * learns by muscle memory.
 *
 * NAMES THE DESTINATION, never claims a departure. The plan's draft copy was
 * "Are you sure you wish to leave {current}?" — but the drawer row it is wired
 * to resolves INSIDE the current product (it does not call `switchProduct`, and
 * the product key never changes), so that sentence would have been false on the
 * very row that prompted it. It also contradicted the deliberate exemption for
 * the Departmental messenger tab, which leaves with no confirm at all.
 *
 * `destructive` is not set on Yes: this is navigation, not deletion, and a red
 * button for "go to your workspace" reads as a warning about the destination.
 */
// NAV-16 — leading-edge latch: the switch tiles have no disabled state, so a
// mash used to stack one confirm dialog per tap. The alert-queue dedupe above
// deliberately excludes handler-carrying requests, so this confirm guards at
// its own source. Repeats inside the window are the same question.
let lastConfirmSwitchAt = 0;

export function confirmSwitchDashboard(
  destination: string,
  onYes: () => void,
  opts?: {note?: string},
): void {
  const now = Date.now();
  if (now - lastConfirmSwitchAt < 600) {return;}
  lastConfirmSwitchAt = now;
  show(
    `Go to ${destination}?`,
    opts?.note ?? 'You can come back from the menu at any time.',
    [
      {text: 'No', style: 'cancel'},
      {text: 'Yes', onPress: onYes},
    ],
  );
}
