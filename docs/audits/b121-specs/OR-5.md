# OR-5 — `connectionStateRecovery` is inert server-side (`WS_SESSION_RECOVERY` never set anywhere)

## Verdict

**CONFIRMED** — but the audit's "env/ops change, no code" framing is **wrong**. Flipping the flag
activates ~225 lines of never-unit-tested broadcast-path code plus two `console.log`s on every
disconnect/restore, and the repo has no tracked staging deploy file to put the var in.

Evidence from the current tree:

1. `apps/messenger-service/src/gateway/redis-io.adapter.ts:71-77` — the gate:
   ```ts
   if (process.env.WS_SESSION_RECOVERY === 'true') {
     this.adapterConstructor = createSessionAwareRedisAdapter(this.pub, this.sub);
   ```
   and `:107-110` unconditionally sets `connectionStateRecovery: {maxDisconnectionDuration: 2*60*1000, skipMiddlewares: false}`.
2. `WS_SESSION_RECOVERY` occurs in **zero** config/deploy artefacts. Verified absent from
   `apps/messenger-service/src/config/configuration.ts` (every other WS knob — `WS_PATH`,
   `WS_HEARTBEAT_MS`, `WS_HEARTBEAT_GRACE`, `WS_MAX_PAYLOAD_BYTES` — is there), from
   `apps/messenger-service/.env.example`, `infra/env/messenger.env.example`, root
   `docker-compose.yml`, and `.github/workflows/deploy-staging.yml`. Its only occurrences outside
   `redis-io.adapter.ts` are audit prose and `TEST_PLAN.md:18,116`.
3. With the flag off, the stock adapter's base class is in effect:
   `node_modules/socket.io-adapter/dist/in-memory-adapter.js:301` `persistSession(session) { }` and
   `:307-309` `restoreSession(pid, offset) { return null; }`. `node_modules/socket.io/dist/namespace.js:255-263`
   treats that falsy result as "mint a fresh Socket". Every reconnect is cold.
4. The client genuinely does its half — `packages/messenger-core/src/transport/client.ts` sends
   `auth: {token, signalDeviceId, ...(this.recoveryPid ? {pid: this.recoveryPid, offset: this.recoveryOffset ?? ''} : {})}`,
   captures `_pid` on `connect` (P1-13 fix) and scrapes the trailing offset arg in `onAny`
   (`const tail = args[args.length - 1]`), persisting both to AsyncStorage. Because the server still
   sets `connectionStateRecovery` in `createIOServer`, socket.io mints a `pid` per socket
   (`node_modules/socket.io/dist/socket.js:116-118`) and the client dutifully stores and re-presents
   state that can never be honoured. Dead-weight bookkeeping, exactly as OR-5/LC-7/SRV-07 describe.

### Two corrections to the audit text

- **Scope of the loss is narrower than "every blip drops volatile frames".** socket.io only buffers
  packets that pass through `adapter.broadcast` — i.e. `server.to(room).emit()` /
  `client.to(room).emit()`. That covers typing (`messenger.gateway.ts:2185,2196`), presence
  (`presence.service.ts:162`), mission telemetry (`:467`), SFU fanout (`:301,311,1916,1983,2097,2120`)
  and everything routed via `socket-hub.ts:31,35`. It does **not** cover direct `client.emit(...)`
  frames: `envelope.deliver` (`:735`), `call.offer` (`:609`), `envelope.accepted` (`:1133`),
  `pong` (`:875`), `error`. Enabling recovery will **not** recover missed envelopes — the catch-up
  drain still owns that lane. Do not sell this fix as message-delivery reliability.
- **"Env change only" is false.** `session-aware-redis-adapter.ts` has **zero** spec files
  (`ls apps/messenger-service/src/gateway/*.spec.ts` — 13 specs, none for either adapter), and it
  overrides `broadcast()` for _every_ WS event in the service. It also ships two unconditional
  `console.log`s (`:149`, `:167`) that fire on every disconnect and every reconnect attempt.

## Mechanism

