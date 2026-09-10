# SRV-07 - `connectionStateRecovery` is advertised to every client but can never fire (stock Redis adapter no-ops `restoreSession`)

## Verdict

**CONFIRMED** (with one material addition the audit missed — see §Mechanism step 6).

Evidence from the current tree:

1. `apps/messenger-service/src/gateway/redis-io.adapter.ts:71-77` — the adapter choice is
   flag-gated, and the flag is off everywhere:
   ```ts
   if (process.env.WS_SESSION_RECOVERY === 'true') {
     this.adapterConstructor = createSessionAwareRedisAdapter(this.pub, this.sub);
   ```
2. `apps/messenger-service/src/gateway/redis-io.adapter.ts:107-110` — but the _option_ is set
   unconditionally: `connectionStateRecovery: {maxDisconnectionDuration: 2 * 60 * 1000,
skipMiddlewares: false}`.
3. `apps/messenger-service/node_modules/@socket.io/redis-adapter/dist/index.js:53` —
   `class RedisAdapter extends socket_io_adapter_1.Adapter` (the _base_ Adapter, not
   `SessionAwareAdapter`), and `node_modules/socket.io-adapter/dist/in-memory-adapter.js:307-309`
   — `restoreSession(pid, offset) { return null; }`. So with the stock adapter recovery is a
   guaranteed no-op.
4. `WS_SESSION_RECOVERY` appears in **zero** runtime config: absent from
   `apps/messenger-service/.env`, `apps/messenger-service/.env.example`, `docker-compose.yml`,
   `scripts/deploy-staging.sh` and `.github/workflows/deploy-staging.yml`. Grep hits are only the
   adapter itself plus five audit/QA docs.
5. The file's own sibling already documents this: `session-aware-redis-adapter.ts:14-20` — "the
   base Adapter's no-op `restoreSession` is in effect — every reconnect logs `recovered=no` … the
   original wiring (Round 2) had the connectionStateRecovery config 'enabled' but it never
   actually fired."
6. The dead config is **not inert on the client**: because
   `this.server._opts.connectionStateRecovery` is truthy, `node_modules/socket.io/dist/socket.js:117-119`
   mints a `pid` and `:414-417` ships it in the CONNECT payload, which drives the whole
   pid/offset persistence machine in `packages/messenger-core/src/transport/client.ts:13-21`,
   `:775-784`, `:861-894`, `:958-964` — a pair of AsyncStorage writes/reads on every connect and
   every distinct broadcast, all of which can never produce a recovery.

Prior sightings of the same defect: `docs/audits/CALL_LIFECYCLE_CONTINUITY_AUDIT_2026-07-18.md:34`
(LC-7) and `docs/audits/BACKGROUND_RELIABILITY_AUDIT_2026-07-10.md:123`. It has now been reported
three times and closed zero times because each report proposed an _env_ action nobody owns.

## Mechanism

1. `main.ts:47` constructs `RedisIoAdapter`; `:48` calls `connectToRedis()`.
2. `WS_SESSION_RECOVERY` is unset ⇒ `redis-io.adapter.ts:75` installs the stock
   `createAdapter(pub, sub)`.
3. Nest calls `createIOServer`, which merges `connectionStateRecovery` into the socket.io server
   options unconditionally (`redis-io.adapter.ts:107-110`).
4. socket.io now believes recovery is enabled: `namespace.js:250-255` will call
   `this.adapter.restoreSession(sessionId, offset)` whenever a client presents `auth.pid` **and**
   `auth.offset` as strings. `RedisAdapter` inherits `Adapter.restoreSession` → returns `null` →
   `_createSocket` falls through to `new Socket(this, client, auth)` with no session.
   `client.recovered` is therefore always `false`, which is exactly what
   `messenger.gateway.ts:530` logs (`recovered=no`) on every single connect.
5. Client-side cost of the lie: `socket.js:117` mints a `pid` (because the option is truthy) and
   `:416` sends it. `client.ts:884-894` captures `_pid`, writes it to AsyncStorage, rehydrates it
   on the next open (`:775-784`), and re-presents it in `auth` (`:821-827`). Every one of those
   handshakes takes the `sock.recovered !== true` branch at `client.ts:878-883`, wipes the stored
   offset, and starts over. Net effect: 1 extra AsyncStorage read-pair per connect + 1 write per
   pid + 1 write per distinct broadcast offset (`client.ts:961-963`), for zero behaviour. No
   messages are lost by this (envelopes are durable in Redis and replayed by
   `flushPendingOnConnect`, `messenger.gateway.ts:538`), but every _volatile_ frame — typing,
   presence, receipt fan-out — is dropped on every blip, which is the user-visible half of OR-5.
