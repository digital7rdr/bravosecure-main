/**
 * B-241 — how the client should surface an unsolicited gateway `error` frame.
 *
 * The WS gateway emits `{event:'error', data:{code, message}}` for a grab-bag of
 * reasons. Before this, the `dispatchFrame` `case 'error'` handler red-barred
 * EVERY code except `superseded`, and only auto-cleared the three call codes.
 * So a `rate_limited` frame — the gateway throttling a typing/presence/send
 * burst, which fires per keystroke (`messenger.gateway.ts` emits
 * `event <name> rate-limited; retry in <n>ms`) — left a persistent red
 * "Error: rate_limited: event typing rate-limited; retry in 15ms" banner on
 * ChatScreen. That is pure flow control: the retry is accepted, nothing is lost,
 * and there is nothing the user can do — so it must never be shown.
 *
 * This is the pure decision the frame handler consults. It changes NO security
 * behaviour: a genuinely actionable gateway error (auth, bad_request, …) still
 * red-bars exactly as before — it is the default.
 *
 *   'silent'     → log only, no banner (benign flow-control / lifecycle codes)
 *   'auto-clear' → brief red notice that clears itself (transient call codes)
 *   'persistent' → a real red banner that stays until superseded (default)
 *
 * Pure + zero-import (Tier A) so it runs under the node messenger-crypto project
 * (productionRuntime pulls react-native and cannot be imported there).
 */
export type GatewayErrorDisposition = 'silent' | 'auto-clear' | 'persistent';

// Benign, non-actionable codes the user must never see as a red banner:
//   superseded   — a newer socket from this device took over (remount/reconnect)
//   rate_limited — the gateway throttled a typing/presence/send burst; the retry
//                  is accepted and nothing is lost
const SILENT_CODES = new Set<string>(['superseded', 'rate_limited']);

// Call-setup codes that are transient — the gateway queued the offer and fired a
// VoIP push, so the call WILL ring when the callee returns. Show briefly, then
// auto-clear so it reads as a toast, not a stuck error.
const AUTO_CLEAR_CODES = new Set<string>(['peer_offline', 'busy', 'declined']);

export function gatewayErrorDisposition(code: string): GatewayErrorDisposition {
  if (SILENT_CODES.has(code)) {
    return 'silent';
  }
  if (AUTO_CLEAR_CODES.has(code)) {
    return 'auto-clear';
  }
  return 'persistent';
}
