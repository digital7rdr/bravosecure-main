# Ops Console Audit — 2026-08-07

**Method:** three read-only auditors run in parallel over `apps/ops-console` (Next.js 15
App Router) + its `/ops/*` backend surface in `apps/auth-service` — a **skeptic** (SK-_,
adversarial data-truth checks), a **code auditor** (CA-_, correctness/flow tracing), and an
**industry-standard reviewer** (IS-\*, parity vs. mature ops consoles). Findings were
cross-verified before logging; remediation is landing in three fixer batches.

**Scope:** every console page + the ops endpoints backing them. Mobile app, messenger
crypto, and security primitives (JWT/CSRF/guards) explicitly out of scope — only
_strengthening_ additions (audit writes, existing `@RequireRoles` patterns) allowed.

## Industry scorecard (pre-remediation)

| Axis                    | Score  |
| ----------------------- | ------ |
| **Overall**             | 68/100 |
| Entity model coverage   | 72     |
| Money handling          | 78     |
| Workflow completeness   | 70     |
| Trust / attribution     | 62     |
| Resilience / error UX   | 74     |
| Consistency (design/UX) | 55     |

## Consolidated findings

Status legend: **FIXED** (batch 1, this commit) · QUEUED (batch 2/3) · DEFERRED (documented, not scheduled this cycle).
Later batches update this table in place.

### P1

| ID                | Finding                                                                                                          | Batch | Status                                                                                                                                            |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| SK-01/CA-02/IS-01 | `covered_until` off-by-one — ops surfaces rendered the EXCLUSIVE `current_period_end`                            | 1     | **FIXED** — derived `covered_until` alias added to `getForOps` + `listForOps`; list card shows it for ACTIVE plans                                |
| SK-02             | Driver-only / exec protection-only bookings un-dispatchable — console hard-required a vehicle the server refuses | 1     | **FIXED** — console mirrors the server rule (`!driver_only && vehicle_count > 0`); "no vehicle required" state; `vehicleId` omitted               |
| IS-02             | Pro module wrote ZERO audit attribution                                                                          | 1     | **FIXED** — `OpsAuditService.recordAdmin` on all 12 mutating Pro endpoints; `decided_by` resolved to name/email on the detail page                |
| SK-07/IS-03       | Family/linked members invisible to ops                                                                           | 1     | **FIXED** — `family` block on Pro detail (LINKED MEMBERS card w/ hold state), `GET /ops/users/:id/family` + both-directions card on the user page |
| CA-04/IS-04       | Pro-queue destructive actions fired with no confirmation                                                         | 1     | **FIXED** — decline gets a note-capable modal; FINISH / CANCEL / SUSPEND 14D get explicit confirm steps                                           |
| CA-13/IS-05       | Dispute resolution ran through three chained `window.prompt`s                                                    | 1     | **FIXED** — structured modal: gross shown, split inputs, live remainder, `to_client + to_provider <= gross` validation                            |
| IS-06             | Compliance queue was a blind list of UUIDs with no document access                                               | 1     | **FIXED** — provider name (linked to agent record) + VIEW DOC (`file_url`) per row; server projection extended                                    |

### P2