6. **What the audit missed — why "just set the flag" is NOT a safe fix.**
   `SessionAwareRedisAdapter.doRestoreSession` keys the lookup on `pid` alone
   (`session-aware-redis-adapter.ts:164-168`) with **no subject binding**. And socket.io applies
   the restored session inside the `Socket` constructor, i.e. _before_ the Nest handshake
   middleware runs:
   ```js
   // node_modules/socket.io/dist/socket.js:96-107
   if (previousSession) {
     this.id = previousSession.sid;
     this.pid = previousSession.pid;
     previousSession.rooms.forEach((room) => this.join(room));
     this.data = previousSession.data;
     previousSession.missedPackets.forEach((packet) => { this.packet({...}); });
   ```
   `namespace.js:212-221` calls `_createSocket` first and only then `this.run(socket, ...)` (the
   `server.use()` chain at `messenger.gateway.ts:346`). `this.packet(...)` writes straight to the
   transport. So a client that presents **any** valid JWT plus **someone else's** pid joins that
   victim's `user:<id>` / `dev:<id>:<n>` rooms and gets their buffered broadcasts flushed to the
   wire before a single auth check runs. The gateway's `socket.data = ctx` overwrite
   (`messenger.gateway.ts:362`) fixes the _claims_ but not the already-joined rooms and not the
   already-flushed packets. The pid is a 128-bit server-minted bearer secret — unguessable, but
   `client.ts:891` persists it to **plaintext AsyncStorage** under `bravo:transport:recoveryPid`,
   so on a rooted device or an ADB backup it is readable. That is a cross-account leak of
   presence/typing/receipt frames and of E2EE envelope _ciphertext_ addressed to another user.
   Flipping `WS_SESSION_RECOVERY=true` as the audit proposes turns that hole on.

## Fix

Two parts. **Part A is the change to ship now** — it is a pure no-op for the running server and
makes the flag a single honest switch. **Part B is the precondition** that must land before anyone
sets `WS_SESSION_RECOVERY=true`; it is deliberately _not_ bundled into Part A.

### Part A — couple the option to the adapter (ship now)

File: `apps/messenger-service/src/gateway/redis-io.adapter.ts`

**A1 — resolve the flag once, as a field.**

Anchor (verbatim, current):

```ts
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pub?: Redis;
  private sub?: Redis;
```

Replacement:

```ts
/**
 * Recovery buffer window. Used both as socket.io's
 * `maxDisconnectionDuration` and as SessionAwareRedisAdapter's session /
 * packet retention (it reads this same option off `nsp.server.opts`).
 */
const SESSION_RECOVERY_WINDOW_MS = 2 * 60 * 1000;

export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private adapterConstructor?: ReturnType<typeof createAdapter>;
  private pub?: Redis;
  private sub?: Redis;
  // Why: socket.io only calls `adapter.restoreSession` when the
  // `connectionStateRecovery` option is present, and only
  // SessionAwareRedisAdapter implements it — the stock RedisAdapter
  // inherits `Adapter.restoreSession`, which returns null. Advertising
  // recovery without that adapter makes every client mint, persist and
  // re-present a pid/offset that can never match. One field drives both
  // decisions so the two can never disagree again.
  private readonly sessionRecovery = process.env.WS_SESSION_RECOVERY === 'true';
```

**A2 — use the field in `connectToRedis`.**

Anchor (verbatim, current):

```ts
    if (process.env.WS_SESSION_RECOVERY === 'true') {
      this.adapterConstructor = createSessionAwareRedisAdapter(this.pub, this.sub);
```

Replacement:

```ts
    if (this.sessionRecovery) {
      this.adapterConstructor = createSessionAwareRedisAdapter(this.pub, this.sub);
```

**A3 — gate the option itself.**

Anchor (verbatim, current — the whole trailing block of `merged`):

```ts
      // socket.io 4.6+ connection state recovery — the server buffers a
      // disconnected socket's missed packets for this window; if the
      // client reconnects with the same session id it rejoins the same
      // rooms and receives everything it missed. Keeps mobile users from
      // losing typing + presence frames during brief network blips
      // (subway, elevator, lock-screen).
      //
      // Why skipMiddlewares: false — socket.io does NOT preserve custom
      // `socket.data` across the recovery boundary, only session id,
      // rooms, and missed packets. With `skipMiddlewares: true` the auth
      // middleware doesn't run on recovery, so `socket.data.claims` is
      // undefined and handleConnection drops the socket as unauthorized
      // (every recovery attempt logged `recovered=no`). Running the
      // middleware again repopulates socket.data — JWT verify is cheap,
      // and we still get the win: same session id, same rooms, queued
      // packets replayed without going through flushPendingOnConnect.
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 min
        skipMiddlewares:          false,
      },
    };
```

