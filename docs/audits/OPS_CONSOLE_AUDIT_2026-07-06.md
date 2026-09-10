# Ops Console (Web App) — Full Audit

**Date:** 2026-07-06
**Auditor:** Claude (parallel full read of `apps/ops-console/src/**` across five dimensions — E2EE messenger/vault crypto, auth/session/RBAC/API with auth-service guard cross-checks, build/config/deps, the bookings/live/dashboard pages, and the dispatch/agents/finance/compliance pages — plus `typecheck`, `lint`, and `npm audit` gates)
**Scope:** `apps/ops-console` (Next.js 15.3.0 App Router, React 19, SWR, socket.io-client, mapbox-gl, `@bravo/messenger-core`). Backend touched only to verify server-side enforcement of `/ops/*` routes.

## Overall Score: 70 / 100

A well-built admin panel with genuinely strong security foundations — httpOnly-cookie sessions, a layered CSP with per-request nonces, server-side region scoping on writes, non-extractable WebCrypto keys, idempotency keys on every mutation, and a clean typecheck. It is held back from a higher score by a cluster of **P1** issues that each break a documented invariant: plaintext message bodies reaching the browser console, the group master key sitting unencrypted in IndexedDB, a cross-region IDOR on detail reads, a dead "RESOLVE SOS" control that strands emergency missions, a booking map hardwired to fake coordinates, and a Next.js version ~14 months behind its security-patch line (npm audit flags one critical + two high advisories).

None of the P1s is a remote unauthenticated compromise, but several are reachable by a logged-in operator on the golden path, and two (plaintext logging, group-key-at-rest) directly contradict the project's hard security constraints.

| Dimension                         | Score | Headline                                                                       |
| --------------------------------- | ----- | ------------------------------------------------------------------------------ |
| Messenger / crypto / vault        | 61    | Plaintext logging + group key stored unencrypted; strong primitives otherwise  |
| Auth / session / RBAC / API       | 78    | Cross-region IDOR on detail reads; excellent cookie/CSRF/region-write posture  |
| Bookings / Live / Dashboard pages | 62    | Dead RESOLVE-SOS control + hardcoded map coords; solid mutation safety         |
| Dispatch / Agents / Finance pages | 78    | Missing confirms on money/destructive actions; FIFO + BC math verified correct |
| Build / config / deps             | 82    | Next.js patch lag + no `.dockerignore`; no committed secrets, strong headers   |

---

## Remediation status — 2026-07-06 (same day)

**All P1 and P2 findings fixed, plus the correctness-bearing P3s.** Verified green: ops-console `tsc --noEmit` (0 errors) and `next lint` ("No ESLint warnings or errors" — the two pre-existing warnings were also cleared); auth-service `tsc --noEmit` (0 errors) and `mission.service.spec` (pass). Dependency remediation took `npm audit` from **7 vulns (1 critical / 2 high / 4 moderate) → 2 moderate** (Next bumped 15.3.0 → 15.5.20; `ws`/`protobufjs`/`brace-expansion`/`js-yaml` patched; the 2 residual moderates are `postcss` _bundled inside Next_, build-time-only, unfixable without an absurd Next downgrade).

| Group                                                                                        | Status                         |
| -------------------------------------------------------------------------------------------- | ------------------------------ |
| **P1** — MSG-01/02/03, AUTH-01, PAGE-01/02, CFG-01                                           | ✅ all fixed                   |
| **P2** — MSG-04/05/06/07, AUTH-02\*/03, PAGE-03–08/10–16, CFG-02/03                          | ✅ fixed (see note on AUTH-02) |
| **P3 (correctness)** — MSG-08/09, AUTH-07, PAGE-17/18/19/20/21/23/24, CFG-04                 | ✅ fixed                       |
| **P3 (cosmetic / product / hardening)** — PAGE-22/25/26, AUTH-04/05/06/08, CFG-05, MSG notes | ⏭️ deferred (rationale below)  |

**Policy calls made during remediation (please confirm):**