1. `main.ts:47` constructs `RedisIoAdapter`; `connectToRedis()` reads `process.env.WS_SESSION_RECOVERY`,
   finds it undefined (no template, no compose entry, no systemd env file key), and installs the
   stock `createAdapter(pub, sub)`.
2. `createIOServer` nevertheless merges `connectionStateRecovery` into the server options, so
   `Socket`'s constructor mints `this.pid = base64id.generateId()` for every socket and socket.io
   ships it in the CONNECT payload.
3. Client captures `_pid`, and on each broadcast scrapes `args[args.length - 1]` as the offset —
   which with the stock adapter is _not_ an offset at all, it's just the last real argument. (Every
   gateway broadcast happens to emit a single object arg, so `tail` is an object, `typeof tail === 'string'`
   is false, and no bogus offset is stored. Benign only by accident.)
4. On a blip the socket closes with `transport close`. `socket.js:536-550` calls
   `this.adapter.persistSession(...)` → base-class no-op. Nothing is stored.
5. On reopen the client sends `auth.pid` + `auth.offset`. `namespace.js:_createSocket` calls
   `adapter.restoreSession(pid, offset)` → `null` → fresh `Socket`, new id, new pid, rooms rejoined
   only by `handleConnection`'s `client.join([...])`. Everything broadcast during the gap —
   typing transitions, presence, in-flight SFU/ring frames, mission telemetry — is gone.

## Fix

Smallest correct increment = **make the flag real, tested, and configured**, then flip it on staging.
Four code edits + two deploy edits + one box-side action. All are additive and wire-compatible: the
offset trailing arg is the stock socket.io wire shape and old clients ignore extra `emit` args.

### 1. `apps/messenger-service/src/config/configuration.ts` — route the flag through config

Anchor (verbatim, inside the `ws:` block):

```ts
    /** Max bytes per frame — anything larger is dropped to prevent memory abuse. */
    maxPayloadBytes: parseInt(process.env['WS_MAX_PAYLOAD_BYTES'] ?? String(256 * 1024), 10),
  },
```

Replacement:

```ts
    /** Max bytes per frame — anything larger is dropped to prevent memory abuse. */
    maxPayloadBytes: parseInt(process.env['WS_MAX_PAYLOAD_BYTES'] ?? String(256 * 1024), 10),
    // OR-5/SRV-07 — socket.io connectionStateRecovery. OFF by default: the
    // SessionAwareRedisAdapter overrides broadcast() for every WS event and its
    // session buffer is per-process, so it is only correct on a single replica
    // (or behind sticky sessions). Enable on staging first.
    sessionRecovery: (process.env['WS_SESSION_RECOVERY'] ?? 'false') === 'true',
  },
```

### 2. `apps/messenger-service/src/main.ts` — pass it in like every other WS knob

Anchor:

```ts
const maxPayloadB = config.get<number>('ws.maxPayloadBytes') ?? 256 * 1024;
```

Insert after:

```ts
const wsRecovery = config.get<boolean>('ws.sessionRecovery') ?? false;
```

Anchor:

```ts
const adapter = new RedisIoAdapter(
  app,
  redisUrl,
  heartbeatMs,
  heartbeatGr,
  maxPayloadB,
  wsAllowedOrigins,
);
```

Replacement:

```ts
const adapter = new RedisIoAdapter(
  app,
  redisUrl,
  heartbeatMs,
  heartbeatGr,
  maxPayloadB,
  wsAllowedOrigins,
  wsRecovery,
);
```

### 3. `apps/messenger-service/src/gateway/redis-io.adapter.ts` — constructor arg instead of bare env read

Anchor:

```ts
    private readonly allowedOrigins: string[] = [],
  ) {
    super(app);
  }
```

Replacement:

```ts
    private readonly allowedOrigins: string[] = [],
    /**
     * OR-5/SRV-07 — WS_SESSION_RECOVERY. Read via ConfigService in main.ts so
     * it is testable without mutating process.env and shows up alongside the
     * other ws.* knobs.
     */
    private readonly sessionRecovery: boolean = false,
  ) {
    super(app);
  }
```

