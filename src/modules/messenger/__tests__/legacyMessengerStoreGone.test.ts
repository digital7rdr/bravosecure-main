/**
 * B-156 (L6) — there is exactly ONE `messengerStore.ts`.
 *
 * The repo carried a second, Twilio-era `src/store/messengerStore.ts` (120 lines)
 * whose only consumer was `src/hooks/useRealtimeMessages.ts` — itself imported by
 * nothing. That hook subscribed to Supabase Realtime (the pre-relay transport) and
 * pulled the whole store with a selector-less `useMessengerStore()`, so reviving it
 * would have re-rendered its host on EVERY store commit.
 *
 * The real hazard was not the wasted bytes, it was the name collision:
 * `docs/handoffs/FABLE_BRIEF_MESSAGE_PIPELINE_SIMPLIFICATION.md` flags "two files
 * named messengerStore.ts — a grep-driven refactor will hit the wrong file". Every
 * live consumer imports `@/modules/messenger/store/messengerStore`; the legacy copy
 * existed only to catch a careless grep.
 *
 * The whole dead chain (hook → legacy store → `@services/twilio`, which had no other
 * importer) was deleted. Same discipline as B-152: a duplicate nothing imports cannot
 * be kept honest by any test, so it goes rather than gets pinned.
 *
 * If a legacy store is ever legitimately needed again, update this test DELIBERATELY
 * with the reason — do not delete it to make a red run green.
 */

import {existsSync, readFileSync, readdirSync} from 'node:fs';
import {join} from 'node:path';

const SRC = join(process.cwd(), 'src');

describe('B-156 — the Twilio-era messenger chain stays deleted', () => {
  it.each([
    ['src/store/messengerStore.ts', join(SRC, 'store', 'messengerStore.ts')],
    ['src/hooks/useRealtimeMessages.ts', join(SRC, 'hooks', 'useRealtimeMessages.ts')],
    ['src/services/twilio.ts', join(SRC, 'services', 'twilio.ts')],
  ])('%s does not exist', (_label, path) => {
    expect(existsSync(path)).toBe(false);
  });

  it('the real store is still where every consumer expects it', () => {
    // The counter-example that stops this being read as "delete stores".
    expect(existsSync(join(SRC, 'modules', 'messenger', 'store', 'messengerStore.ts'))).toBe(true);
  });

  it('nothing imports the legacy @store/messengerStore alias or the twilio service', () => {
    // Walk the source tree rather than trusting a stale file list: a NEW file that
    // reaches for either module is exactly the regression this guards.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '__tests__') {continue;}
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name)) {continue;}
        const src = readFileSync(full, 'utf8');
        if (/from\s*'@store\/messengerStore'/.test(src)) {offenders.push(`${full} → @store/messengerStore`);}
        if (/from\s*'@services\/twilio'/.test(src))     {offenders.push(`${full} → @services/twilio`);}
      }
    };
    walk(SRC);
    expect(offenders).toEqual([]);
  });
});
