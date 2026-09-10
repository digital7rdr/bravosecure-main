/**
 * Warm-start FIX-05 — a real SYNCING → SYNCED signal.
 *
 * Before this, nothing published "the relay drain is in flight / has settled".
 * Two consequences the spec calls out:
 *   - an empty thread and a thread whose 1000-envelope bootstrap page is still
 *     draining rendered identically ("No messages yet."), which on a cold boot
 *     with a backlog reads as data loss;
 *   - the notification-tap path had nothing to await, so it races a 6s timer
 *     (fcmBootstrap startTapTimePull).
 *
 * The publisher lives in productionRuntime.ts, which no test can import
 * (MESSAGE_LOOP §5) — so the wiring is pinned by a source scan and the
 * DECISION it feeds is pinned as a pure function.
 */
import {chatEmptyStateLabel} from '../ui/chatScreenLogic';

describe('chatEmptyStateLabel — what an empty thread is allowed to claim', () => {
  it('says nothing while the runtime is not ready (the status banner speaks)', () => {
    expect(chatEmptyStateLabel({ready: false, syncState: 'idle'})).toBeNull();
    expect(chatEmptyStateLabel({ready: false, syncState: 'syncing'})).toBeNull();
  });

  it('shows a syncing label instead of "No messages yet." while a drain is in flight', () => {
    expect(chatEmptyStateLabel({ready: true, syncState: 'syncing'})).toMatch(/sync/i);
  });

  it('also holds the claim back before ANY drain has run this session', () => {
    // 'idle' is not evidence of an empty inbox — no one has looked yet.
    expect(chatEmptyStateLabel({ready: true, syncState: 'idle'})).toMatch(/sync/i);
  });

  it('lets the normal empty state through only once a drain has settled', () => {
    expect(chatEmptyStateLabel({ready: true, syncState: 'synced'})).toBeNull();
  });
});

/**
 * Source scan for the publisher. CLAUDE.md rules: strip comments first (prose
 * containing the token is the usual false result), and never anchor on \n —
 * these files are CRLF and a \n-anchored regex passes VACUOUSLY.
 */
describe('FIX-05 — the drain publishes its phase (source scan)', () => {
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const RUNTIME = path.resolve(__dirname, '..', 'runtime', 'productionRuntime.ts');

  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '')
      .split(/\r?\n/)
      .map(l => l.replace(/(^|[^:])\/\/.*$/, '$1'))
      .join('\n');

  const src = (): string => stripComments(fs.readFileSync(RUNTIME, 'utf8'));

  it('publishes from the ONE coalescer, not from each drain trigger site', () => {
    const s = src();
    // Five sites trigger a drain (WS connect, AppState active, ChatScreen
    // focus, notification tap, push wake). N drifted copies of one behaviour
    // is this repo's most common bug shape.
    // Exactly two INVOCATIONS ('syncing' and 'synced'); the arrow-function
    // definition reads `const publishSyncState = (` and does not match.
    const publishes = (s.match(/publishSyncState\(/g) ?? []).length;
    expect(publishes).toBe(2);
    expect(s).toMatch(/const publishSyncState = \(/);
  });

  it('marks syncing before the pump and synced in a finally', () => {
    const s = src();
    const syncing = s.indexOf("publishSyncState('syncing')");
    const pump = s.indexOf('drainPump().finally(');
    const synced = s.indexOf("publishSyncState('synced')");
    expect(syncing).toBeGreaterThan(-1);
    expect(pump).toBeGreaterThan(syncing);
    // `finally`, not `then`: drainRelay swallows its own errors, and a phase
    // that can stick on 'syncing' is worse than no phase at all.
    expect(synced).toBeGreaterThan(pump);
  });

  it('never writes the store from a headless boot', () => {
    const s = src();
    const fn = s.indexOf('const publishSyncState');
    expect(fn).toBeGreaterThan(-1);
    const body = s.slice(fn, fn + 400);
    // The headless VM has no hydrated store (B-361/B-363 class); writing there
    // is how a background wake corrupts what the foreground renders next boot.
    expect(body).toMatch(/config\.backgroundBoot/);
    expect(body.indexOf('config.backgroundBoot')).toBeLessThan(body.indexOf('setSyncState'));
  });
});