Anchor:

```ts
    if (process.env.WS_SESSION_RECOVERY === 'true') {
```

Replacement:

```ts
    if (this.sessionRecovery) {
```

(Leave the surrounding comment block; update the trailing sentence `WS_SESSION_RECOVERY=true is
explicitly set` → `ws.sessionRecovery is true (WS_SESSION_RECOVERY=true)` so it stays accurate.)

Additionally gate the server option itself so the OFF path stops minting dead pids — this is
SRV-07's "comment-gate the dead options", and it stops the client persisting state that can never
be used:

Anchor:

```ts
      connectionStateRecovery: {
        maxDisconnectionDuration: 2 * 60 * 1000, // 2 min
        skipMiddlewares:          false,
      },
    };
```

Replacement:

```ts
      // Only advertise recovery when the adapter can actually honour it —
      // otherwise socket.io mints a pid per socket and clients persist + replay
      // an offset the stock adapter's no-op restoreSession always rejects.
      ...(this.sessionRecovery
        ? {
            connectionStateRecovery: {
              maxDisconnectionDuration: 2 * 60 * 1000, // 2 min
              skipMiddlewares:          false,
            },
          }
        : {}),
    };
```

Back-compat for old clients: with the option absent, no `_pid` is sent, `client.ts`'s connect
handler already clears any stale persisted pid ("when the server sends none (recovery disabled),
clear any stale persisted pid so future handshakes omit `auth.pid`/`auth.offset` entirely"), and
`namespace.js:_createSocket` short-circuits on `this.server.opts.connectionStateRecovery` being
falsy — a client that still sends `auth.pid` is simply given a fresh session. No wire break.

### 4. `apps/messenger-service/src/gateway/session-aware-redis-adapter.ts` — strip diagnostics, close the pre-auth gap

**(a) Remove both `console.log`s.** They fire on every disconnect and every restore attempt.

Anchor:

```ts
    this.sessions.set(session.pid, persisted);
    // Diagnostic — see why client-side recovery isn't firing. Pid is
    // an opaque base64id, not sensitive. Strip once recovery is
    // verified working in staging.
    console.log(`[adapter.persist] pid=${session.pid.slice(0, 8)} rooms=${session.rooms.length} stored=${this.sessions.size}`);
  }
```

Replacement:

```ts
    this.sessions.set(session.pid, persisted);
  }
```

Anchor:

```ts
const session = this.sessions.get(pid);
const offsetIdx = offset === '' ? -2 : this.packets.findIndex(p => p.id === offset);
console.log(
  `[adapter.restore] pid=${pid?.slice(0, 8)} offset='${offset}' sessionFound=${!!session} offsetIdx=${offsetIdx} pktBuf=${this.packets.length} sessMap=${this.sessions.size}`,
);
if (!session) return null;
```

Replacement:

```ts
const session = this.sessions.get(pid);
if (!session) return null;
```

(`offsetIdx` was diagnostic-only — the real lookup is the `index` computed 6 lines below.)

**(b) Refuse to restore a session whose JWT was revoked while it was offline.** socket.io flushes
`missedPackets` inside the `Socket` constructor (`node_modules/socket.io/dist/socket.js:100-106`),
which `namespace.js:_createSocket` runs **before** `this.run(socket, …)` executes the handshake
auth middleware. So without this guard, a device presenting a valid pid+offset receives up to 2 min
of buffered room broadcasts _before_ its token is verified. The persisted session already carries
the claims (`data: this.data` = the gateway's `SocketContext`), and P0-6's revocation source of
truth is the `jti:<jti>` Redis key (`messenger.gateway.ts:409-419`), so the check is one `EXISTS`.

Anchor (constructor signature + `super` call):

```ts
  constructor(
    nsp:       Namespace,
    pubClient: Redis,
    subClient: Redis,
    opts:      Partial<RedisAdapterOptions> = {},
  ) {
    super(nsp, pubClient, subClient, opts);
```

Replacement:

```ts
  private readonly redis: Redis;

  constructor(
    nsp:       Namespace,
    pubClient: Redis,
    subClient: Redis,
    opts:      Partial<RedisAdapterOptions> = {},
  ) {
    super(nsp, pubClient, subClient, opts);
    this.redis = pubClient;
```

Anchor:

```ts
const session = this.sessions.get(pid);
if (!session) return null;
if (session.disconnectedAt + this.maxDisconnectionDuration < Date.now()) {
  this.sessions.delete(pid);
  return null;
}
```

Replacement:

```ts
const session = this.sessions.get(pid);
if (!session) return null;
if (session.disconnectedAt + this.maxDisconnectionDuration < Date.now()) {
  this.sessions.delete(pid);
  return null;
}
// Why: socket.io flushes missedPackets in the Socket constructor, BEFORE the
// handshake auth middleware runs, so a session revoked while the device was
// offline would still get its buffered frames replayed. P0-6's jti allowlist
// is the same source of truth the live-socket recheck uses.
if (!(await this.jtiStillValid(session))) {
  this.sessions.delete(pid);
  return null;
}
```

New private helper (place directly under `doRestoreSession`):

```ts
  private async jtiStillValid(session: PersistedSession): Promise<boolean> {
    const jti = (session.data as {claims?: {jti?: string}} | undefined)?.claims?.jti;
    if (!jti) return false;
    try {
      return (await this.redis.exists(`jti:${jti}`)) === 1;
    } catch {
      // Fail closed — an unreachable Redis must not hand back a buffered session.
      return false;
    }
  }
```

### 5. Deploy / env files

`apps/messenger-service/.env.example` — append after the `WS_HEARTBEAT_GRACE` block:

```
# OR-5/SRV-07 — socket.io connectionStateRecovery (2-min missed-broadcast replay
# for typing/presence/SFU/mission frames). OFF by default. The session buffer is
# per-process, so only set this to true on a SINGLE-REPLICA deployment or behind
# sticky sessions. Does NOT affect envelope delivery (direct socket.emit, never
# buffered) — the catch-up drain still owns that.
WS_SESSION_RECOVERY=false
```

`infra/env/messenger.env.example` — same key + comment, in the `## WebSocket heartbeat` section.

Root `docker-compose.yml`, under `messenger-service.environment:` after `WS_HEARTBEAT_GRACE`:

```yaml
# OR-5/SRV-07 — see apps/messenger-service/.env.example. Single-replica only.
WS_SESSION_RECOVERY: '${WS_SESSION_RECOVERY:-false}'
```

### 6. The actual staging flip — honest statement of where it lives

There is **no repo-tracked staging deploy file.** `scripts/deploy-staging.sh:31` resolves
`COMPOSE="${COMPOSE:-docker-compose.staging.yml}"` and line ~90 only asserts the file exists **on
the box**; the rsync excludes are `--exclude '.env' --exclude '.env.*'` (`scripts/deploy-staging.sh:41-43`)
and `.gitignore:10-15` ignores `.env*`. So the flip is a **manual box-side change**:

```
ssh admin@94.136.184.52
# edit /home/admin/bravo/docker-compose.staging.yml (messenger-service.environment)
#   WS_SESSION_RECOVERY: 'true'
# or the env_file it references
cd /home/admin/bravo && docker compose -f docker-compose.staging.yml up -d messenger-service
docker compose -f docker-compose.staging.yml logs messenger-service | grep 'SESSION RECOVERY ENABLED'
```

The startup log line at `redis-io.adapter.ts:73` is the confirmation signal. Follow-up (out of
scope for OR-5, worth filing): `docker-compose.staging.yml` should be tracked in the repo so
staging topology stops living only on the box.

Verification is `TEST_PLAN.md` row F2 and `docs/qa/MESSENGER_TEST_PLAN.csv` case **NET-29**:
2 devices, B types → drop A's socket for <2 min → on reopen `socket.recovered === true` and the
typing/presence transitions missed during the gap are replayed, no "Reconnecting" sticky banner.

### If the product decision is "don't enable"

Then ship only edits **1–3** (config plumbing + the `...(this.sessionRecovery ? … : {})` gate) and
leave `WS_SESSION_RECOVERY=false`. That alone closes SRV-07: the server stops advertising recovery,
clients stop persisting a pid/offset that can never be honoured, and
`session-aware-redis-adapter.ts` becomes explicitly-dormant rather than silently-dead. Edits 4–6
are only needed if you intend to turn it on.

## Blast radius

- `apps/messenger-service/src/main.ts` — one new local + one extra constructor arg. No other caller
  of `RedisIoAdapter` exists (`grep RedisIoAdapter` → `main.ts:8,47` only).
- `apps/messenger-service/src/gateway/redis-io.adapter.ts` — `createIOServer` is called by Nest's
  `useWebSocketAdapter`. The new optional 7th ctor arg defaults `false`, so any test constructing it
  positionally keeps today's behaviour.
- `apps/messenger-service/src/gateway/session-aware-redis-adapter.ts` — currently has exactly one
  importer (`redis-io.adapter.ts:7`). Adding the jti gate makes `doRestoreSession` do one Redis
  `EXISTS` per reconnect-with-pid; negligible, and it is already `async`.
- **Wire format:** when enabled, every adapter-broadcast event gains a trailing string arg (stock
  socket.io shape, `in-memory-adapter.js:376`). Every consumer is `@bravo/messenger-core`'s
  `TransportClient.onAny` (mobile + ops-console), which reads `args[0]` as data and only treats a
  trailing **string** as an offset. All gateway broadcasts emit exactly one object arg, so no
  handler misreads. Old clients that never send `auth.pid` are unaffected. **No schema/migration —
  nothing persisted, no SQLCipher change, no DB.**
- **Overlapping findings:** SRV-07 is the same edit (merge them). LC-7 is the prior sighting.
  OR-4/OR-6 touch `productionRuntime.ts` drain coalescers — disjoint files, but they share the
  "reconnect reliability" narrative; do not let OR-5 be credited with fixing envelope delivery.
  SRV-03 (connect-time drain of pending call offers) is the correct fix for the call lane, because
  `call.offer` is a direct `client.emit` and recovery cannot help it.
- **Regression risk if enabled:** the `broadcast()` override is on the hot path for typing, presence,
  SFU fanout and mission telemetry — a bug there degrades _all_ real-time messaging, which is
  precisely why the flag exists.

## Tests

New spec, mirroring the existing gateway spec layout (plain Jest + ts-jest, `apps/messenger-service`
project, run with `cd apps/messenger-service && npm test`):

**`apps/messenger-service/src/gateway/session-aware-redis-adapter.spec.ts`** (new)

- Fake `nsp` (`{server: {opts: {connectionStateRecovery: {maxDisconnectionDuration: 120000}}}}`),
  `ioredis-mock` for pub/sub (already a devDependency).
- `broadcast` appends a trailing string offset to `packet.data` for an event packet with
  `packet.id === undefined` and no volatile flag; asserts `super.broadcast` still received the packet.
- `broadcast` does **not** append/buffer when `packet.id !== undefined` (ack) or when
  `opts.flags.volatile` is set — assert `data.length` unchanged.
- `persistSession` then `restoreSession(pid, offset)` returns the session with exactly the packets
  emitted **after** that offset, filtered by `shouldIncludePacket` (room membership + `except`).
- `restoreSession` returns `null` for: unknown pid; expired session (advance `Date.now`);
  unknown/`''` offset.
- **jti gate:** with `jti:<jti>` absent from the mock Redis, `restoreSession` returns `null` and the
  pid is evicted from the session map; with the key present it returns the session. Redis throwing
  → `null` (fail closed).
- No `console.log` is emitted on persist/restore (`jest.spyOn(console, 'log')`, expect not called) —
  keeps the stripped diagnostics from creeping back.

**`apps/messenger-service/src/gateway/redis-io.adapter.spec.ts`** (new)

- `createIOServer` **omits** `connectionStateRecovery` when `sessionRecovery === false` and includes
  it (2 min, `skipMiddlewares: false`) when `true`. Stub `IoAdapter.prototype.createIOServer` to
  capture the merged options.
- `connectToRedis` selects `createAdapter` vs `createSessionAwareRedisAdapter` off the ctor flag,
  not `process.env` (set `process.env.WS_SESSION_RECOVERY = 'true'` and assert the stock adapter is
  still chosen when the ctor flag is `false` — proves the plumbing moved).

**Regression suites to run:** `cd apps/messenger-service && npm test` (all gateway specs, especially
`messenger.gateway.handshake.spec.ts`, `.privacy.spec.ts`, `.sfu-fanout.spec.ts`), then
`npm run test:crypto` at repo root for `transportRecoveryPid.test.ts` /
`transportServerReconnect.test.ts` / `transportReconnect.test.ts` (client half unchanged — must stay
green), then `npm run typecheck` (baseline 47) and `cd apps/messenger-service && npm run typecheck`.

**Device test:** `docs/qa/MESSENGER_TEST_PLAN.csv` NET-29 / `TEST_PLAN.md` F2, on staging only,
2 devices, after the box-side flip.

## Risk

1. **The audit undersells the change.** "Env/ops, no code" would mean turning on ~225 lines with
   zero test coverage that intercept every broadcast in the service. A reviewer seeing a one-line
   env diff should push back.
2. **ARCH NOTE — pre-middleware replay window.** Enabling recovery means socket.io writes
   `missedPackets` to the wire in the `Socket` constructor (`socket.js:100-106`) _before_ the
   gateway's handshake auth middleware runs (`namespace.js:_add` → `this.run(socket, …)`). Fix §4(b)
   closes this with the P0-6 jti check; **do not ship the flag flip without it.** Note the existing
   partial mitigation: P0-6 revokes with `sock.disconnect(true)` → reason
   `"server namespace disconnect"`, which is **not** in socket.io's `RECOVERABLE_DISCONNECT_REASONS`
   (`socket.js:14-21`), so a socket revoked _while connected_ is never persisted. The gap is only
   for a socket that dropped with `transport close` and was revoked while offline. Only broadcast
   metadata (typing/presence/SFU/mission) is at stake — envelope bodies are sealed and are
   direct-emitted, never buffered. Worth an architecture-owner FYI even with the guard.
3. **Multi-replica is worse than the file's own header claims.** The header says a reconnect landing
   on another replica "falls back to a fresh session". Not guaranteed: offsets are minted by a
   local `yeast()` derived from `Date.now()` (`session-aware-redis-adapter.ts:75-91`), independently
   per process, so two replicas can mint the **same** id in the same millisecond. Node B's
   `findIndex(p => p.id === offset)` can then match its _own_ unrelated packet and replay the wrong
   window. `RedisAdapter.onmessage` dispatches remote packets via the base `Adapter.broadcast`, so
   remote packets are never buffered locally — the buffers are genuinely per-process. Hard
   constraint: **single replica, or sticky sessions.** Staging (1 replica) is the documented sweet
   spot; prod must not get this flag without an LB decision.
4. **Memory.** `this.packets` retains every broadcast (plus its `opts`, which holds `rooms`/`except`
   `Set`s) for 2 min, GC'd every 60 s. On a busy relay this is a new, unbounded-between-sweeps
   allocation. Watch RSS on staging.
5. **Do not claim delivery reliability.** `envelope.deliver`, `envelope.accepted` and `call.offer`
   are direct `client.emit` — never buffered by stock or custom adapters. If someone reports
   "messages still lost after a blip", this fix was never going to help; that's OR-4/OR-6/SRV-03.
6. **Dead legacy copy.** `src/modules/messenger/transport/client.ts` still uses `sock.pid ?? socket.id`
   and never sends `auth.offset` — i.e. the pre-P1-13 code. It is exported from
   `src/modules/messenger/transport/index.ts` but that barrel has no importers; the app uses
   `@bravo/messenger-core`. Harmless for this fix, but if anyone ever re-points mobile at it,
   recovery breaks again. Candidate for `npm run deadcode`, out of scope here.
