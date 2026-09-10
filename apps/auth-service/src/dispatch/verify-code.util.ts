import {createHmac} from 'node:crypto';

/**
 * On-arrival identity verify code (BUILD_RUNBOOK Step 16) — SHARED so the client side
 * (BookingService.getVerifyCode) and the lead side (AgentService.getMissionVerifyCode)
 * derive the SAME value. If these two ever drifted apart the handover check would fail
 * silently, so the derivation lives in exactly one place.
 *
 * HMAC-SHA256(server actionSecret, "<bookingId>:<leadAgentId>:<timeBucket>") → first
 * 32 bits → mod 1e6 → 6 digits. DERIVED, never stored (no verify_code column). Two
 * properties make it a real handshake token:
 *   • bound to the lead's agent id → a different/unassigned person yields a different
 *     code, which is what makes the client's "not my guard" meaningful.
 *   • bound to a coarse time bucket → it ROTATES every window, so a code screenshotted
 *     and shared ahead of time is stale by arrival. BOTH sides read it from the server,
 *     so the bucket is computed from the SERVER clock (no client-clock drift); the only
 *     edge is the two reads straddling a rotation, which `rotates_at` lets the UI refresh.
 * Rotating JWT_ACTION_SECRET also invalidates every outstanding code at once.
 */
export const VERIFY_CODE_WINDOW_MS = 10 * 60 * 1000; // 10 min rotation window

export interface VerifyCodeResult {
  code: string;
  rotates_at: string; // ISO timestamp of the next rotation boundary
}

export function deriveVerifyCode(
  secret: string,
  bookingId: string,
  agentId: string,
  nowMs: number,
  windowMs: number = VERIFY_CODE_WINDOW_MS,
): VerifyCodeResult {
  const bucket = Math.floor(nowMs / windowMs);
  const mac = createHmac('sha256', secret).update(`${bookingId}:${agentId}:${bucket}`).digest('hex');
  const code = (parseInt(mac.slice(0, 8), 16) % 1_000_000).toString().padStart(6, '0');
  return {code, rotates_at: new Date((bucket + 1) * windowMs).toISOString()};
}