| ID          | Finding                                                                            | Batch | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA-01       | Lead-agent mismatch — server fallback `agentIds[0]` depended on Postgres row order | 1     | **FIXED** — console always sends `leadAgentId`; server orders by `array_position` (pick order)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CA-03       | pro-management sections rendered empty-state copy on API failure                   | 1     | **FIXED** — all four hooks destructure `error`; distinct error state + RETRY per section                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| SK-03       | Escrow filter chips included fictional `SPLIT`, missing 3 real statuses            | 1     | **FIXED** — chips now the real enum: HELD, PENDING_RELEASE, RELEASED, REFUNDED, PARTIAL, DISPUTED                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| SK-04       | Booking status model missing DISPATCHING / NO_PROVIDER / AGENCY_NO_SHOW            | 1     | **FIXED** — union, filter rail, `STATUS_ORDER`, tones; all status renders use `replace(/_/g, ' ')`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| SK-05       | Client ratings collected but invisible to ops                                      | 1     | **FIXED** — CLIENT RATING card (stars + tag chips + remarks, empty state) on COMPLETED bookings                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| SK-06       | Enterprise/dept-v2 dark + flat channel tree                                        | 2     | **(a) FIXED** — `DepartmentChannelRow` gains `parent_id`/`level`/`channel_type`/`access` (server already sent them); `/departments` renders the indented tree + type/access badges. **(b) DEFERRED** — the read-only `/ops/enterprise` surface for the four dark tables needs new guarded endpoints + a page; out of batch-2 budget                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| IS-07       | Exec bookings showed a single opaque total                                         | 1     | **FIXED** — server-computed `price_breakdown` (via PricingService, never re-tabled) + composition table; add-on prices inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| IS-08/CA-10 | Pro applications list below queue standard                                         | 1     | **FIXED** — oldest-first actionable buckets (server), LOAD MORE, search box, per-tab counts from loaded data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| IS-09       | Entity chain navigation + dead orgDetail                                           | 2     | **FIXED** — booking client id + payer pill, Pro applicant, and incident org all link through to identities; ORGANIZATIONS rows open a drill-down (roster + protected members + org audit log) wiring the dead `orgDetail` + `orgAudit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| IS-10       | Design system navy/two-dialects                                                    | 3     | **FIXED** — console migrated Command-Navy → obsidian `#07090D` / cobalt `#5B8DEF` by retokening `globals.css` `:root` (token NAMES unchanged, values obsidian; new `--err-solid` for white-text fills) and mirroring the same hexes into the existing `tailwind.config.ts` aliases; every zinc/sky/emerald/red/amber utility on the 13 Tailwind-dialect pages + `ConfirmReasonModal` mechanically mapped to the token aliases (layout classes untouched); all literal navy hexes/rgba tints in tsx (live, wall, BravoMap, MissionGroupPanel, Shell, SosAlertBar, auth-primitives, settings, analytics) swept to the new palette; `var(--glow, var(--acc))` normalized, dead `aq-ico-ok/rej` deleted. WCAG table in §IS-10 note below. Console typecheck 0 / lint clean / build exit 0. |
| IS-11       | Bookings list "client" column showed the region label                              | 1     | **FIXED** — `client_name` joined server-side; client cell + search use it, region on the sub-line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| IS-12       | Server-side search / global search                                                 | —     | DEFERRED — documented; needs a real search endpoint, not client filtering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| IS-13       | Export coverage                                                                    | 2     | **FIXED** (cheap tier) — EXPORT CSV on escrows / payouts / invoices / disputes over the loaded rows (button title says so); every export shares the hardened `csvEscape`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| IS-14       | Pro module absent from dashboard/nav signals                                       | 1     | **FIXED** — two KPI tiles (pending apps, waiting date-requests) server-side in the dashboard query; nav count badges off the same poll                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| IS-15       | Prompt-driven suspend / SOS resolve / compliance reject                            | 1     | **FIXED** — shared `ConfirmReasonModal`; `window.prompt` count across the console is now ZERO (erase keeps double-confirm)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| IS-16       | Assignment calendar                                                                | —     | DEFERRED — documented                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### P3 (all batch 2 unless noted)