Replacement:

```ts
      // socket.io 4.6+ connection state recovery — the server buffers a
      // disconnected socket's missed packets for this window; if the
      // client reconnects with the same session id it rejoins the same
      // rooms and receives everything it missed. Keeps mobile users from
      // losing typing + presence frames during brief network blips
      // (subway, elevator, lock-screen).
      //
      // SRV-07/OR-5: only advertised when the SessionAware adapter is
      // actually installed. With the stock adapter `restoreSession`
      // returns null, so leaving this on merely made socket.io mint a
      // `pid` for every client and made the mobile transport persist and
      // re-present a pid/offset that could never match.
      //
      // Why skipMiddlewares: false — socket.io does NOT preserve custom
      // `socket.data` across the recovery boundary, only session id,
      // rooms, and missed packets. With `skipMiddlewares: true` the auth
      // middleware doesn't run on recovery, so `socket.data.claims` is
      // undefined and handleConnection drops the socket as unauthorized.
      ...(this.sessionRecovery
        ? {
          connectionStateRecovery: {
            maxDisconnectionDuration: SESSION_RECOVERY_WINDOW_MS,
            skipMiddlewares:          false,
          },
        }
        : {}),
    };
```

No wire-format change and no schema change. Back-compat for already-shipped clients:

- **Current release client** (`packages/messenger-core/src/transport/client.ts:877-894`) already
  handles a missing `_pid`: `sock.recovered !== true` clears the stored offset, `nextPid` resolves
  to `null`, `RECOVERY_PID_KEY` is removed, and the next handshake omits `auth.pid`/`auth.offset`
  entirely (`:824-826`). Behaviour is identical, minus two AsyncStorage writes.
- **Older clients** that fell back to `socket.id` as the pid (the pre-P1-13 build described in the
  comment at `client.ts:868-876`) will keep sending `auth.pid` + `auth.offset`.
  `namespace.js:249-251` short-circuits on `this.server.opts.connectionStateRecovery` being
  falsy, so the fields are ignored and a fresh session is minted — exactly what happens today when
  `restoreSession` returns null. No regression.
- **ops-console** (`apps/ops-console/src/lib/messenger/transport.ts:132-151`) never sends
  `auth.pid` and reads only `args[0]` in `onAny`. Unaffected.

### Part B — precondition for ever setting `WS_SESSION_RECOVERY=true` (do NOT bundle with A)

Blocking, in this order:

1. **Subject-bind the recovery session.** `session-aware-redis-adapter.ts:164-189` must not hand a
   session to a caller that cannot prove it owns the pid. `restoreSession(pid, offset)` receives no
   auth context and runs before the middleware, so the binding cannot be added inside the adapter
   without patching socket.io internals. The sound, small fix is on the client: drop the
   AsyncStorage persistence of pid/offset in `packages/messenger-core/src/transport/client.ts`
   (`RECOVERY_PID_KEY` / `RECOVERY_OFFSET_KEY`, `:13`, `:21`, `:484-485`, `:775-784`, `:882`,
   `:891-893`, `:963`) and keep both values **in memory only**. That preserves the real use case
   (in-process reconnect after a blip or screen lock, which is where the volatile frames are lost)
   and removes the at-rest bearer secret. A kill-revive already pays a full `flushPendingOnConnect`
   (`messenger.gateway.ts:538`), so the only thing given up is typing/presence frames that are
   worthless after a process death.
2. **Defence in depth in the gateway.** In `handleConnection`, after `socket.data = ctx` is in
   place, when `client.recovered === true` leave any room that is not
   `hub.deviceRoom({userId: claims.sub, deviceId: signalDeviceId})`, `hub.userRoom(claims.sub)` or
   `client.id`. This does not un-send the already-flushed missed packets, so it is a backstop, not
   the fix — item 1 is the fix.
3. **Strip the two raw `console.log` diagnostics** that fire on every disconnect/reconnect once the
   adapter is live: `session-aware-redis-adapter.ts:149` and `:167`. They bypass the Nest logger
   and the file's own comment says "Strip once recovery is verified working in staging." Values are
   opaque (pid prefix, offset, counts) so there is no `logAudit` exposure, but they are noise at
   connection rate.
4. **Bound the packet buffer.** `session-aware-redis-adapter.ts:102` is an unbounded array trimmed
   only by a 60s GC over a 2-min window; it holds the full data array of every broadcast, including
   `envelope.deliver` ciphertext. Add a hard cap (e.g. 10 000 entries, oldest-evicted) before this
   runs in front of real traffic.