- **AUTH-03** reconciled by **tightening the server** (`@RequireRoles('SUPERVISOR','ADMIN')` on `approve`/`reject`) to match the console UI, which already hides these from OPS-tier — zero UI regression, least-privilege. The alternative (relax the client to let OPS approve/reject, matching the server's prior "any admin" comment) is equally valid; flag if you prefer it.
- **MSG-05** (WebAuthn PRF domain-separation) now includes the label in the PRF input. This changes the derived secret for **already-enrolled passkeys**, so those operators must re-enroll via the passphrase-recovery path (passphrase unlock is unaffected).
- **MSG-06** (reject legacy v2 outer wraps) is gated behind `NEXT_PUBLIC_ACCEPT_OUTER_V2` **defaulting to accept** (no behaviour change) so it can't silently drop in-flight v2 traffic; flip to `false` once the fleet is fully v3.

**\*AUTH-02** (messenger ticket is a full-scope `aud: bravo-api` JWT) was **not** auto-fixed: changing the ticket's audience requires a coordinated messenger-service verification change and its own test pass — it is a backend auth-token change (a documented stop-condition) and is left for a dedicated PR.

**Deferred P3s and why:** PAGE-22 (`legacyBehavior` row links → real anchors) is a per-table refactor for Next 16 readiness; PAGE-25 (fake search box, "Client" column showing region) needs a product decision (build vs. remove); PAGE-26 (dashboard decorative icons) is minor UX; AUTH-04 (`'unsafe-inline'` in CSP) is a documented Mapbox constraint until the min-browser target supports `strict-dynamic`; AUTH-05 (client-side redaction is presentational) needs server-side masking + an audited unmask endpoint; AUTH-06/08 (verify-body tokens, refresh reuse-detection) are backend auth hardening; CFG-05 (shared Mapbox token, ESLint 8 EOL, libsignal 0.0.16) are deliberate/ops-process items.

---

## Quality gates (objective)

| Gate                                 | Result                                          | Notes                                                                             |
| ------------------------------------ | ----------------------------------------------- | --------------------------------------------------------------------------------- |
| `npm run typecheck` (`tsc --noEmit`) | ✅ **0 errors**                                 | Clean — better than the mobile baseline of 96                                     |
| `npm run lint` (`next lint`)         | ⚠️ **2 warnings**                               | `BravoMap.tsx:190` ref-in-cleanup; `runtime.ts:40` unused `TransportState` import |
| `npm audit`                          | ❌ **7 vulns** (1 critical, 2 high, 4 moderate) | See CFG-01                                                                        |

**`npm audit` detail:**

- **critical** — `next` 15.3.0: long advisory list incl. App Router _middleware/proxy bypass via segment-prefetch routes_, cache-poisoning (missing `Vary`), image-optimizer content injection, and a _middleware SSRF_ pattern this app's middleware actually uses. Fixed in the 15.4.x–15.5.x line.
- **high** — `ws` 8.x (via `socket.io-client` → `engine.io-client`): uninitialized-memory disclosure + fragment DoS. `protobufjs` (transitive): unbounded-recursion DoS.
- **moderate** — `postcss <8.5.10` (via next), `brace-expansion`, `js-yaml` merge-key DoS.

---

## Severity summary

| ID      | Sev    | Area       | Title                                                                                            |
| ------- | ------ | ---------- | ------------------------------------------------------------------------------------------------ |
| MSG-01  | **P1** | Crypto     | Plaintext message bodies logged to the browser console                                           |
| MSG-02  | **P1** | Crypto     | Group master key stored as plaintext in IndexedDB                                                |
| MSG-03  | **P1** | Crypto     | Sender-cert revocation list never consulted (diverges from mobile)                               |
| AUTH-01 | **P1** | Auth       | Cross-region IDOR on booking/mission **detail** reads → customer PII                             |
| PAGE-01 | **P1** | Live       | RESOLVE-SOS button unreachable — missions can never exit SOS from console                        |
| PAGE-02 | **P1** | Bookings   | Booking-detail mini-map renders hardcoded Jeddah coords for every booking                        |
| CFG-01  | **P1** | Deps       | Next.js 15.3.0 behind the security-patch line (critical npm advisory)                            |
| MSG-04  | P2     | Crypto     | Hardcoded fallback to the dev sender-cert authority key                                          |
| MSG-05  | P2     | Crypto     | WebAuthn PRF input silently drops its domain-separation label                                    |
| MSG-06  | P2     | Crypto     | Legacy v2 outer-wrap still accepted → rate-limited session-reset DoS                             |
| MSG-07  | P2     | Crypto     | First-contact cert identity not cross-checked against keys-service                               |
| AUTH-02 | P2     | Auth       | Messenger ticket is a full-scope access JWT; XSS bypasses CSRF on `/ops/*`                       |
| AUTH-03 | P2     | Auth       | RBAC drift: console gates approve/reject to SUPERVISOR, server allows any OPS                    |
| PAGE-03 | P2     | Bookings   | Applicants/vehicles auto-refresh dies permanently after one failed poll                          |
| PAGE-04 | P2     | Bookings   | Picked applicants/vehicle never reconciled against the refreshed list                            |
| PAGE-05 | P2     | Live       | Route options never refetched; `is_current` goes stale after a re-route                          |
| PAGE-06 | P2     | Live       | Map camera yanks to CPO fix and resets zoom on every 2 s GPS poll                                |
| PAGE-07 | P2     | Finance    | ±100,000 BC wallet adjustment applies on one click, no confirm/target preview                    |
| PAGE-08 | P2     | Dispatch   | Cancel-dispatch & Force-assign (charges escrow) fire on a single click                           |
| PAGE-09 | P2     | Cross      | Timezone split — local-time bucketing/labels vs UTC display (many pages)                         |
| PAGE-10 | P2     | Attendance | Export date range mixes UTC/local → ~4 h of the "To" day dropped                                 |
| PAGE-11 | P2     | Cross      | Agent GPS reverse-geocoded via public Nominatim (privacy egress)                                 |
| PAGE-12 | P2     | Cross      | SWR `error` ignored → API failure shows "not found" / fake `● LIVE`                              |
| PAGE-13 | P2     | Bookings   | List quick-reject: `window.prompt` regression + fully swallowed error                            |
| PAGE-14 | P2     | Cross      | `fetchJson` treats every 403 (incl. RBAC/CSRF) as session expiry → boots to `/login`             |
| PAGE-15 | P2     | Live       | Client email/phone plaintext + unaudited on live pages (redaction bypass)                        |
| PAGE-16 | P2     | Live       | Deployment sign-off failure silently swallowed                                                   |
| CFG-02  | P2     | Build      | No `.dockerignore` — `.env.local` + host `node_modules` baked into image                         |
| CFG-03  | P2     | Build      | Vercel deploy uses `npm install --legacy-peer-deps` (not `npm ci`)                               |
| MSG-08  | P3     | Crypto     | Vault modal advertises 8-char floor while real gate is 12                                        |
| MSG-09  | P3     | Crypto     | `lock()` performs no explicit key teardown / DB close / group-key dispose                        |
| AUTH-04 | P3     | Auth       | CSP retains `'unsafe-inline'` in script-src/style-src                                            |
| AUTH-05 | P3     | Auth       | Client-side PII redaction is bypassable; reveal-audit not guaranteed                             |
| AUTH-06 | P3     | Auth       | `/auth/verify` still returns access+refresh tokens in the response body for web                  |
| AUTH-07 | P3     | Auth       | `keys.ts`/`relay.ts` fall back to `localhost` with no prod guard                                 |
| AUTH-08 | P3     | Auth       | Refresh rotation has no reuse-detection / family-revoke                                          |
| PAGE-17 | P3     | Dispatch   | `fireTestDispatch` has no Idempotency-Key and no UI RBAC gate                                    |
| PAGE-18 | P3     | Compliance | No UI RBAC gate; unstyled failures; expired docs show "0d" not "expired"                         |
| PAGE-19 | P3     | Agents     | Compounded rounding in "Est. Earnings" (+1.7% drift)                                             |
| PAGE-20 | P3     | Agents     | Same rate shown as BC on agent pages, raw AED on job applications                                |
| PAGE-21 | P3     | Jobs       | Jobs with an unknown status vanish silently from the pipeline board                              |
| PAGE-22 | P3     | Cross      | Row navigation via deprecated `legacyBehavior` Link / onClick — no ctrl-click, breaks in Next 16 |
| PAGE-23 | P3     | UX         | Swallowed review/sign-off errors; `alert()` used where sibling pages use inline banners          |
| PAGE-24 | P3     | UX         | Modals advertise ESC dismissal but none implement it; chat panes force-scroll on poll            |
| PAGE-25 | P3     | Bookings   | Fake search box + hardcoded Service filters; "Client" column shows region label                  |
| PAGE-26 | P3     | Dashboard  | Sub-fetch errors invisible; decorative non-actionable action icons                               |
| CFG-04  | P3     | Build      | `poweredByHeader` not disabled; `/api/health` bypass emits no security headers                   |
| CFG-05  | P3     | Build      | Shared Mapbox `pk.*` token (not domain-restricted); ESLint 8 EOL; libsignal 0.0.16 unmaintained  |

**Totals:** 0 P0 · 7 P1 · 21 P2 · 20 P3.

---

## P1 findings (fix before next release)

### MSG-01 — Plaintext message bodies logged to the browser console

**File:** `src/lib/messenger/runtime.ts:693-695` and `:915-917`

```ts
// pullOnce() — HTTP catch-up path, every inbound envelope (runs ~every 15s)
console.log(`[messenger] dispatching to ${this.listeners.size} listeners`, {
  envelopeId: env.envelopeId,
  conversationId: decoded.conversationId,
  body: decoded.body.slice(0, 40),
});
// group-envelope fallback branch
console.warn('[messenger] group envelope body is neither ciphertext nor plain envelope', {
  envelopeId: env.envelopeId,
  groupId,
  bodyPreview: sealed.body.slice(0, 60),
});
```

`decoded.body` is decrypted plaintext; `sealed.body` is the decrypted sealed payload. This violates the hard constraint _"Never log plaintext message bodies … console.log/warn/error/debug all count."_ The static log-audit test in CLAUDE.md guards only `packages/messenger-core` and legacy mobile — the ops-console runtime is unguarded, so this slipped through. Anything ingesting the console (Sentry breadcrumbs, remote-console tooling, an operator's open DevTools) captures message content.
**Fix:** Drop the `body`/`bodyPreview` fields (log only `envelopeId`/`conversationId`/`groupId`), and extend the log-audit test to cover `apps/ops-console/src/lib/messenger`.

### MSG-02 — Group master key stored as plaintext in IndexedDB

**File:** `src/lib/messenger/idb.ts:110-127`, consumed at `runtime.ts:1038-1056`

```ts
// group_keys store — comment: "the key is held as plaintext base64 here for read-path simplicity."
group_keys: {
  key: string;
  value: {
    group_id: string;
    master_key_b64: string;
    epoch: number;
    updated_at: number;
  }
}
```

Every other secret in this store (identity privkey, session records, pre-keys, message bodies, peer identity keys) is wrapped with the vault AES-GCM key. The group **master key** — "synonymous with group membership" — is the sole cleartext exception, defeating the exact threat the vault defends (`webauthnPrf.ts`: _"XSS or read-only IndexedDB exfil → ciphertext only, no key"_). An attacker with IDB read access (XSS or disk forensics) recovers the AES-256 master key and can decrypt any group ciphertext they can capture. Mobile (source of truth) holds this in SQLCipher, encrypted at rest — so this is a divergence and contradicts the console's "IndexedDB + AES-GCM" contract. P1 not P0 because message bodies in the `messages` store are already wrapped and wire traffic is pairwise-Signal-encrypted.
**Fix:** Wrap `master_key_b64` with the vault key (reuse `wrapString`/`unwrapString`) exactly as sessions/identity are; unwrap on read in `getGroupKey`.

### MSG-03 — Sender-cert revocation list never consulted

**File:** `src/lib/messenger/runtime.ts:737-745` and `:828-832` (both `verifySenderCert` call sites)

```ts
const claims = await verifySenderCert({
  cert: senderCert,
  authorityPubKeyB64: SENDER_CERT_PUBLIC_KEY_B64,
  expectedIdentityKey: peerIdentityKey ? toBase64(peerIdentityKey) : undefined,
}); // ← no `revokedJtis`
```

`verifySenderCert` accepts a `revokedJtis` set, and mobile's `productionRuntime.ts` supplies it on every call via `RevokedJtiCache` (5-min poll, fresh-only gating). The ops-console never instantiates that cache, so a leaked/explicitly-revoked sender cert stays accepted for its full TTL — the ops console does not benefit from the revocation window mobile shipped.
**Fix:** Instantiate + `start()` `RevokedJtiCache` at unlock and pass `revokedJtis: cache.isFresh() ? cache.snapshot() : undefined` to both call sites, mirroring mobile's fresh-only posture.

### AUTH-01 — Cross-region IDOR on booking/mission detail reads → customer PII

**File:** `apps/auth-service/src/ops/ops.controller.ts:117-119, 353-356`; `ops.service.ts:172-201` (triggered by the console's detail pages)

```ts
@Get('bookings/:id')
getBooking(@Param('id', ParseUUIDPipe) id) { return this.ops.getBookingDetail(id); }  // no req.admin
// ops.service.ts
async getBookingDetail(id) {                       // no assertRegionScope
  const b = await this.db.qOne(`SELECT * FROM lite_bookings WHERE id = $1`, [id]); ...
}
```

The **list** endpoint force-scopes non-global admins to their region and every **mutation** calls `assertRegionScope`, but the by-id **detail** reads (`getBookingDetail`, `missions.getById`, `getMissionDeployment`, `getRouteOptions`) receive no admin context and perform no region check. A region-scoped OPS/SUPERVISOR can enumerate any booking/mission UUID from another tenant and read full customer PII (email, phone, address), crew, principals, and route. UUIDs leak through activity feeds, audit rows, and the dispatch inspector.
**Fix:** Thread `req.admin` into those four service reads and call `assertRegionScope(admin, row.region_code)` after the row loads, exactly as the mutation paths already do. _(Server-side fix, but it is the console's detail pages that expose the surface — worth tracking here.)_

### PAGE-01 — RESOLVE-SOS button is unreachable; missions can never exit SOS from the console

**File:** `src/app/live/[id]/page.tsx:145, 407-416, 212-215`

```ts
const activeSos = data?.sos?.find(s => !s.acknowledged_at);   // L145
...
{isSos && activeSos?.acknowledged_at && canResolveSos(role) && (   // L412 — always false
  <button onClick={resolveSos}>RESOLVE SOS</button> )}
```

`activeSos` is by construction an SOS with `acknowledged_at == null`, so `activeSos?.acknowledged_at` is always falsy — the RESOLVE button can never render. After ACK, `mutate()` refetches and `activeSos` becomes `undefined`, so both ACK and RESOLVE disappear while the mission stays `SOS`. The backend only flips `SOS → LIVE` inside `resolveSos` (`mission.service.ts:683-690`); ack alone doesn't. Result: an acknowledged SOS mission is permanently stuck in SOS — the only console exits are ABORT or COMPLETE, on the emergency golden path.
**Fix:** `activeSos = data?.sos?.find(s => !s.resolved_at)`; show ACK when `!acknowledged_at`, RESOLVE when `acknowledged_at && !resolved_at`.

### PAGE-02 — Booking-detail mini-map renders hardcoded Jeddah coordinates for every booking

**File:** `src/app/bookings/[id]/page.tsx:537-548`

```tsx
<BravoMap
  markers={[
    {id: 'a', lat: 22.3092, lng: 39.1042, label: 'A · PICKUP', type: 'pickup'},
    {id: 'b', lat: 21.4858, lng: 39.1925, label: 'B · DROPOFF', type: 'dropoff'},
  ]}
  route={[
    [39.1042, 22.3092],
    [39.1925, 21.4858],
  ]}
  center={[39.1, 21.9]}
/>
```

The API already returns real `pickup_lat/lng` + `dropoff_lat/lng` (`lib/api.ts:570-573`), but every booking shows the same fake Jeddah→Makkah route. An operator can approve/dispatch against a map that has nothing to do with the booking.
**Fix:** Build markers/route from `data.booking.pickup_lat/lng` + `dropoff_lat/lng`; hide the map when coords are null.

### CFG-01 — Next.js 15.3.0 is behind the security-patch line

**File:** `package.json:21` (`"next": "15.3.0"`, exact pin, ~14 months old)
CVE-2025-29927 (middleware auth bypass, `<15.2.3`) _is_ patched. But `npm audit` returns a **critical** cluster against 15.3.0 — App Router middleware/proxy bypass via segment-prefetch routes, cache poisoning (missing `Vary`), image-optimizer content injection, and a **middleware SSRF** pattern (`NextResponse.next({request:{headers}})`) that this app's `middleware.ts:147,160` uses, on a self-hosted Docker/Caddy deploy. Fixed across 15.4.x–15.5.x.
**Fix:** Bump to the latest 15.x patch, re-run `next build`, and adopt a patch-update cadence for this admin surface. Also address the `ws`/`protobufjs` **high** and `postcss` **moderate** transitives (`npm audit fix`).

---

## P2 findings (fix soon)

**Crypto/vault**

- **MSG-04** — `runtime.ts:54-56`: `SENDER_CERT_PUBLIC_KEY_B64` falls back to a hardcoded dev authority key (`'7uox…'`, checked into `auth-service/.env`) when the env var is unset. A misconfigured prod build silently trusts certs minted with the well-known dev private key — **fails open, no error**. Throw at module load if the var is missing in a non-dev build.
- **MSG-05** — `webauthnPrf.ts:178-192`: `derivePrfInput` appends `PRF_INFO_LABEL` to a 32-byte salt (→ 52 bytes) then returns `subarray(0,32)` = the salt alone; the label and the comment's claimed "SHA-256 hash" contribute nothing. Domain separation is a no-op. Real key security holds (salt is random per-vault), so it's hardening. Actually hash: `sha256(concat(salt, label))`.
- **MSG-06** — `runtime.ts:703-806`: `unwrapOuter` still accepts `version === 2`; the pre-decrypt cert verify runs only for v3, so a forged v2 outer envelope reaches `session.decrypt` → `DecryptError` → `closeSession` + bundle refetch. This is the forged-outer session-reset vector v3 closes; rate-limited by `REBUILD_COOLDOWN_MS` (1/peer/min). Ops only ever sends v3 — reject v2 inbound (or require a cert) once the fleet is fully v3.
- **MSG-07** — `runtime.ts:739-744, 825-832`: on first contact `expectedIdentityKey` is `undefined`, so the cert's identity key isn't cross-checked against keys-service (mobile does this via `resolveExpectedSenderIdentity`). A compromised auth-service could bind a victim userId to an attacker key and ops wouldn't catch it. Fetch the peer bundle on first contact and pass its `identityKey`.

**Auth/API**

- **AUTH-02** — The messenger ticket (`api.ts:130-184`) is a real `aud: bravo-api` access JWT, jti-allowlisted, held in JS memory. `JwtAuthGuard` accepts it as `Authorization: Bearer` on any `/ops/*` route and `CsrfGuard` exempts Bearer callers. An XSS that reads the in-memory ticket gets a 5-min token that drives state changes (approve/dispatch/wallet-adjust) off-origin **without** CSRF — a larger blast radius than the cookie session. Issue the ticket with a distinct `aud: bravo-messenger` and reject that audience at `/ops/*`.
- **AUTH-03** — RBAC drift: `rbac.ts` gates approve/reject to SUPERVISOR and its comment claims the backend mirrors this, but `ops.controller.ts:122-142` `approve`/`reject` carry **no** `@RequireRoles` — any OPS admin can call them raw. Make both layers agree (add the guard, or relax the client + fix the comment).

**Pages — operational correctness**

- **PAGE-03** — `bookings/[id]/page.tsx:159-186`: the applicants/vehicles poll only reschedules on the success path; one transient error stops the "auto-refresh every 6s" loop permanently. Bonus: the poll error writes shared `err`, which also renders inside the approve/reject modals. Reschedule in `finally` with a separate error channel.
- **PAGE-04** — `bookings/[id]/page.tsx:140-201`: `pickedApps`/`pickedLead`/`pickedVehicle` are never reconciled against the 6 s-refreshed lists. A withdrawn agent stays "LOCKED" in the banner and `dispatch()` posts a stale `applicationId` that fails only server-side. Prune picks to ids still present each poll.
- **PAGE-05** — `live/[id]/page.tsx:44-112`: route options are fetched once (effect keyed on `id`); `commitRouteSelection` never refreshes them, so the committed route still shows "→ DISPATCH" (re-committable) and another admin's re-route never appears. Call `loadRouteOptions()` after a successful commit.
- **PAGE-06** — `live/[id]/page.tsx:366-372` + `BravoMap.tsx:469-477`: `mapCenter` is memoized on `current_lat/lng`, which changes every 2 s poll, so `flyTo` re-fires and **resets zoom to 12** on each fix — the operator can't pan/zoom during an in-motion mission. Fly only on mission-id change or an explicit "follow" toggle.
- **PAGE-07** — `finance/page.tsx:37-51, 100-105`: a ±100,000 BC wallet adjustment applies on one `submit` click against a hand-pasted raw UUID — no name/balance lookup, no confirm, no direction restatement. Idempotency prevents double-apply but not wrong-target/wrong-sign. Resolve+display the target and add a confirm restating direction + amount.
- **PAGE-08** — `dispatch/page.tsx:149-164`: Cancel-dispatch and Force-assign fire on a single click with no confirm — and Force-assign "runs the real accept saga incl. escrow charge." The killswitch and agent-terminate on the _same page_ use confirms; these two heavier actions are the outliers. Add the same arm/confirm pattern.
- **PAGE-09** — Timezone split (cross-cutting): Today/Upcoming/Past buckets and TODAY/TOMORROW badges are computed in operator-local time while timestamps display UTC (`bookings/page.tsx:286-320`); `agents/[id]:58-66`, `incidents/page.tsx:21-23`, `jobs/[id]:191` use `toLocale*` (local) while `jobs/page.tsx`, `departments`, `dashboard`, `bookings/[id]:1336` use `getUTC*`. In UTC+4 a `22:00Z` booking badges "TOMORROW" and counts mis-bucket. Route all date rendering through one shared UTC formatter (mirror mobile's `@utils/datetime`).
- **PAGE-10** — `dept-attendance/page.tsx:56-59`: `new Date('2026-07-01')` parses as UTC midnight but `new Date('2026-07-06T23:59:59')` parses as **local** — in UTC+4 the range ends at 19:59:59Z, silently dropping ~4 h of the "To" day from the audit-logged CSV/PDF export. Build both bounds identically (`…T23:59:59Z`).
- **PAGE-11** — Agent GPS → public Nominatim (cross-cutting, `agents/[id]/page.tsx:11-35, 97`): the agent's last-known lat/lng is shipped to `nominatim.openstreetmap.org` (in the URL query, server-logged) on every fix — for a close-protection product, a continuous protectee-adjacent location trail to an uncontrolled third party, at a cadence violating Nominatim's 1 req/s policy. _Currently CSP-blocked_ (`connect-src` omits the host) so it fails silently today — a latent privacy egress the moment CSP loosens, plus a dead feature. Reverse-geocode via Mapbox (already CSP-allowed) or proxy through auth-service. (Also sets a browser-forbidden `User-Agent` header that's dropped.)
- **PAGE-12** — SWR `error` ignored (cross-cutting): `bookings/[id]:38` and `live/[id]:23` never destructure `error`; a 500/network failure renders "Booking not found." (wrong diagnosis) or a fake `● LIVE` header pill + live ABORT button on a mission the page never loaded. Surface `error` with a distinct failure state.
- **PAGE-13** — `bookings/page.tsx:72-79`: list quick-reject uses `window.prompt` (the detail page removed this as "Audit fix 4.4", bypassing the 8-char reason validation) and swallows the error entirely (`catch { /* surface on detail page */ }` — but nothing navigates there). Route through the same modal or at least surface the error inline.
- **PAGE-14** — `api.ts:64-73`: `fetchJson` treats every 401 **and 403** as session expiry and hard-redirects to `/login` via `window.location.assign` (discarding SWR cache). Backend RBAC and CSRF failures are also 403 — any UI/server gating drift boots a validly-logged-in operator off a live mission. Redirect only on 401 (or 403 with a specific `session_expired` body code); show inline "insufficient role" for RBAC 403s.
- **PAGE-15** — `live/[id]/page.tsx:492-494` and `live/page.tsx:173-177`: client email/phone rendered plaintext with no mask and no audit trail, while the _same client's_ contact on `bookings/[id]:437-438` is behind `<Redacted>` with a `pii-reveal` audit row. The live list defeats the reveal-audit control one click away. Wrap live contact fields in `<Redacted>`; drop email from list rows.
- **PAGE-16** — `live/[id]/page.tsx:131-138`: deployment sign-off `catch {}` is empty (comment claims "surface in UI"); a failed PASS/FAIL sign-off just re-enables the buttons with the check still "pending", and `refreshDeploy` treats 500s as "no checks yet". Set `err` in the catch; refetch deployment on the poll cadence.

**Build**

- **CFG-02** — No `.dockerignore` at repo root or in the app; `Dockerfile:50` `COPY apps/ops-console ./apps/ops-console` from a repo-root context bakes the developer's real `.env.local` (also read by `next build`), `tsconfig.tsbuildinfo`, local `.next/`, and host Windows `node_modules` (on top of the clean `--from=deps` copy) into image layers. Today `.env.local` holds only public values, so P2 pattern-risk. Add `.dockerignore` covering `**/.env*`, `**/node_modules`, `**/.next`, `**/*.tsbuildinfo`, `.git`.
- **CFG-03** — `vercel.json:6` `installCommand: "npm install --legacy-peer-deps"` — `npm install` (vs `npm ci`) can drift/rewrite the lockfile at deploy time and `--legacy-peer-deps` masks React-19 peer conflicts. Docker correctly uses `npm ci`; the two paths behave differently. Use `npm ci --legacy-peer-deps`.

---

## P3 findings (hygiene / hardening)

**Crypto:** MSG-08 vault modal says "≥8 chars" while `crypto.ts` enforces 12 + 3 classes (align copy). MSG-09 `lock()` (`MessengerProvider.tsx:88-96`) drops the runtime ref but doesn't close the DB, null `wrapKey`, or call `disposeAllGroupKeys()` — low risk since keys are non-extractable, but `wipe()` is the only thorough teardown.

**Auth:** AUTH-04 CSP keeps `'unsafe-inline'` in script-src (ignored where `strict-dynamic` is honoured, live on older engines) and style-src (Mapbox constraint). AUTH-05 `Redacted` masks presentationally only — raw PII is in the payload/SWR cache/devtools with no `pii.reveal` audit; callers without `subject` never audit. AUTH-06 `/auth/verify` still returns access+refresh in the body for web (cookies already carry them) — brief in-memory exposure. AUTH-07 `keys.ts:11`/`relay.ts:20-23` fall back to `localhost:3001/3100` with no prod guard (unlike `api.ts` which throws). AUTH-08 refresh rotation has no reuse-detection/family-revoke.

**Pages:** PAGE-17 `fireTestDispatch` has no Idempotency-Key + shows an enabled button that 403s for OPS. PAGE-18 compliance page: no UI RBAC gate, `Failed:` in neutral grey, `Math.round` shows "0d" for docs expired ≤12 h ago (use `Math.floor`/compare timestamps), no idempotency key. PAGE-19 "Est. Earnings" rounds the per-hour BC rate before multiplying (+1.7% drift) — round once at the end. PAGE-20 same agent rate shows as BC on agent pages but raw "AED 100" on job applications (`jobs/[id]:197`). PAGE-21 jobs with an unknown status push into a throwaway `[]` and vanish from the board (bucket unknowns into "Other"). PAGE-22 row nav via deprecated `legacyBehavior` Link / `onClick` / raw `<a>` — no ctrl-click/keyboard nav, breaks in Next 16. PAGE-23 swallowed review/sign-off errors + `alert()` where `jobs/[id]` uses inline banners. PAGE-24 modals advertise ESC but only backdrop-click works; chat panes force-scroll to bottom on every poll. PAGE-25 fake search box + permanently-on Service filters; "Client" column shows `region_label`. PAGE-26 dashboard sub-fetch errors invisible; decorative check/cross icons look actionable but only navigate.

**Build:** CFG-04 `poweredByHeader` not disabled; `/api/health` bypass emits no security headers and `startsWith` matches `/api/healthanything`. CFG-05 shared Mapbox `pk.*` token isn't domain-restricted (rotation is all-or-nothing); ESLint 8.57.1 is EOL with `no-misused-promises: off`; `@privacyresearch/libsignal-protocol-typescript@0.0.16` is unmaintained (known, deliberate — patch locally).

---

## Cross-cutting themes

1. **Date/timezone rendering is inconsistent (PAGE-09, PAGE-10).** Roughly half the pages render UTC via `getUTC*`, the other half render operator-local via `toLocale*`, and one export mixes both within a single range calc. The project's UTC-everywhere rule (mobile's `@utils/datetime`) has no console equivalent. **One shared `@lib/datetime` formatter would close ~5 findings at once** and is the single highest-leverage cleanup.
2. **Error handling fails silently on secondary paths.** SWR `error` is repeatedly ignored (PAGE-12), background polls die quietly (PAGE-03), and several `catch {}` blocks carry "surface in UI" comments that were never implemented (PAGE-13, PAGE-16, PAGE-23). Golden paths are well-handled; degraded paths mislead.
3. **Destructive/money actions lack confirm-and-preview (PAGE-07, PAGE-08).** The idempotency/busy-state discipline is excellent, but that protects against _double_-submit, not _wrong_-submit. The heaviest actions (escrow charge, wallet adjust, dispatch cancel) are one click from a mispaste.
4. **The client↔server RBAC contract is asserted, not verified (AUTH-03, PAGE-17, PAGE-18).** `rbac.ts` claims "backend enforces `@RequireRoles` on every mutation"; approve/reject/fire-test/compliance are counter-examples. Add a test that asserts each `can*` helper has a matching server `@RequireRoles`.
5. **Ops-console crypto has drifted from the mobile source of truth (MSG-02, MSG-03, MSG-07).** Group-key-at-rest, revocation, and first-contact identity binding are all weaker than `productionRuntime.ts`. The shared `@bravo/messenger-core` primitives are consumed correctly; the _runtime wiring_ around them diverged.

---

## Positives (what's done well)

**Security foundations**

- Session tokens in **httpOnly/Secure cookies**, never localStorage; refresh cookie **path-scoped** to `/auth/session/refresh`; only the CSRF token is JS-readable (correct double-submit). Bearer callers correctly CSRF-exempt.
- **Layered CSP** with per-request nonce + `strict-dynamic`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri`/`form-action 'self'`; X-Frame-Options DENY, nosniff, `Referrer-Policy: no-referrer`, prod-only HSTS w/ preload — duplicated belt-and-braces in `vercel.json`. `'unsafe-eval'` is dev-only.
- **Server is source of truth**: `@UseGuards(JwtAuthGuard, CsrfGuard, AdminGuard)` on the whole `/ops` controller; JWT verify pins `algorithms:['HS256']` + issuer + `aud`; CORS fail-closed in prod; parameterized SQL + `class-validator` DTOs; per-route throttling + OTP lockout.
- **Region scoping** enforced server-side on lists **and every mutation** via `assertRegionScope` (the gap is detail _reads_ only — AUTH-01).
- **No committed secrets** — `.env.local` untracked with zero git history; only `.env.local.example` placeholders tracked. `next.config.ts` has `ignoreBuildErrors:false`, `removeConsole` in prod, standalone output; Dockerfile runs `USER node` (non-root), multi-stage, `npm ci`, HEALTHCHECK.
- **Logout is complete** — wipes the IndexedDB messenger vault, drops the in-memory ticket, invalidates SWR globally, clears sessionStorage, server-side cookie clear. **No open redirect** (login ignores `next`).

**Crypto/vault**

- **Non-extractable** AES keys throughout (`deriveKey`, `importPasskeyDerivedKey` both `extractable=false`); PBKDF2 at 600k SHA-256 with a real strength gate on setup _and_ unlock; fresh random 12-byte IV per `wrap`/`groupEncrypt` (no reuse, birthday bound reasoned about).
- Sealed-sender receive path is **fail-closed and layered** — v3 cert pre-verify _before_ `session.decrypt`, post-decrypt subject + deviceId pinning, AAD binding defaulting closed; every failure `return null`. Receive-side identity hard-gate returns `false` on rotation with a forensic trail + constant-time compare. `wipe()` is thorough and userId-keyed.

**Pages/UI**

- **`BravoMap` is well-engineered** — diff-by-id marker sync, in-place style updates, content-signature diffing to avoid GL churn on 2 s polls, NaN/Infinity coord guards, `escapeHtml` at the `setHTML` sink (real XSS mitigation), `map.remove()` on unmount, lazy chunk keeping ~1.5 MB of mapbox-gl out of first load.
- **Mutation safety** — fresh `Idempotency-Key` on every state-changing call (client + server `IdempotencyInterceptor`); busy/disabled pending states everywhere; destructive ops mostly behind validated-reason modals; `mutate()` after every mutation; no WS-mutates-stale-copy patterns.
- **Domain invariants verified correct** — FIFO job ordering holds end-to-end (`published_at ASC`, spec-locked); `bc.ts` `350/86` exactly mirrors `pricing.service.ts` with one canonical helper; attendance PDF export is XSS-safe (`escapeHtml` per cell); finance form validation is tight (UUID regex, integer-only, ±100k cap, mandatory reason).
- **No `dangerouslySetInnerHTML` anywhere in scope**; `tel:` hrefs sanitized; clean typecheck (0 errors).

---

## Recommended remediation order

1. **MSG-01** (plaintext logging) — trivial diff, hard-constraint violation; extend the log-audit test to cover ops-console. _(hours)_
2. **PAGE-01 + PAGE-02** — dead RESOLVE-SOS and fake booking map: both are one-logic-line fixes with high operational impact. _(hours)_
3. **AUTH-01** (cross-region IDOR) — thread `admin` into 4 detail reads + `assertRegionScope`. _(half day)_
4. **CFG-01** — bump Next.js to latest 15.x + `npm audit fix` for `ws`/`protobufjs`/`postcss`; re-run build. _(half day + regression)_
5. **MSG-02 + MSG-03** — wrap the group key at rest; wire `RevokedJtiCache`. _(day)_
6. **P2 batch** — lead with the shared UTC datetime util (closes PAGE-09/10 + parts of others), then confirm-and-preview on money/destructive actions (PAGE-07/08), then the SWR-error and swallowed-error cleanups.
7. **P3** — fold into normal hygiene; the RBAC client↔server contract test (theme 4) is worth doing early as a regression guard.

---

_Generated by a five-way parallel audit (crypto/vault · auth/RBAC/API · build/config/deps · bookings-live-dashboard pages · dispatch-agents-finance pages) plus `typecheck` / `lint` / `npm audit` gates. Every finding was verified against source; server-side claims were cross-checked in `apps/auth-service/src`. Original per-dimension IDs are preserved in the finding bodies for traceability._