| ID          | Finding                                      | Batch | Status                                                                                                                                                                          |
| ----------- | -------------------------------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CA-05       | Thread double-send / unkeyed message POST    | 2     | **FIXED** — `proAppsApi.sendMessage` carries an Idempotency-Key; `sendReply` busy-guards the Enter path                                                                         |
| CA-06       | Jobs REJECT rbac                             | 2     | **FIXED** — REJECT gates on new `canRejectApplication` (SUPERVISOR+), mirroring the server `@RequireRoles`                                                                      |
| CA-07/SK-09 | MissionDetail type debt                      | 2     | **FIXED** — `MissionDetail` types `hourly_checkins` + booking `duration_hours`/`task_type`/`exec_transport`; inline casts in `live/[id]` deleted                                |
| CA-08       | EXPIRED copy                                 | 2     | **FIXED** — explicit EXPIRED decision copy (“Coverage ended … may renew”), no action buttons                                                                                    |
| CA-09       | Deploy checklist poll                        | 2     | **FIXED** — deployment checklist polls (5s); 404/no-checks (pane absent) split from fetch failure (error line); signoff refresh kept                                            |
| CA-11       | Detail 2s poll + UPDATE per tick             | 2     | **FIXED** — `useProApplication` polls at `POLL_DASH`; the 2s cadence stays on the LIST hook only                                                                                |
| CA-12       | addMonths overflow                           | 2     | **FIXED** — `addMonths` clamps to the target month's last day (Jan 31 +1mo → Feb 28/29)                                                                                         |
| CA-14       | CSV formula injection                        | 2     | **FIXED** — shared `csvEscape` (`lib/csv.ts`) neutralises leading `=` `+` `-` `@`; audit + all finance exports route through it (dept-attendance CSV is server-built)           |
| CA-15       | LOST SIGNAL client clock                     | 2     | **FIXED** — max-tracked server-vs-client clock offset (from `updated_at` at receipt) applied before the LOST SIGNAL thresholds                                                  |
| CA-16       | Relay localhost fail-open                    | 2     | **FIXED** — relay throws at first use in a production BROWSER when the base URL is unset; module-eval/prerender untouched so `next build` stays green                           |
| CA-17/IS-18 | Ad-hoc date formatters / dateless timestamps | 2     | **FIXED** — hand-rolled formatters in jobs / bookings detail / live / dashboard replaced with `@lib/datetime`; booking audit trail + dashboard activity stamps now carry a date |
| CA-18       | Unkeyed invite POST + biased genPassword     | 2     | **FIXED** — invite POST keyed; `genPassword` uses rejection sampling (no modulo bias)                                                                                           |
| SK-08       | Route-shadowed org audit                     | 2     | **FIXED** — reader moved to `/ops/audit-log/org/:orgUserId` (pinned by `ops-data.routes.spec.ts`); first consumer added (pro-management org drill-down)                         |
| SK-10       | ISSUE check-in green ✓                       | 2     | **FIXED** — ISSUE check-ins badge `!` on the danger token (not the green ✓); service renders via `bookingServiceLabel`                                                          |
| SK-11       | Unconsumed endpoints                         | 2     | **DOCUMENTED** — `orgAudit` wired (SK-08/IS-09); the rest recorded below as unconsumed-kept                                                                                     |
| SK-12       | confirmed_at hidden                          | 2     | **FIXED** — “Confirmed At” row (UTC) on the booking detail when stamped                                                                                                         |
| SK-13       | dept-attendance raw UUID + flag 404          | 2     | **FIXED** — org picker fed by the orgs listing endpoint + manual-UUID escape hatch                                                                                              |
| IS-17       | Proposal terms write-only                    | 2     | **FIXED** — proposal history cards render `terms` collapsed behind a details toggle                                                                                             |
| IS-19       | Dashboard inert icons                        | 2     | **FIXED** — fake ✓/✗ icons removed from the approval-queue rows; the open chevron stays (the row is a Link)                                                                     |
| IS-20       | Idle logout dumps draft                      | 2     | **FIXED** — proposal-builder + internal-notes drafts persist to sessionStorage keyed by application id; restored on reopen, cleared on submit                                   |
| IS-21       | Terminal REJECT clickable                    | 2     | **FIXED** — booking REJECT disabled on terminal states (COMPLETED/CANCELLED/NO_PROVIDER/AGENCY_NO_SHOW), mission-ABORT pattern                                                  |
| IS-22       | Identity truncation/copy                     | 2     | **FIXED** — shared `CopyId` on booking/mission/user/application ids + minted credentials; users tier filter gains `enterprise`; incidents org gets name + link                  |
| IS-23       | Skeletons / stale indicators                 | —     | DEFERRED — documented                                                                                                                                                           |

## Batch 1 remediation notes (2026-08-07)