5. **Staging verification** (single replica — the documented sweet spot,
   `session-aware-redis-adapter.ts:33-41`): two clients, kill the network on one for 20s, confirm
   `ws open … recovered=yes` at `messenger.gateway.ts:530` and that typing/presence emitted during
   the gap arrive on reconnect; then confirm a _third_ client with a different account presenting
   the first client's pid gets `recovered=no`.
6. Only then add `WS_SESSION_RECOVERY: 'true'` to `docker-compose.yml` (next to
   `WS_HEARTBEAT_GRACE`) and to `apps/messenger-service/.env.example` with the multi-replica
   sticky-session caveat. **Never in prod without sticky sessions** — with >1 replica a reconnect
   landing on another pod finds no pid and silently degrades (documented at
   `session-aware-redis-adapter.ts:33-41`).

## Blast radius

- **Changed file (Part A):** `apps/messenger-service/src/gateway/redis-io.adapter.ts` only —
  `connectToRedis()` and `createIOServer()`. Both are called exactly once, from
  `apps/messenger-service/src/main.ts:47-49`. No other caller
  (`grep -rn "RedisIoAdapter"` → main.ts + the file itself).
- **Server-side readers of the removed capability:** `client.recovered` is read only by the log
  line at `apps/messenger-service/src/gateway/messenger.gateway.ts:530`, which already prints
  `recovered=no` on every connect today — unchanged. The middleware comment at
  `messenger.gateway.ts:322-327` about `skipMiddlewares` stays accurate (it describes the enabled
  case).
- **Client-side:** `packages/messenger-core/src/transport/client.ts` — no code change in Part A;
  the existing `_pid`-absent branch (`:877-894`) already degrades correctly. `apps/ops-console`
  transport untouched.
- **No persisted schema, no migration, no wire field.** SQLCipher/outbox schema untouched.
- **Overlapping findings:** **OR-5 is the same root cause** (client half of this defect) — the two
  must be fixed by one diff; OR-5 must not independently edit `redis-io.adapter.ts`. **LC-7**
  (`CALL_LIFECYCLE_CONTINUITY_AUDIT_2026-07-18.md:34`) is the prior report of the same thing.
  Nothing here touches `messenger.gateway.ts`, so **SRV-02/SRV-03/SRV-06/SRV-08** do not collide.
- **What could regress:** nothing at runtime for the server. The one behavioural delta reaching a
  device is that `sock._pid` becomes undefined, which drives the client's
  `AsyncStorage.removeItem(RECOVERY_PID_KEY)` path once per install. If a future change assumes
  `socket.pid` exists server-side it will now be `undefined` when the flag is off — the field is
  currently referenced nowhere in `apps/**`.

## Tests

Jest project: the messenger-service standalone runner (`apps/messenger-service/package.json` →
`jest.rootDir: "src"`, `testRegex: ".*\\.spec\\.ts$"`, `testEnvironment: "node"`). Run with
`cd apps/messenger-service && npm test`. Style reference: `messenger.gateway.handshake.spec.ts`
(pure unit, hand-rolled fakes, no infra).

**New file:** `apps/messenger-service/src/gateway/redis-io.adapter.spec.ts`

