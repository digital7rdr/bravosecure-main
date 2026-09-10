import type {Request} from 'express';

/**
 * Audit Rev2 API-01 — the ONE place that answers "who sent this request".
 *
 * There were four copies of this, all doing:
 *
 *   (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim() ?? req.ip
 *
 * i.e. taking the LEFTMOST X-Forwarded-For value, which is entirely
 * attacker-supplied — nothing strips an inbound XFF. Every ops_audit row for
 * register / login / TOTP / biometric / key-upload therefore recorded an
 * address the caller chose, which is worse than recording nothing: it reads
 * like evidence.
 *
 * `req.ip` is the correct answer now that main.ts sets `trust proxy` to a hop
 * COUNT rather than `true`. Express walks the XFF chain right-to-left and stops
 * after that many trusted hops, so the result is the address our own proxy
 * actually observed, not the one the client typed. Do not reintroduce manual
 * header parsing here — the hop count is the only thing that makes it sound.
 */
export function clientIp(req: Request): string {
  return req.ip ?? 'unknown';
}