- **Regression pins landed with the fixes** (repo rule: new behavior needs a test):
  `pro-applications.service.spec.ts` (covered_until projections, ASC/DESC ordering, family
  block), `pro-ops-audit.spec.ts` ×2 (every mutating Pro endpoint records `recordAdmin`;
  a failed mutation records nothing), `ops.service.projections.spec.ts` (client_name join,
  Pro KPIs, `array_position` pick order, driver-only vehicle rejection, exec
  `price_breakdown` line items incl. 2×86+30+90=292/hr ×3h=876), and two
  `compliance.service.spec.ts` additions (provider_name + file_url projection/mapping).
- **HQ-level (no region scope) semantics for the Pro module are kept deliberately** —
  coverage_area is free text, not a dispatch region (documented decision).
- `OpsService` gained an `@Optional() PricingService` (BookingModule now exports it) —
  the established positional-spec-safe pattern; a dependency-free fallback keeps old
  constructions working.
- Gates at commit time: auth-service `tsc --noEmit` 0 errors; targeted
  `jest pro-applications pro-management ops` 24 suites / 407 tests green; full
  `npm test` 126 suites / 2295 passed; ops-console `typecheck` 0 errors, `lint` clean,
  `next build` exit 0.

## Batch 2 remediation notes (2026-08-07)

- **Server-side regression pins:** `ops-data.routes.spec.ts` (SK-08 — the org-audit
  reader lives at `audit-log/org/:orgUserId` and nothing in `OpsDataController` shares
  the `audit/` wildcard prefix) and an `adminIncidents` case in
  `incident.service.spec.ts` (IS-09 — `org_name` joined via `LEFT JOIN users`).
- **SK-11 dispositions** (endpoints with no console consumer):
  - `POST /ops/missions/:id/waypoint` — unconsumed — kept (manual ops override;
    mobile drives waypoints via the agent surface).
  - `opsApi.activity` / `GET /ops/activity` — unconsumed helper — kept (dashboard
    reads `dashboard.activity` from the combined query; endpoint serves parity).
  - `useMissionTelemetry` / `GET /ops/missions/:id/telemetry` — unconsumed — kept
    (DC-16 route-replay surface, planned).
  - `GET /ops/broadcasts/subject|conversation/…` readers — unconsumed — kept
    (legacy parity; `useBroadcastsRecent` IS consumed by /messenger).
  - `orgDetail` + `orgAudit` — now CONSUMED (IS-09 org drill-down).
- **SK-06(b) DEFERRED:** the read-only enterprise surface (`enterprise_join_requests`,
  `org_workspaces`, `cpo_roster_months`, `attendance_corrections`) needs four new
  AdminGuard(+DeptChatV2Guard) list endpoints plus a page — deliberately left out of an
  already 23-fix batch so it ships reviewed, not rushed.
- **New shared console pieces for batch 3:** `lib/csv.ts` (`csvEscape`/`downloadCsv`),
  `lib/format.ts#bookingServiceLabel`, `components/CopyId.tsx` (style-neutral inline
  button), `rbac.ts#canRejectApplication`. New UI written this batch: /departments tree
  - badges (inline-style dialect), pro-management org drill-down modal (inline-style
    dialect), finance export buttons (Tailwind dialect), dept-attendance org select
    (Tailwind dialect).
- Gates at commit time: auth-service `tsc --noEmit` 0 errors; targeted
  `jest ops pro-applications pro-management department incident` 35 suites / 617 tests
  green; full `npm test` green (see commit); ops-console `typecheck` 0 errors, `lint`
  clean, `next build` exit 0 (CA-16 verified against prerender).

## Batch 3 note — IS-10 obsidian/cobalt migration (2026-08-07)

**Mechanism chosen:** route (a) — the CSS custom properties in `globals.css`
stay the single source of truth for the token-dialect pages, and the
already-existing `tailwind.config.ts` color aliases (`canvas s1 s2 s3 act acc
glow t1 t2 t3 bd1 bd2 ok warn err info` + new `err-solid`) were re-pointed to
the same obsidian hexes (literal hexes, not `var()`, so Tailwind alpha
modifiers like `bg-act/10` keep working — the two files carry a keep-in-sync
comment). The 13 zinc-dialect pages (finance, users, users/[id], sos, audit,
compliance, vbg, incidents, dept-attendance, analytics, messenger, admins,
dispatch) + `ConfirmReasonModal` kept their Tailwind layout classes; only the
color utilities were mapped (zinc→t1/t2/t3/s1/s2/bd1/bd2, sky/blue→act/acc,
emerald→ok, red→err/err-solid, amber→warn). Solid green buttons switched
white→dark ink (`text-canvas`) to pass contrast; the text-hierarchy collapse
(zinc-400/500/600 → t3) is deliberate — the master system defines exactly
three text levels.