```ts
/**
 * SRV-07/OR-5 — `connectionStateRecovery` must be advertised ONLY when
 * SessionAwareRedisAdapter is installed. With the stock RedisAdapter,
 * `restoreSession` inherits Adapter's `return null`, so the option only
 * made socket.io mint a pid the client could never redeem.
 */
import {IoAdapter} from '@nestjs/platform-socket.io';
import type {INestApplicationContext} from '@nestjs/common';
import type {ServerOptions} from 'socket.io';
import {RedisIoAdapter} from './redis-io.adapter';

const app = {} as INestApplicationContext;

function build(): RedisIoAdapter {
  return new RedisIoAdapter(app, 'redis://127.0.0.1:6379', 30_000, 25_000, 262_144, []);
}

describe('SRV-07 — connectionStateRecovery is flag-coupled', () => {
  let spy: jest.SpyInstance;
  const prev = process.env.WS_SESSION_RECOVERY;

  beforeEach(() => {
    spy = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue({adapter: jest.fn()} as never);
  });
  afterEach(() => {
    spy.mockRestore();
    if (prev === undefined) delete process.env.WS_SESSION_RECOVERY;
    else process.env.WS_SESSION_RECOVERY = prev;
  });

  test('flag unset → option is absent (stock adapter cannot restore)', () => {
    delete process.env.WS_SESSION_RECOVERY;
    build().createIOServer(0);
    const opts = spy.mock.calls[0][1] as Partial<ServerOptions>;
    expect(opts.connectionStateRecovery).toBeUndefined();
  });

  test('flag set to a non-"true" value → still absent', () => {
    process.env.WS_SESSION_RECOVERY = '1';
    build().createIOServer(0);
    const opts = spy.mock.calls[0][1] as Partial<ServerOptions>;
    expect(opts.connectionStateRecovery).toBeUndefined();
  });

  test('flag=true → option present with a 2-min window and middlewares ON', () => {
    process.env.WS_SESSION_RECOVERY = 'true';
    build().createIOServer(0);
    const opts = spy.mock.calls[0][1] as Partial<ServerOptions>;
    expect(opts.connectionStateRecovery).toEqual({
      maxDisconnectionDuration: 120_000,
      skipMiddlewares: false,
    });
  });

  test('unrelated transport options are unchanged in both states', () => {
    delete process.env.WS_SESSION_RECOVERY;
    build().createIOServer(0);
    const opts = spy.mock.calls[0][1] as Partial<ServerOptions>;
    expect(opts.pingInterval).toBe(30_000);
    expect(opts.pingTimeout).toBe(25_000);
    expect(opts.maxHttpBufferSize).toBe(262_144);
    expect(opts.transports).toEqual(['websocket']);
  });
});
```

Regression suites to run, in order:

1. `cd apps/messenger-service && npm test` — the 12 existing gateway/relay specs, in particular
   `messenger.gateway.handshake.spec.ts`, `messenger.gateway.calls.spec.ts`,
   `messenger.gateway.envelope-wake.spec.ts`, `connection-registry.spec.ts`.
2. `cd apps/messenger-service && npm run typecheck`.
3. Repo root `npm run test:crypto` — untouched by this diff, but it is the standing gate for
   anything in the messenger lane and it must stay green.
4. Root `npm run typecheck` — must not exceed the `.tsc-baseline.json` count (47). No mobile file
   changes in Part A, so this should be a no-op.

Device smoke (5 min, no APK rebuild required — server-only change): boot the app against a
messenger-service running this diff, send + receive a 1:1 and a group message, background/foreground
once, and confirm `ws open … recovered=no` in the service log with no `connect_error` and no change
in reconnect latency.

If Part B ever ships, add `apps/messenger-service/src/gateway/session-aware-redis-adapter.spec.ts`
asserting: `restoreSession` returns null for an unknown pid; returns null for a session past
`maxDisconnectionDuration`; `broadcast` appends exactly one offset string and skips packets with an
ack id or the volatile flag; the packet buffer never exceeds its cap.

## Risk

- **The audit's own prescribed fix ("verify + set `WS_SESSION_RECOVERY=true`") is the wrong first
  move.** It enables a code path whose session lookup is pid-only and runs before the auth
  middleware (§Mechanism 6). A reviewer should reject any diff that flips the flag without Part B
  item 1.
- **This spec deliberately fixes the _symmetry_, not the _feature_.** After Part A the recovery
  feature is still off and volatile frames are still lost on every blip — that is OR-5's user-visible
  complaint and it remains open by design. If a reviewer expects SRV-07 to make recovery _work_,
  that is a bigger change gated on Part B + staging verification, not a P3.
- **Flag read moved from method to constructor.** `main.ts:47-48` constructs and calls
  `connectToRedis()` on adjacent lines, both after `@nestjs/config` has populated `process.env`, so
  the resolution moment is unchanged. Worth a glance anyway. A reviewer may reasonably prefer
  threading it through `configuration.ts` (`ws.sessionRecovery`) + a constructor param like every
  other option in this class; that is a 3-file diff and I chose the 1-file version to stay minimal —
  push back if house style wins.
- **The literal `2 * 60 * 1000` is duplicated** in `session-aware-redis-adapter.ts:120` as a
  fallback. Part A introduces `SESSION_RECOVERY_WINDOW_MS` in the adapter file but deliberately does
  **not** touch the sibling's fallback (it is dead today and the coupling now guarantees the option
  is present whenever that adapter is constructed). Do not "tidy" it in this diff.
- **Nothing security-sensitive is weakened.** Part A strictly removes an advertised capability; it
  touches no encryption primitive, no envelope shape, no AAD binding, no sender-cert path, no vault
  MFA gate, and logs nothing new. It is not a CLAUDE.md stop condition. The _enablement_ (Part B +
  the env flip) does touch session-restore ordering relative to the auth middleware and should get a
  security review before staging.