**Palette:** canvas `#07090D` · shell `#0B0E14` · surfaces `#171C26/#10141C/#0D1119`
· accent `#5B8DEF` (hover `#7CA5F4`, pressed `#4A76D4`, dim `#31446E`, soft
`#8FB0F7`, glow `#A9C5FF`) · text `#F2F4F8/#B7C0CE/#8B95A8` · borders
`#2A3140/#1C2230` · ok `#4ADE80` · warn `#FFC107` · err text `#F87171` /
err solid `#DC2626` · map-grid `#4CC2FF` (master map-restricted token, kept).

**WCAG contrast (computed, not guessed):**

| Pair                                        | Ratio           | AA target | Pass                                                                                                                                                                           |
| ------------------------------------------- | --------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| tx-1 on canvas / card                       | 18.1 / 16.8     | 4.5       | YES                                                                                                                                                                            |
| tx-2 on canvas / card                       | 10.9 / 10.1     | 4.5       | YES                                                                                                                                                                            |
| tx-3 (muted) on canvas / card / s1 (worst)  | 6.6 / 6.1 / 5.7 | 4.5       | YES                                                                                                                                                                            |
| tx-3 on table header (surf-3)               | 6.3             | 4.5       | YES                                                                                                                                                                            |
| act link on canvas / card                   | 6.2 / 5.7       | 4.5       | YES                                                                                                                                                                            |
| acc (id/code) on card                       | 8.5             | 4.5       | YES                                                                                                                                                                            |
| glow on card                                | 10.6            | 4.5       | YES                                                                                                                                                                            |
| ok / warn / err chip text on tinted chip bg | 8.8 / 9.4 / 5.9 | 4.5       | YES                                                                                                                                                                            |
| pill-act text (glow) on act-tinted bg       | 8.8             | 4.5       | YES                                                                                                                                                                            |
| white on err-solid (badges, danger btns)    | 4.8             | 4.5       | YES                                                                                                                                                                            |
| canvas ink on ok (solid green btns)         | 11.4            | 4.5       | YES                                                                                                                                                                            |
| act as focus/selected border vs card        | 5.7             | 3.0       | YES                                                                                                                                                                            |
| white on act (btn-pri, 12px bold)           | 3.2             | 4.5       | NO — house CTA style (white-on-cobalt, locked by the mobile design system); legacy navy was 3.5, so no regression. Passes the 3.0 large-text bar; keep CTA labels ≥ 13px bold. |
| bd-1 / bd-2 hairlines vs card               | 1.4 / 1.2       | 3.0       | NO — decorative hairlines on layered dark surfaces (legacy was 1.6/1.2); interactive boundaries (inputs, selected chips, focus) use `--act` at 5.7.                            |

Residual off-palette values, with rationale: `#FFB4B4` (soft SOS-text tint on
red-tinted fills, part of the SOS treatment), `#FFC107` warn (master token),
`#4CC2FF`/`rgba(76,194,255)` map grid (master map-restricted), BravoMap's
mapbox basemap greys, `NotificationBell`'s `#0b0e14/#131824/#8a93a6/#e8ecf4`
(built obsidian-native in batch 1; values match the new ramp), and `CopyId`
(style-neutral by design).

---

## Deployment

Deployed to Contabo staging 2026-08-07 (~21:50 UTC): all three batches live on
`bravo-staging-auth` + `bravo-staging-ops`. Probes green (health 200, login 400,
`/ops/users/:id/family` + `/ops/audit-log/org/:id` 401-not-404, console 307,
public sslip.io mirrors). In-container markers verified (`covered_until`,
`price_breakdown`, `recordAdmin`, cobalt CSS). Details in
`docs/planning/BUILD_RUNBOOK.md` same-date entry.
